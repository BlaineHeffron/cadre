import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildResearchSessionStore,
  ensureResearchBridgeToken,
  inspectResearchRuntimeProfile,
  normalizeResearchWorkDir,
  researchWorkbenchPlugin,
} from '../modules/integrations/research-workbench.mjs';

it('reports missing optional research setup', async () => {
  const inspected = await inspectResearchRuntimeProfile({ pluginDir: '' });
  assert.equal(inspected.ok, false);
  assert.deepEqual(inspected.checks, [{ name: 'RESEARCH_WORKBENCH_PLUGIN_DIR', ok: false }]);
  await assert.rejects(normalizeResearchWorkDir('', { defaultWorkDir: '' }), {
    code: 'research_workdir_not_configured',
    message: 'Research workdir requires RESEARCH_WORKBENCH_DEFAULT_WORKDIR',
  });
});

const TOKEN = 'r'.repeat(64);
const auth = (token = TOKEN) => ({ authorization: `Bearer ${token}` });
const context = (itemKey = 'ITEM1') => ({ source: 'zotero', itemKey });

function requestFingerprint(value) {
  const stable = (entry) => {
    if (Array.isArray(entry)) return entry.map(stable);
    if (!entry || typeof entry !== 'object') return entry;
    return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, stable(entry[key])]));
  };
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function memoryStore() {
  let value = {};
  return buildResearchSessionStore({
    stateStore: {
      loadSync: () => value,
      async load() { return value; },
      async save(next) { value = JSON.parse(JSON.stringify(next)); },
      async close() {},
    },
  });
}

async function buildApp() {
  const workDir = await mkdtemp(join(tmpdir(), 'dueno-research-workdir-'));
  const app = Fastify({ logger: false });
  const calls = [];
  let transcript = '';
  let sessionStatus = 'ready';
  let revision = 1;
  let startupInjected = true;
  let transcriptFailure = false;
  let transcriptFailureCode = 'transcript_not_found';
  const store = memoryStore();
  const requestImpl = async (path, options = {}) => {
    calls.push({ path, options: JSON.parse(JSON.stringify(options)) });
    if (path === '/api/codex/sessions' && options.method === 'POST') {
      return { id: 'codex_research_1', initialPromptInjected: startupInjected, initialPromptError: startupInjected ? null : 'startup failed' };
    }
    if (path === '/api/agent-bus/threads' && options.method === 'POST') return { thread: { id: 'thread_research_1' } };
    if (path.endsWith('/transcript')) {
      if (transcriptFailure) throw Object.assign(new Error('transcript unavailable'), { statusCode: 503, code: transcriptFailureCode });
      return { text: transcript };
    }
    if (path.includes('/api/codex/sessions/codex_research_1?')) {
      return { state: { status: sessionStatus, lifecycle: 'running', execution: sessionStatus === 'ready' ? 'idle' : 'working', revision } };
    }
    if (path === '/api/codex/sessions/codex_research_1' && options.method === 'DELETE') return { ok: true };
    if (path.endsWith('/input') && options.method === 'POST') return { accepted: true };
    if (path.endsWith('/resume') && options.method === 'POST') return { resumed: true };
    throw new Error(`Unexpected request: ${path}`);
  };
  const sourceConfig = {
    defaultWorkDir: workDir,
    allowedWorkDirs: workDir,
    streamPollMs: 10,
    streamTimeoutMs: 2000,
    runtimeProofTimeoutMs: 1000,
    pluginRef: 'research-workbench@personal',
  };
  await app.register(researchWorkbenchPlugin, {
    bridgeToken: TOKEN,
    store,
    requestImpl,
    sourceConfig,
    inspectProfile: async () => ({ ok: true, profileId: 'research-workbench-v1', mcpServers: ['zotero', 'nodus', 'paper-search'] }),
  });
  return {
    app,
    calls,
    workDir,
    store,
    setTranscript(value) { transcript = value; },
    setSession(status, nextRevision = revision + 1) { sessionStatus = status; revision = nextRevision; },
    setStartupInjected(value) { startupInjected = value; },
    setTranscriptFailure(value, code = 'transcript_not_found') { transcriptFailure = value; transcriptFailureCode = code; },
  };
}

