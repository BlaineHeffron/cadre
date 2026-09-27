import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  buildDeepSeekChildEnv,
  deepseekSessionsPlugin,
  getDeepSeekProviderHealth,
} from '../modules/sessions/deepseek-sessions.mjs';
import { buildAgentRuntimeLaunchArgs, buildAgentRuntimeResumeArgs } from '../modules/agent/runtime-args.mjs';
import { resolveSpawnType } from '../modules/agent/provider-preferences.mjs';
import { buildAgentProviderCatalog } from '../modules/agent/provider-interface.mjs';
import { AsyncEventQueue, createBaseCapabilities, createTransportEvent, unsupportedCapability } from '../modules/agent/agent-transport.mjs';
import { AgentBusCredentialStore } from '../modules/agent-bus/mcp-auth.mjs';

const tempDirs = [];

class FakeTransport {
  constructor({ imageEnabled = false } = {}) {
    this.queue = new AsyncEventQueue();
    this.prompts = [];
    this.permissionAnswers = [];
    this.cancelCalls = 0;
    this.open = new Map();
    this.closed = false;
    this.imageEnabled = imageEnabled;
  }

  emit(type, payload = {}) {
    this.queue.push(createTransportEvent(type, payload, { attemptId: this.attemptId, provider: 'deepseek', transport: 'acp' }));
  }

  async start(spec) {
    this.startSpec = structuredClone(spec);
    this.attemptId = spec.attemptId;
    this.emit('attempt.started', { protocolSessionId: 'acp-session-1' });
    return { attemptId: spec.attemptId, protocolSessionId: 'acp-session-1', negotiated: this.capabilities() };
  }

  async attach() { throw unsupportedCapability('attach'); }

  async prompt({ turnId, blocks }) {
    const value = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    this.prompts.push(value || structuredClone(blocks));
    this.emit('turn.started', { turnId, evidence: { accepted: true, settled: false, quiescent: false } });
    this.emit('message.delta', { turnId, delta: { type: 'text', text: 'Fin' } });
    this.emit('message.delta', { turnId, delta: { type: 'text', text: 'ished' } });
    this.emit('message.committed', { turnId, blocks: [{ type: 'text', text: 'Finished' }] });
    this.emit('turn.settled', { turnId, stopReason: 'end_turn', evidence: { accepted: true, settled: true, quiescent: true } });
    return { stopReason: 'end_turn' };
  }

  async cancel() { this.cancelCalls += 1; return { mode: 'best_effort' }; }

  emitPermission({ requestId, toolCall, options, turnId = null }) {
    const interactionId = `${this.attemptId}:${requestId}`;
    this.open.set(interactionId, { requestId, options });
    this.emit('interaction.requested', { interactionId, turnId, kind: 'permission', toolCall, options });
  }

  async answerInteraction({ interactionId, optionId }) {
    const entry = this.open.get(interactionId);
    if (!entry) throw new Error('interaction missing');
    this.permissionAnswers.push({ requestId: entry.requestId, optionId });
    this.open.delete(interactionId);
    this.emit('interaction.answered', { interactionId, optionId });
    return { ok: true };
  }

  async cancelInteraction(interactionId) {
    if (!this.open.delete(interactionId)) return false;
    this.emit('interaction.cancelled', { interactionId });
    return true;
  }

  events() { return this.queue; }
  snapshot() { return { attemptId: this.attemptId, lifecycle: this.closed ? 'ended' : 'ready' }; }
  capabilities() {
    return createBaseCapabilities({
      protocol: { name: 'acp', version: '1' },
      promptCapabilities: this.imageEnabled ? {
        types: ['text', 'resource_link', 'image'], deliveryMode: 'inline',
        mimeAllowlist: ['image/png'], maxBytes: 1024, maxCount: 2, maxSessionBytes: 4096,
      } : undefined,
      ...(this.startSpec?.capabilityEvidence || {}),
    });
  }
  async terminate() {
    this.closed = true;
    this.emit('attempt.exited', { code: 0 });
    this.queue.close();
    return { ok: true, status: 'terminated', residual: [] };
  }
}

afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop(), { recursive: true, force: true });
});

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for test state');
}

