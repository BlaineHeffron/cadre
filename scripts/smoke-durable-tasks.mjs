// Explicit manual smoke: two disposable real Codex tasks and a local authenticated
// MCP endpoint. Never imports server.mjs or uses production state/room identities.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const safeFlags = { CADRE_DISABLE_SIDE_EFFECTS: '1', CADRE_GITHUB_AGENT_POLLER_ENABLED: '0',
  CADRE_GITHUB_AGENTS_ENABLED: '0', CADRE_SCHEDULED_AGENT_PUMP_ENABLED: '0', TELEGRAM_BRIDGE: '0' };
if (!process.argv.includes('--run') || Object.entries(safeFlags).some(([key, value]) => process.env[key] !== value) || existsSync('.env')) {
  throw new Error('Use --run with safe side-effect flags from an env-free cwd');
}
const { default: Fastify } = await import('fastify');
const { authPlugin, buildInternalBypassHeaders } = await import('../modules/platform/auth.mjs');
const { AgentBusStore } = await import('../modules/agent-bus/store.mjs');
const { AgentBusCredentialStore } = await import('../modules/agent-bus/mcp-auth.mjs');
const { agentBusPlugin } = await import('../modules/agent-bus/index.mjs');
const { buildAgentBusMcpServer } = await import('../modules/agent-bus/mcp.mjs');
const { buildInProcessFastifyRequest } = await import('../modules/agent-bus/in-process-mcp.mjs');
const { startAgentBusMcpHttpServer } = await import('../modules/agent-bus/mcp-http.mjs');
const { createCodexAppServerSessionProvider } = await import('../modules/sessions/codex-app-server-sessions.mjs');
const { TASK_TOOLS } = await import('../modules/agent-bus/task-routes.mjs');
const root = await mkdtemp(join(tmpdir(), 'dueno-real-fanout-'));
const token = randomBytes(32).toString('hex'), bypass = randomBytes(32).toString('hex');
let credentialState;
const credentials = new AgentBusCredentialStore({ mode: 'enforce', store: {
  mode: 'memory', load: async () => credentialState, save: async (next) => { credentialState = structuredClone(next); }, close: async () => {},
} });
const issued = await credentials.issue({ principal: { type: 'agent', kind: 'codex', sessionId: 'disposable-parent' }, attemptGeneration: 1,
  threadAllowlist: ['@member'], toolScopes: ['mcp:discover', 'room_context', 'room_send', ...TASK_TOOLS.map((tool) => tool.name)] });
