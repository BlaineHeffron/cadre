// Explicit, disposable real-provider smoke. Never run from production startup.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

for (const [key, value] of Object.entries({ CADRE_DISABLE_SIDE_EFFECTS: '1', CADRE_GITHUB_AGENT_POLLER_ENABLED: '0',
  CADRE_GITHUB_AGENTS_ENABLED: '0', CADRE_SCHEDULED_AGENT_PUMP_ENABLED: '0', TELEGRAM_BRIDGE: '0' })) {
  if (process.env[key] !== value) throw new Error(`Smoke requires ${key}=${value}`);
}
const root = await mkdtemp(join(tmpdir(), 'dueno-app-scoped-smoke-'));
const originalCwd = process.cwd();
try {
  // config.mjs loads dotenv on import: only import from this fresh, empty cwd.
  process.chdir(root);
  await smoke(root);
} finally {
  process.chdir(originalCwd);
  await rm(root, { recursive: true, force: true });
}

async function smoke(root) {
const [{ AgentBusCredentialStore }, { buildAgentBusMcpServer }, { startAgentBusMcpHttpServer }, { createCodexAppServerSessionProvider }] = await Promise.all([
  import('../modules/agent-bus/mcp-auth.mjs'), import('../modules/agent-bus/mcp.mjs'),
  import('../modules/agent-bus/mcp-http.mjs'), import('../modules/sessions/codex-app-server-sessions.mjs'),
]);
const sessionId = 'disposable-app-server-smoke';
const threadId = 'disposable-app-server-room';
const calls = [], messages = [];
let state = null;
const credentialStore = new AgentBusCredentialStore({ mode: 'enforce', stateFile: null,
  store: { mode: 'memory', async load() { return state; }, async save(value) { state = structuredClone(value); }, async close() {} } });
const room = () => ({ id: threadId, status: 'open', participants: [{ kind: 'codex-app-server', sessionId }], messages });
const mcp = buildAgentBusMcpServer({ credentialStore, requestImpl: async (path, options = {}) => {
  if (path.startsWith(`/api/agent-bus/threads/${threadId}`)) return { thread: room(), messages };
  if (path === '/api/agent-bus/messages' && options.method === 'POST') {
    const message = { id: `smoke-message-${messages.length + 1}`, ...options.body, createdAt: Date.now() };
    messages.push(message); return { message, delivery: { status: 'queued' } };
  }
  throw new Error(`Unscoped smoke request refused: ${path}`);
} });
const http = startAgentBusMcpHttpServer({ host: '127.0.0.1', port: 0, path: '/mcp', credentialStore,
  log: { info() {}, error() {} }, serverFactory: { async handleRequest(message, context) {
    const result = await mcp.handleRequest(message, context);
    if (message.method === 'tools/call') calls.push({ name: message.params.name,
      threadId: message.params.arguments?.thread_id, principal: context.authContext?.principal,
      ok: !result.error && !result.result?.isError, error: result.error?.message });
    return result;
  } } });
await once(http, 'listening');
let binding, timer;
try {
  binding = await createCodexAppServerSessionProvider({ sessionRoot: join(root, 'sessions'), credentialStore,
    sourceConfig: { agentBusMcpHttp: { host: '127.0.0.1', port: http.address().port, path: '/mcp' } } });
  binding.service.subscribe((_session, event) => {
    if (event.type === 'transport.event' && event.data.event.type === 'transport.error') console.log(JSON.stringify({ phase: 'transport_error', code: event.data.event.kind, message: event.data.event.message, inventory: event.data.event.startup?.tools?.map(server => ({ name: server.server, toolCount: server.names.length })) }));
  });
  timer = setTimeout(() => { void binding.close(); }, 100_000);
  const started = await binding.start({ sessionId, workDir: root, threadId, model: 'gpt-6-astra',
    permissionMode: 'read-only', approvalPolicy: 'never', ephemeral: true, toolScopes: ['mcp:discover', 'room_context', 'room_send'] });
  const startup = started.negotiated.startup;
  console.log(JSON.stringify({ phase: 'startup', model: startup.effectiveModel, modelEvidence: startup.modelEvidence,
    servers: startup.tools.map((server) => ({ name: server.server, runtimeStatus: server.runtimeStatus, tools: server.names })),
    providerThreadId: startup.providerThreadId }));
  await binding.service.prompt(sessionId, { idempotencyKey: 'scoped-smoke', blocks: [{ type: 'text', text:
    `Disposable local transport smoke. Use only dueno room_context to read thread_id ${threadId}, then dueno room_send with thread_id ${threadId} and body APP_SERVER_SCOPED_SMOKE_OK. Do not use any other tools, access files or credentials, or delegate. Then reply DONE.` }] });
  for (let count = 0; count < 900; count++) {
    const session = binding.service.get(sessionId);
    if (session.lifecycle === 'ready' && session.turns.length) break;
    if (['ended', 'interrupted'].includes(session.lifecycle)) throw new Error(`Smoke ended: ${session.detail}`);
    await delay(100);
  }
  console.log(JSON.stringify({ phase: 'turn', calls, turns: binding.service.get(sessionId).turns, text: binding.project(binding.service.get(sessionId)).content }));
  for (const name of ['room_context', 'room_send']) {
    assert.ok(calls.some((call) => call.name === name && call.ok && call.threadId === threadId && call.principal?.kind === 'codex-app-server' && call.principal.sessionId === sessionId), `Missing authenticated ${name} receipt`);
  }
  assert.ok(messages.some((message) => message.body === 'APP_SERVER_SCOPED_SMOKE_OK'));
  console.log(JSON.stringify({ phase: 'handshake', calls, replyCount: messages.length, lifecycle: binding.service.get(sessionId).lifecycle }));
} catch (error) {
  console.log(JSON.stringify({ phase: 'error', code: error.code || null, message: error.message })); process.exitCode = 1;
} finally {
  clearTimeout(timer); await binding?.close(); http.closeAllConnections();
  await new Promise((resolve) => http.close(resolve));
}
}
