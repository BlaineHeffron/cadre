// Multi-machine slices 1 and 2: a hub and a worker in this process on loopback ports, real HTTP between them,
// a real tmux server (private socket) running a stand-in claude binary on the worker side. Supervisor and
// wake timers are fake, so backoff runs only when a test fires it; jitter is fixed at the midpoint.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'cadre-machines-'));
const tmuxSocket = `cadre_machines_${process.pid}`;
const bin = join(root, 'bin');
const TOKEN = 'operator-token-for-machines';
await mkdir(bin, { recursive: true });
await mkdir(join(root, 'home'), { recursive: true });
await writeFile(join(bin, 'tmux'), `#!/bin/sh\nexec /usr/bin/tmux -L '${tmuxSocket}' "$@"\n`);
await writeFile(join(bin, 'claude'), "#!/bin/sh\nprintf 'Claude Code v2.1.296\\n────────────────────\\n❯ \\n────────────────────\\n  ⏵⏵ bypass permissions on\\n'\ncat >/dev/null\n");
await chmod(join(bin, 'tmux'), 0o755);
await chmod(join(bin, 'claude'), 0o755);
delete process.env.CADRE_STATE_DIR;
Object.assign(process.env, {
  AUTH_TOKEN: TOKEN, INTERNAL_BYPASS_TOKEN: 'internal-token-for-machines', HOME: join(root, 'home'),
  PATH: `${bin}:${process.env.PATH}`, APP_STATE_STORAGE: 'file', CLAUDE_SESSIONS_STORAGE: 'file', DATABASE_URL: '',
  DM_STATE_DIR: join(root, 'state'), DM_FLEET_PRIVATE_HOSTS_REF: 'CADRE_TEST_MACHINE_HOSTS', CADRE_TEST_MACHINE_HOSTS: '127.0.0.1',
});

const { default: Fastify } = await import('fastify');
const { createAgentBusHarness } = await import('./helpers/agent-bus-test-harness.mjs');
const { AgentBusCredentialStore } = await import('../modules/agent-bus/mcp-auth.mjs');
const { buildInProcessAgentBusMcpServer, buildInProcessFastifyRequest } = await import('../modules/agent-bus/in-process-mcp.mjs');
const { startAgentBusMcpHttpServer } = await import('../modules/agent-bus/mcp-http.mjs');
const { buildMonitorMcpServer } = await import('../modules/platform/monitor-mcp.mjs');
const { authPlugin, buildInternalBypassHeaders } = await import('../modules/platform/auth.mjs');
const { shouldSuppressSideEffectLoops } = await import('../modules/platform/side-effect-loops.mjs');
const { agentInterfacePlugin } = await import('../modules/agent/interface.mjs');
const { agentProviderPreferencesPlugin } = await import('../modules/agent/provider-preferences.mjs');
const { claudeSessionsPlugin } = await import('../modules/sessions/claude-sessions.mjs');
const { LOG_REDACT, MACHINE_PROTOCOL, machinesPlugin, machineState } = await import('../modules/machines/index.mjs');
const { mcpClientConfigPath, prepareAgentBusCredentialLaunch } = await import('../modules/integrations/mcp-launch-preflight.mjs');
const { runtimeStatePath } = await import('../modules/ops/runtime-state.mjs');
const { enqueueAgentSessionCommand, routeRemoteSessionCommands } = await import('../modules/sessions/index.mjs');

function fakeTimers() {
  const pending = new Set();
  return { pending, set: (fn, ms) => { const timer = { fn, ms }; pending.add(timer); return timer; }, clear: (timer) => pending.delete(timer),
    async fire() { const due = [...pending]; pending.clear(); for (const timer of due) await timer.fn(); return due.map((timer) => timer.ms); } };
}
const hubTimers = fakeTimers();
const workerTimers = fakeTimers();
let online = true; let skew = 0;