const parent = await credentials.authenticate(issued.token);
let app, store, binding, http, mcp;
const calls = [];
async function open() {
  app = Fastify();
  await app.register(authPlugin, { token, internalBypassToken: bypass });
  const requestImpl = buildInProcessFastifyRequest({ app, buildHeaders: () => buildInternalBypassHeaders({ authToken: token, bypassToken: bypass }) });
  mcp = buildAgentBusMcpServer({ requestImpl, credentialStore: credentials });
  http = startAgentBusMcpHttpServer({ port: 0, credentialStore: credentials, log: { info() {}, error() {} }, serverFactory: {
    async handleRequest(message, context) {
      const response = await mcp.handleRequest(message, context);
      if (message.method === 'tools/call') calls.push({ name: message.params.name,
        principal: context.authContext?.principal, ok: !response.error && !response.result?.isError });
      return response;
    },
  } });
  await once(http, 'listening');
  binding = await createCodexAppServerSessionProvider({ sessionRoot: join(root, 'sessions'), credentialStore: credentials,
    sourceConfig: { agentBusMcpHttp: { host: '127.0.0.1', port: http.address().port, path: '/mcp' } },
    mcpCatalog: { servers: [{ id: 'dueno' }] },
  });
  store = new AgentBusStore({ stateDir: join(root, 'bus') });
  await app.register(agentBusPlugin, { store, credentialStore: credentials });
  await app.ready();
}
async function close() {
  await app?.close(); await binding?.close();
  if (http) await new Promise((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  await store?.close();
}
const call = async (name, args) => (await mcp.callTool(name, args, parent)).structuredContent;
const delegation = process.argv.includes('--delegate');
const receipt = { root, startedAt: new Date().toISOString(), model: 'gpt-6-astra', children: [], delegation };
try {
  await open();
  const room = await store.createThread({ title: 'Disposable durable task smoke', participants: [{ kind: 'codex', sessionId: 'disposable-parent' }] });
  const spawn = (task_key) => call('task_spawn', { thread_id: room.id, task_key, spec: {
    provider: 'codex-app-server', model: 'gpt-6-astra', workDir: root,
    initialPrompt: delegation && task_key === 'one'
      ? `Disposable bounded delegation smoke. Use only Cadre task tools; no file access, shell commands or other tools. Your own task ID was supplied in your startup handshake. Use that exact ID as both thread_id and parent_task_id. Call task_spawn twice, task_key nested-one and nested-two, with spec provider codex-app-server, model gpt-6-astra, workDir ${root}, initialPrompt "Do not use tools, files or delegation. Reply exactly NESTED_ONE_OK." and "Do not use tools, files or delegation. Reply exactly NESTED_TWO_OK." respectively. Repeat nested-one spawn with identical arguments and verify the same taskId. Attempt a third task_key nested-three with the same spec and verify task_scope_denied; do not try another path. Use task_wait with both child task_ids and timeout_ms 1000 until both completed results actually contain the expected outputs. Pass the returned after cursor on your next wait to acknowledge consumption, including one final wait after both results. If task_wait returns task_wait_timeout, retry that exact wait with the same cursor; do not advance it or repeat other operations. Then reply exactly DURABLE_ONE_OK. On any failure describe it truthfully instead.`
      : `No file access, commands, delegation or external tools. Reply exactly DURABLE_${task_key.toUpperCase()}_OK.`,
  } });
  const children = [await spawn('one'), await spawn('two')];
  assert.equal((await spawn('one')).taskId, children[0].taskId);
  let cursor;
  const results = new Map();
  for (let i = 0; i < 240 && results.size < 2; i++) {
    let page;
    try {
      page = await call('task_wait', { thread_id: room.id, task_ids: children.map((child) => child.taskId), ...(cursor ? { after: cursor } : {}), timeout_ms: 1000 });
    } catch (error) {
      if (error.code !== 'task_wait_timeout') throw error;
      await delay(250);
      continue; // Retry only the same idempotent cursor acknowledgment.
    }
    cursor = page.cursor;
    for (const result of page.results) if (result.data.state === 'completed') results.set(result.taskId, result);
    for (const state of page.states) if (['startup_failed', 'unknown'].includes(state.state)) throw new Error(JSON.stringify({ taskId: state.taskId, state: state.state, startup: state.startup }));
    if (results.size < 2) await delay(250);
  }
  assert.equal(results.size, 2, 'Both real children must return durable results');
  for (const child of children) {
    const state = await call('task_status', { thread_id: room.id, task_id: child.taskId });
    const result = results.get(child.taskId);
    const finalMessage = result.data.output.filter((entry) => entry.type === 'message.committed').at(-1);
    const output = (finalMessage?.blocks || []).map((block) => block.text || '').join('');
    assert.equal(output.trim(), `DURABLE_${state.taskKey.toUpperCase()}_OK`);
    assert.ok(state.startup.evidence.roomRead.ok && state.startup.evidence.roomReply.messageId);
    receipt.children.push({ taskId: child.taskId, sessionId: child.sessionId, attemptId: child.attemptId,
      providerThreadId: state.providerThreadId, requestedModel: state.requestedModel, effectiveModel: state.effectiveModel,
      modelEvidence: state.modelEvidence, startup: state.startup, resultKey: result.data.resultKey, output });
  }
  if (delegation) {
    const nested = store.listThreads().filter((room) => room.metadata?.task?.parentTaskId === children[0].taskId);
    const consumed = store.getThread(children[0].taskId).thread.metadata.task.consumed;
    assert.equal(nested.length, 2, 'Managed parent must spawn exactly two children');
    for (const room of nested) {
      const task = room.metadata.task;
      assert.equal(task.startup.state, 'ready');
      assert.ok(task.results.some((result) => result.state === 'completed'));
      for (const result of task.results.filter((result) => result.state === 'completed')) {
        assert.ok(consumed[`${task.taskId}/${result.sessionId}/${result.attemptId}`] >= result.seq,
          'Managed parent must acknowledge each child result sequence');
      }
    }
    const parentCalls = calls.filter((call) => call.principal?.sessionId === children[0].sessionId);
    assert.ok(parentCalls.filter((call) => call.name === 'task_spawn' && call.ok).length >= 3);
    assert.ok(parentCalls.some((call) => call.name === 'task_spawn' && !call.ok), 'Third child must fail bounded scope');
    assert.ok(parentCalls.some((call) => call.name === 'task_wait' && call.ok));
    receipt.delegatedTaskIds = nested.map((room) => room.id);
    receipt.delegationCalls = parentCalls;
  }
  // Simulate a lost result-page response: close/reopen Fleet components, retaining
  // only the previously consumed cursor; results remain retrievable by stable IDs.
  await close(); await open();
  assert.equal((await spawn('one')).taskId, children[0].taskId);
  const recovered = await call('task_wait', { thread_id: room.id, task_ids: children.map((child) => child.taskId), timeout_ms: 0 });
  assert.ok(recovered.states.every((state) => state.results.some((result) => result.state === 'completed')));
  assert.ok(recovered.states.every((state) => state.attempts.length === 1), 'Retry after restart must not spawn again');
  receipt.restartVerified = true;
  receipt.completedAt = new Date().toISOString();
  await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ ok: true, receipt: join(root, 'receipt.json'), children: receipt.children.map(({ taskId, sessionId, output }) => ({ taskId, sessionId, output })), restartVerified: true }));
} finally { await close(); await credentials.close(); }
