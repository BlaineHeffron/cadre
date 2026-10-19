import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, platform } from 'node:os';
import { join } from 'node:path';
import { privateAllowedHosts } from '../fleet/registry.mjs';
import { readEnv } from '../platform/cadre-env.mjs';
import { deriveSpawnTrust } from '../agent-bus/coordinator-policy.mjs';
import { cleanupAgentBusCredentialLaunch, prepareAgentBusCredentialLaunch } from '../integrations/mcp-launch-preflight.mjs';

// Bump when the hub-to-worker contract breaks. A commit mismatch only warns.
export const MACHINE_PROTOCOL = 1;
export const LOG_REDACT = ['req.headers.authorization', 'busCredential', '*.busCredential', 'pairCode', '*.pairCode',
  'hubCredential', '*.hubCredential', 'workerCredential', '*.workerCredential'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_MS = 5 * 60_000;
const COMMIT = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } })();
const sha = (value) => createHash('sha256').update(String(value)).digest('hex');
const fail = (message, code, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });

// One 0600 file per instance. Every read goes to disk, so a CLI revoke or a consumed code is
// seen by the server on its next call. A lock file serializes read-modify-write between the CLI and the server.
export function machineState(dir) {
  const file = join(dir, 'machines.json');
  const lock = `${file}.lock`;
  const read = () => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } };
  const update = (fn) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (;;) {
      try { closeSync(openSync(lock, 'wx', 0o600)); break; } catch (error) { if (error.code !== 'EEXIST') throw error; }
      try { if (Date.now() - statSync(lock).mtimeMs > 5000) rmSync(lock, { force: true }); } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    try {
      const state = read();
      const result = fn(state);
      writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
      return result;
    } finally { rmSync(lock, { force: true }); }
  };
  const machineId = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { writeFileSync(join(dir, 'machine-id'), randomBytes(16).toString('hex'), { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    return readFileSync(join(dir, 'machine-id'), 'utf8').trim();
  };
  const issueCredential = (state, scope, peer) => {
    const token = `cadre_machine_v1.${randomBytes(32).toString('base64url')}`;
    (state.credentials ||= {})[sha(token)] = { scope, peer };
    return token;
  };
  return {
    read, update, machineId, issueCredential,
    issueCode(now = Date.now()) {
      const code = Array.from(randomBytes(12), (byte) => CODE_ALPHABET[byte & 31]).join('');
      update((state) => { (state.codes ||= {})[sha(code)] = now + CODE_TTL_MS; });
      return code;
    },
    consumeCode(code, now = Date.now()) {
      return update((state) => {
        const expiresAt = state.codes?.[sha(code)];
        if (expiresAt) delete state.codes[sha(code)];
        return Boolean(expiresAt) && now <= expiresAt;
      });
    },
    // A worker accepts only the credential it issued to its hub at pairing.
    verifyPeer(token) {
      const state = read();
      const record = state.credentials?.[sha(token)];
      return record?.scope === 'worker:operate' ? { envId: record.peer, mcpUrl: state.hub?.mcpUrl || '' } : null;
    },
    unpair() { update((state) => { state.credentials = {}; state.codes = {}; delete state.hub; }); },
  };
}

export function descriptor(store, { label = readEnv('CADRE_MACHINE_LABEL') || hostname(), protocol = MACHINE_PROTOCOL } = {}) {
  return { machineId: store.machineId(), label, os: platform(), commit: COMMIT, protocol };
}

// Every host must be listed in DM_FLEET_PRIVATE_HOSTS_REF: worker links are plain HTTP.
export function validateMachineUrl(raw, { mcp = false, env = process.env } = {}) {
  const url = new URL(String(raw || ''));
  const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname);
  const scheme = mcp ? url.protocol === 'https:' || (loopback && url.protocol === 'http:') : url.protocol === 'http:';
  const allowed = privateAllowedHosts(env, readEnv('DM_FLEET_PRIVATE_HOSTS_REF', env));
  if (!scheme || url.username || url.password || url.search || url.hash || url.pathname !== (mcp ? '/mcp' : '/')
    || !(allowed.has(url.hostname.toLowerCase()) || allowed.has(url.origin))) {
    throw fail(`Machine URL ${url.origin} is not an allowed ${mcp ? 'https MCP' : 'http'} URL`, 'machine_url_invalid');
  }
  return mcp ? url.href : url.origin;
}

// Runs before every credential send: no answer, a different machine or another protocol sends nothing.
export async function checkPeer(url, envId, { protocol = MACHINE_PROTOCOL } = {}) {
  let peer;
  try {
    validateMachineUrl(url);
    const res = await fetch(`${url}/api/machine/descriptor`, { signal: AbortSignal.timeout(5000) });
    peer = res.ok ? await res.json() : null;
  } catch { peer = null; }
  if (!peer) return { code: 'machine_unreachable' };
  if (peer.machineId !== envId) return { code: 'machine_blocked', detail: `expected machine ${envId}, found ${peer.machineId}` };
  if (peer.protocol !== protocol) return { code: 'machine_protocol_mismatch', detail: `update machine (protocol ${peer.protocol}, hub ${protocol})` };
  return { code: null, commitWarning: peer.commit !== COMMIT ? `machine runs commit ${peer.commit || 'unknown'}, hub ${COMMIT || 'unknown'}` : '' };
}