const logs = [];
const logger = () => ({ level: 'trace', redact: LOG_REDACT, stream: new Writable({ write(chunk, _enc, done) { logs.push(String(chunk)); done(); } }) });
const secrets = new Set();
const responses = [];
const hubDir = join(root, 'hub-state');
const workerDir = join(root, 'worker-state');
const hubStore = machineState(join(hubDir, 'machines'));
const workerStore = machineState(join(workerDir, 'machines'));
const busStore = new AgentBusCredentialStore({ stateFile: join(root, 'hub-bus.json'), mode: 'issue_only', env: { APP_STATE_STORAGE: 'file', DATABASE_URL: '' } });
let hub; let tailnet; let hubMcpUrl; let worker; let workerPort = 0; let workerUrl;

async function startWorker({ protocol = MACHINE_PROTOCOL, store = workerStore, sessions = true, port = workerPort } = {}) {
  const app = Fastify({ logger: logger() });
  await app.register(authPlugin, { workerMachines: store });
  await app.register(machinesPlugin, { role: 'worker', store, protocol, timers: workerTimers, now: () => Date.now() + skew });
  await app.register(agentProviderPreferencesPlugin);
  if (sessions) await app.register(claudeSessionsPlugin, { wsManager: { broadcast() {}, onChannel() {} } });
  await app.listen({ host: '127.0.0.1', port });
  return app;
}
async function restartWorker(options) {
  await worker?.close();
  worker = await startWorker(options);
}
async function call(url, { method = 'GET', token, body } = {}) {
  const res = await fetch(url, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body) });
  const text = await res.text();
  responses.push(text);
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}
async function tool(token, name, args = {}) {
  const { status, json } = await call(hubMcpUrl, { method: 'POST', token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } });
  return { status, isError: Boolean(json?.result?.isError || json?.error), text: json?.result?.content?.[0]?.text || json?.error?.message || '', value: json?.result?.structuredContent };
}
const cli = (dir, args, env = {}) => execFileAsync(process.execPath, ['scripts/cadre.mjs', ...args], { env: { ...process.env, DM_STATE_DIR: dir, ...env } })
  .then(({ stdout }) => ({ ok: true, out: stdout.trim() }), (error) => ({ ok: false, out: `${error.stdout}${error.stderr}` }));
const pair = () => cli(workerDir, ['pair'], { CADRE_ROLE: 'worker', HOST: '127.0.0.1', PORT: String(workerPort) }).then(({ out }) => { secrets.add(out.split('.').at(-1)); return out; });
const addMachine = (name, link) => cli(hubDir, ['machine', 'add', name, link], { CADRE_HUB_MCP_URL: hubMcpUrl });
const pane = async (id) => (await execFileAsync('/usr/bin/tmux', ['-L', tmuxSocket, 'capture-pane', '-p', '-J', '-S', '-', '-t', `claude-${id}`])).stdout;
async function until(check, label) {
  for (let i = 0; i < 200; i += 1) { const value = await check(); if (value) return value; await new Promise((r) => setTimeout(r, 50)); }
  assert.fail(`timed out waiting for ${label}`);
}

