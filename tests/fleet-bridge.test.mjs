import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { request } from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { createFleetBridge } from '../scripts/fleet-bridge.mjs';

const token = randomBytes(32).toString('base64url');
const fleetToken = randomBytes(32).toString('base64url');
const headers = { authorization: `Bearer ${token}` };
async function setup(t, options = {}, handler = (req) => ({ method: req.method, url: req.url, headers: req.headers, body: req.body })) {
  const upstream = Fastify({ bodyLimit: 2 * 1024 * 1024 });
  let calls = 0;
  upstream.all('/*', (req, reply) => { calls++; return handler(req, reply); });
  const address = await upstream.listen({ host: '127.0.0.1', port: 0 });
  const bridge = await createFleetBridge({ token, fleetToken, upstream: address, ...options });
  const url = await bridge.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => { await bridge.close(); await upstream.close(); });
  return { bridge, url, calls: () => calls, upstream, address };
}

test('fails closed for weak/missing/shared credentials and non-loopback origins', async () => {
  for (const options of [{ token: '' }, { fleetToken: 'weak' }, { fleetToken: token },
    { upstream: 'http://example.com' }, { upstream: 'http://127.0.0.1/api' },
    { upstream: 'http://user:pass@127.0.0.1' }, { upstream: 'https://127.0.0.1' }]) {
    await assert.rejects(createFleetBridge({ token, fleetToken, ...options }));
  }
});

test('bearer required for every endpoint; cookies, query tokens and internal headers cannot authenticate', async (t) => {
  const h = await setup(t);
  for (const requestHeaders of [{}, { authorization: `Bearer ${fleetToken}` },
    { cookie: `dueno_token=${token}` }, { 'x-dueno-internal': fleetToken },
    { authorization: `Basic ${token}` }]) {
    const result = await fetch(`${h.url}/api/agent-bus/threads?token=${token}`, { headers: requestHeaders });
    assert.equal(result.status, 401);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    await result.text();
  }
  assert.equal(h.calls(), 0);
});

test('exact allowlist denies unrelated APIs, methods and ambiguous paths before upstream', async (t) => {
  const h = await setup(t);
  for (const url of ['/', '/mcp', '/api/auth/login', '/api/ops/controls', '/api/research',
    '/api/health', '/api/health/live', '/api/agent-bus/auth/readiness', '/api/agent-bus/bootstrap', '/api/agents/scheduled/step-now',
    '/api/agent-bus/threads/abc/end', '/api/agent-bus/threads/%2e%2e',
    '/api/agent-bus/threads/a%2fb', '/api/agent-bus/threads/../state', '//api/agent-bus/threads']) {
    const status = await new Promise((resolve, reject) => {
      const req = request(h.url, { path: url, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end();
    });
    assert.equal(status, 404, url);
  }
  assert.equal((await h.bridge.inject({ method: 'DELETE', url: '/api/agent-bus/threads/a', headers })).statusCode, 404);
  assert.equal((await h.bridge.inject({ url: '/api/agent-bus/threads', headers: { ...headers, origin: 'https://example.com' } })).statusCode, 403);
  assert.equal(h.calls(), 0);
});

test('forwards JSON mutations and queries with only server-owned auth; strips response authority', async (t) => {
  const h = await setup(t, {}, (req, reply) => {
    reply.header('set-cookie', 'secret=1').header('x-dueno-internal', 'private');
    return { method: req.method, url: req.url, headers: req.headers, body: req.body };
  });
  const result = await fetch(`${h.url}/api/agents/sessions`, { method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', cookie: 'dueno_session=forged',
      'x-dueno-internal': fleetToken, 'x-dueno-internal-ts': new Date().toISOString(),
      'x-dueno-mcp-principal': 'forged', 'x-dueno-automation-policy': 'forged',
      'x-dueno-mcp-auth-context': 'forged', 'x-forwarded-for': '8.8.8.8' },
    body: JSON.stringify({ prompt: 'hello', idempotencyKey: 'request-1' }) });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('set-cookie'), null);
  assert.equal(result.headers.get('x-dueno-internal'), null);
  const payload = await result.json();
  assert.equal(payload.headers.authorization, `Bearer ${fleetToken}`);
  for (const key of ['cookie', 'x-dueno-internal', 'x-dueno-internal-ts', 'x-dueno-mcp-principal', 'x-dueno-automation-policy', 'x-dueno-mcp-auth-context', 'x-forwarded-for']) assert.equal(payload.headers[key], undefined);
  assert.deepEqual(payload.body, { prompt: 'hello', idempotencyKey: 'request-1' });
  const query = await fetch(`${h.url}/api/agent-bus/threads?q=hello%20world`, { headers });
  assert.equal((await query.json()).url, '/api/agent-bus/threads?q=hello%20world');
});

test('readiness is bearer-protected and preserves upstream ready/not-ready status', async (t) => {
  let ready = true;
  const h = await setup(t, {}, (_req, reply) => reply.code(ready ? 200 : 503).send({ ready }));
  assert.equal((await fetch(`${h.url}/api/health/ready`)).status, 401);
  assert.equal(h.calls(), 0);
  for (const value of [true, false]) {
    ready = value;
    const result = await fetch(`${h.url}/api/health/ready`, { headers });
    assert.equal(result.status, ready ? 200 : 503);
    assert.deepEqual(await result.json(), { ready });
  }
  assert.equal(h.calls(), 2);
});