async function buildHarness({ healthOk = true, existingRoot = null, startFailure = false, discoveryFailure = false, imageEnabled = false } = {}) {
  const root = existingRoot || await mkdtemp(join(tmpdir(), 'dueno-deepseek-'));
  if (!existingRoot) tempDirs.push(root);
  const workDir = join(root, 'work');
  await mkdir(workDir, { recursive: true });
  const clients = [];
  const broadcasts = [];
  const sends = [];
  let channelHandler = null;
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    request.duenoAuth = {
      authenticated: true,
      principal: { type: 'ui', kind: 'dashboard', sessionId: 'test-operator' },
      automationPolicy: '',
    };
  });
  let credentialState = null;
  const attemptConfigPaths = [];
  const issuedTokens = [];
  const credentialStore = new AgentBusCredentialStore({
    mode: 'issue_only',
    store: {
      mode: 'memory',
      async load() { return credentialState; },
      async save(next) { credentialState = structuredClone(next); },
      async close() {},
    },
  });
  await app.register(deepseekSessionsPlugin, {
    sessionRoot: join(root, 'sessions'),
    healthFn: () => ({ ok: healthOk, detail: healthOk ? 'deepseek_acp_ready' : 'api_key_missing' }),
    credentialStore,
    sourceConfig: { agentBusMcpHttp: { host: '127.0.0.1', port: 9876, path: '/mcp' } },
    mcpDiscovery: async ({ token }) => {
      issuedTokens.push(token);
      if (discoveryFailure) {
        const error = new Error('synthetic authenticated discovery failure');
        error.statusCode = 503;
        error.code = 'deepseek_mcp_discovery_failed';
        throw error;
      }
      return { authenticated: true, discoveredToolCount: 8 };
    },
    async attemptConfigWriter({ sessionId, attemptGeneration }) {
      const path = join(root, `deepseek-${sessionId}-attempt-${attemptGeneration}.cordis.yml`);
      await writeFile(path, '# synthetic per-attempt Cordis config\n', { mode: 0o600 });
      attemptConfigPaths.push(path);
      return path;
    },
    async attemptConfigRemover({ sessionId, attemptGeneration }) {
      await rm(join(root, `deepseek-${sessionId}-attempt-${attemptGeneration}.cordis.yml`), { force: true });
    },
    wsManager: {
      broadcast(...args) { broadcasts.push(args); },
      onChannel(_name, handler) { channelHandler = handler; },
      send(...args) { sends.push(args); },
    },
    transportFactory() {
      const transport = new FakeTransport({ imageEnabled });
      if (startFailure) {
        transport.start = async function failStart(spec) {
          this.startSpec = structuredClone(spec);
          throw new Error('synthetic transport start failure');
        };
      }
      clients.push(transport);
      return transport;
    },
  });
  return {
    app, clients, broadcasts, sends, credentialStore, attemptConfigPaths, issuedTokens,
    get credentialState() { return structuredClone(credentialState); },
    get channelHandler() { return channelHandler; }, workDir, root,
  };
}

