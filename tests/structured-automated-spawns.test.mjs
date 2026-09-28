import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const { buildMonitorMcpServer } = await import('../modules/platform/monitor-mcp.mjs');
const { buildInProcessFastifyRequest } = await import('../modules/agent-bus/in-process-mcp.mjs');
const { createAgentAdapters } = await import('../modules/agent-bus/adapters.mjs');

class FakeTransport {
  constructor() { this.queue = new AsyncEventQueue(); this.prompts = []; }
  emit(type, payload = {}) { this.queue.push(createTransportEvent(type, payload, { attemptId: this.attemptId, provider: 'claude', transport: 'structured' })); }
  async start(spec) {
    this.spec = spec;
    this.attemptId = spec.attemptId;
    this.emit('attempt.started', { protocolSessionId: spec.sessionId });
    return { attemptId: spec.attemptId, protocolSessionId: spec.sessionId, negotiated: this.capabilities() };
  }
  async prompt({ turnId, blocks }) {
    this.prompts.push(blocks);
    this.emit('turn.started', { turnId, evidence: { accepted: true, settled: false, quiescent: false } });
    // Like Claude, a tool call asks the permission prompt tool unless permissions are skipped.
    if (blocks[0]?.text === 'run tests' && !buildClaudeStreamJsonArgs(this.spec).includes('--dangerously-skip-permissions')) {
      this.emit('interaction.requested', {
        interactionId: 'i1', turnId, kind: 'permission',
        options: [{ optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
        toolCall: { toolCallId: 't1', name: 'Bash', title: 'Bash requires permission', input: { command: 'npm test' } },
      });
      return new Promise(() => {});
    }
    this.emit('message.committed', { turnId, blocks: [{ type: 'text', text: 'Structured reply' }] });
    this.emit('turn.settled', { turnId, stopReason: 'end_turn', evidence: { accepted: true, settled: true, quiescent: true } });
    return { stopReason: 'end_turn' };
  }
  async attach(spec) { return this.start({ ...spec, sessionId: spec.protocolSessionId }); }
  async cancel() { return { mode: 'best_effort' }; }
  async answerInteraction() { return { ok: true }; }
  events() { return this.queue; }
  snapshot() { return { attemptId: this.attemptId, lifecycle: 'ready' }; }
  capabilities() { return createBaseCapabilities({ protocol: { name: 'claude-stream-json', version: '1' } }); }
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

async function buildApp() {
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
  app.addHook('onRequest', async (req) => { req.duenoAuth = PRINCIPALS[req.headers['x-test-principal'] || 'agent']; });
  await app.register(claudeSessionsPlugin, {
    wsManager: ws, sessionRoot: join(root, 'structured'), credentialStore,
    sourceConfig: { agentBusMcpHttp: { host: '127.0.0.1', port: 9876, path: '/mcp' } },
    mcpDiscovery: async () => ({ authenticated: true }),
    e2eEvidence: { proven: true, expectedVersion: 'test' },
    transportFactory() { const transport = new FakeTransport(); transports.push(transport); return transport; },
  });
  await app.register(agentInterfacePlugin, {
    idempotencyStore: { async get() { return null; }, async set() {}, async close() {} },
    getPreferences: async () => ({ claudeEnabled: true, codexEnabled: true, piEnabled: true, preferredSingleProvider: 'claude' }),
  });
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
      assert.deepEqual([terminated.ok, terminated.status, terminated.kind], [true, 'terminated', 'claude']);
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

  it('lets a spawn_session worker run tools unattended, as tmux does, unless a mode is given', async () => {
    process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS = 'claude';
    const { app, transports, request, mcp } = await buildApp();
    try {
      const spawned = await mcp.handleToolCall('spawn_session', { provider: 'claude', workDir, displayName: 'worker' });
      const id = spawned.session?.id || spawned.id;
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
    } finally {
      await app.close();
      delete process.env.CADRE_STRUCTURED_AUTOMATED_SPAWNS;
    }
  });
});