before(async () => {
  hub = await createAgentBusHarness({ authToken: TOKEN, pollMs: 50, credentialStore: busStore, logger: logger(), beforeReady: async (app) => {
    await app.register(machinesPlugin, { role: 'hub', store: hubStore, credentialStore: busStore, supervise: true, timers: hubTimers,
      random: () => 0.5, online: () => online, routeCommands: routeRemoteSessionCommands });
    await app.register(agentInterfacePlugin);
  } });
  const requestImpl = buildInProcessFastifyRequest({ app: hub.app, buildHeaders: () => buildInternalBypassHeaders() });
  const serverFactory = buildInProcessAgentBusMcpServer({ requestImpl, monitorMcp: buildMonitorMcpServer({ requestImpl }), credentialStore: busStore });
  tailnet = startAgentBusMcpHttpServer({ host: '127.0.0.1', port: 0, credentialStore: busStore, serverFactory, requireCredential: true, machineRoutes: hub.app.machineRoutes, log: { info() {}, error() {} } });
  await once(tailnet, 'listening');
  hubMcpUrl = `http://127.0.0.1:${tailnet.address().port}/mcp`;
  worker = await startWorker();
  workerPort = worker.server.address().port;
  workerUrl = `http://127.0.0.1:${workerPort}`;
});
after(async () => {
  await worker?.close();
  await new Promise((resolve) => tailnet.close(resolve));
  await hub.cleanup();
  await execFileAsync('/usr/bin/tmux', ['-L', tmuxSocket, 'kill-server']).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

describe('multi-machine slice 1', () => {
  let remoteId; let agentToken; let childToken;

  it('rejects unpaired requests on the worker and the hub tailnet listener, even in issue_only', async () => {
    assert.equal(busStore.mode, 'issue_only');
    assert.equal((await call(`${workerUrl}/api/claude/sessions`)).status, 401);
    assert.equal((await call(`${workerUrl}/api/claude/sessions`, { method: 'POST', token: TOKEN, body: { workDir: root } })).status, 401);
    assert.equal((await call(`${workerUrl}/api/pairing/forget`, { method: 'POST', token: TOKEN })).status, 401);
    const descriptor = await call(`${workerUrl}/api/machine/descriptor`);
    assert.equal(descriptor.status, 200);
    assert.deepEqual(Object.keys(descriptor.json).sort(), ['commit', 'label', 'machineId', 'os', 'protocol']);
    assert.equal((await call(`${workerUrl}/api/pairing/redeem`, { method: 'POST', body: { pairCode: 'WRONG', hubEnvId: 'x', hubCredential: 'y', hubMcpUrl } })).status, 403);
    assert.equal((await tool('', 'room_list')).status, 401);
  });

  it('pairs only after the descriptor matches, without spending the code or sending a secret on a mismatch', async () => {
    const link = await pair();
    const seen = [];
    const capture = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ machineId: 'someone-else', protocol: MACHINE_PROTOCOL }));
    }).listen(0, '127.0.0.1');
    await once(capture, 'listening');
    const impostor = await addMachine('w1', link.replace(workerUrl, `http://127.0.0.1:${capture.address().port}`));
    capture.close();
    assert.equal(impostor.ok, false);
    assert.match(impostor.out, /blocked/);
    assert.deepEqual(seen, [{ method: 'GET', url: '/api/machine/descriptor', authorization: undefined }]);

    await restartWorker({ protocol: MACHINE_PROTOCOL + 1 });
    assert.match((await addMachine('w1', link)).out, /protocol/);
    await restartWorker();
    const paired = await addMachine('w1', link);
    assert.equal(paired.ok, true, paired.out);
    assert.match(paired.out, /Paired w1/);
    assert.equal((await addMachine('w2', link)).ok, false, 'a used code is rejected');
    const expired = `${workerUrl}/#${workerStore.machineId()}.${workerStore.issueCode(Date.now() - 6 * 60_000)}`;
    assert.equal((await addMachine('w2', expired)).ok, false, 'an expired code is rejected');
    const stored = await readFile(join(workerDir, 'machines', 'machines.json'), 'utf8');
    for (const code of secrets) assert.ok(!stored.includes(code), 'codes are stored only as hashes');
    secrets.add(hubStore.read().machines.w1.credential);
    secrets.add(workerStore.read().hub.credential);
  });

  it('spawns on the worker with a hub-minted token that goes only to the hub origin', async () => {
    agentToken = (await prepareAgentBusCredentialLaunch({ backendType: 'claude', sessionId: 'claude-1', credentialStore: busStore })).token;
    const workDir = await mkdtemp(join(root, 'repo-'));
    const spawned = await tool(agentToken, 'spawn_session', { provider: 'claude', machine: 'w1', workDir, displayName: 'remote child' });
    assert.equal(spawned.isError, false, spawned.text);
    remoteId = spawned.value.participants[0].session_id;
    assert.match(remoteId, /^[a-f0-9]{8}$/);
    const mcpConfig = JSON.parse(await readFile(mcpClientConfigPath('claude', remoteId), 'utf8')).mcpServers.dueno;
    assert.equal(mcpConfig.url, hubMcpUrl);
    childToken = mcpConfig.headers.Authorization.slice('Bearer '.length);
    secrets.add(childToken);
    assert.equal((await busStore.authenticate(childToken)).principal.sessionId, remoteId);
    await assert.rejects(stat(runtimeStatePath('agent_bus_mcp_credentials.json')), /ENOENT/, 'the worker never mints');

    const directory = await tool(agentToken, 'agent_directory');
    assert.deepEqual(directory.value.agents.find((agent) => agent.sessionId === remoteId)?.machine, { id: 'w1', status: 'live' });
    const returning = await tool(agentToken, 'spawn_session', { provider: 'claude', machine: 'w1', workDir, returnResults: true });
    assert.match(returning.text, /returnResults is not supported/);
    for (const windowsPath of ['C:\\Users\\me\\repo', '\\\\wsl$\\Ubuntu\\home', '/mnt/c/Users/me']) {
      assert.match((await tool(agentToken, 'spawn_session', { provider: 'claude', machine: 'w1', workDir: windowsPath })).text, /workdir_windows_path_unsupported/);
    }
    const missing = await hub.app.inject({ method: 'POST', url: '/api/claude/sessions', headers: hub.authHeaders, payload: { machine: 'w1', workDir: join(root, 'no-such-dir') } });
    assert.deepEqual([missing.statusCode, missing.json()], [400, { error: 'machine returned HTTP 400', code: null }], 'worker error bodies stay on the worker');
    hubStore.update((state) => { state.sessions['claude:deadbeef'] = { machine: 'w1', kind: 'claude', sessionId: 'deadbeef', status: 'live' }; });
    assert.equal((await hub.app.inject({ url: '/api/claude/sessions/deadbeef', headers: hub.authHeaders })).json().code, 'session_not_found');
    assert.equal(hubStore.read().sessions['claude:deadbeef'], undefined, 'a session the worker no longer has leaves the index');
  });

  it('a create carrying the worker credential stamps no coordinator or operator loop metadata', async () => {
    const metadata = { coordinatorControlPolicy: { policyId: 'p' }, duenoCoordinatorControl: { issuedBy: 'scheduled-agent-pump' },
      duenoCoordinatorOwner: { policyId: 'p' }, duenoLoopRegistration: { version: 1, issuedBy: 'authenticated-operator' }, note: 'kept' };
    const created = await call(`${workerUrl}/api/claude/sessions`, { method: 'POST', token: hubStore.read().machines.w1.credential,
      body: { workDir: root, displayName: 'direct', metadata, sessionId: 'abcdef01', busCredential: '' } });
    assert.equal(created.status, 200, created.text);
    const saved = JSON.parse(await readFile(runtimeStatePath('claude_sessions.json'), 'utf8'));
    const row = (Array.isArray(saved) ? saved : saved.sessions || Object.values(saved)).find((entry) => entry.id === 'abcdef01');
    assert.deepEqual(row.metadata, { note: 'kept' });
  });

  it('scopes each credential to one role and one machine', async () => {
    const workerCredential = hubStore.read().machines.w1.credential;
    const hubCredential = workerStore.read().hub.credential;
    assert.equal((await call(`${workerUrl}/api/claude/sessions`, { method: 'POST', token: hubCredential, body: { workDir: root } })).status, 401, 'bus:agent cannot create sessions');
    assert.equal((await hub.app.inject({ url: '/api/claude/sessions', headers: { authorization: `Bearer ${workerCredential}` } })).statusCode, 403, 'worker:operate cannot reach hub routes');
    assert.equal((await tool(workerCredential, 'room_list')).status, 401);
    assert.equal((await tool(hubCredential, 'room_list')).status, 401);
    const other = await startWorker({ store: machineState(join(root, 'other-worker')), sessions: false, port: 0 });
    const otherUrl = `http://127.0.0.1:${other.server.address().port}`;
    assert.equal((await call(`${otherUrl}/api/pairing/forget`, { method: 'POST', token: workerCredential })).status, 401, 'one machine credential fails on another');
    assert.equal((await call(`${workerUrl}/api/agent-provider-preferences`, { token: workerCredential })).status, 403, 'worker:operate is limited to session routes');
    assert.equal((await call(`${workerUrl}/api/agent-provider-preferences`, { token: TOKEN })).status, 200, 'the worker UI token still reads');
    await other.close();
  });

  it('a worker that echoes credentials gets status and a code through, never the secret', async () => {
    const hostile = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const echo = `${req.headers.authorization} ${JSON.parse(raw || '{}').busCredential || ''}`;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/machine/descriptor') return res.end(JSON.stringify({ machineId: 'hostile-id', protocol: MACHINE_PROTOCOL }));
      if (req.method === 'POST' && req.url === '/api/claude/sessions') return res.end(JSON.stringify({ sessionName: echo, initialPromptError: echo }));
      if (req.method === 'GET') return res.end(JSON.stringify({ content: echo }));
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: echo, code: echo }));
    }).listen(0, '127.0.0.1');
    await once(hostile, 'listening');
    const credential = 'hostile-row-credential-secret';
    hubStore.update((state) => { state.machines.hostile = { id: 'hostile', url: `http://127.0.0.1:${hostile.address().port}`, envId: 'hostile-id', credential }; });
    const created = await hub.app.inject({ method: 'POST', url: '/api/claude/sessions', headers: hub.authHeaders, payload: { machine: 'hostile', workDir: '/srv/repo' } });
    const { id } = created.json();
    const input = await hub.app.inject({ method: 'POST', url: `/api/claude/sessions/${id}/input`, headers: hub.authHeaders, payload: { text: 'hi' } });
    const detail = await hub.app.inject({ url: `/api/claude/sessions/${id}`, headers: hub.authHeaders });
    hostile.close();
    hubStore.update((state) => { delete state.machines.hostile; delete state.sessions[`claude:${id}`]; });
    assert.equal(created.statusCode, 200);
    assert.deepEqual([input.statusCode, input.json()], [400, { error: 'machine returned HTTP 400', code: null }]);
    for (const body of [created.body, input.body, detail.body]) {
      assert.ok(!body.includes(credential) && !body.includes('dueno_mcp_v1.'), body);
    }
  });

  it('the child talks to hub rooms; a room message to it stays queued while the worker is down or mismatched, then injects once', async () => {
    const thread = (await hub.app.inject({ method: 'POST', url: '/api/agent-bus/threads', headers: hub.authHeaders,
      payload: { title: 'cross-machine', participants: [{ kind: 'claude', sessionId: 'claude-1' }, { kind: 'claude', sessionId: remoteId }] } })).json().thread;
    const sent = await tool(childToken, 'room_send', { thread_id: thread.id, body: 'hello from the worker' });
    assert.equal(sent.isError, false, sent.text);
    assert.ok(hub.store.listMessages().some((message) => message.from.sessionId === remoteId));

    await worker.close();
    const posted = await hub.app.inject({ method: 'POST', url: '/api/agent-bus/messages', headers: hub.authHeaders,
      payload: { threadId: thread.id, from: { kind: 'claude', sessionId: 'claude-1' }, body: 'ping across machines' } });
    assert.equal(posted.statusCode, 200, posted.body);
    const messageId = posted.json().message.id;
    const delivery = () => hub.store.getDeliveryForMessage(messageId);
    await until(() => delivery()?.holdReason === 'machine_offline' && delivery().holdDetail === 'machine_unreachable', 'an unreachable hold');
    worker = await startWorker({ protocol: MACHINE_PROTOCOL + 1 });
    await until(() => delivery()?.holdDetail === 'machine_protocol_mismatch', 'a protocol-mismatch hold');
    assert.equal(delivery().status, 'queued');
    await restartWorker();
    await until(() => delivery()?.status === 'injected', 'injection');
    await until(async () => (await pane(remoteId)).includes(`id=${messageId}`), 'the envelope in the worker pane');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await pane(remoteId)).split(`id=${messageId}`).length - 1, 1, 'injected exactly once');
  });

  it('revokes on the next call on both sides; forget while the worker is down completes on reconnect', async () => {
    const workerCredential = hubStore.read().machines.w1.credential;
    await worker.close();
    const deleted = await hub.app.inject({ method: 'DELETE', url: `/api/claude/sessions/${remoteId}`, headers: hub.authHeaders });
    assert.deepEqual([deleted.statusCode, deleted.json().ok], [200, true], 'delete proceeds while the worker sleeps');
    assert.equal((await busStore.authenticate(childToken)).ok, false, 'and revokes the token');
    assert.equal(hubStore.read().sessions[`claude:${remoteId}`], undefined);
    assert.match((await cli(hubDir, ['machine', 'forget', 'w1'])).out, /Pending on unreachable workers: w1/);
    const spawn = await hub.app.inject({ method: 'POST', url: '/api/claude/sessions', headers: hub.authHeaders, payload: { machine: 'w1', workDir: root } });
    assert.equal(spawn.json().code, 'machine_unknown');
    worker = await startWorker();
    assert.equal((await call(`${workerUrl}/api/claude/sessions/${remoteId}`, { token: workerCredential })).status, 200, 'still paired until the worker hears');
    assert.match((await cli(hubDir, ['machine', 'forget', 'w1'])).out, /Revoked on both sides/);
    assert.equal((await call(`${workerUrl}/api/claude/sessions/${remoteId}`, { token: workerCredential })).status, 403);
    assert.equal(workerStore.read().hub, undefined);
    const unusedLink = await pair();
    await cli(workerDir, ['unpair']);
    assert.equal((await addMachine('w3', unusedLink)).ok, false, 'unpair revokes outstanding codes');
  });

  it('a worker forces loops off and refuses to bind an address that is not its Tailscale IP', async () => {
    assert.equal(shouldSuppressSideEffectLoops({ env: { CADRE_ROLE: 'worker', CADRE_ALLOW_SIDE_EFFECTS: '1', PORT: '4310' } }), true);
    await writeFile(join(bin, 'tailscale'), '#!/bin/sh\necho 100.64.0.7\n', { mode: 0o755 });
    const result = await execFileAsync(process.execPath, ['server.mjs'], { timeout: 60_000, env: { PATH: process.env.PATH, HOME: process.env.HOME,
      NODE_TEST_CONTEXT: '1', CADRE_ROLE: 'worker', HOST: '127.0.0.1', PORT: '0', DM_STATE_DIR: join(root, 'boot') } }).catch((error) => error);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /requires HOST to be this node's Tailscale IP \(100\.64\.0\.7\), got 127\.0\.0\.1/);
  });

});

