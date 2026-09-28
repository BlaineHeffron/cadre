import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { AsyncEventQueue, createBaseCapabilities, createTransportEvent } from '../modules/agent/agent-transport.mjs';
import { AgentBusCredentialStore } from '../modules/agent-bus/mcp-auth.mjs';
import { buildMcpCapabilityCatalog } from '../modules/integrations/mcp-server-catalog.mjs';
import { claudeSessionsPlugin, isClaudeStreamJsonEnabled } from '../modules/sessions/claude-sessions.mjs';
import { codexSessionsPlugin, isCodexAppServerEnabled } from '../modules/sessions/codex-sessions.mjs';
import { getProtocolSessionProvider } from '../modules/sessions/protocol-session-registry.mjs';
import { TASK_ADMISSION } from '../modules/sessions/session-service.mjs';
import { defaultSendSessionInput } from '../modules/telegram/bridge-loop.mjs';
import { RESEARCH_PROFILE_ID } from '../modules/integrations/research-profile.mjs';
import { CLAUDE_STREAM_JSON_E2E_VERSION, claudeStreamJsonBusE2eEvidence } from '../modules/sessions/claude-stream-json-mcp.mjs';

const roots = [];
const apps = [];
afterEach(async () => {
  await Promise.allSettled(apps.splice(0).map((app) => app.close()));
  while (roots.length) await rm(roots.pop(), { recursive: true, force: true });
});

class FakeTransport {
  constructor(provider = 'claude') { this.provider = provider; this.queue = new AsyncEventQueue(); this.prompts = []; this.cancelCalls = 0; this.answers = []; }
  emit(type, payload = {}) {
    this.queue.push(createTransportEvent(type, payload, { attemptId: this.attemptId, provider: this.provider, transport: 'structured' }));
  }
  async start(spec) {
    this.startSpec = structuredClone(spec);
    this.attemptId = spec.attemptId;
    this.emit('attempt.started', { protocolSessionId: spec.sessionId });
    return { attemptId: spec.attemptId, protocolSessionId: spec.sessionId, negotiated: this.capabilities() };
  }
  async prompt({ turnId, blocks }) {
    this.prompts.push(blocks);
    this.activeTurnId = turnId;
    this.emit('turn.started', { turnId, evidence: { accepted: true, settled: false, quiescent: false } });
    if (blocks.some((block) => block.type === 'text' && block.text === 'wait')) return new Promise(() => {});
    this.emit('message.committed', { turnId, blocks: [{ type: 'text', text: 'Structured reply' }] });
    this.emit('turn.settled', { turnId, stopReason: 'end_turn', evidence: { accepted: true, settled: true, quiescent: true } });
    this.activeTurnId = null;
    return { stopReason: 'end_turn' };
  }
  async attach(spec) {
    this.attachSpec = structuredClone(spec);
    if (FakeTransport.failNextAttach) { FakeTransport.failNextAttach = false; throw new Error('provider unavailable'); }
    return this.start({ ...spec, sessionId: spec.protocolSessionId });
  }
  async cancel() {
    this.cancelCalls += 1;
    this.emit('turn.settled', {
      turnId: this.activeTurnId, stopReason: 'interrupted',
      evidence: { accepted: true, settled: true, quiescent: true },
    });
    this.activeTurnId = null;
    return { mode: 'best_effort' };
  }
  emitPermission() {
    this.emit('interaction.requested', {
      interactionId: `${this.attemptId}:permission-1`, turnId: this.activeTurnId, kind: 'permission',
      toolCall: { name: 'Bash', title: 'Run command' },
      options: [{ optionId: 'allow_once', name: 'Allow once' }, { optionId: 'deny', name: 'Deny' }],
    });
  }
  async answerInteraction({ interactionId, optionId }) {
    this.answers.push({ interactionId, optionId });
    this.emit('interaction.answered', { interactionId, optionId });
    return { ok: true };
  }
  events() { return this.queue; }
  snapshot() { return { attemptId: this.attemptId, lifecycle: 'ready' }; }
  capabilities() {
    return createBaseCapabilities({
      protocol: { name: 'claude-stream-json', version: '1' },
      interaction: { permissions: 'structured_options', elicitation: false, answerOnce: true },
      sessionOps: { list: 'unsupported', load: 'unsupported', resume: 'supported', fork: 'unsupported', close: 'unsupported', delete: 'supported' },
      ...(this.startSpec?.capabilityEvidence || {}),
    });
  }
  async terminate() { this.emit('attempt.exited', { code: 0 }); this.queue.close(); return { ok: true, status: 'terminated', residual: [] }; }
}

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition timeout');
}

