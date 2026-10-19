import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, stat } from 'node:fs/promises';
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces, platform, release } from 'node:os';
import { join } from 'node:path';
import { privateAllowedHosts } from '../fleet/registry.mjs';
import { readEnv } from '../platform/cadre-env.mjs';
import { deriveSpawnTrust, operatorResumeLoopRegistrationPolicy, SPAWN_RESULT_NOTE, storedCoordinatorPolicy } from '../agent-bus/coordinator-policy.mjs';
import { buildHookSessionPaths, readHookEventsSince, registerHookSessionRegistry } from '../agent/hook-events.mjs';
import { buildInternalBypassHeaders, HUB_OPERATOR_HEADER, permissionAuthorityForRequest } from '../platform/auth.mjs';
import { queueSessionInteraction } from '../platform/push.mjs';
import { resolveBinding } from '../telegram/binding.mjs';
import { cleanupAgentBusCredentialLaunch, prepareAgentBusCredentialLaunch } from '../integrations/mcp-launch-preflight.mjs';
import { cleanupManagedWorktree, createManagedWorktree, managedWorktreeBase } from '../agent-bus/managed-worktrees.mjs';

// Bump when the hub-to-worker contract breaks. A commit mismatch only warns.
export const MACHINE_PROTOCOL = 2;
export const LOG_REDACT = ['req.headers.authorization', 'busCredential', '*.busCredential', 'pairCode', '*.pairCode',
  'hubCredential', '*.hubCredential', 'workerCredential', '*.workerCredential'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_MS = 5 * 60_000;
const COMMIT = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } })();
const sha = (value) => createHash('sha256').update(String(value)).digest('hex');
const fail = (message, code, statusCode = 400) => Object.assign(new Error(message), { code, statusCode });
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 5 * 60_000;
const POLL_MS = 5000;
const SWEEP_MS = 30_000;
const EVENT_LOG_SIZE = 1000;
const BLOCKING = new Set(['machine_blocked', 'machine_protocol_mismatch']);
const QUEUED = new Set(['permission', 'confirmation', 'selection']);
// Worktree keeps that are the worker's answer, as at a local room end; any other keep (a git or fetch failure, a session
// still live there) leaves a remote cleanup pending.
const SETTLED_KEEP = /^(dirty or untracked files|unpushed commits|new ignored files|cleanup off|cleanup policy not recorded|marker mismatch|metadata missing|path outside managed base|local commits after failed spawn|worktree missing)/;
// A row's status, plus a prompt the hub files in its Command Queue.
const eventRow = ({ state }) => ({ status: state?.status || 'unknown', ...(QUEUED.has(state?.interaction?.kind) && state.interaction.fingerprint
  ? { interaction: (({ kind, detail, options, fingerprint }) => ({ kind, detail, options, fingerprint }))(state.interaction) } : {}) });
const realTimers = { set: (fn, ms) => setTimeout(fn, ms).unref(), clear: (timer) => clearTimeout(timer) };
const addresses = () => Object.values(networkInterfaces()).flat().filter((nic) => !nic.internal).map((nic) => nic.address).sort().join();

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
    dir, read, update, machineId, issueCredential,
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
    // The hub accepts a hello only with the bus:agent credential it issued to that worker.
    helloPeer(token) { const record = read().credentials?.[sha(token)]; return record?.scope === 'bus:agent' ? record.peer : null; },
    unpair() { update((state) => { state.credentials = {}; state.codes = {}; delete state.hub; }); },
  };
}

export function descriptor(store, { label = readEnv('CADRE_MACHINE_LABEL') || hostname(), protocol = MACHINE_PROTOCOL } = {}) {
  const os = platform() === 'linux' && /microsoft/i.test(release()) ? 'linux-wsl2' : platform();
  return { machineId: store.machineId(), label, os, commit: COMMIT, protocol };
}

// The one-time link `cadre pair` prints and the worker UI's pair button shows (a Tailscale IPv6 host is bracketed).
export const pairLink = (store, host, port) => `http://${String(host).includes(':') ? `[${host}]` : host}:${port}/#${store.machineId()}.${store.issueCode()}`;