export function parsePairLink(link) {
  const url = new URL(String(link || ''));
  const [envId, code] = url.hash.slice(1).split('.');
  return { url: url.origin, envId, code };
}

export async function addMachine(store, name, link, { hubMcpUrl, env = process.env } = {}) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(name))) throw fail('Machine name must be lowercase letters, digits and dashes', 'machine_name_invalid');
  const { url, envId, code } = parsePairLink(link);
  validateMachineUrl(url, { env });
  const peer = await checkPeer(url, envId);
  if (peer.code) throw fail(`Machine blocked: ${peer.detail || peer.code}`, peer.code);
  const hubCredential = store.issueCredential({}, 'bus:agent', envId);
  const res = await fetch(`${url}/api/pairing/redeem`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ pairCode: code, hubEnvId: store.machineId(), hubCredential, hubMcpUrl: validateMachineUrl(hubMcpUrl, { mcp: true, env }) }),
  });
  if (!res.ok) throw fail(`Pairing failed with HTTP ${res.status}`, 'machine_pairing_failed');
  const { workerCredential, label } = await res.json();
  store.update((state) => {
    (state.credentials ||= {})[sha(hubCredential)] = { scope: 'bus:agent', peer: envId };
    (state.machines ||= {})[name] = { id: name, url, envId, label, credential: workerCredential };
  });
  return { id: name, label, warning: peer.commitWarning };
}