describe('Claude stream-json E2E version gate', () => {
  it('documents the tested reference version', () => {
    assert.equal(CLAUDE_STREAM_JSON_E2E_VERSION, '2.1.251');
  });

  it('accepts the tested version and every newer version', () => {
    for (const cliVersion of [
      '2.1.251 (Claude Code)', '2.1.252 (Claude Code)', '2.2.0 (Claude Code)',
      '2.10.0 (Claude Code)', '3.0.0 (Claude Code)',
    ]) {
      const evidence = claudeStreamJsonBusE2eEvidence({ cliVersion });
      assert.equal(evidence.proven, true, cliVersion);
      assert.equal(evidence.expectedVersion, CLAUDE_STREAM_JSON_E2E_VERSION);
    }
  });

  it('rejects older, missing, and unparseable versions', () => {
    for (const cliVersion of [
      '2.1.250 (Claude Code)', '2.0.999 (Claude Code)', '1.9.9 (Claude Code)', '', 'not a version',
    ]) {
      assert.equal(claudeStreamJsonBusE2eEvidence({ cliVersion }).proven, false, cliVersion || '(empty)');
    }
  });

  it('compares version segments numerically, not lexically', () => {
    assert.equal(claudeStreamJsonBusE2eEvidence({ cliVersion: '2.1.1000' }).proven, true);
    assert.equal(claudeStreamJsonBusE2eEvidence({ cliVersion: '2.1.99' }).proven, false);
  });
});