describe('DeepSeek Harness ACP sessions', () => {
  it('builds the ACP process argv and rejects unsupported resume', { timeout: 15000 }, () => {
    assert.deepEqual(
      buildAgentRuntimeLaunchArgs({ runtime: 'deepseek', configPath: '/tmp/deepseek.yml' }),
      ['--config', '/tmp/deepseek.yml'],
    );
    assert.throws(
      () => buildAgentRuntimeResumeArgs({ runtime: 'deepseek', cliSessionId: 'old' }),
      /cannot be resumed/,
    );
  });

  it('creates an ACP-backed session and projects committed output', { timeout: 15000 }, async () => {
    const harness = await buildHarness();
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/deepseek/sessions',
      payload: { workDir: harness.workDir, initialPrompt: 'Run the tests' },
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().transport, 'acp');
    assert.equal(created.json().transcriptGrade, 'committed_text');
    assert.equal(created.json().experimental, true);
    assert.equal(created.json().negotiated.mcpAttachment, 'launch_time_mcp_client');
    assert.deepEqual(created.json().negotiated.mcpFeatures, { tools: true, resources: false, prompts: false });
    assert.equal(created.json().negotiated.busParticipation, 'authenticated_scoped');
    assert.equal(created.json().initialPromptInjected, true);
    await waitFor(async () => {
      const response = await harness.app.inject({ method: 'GET', url: `/api/deepseek/sessions/${created.json().id}` });
      return response.json().state.status === 'ready';
    });

    const detail = await harness.app.inject({
      method: 'GET',
      url: `/api/deepseek/sessions/${created.json().id}`,
    });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().state.status, 'ready');
    assert.equal(detail.json().state.transcriptGrade, 'committed_text');
    assert.match(detail.json().content, /> Run the tests/);
    assert.match(detail.json().content, /Finished/);
    assert.deepEqual(harness.clients[0].prompts, ['Run the tests']);
    const token = harness.clients[0].startSpec.env.DUENO_AGENT_BUS_TOKEN;
    assert.match(token, /^dueno_mcp_v1\./);
    assert.equal(JSON.stringify(harness.clients[0].startSpec.args || []).includes(token), false);
    assert.equal(JSON.stringify(created.json()).includes(token), false);
    assert.equal(JSON.stringify(harness.credentialState).includes(token), false);
    const removed = await harness.app.inject({ method: 'DELETE', url: `/api/deepseek/sessions/${created.json().id}` });
    assert.equal(removed.statusCode, 200);
    assert.equal((await harness.credentialStore.authenticate(token)).reason, 'revoked');
    await assert.rejects(stat(harness.attemptConfigPaths[0]), /ENOENT/);
    await harness.app.close();
  });

  it('stores and redacts an image before delivering it when ACP advertises image prompts', { timeout: 15000 }, async () => {
    const harness = await buildHarness({ imageEnabled: true });
    const created = await harness.app.inject({
      method: 'POST', url: '/api/deepseek/sessions', payload: { workDir: harness.workDir },
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.deepEqual(created.json().negotiated.promptCapabilities.mimeAllowlist, ['image/png']);
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]).toString('base64');
    const input = await harness.app.inject({
      method: 'POST', url: `/api/deepseek/sessions/${created.json().id}/input`,
      payload: { blocks: [{ type: 'image', mimeType: 'image/png', data: png, name: 'screen.png' }] },
    });
    assert.equal(input.statusCode, 200, input.body);
    assert.deepEqual(harness.clients[0].prompts[0], [{
      type: 'image', mimeType: 'image/png', data: png, name: 'screen.png',
    }]);
    const detail = await harness.app.inject({ method: 'GET', url: `/api/deepseek/sessions/${created.json().id}` });
    const durable = detail.json().turns[0].blocks[0];
    assert.match(durable.attachment.digest, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(detail.json()).includes(png), false);
    const removed = await harness.app.inject({
      method: 'DELETE', url: `/api/deepseek/sessions/${created.json().id}`,
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(removed.json().status, 'deleted');
    assert.deepEqual(await readdir(join(harness.root, 'sessions', 'attachments', 'blobs')), []);
    assert.deepEqual(await readdir(join(harness.root, 'sessions', 'journal')), []);
    const missing = await harness.app.inject({ method: 'GET', url: `/api/deepseek/sessions/${created.json().id}` });
    assert.equal(missing.statusCode, 404);
    await harness.app.close();
  });

  it('falls back from empty blocks to text and rejects non-array blocks', { timeout: 15000 }, async () => {
    const harness = await buildHarness();
    const created = await harness.app.inject({
      method: 'POST', url: '/api/deepseek/sessions', payload: { workDir: harness.workDir },
    });
    const fallback = await harness.app.inject({
      method: 'POST', url: `/api/deepseek/sessions/${created.json().id}/input`,
      payload: { text: 'fallback text', blocks: [] },
    });
    assert.equal(fallback.statusCode, 200, fallback.body);
    assert.deepEqual(harness.clients[0].prompts, ['fallback text']);
    const invalid = await harness.app.inject({
      method: 'POST', url: `/api/deepseek/sessions/${created.json().id}/input`,
      payload: { text: 'must not send', blocks: { type: 'text', text: 'wrong shape' } },
    });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.equal(invalid.json().code, 'invalid_prompt_blocks');
    assert.deepEqual(harness.clients[0].prompts, ['fallback text']);
    const removed = await harness.app.inject({
      method: 'DELETE', url: `/api/deepseek/sessions/${created.json().id}`,
    });
    assert.equal(removed.statusCode, 200, removed.body);
    await harness.app.close();
  });

  it('revokes the per-attempt credential when ACP startup fails', { timeout: 15000 }, async () => {
    const harness = await buildHarness({ startFailure: true });
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/deepseek/sessions',
      payload: { workDir: harness.workDir },
    });
    assert.equal(response.statusCode, 500);
    const token = harness.clients[0].startSpec.env.DUENO_AGENT_BUS_TOKEN;
    assert.match(token, /^dueno_mcp_v1\./);
    assert.equal((await harness.credentialStore.authenticate(token)).reason, 'revoked');
    await harness.app.close();
  });

  it('fails closed and removes attempt state when authenticated Dueno discovery fails', { timeout: 15000 }, async () => {
    const harness = await buildHarness({ discoveryFailure: true });
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/deepseek/sessions',
      payload: { workDir: harness.workDir },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'deepseek_mcp_discovery_failed');
    assert.equal(harness.clients.length, 0);
    assert.equal((await harness.credentialStore.authenticate(harness.issuedTokens[0])).reason, 'revoked');
    await assert.rejects(stat(harness.attemptConfigPaths[0]), /ENOENT/);
    await harness.app.close();
  });

  it('maps ACP permission options to Fleet interaction answers once', { timeout: 15000 }, async () => {
    const harness = await buildHarness();
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/deepseek/sessions',
      payload: { workDir: harness.workDir },
    });
    const id = created.json().id;
    harness.clients[0].prompt = async ({ turnId }) => {
      harness.clients[0].currentTurnId = turnId;
      harness.clients[0].emit('turn.started', { turnId });
      return new Promise(() => {});
    };
    const prompted = await harness.app.inject({
      method: 'POST', url: `/api/deepseek/sessions/${id}/input`, payload: { text: 'trigger permission' },
    });
    assert.equal(prompted.statusCode, 200);
    await waitFor(() => harness.app.inject({ method: 'GET', url: `/api/deepseek/sessions/${id}` })
      .then((response) => response.json().state.status === 'working'));
    harness.clients[0].emitPermission({
      requestId: 42,
      sessionId: 'acp-session-1',
      toolCall: { title: 'Write outside workspace' },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
      turnId: harness.clients[0].currentTurnId,
    });

    await waitFor(async () => {
      const response = await harness.app.inject({ method: 'GET', url: `/api/deepseek/sessions/${id}` });
      return response.json().state.status === 'blocked';
    });

    const blocked = await harness.app.inject({ method: 'GET', url: `/api/deepseek/sessions/${id}` });
    assert.equal(blocked.json().state.status, 'blocked');

    const answered = await harness.app.inject({
      method: 'POST',
      url: `/api/deepseek/sessions/${id}/input`,
      payload: { text: 'allow_once' },
    });
    assert.equal(answered.statusCode, 200);
    assert.deepEqual(harness.clients[0].permissionAnswers, [{ requestId: 42, optionId: 'allow_once' }]);

    const replay = await harness.app.inject({
      method: 'POST',
      url: `/api/deepseek/sessions/${id}/interaction`,
      payload: { optionId: 'allow_once' },
    });
    assert.equal(replay.statusCode, 409);
    await harness.app.close();
  });

  it('rejects overlapping prompts and unsupported capabilities', { timeout: 15000 }, async () => {
    const harness = await buildHarness();
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/deepseek/sessions',
      payload: { workDir: harness.workDir, thinkingLevel: 'high' },
    });
    assert.equal(created.statusCode, 400);

    const ok = await harness.app.inject({
      method: 'POST',
      url: '/api/deepseek/sessions',
      payload: { workDir: harness.workDir },
    });
    const id = ok.json().id;
    harness.clients[0].prompt = async () => new Promise(() => {});
    const first = await harness.app.inject({
      method: 'POST',
      url: `/api/deepseek/sessions/${id}/input`,
      payload: { text: 'hello' },
    });
    assert.equal(first.statusCode, 200);
    const second = await harness.app.inject({
      method: 'POST',
      url: `/api/deepseek/sessions/${id}/input`,
      payload: { text: 'again' },
    });
    assert.equal(second.statusCode, 409);
    await harness.app.close();
  });

  it('returns 503 when DeepSeek health fails', { timeout: 15000 }, async () => {
    const harness = await buildHarness({ healthOk: false });
    const created = await harness.app.inject({
      method: 'POST',
      url: '/api/deepseek/sessions',
      payload: { workDir: harness.workDir },
    });
    assert.equal(created.statusCode, 503);
    await harness.app.close();
  });

  it('allowlists child env and reports experimental catalog flags', { timeout: 15000 }, () => {
    const env = buildDeepSeekChildEnv({
      sourceEnv: {
        PATH: '/usr/bin',
        DEEPSEEK_API_KEY: 'secret',
        AWS_SECRET_ACCESS_KEY: 'nope',
        HOME: '/tmp/home',
      },
      model: 'deepseek-v4-flash',
      sessionRoot: '/tmp/s',
      permissionMode: 'workspace-write',
    });
    assert.equal(env.DEEPSEEK_API_KEY, 'secret');
    assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(env.DEEPSEEK_MODEL, 'deepseek-v4-flash');
    const catalog = buildAgentProviderCatalog();
    const deepseek = catalog.find((entry) => entry.id === 'deepseek');
    assert.equal(deepseek.enabled, false);
    assert.equal(deepseek.supportsOneOffTasks, false);
    assert.equal(deepseek.experimental, true);
    assert.equal(deepseek.supportsCollaboration, true);
    assert.equal(deepseek.transportCapabilities.busParticipation, 'authenticated_scoped');
    assert.equal(resolveSpawnType('deepseek', { deepseek: true, claude: true, codex: true, pi: true }), 'deepseek');
    assert.equal(resolveSpawnType('deepseek', { deepseek: false, claude: true, codex: true, pi: true }), 'codex');
    assert.equal(getDeepSeekProviderHealth({ env: {}, binary: '/missing-bin', configPath: '/missing.yml' }).ok, false);
  });

  it('reaps leftover process groups from the ledger on boot', { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-deepseek-reap-'));
    tempDirs.push(root);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const pid = child.pid;
    child.unref();
    const { readProcessStartTime } = await import('../modules/sessions/deepseek-acp-client.mjs');
    const startTime = readProcessStartTime(pid);
    await mkdir(join(root, 'sessions'), { recursive: true });
    await writeFile(join(root, 'sessions', 'ledger.json'), JSON.stringify([{
      id: 'dead',
      pid,
      pgid: pid,
      processStartTime: startTime,
      sessionRoot: join(root, 'sessions', 'dead'),
      createdAt: Date.now(),
    }]));
    const app = Fastify({ logger: false });
    await app.register(deepseekSessionsPlugin, {
      sessionRoot: join(root, 'sessions'),
      healthFn: () => ({ ok: true }),
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false);
    await app.close();
  });

  it('preserves history and marks an inflight turn unknown/non-resumable across Fleet restart', { timeout: 15000 }, async () => {
    const first = await buildHarness();
    const created = await first.app.inject({ method: 'POST', url: '/api/deepseek/sessions', payload: { workDir: first.workDir } });
    const id = created.json().id;
    first.clients[0].prompt = async ({ turnId }) => {
      first.clients[0].emit('turn.started', { turnId });
      return new Promise(() => {});
    };
    const sent = await first.app.inject({ method: 'POST', url: `/api/deepseek/sessions/${id}/input`, payload: { text: 'uncertain prompt' } });
    assert.equal(sent.statusCode, 200);
    await waitFor(async () => {
      const response = await first.app.inject({ method: 'GET', url: `/api/deepseek/sessions/${id}` });
      return response.json().turns[0]?.status === 'inflight';
    });
    await first.app.close();

    const restarted = await buildHarness({ existingRoot: first.root });
    const detail = await restarted.app.inject({ method: 'GET', url: `/api/deepseek/sessions/${id}` });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().state.status, 'ended');
    assert.equal(detail.json().nonResumable, true);
    assert.equal(detail.json().endedWithHistory, true);
    assert.equal(detail.json().turns[0].status, 'unknown');
    assert.match(detail.json().content, /uncertain prompt/);
    assert.equal(restarted.clients.length, 0);
    await restarted.app.close();
  });

  it('exposes journal cursors over HTTP and WebSocket subscriptions', { timeout: 15000 }, async () => {
    const harness = await buildHarness();
    const created = await harness.app.inject({ method: 'POST', url: '/api/deepseek/sessions', payload: { workDir: harness.workDir } });
    const id = created.json().id;
    const first = await harness.app.inject({ method: 'GET', url: `/api/deepseek/sessions/${id}/events?after=0&limit=2` });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().events.length, 2);
    const second = await harness.app.inject({ method: 'GET', url: `/api/deepseek/sessions/${id}/events?after=${first.json().cursor}` });
    assert.ok(second.json().events.every((event) => event.seq > first.json().cursor));
    await harness.channelHandler({}, `deepseek:session:${id}`, { action: 'subscribe', after: first.json().cursor, limit: 10 });
    const wsEvents = harness.sends.find((args) => args[2] === 'events');
    assert.ok(wsEvents);
    assert.ok(wsEvents[3].events.every((event) => event.seq > first.json().cursor));
    await harness.app.close();
  });
});