// Every host must be listed in DM_FLEET_PRIVATE_HOSTS_REF: worker links are plain HTTP.
export function validateMachineUrl(raw, { mcp = false, env = process.env } = {}) {
  const url = new URL(String(raw || ''));
  const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname);
  const scheme = mcp ? url.protocol === 'https:' || (loopback && url.protocol === 'http:') : url.protocol === 'http:';
  const allowed = privateAllowedHosts(env, readEnv('DM_FLEET_PRIVATE_HOSTS_REF', env));
  if (!scheme || url.username || url.password || url.search || url.hash || url.pathname !== (mcp ? '/mcp' : '/')
    // An IPv6 hostname comes bracketed; the allowlist holds `tailscale ip` output, which is not.
    || !(allowed.has(url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1')) || allowed.has(url.origin))) {
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
  return { code: null, os: peer.os, protocol: peer.protocol, commitWarning: peer.commit !== COMMIT ? `machine runs commit ${peer.commit || 'unknown'}, hub ${COMMIT || 'unknown'}` : '' };
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

// The Telegram relay keeps a remote session's cursor on the hub. The binding names the worker's transcript by inode, and each
// tick pulls what follows the hub's offset through the proxied transcript route; while the worker is away the pull throws,
// so nothing is sent and the offset stays.
export const relayBinding = (request) => async (session, options = {}) => {
  if (!session.machine) return resolveBinding(session, options);
  const prefix = `machine:${session.runtime}:${session.id}:`;
  const previous = options.previous?.transcript_path?.startsWith(prefix) ? options.previous : null;
  const ino = Number(previous?.transcript_path.slice(prefix.length)) || 0;
  const delta = await request(`/api/${session.runtime}/sessions/${session.id}/transcript?cursor=${Number(previous?.offset) || 0}&ino=${ino}`);
  return { path: `${prefix}${delta.ino}`, anchor: 'machine', ino: delta.ino, startOffset: 0, reused: delta.ino === ino && Boolean(previous), delta };
};

const SESSION_ROUTE = /^\/api\/([a-z]+)\/sessions(?:\/:id(.*))?$/;

export async function machinesPlugin(app, { role = 'hub', store, credentialStore, protocol = MACHINE_PROTOCOL, now = () => Date.now(), hubMcpUrl = '',
  supervise = false, timers = realTimers, random = Math.random, online = () => addresses() !== '', routeCommands = null, wakeCheckMs = 30_000, wsManager, worktreeBaseDir = managedWorktreeBase }) {
  app.get('/api/machine/descriptor', async () => descriptor(store, { protocol }));
  const operatorOnly = (req) => { if (req.duenoAuth?.principal?.type !== 'ui') throw fail('Operator required', 'forbidden', 403); };
  if (role === 'worker') {
    app.get('/api/machines', async () => ({ role, machines: [] }));
    app.post('/api/pairing/code', async (req, reply) => {
      operatorOnly(req);
      const { address, port } = app.server.address();
      reply.header('Cache-Control', 'no-store');
      return { link: pairLink(store, address, port) };
    });
    // Hello on boot, after a sleep (a late tick) and on a network change, so the hub stops backing off.
    async function hello() {
      const hub = store.read().hub;
      if (!hub?.credential) return;
      const origin = new URL(hub.mcpUrl).origin;
      try {
        const peer = await (await fetch(`${origin}/machine/descriptor`, { signal: AbortSignal.timeout(5000) })).json();
        // Only the hub's identity is checked: on a protocol mismatch the hello lets the hub show this machine as blocked.
        if (peer.machineId !== hub.envId) return;
        await fetch(`${origin}/machine/hello`, { method: 'POST', headers: { authorization: `Bearer ${hub.credential}` }, signal: AbortSignal.timeout(5000) });
      } catch {}
    }
    let timer; let last = now(); let nets = addresses();
    const watch = () => { timer = timers.set(async () => {
      const [at, current] = [now(), addresses()];
      if (at - last > 2 * wakeCheckMs || current !== nets) await hello();
      [last, nets] = [at, current];
      watch();
    }, wakeCheckMs); };
    app.addHook('onListen', async () => { void hello(); watch(); });
    app.addHook('onClose', async () => timers.clear(timer));
    // Session-state events with a persisted, monotonic sequence, made by diffing the session list on each read.
    // A cursor the log no longer covers gets a snapshot of every row instead.
    app.get('/api/machine/events', async (req) => {
      if (req.duenoAuth?.principal?.type !== 'hub-peer') throw fail('Hub credential required', 'forbidden', 403);
      const after = Number(req.query.afterSequence) || 0;
      const list = await app.inject({ url: '/api/claude/sessions', headers: { authorization: req.headers.authorization } });
      const rows = list.statusCode === 200 && !list.json().stale ? list.json().sessions : null;
      return store.update((state) => {
        const log = state.events ||= { sequence: 0, rows: {}, items: [] };
        const current = rows && Object.fromEntries(rows.map((row) => [`claude:${row.id}`, eventRow(row)]));
        for (const key of current ? new Set([...Object.keys(log.rows), ...Object.keys(current)]) : []) {
          if (JSON.stringify(current[key] || null) === JSON.stringify(log.rows[key] || null)) continue;
          log.items.push({ sequence: ++log.sequence, type: 'session', key, row: current[key] || null });
          if (current[key]) log.rows[key] = current[key]; else delete log.rows[key];
        }
        log.items = log.items.slice(-EVENT_LOG_SIZE);
        const gap = after > log.sequence || (log.items.length > 0 && after < log.items[0].sequence - 1);
        // Without a fresh list a snapshot could miss live rows, so a gap waits for the next read.
        if (gap && !current) return { sequence: after, events: [] };
        return { sequence: log.sequence, events: gap ? [] : log.items.filter((event) => event.sequence > after), ...(gap ? { snapshot: log.rows } : {}) };
      });
    });
    // A returnResults child's prompt and stop hook events after `cursor`, read from the append-only log they are recorded in.
    app.get('/api/machine/hook-events', async (req) => {
      if (req.duenoAuth?.principal?.type !== 'hub-peer') throw fail('Hub credential required', 'forbidden', 403);
      const { sessionId = '', cursor = 0 } = req.query;
      const detail = /^[a-f0-9]{8,32}$/.test(sessionId) && await app.inject({ url: `/api/claude/sessions/${sessionId}?lines=50`, headers: { authorization: req.headers.authorization } });
      if (detail?.statusCode !== 200 || !detail.json().workDir) return { cursor: Number(cursor) || 0, events: [] };
      const read = await readHookEventsSince({ workDir: detail.json().workDir, provider: 'claude', sessionId, cursor });
      return { cursor: read.cursor, events: read.events.filter((event) => ['UserPromptSubmit', 'Stop'].includes(event.eventName))
        .map(({ loggedAt, eventName, lastAssistantMessage, payload }) => ({ loggedAt, eventName, lastAssistantMessage, payload: { background_tasks: payload?.background_tasks } })) };
    });
    // A remote collab participant's managed worktree, made and cleaned here only when the hub asks (this worker runs no sweep).
    // The worker's own sessions are the live-session guard; the dirty and unpushed guards are cleanupManagedWorktree's.
    app.post('/api/machine/worktree', async (req) => {
      if (req.duenoAuth?.principal?.type !== 'hub-peer') throw fail('Hub credential required', 'forbidden', 403);
      const { create, cleanup, spawnFailed } = req.body || {};
      if (create) {
        const { repo, branch, base, roomId } = create;
        return createManagedWorktree({ repo, branch, base, roomId, baseDir: worktreeBaseDir }).catch((error) => { throw fail(error.message, 'worktree_create_failed'); });
      }
      // Gone already (an earlier answer the hub did not record) settles a retry.
      if (cleanup?.path && !await stat(cleanup.path).catch(() => null)) return { removed: false, reason: 'worktree missing', report: 'worktree: missing' };
      const list = await app.inject({ url: '/api/claude/sessions', headers: { authorization: req.headers.authorization } });
      if (list.statusCode !== 200 || list.json().stale) throw fail('Session list unavailable', 'machine_busy', 503);
      const sessions = list.json().sessions.map((row) => ({ workDir: row.workDir, lifecycle: row.canonicalState?.lifecycle }));
      return cleanupManagedWorktree(cleanup, { sessions, baseDir: worktreeBaseDir, spawnFailed: spawnFailed === true });
    });
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

  const unreachable = (reply, peer, status = 503) => reply.code(status).send({ error: peer.detail || peer.code, code: peer.code, transient: true });
  const parse = (text) => { try { return JSON.parse(text) || {}; } catch { return {}; } };
  // A worker's error body never reaches the hub's caller: only its status and code (§4.2.6).
  const failure = (reply, { status, text }) => {
    const { code: raw } = parse(text);
    const code = typeof raw === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(raw) ? raw : null;
    return reply.code(status).send({ error: code || `machine returned HTTP ${status}`, code });
  };
  // A success body never carries a credential the hub holds for this call back to the caller.
  const scrub = (text, secrets) => secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join('[redacted]'), text);
  const passThrough = (reply, status, text, secrets) => reply.code(status).type('application/json').send(scrub(text, secrets));
  const forgetSession = (kind, sessionId) => cleanupAgentBusCredentialLaunch({ backendType: kind, sessionId, credentialStore, reason: 'session_deleted' });
  const dropSession = async (kind, sessionId) => {
    store.update((state) => { delete state.sessions?.[`${kind}:${sessionId}`]; });
    await forgetSession(kind, sessionId);
  };

  // One supervisor per machine (§4.6): it moves between available, offline, connecting, backoff, connected and
  // blocked. Transient failures back off with equal jitter from 1 s to 5 min; blocked ones wait for a hello.
  const supervisors = new Map();
  const sup = (name) => supervisors.get(name) || supervisors.set(name, { phase: 'available', since: now(), attempt: 0, peer: null }).get(name);
  const down = (s) => supervise && ['offline', 'backoff', 'blocked'].includes(s.phase);
  const enter = (s, phase, peer = null) => { if (s.phase !== phase) Object.assign(s, { phase, since: now() }); s.peer = peer; };
  const schedule = (name, ms) => { const s = sup(name); timers.clear(s.timer); s.timer = timers.set(() => connect(name), ms); };
  const machineStatus = (name) => {
    const s = sup(name);
    // Live only once connected (or before the first contact); a reconnect in progress is still unreachable.
    const status = { blocked: 'blocked', backoff: 'unreachable', offline: 'unreachable', connecting: 'unreachable' }[supervise ? s.phase : ''] || 'live';
    return status === 'live' ? { id: name, status } : { id: name, status, since: s.since };
  };
  function failed(name, peer) {
    const s = sup(name);
    if (!supervise) return;
    if (BLOCKING.has(peer.code)) return void (timers.clear(s.timer), enter(s, 'blocked', peer));
    enter(s, 'backoff', peer);
    const cap = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** s.attempt++);
    schedule(name, cap / 2 + random() * cap / 2);
  }
  // A forgotten machine takes its sessions with it: index entries dropped, their bus tokens revoked.
  async function retire(name) {
    timers.clear(supervisors.get(name)?.timer);
    supervisors.delete(name);
    for (const entry of Object.values(store.read().sessions || {})) if (entry.machine === name) await dropSession(entry.kind, entry.sessionId);
    store.update((state) => { for (const [key, entry] of Object.entries(state.worktreeCleanup || {})) if (entry.machine === name) delete state.worktreeCleanup[key]; });
  }
  // A remote prompt takes the local path into the hub's Command Queue: one item per fingerprint, and a changed or gone prompt closes it.
  async function fileInteraction({ kind, sessionId, displayName, state }) {
    const { closeStaleSessionQueueItems } = await import('../integrations/command-center-ai.mjs');
    await closeStaleSessionQueueItems(kind, sessionId, state?.interaction?.fingerprint || null, { wsManager });
    await queueSessionInteraction({ id: kind, displayName: 'Claude' }, { sessionId, sessionName: displayName || sessionId, interaction: state?.interaction }, { wsManager });
  }
  async function apply(name, { sequence = 0, events = [], snapshot }) {
    const removed = [];
    const changed = [];
    store.update((state) => {
      // A snapshot lists every session the worker still has; a live entry it omits is gone.
      for (const entry of snapshot ? Object.values(state.sessions || {}) : []) {
        if (entry.machine !== name || entry.status !== 'live') continue;
        if (snapshot[`${entry.kind}:${entry.sessionId}`]) changed.push(Object.assign(entry, { state: snapshot[`${entry.kind}:${entry.sessionId}`] })); else removed.push(entry);
      }
      // Unknown event types are skipped and still advance the cursor.
      for (const event of events) {
        const entry = event.type === 'session' && state.sessions?.[event.key];
        if (entry?.machine !== name) continue;
        if (event.row) changed.push(Object.assign(entry, { state: event.row })); else removed.push(entry);
      }
      if (state.machines?.[name]) state.machines[name].cursor = sequence;
    });
    for (const entry of removed) await dropSession(entry.kind, entry.sessionId);
    for (const entry of [...changed, ...removed.map((gone) => ({ ...gone, state: null }))]) {
      await fileInteraction(entry).catch((error) => app.log.warn({ err: error.message }, 'Remote session prompt not filed'));
    }
  }
  // Remote returnResults children: the hub mirrors their prompt and stop events into a local hook log that the observer
  // reads as it reads a local child's. Each mirrored line carries the worker's cursor, so a hub restart or a reconnect
  // resumes after the last event seen and the mirror never holds an event twice.
  const hookFile = (entry) => ({ workDir: join(store.dir, 'hooks'), provider: entry.kind, sessionId: entry.sessionId });
  // A .git marker ends buildHookSessionPaths' walk up, so the mirror stays under the state dir even inside a checkout.
  mkdirSync(hookFile({}).workDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(hookFile({}).workDir, '.git'), '', { flag: 'a' });
  const returning = () => Object.values(store.read().sessions || {}).filter((entry) => entry.status === 'live' && entry.metadata?.spawnedBy);
  const unregisterHooks = registerHookSessionRegistry('claude', () => returning().map((entry) => [entry.sessionId,
    { workDir: hookFile(entry).workDir, metadata: entry.metadata, created: entry.created, lifecycle: entry.state?.status }]));
  app.addHook('onClose', async () => unregisterHooks());
  const hookCursors = new Map();
  let lastStamp = 0;
  async function mirrorHooks(name, row) {
    const fetched = [];
    for (const entry of returning().filter((item) => item.machine === name)) {
      const key = `${entry.kind}:${entry.sessionId}`;
      // Read once per hub process: the mirror's last line, or the cursor of a batch with no prompt or stop (which wrote no line).
      if (!hookCursors.has(key)) hookCursors.set(key, Math.max((await readHookEventsSince(hookFile(entry))).events.at(-1)?.machineCursor || 0, entry.hookCursor || 0));
      const cursor = hookCursors.get(key);
      const result = await send(row, 'GET', `/api/machine/hook-events?sessionId=${entry.sessionId}&cursor=${cursor}`).catch(() => null);
      const { events = [], cursor: next } = result?.status === 200 ? parse(result.text) : {};
      if (!(next > cursor)) continue;
      if (events.length) { fetched.push({ entry, key, events, next }); continue; }
      store.update((state) => { if (state.sessions?.[key]) state.sessions[key].hookCursor = next; });
      hookCursors.set(key, next);
    }
    // The observer compares these times with hub times (spawns, rooms, messages), and the worker clock can step between a hook
    // and this read. So each event gets the hub's receive time, strictly increasing in the worker's order across sessions.
    const order = fetched.flatMap(({ events }) => { let at = 0; return events.map((event) => ({ event, at: at = Math.max(at, Date.parse(event.loggedAt) || 0) })); });
    for (const { event } of order.sort((a, b) => a.at - b.at)) event.loggedAt = new Date(lastStamp = Math.max(now(), lastStamp + 1)).toISOString();
    for (const { entry, key, events, next } of fetched) {
      const { hooksDir, eventsPath } = await buildHookSessionPaths(hookFile(entry));
      await mkdir(hooksDir, { recursive: true });
      await appendFile(eventsPath, events.map((event) => `${JSON.stringify({ ...event, machineCursor: next })}\n`).join(''));
      hookCursors.set(key, next);
    }
  }
  async function attempt(name) {
    const s = sup(name);
    const row = store.read().machines?.[name];
    if (!row) return retire(name);
    if (!online()) return void (s.phase !== 'connected' && enter(s, 'offline'), schedule(name, BACKOFF_MIN_MS));
    if (s.phase !== 'connected') enter(s, 'connecting');
    let peer = await checkPeer(row.url, row.envId, { protocol });
    if (!peer.code) {
      const result = await send(row, 'GET', `/api/machine/events?afterSequence=${Number(row.cursor) || 0}`).catch(() => null);
      if (result?.status === 200) {
        await apply(name, parse(result.text));
        await mirrorHooks(name, row);
        await drainWorktrees(name, row);
        enter(s, 'connected');
        s.attempt = 0;
        return schedule(name, POLL_MS);
      }
      peer = { code: result && result.status < 500 ? 'machine_blocked' : 'machine_unreachable', detail: result ? `machine returned HTTP ${result.status}` : '' };
    }
    failed(name, peer);
  }
  const connect = (name) => { const s = sup(name); return s.busy ||= attempt(name).finally(() => { s.busy = null; }); };
  // Every credential send still checks the descriptor first; a machine known to be down is answered without a call.
  async function reach(name, row) {
    const s = sup(name);
    if (down(s)) return s.peer || { code: 'machine_unreachable' };
    const peer = row ? await checkPeer(row.url, row.envId, { protocol }) : { code: 'machine_unreachable' };
    if (peer.code) failed(name, peer);
    else if (supervise && s.phase === 'available') void connect(name);
    return peer;
  }
  // `cadre machine forget` only removes the row: the hub revokes that machine's session tokens within SWEEP_MS,
  // whatever phase its supervisor is in.
  let sweepTimer;
  async function sweep() {
    const state = store.read();
    const names = new Set([...supervisors.keys(), ...[...Object.values(state.sessions || {}), ...Object.values(state.worktreeCleanup || {})].map((entry) => entry.machine)]);
    for (const name of names) if (!state.machines?.[name]) await retire(name);
    sweepTimer = timers.set(sweep, SWEEP_MS);
  }
  if (supervise) {
    app.addHook('onReady', async () => {
      await sweep();
      for (const name of Object.keys(store.read().machines || {})) void connect(name);
    });
    app.addHook('onClose', async () => { timers.clear(sweepTimer); for (const s of supervisors.values()) timers.clear(s.timer); });
  }
  // Status from the supervisor; OS, protocol and providers as the machine last reported them, so an away machine still lists.
  async function machineInfo(name, row) {
    const peer = await reach(name, row);
    if (!peer.code) {
      const listed = await send(row, 'GET', '/api/agents/providers').catch(() => null);
      // Remote spawn runs Claude only for now, so only the worker's enabled Claude providers are offered.
      const providers = listed?.status === 200 ? (parse(listed.text).providers || [])
        .filter((entry) => entry.enabled !== false && entry.backendType === 'claude').map((entry) => entry.id) : row.providers;
      const report = { os: peer.os, protocol: peer.protocol, providers };
      if (JSON.stringify(report) !== JSON.stringify({ os: row.os, protocol: row.protocol, providers: row.providers })) {
        Object.assign(row, report);
        store.update((state) => { if (state.machines?.[name]) Object.assign(state.machines[name], report); });
      }
    }
    return { ...machineStatus(name), label: row.label || name, url: row.url, os: row.os || '', protocol: row.protocol ?? null, providers: row.providers || [] };
  }
  app.get('/api/machines', async () => ({ role, canAdd: Boolean(hubMcpUrl),
    machines: await Promise.all(Object.entries(store.read().machines || {}).map(([name, row]) => machineInfo(name, row))) }));
  app.post('/api/machines', async (req) => {
    operatorOnly(req);
    const { name, link } = req.body || {};
    return addMachine(store, name, link, { hubMcpUrl }).catch((error) => { throw error.statusCode ? error : fail(error.message, 'machine_pairing_failed'); });
  });
  app.decorate('machineRoutes', async (req, res, url) => {
    const answer = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); return true; };
    if (req.method === 'GET' && url.pathname === '/machine/descriptor') return answer(200, descriptor(store, { protocol }));
    if (req.method !== 'POST' || url.pathname !== '/machine/hello') return false;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const envId = bearer && store.helloPeer(bearer);
    const row = envId && Object.values(store.read().machines || {}).find((machine) => machine.envId === envId);
    if (!row) return answer(401, { error: 'Machine credential required' });
    // A hello resets the backoff and probes at once, blocked or not.
    if (supervise) { sup(row.id).attempt = 0; void connect(row.id); }
    return answer(200, { ok: true });
  });
  routeCommands?.((kind, sessionId, { keys, text, enter, source, expectedRevision, expectedFingerprint, expectedInteractionKind }) => (store.read().sessions?.[`${kind}:${sessionId}`]
    ? app.inject({ method: 'POST', url: `/api/${kind}/sessions/${sessionId}/${keys ? 'keys' : 'input'}`,
      // An in-process interaction answer (a Command Queue answer) was checked as the operator's already, as it is for a local
      // session, so it goes in with the operator bearer alone.
      headers: expectedFingerprint ? { authorization: buildInternalBypassHeaders().authorization } : buildInternalBypassHeaders(),
      payload: { ...(keys ? { keys: keys.join(' ') } : { text, enter, source }), expectedRevision, expectedFingerprint, expectedInteractionKind } }).then((res) => {
      if (res.statusCode >= 300) throw Object.assign(new Error(res.json().error || `input failed with HTTP ${res.statusCode}`), { payload: res.json() });
      return res.json();
    })
    : null));

  // Collab worktrees of remote participants live on their worker. A cleanup the worker cannot take now (with the room's
  // sessions there to end first) is recorded pending and retried after each successful poll; a worker answer settles it.
  // Resolves to the worker's answer only when it is final: sessions ended (or unknown there) and a removal or settled keep.
  const worktreeSend = async (row, { sessionIds = [], ...body }) => {
    for (const id of sessionIds) {
      const { status } = await send(row, 'DELETE', `/api/claude/sessions/${id}`);
      if (status >= 300 && status !== 404) return null;
    }
    const result = await send(row, 'POST', '/api/machine/worktree', body);
    const answer = result.status === 200 ? parse(result.text) : null;
    return answer && (body.create || answer.removed || SETTLED_KEEP.test(answer.reason || '')) ? answer : null;
  };
  app.decorate('machineWorktree', async (name, body) => {
    const row = store.read().machines?.[name];
    const answer = (await reach(name, row)).code ? null : await worktreeSend(row, body).catch(() => null);
    if (answer) return answer;
    if (body.create) throw fail(`Machine ${name}: worktree create failed`, 'machine_worktree_failed');
    store.update((state) => { (state.worktreeCleanup ||= {})[`${name}:${body.cleanup.roomId}`] = { machine: name, ...body }; });
    return { removed: false, pending: true, report: `worktree: cleanup pending until ${name} is reachable` };
  });
  async function drainWorktrees(name, row) {
    for (const [key, { machine, ...body }] of Object.entries(store.read().worktreeCleanup || {})) {
      if (machine !== name || !await worktreeSend(row, body).catch(() => null)) continue;
      store.update((state) => { delete state.worktreeCleanup[key]; });
    }
  }

  async function send(row, method, url, body, operator = false) {
    const res = await fetch(`${row.url}${url}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${row.credential}`, ...(operator ? { [HUB_OPERATOR_HEADER]: '1' } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, text: await res.text() };
  }

  async function createRemote(kind, req, reply) {
    const { machine, busCredential: _ignored, sessionId: requested, structured: _structured, mcpServers: _servers, ...body } = req.body;
    const row = store.read().machines?.[machine];
    if (!row) return reply.code(400).send({ error: `Unknown machine: ${machine}`, code: 'machine_unknown' });
    if (kind !== 'claude') return reply.code(400).send({ error: `machine ${machine} runs only claude sessions`, code: 'machine_kind_unsupported' });
    // Never queued: a machine that is down, or on another protocol (426), fails the spawn now.
    const peer = await reach(machine, row);
    if (peer.code) return unreachable(reply, peer, peer.code === 'machine_protocol_mismatch' ? 426 : 503);
    if (peer.commitWarning) req.log.warn({ machine }, peer.commitWarning);
    const trust = deriveSpawnTrust(req.duenoAuth, body.metadata);
    // A caller's id (a collab roster's, minted on the hub) is taken only when no local or remote session has it.
    const sessionId = requested ?? randomBytes(4).toString('hex');
    const key = `${kind}:${sessionId}`;
    if (requested !== undefined && (!/^[a-f0-9]{8,32}$/.test(requested) || store.read().sessions?.[key]
      || (await app.inject({ url: `/api/${kind}/sessions`, headers: buildInternalBypassHeaders() })).json().sessions?.some((row) => row.id === requested))) {
      return reply.code(400).send({ error: 'Invalid or duplicate sessionId', code: 'session_id_invalid' });
    }
    const issued = await prepareAgentBusCredentialLaunch({ backendType: kind, sessionId, credentialStore,
      coordinatorPolicy: trust.coordinatorPolicy, loopRegistrationPolicy: trust.loopRegistrationPolicy });
    const entry = { machine, kind, sessionId, workDir: String(body.workDir || ''), displayName: String(body.displayName || ''), created: now(), status: 'pending', metadata: trust.metadata };
    store.update((state) => { (state.sessions ||= {})[key] = entry; });
    // spawnedBy stays on the hub, which returns the child's results; the worker gets only the note it would have added.
    const { spawnedBy, ...metadata } = trust.metadata;
    const initialPrompt = spawnedBy && body.initialPrompt ? `${body.initialPrompt}\n\n${SPAWN_RESULT_NOTE}` : body.initialPrompt;
    const result = await send(row, 'POST', `/api/${kind}/sessions`, {
      ...body, initialPrompt, mcpProfile: 'dueno', metadata, sessionId, busCredential: issued?.token || '',
    }).catch(() => null);
    const ok = result && result.status < 300;
    store.update((state) => { if (ok) state.sessions[key].status = 'live'; else delete state.sessions[key]; });
    if (!ok) await cleanupAgentBusCredentialLaunch({ backendType: kind, sessionId, credentialStore, reason: 'launch_failed' });
    if (!result) return unreachable(reply, { code: 'machine_unreachable' });
    if (!ok) return failure(reply, result);
    const { sessionName, mcpCapabilities, initialPromptInjected, initialPromptError, initialPromptDelivery } = parse(result.text);
    return passThrough(reply, 200, JSON.stringify({ id: sessionId, sessionName, mcpCapabilities, initialPromptInjected,
      initialPromptError, initialPromptDelivery, machine }), [issued?.token, row.credential]);
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
    if (!row) await retire(entry.machine);
    const deleting = req.method === 'DELETE' && suffix === '';
    // Delete revokes the token at once, even while the worker sleeps.
    if (deleting) await forgetSession(kind, req.params.id);
    const peer = await reach(entry.machine, row);
    const detail = req.method === 'GET' && suffix === '';
    const ref = { url: row?.url || '' };
    // Detail answers from the cached row while the machine is away, so deliveries hold as machine_offline.
    if (peer.code && detail) {
      return reply.send({ id: entry.sessionId, displayName: entry.displayName, workDir: entry.workDir,
        state: { status: entry.state?.status || 'unknown', reason: peer.code },
        machine: { id: entry.machine, status: BLOCKING.has(peer.code) ? 'blocked' : 'unreachable', since: sup(entry.machine).since, ...ref } });
    }
    let body = req.body;
    let rotated = '';
    // Resume rotates the session token on the hub; it is refused before rotating if the session still runs.
    if (!peer.code && req.method === 'POST' && suffix === '/resume') {
      const current = await send(row, 'GET', `/api/${kind}/sessions/${req.params.id}`).catch(() => null);
      if (!current || !parse(current.text).sessionEnded) return reply.code(409).send({ error: 'Session is running or unreachable', code: 'session_already_running' });
      rotated = (await prepareAgentBusCredentialLaunch({ backendType: kind, sessionId: req.params.id, credentialStore, rotation: true,
        coordinatorPolicy: storedCoordinatorPolicy(entry.metadata),
        loopRegistrationPolicy: operatorResumeLoopRegistrationPolicy(req.duenoAuth?.principal, entry.metadata) }))?.token || '';
      body = { busCredential: rotated };
    }
    // The worker accepts a permission answer from the hub only when the hub's own caller holds that authority here.
    const operator = (() => { try { return Boolean(permissionAuthorityForRequest(req)); } catch { return false; } })();
    const result = peer.code ? null : await send(row, req.method, req.url, body, operator).catch(() => null);
    // Delete still proceeds while the worker is away: the token is revoked and the row dropped; tmux keeps running there.
    if (!result && deleting) {
      await dropSession(kind, req.params.id);
      return reply.send({ ok: true, status: 'already_gone', kind, sessionId: req.params.id, residual: [], reason: peer.code || 'machine_unreachable' });
    }
    if (peer.code) return unreachable(reply, peer);
    if (!result) return unreachable(reply, { code: 'machine_unreachable' });
    // The worker answers an unknown id with 404 or an ended payload coded session_not_found; a resumable one stays.
    const ended = parse(result.text);
    const gone = suffix === '' && (result.status === 404 || (ended.code === 'session_not_found' && !ended.canResume) || (deleting && result.status < 300));
    if (gone) await dropSession(kind, req.params.id);
    if (result.status >= 300) return failure(reply, result);
    // The UI's remote terminal view links to the worker's own UI. The worker just answered, so it is live: a reconnect
    // in progress must not read as away, or deliveries would hold (delivery.mjs).
    const text = detail ? JSON.stringify({ ...parse(result.text), machine: { id: entry.machine, status: 'live', ...ref } }) : result.text;
    return passThrough(reply, result.status, text, [row.credential, rotated]);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const [, kind, suffix] = SESSION_ROUTE.exec(req.routeOptions?.url || '') || [];
    if (!kind || suffix !== undefined || req.method !== 'GET' || reply.statusCode !== 200) return payload;
    const rows = Object.values(store.read().sessions || {}).filter((entry) => entry.kind === kind && entry.status === 'live');
    if (!rows.length) return payload;
    const body = JSON.parse(payload);
    body.sessions = [...(body.sessions || []), ...rows.map(({ sessionId, machine, workDir, displayName, created, state }) => ({
      id: sessionId, displayName, workDir, created, tmuxSession: `${kind}-${sessionId}`, ...(state ? { state } : {}), machine: machineStatus(machine),
    }))];
    return JSON.stringify(body);
  });
}
machinesPlugin[Symbol.for('skip-override')] = true;