// The hub side takes effect at once; the worker side stays pending until it answers.
export async function forgetMachine(store, name = '') {
  store.update((state) => {
    const row = state.machines?.[name];
    if (!row) return;
    delete state.machines[name];
    for (const [hash, record] of Object.entries(state.credentials || {})) if (record.peer === row.envId) delete state.credentials[hash];
    (state.pendingForget ||= {})[name] = row;
  });
  for (const row of Object.values(store.read().pendingForget || {})) {
    if ((await checkPeer(row.url, row.envId)).code) continue;
    const res = await fetch(`${row.url}/api/pairing/forget`, { method: 'POST', headers: { authorization: `Bearer ${row.credential}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (res && (res.ok || res.status === 401)) store.update((state) => { delete state.pendingForget[row.id]; });
  }
  return Object.keys(store.read().pendingForget || {});
}

// A worker binds only this node's own Tailscale address, never a LAN or wildcard address.
export function assertWorkerHost(host) {
  let ips = [];
  try { ips = execFileSync('tailscale', ['ip'], { encoding: 'utf8', timeout: 5000 }).split(/\s+/).filter(Boolean); } catch {}
  if (!ips.includes(String(host))) throw new Error(`CADRE_ROLE=worker requires HOST to be this node's Tailscale IP (${ips.join(', ') || 'tailscale unavailable'}), got ${host}`);
}

const SESSION_ROUTE = /^\/api\/([a-z]+)\/sessions(?:\/:id(.*))?$/;

export async function machinesPlugin(app, { role = 'hub', store, credentialStore, protocol = MACHINE_PROTOCOL, now = () => Date.now() }) {
  app.get('/api/machine/descriptor', async () => descriptor(store, { protocol }));
  if (role === 'worker') {
    app.post('/api/pairing/redeem', async (req, reply) => {
      const { pairCode, hubEnvId, hubCredential, hubMcpUrl } = req.body || {};
      let mcpUrl;
      try { mcpUrl = validateMachineUrl(hubMcpUrl, { mcp: true }); } catch (error) { return reply.code(400).send({ error: error.message, code: error.code }); }
      if (!hubEnvId || !hubCredential || !store.consumeCode(String(pairCode || ''), now())) {
        return reply.code(403).send({ error: 'Invalid, used or expired pairing code', code: 'pairing_code_invalid' });
      }
      const workerCredential = store.update((state) => {
        state.credentials = {};
        state.hub = { envId: String(hubEnvId), mcpUrl, credential: String(hubCredential) };
        return store.issueCredential(state, 'worker:operate', String(hubEnvId));
      });
      reply.header('Cache-Control', 'no-store');
      return { workerCredential, ...descriptor(store, { protocol }) };
    });
    app.post('/api/pairing/forget', async (req) => {
      if (req.duenoAuth?.principal?.type !== 'hub-peer') throw fail('Hub credential required', 'forbidden', 403);
      store.unpair();
      return { ok: true };
    });
    return;
  }

  const unreachable = (reply, peer) => reply.code(503).send({ error: peer.detail || peer.code, code: peer.code, transient: true });
  const parse = (text) => { try { return JSON.parse(text) || {}; } catch { return {}; } };
  // A worker's error body never reaches the hub's caller: only its status and code (§4.2.6).
  const failure = (reply, { status, text }) => {
    const code = typeof parse(text).code === 'string' ? parse(text).code : null;
    return reply.code(status).send({ error: code || `machine returned HTTP ${status}`, code });
  };
  const forgetSession = (kind, sessionId) => cleanupAgentBusCredentialLaunch({ backendType: kind, sessionId, credentialStore, reason: 'session_deleted' });
  const dropSession = async (kind, sessionId) => {
    store.update((state) => { delete state.sessions?.[`${kind}:${sessionId}`]; });
    await forgetSession(kind, sessionId);
  };

  async function send(row, method, url, body) {
    const res = await fetch(`${row.url}${url}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${row.credential}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, text: await res.text() };
  }

  async function createRemote(kind, req, reply) {
    const { machine, busCredential: _ignored, sessionId: _caller, structured: _structured, mcpServers: _servers, ...body } = req.body;
    const row = store.read().machines?.[machine];
    if (!row) return reply.code(400).send({ error: `Unknown machine: ${machine}`, code: 'machine_unknown' });
    if (kind !== 'claude') return reply.code(400).send({ error: `machine ${machine} runs only claude sessions`, code: 'machine_kind_unsupported' });
    if (body.metadata?.returnToSpawner) return reply.code(400).send({ error: 'returnResults is not supported on another machine yet', code: 'machine_return_results_unsupported' });
    const peer = await checkPeer(row.url, row.envId, { protocol });
    if (peer.code) return unreachable(reply, peer);
    if (peer.commitWarning) req.log.warn({ machine }, peer.commitWarning);
    const trust = deriveSpawnTrust(req.duenoAuth, body.metadata);
    const sessionId = randomBytes(4).toString('hex');
    const key = `${kind}:${sessionId}`;
    const issued = await prepareAgentBusCredentialLaunch({ backendType: kind, sessionId, credentialStore,
      coordinatorPolicy: trust.coordinatorPolicy, loopRegistrationPolicy: trust.loopRegistrationPolicy });
    const entry = { machine, kind, sessionId, workDir: String(body.workDir || ''), displayName: String(body.displayName || ''), created: now(), status: 'pending' };
    store.update((state) => { (state.sessions ||= {})[key] = entry; });
    const result = await send(row, 'POST', `/api/${kind}/sessions`, {
      ...body, mcpProfile: 'dueno', metadata: trust.metadata, sessionId, busCredential: issued?.token || '',
    }).catch(() => null);
    const ok = result && result.status < 300;
    store.update((state) => { if (ok) state.sessions[key].status = 'live'; else delete state.sessions[key]; });
    if (!ok) await cleanupAgentBusCredentialLaunch({ backendType: kind, sessionId, credentialStore, reason: 'launch_failed' });
    if (!result) return unreachable(reply, { code: 'machine_unreachable' });
    if (!ok) return failure(reply, result);
    const { sessionName, mcpCapabilities, initialPromptInjected, initialPromptError, initialPromptDelivery } = parse(result.text);
    return reply.send({ id: sessionId, sessionName, mcpCapabilities, initialPromptInjected, initialPromptError, initialPromptDelivery, machine });
  }

  // Runs for app.inject too, so bus deliveries to a remote id never reach a local handler.
  app.addHook('preHandler', async (req, reply) => {
    const [, kind, suffix] = SESSION_ROUTE.exec(req.routeOptions?.url || '') || [];
    if (!kind || kind === 'agents') return;
    if (suffix === undefined) return req.method === 'POST' && req.body?.machine ? createRemote(kind, req, reply) : undefined;
    const state = store.read();
    const entry = state.sessions?.[`${kind}:${req.params.id}`];
    if (!entry) return;
    const row = state.machines?.[entry.machine];
    const deleting = req.method === 'DELETE' && suffix === '';
    // Delete revokes the token at once, even while the worker sleeps.
    if (deleting) await forgetSession(kind, req.params.id);
    const peer = row ? await checkPeer(row.url, row.envId, { protocol }) : { code: 'machine_unreachable' };
    if (peer.code) return unreachable(reply, peer);
    const result = await send(row, req.method, req.url, req.body).catch(() => null);
    if (!result) return unreachable(reply, { code: 'machine_unreachable' });
    // The worker answers an unknown id with 404 or an ended payload coded session_not_found.
    const gone = suffix === '' && (result.status === 404 || parse(result.text).code === 'session_not_found' || (deleting && result.status < 300));
    if (gone) await dropSession(kind, req.params.id);
    if (result.status >= 300) return failure(reply, result);
    return reply.code(result.status).type('application/json').send(result.text);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const [, kind, suffix] = SESSION_ROUTE.exec(req.routeOptions?.url || '') || [];
    if (!kind || suffix !== undefined || req.method !== 'GET' || reply.statusCode !== 200) return payload;
    const rows = Object.values(store.read().sessions || {}).filter((entry) => entry.kind === kind && entry.status === 'live');
    if (!rows.length) return payload;
    const body = JSON.parse(payload);
    body.sessions = [...(body.sessions || []), ...rows.map(({ sessionId, machine, workDir, displayName, created }) => ({
      id: sessionId, displayName, workDir, created, machine: { id: machine, status: 'live' },
    }))];
    return JSON.stringify(body);
  });
}
machinesPlugin[Symbol.for('skip-override')] = true;
