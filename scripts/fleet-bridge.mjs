#!/usr/bin/env node
// Standalone ingress: deliberately imports neither Fleet config nor its side-effect loops.
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { readEnv } from '../modules/platform/cadre-env.mjs';

// Exact methods and paths: adding a Fleet route never implicitly publishes it.
const routes = [
  ['GET', /^\/api\/health\/ready$/],
  ['GET', /^\/api\/agents\/(providers|scheduled)$/],
  ['POST', /^\/api\/agents\/(sessions|tasks|scheduled)$/],
  ['POST', /^\/api\/agents\/scheduled\/[A-Za-z0-9_-]+\/cancel$/],
  ['GET', /^\/api\/agent-bus\/(participants|model-catalog|threads|state)$/],
  ['GET', /^\/api\/agent-bus\/threads\/(by-participant|[A-Za-z0-9_-]+)$/],
  ['GET', /^\/api\/agent-bus\/messages\/[A-Za-z0-9_-]+\/context$/],
  ['POST', /^\/api\/agent-bus\/(threads|messages|dm)$/],
  ['POST', /^\/api\/agent-bus\/threads\/[A-Za-z0-9_-]+\/(participants|close)$/],
];
const digest = (value) => createHash('sha256').update(value).digest();

export async function createFleetBridge({
  token = process.env.AUTH_TOKEN,
  fleetToken = process.env.FLEET_AUTH_TOKEN,
  upstream = readEnv('DUENO_BRIDGE_UPSTREAM') || 'http://127.0.0.1:4310',
  timeoutMs = 120_000,
  rateMax = 120,
} = {}) {
  for (const [name, value] of [['AUTH_TOKEN', token], ['FLEET_AUTH_TOKEN', fleetToken]]) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43,256}$/.test(value)) {
      throw new Error(`${name} must be a random base64url/hex token of 43–256 characters`);
    }
  }
  if (token === fleetToken) throw new Error('AUTH_TOKEN must differ from FLEET_AUTH_TOKEN');
  const origin = new URL(upstream);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1'
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('DUENO_BRIDGE_UPSTREAM must be an HTTP origin on 127.0.0.1');
  }
  const expected = digest(token);
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, requestTimeout: 30_000,
    connectionTimeout: 130_000, trustProxy: false, exposeHeadRoutes: false });
  // Shared ingress budget: never trust forwarded client IPs for authentication/rate limits.
  await app.register(rateLimit, { max: rateMax, timeWindow: '1 minute', keyGenerator: () => 'ingress' });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    return payload;
  });
  app.addHook('onRequest', async (req, reply) => {
    const authorization = req.headers.authorization || '';
    const match = /^Bearer ([A-Za-z0-9_-]{43,256})$/i.exec(authorization);
    if (!match || !timingSafeEqual(digest(match[1]), expected)) {
      return reply.code(401).header('www-authenticate', 'Bearer').send({ error: 'Unauthorized' });
    }
    const path = req.raw.url.split('?')[0];
    if (!routes.some(([method, pattern]) => method === req.method && pattern.test(path))) {
      return reply.code(404).send({ error: 'Not found' });
    }
    if (req.headers.origin) return reply.code(403).send({ error: 'Browser origins are not supported' });
  });
  app.all('/*', async (req, reply) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const cancel = () => {
      clearTimeout(timer);
      if (!reply.raw.writableFinished) controller.abort();
    };
    reply.raw.once('close', cancel);
    try {
      // A fresh header set prevents cookie, internal-bypass and MCP-principal escalation.
      const body = req.method === 'POST' && req.body !== undefined ? JSON.stringify(req.body) : undefined;
      const response = await fetch(`${origin.origin}${req.raw.url}`, {
        method: req.method,
        headers: { authorization: `Bearer ${fleetToken}`, accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body,
        redirect: 'manual', signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        return reply.code(502).send({ error: 'Upstream redirect refused' });
      }
      reply.code(response.status);
      // No upstream cookies, redirects, CORS or internal headers cross this boundary.
      reply.type('application/json');
      return reply.send(response.body ? Readable.fromWeb(response.body) : null);
    } catch {
      return reply.code(controller.signal.aborted ? 504 : 502).send({ error: 'Fleet unavailable; mutation outcome may be unknown' });
    }
  });
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const port = Number(readEnv('DUENO_BRIDGE_PORT') || 4311);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid DUENO_BRIDGE_PORT');
    const app = await createFleetBridge();
    await app.listen({ host: '127.0.0.1', port });
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
      const deadline = setTimeout(() => process.exit(1), 10_000).unref();
      app.close().then(() => { clearTimeout(deadline); process.exit(0); });
    });
    console.info(`Cadre bridge listening on 127.0.0.1:${port}`);
  } catch {
    // Configuration errors must never echo a URL, header or credential.
    console.error('Cadre bridge startup failed; check token, upstream and port configuration');
    process.exitCode = 1;
  }
}
