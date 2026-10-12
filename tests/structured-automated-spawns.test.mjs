import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The real tmux plugin runs against a fake tmux binary in an isolated cwd and state dir.
const root = mkdtempSync(join(tmpdir(), 'cadre-hybrid-sessions-'));
const bin = join(root, 'bin');
const workDir = join(root, 'work');
mkdirSync(bin);
mkdirSync(workDir);
writeFileSync(join(bin, 'tmux'), [
  '#!/bin/sh',
  'case "$1" in',
  `  list-sessions) printf 'claude-tmux1\\t1700000000\\t0\\t\\t${workDir}\\n' ;;`,
  '  capture-pane) printf "> " ;;',
  'esac',
  'exit 0',
  '',
].join('\n'));
writeFileSync(join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n');
writeFileSync(join(root, '.claude_sessions.json'), JSON.stringify([{
  id: 'tmux1', tmuxSession: 'claude-tmux1', source: 'dashboard', workDir, created: Date.now(), provider: 'anthropic', runtime: 'claude',
}]));
chmodSync(join(bin, 'tmux'), 0o755);
chmodSync(join(bin, 'pgrep'), 0o755);
const originalCwd = process.cwd();
Object.assign(process.env, {
  HOME: root, PATH: `${bin}:${process.env.PATH}`, DM_STATE_DIR: join(root, 'state'), APP_STATE_STORAGE: 'file',
  CLAUDE_SESSIONS_STORAGE: 'file', DATABASE_URL: '', LOG_LEVEL: 'error',
  AGENT_BUS_STORAGE: 'file', AGENT_BUS_STATE_DIR: join(root, 'agent-bus'), AGENT_BUS_POLL_MS: '20',
});
for (const name of ['DUENO_DEFAULT_AGENT_WORKDIR', 'CADRE_DEFAULT_AGENT_WORKDIR']) delete process.env[name];
process.chdir(root);
after(() => { process.chdir(originalCwd); rmSync(root, { recursive: true, force: true }); });

const { default: Fastify } = await import('fastify');
const { AsyncEventQueue, createBaseCapabilities, createTransportEvent } = await import('../modules/agent/agent-transport.mjs');
const { AgentBusCredentialStore } = await import('../modules/agent-bus/mcp-auth.mjs');
const { claudeSessionsPlugin } = await import('../modules/sessions/claude-sessions.mjs');
const { isStructuredAutomatedSpawnsEnabled } = await import('../modules/sessions/claude-stream-json-sessions.mjs');
const { getProtocolSessionProvider } = await import('../modules/sessions/protocol-session-registry.mjs');
const { buildClaudeStreamJsonArgs } = await import('../modules/agent/claude-stream-json-transport.mjs');
const { agentInterfacePlugin } = await import('../modules/agent/interface.mjs');
const { buildAgentBusMcpServer } = await import('../modules/agent-bus/mcp.mjs');
const { buildMonitorMcpServer } = await import('../modules/platform/monitor-mcp.mjs');
const { buildInProcessFastifyRequest } = await import('../modules/agent-bus/in-process-mcp.mjs');
const { createAgentAdapters } = await import('../modules/agent-bus/adapters.mjs');
const { agentBusPlugin } = await import('../modules/agent-bus/index.mjs');
const { knownSessions, recordHookPayload } = await import('../modules/agent/hook-events.mjs');
const { pushPlugin } = await import('../modules/platform/push.mjs');
const { addHumanQueueItem, commandCenterAIPlugin, serializeWorkQueue } = await import('../modules/integrations/command-center-ai.mjs');

let failStart = () => false;
class FakeTransport {
  constructor() { this.queue = new AsyncEventQueue(); this.prompts = []; }
  emit(type, payload = {}) { this.queue.push(createTransportEvent(type, payload, { attemptId: this.attemptId, provider: 'claude', transport: 'structured' })); }
  async start(spec) {
    if (failStart()) throw new Error('fixture launch failed');
    this.spec = spec;
    this.attemptId = spec.attemptId;
    this.emit('attempt.started', { protocolSessionId: spec.sessionId });
    return { attemptId: spec.attemptId, protocolSessionId: spec.sessionId, negotiated: this.capabilities() };
  }
  async prompt({ turnId, blocks }) {
    this.prompts.push(blocks);
    this.turnId = turnId;
    this.emit('turn.started', { turnId, evidence: { accepted: true, settled: false, quiescent: false } });
    this.emit('usage', { turnId, inputTokens: 1 });
    // Like Claude, a tool call asks the permission prompt tool unless permissions are skipped.
    if (blocks[0]?.text === 'run tests' && !buildClaudeStreamJsonArgs(this.spec).includes('--dangerously-skip-permissions')) {
      this.emit('interaction.requested', {
        interactionId: 'i1', turnId, kind: 'permission',
        options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
        toolCall: { toolCallId: 't1', name: 'Bash', title: 'Bash requires permission', input: { command: 'npm test' } },
      });
      return new Promise(() => {});
    }
    if (blocks[0]?.text.startsWith('long task')) await new Promise((resolve) => { this.finishTurn = resolve; });
    this.emit('message.committed', { turnId, blocks: [{ type: 'text', text: 'Structured reply' }] });
    this.emit('turn.settled', { turnId, stopReason: 'end_turn', evidence: { accepted: true, settled: true, quiescent: true } });
    return { stopReason: 'end_turn' };
  }
  async attach(spec) { this.attached = spec.protocolSessionId; return this.start({ ...spec, sessionId: spec.protocolSessionId }); }
  async cancel() { return { mode: 'best_effort' }; }
  async answerInteraction({ interactionId, optionId }) {
    // Like Claude, an answered permission lets the blocked turn finish.
    const { turnId } = this;
    this.emit('interaction.answered', { interactionId, optionId });
    this.emit('message.committed', { turnId, blocks: [{ type: 'text', text: `Answered ${optionId}` }] });
    this.emit('turn.settled', { turnId, stopReason: 'end_turn', evidence: { accepted: true, settled: true, quiescent: true } });
    return { ok: true };
  }
  events() { return this.queue; }
  snapshot() { return { attemptId: this.attemptId, lifecycle: 'ready' }; }
  capabilities() { return createBaseCapabilities({ protocol: { name: 'claude-stream-json', version: '1' }, sessionOps: { resume: 'supported' } }); }
  async terminate() { this.emit('attempt.exited', { code: 0 }); this.queue.close(); return { ok: true, status: 'terminated', residual: [] }; }
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition timeout');
}

const PRINCIPALS = {
  agent: { authenticated: true, principal: { type: 'agent', kind: 'claude', sessionId: 'parent-1' } },
  ui: { authenticated: true, principal: { type: 'ui', kind: 'dashboard', sessionId: 'browser' } },
  coordinator: {
    authenticated: true, principal: { type: 'service', kind: 'scheduled-agent-pump', sessionId: 'sched-1' },
    coordinatorPolicy: { version: 'coordinator-v1', scheduleId: 'sched-1' },
  },
};

// Each app gets its own session root unless a test restarts onto the same one; earlier apps' sessions would resume.
let apps = 0;
async function buildApp({ agentBus = false, queue = false, sessionRoot = join(root, `structured-${apps += 1}`), mcpDiscovery = async () => ({ authenticated: true }) } = {}) {
  let credentialState = null;
  const credentialStore = new AgentBusCredentialStore({
    mode: 'issue_only',
    store: { mode: 'memory', async load() { return credentialState; }, async save(next) { credentialState = structuredClone(next); }, async close() {} },
  });
  const ws = {
    broadcasts: [], handlers: new Map(), channels: new Map(),
    broadcast(channel, type, data) { this.broadcasts.push({ channel, type, data }); },
    onChannel(prefix, handler) { this.handlers.set(prefix, handler); },
  };
  const transports = [];
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (req) => { req.duenoAuth = PRINCIPALS[req.headers['x-test-principal'] || (req.headers.cookie ? 'ui' : 'agent')]; });
  await app.register(claudeSessionsPlugin, {
    wsManager: ws, sessionRoot, credentialStore,
    sourceConfig: { agentBusMcpHttp: { host: '127.0.0.1', port: 9876, path: '/mcp' } },
    mcpDiscovery,
    e2eEvidence: { proven: true, expectedVersion: 'test' },
    transportFactory() { const transport = new FakeTransport(); transports.push(transport); return transport; },
  });
  await app.register(agentInterfacePlugin, {
    idempotencyStore: { async get() { return null; }, async set() {}, async close() {} },
    getPreferences: async () => ({ claudeEnabled: true, codexEnabled: true, piEnabled: true, preferredSingleProvider: 'claude' }),
  });
  if (agentBus) await app.register(agentBusPlugin, { wsManager: ws, credentialStore });
  if (queue) {
    await app.register(pushPlugin, { storeFile: join(root, 'push.json'), subject: 'mailto:test@example.com', send: async () => {} });
    await app.register(commandCenterAIPlugin, { wsManager: ws });
  }
  await app.ready();
  const request = (method, url, { principal, payload } = {}) => app.inject({
    method, url, payload, headers: principal ? { 'x-test-principal': principal } : {},
  });
  // The real MCP tools, calling routes in process as an agent principal.
  const mcp = buildMonitorMcpServer({ requestImpl: buildInProcessFastifyRequest({ app, buildHeaders: () => ({}) }) });
  return { app, ws, transports, request, mcp };
}