test('the complete JSON wire body accepts 1 MiB and rejects one byte over', async (t) => {
  const h = await setup(t, {}, (req) => ({ bytes: Buffer.byteLength(JSON.stringify(req.body)) }));
  const limit = 1024 * 1024;
  const overhead = Buffer.byteLength(JSON.stringify({ prompt: '' }));
  for (const extra of [-1, 0, 1]) {
    const body = JSON.stringify({ prompt: 'x'.repeat(limit - overhead + extra) });
    assert.equal(Buffer.byteLength(body), limit + extra);
    const result = await fetch(`${h.url}/api/agents/tasks`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body,
    });
    assert.equal(result.status, extra > 0 ? 413 : 200);
    const payload = await result.json();
    if (extra <= 0) assert.equal(payload.bytes, limit + extra);
  }
  assert.equal(h.calls(), 2, 'oversized request never reaches the larger-capacity upstream');
});

test('bounds ingress rate without trusting forwarded IPs', async (t) => {
  const h = await setup(t, { rateMax: 1 });
  assert.equal((await h.bridge.inject({ url: '/api/agents/providers', headers })).statusCode, 200);
  const limited = await h.bridge.inject({ url: '/api/agents/providers', headers: { ...headers, 'x-forwarded-for': '1.2.3.4' } });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['cache-control'], 'no-store');
  assert.equal(h.calls(), 1);
});

test('preserves absent POST bodies and sends content-type only with a body', async (t) => {
  const h = await setup(t);
  for (const method of ['GET', 'POST']) {
    const path = method === 'GET' ? '/api/agents/providers' : '/api/agent-bus/threads/example/close';
    const result = await fetch(`${h.url}${path}`, { method, headers });
    assert.equal(result.status, 200);
    const payload = await result.json();
    assert.equal(payload.body, undefined);
    assert.equal(payload.headers['content-type'], undefined);
  }
});

test('refuses redirects, reports timeouts and upstream outages without retrying mutations', async (t) => {
  const redirect = await setup(t, {}, (_req, reply) => reply.redirect('http://example.com'));
  assert.equal((await redirect.bridge.inject({ url: '/api/agents/providers', headers })).statusCode, 502);
  assert.equal(redirect.calls(), 1);
  const slow = await setup(t, { timeoutMs: 15 }, async () => { await new Promise((r) => setTimeout(r, 60)); return {}; });
  assert.equal((await slow.bridge.inject({ method: 'POST', url: '/api/agents/tasks', headers, payload: {} })).statusCode, 504);
  assert.equal(slow.calls(), 1);
  await redirect.upstream.close();
  assert.equal((await redirect.bridge.inject({ url: '/api/agents/providers', headers })).statusCode, 502);
});

test('real Fleet auth and agent-bus store accept a remote thread/message round trip without GUI execution', async (t) => {
  const { createAgentBusHarness } = await import('./helpers/agent-bus-test-harness.mjs');
  const h = await createAgentBusHarness({ authToken: fleetToken });
  const upstream = await h.app.listen({ host: '127.0.0.1', port: 0 });
  const bridge = await createFleetBridge({ token, fleetToken, upstream });
  const url = await bridge.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => { await bridge.close(); await h.cleanup(); });
  const post = async (path, body) => {
    const result = await fetch(`${url}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(result.status, 200, await result.clone().text());
    return result.json();
  };
  const { thread } = await post('/api/agent-bus/threads', { title: 'Service hop', participants: [{ kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' }] });
  const { message } = await post('/api/agent-bus/messages', { threadId: thread.id, from: { kind: 'codex', sessionId: 'codex-1' }, body: 'Durable remote mutation', deliveryMode: 'enqueue' });
  const read = await fetch(`${url}/api/agent-bus/threads/${thread.id}`, { headers });
  assert.equal(read.status, 200);
  const snapshot = await read.json();
  assert.ok(snapshot.messages.some((item) => item.id === message.id && item.body === 'Durable remote mutation'));
});

test('restart with a rotated remote token revokes the old bearer and retains the Fleet credential', async (t) => {
  const h = await setup(t);
  await h.bridge.close();
  const rotated = randomBytes(32).toString('base64url');
  const bridge = await createFleetBridge({ token: rotated, fleetToken, upstream: h.address });
  t.after(() => bridge.close());
  assert.equal((await bridge.inject({ url: '/api/agents/providers', headers })).statusCode, 401);
  const response = await bridge.inject({ url: '/api/agents/providers', headers: { authorization: `Bearer ${rotated}` } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().headers.authorization, `Bearer ${fleetToken}`);
});

test('finishes a streamed JSON response without truncation across repeated requests', async (t) => {
  const body = JSON.stringify({ messages: ['a'.repeat(32_768), 'b'.repeat(32_768)] });
  const h = await setup(t, {}, (_req, reply) => reply.type('application/json').send(Readable.from((async function* () {
    for (let offset = 0; offset < body.length; offset += 8192) {
      yield body.slice(offset, offset + 8192);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  })())));
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(`${h.url}/api/agent-bus/threads/example`, { headers });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), body);
  }
});