async function create(harness, overrides = {}) {
  return harness.app.inject({
    method: 'POST',
    url: '/api/research/sessions',
    headers: auth(),
    payload: {
      idempotencyKey: 'create-1',
      provider: 'codex',
      query: { text: 'Explain this paper.', mode: 'ask' },
      context: context(),
      ...overrides,
    },
  });
}

describe('Fleet Research API', () => {
  it('requires its dedicated bearer and rejects non-Codex providers', async () => {
    const harness = await buildApp();
    const missing = await harness.app.inject({ method: 'GET', url: '/api/research/health' });
    assert.equal(missing.statusCode, 403);
    const wrong = await harness.app.inject({ method: 'GET', url: '/api/research/health', headers: auth('x'.repeat(64)) });
    assert.equal(wrong.statusCode, 403);
    const provider = await create(harness, { provider: 'claude' });
    assert.equal(provider.statusCode, 400);
    assert.equal(provider.json().code, 'research_provider_unsupported');
    await harness.app.close();
  });

  it('creates fixed-profile Codex session plus accepted first query', async () => {
    const harness = await buildApp();
    const response = await create(harness);
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.match(body.researchSessionId, /^rs_[a-f0-9]{24}$/);
    assert.deepEqual(body.agent, { kind: 'codex', id: 'codex_research_1', threadId: 'thread_research_1' });
    assert.equal(body.workDir, harness.workDir);
    assert.equal(body.fleetPath, '/codex/codex_research_1');
    assert.match(body.query.id, /^rq_[a-f0-9]{24}$/);
    assert.equal(body.query.status, 'accepted');
    assert.equal(body.query.streamPath, `/api/research/sessions/${body.researchSessionId}/queries/${body.query.id}/stream`);

    const launch = harness.calls.find((entry) => entry.path === '/api/codex/sessions');
    assert.equal(launch.options.body.metadata.researchWorkbench.profileId, 'research-workbench-v1');
    assert.equal(launch.options.body.metadata.researchWorkbench.safetyPolicy, 'read_only_sandbox_untrusted_approvals');
    assert.equal(launch.options.body.mcpProfile, 'research');
    assert.equal(Object.hasOwn(launch.options.body, 'args'), false);
    assert.equal(JSON.stringify(launch.options.body).includes('evil'), false);
    assert.match(launch.options.body.initialPrompt, /BEGIN_UNTRUSTED_ZOTERO_CONTEXT/);
    await harness.app.close();
  });

  it('fails closed and cleans up when the startup prompt was not injected', async () => {
    const harness = await buildApp();
    harness.setStartupInjected(false);
    const response = await create(harness, { idempotencyKey: 'startup-failure' });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().code, 'research_startup_injection_failed');
    assert.equal(harness.calls.some((entry) => entry.path === '/api/codex/sessions/codex_research_1' && entry.options.method === 'DELETE'), true);
    assert.equal(harness.calls.some((entry) => entry.path === '/api/agent-bus/threads'), false);
    await harness.app.close();
  });

  it('replays identical create keys and conflicts on changed payload hashes', async () => {
    const harness = await buildApp();
    const first = await create(harness);
    const replay = await create(harness);
    const conflict = await create(harness, { query: { text: 'Different.', mode: 'ask' } });
    assert.equal(first.statusCode, 200);
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().idempotencyReplay, true);
    assert.equal(replay.json().researchSessionId, first.json().researchSessionId);
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().code, 'research_idempotency_conflict');
    assert.equal(harness.calls.filter((entry) => entry.path === '/api/codex/sessions').length, 1);
    await harness.app.close();
  });

  it('never retries persisted pending side effects and reports indeterminate recovery', async () => {
    const harness = await buildApp();
    const createHashValue = requestFingerprint({
      workDir: harness.workDir,
      provider: 'codex',
      query: { text: 'Explain this paper.', mode: 'ask' },
      context: context(),
    });
    await harness.store.putCreateKey('pending-create', {
      requestHash: createHashValue,
      state: 'pending',
      createdAt: 1,
    });
    const response = await create(harness, { idempotencyKey: 'pending-create' });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().code, 'research_idempotency_indeterminate');
    assert.equal(harness.calls.filter((entry) => entry.path === '/api/codex/sessions').length, 0);
    await harness.app.close();
  });

  it('requires typed Zotero context and bounds nested selection', async () => {
    const harness = await buildApp();
    const invalid = await create(harness, { context: { source: 'zotero' } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().code, 'research_zotero_context_required');
    const valid = await create(harness, {
      idempotencyKey: 'selection',
      context: { ...context(), reader: { selection: { text: 'x'.repeat(60_000), annotation: { pageLabel: '4' } } } },
    });
    assert.equal(valid.statusCode, 200);
    const launch = harness.calls.filter((entry) => entry.path === '/api/codex/sessions').at(-1);
    assert.equal(launch.options.body.initialPrompt.includes('x'.repeat(51_200)), true);
    assert.equal(launch.options.body.initialPrompt.includes('x'.repeat(51_201)), false);
    await harness.app.close();
  });

  it('rejects relative, outside, and symlink-escaped workdirs', async () => {
    const harness = await buildApp();
    const outside = await mkdtemp(join(tmpdir(), 'dueno-research-outside-'));
    const link = join(harness.workDir, 'outside-link');
    await symlink(outside, link);
    const relative = await create(harness, { idempotencyKey: 'relative', workDir: 'relative/path' });
    const escaped = await create(harness, { idempotencyKey: 'escaped', workDir: link });
    const direct = await create(harness, { idempotencyKey: 'outside', workDir: outside });
    assert.equal(relative.statusCode, 400);
    assert.equal(relative.json().code, 'research_workdir_invalid');
    assert.equal(escaped.statusCode, 403);
    assert.equal(escaped.json().code, 'research_workdir_not_allowed');
    assert.equal(direct.statusCode, 403);
    await harness.app.close();
  });

  it('serializes active queries and submits a correlated follow-up after completion', async () => {
    const harness = await buildApp();
    const created = (await create(harness)).json();
    const payload = { idempotencyKey: 'followup', query: { text: 'Audit this claim.', mode: 'claim_audit' }, context: context() };
    const pending = await harness.app.inject({ method: 'POST', url: `/api/research/sessions/${created.researchSessionId}/queries`, headers: auth(), payload });
    assert.equal(pending.statusCode, 409);
    assert.equal(pending.json().code, 'research_query_in_progress');
    harness.setTranscript(`## AI\n\nRESEARCH_QUERY_ID: ${created.query.id}\n\nInitial research answer.`);
    const accepted = await harness.app.inject({ method: 'POST', url: `/api/research/sessions/${created.researchSessionId}/queries`, headers: auth(), payload });
    assert.equal(accepted.statusCode, 202);
    assert.equal(accepted.json().status, 'accepted');
    assert.match(accepted.json().streamPath, /\/queries\/rq_[a-f0-9]{24}\/stream$/);
    await harness.app.close();
  });

  it('serializes simultaneous follow-ups under one research-session mutex', async () => {
    const harness = await buildApp();
    const created = (await create(harness, { idempotencyKey: 'mutex-create' })).json();
    harness.setTranscript(`## AI\n\nRESEARCH_QUERY_ID: ${created.query.id}\n\nInitial answer.`);
    harness.setSession('ready', 2);
    const makePayload = (key, question) => ({ idempotencyKey: key, query: { text: question, mode: 'ask' }, context: context() });
    const [first, second] = await Promise.all([
      harness.app.inject({ method: 'POST', url: `/api/research/sessions/${created.researchSessionId}/queries`, headers: auth(), payload: makePayload('mutex-1', 'First') }),
      harness.app.inject({ method: 'POST', url: `/api/research/sessions/${created.researchSessionId}/queries`, headers: auth(), payload: makePayload('mutex-2', 'Second') }),
    ]);
    assert.deepEqual([first.statusCode, second.statusCode].sort(), [202, 409]);
    const conflict = first.statusCode === 409 ? first : second;
    assert.equal(conflict.json().code, 'research_query_in_progress');
    assert.equal(harness.calls.filter((entry) => entry.path.endsWith('/input')).length, 1);
    await harness.app.close();
  });

  it('aborts query dispatch when its transcript baseline cannot be read', async () => {
    const harness = await buildApp();
    const created = (await create(harness, { idempotencyKey: 'baseline-create' })).json();
    const session = await harness.store.getSession(created.researchSessionId);
    await harness.store.putSession({ ...session, activeQueryId: '' });
    harness.setTranscriptFailure(true);
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/research/sessions/${created.researchSessionId}/queries`,
      headers: auth(),
      payload: { idempotencyKey: 'baseline-query', query: { text: 'Question', mode: 'ask' }, context: context() },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(harness.calls.filter((entry) => entry.path.endsWith('/input')).length, 0);
    await harness.app.close();
  });

  it('keeps the initial query running while its session transcript is being bound', async () => {
    const harness = await buildApp();
    const created = (await create(harness, { idempotencyKey: 'startup-transcript-race' })).json();
    harness.setSession('working', 2);
    harness.setTranscriptFailure(true, 'transcript_not_found');
    await harness.app.listen({ host: '127.0.0.1', port: 0 });
    const address = harness.app.server.address();
    const recover = setTimeout(() => {
      harness.setTranscriptFailure(false);
      harness.setTranscript(`## AI\n\nRESEARCH_QUERY_ID: ${created.query.id}\n\nAnswer after startup.`);
      harness.setSession('ready', 3);
    }, 40);
    const response = await fetch(`http://127.0.0.1:${address.port}${created.query.streamPath}`, { headers: auth() });
    const body = await response.text();
    clearTimeout(recover);
    assert.match(body, /"state":"running"/);
    assert.match(body, /"content":"Answer after startup\."/);
    assert.match(body, /event: done/);
    assert.doesNotMatch(body, /event: error/);
    assert.doesNotMatch(body, /transcript_not_found/);
    await harness.app.close();
  });

  it('ignores a query marker echoed in the user prompt until an AI response owns it', async () => {
    const harness = await buildApp();
    const created = (await create(harness, { idempotencyKey: 'prompt-echo-correlation' })).json();
    const promptEcho = `## User\n\nStart the answer with exactly RESEARCH_QUERY_ID: ${created.query.id}.\n\nUser request:\nPost-deploy check.`;
    harness.setTranscript(promptEcho);
    harness.setSession('working', 2);
    await harness.app.listen({ host: '127.0.0.1', port: 0 });
    const address = harness.app.server.address();
    const answer = setTimeout(() => {
      harness.setTranscript(`${promptEcho}\n\n---\n\n## AI\n\nRESEARCH_QUERY_ID: ${created.query.id}.\n\nCorrelated answer.`);
      harness.setSession('ready', 3);
    }, 40);
    const response = await fetch(`http://127.0.0.1:${address.port}${created.query.streamPath}`, { headers: auth() });
    const body = await response.text();
    clearTimeout(answer);
    assert.match(body, /"content":"","state":"running"/);
    assert.match(body, /"content":"Correlated answer\."/);
    assert.doesNotMatch(body, /"content":"[^"\n]*User request/);
    assert.doesNotMatch(body, /"content":"[^"\n]*Post-deploy check/);
    assert.match(body, /event: done/);
    await harness.app.close();
  });

  it('keeps the stream attached while approval is blocked and completes after approval', async () => {
    const harness = await buildApp();
    const created = (await create(harness, { idempotencyKey: 'approval-lifecycle' })).json();
    harness.setSession('blocked', 2);
    await harness.app.listen({ host: '127.0.0.1', port: 0 });
    const address = harness.app.server.address();
    const working = setTimeout(() => harness.setSession('working', 3), 30);
    const completed = setTimeout(() => {
      harness.setTranscript(`## AI\n\nRESEARCH_QUERY_ID: ${created.query.id}\n\nApproved answer.`);
      harness.setSession('ready', 4);
    }, 60);
    const response = await fetch(`http://127.0.0.1:${address.port}${created.query.streamPath}`, { headers: auth() });
    const body = await response.text();
    clearTimeout(working);
    clearTimeout(completed);
    assert.match(body, /"state":"blocked"/);
    assert.match(body, /"state":"running"/);
    assert.match(body, /"content":"Approved answer\."/);
    assert.match(body, /event: done/);
    const blockedIndex = body.indexOf('"state":"blocked"');
    assert.equal(body.slice(0, blockedIndex).includes('event: done'), false);
    await harness.app.close();
  });

  it('exposes a resumable active query from session status without transcript content', async () => {
    const harness = await buildApp();
    const created = (await create(harness, { idempotencyKey: 'active-status' })).json();
    harness.setSession('blocked', 2);
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/research/sessions/${created.researchSessionId}`,
      headers: auth(),
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.deepEqual(body.activeQuery, {
      id: created.query.id,
      status: 'blocked',
      streamPath: created.query.streamPath,
    });
    assert.equal(JSON.stringify(body).includes('content'), false);
    await harness.app.close();
  });

  it('completes an active query after a Fleet restart resets the session revision', async () => {
    const harness = await buildApp();
    const created = (await create(harness, { idempotencyKey: 'revision-reset' })).json();
    harness.setTranscript(`## AI\n\nRESEARCH_QUERY_ID: ${created.query.id}\n\nRecovered answer.`);
    harness.setSession('ready', 0);
    const status = await harness.app.inject({
      method: 'GET',
      url: `/api/research/sessions/${created.researchSessionId}`,
      headers: auth(),
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().activeQuery, null);
    const followup = await harness.app.inject({
      method: 'POST',
      url: `/api/research/sessions/${created.researchSessionId}/queries`,
      headers: auth(),
      payload: {
        idempotencyKey: 'after-revision-reset',
        query: { text: 'Follow up.', mode: 'ask' },
        context: context(),
      },
    });
    assert.equal(followup.statusCode, 202);
    await harness.app.close();
  });

  it('streams authenticated transcript snapshots with SSE IDs and terminal done', async () => {
    const harness = await buildApp();
    const created = (await create(harness)).json();
    harness.setTranscript(`## AI\n\nRESEARCH_QUERY_ID: ${created.query.id}\n\nAnswer text.`);
    harness.setSession('ready', 7);
    await harness.app.listen({ host: '127.0.0.1', port: 0 });
    const address = harness.app.server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}${created.query.streamPath}`, {
      headers: { ...auth(), 'Last-Event-ID': '8' },
    });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /id: 9\nevent: meta/);
    assert.match(body, /event: snapshot/);
    assert.match(body, /"content":"Answer text\."/);
    assert.match(body, /"revision":7/);
    assert.match(body, /event: done/);
    assert.doesNotMatch(body, /tmux|filePath/);
    await harness.app.close();
  });
});

describe('research bridge token', () => {
  it('creates exact stable loopback schema with private modes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-research-token-'));
    const tokenPath = join(dir, 'private', 'fleet-bridge.json');
    const first = await ensureResearchBridgeToken(tokenPath, { baseUrl: 'http://127.0.0.1:4310' });
    const second = await ensureResearchBridgeToken(tokenPath, { baseUrl: 'http://127.0.0.1:4310' });
    const parsed = JSON.parse(await readFile(tokenPath, 'utf8'));
    assert.deepEqual(Object.keys(parsed).sort(), ['baseUrl', 'token', 'updatedAt']);
    assert.equal(parsed.baseUrl, 'http://127.0.0.1:4310');
    assert.equal(first.token, second.token);
    assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'private'))).mode & 0o777, 0o700);
  });

  it('rejects symlink token files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-research-token-link-'));
    const target = join(dir, 'target.json');
    const tokenPath = join(dir, 'fleet-bridge.json');
    await writeFile(target, JSON.stringify({ baseUrl: 'http://127.0.0.1:4310', token: TOKEN, updatedAt: new Date().toISOString() }), { mode: 0o600 });
    await symlink(target, tokenPath);
    await assert.rejects(() => ensureResearchBridgeToken(tokenPath), /must not be a symlink/);
  });
});