describe('multi-machine slice 2', () => {
  let a; let b; let tokenA; let tokenB; let delivery;
  const create = (displayName) => hub.app.inject({ method: 'POST', url: '/api/claude/sessions', headers: hub.authHeaders, payload: { machine: 'w5', workDir: root, displayName } });
  const tokenOf = async (id) => JSON.parse(await readFile(mcpClientConfigPath('claude', id), 'utf8')).mcpServers.dueno.headers.Authorization.slice('Bearer '.length);
  const listed = async (id) => (await hub.app.inject({ url: '/api/claude/sessions', headers: hub.authHeaders })).json().sessions.find((row) => row.id === id);
  const status = async () => (await listed(a))?.machine.status;
  const events = async (after) => (await call(`${workerUrl}/api/machine/events?afterSequence=${after}`, { token: hubStore.read().machines.w5.credential })).json;
  const pending = () => [...hubTimers.pending].map((timer) => timer.ms);
  const authenticates = async (token) => (await busStore.authenticate(token)).ok;

  it('a spawn starts the supervisor; events fill the rows and replay from any cursor; in-process commands reach the remote pane', async () => {
    assert.equal((await addMachine('w5', await pair())).ok, true);
    a = (await create('a')).json().id;
    b = (await create('b')).json().id;
    [tokenA, tokenB] = [await tokenOf(a), await tokenOf(b)];
    secrets.add(tokenA).add(tokenB);
    await until(async () => { await hubTimers.fire(); return (await listed(a))?.state && (await listed(b))?.state; }, 'rows filled from events');
    assert.deepEqual((await listed(a)).machine, { id: 'w5', status: 'live' });
    assert.deepEqual(pending(), [5000]);
    const all = await events(0);
    assert.ok(all.events.every((event, index) => event.sequence === index + 1), 'a contiguous, persisted sequence');
    assert.deepEqual((await events(0)).events.slice(0, all.events.length), all.events, 'a cursor replays the same events');
    assert.deepEqual((await events(hubStore.read().machines.w5.cursor)).events, [], 'the hub cursor has seen every event');
    await enqueueAgentSessionCommand('claude', b, { text: 'from the command queue', enter: true, source: 'test' });
    await until(async () => (await pane(b)).includes('from the command queue'), 'an in-process command in the remote pane');
  });

  it('while the worker is away: rows show unreachable with since and the last state, spawn fails closed, deliveries hold, backoff grows to 5 min', async () => {
    const before = (await listed(a)).state;
    await worker.close();
    assert.deepEqual(await hubTimers.fire(), [5000]);
    const row = await listed(a);
    assert.deepEqual([row.machine.status, row.state], ['unreachable', before]);
    assert.ok(row.machine.since <= Date.now());
    const spawn = await create('c');
    assert.deepEqual([spawn.statusCode, spawn.json().code], [503, 'machine_unreachable']);
    const thread = (await hub.app.inject({ method: 'POST', url: '/api/agent-bus/threads', headers: hub.authHeaders,
      payload: { title: 'sleepy laptop', participants: [{ kind: 'claude', sessionId: 'claude-1' }, { kind: 'claude', sessionId: a }] } })).json().thread;
    const posted = await hub.app.inject({ method: 'POST', url: '/api/agent-bus/messages', headers: hub.authHeaders,
      payload: { threadId: thread.id, from: { kind: 'claude', sessionId: 'claude-1' }, body: 'while you slept' } });
    delivery = () => hub.store.getDeliveryForMessage(posted.json().message.id);
    await until(() => delivery()?.holdReason === 'machine_offline', 'a machine_offline hold');
    const delays = [];
    for (let i = 0; i < 10; i += 1) delays.push(...await hubTimers.fire());
    assert.deepEqual(delays, [750, 1500, 3000, 6000, 12000, 24000, 48000, 96000, 192000, 225000], 'equal jitter at the midpoint, capped at 5 min');
    assert.equal(delivery().status, 'queued');
  });

  it('the boot hello resets the 5 min backoff; the held delivery injects once and session tokens survive', async () => {
    worker = await startWorker();
    await until(async () => await status() === 'live', 'a reconnect on hello');
    assert.deepEqual(pending(), [5000], 'the hello replaced the 5 min backoff');
    await until(() => delivery()?.status === 'injected', 'the held delivery injected');
    const messageId = delivery().messageId;
    await until(async () => (await pane(a)).includes(`id=${messageId}`), 'the envelope in the pane');
    assert.equal((await pane(a)).split(`id=${messageId}`).length - 1, 1, 'injected exactly once');
    assert.equal(await authenticates(tokenA), true);
  });

  it('a protocol mismatch blocks with no retry until the upgraded worker says hello; a moved address blocks before any credential', async () => {
    await restartWorker({ protocol: MACHINE_PROTOCOL + 1 });
    await until(async () => await status() === 'blocked', 'blocked on protocol');
    assert.deepEqual(pending(), [], 'blocked does not retry');
    const spawn = await create('d');
    assert.deepEqual([spawn.statusCode, spawn.json().code], [426, 'machine_protocol_mismatch']);
    await restartWorker();
    await until(async () => await status() === 'live', 'unblocked by the upgraded worker');

    const seen = [];
    const moved = http.createServer((req, res) => { seen.push([req.url, req.headers.authorization]); res.end(JSON.stringify({ machineId: 'another-machine', protocol: MACHINE_PROTOCOL })); }).listen(0, '127.0.0.1');
    await once(moved, 'listening');
    hubStore.update((state) => { state.machines.w5.url = `http://127.0.0.1:${moved.address().port}`; });
    await hubTimers.fire();
    moved.close();
    assert.deepEqual([await status(), pending(), seen], ['blocked', [], [['/api/machine/descriptor', undefined]]]);
    hubStore.update((state) => { state.machines.w5.url = workerUrl; });
    const hello = `${new URL(hubMcpUrl).origin}/machine/hello`;
    assert.equal((await call(hello, { method: 'POST', token: 'not-a-credential' })).status, 401);
    assert.equal((await call(hello, { method: 'POST', token: workerStore.read().hub.credential })).status, 200);
    await until(async () => await status() === 'live', 'unblocked by a hello');
  });

  it('a hub without network waits without backing off; a late tick after a sleep says hello; the cursor replays what was missed', async () => {
    await worker.close();
    await hubTimers.fire();
    online = false;
    worker = await startWorker();
    await until(() => pending()[0] === 1000, 'offline on the boot hello');
    const cursor = hubStore.read().machines.w5.cursor;
    const removed = await call(`${workerUrl}/api/claude/sessions/${b}`, { method: 'DELETE', token: hubStore.read().machines.w5.credential });
    assert.equal(removed.status, 200, removed.text);
    assert.deepEqual([await hubTimers.fire(), pending(), await status()], [[1000], [1000], 'unreachable'], 'offline does not grow the backoff');
    online = true;
    skew = 10 * 60_000;
    await workerTimers.fire();
    skew = 0;
    await until(async () => await status() === 'live', 'reconnected by the wake hello');
    await until(async () => { await hubTimers.fire(); return !hubStore.read().sessions[`claude:${b}`]; }, 'the removal replayed');
    const missed = (await events(cursor)).events;
    assert.ok(missed.every((event, index) => event.sequence === cursor + index + 1), 'no gap after the cursor');
    assert.deepEqual(missed.filter((event) => event.key === `claude:${b}`).map((event) => event.row), [null], 'the removal, once');
    assert.equal(await authenticates(tokenB), false, 'a session gone from the worker loses its token');
  });

  it('resume rotates the token on the hub, and refuses a running session before rotating', async () => {
    const resume = () => hub.app.inject({ method: 'POST', url: `/api/claude/sessions/${a}/resume`, headers: hub.authHeaders });
    const running = await resume();
    assert.deepEqual([running.statusCode, running.json().code], [409, 'session_already_running']);
    assert.equal(await authenticates(tokenA), true);
    await execFileAsync('/usr/bin/tmux', ['-L', tmuxSocket, 'kill-session', '-t', `claude-${a}`]);
    let resumed;
    await until(async () => (resumed = await resume()).statusCode !== 409, 'the worker reports the session ended');
    assert.equal(resumed.statusCode, 200, resumed.body);
    const rotated = await tokenOf(a);
    secrets.add(rotated);
    assert.deepEqual([await authenticates(tokenA), await authenticates(rotated)], [false, true]);
    tokenA = rotated;
  });

  it('forget drops the machine sessions and revokes their tokens on the hub', async () => {
    assert.match((await cli(hubDir, ['machine', 'forget', 'w5'])).out, /Revoked on both sides/);
    await hubTimers.fire();
    assert.equal(hubStore.read().sessions[`claude:${a}`], undefined);
    assert.equal(await authenticates(tokenA), false);
    assert.equal(await listed(a), undefined);
  });
});

it('never returns or logs a pairing code, machine credential or bus token', () => {
  assert.ok(logs.length > 0);
  const logText = logs.join('');
  for (const secret of secrets) {
    assert.ok(!logText.includes(secret), 'secret in logs');
    assert.ok(!responses.some((text) => text.includes(secret)), 'secret in a response');
  }
});