describe('Claude stream-json sessions', () => {
  it('keeps the provider opt-in disabled by default', () => {
    assert.equal(isClaudeStreamJsonEnabled(''), false);
    assert.equal(isClaudeStreamJsonEnabled('0'), false);
    assert.equal(isClaudeStreamJsonEnabled('true'), true);
  });

  it('serves Claude sessions through SessionService when opted in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-claude-stream-route-'));
    roots.push(root);
    const workDir = join(root, 'work');
    await mkdir(workDir);
    const clients = [];
    const issuedTokens = [];
    let credentialState = null;
    const credentialStore = new AgentBusCredentialStore({
      mode: 'issue_only',
      store: {
        mode: 'memory', async load() { return credentialState; },
        async save(next) { credentialState = structuredClone(next); }, async close() {},
      },
    });
    let issueCalls = 0;
    const issueCredential = credentialStore.issue.bind(credentialStore);
    credentialStore.issue = (options) => { issueCalls += 1; return issueCredential(options); };
    const app = Fastify({ logger: false });
    apps.push(app);
    app.addHook('onRequest', async (request) => {
      request.duenoAuth = {
        authenticated: true,
        principal: { type: 'ui', kind: 'dashboard', sessionId: 'test-operator' },
        automationPolicy: '',
      };
    });
    await app.register(claudeSessionsPlugin, {
      streamJsonEnabled: true,
      sessionRoot: join(root, 'sessions'),
      credentialStore,
      sourceConfig: { agentBusMcpHttp: { host: '127.0.0.1', port: 9876, path: '/mcp' } },
      mcpDiscovery: async ({ token }) => {
        issuedTokens.push(token);
        return { authenticated: true, discoveredToolCount: 8 };
      },
      e2eEvidence: { proven: true, expectedVersion: 'test' },
      transportFactory() { const client = new FakeTransport(); clients.push(client); return client; },
    });
    const created = await app.inject({
      method: 'POST', url: '/api/claude/sessions',
      payload: { workDir, initialPrompt: 'hello' },
    });
    assert.equal(created.statusCode, 200);
    const session = created.json();
    assert.equal(session.transport, 'stream-json');
    assert.equal(session.negotiated.mcpAttachment, 'launch_time_mcp_client');
    assert.equal(session.negotiated.busParticipation, 'authenticated_scoped');
    assert.equal(session.negotiated.interaction.permissions, 'structured_options');
    assert.match(clients[0].startSpec.mcpConfigPath, /attempt-1\/dueno-mcp\.json$/);
    assert.ok(clients[0].startSpec.settingsPath);
    assert.equal((await stat(clients[0].startSpec.mcpConfigPath)).mode & 0o777, 0o600);
    const mcpConfig = await readFile(clients[0].startSpec.mcpConfigPath, 'utf8');
    assert.match(mcpConfig, /Bearer \$\{DUENO_AGENT_BUS_TOKEN\}/);
    assert.equal(mcpConfig.includes(issuedTokens[0]), false);
    assert.equal(clients[0].startSpec.env.DUENO_SESSION_ID, session.id);
    assert.equal(clients[0].startSpec.env.DUENO_PROVIDER, 'claude');
    assert.equal(clients[0].startSpec.env.DUENO_AGENT_BUS_TOKEN, issuedTokens[0]);
    assert.equal(issueCalls, 1);
    assert.deepEqual(session.mcpCapabilities.serverIds, ['dueno']);
    assert.equal(JSON.stringify(session).includes(issuedTokens[0]), false);
    assert.equal(session.initialPromptInjected, true);
    await waitFor(() => clients[0].prompts.length === 1);
    await waitFor(async () => (await app.inject({
      method: 'GET', url: `/api/claude/sessions/${session.id}`,
    })).json().state.status === 'ready');
    const listed = await app.inject({ method: 'GET', url: '/api/claude/sessions' });
    assert.equal(listed.json().sessions[0].id, session.id);
    const waiting = await app.inject({ method: 'POST', url: `/api/claude/sessions/${session.id}/input`, payload: { text: 'wait' } });
    assert.equal(waiting.statusCode, 200);
    await waitFor(() => clients[0].activeTurnId);
    clients[0].emitPermission();
    await waitFor(async () => (await app.inject({
      method: 'GET', url: `/api/claude/sessions/${session.id}`,
    })).json().state.status === 'blocked');
    const { state: blocked } = (await app.inject({ method: 'GET', url: `/api/claude/sessions/${session.id}` })).json();
    const guards = { expectedRevision: blocked.revision, expectedFingerprint: blocked.interaction.fingerprint, expectedInteractionKind: 'permission' };
    const answer = (payload) => app.inject({ method: 'POST', url: `/api/claude/sessions/${session.id}/input`, payload: { text: 'allow_once', source: 'ui_dialog_answer', ...payload } });
    for (const stale of [{ expectedRevision: blocked.revision - 1 }, { expectedFingerprint: 'other-interaction' }, { expectedInteractionKind: 'selection' }]) {
      const rejected = await answer({ ...guards, ...stale });
      assert.deepEqual([rejected.statusCode, rejected.json().code], [409, 'interaction_changed'], JSON.stringify(stale));
    }
    assert.deepEqual(clients[0].answers, []);
    const allowed = await answer(guards);
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(clients[0].answers[0].optionId, 'allow_once');
    // A delayed duplicate click finds no open interaction; it must not become a prompt.
    const replay = await answer(guards);
    assert.deepEqual([replay.statusCode, replay.json().code, clients[0].prompts.length, clients[0].answers.length], [409, 'interaction_changed', 2, 1]);
    clients[0].emit('interaction.requested', { interactionId: `${clients[0].attemptId}:ask-1`, turnId: clients[0].activeTurnId, kind: 'selection',
      toolCall: { title: 'Retries?' }, options: ['1', '3', '5'].map((label) => ({ optionId: label, name: label })) });
    await waitFor(async () => (await app.inject({ method: 'GET', url: `/api/claude/sessions/${session.id}` })).json().state.interaction.kind === 'selection');
    // Toolbar keys, captured keystrokes and non-key digits must not become answers.
    const strayKey = await app.inject({ method: 'POST', url: `/api/claude/sessions/${session.id}/keys`, payload: { keys: 'Up' } });
    const digit = await app.inject({ method: 'POST', url: `/api/claude/sessions/${session.id}/keys`, payload: { keys: '2' } });
    const keystroke = await app.inject({ method: 'POST', url: `/api/claude/sessions/${session.id}/input`, payload: { text: 'j', enter: false } });
    assert.deepEqual([strayKey.statusCode, strayKey.json().code, digit.statusCode, keystroke.statusCode, clients[0].answers.length], [400, 'unsupported_capability', 400, 400, 1]);
    // Telegram's hook buttons send answer:N; the bridge resolves N to the Nth option's key, so button 3 is "5", not the label "3".
    const { state: selection } = (await app.inject({ method: 'GET', url: `/api/claude/sessions/${session.id}` })).json();
    await defaultSendSessionInput({ session: { id: session.id, runtime: 'claude', state: selection }, text: '3', interactionAnswer: true,
      requestImpl: async (url, { method, body }) => { const res = await app.inject({ method, url, payload: body }); return { statusCode: res.statusCode, payload: res.json() }; } });
    assert.equal(clients[0].answers[1]?.optionId, '5');
    const unsupported = await app.inject({
      method: 'POST', url: `/api/claude/sessions/${session.id}/keys`, payload: { keys: 'Up Enter' },
    });
    assert.equal(unsupported.statusCode, 400);
    assert.equal(unsupported.json().code, 'unsupported_capability');
    const interrupted = await app.inject({
      method: 'POST', url: `/api/claude/sessions/${session.id}/keys`, payload: { keys: 'Escape' },
    });
    assert.equal(interrupted.json().mode, 'best_effort');
    assert.equal(clients[0].cancelCalls, 1);
    const removed = await app.inject({ method: 'DELETE', url: `/api/claude/sessions/${session.id}` });
    assert.equal(removed.json().ok, true);
    assert.equal((await credentialStore.authenticate(issuedTokens[0])).reason, 'revoked');
    await assert.rejects(stat(clients[0].startSpec.mcpConfigPath), /ENOENT/);
    const selected = await app.inject({
      method: 'POST', url: '/api/claude/sessions', payload: { workDir, mcpServers: { add: ['fetch'] } },
    });
    assert.equal(selected.statusCode, 200, selected.body);
    assert.deepEqual(selected.json().mcpCapabilities.serverIds, ['dueno', 'fetch']);
    const selectedConfigPath = clients[1].startSpec.mcpConfigPath;
    const selectedConfig = JSON.parse(await readFile(selectedConfigPath, 'utf8'));
    assert.deepEqual(Object.keys(selectedConfig.mcpServers).sort(), ['dueno', 'fetch']);
    assert.match(selectedConfig.mcpServers.dueno.headers.Authorization, /\$\{DUENO_AGENT_BUS_TOKEN\}/);
    assert.equal(JSON.stringify(selectedConfig).includes(issuedTokens[1]), false);
    assert.deepEqual((await credentialStore.authenticate(issuedTokens[1])).serverAllowlist, ['dueno', 'fetch']);

    const forced = await app.inject({
      method: 'POST', url: '/api/claude/sessions', payload: { workDir, mcpServers: { remove: ['dueno'] } },
    });
    assert.equal(forced.statusCode, 200, forced.body);
    assert.deepEqual(forced.json().mcpCapabilities.serverIds, ['dueno']);
    assert.equal(forced.json().mcpWarnings.some((warning) => warning.code === 'mcp_required_server_forced'), true);
    const forcedConfigPath = clients[2].startSpec.mcpConfigPath;
    const forcedConfig = JSON.parse(await readFile(forcedConfigPath, 'utf8'));
    assert.deepEqual(Object.keys(forcedConfig.mcpServers), ['dueno']);
    assert.equal(issueCalls, 3);
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    assert.equal((await credentialStore.authenticate(issuedTokens[1])).reason, 'revoked');
    assert.equal((await credentialStore.authenticate(issuedTokens[2])).reason, 'revoked');
    await assert.rejects(stat(selectedConfigPath), /ENOENT/);
    await assert.rejects(stat(forcedConfigPath), /ENOENT/);
  });

  it('rejects unknown, unconfigured, and incompatible selections before minting a credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-claude-stream-selection-'));
    roots.push(root);
    const workDir = join(root, 'work');
    await mkdir(workDir);
    let credentialState = null;
    const credentialStore = new AgentBusCredentialStore({
      mode: 'issue_only', store: {
        mode: 'memory', async load() { return credentialState; },
        async save(next) { credentialState = structuredClone(next); }, async close() {},
      },
    });
    let issueCalls = 0;
    const issueCredential = credentialStore.issue.bind(credentialStore);
    credentialStore.issue = (options) => { issueCalls += 1; return issueCredential(options); };
    const mcpCatalog = structuredClone(buildMcpCapabilityCatalog({
      sourceConfig: { agentBusMcpHttp: { host: '127.0.0.1', port: 9876, path: '/mcp' } },
    }));
    mcpCatalog.servers.find((server) => server.id === 'fetch').providers = ['codex'];
    mcpCatalog.servers.find((server) => server.id === 'time').runtimes = ['pi'];
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(claudeSessionsPlugin, {
      streamJsonEnabled: true, sessionRoot: join(root, 'sessions'),
      credentialStore, sourceConfig: { agentBusMcpHttp: { host: '127.0.0.1', port: 9876, path: '/mcp' } },
      mcpCatalog,
    });
    const unknownProfile = await app.inject({
      method: 'POST', url: '/api/claude/sessions', payload: { workDir, mcpProfile: 'unknown' },
    });
    assert.equal(unknownProfile.json().code, 'mcp_profile_unknown');
    const unknown = await app.inject({
      method: 'POST', url: '/api/claude/sessions', payload: { workDir, mcpServers: { add: ['unknown'] } },
    });
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.json().code, 'mcp_server_unknown');
    const providerUnsupported = await app.inject({
      method: 'POST', url: '/api/claude/sessions', payload: { workDir, mcpServers: { add: ['fetch'] } },
    });
    assert.equal(providerUnsupported.json().code, 'mcp_provider_unsupported');
    const runtimeUnsupported = await app.inject({
      method: 'POST', url: '/api/claude/sessions', payload: { workDir, mcpServers: { add: ['time'] } },
    });
    assert.equal(runtimeUnsupported.json().code, 'mcp_runtime_unsupported');
    const unconfigured = await app.inject({
      method: 'POST', url: '/api/claude/sessions', payload: { workDir, mcpServers: { add: ['businessos'] } },
    });
    assert.equal(unconfigured.statusCode, 400);
    assert.equal(unconfigured.json().code, 'mcp_server_unconfigured');
    assert.equal(issueCalls, 0);
    assert.equal(credentialState, null);
  });

  it('revokes the scoped bearer when launch preparation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-claude-stream-failure-'));
    roots.push(root);
    const sessionRoot = join(root, 'sessions');
    const workDir = join(root, 'work');
    await mkdir(workDir);
    let state = null;
    let issuedToken = '';
    const credentialStore = new AgentBusCredentialStore({
      mode: 'issue_only', store: {
        mode: 'memory', async load() { return state; },
        async save(next) { state = structuredClone(next); }, async close() {},
      },
    });
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(claudeSessionsPlugin, {
      streamJsonEnabled: true, sessionRoot,
      credentialStore, sourceConfig: { agentBusMcpHttp: { host: '127.0.0.1', port: 9876, path: '/mcp' } },
      mcpDiscovery: async ({ token }) => { issuedToken = token; throw new Error('discovery failed'); },
    });
    const response = await app.inject({
      method: 'POST', url: '/api/claude/sessions', payload: { workDir, mcpServers: { add: ['fetch'] } },
    });
    assert.equal(response.statusCode, 500);
    assert.ok(issuedToken);
    assert.equal((await credentialStore.authenticate(issuedToken)).reason, 'revoked');
    assert.equal((await readdir(sessionRoot, { recursive: true }))
      .some((entry) => entry.endsWith('dueno-mcp.json')), false);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/claude/sessions' })).json().sessions, []);
  });

  for (const kind of ['claude', 'codex']) {
    it(`resumes an interrupted ${kind} structured session through its route after a Fleet restart`, async () => {
      const root = await mkdtemp(join(tmpdir(), `dueno-${kind}-structured-resume-`));
      roots.push(root);
      const workDir = join(root, 'work');
      await mkdir(workDir);
      let credentialState = null;
      const credentialStore = new AgentBusCredentialStore({
        mode: 'issue_only', store: {
          mode: 'memory', async load() { return credentialState; },
          async save(next) { credentialState = structuredClone(next); }, async close() {},
        },
      });
      const clients = [];
      const register = async () => {
        const app = Fastify({ logger: false });
        apps.push(app);
        await app.register(kind === 'claude' ? claudeSessionsPlugin : codexSessionsPlugin, {
          streamJsonEnabled: true, appServerEnabled: true, sessionRoot: join(root, 'sessions'), credentialStore,
          sourceConfig: { agentBusMcpHttp: { host: '127.0.0.1', port: 9876, path: '/mcp' } },
          mcpDiscovery: async () => ({ authenticated: true }), e2eEvidence: { proven: true, expectedVersion: 'test' },
          transportFactory() { const client = new FakeTransport(kind); clients.push(client); return client; },
        });
        return app;
      };
      const base = `/api/${kind}/sessions`;
      const first = await register();
      assert.equal(Boolean(getProtocolSessionProvider(kind)), kind === 'claude');
      if (kind === 'codex') {
        const invalid = await first.inject({ method: 'POST', url: base, payload: { workDir, codexPlugins: 'x' } });
        assert.deepEqual([invalid.statusCode, invalid.json().code, clients.length], [400, 'codex_plugin_selection_invalid', 0]);
      }
      const created = await first.inject({ method: 'POST', url: base, payload: {
        workDir, initialPrompt: 'remember PELICAN', thinkingLevel: 'high',
        ...(kind === 'codex' ? { codexPlugins: { add: ['fixture@local'] } } : {}),
      } });
      assert.equal(created.statusCode, 200, created.body);
      const { id } = created.json();
      assert.deepEqual([created.json().provider, created.json().sessionName, created.json().canResume],
        [kind, `${kind}-${id}`, false]);
      assert.equal(clients[0].startSpec.thinkingLevel, 'high');
      const pluginArgs = /plugins\."browser@openai-bundled"\.enabled=false[\s\S]*plugins\."fixture@local"\.enabled=true/;
      const firstToken = clients[0].startSpec.env.DUENO_AGENT_BUS_TOKEN;
      assert.equal(clients[0].startSpec.env.DUENO_PROVIDER, kind);
      assert.equal(clients[0].startSpec.permissionMode, 'workspace-write');
      if (kind === 'codex') {
        assert.equal(created.json().transport, 'app-server');
        const args = clients[0].startSpec.args.join(' ');
        assert.match(args, /mcp_servers=\{\}/);
        assert.match(args, /bearer_token_env_var="DUENO_AGENT_BUS_TOKEN"/);
        assert.equal(args.includes(firstToken), false);
        assert.match(args, pluginArgs);
      }
      await waitFor(async () => (await first.inject({ method: 'GET', url: `${base}/${id}` })).json().content.includes('Structured reply'));
      const early = await first.inject({ method: 'POST', url: `${base}/${id}/resume` });
      assert.deepEqual([early.statusCode, early.json().code], [409, 'session_not_resumable']);
      await first.close(); // Fleet restart: the provider process is gone, the provider conversation is not.
      apps.splice(apps.indexOf(first), 1);
      assert.equal((await credentialStore.authenticate(firstToken)).reason, 'revoked');

      const second = await register();
      const interrupted = (await second.inject({ method: 'GET', url: `${base}/${id}` })).json();
      assert.deepEqual([interrupted.state.status, interrupted.sessionEnded, interrupted.canResume, interrupted.nonResumable], ['ended', true, true, false]);
      FakeTransport.failNextAttach = true;
      const failed = await second.inject({ method: 'POST', url: `${base}/${id}/resume` });
      assert.equal(failed.statusCode, 500);
      assert.equal((await credentialStore.authenticate(clients[1].attachSpec.env.DUENO_AGENT_BUS_TOKEN)).reason, 'revoked');
      assert.equal((await second.inject({ method: 'GET', url: `${base}/${id}` })).json().canResume, true);
      // Concurrent resumes serialize: the loser must not revoke or delete what the winner issued.
      const racing = await Promise.all([1, 2].map(() => second.inject({ method: 'POST', url: `${base}/${id}/resume` })));
      assert.deepEqual(racing.map((response) => response.statusCode).sort(), [200, 409]);
      const resumed = racing.find((response) => response.statusCode === 200);
      // The loser must not offer Start Fresh beside the session the winner just resumed.
      assert.equal(racing.find((response) => response.statusCode === 409).json().freshSession, undefined);
      assert.equal(resumed.json().canResume, false);
      const attach = clients[2].attachSpec;
      assert.ok(created.json().attempts[0].protocolSessionId);
      assert.equal(attach.protocolSessionId, created.json().attempts[0].protocolSessionId);
      assert.deepEqual(attach.promptArgs || [], []);
      assert.equal(attach.permissionMode, 'workspace-write');
      assert.equal(attach.thinkingLevel, 'high');
      if (kind === 'codex') assert.match(attach.args.join(' '), pluginArgs);
      if (kind === 'claude') {
        assert.match(attach.mcpConfigPath, /attempt-3\/dueno-mcp\.json$/);
        await stat(attach.mcpConfigPath);
      }
      const resumedToken = attach.env.DUENO_AGENT_BUS_TOKEN;
      assert.notEqual(resumedToken, firstToken);
      assert.equal((await credentialStore.authenticate(resumedToken)).ok, true);
      const sent = await second.inject({ method: 'POST', url: `${base}/${id}/input`, payload: { text: 'what word?' } });
      assert.equal(sent.statusCode, 200, sent.body);
      await waitFor(async () => (await second.inject({ method: 'GET', url: `${base}/${id}` })).json().state.status === 'ready');
      assert.equal(clients[2].prompts.length, 1);
      const detail = (await second.inject({ method: 'GET', url: `${base}/${id}` })).json();
      assert.match(detail.content, /remember PELICAN[\s\S]*what word\?/);
      const again = await second.inject({ method: 'POST', url: `${base}/${id}/resume` });
      assert.equal(again.statusCode, 409);
      assert.equal((await second.inject({ method: 'POST', url: `${base}/missing/resume` })).statusCode, 404);
      assert.equal((await second.inject({ method: 'DELETE', url: `${base}/${id}` })).json().ok, true);
      assert.equal((await credentialStore.authenticate(resumedToken)).reason, 'revoked');
      await assert.rejects(stat(join(root, 'sessions', id)), { code: 'ENOENT' });
    });

    it(`offers ${kind} Start Fresh instead of resuming a conversation that was never proven`, async () => {
      const root = await mkdtemp(join(tmpdir(), `dueno-${kind}-structured-unproven-`));
      roots.push(root);
      const workDir = join(root, 'work');
      await mkdir(workDir);
      const clients = [];
      const register = async () => {
        const app = Fastify({ logger: false });
        apps.push(app);
        await app.register(kind === 'claude' ? claudeSessionsPlugin : codexSessionsPlugin, {
          streamJsonEnabled: true, appServerEnabled: true, sessionRoot: join(root, 'sessions'),
          sourceConfig: { agentBusMcpHttp: { host: '127.0.0.1', port: 9876, path: '/mcp' } },
          mcpDiscovery: async () => ({ authenticated: true }), e2eEvidence: { proven: true, expectedVersion: 'test' },
          transportFactory() { const client = new FakeTransport(kind); clients.push(client); return client; },
        });
        return app;
      };
      const base = `/api/${kind}/sessions`;
      const first = await register();
      const created = await first.inject({ method: 'POST', url: base, payload: { workDir, displayName: 'Idle', model: kind === 'claude' ? 'claude-sonnet-5' : '' } });
      assert.equal(created.statusCode, 200, created.body);
      const { id } = created.json();
      let taskId = null;
      if (kind === 'claude') {
        // A task-owned session is resumable only through task_resume.
        const { service } = getProtocolSessionProvider('claude');
        taskId = (await service.start({ workDir, permissionMode: 'workspace-write', metadata: { taskId: 'task-1' } })).id;
        await service.prompt(taskId, { blocks: [{ type: 'text', text: 'task work' }], idempotencyKey: 'task', taskAdmission: TASK_ADMISSION });
        await waitFor(() => service.get(taskId).turns[0]?.status === 'settled');
      }
      await first.close();
      apps.splice(apps.indexOf(first), 1);

      const second = await register();
      const launched = clients.length;
      const idle = (await second.inject({ method: 'GET', url: `${base}/${id}` })).json();
      assert.deepEqual([idle.canResume, idle.nonResumable, idle.model], [false, true, created.json().model]);
      const refused = await second.inject({ method: 'POST', url: `${base}/${id}/resume` });
      assert.deepEqual([refused.statusCode, refused.json().code], [409, 'session_not_resumable']);
      assert.deepEqual(refused.json().freshSession, { workDir, model: created.json().model, displayName: 'Idle' });
      if (taskId) {
        assert.equal((await second.inject({ method: 'GET', url: `${base}/${taskId}` })).json().canResume, false);
        const task = await second.inject({ method: 'POST', url: `${base}/${taskId}/resume` });
        assert.deepEqual([task.statusCode, task.json().code, task.json().freshSession], [409, 'task_managed', undefined]);
      }
      assert.equal(clients.length, launched);
    });
  }

  it('gives Research Workbench Codex sessions the read-only untrusted sandbox and validates permission modes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-codex-structured-research-'));
    roots.push(root);
    const workDir = join(root, 'work');
    await mkdir(workDir);
    const clients = [];
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(codexSessionsPlugin, {
      appServerEnabled: true, sessionRoot: join(root, 'sessions'),
      sourceConfig: { agentBusMcpHttp: { host: '127.0.0.1', port: 9876, path: '/mcp' } },
      transportFactory() { const client = new FakeTransport('codex'); clients.push(client); return client; },
    });
    const research = await app.inject({ method: 'POST', url: '/api/codex/sessions', payload: {
      workDir, permissionMode: 'danger-full-access', metadata: { researchWorkbench: { profileId: RESEARCH_PROFILE_ID } },
    } });
    assert.equal(research.statusCode, 200, research.body);
    assert.deepEqual([clients[0].startSpec.permissionMode, clients[0].startSpec.approvalPolicy], ['read-only', 'untrusted']);
    const plain = await app.inject({ method: 'POST', url: '/api/codex/sessions', payload: { workDir } });
    assert.equal(plain.statusCode, 200, plain.body);
    assert.deepEqual([clients[1].startSpec.permissionMode, clients[1].startSpec.approvalPolicy], ['workspace-write', 'on-request']);
    const invalid = await app.inject({ method: 'POST', url: '/api/codex/sessions', payload: { workDir, permissionMode: 'yolo' } });
    assert.deepEqual([invalid.statusCode, invalid.json().code], [400, 'unsupported_permission_mode']);
    assert.equal(clients.length, 2);
    // Automated spawns default to tmux's unattended full access; Research Workbench still forces read-only.
    for (const metadata of [undefined, { researchWorkbench: { profileId: RESEARCH_PROFILE_ID } }]) {
      const res = await app.inject({ method: 'POST', url: '/api/codex/sessions', payload: { workDir, structured: true, metadata } });
      assert.equal(res.statusCode, 200, res.body);
    }
    assert.deepEqual(clients.slice(2).map((client) => [client.startSpec.permissionMode, client.startSpec.approvalPolicy]),
      [['danger-full-access', 'never'], ['read-only', 'untrusted']]);
  });

  it('keeps interactive Codex on the tmux provider unless opted in', () => {
    assert.equal(isCodexAppServerEnabled(''), false);
    assert.equal(isCodexAppServerEnabled('0'), false);
    assert.equal(isCodexAppServerEnabled('yes'), true);
  });
});