describe('structured automated spawns', () => {
  it('parses the flag as all kinds or a comma list and defaults off', () => {
    assert.equal(isStructuredAutomatedSpawnsEnabled('claude', ''), false);
    assert.equal(isStructuredAutomatedSpawnsEnabled('claude', '0'), false);
    assert.equal(isStructuredAutomatedSpawnsEnabled('codex', 'true'), true);
    assert.equal(isStructuredAutomatedSpawnsEnabled('codex', 'claude, codex'), true);
    assert.equal(isStructuredAutomatedSpawnsEnabled('codex', 'claude'), false);
  });

  it('keeps every create on tmux while the flag is off', async () => {
    delete process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS;
    const { app, request } = await buildApp();
    try {
      const res = await request('POST', '/api/claude/sessions', { payload: { structured: true } });
      assert.equal(res.statusCode, 400);
      assert.match(res.json().error, /^Session create requires/);
      assert.equal(getProtocolSessionProvider('claude'), null);
    } finally { await app.close(); }
  });

  it('serves automated creates on the structured runtime beside tmux sessions when the flag is on', async () => {
    process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS = 'claude';
    const { app, ws, transports, request, mcp } = await buildApp();
    try {
      // Human and coordinator-authority creates stay on tmux; only an automated create reaches structured.
      for (const [principal, error] of [['ui', /^Session create requires/], ['coordinator', /^Session create requires/], ['agent', /^workDir is required for Claude sessions/]]) {
        const res = await request('POST', '/api/claude/sessions', { principal, payload: { structured: true } });
        assert.equal(res.statusCode, 400, `${principal} ${res.body}`);
        assert.match(res.json().error, error, principal);
      }
      const unknownSkill = await request('POST', '/api/claude/sessions', { payload: { structured: true, workDir, skills: ['missing-skill'] } });
      assert.equal(unknownSkill.json().code, 'launch_skill_unknown');
      const sandboxed = await request('POST', '/api/claude/sessions', { payload: { structured: true, workDir, sandbox: 'nono' } });
      assert.deepEqual([sandboxed.statusCode, sandboxed.json().code], [400, 'sandbox_unsupported']);
      assert.equal(transports.length, 0);

      const created = await request('POST', '/api/claude/sessions', { payload: { structured: true, workDir, initialPrompt: 'hello' } });
      assert.equal(created.statusCode, 200, created.body);
      const session = created.json();
      assert.deepEqual([session.transport, session.initialPromptInjected, session.attachCommand], ['stream-json', true, '']);
      await waitFor(() => transports[0].prompts.length === 1);
      assert.equal(getProtocolSessionProvider('claude').service.get(session.id).id, session.id);

      const listed = (await request('GET', '/api/claude/sessions')).json().sessions;
      assert.deepEqual(listed.map((entry) => entry.id).sort(), [session.id, 'tmux1'].sort());
      const structuredDetail = (await request('GET', `/api/claude/sessions/${session.id}`)).json();
      const tmuxDetail = (await request('GET', '/api/claude/sessions/tmux1')).json();
      assert.deepEqual([structuredDetail.transport, tmuxDetail.transport], ['stream-json', undefined]);
      assert.equal(tmuxDetail.tmuxSession, 'claude-tmux1');
      const events = await request('GET', `/api/claude/sessions/${session.id}/events`);
      assert.equal(events.statusCode, 200);

      // A structured session is sendable through the shared input route used by rooms and loops.
      await waitFor(async () => (await request('GET', `/api/claude/sessions/${session.id}`)).json().state.capabilities.canSendNow === true);
      const sent = await request('POST', `/api/claude/sessions/${session.id}/input`, { payload: { text: 'next', source: 'agent_bus' } });
      assert.equal(sent.statusCode, 200, sent.body);
      await waitFor(() => transports[0].prompts.length === 2);

      // The tmux pane stream ignores structured ids; tmux list broadcasts keep structured sessions.
      const client = { readyState: 1, send() {} };
      for (const id of [session.id, 'tmux1']) {
        ws.channels.set(`claude:session:${id}`, new Set([client]));
        ws.handlers.get('claude')(client, `claude:session:${id}`, { action: 'subscribe' });
      }
      await waitFor(() => ws.broadcasts.some((entry) => entry.channel === 'claude:session:tmux1' && entry.type === 'content'));
      assert.equal(ws.broadcasts.some((entry) => entry.channel === `claude:session:${session.id}` && 'attention' in entry.data), false);
      const listIds = () => ws.broadcasts.filter((entry) => entry.channel === 'claude:sessions').at(-1)?.data.sessions.map((item) => item.id).sort();
      const renamed = await request('PUT', '/api/claude/sessions/tmux1', { payload: { displayName: 'Human pane' } });
      assert.equal(renamed.statusCode, 200, renamed.body);
      await waitFor(() => listIds()?.length === 2);
      assert.deepEqual(listIds(), [session.id, 'tmux1'].sort());

      // monitor_terminate_session and the agent-bus adapter accept only terminated/already_gone.
      const terminated = await mcp.handleToolCall('monitor_terminate_session', { session_id: session.id });
      assert.deepEqual(terminated, { session_id: session.id, status: 'terminated' });
      assert.equal(getProtocolSessionProvider('claude').service.get(session.id), null);
      await waitFor(() => listIds()?.length === 1);
      assert.deepEqual(listIds(), ['tmux1']);
      // A deleted structured id stays structured: 404 rather than a tmux fallthrough.
      const gone = await request('GET', `/api/claude/sessions/${session.id}`);
      assert.deepEqual([gone.statusCode, gone.json().code], [404, 'session_not_found']);

      const roomWorker = (await request('POST', '/api/claude/sessions', { payload: { structured: true, workDir } })).json();
      const adapterResult = await createAgentAdapters().claude.deleteSession(app, roomWorker.id);
      assert.deepEqual([adapterResult.ok, adapterResult.status], [true, 'terminated']);
      // No merged list ever dropped the tmux session, even before tmux first broadcast.
      assert.equal(ws.broadcasts.filter((entry) => entry.channel === 'claude:sessions')
        .every((entry) => entry.data.sessions.some((item) => item.id === 'tmux1')), true);
    } finally {
      await app.close();
      delete process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS;
    }
  });

  it('holds a room message to a busy structured participant and delivers it when the turn ends', async () => {
    process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS = 'claude';
    const { app, transports, request } = await buildApp({ agentBus: true });
    try {
      const { id } = (await request('POST', '/api/claude/sessions', { payload: { structured: true, workDir } })).json();
      await request('POST', `/api/claude/sessions/${id}/input`, { payload: { text: 'long task', source: 'agent_bus' } });
      await waitFor(() => transports[0].finishTurn);
      const created = await request('POST', '/api/agent-bus/threads', { principal: 'ui', payload: {
        title: 'busy', participants: [{ kind: 'claude', sessionId: 'tmux1' }, { kind: 'claude', sessionId: id }] } });
      assert.equal(created.statusCode, 200, created.body);
      const threadId = created.json().thread.id;
      const sent = await request('POST', '/api/agent-bus/messages', { principal: 'ui', payload: {
        threadId, from: { kind: 'claude', sessionId: 'tmux1' }, targets: [{ kind: 'claude', sessionId: id }], body: 'mid-turn note' } });
      assert.equal(sent.statusCode, 200, sent.body);
      const delivery = async () => (await request('GET', `/api/agent-bus/threads/${threadId}`, { principal: 'ui' })).json().deliveries[0];
      assert.deepEqual([(await delivery()).status, (await delivery()).holdReason], ['queued', 'target_busy']);

      transports[0].finishTurn();
      await waitFor(async () => (await delivery()).status === 'injected');
      assert.match(transports[0].prompts[1][0].text, /mid-turn note/);
    } finally {
      await app.close();
      delete process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS;
    }
  });

  it('ends the room and terminates the launched participant when a collab participant fails to launch', async () => {
    process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS = 'claude';
    const { app, transports, request, mcp } = await buildApp({ agentBus: true });
    failStart = () => transports.length === 2;
    const before = new Set(getProtocolSessionProvider('claude').service.list().map((session) => session.id));
    try {
      await assert.rejects(mcp.handleToolCall('spawn_collab_session', { title: 'doomed', workDir,
        participants: [{ provider: 'claude' }, { provider: 'claude' }] }), /fixture launch failed/);
      const rooms = (await request('GET', '/api/agent-bus/threads?status=all', { principal: 'ui' })).json().threads;
      assert.deepEqual(rooms.filter((room) => room.title === 'doomed').map((room) => room.status), ['closed']);
      // The first participant launched and was deleted; only the failed launch's ended record remains.
      assert.equal(transports.length, 2);
      assert.deepEqual(getProtocolSessionProvider('claude').service.list().filter((session) => !before.has(session.id))
        .map((session) => [session.lifecycle, session.detail]),
        [['ended', 'fixture launch failed']]);
    } finally {
      failStart = () => false;
      await app.close();
      delete process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS;
    }
  });

  it('resumes a structured returnResults worker after a Cadre restart and returns each turn once', async () => {
    process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS = 'claude';
    const sessionRoot = join(root, 'restart');
    const first = await buildApp({ agentBus: true, sessionRoot });
    let second = null;
    try {
      // The spawner is a structured session too, so it is live to receive results after the restart.
      const parent = (await first.request('POST', '/api/claude/sessions', { payload: { structured: true, workDir, initialPrompt: 'hi' } })).json();
      PRINCIPALS.parent = { authenticated: true, principal: { type: 'agent', kind: 'claude', sessionId: parent.id } };
      const worker = (await first.request('POST', '/api/claude/sessions', { principal: 'parent', payload: {
        structured: true, workDir, initialPrompt: 'long task', metadata: { returnToSpawner: true } } })).json();
      const ended = (await first.request('POST', '/api/claude/sessions', { payload: { structured: true, workDir, initialPrompt: 'hi' } })).json();
      await waitFor(() => first.transports[1].finishTurn && first.transports[2].prompts.length === 1);
      await getProtocolSessionProvider('claude').service.terminate(ended.id);
      const hook = (payload) => recordHookPayload({ session_id: worker.id, cwd: workDir, ...payload }, { provider: 'claude', duenoSessionId: worker.id, workDir });
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'long task' });
      // A room message sent while the worker is mid-turn is held through the restart.
      const room = await first.request('POST', '/api/agent-bus/threads', { principal: 'ui', payload: {
        title: 'restart', participants: [{ kind: 'claude', sessionId: 'tmux1' }, { kind: 'claude', sessionId: worker.id }] } });
      const threadId = room.json().thread.id;
      await first.request('POST', '/api/agent-bus/messages', { principal: 'ui', payload: {
        threadId, from: { kind: 'claude', sessionId: 'tmux1' }, targets: [{ kind: 'claude', sessionId: worker.id }], body: 'held note' } });
      await first.app.close();

      // The Cadre MCP listener comes up after the app; resumes wait for it, holding the worker's deliveries.
      let listening = false;
      second = await buildApp({ agentBus: true, sessionRoot, mcpDiscovery: async () => {
        if (!listening) throw new Error('connect ECONNREFUSED');
        return { authenticated: true };
      } });
      // Longer than the observer's 2 s recovery grace, so it retries the held delivery while the bus is down.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      assert.deepEqual([second.transports.length, (await second.request('GET', `/api/agent-bus/threads/${threadId}`, { principal: 'ui' })).json().deliveries[0].status],
        [0, 'queued']);
      listening = true;
      const { service } = getProtocolSessionProvider('claude');
      // The cut-off turn is reported to the resumed conversation, then the held message follows.
      const resumedWorker = () => second.transports.find((transport) => transport.attached === worker.id);
      await waitFor(() => resumedWorker()?.prompts.length === 2, 10000);
      // The idle parent resumes without a note; the ended session stays down.
      assert.deepEqual(second.transports.map((transport) => [transport.attached, transport.prompts.length]).sort(),
        [[parent.id, 0], [worker.id, 2]].sort());
      assert.match(resumedWorker().prompts[0][0].text, /^Cadre restarted during your last turn/);
      assert.match(resumedWorker().prompts[1][0].text, /held note/);
      const resumed = service.get(worker.id);
      const before = (await second.request('GET', `/api/claude/sessions/${worker.id}`)).json();
      assert.deepEqual([resumed.workDir, resumed.permissionMode, resumed.metadata.spawnedBy, before.model, resumedWorker().spec.permissionMode],
        [worker.workDir, 'danger-full-access', { kind: 'claude', sessionId: parent.id }, worker.model, 'danger-full-access']);
      assert.deepEqual(resumed.turns.slice(0, 1).map((turn) => turn.status), ['unknown']);
      const endedDetail = (await second.request('GET', `/api/claude/sessions/${ended.id}`)).json();
      assert.deepEqual([endedDetail.sessionEnded, endedDetail.canResume, service.get(ended.id).lifecycle], [true, false, 'ended']);

      // Each resumed turn's Stop returns to the spawner exactly once.
      const results = async () => {
        const threads = (await second.request('GET', '/api/agent-bus/threads', { principal: 'ui' })).json().threads;
        const messages = await Promise.all(threads.map(async (thread) => (await second.request('GET', `/api/agent-bus/threads/${thread.id}`, { principal: 'ui' })).json().messages));
        return messages.flat().filter((message) => message.type === 'result' && message.from.sessionId === worker.id).map((message) => message.body);
      };
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'restart note' });
      await hook({ hook_event_name: 'Stop', last_assistant_message: 'Continued answer' });
      await waitFor(async () => (await results()).length === 1);
      await waitFor(async () => (await second.request('GET', `/api/claude/sessions/${worker.id}`)).json().state.capabilities.canSendNow === true);
      const sent = await second.request('POST', `/api/claude/sessions/${worker.id}/input`, { payload: { text: 'follow-up', source: 'agent_bus' } });
      assert.equal(sent.statusCode, 200, sent.body);
      await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'follow-up' });
      await hook({ hook_event_name: 'Stop', last_assistant_message: 'Follow-up answer' });
      await waitFor(async () => (await results()).length === 2);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(await results(), ['Continued answer', 'Follow-up answer']);
    } finally {
      await (second || first).app.close();
      delete process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS;
    }
  });

  it('sends no restart note when the cut-off turn already wrote its Stop, so its result returns once', async () => {
    process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS = 'claude';
    const sessionRoot = join(root, 'restart-stopped');
    const first = await buildApp({ agentBus: true, sessionRoot });
    let second = null;
    try {
      const parent = (await first.request('POST', '/api/claude/sessions', { payload: { structured: true, workDir, initialPrompt: 'hi' } })).json();
      PRINCIPALS.parent = { authenticated: true, principal: { type: 'agent', kind: 'claude', sessionId: parent.id } };
      const worker = (await first.request('POST', '/api/claude/sessions', { principal: 'parent', payload: {
        structured: true, workDir, initialPrompt: 'long task', metadata: { returnToSpawner: true } } })).json();
      await waitFor(() => first.transports[1].finishTurn);
      // Claude ran its Stop hook, but Cadre stopped before the turn's result frame arrived.
      for (const payload of [{ hook_event_name: 'UserPromptSubmit', prompt: 'long task' }, { hook_event_name: 'Stop', last_assistant_message: 'Finished before restart' }]) {
        await recordHookPayload({ session_id: worker.id, cwd: workDir, ...payload }, { provider: 'claude', duenoSessionId: worker.id, workDir });
      }
      await first.app.close();

      second = await buildApp({ agentBus: true, sessionRoot });
      const results = async () => {
        const threads = (await second.request('GET', '/api/agent-bus/threads', { principal: 'ui' })).json().threads;
        const messages = await Promise.all(threads.map(async (thread) => (await second.request('GET', `/api/agent-bus/threads/${thread.id}`, { principal: 'ui' })).json().messages));
        return messages.flat().filter((message) => message.type === 'result' && message.from.sessionId === worker.id).map((message) => message.body);
      };
      await waitFor(async () => (await results()).length === 1);
      await waitFor(async () => (await second.request('GET', `/api/claude/sessions/${worker.id}`)).json().state.capabilities.canSendNow === true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(await results(), ['Finished before restart']);
      assert.deepEqual(second.transports.find((transport) => transport.attached === worker.id).prompts, []);
    } finally {
      await (second || first).app.close();
      delete process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS;
    }
  });

  it('lets a spawn_session worker run tools unattended, as tmux does, unless a mode is given', async () => {
    process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS = 'claude';
    const { app, transports, request, mcp } = await buildApp();
    try {
      const spawned = await mcp.handleToolCall('spawn_session', { provider: 'claude', workDir, displayName: 'worker' });
      const id = spawned.participants[0].session_id;
      assert.equal(transports[0].spec.permissionMode, 'danger-full-access');
      const sent = await request('POST', `/api/claude/sessions/${id}/input`, { payload: { text: 'run tests', source: 'agent_bus' } });
      assert.equal(sent.statusCode, 200, sent.body);
      await waitFor(async () => (await request('GET', `/api/claude/sessions/${id}`)).json().state.capabilities.canSendNow === true);
      assert.deepEqual(getProtocolSessionProvider('claude').service.get(id).interactions, []);

      // An explicit mode wins, so that session asks for tool permission.
      const explicit = await request('POST', '/api/claude/sessions', { payload: { structured: true, workDir, permissionMode: 'workspace-write' } });
      assert.equal(transports[1].spec.permissionMode, 'workspace-write');
      await request('POST', `/api/claude/sessions/${explicit.json().id}/input`, { payload: { text: 'run tests', source: 'agent_bus' } });
      await waitFor(() => getProtocolSessionProvider('claude').service.get(explicit.json().id).interactions.length === 1);
      assert.equal(getProtocolSessionProvider('claude').service.get(explicit.json().id).interactions[0].status, 'open');
    } finally {
      await app.close();
      delete process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS;
    }
  });

  it('records spawnedBy and the result note on a tmux spawn_session worker only when returnResults is true', async () => {
    delete process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS;
    const { app, mcp } = await buildApp();
    try {
      const outcomes = [];
      for (const args of [{}, { returnResults: false }, { returnResults: true }]) {
        const { session_id: id } = (await mcp.handleToolCall('spawn_session', { provider: 'claude', workDir, initialPrompt: 'go', mcpProfile: 'default', ...args })).participants[0];
        const stored = JSON.parse(readFileSync(join(root, 'state', 'claude_sessions.json'), 'utf8')).find((entry) => entry.id === id);
        const prompt = readFileSync(join(root, 'state', 'initial_prompts', `claude-${id}.txt`), 'utf8');
        if (args.returnResults) {
          assert.match(prompt, /For your own bounded reading, searching, and checks, use built-in subagents when available: Haiku 5\.5 \(claude-haiku-5-5\) on Claude, GPT-6 Luna \(gpt-6-luna\) on Codex/);
          assert.match(prompt, /Reply only if this is new work\. Do not reply to delayed copies or courtesy acks\./);
        }
        outcomes.push([stored.metadata.spawnedBy, prompt.includes('final message of each turn')]);
      }
      assert.deepEqual(outcomes, [[undefined, false], [undefined, false], [{ kind: 'claude', sessionId: 'parent-1' }, true]]);
    } finally { await app.close(); }
  });

  it('records the credential spawner and result note on a structured returnResults worker', async () => {
    process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS = 'claude';
    const { app, transports, request, mcp } = await buildApp();
    try {
      const { session_id: id } = (await mcp.handleToolCall('spawn_session', { provider: 'claude', workDir, initialPrompt: 'go', returnResults: true })).participants[0];
      await waitFor(() => transports[0].prompts.length === 1);
      assert.match(transports[0].prompts[0][0].text, /^go\n\nCadre returns your final message of each turn/);
      // The observer finds spawned children, and their hook logs, through the hook session registry; structured
      // Claude writes those logs with the same fleet hook plugin as tmux.
      const spawned = [...knownSessions()].filter((session) => session.id === id);
      assert.deepEqual(spawned.map((session) => [session.provider, session.metadata.spawnedBy]),
        [['claude', { kind: 'claude', sessionId: 'parent-1' }]]);
      assert.equal(spawned[0].workDir, (await request('GET', `/api/claude/sessions/${id}`)).json().workDir);

      // A caller cannot name its own spawner, and an unopted spawn gets no note.
      const forged = await request('POST', '/api/claude/sessions', { payload: { structured: true, workDir, initialPrompt: 'go',
        metadata: { spawnedBy: { kind: 'claude', sessionId: 'victim' } } } });
      await waitFor(() => transports[1]?.prompts.length === 1);
      assert.equal(getProtocolSessionProvider('claude').service.get(forged.json().id).metadata.spawnedBy, undefined);
      assert.equal(transports[1].prompts[0][0].text, 'go');
    } finally {
      await app.close();
      delete process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS;
    }
  });

  it('puts a structured permission on the Command Queue once, and answering it resumes the session', async () => {
    process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS = 'claude';
    const { app, request } = await buildApp({ queue: true });
    try {
      const block = async () => {
        const { id } = (await request('POST', '/api/claude/sessions', { payload: { structured: true, workDir, permissionMode: 'workspace-write' } })).json();
        await request('POST', `/api/claude/sessions/${id}/input`, { payload: { text: 'run tests', source: 'agent_bus' } });
        return id;
      };
      const items = async (id) => (await request('GET', '/api/command-center/work-queue?status=all', { principal: 'ui' })).json()
        .items.filter((item) => item.sessionId === id);
      const id = await block();
      await waitFor(async () => (await items(id)).length === 1);
      const [item] = await items(id);
      assert.deepEqual([item.status, item.sessionKind, item.sessionInteraction, item.options.map((option) => option.id)],
        ['open', 'claude', { kind: 'permission', fingerprint: 'i1', structured: true }, ['allow_once', 'deny']]);

      const answered = await request('POST', `/api/command-center/work-queue/${item.id}/answer`, { principal: 'ui', payload: { optionId: 'allow_once' } });
      assert.equal(answered.statusCode, 200, answered.body);
      assert.equal(answered.json().status, 'routed');
      await waitFor(async () => (await request('GET', `/api/claude/sessions/${id}`)).json().state.capabilities.canSendNow === true);
      assert.match((await request('GET', `/api/claude/sessions/${id}`)).json().content, /Answered allow_once/);
      assert.deepEqual((await items(id)).map((entry) => entry.status), ['routed']);

      // An interaction answered elsewhere closes its queue item.
      const other = await block();
      await waitFor(async () => (await items(other)).length === 1);
      const direct = await request('POST', `/api/claude/sessions/${other}/interaction`, { principal: 'ui', payload: { optionId: 'deny' } });
      assert.equal(direct.statusCode, 200, direct.body);
      await waitFor(async () => (await items(other))[0].status === 'dismissed');
    } finally {
      await app.close();
      delete process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS;
    }
  });

  it('dismisses session-interaction queue items when the session ends, and at startup when it ended while down', async () => {
    process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS = 'claude';
    let { app, request } = await buildApp({ queue: true });
    const items = async (id) => (await request('GET', '/api/command-center/work-queue?status=all', { principal: 'ui' })).json()
      .items.filter((item) => item.sessionId === id);
    const block = async () => {
      const { id } = (await request('POST', '/api/claude/sessions', { payload: { structured: true, workDir, permissionMode: 'workspace-write' } })).json();
      await request('POST', `/api/claude/sessions/${id}/input`, { payload: { text: 'run tests', source: 'agent_bus' } });
      await waitFor(async () => (await items(id)).length === 1);
      return id;
    };
    try {
      const deleted = await block();
      assert.equal((await request('DELETE', `/api/claude/sessions/${deleted}`, { principal: 'ui' })).statusCode, 200);
      await waitFor(async () => (await items(deleted))[0].status === 'dismissed');

      // A shutdown interrupts a blocked session without closing its item; the next start does, and keeps a live session's.
      const interrupted = await block();
      await addHumanQueueItem({ sessionKind: 'claude', sessionId: 'tmux1', question: 'Allow?' }, { sessionInteraction: { kind: 'permission', fingerprint: 'f1' } });
      await app.close();
      assert.equal((await serializeWorkQueue()).items.find((item) => item.sessionId === interrupted).status, 'open');
      ({ app, request } = await buildApp({ queue: true }));
      await waitFor(async () => (await items(interrupted))[0].status === 'dismissed');
      assert.equal((await items('tmux1'))[0].status, 'open');
    } finally {
      await app.close();
      delete process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS;
    }
  });

  it('refuses tmux-only routes for structured ids instead of falling through to tmux', async () => {
    process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS = 'claude';
    const { app, transports, request } = await buildApp();
    try {
      const { id } = (await request('POST', '/api/claude/sessions', { payload: { structured: true, workDir } })).json();
      for (const [method, suffix, payload] of [
        ['PUT', '', { displayName: 'x' }], ['POST', '/scheduled-send', { text: 'later', delayMs: 50 }], ['GET', '/scheduled-sends'],
        ['POST', '/clear', {}], ['POST', '/shift-tab', {}], ['POST', '/image', {}],
      ]) {
        const res = await request(method, `/api/claude/sessions/${id}${suffix}`, { payload });
        assert.deepEqual([res.statusCode, res.json().code], [409, 'unsupported_for_structured_session'], `${method} ${suffix}`);
      }
      assert.equal(transports[0].prompts.length, 0);
      // The same routes still serve tmux sessions.
      const renamed = await request('PUT', '/api/claude/sessions/tmux1', { payload: { displayName: 'Human pane' } });
      assert.equal(renamed.statusCode, 200, renamed.body);
      const requestImpl = buildInProcessFastifyRequest({ app, buildHeaders: () => ({}) });
      const monitor = buildMonitorMcpServer({ requestImpl });
      const bus = buildAgentBusMcpServer({ requestImpl, extraTools: monitor.tools.map((tool) => ({ ...tool, handler: (args, context) => monitor.handleToolCall(tool.name, args, context) })) });
      const scheduled = await bus.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'monitor_scheduled_send', arguments: { type: 'claude', sessionId: 'tmux1', text: 'PRIVATE_SCHEDULE_TEXT', delayMs: 600000 } } });
      assert.equal(scheduled.error, undefined, JSON.stringify(scheduled.error));
      assert.deepEqual(Object.keys(scheduled.result.structuredContent).sort(), ['id', 'status']);
      assert.ok(scheduled.result.structuredContent.id.startsWith('ss_'));
      assert.deepEqual(JSON.parse(scheduled.result.content[0].text), scheduled.result.structuredContent);
      assert.doesNotMatch(JSON.stringify(scheduled.result), /PRIVATE_SCHEDULE_TEXT/);
      await request('DELETE', `/api/claude/sessions/tmux1/scheduled-send/${scheduled.result.structuredContent.id}`);
    } finally {
      await app.close();
      delete process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS;
    }
  });
});
