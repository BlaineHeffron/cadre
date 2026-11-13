import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';

const creator = { kind: 'pi', sessionId: 'pi-1' };
const successor = { kind: 'deepseek', sessionId: 'deepseek-1' };
const participants = [{ kind: 'claude', sessionId: 'claude-1' }, { kind: 'codex', sessionId: 'codex-1' }];

async function setup(t, config = { enabled: false }) {
  process.env.INTERNAL_BYPASS_TOKEN = 'pr-watch-test';
  let now = Date.now();
  let store;
  let poller;
  let preferencesFile;
  const commands = [];
  const calls = [];
  let pr = { state: 'open', merged: false, mergeable_state: 'clean', head: { sha: 'abcdef123' } };
  let reviews = [];
  let checks = { data: { repository: { object: { statusCheckRollup: null } } } };
  const h = await createAgentBusHarness({ pollMs: 60000, beforeReady: async (app, dir) => {
    const { buildGithubAgentRepoStore } = await import('../modules/integrations/github-agents.mjs');
    const { githubAgentsPlugin } = await import('../modules/integrations/github-agents-plugin.mjs');
    store = buildGithubAgentRepoStore({ storeFile: join(dir, 'repos.json'), env: { APP_STATE_STORAGE: 'file' }, now: () => now });
    await store.upsertRepo({ owner: 'octo', repo: 'demo', authRef: 'TEST_GITHUB_TOKEN', prEnabled: false, issueEnabled: false });
    preferencesFile = join(dir, 'agent-provider-preferences.json');
    await githubAgentsPlugin(app, { repoStore: store, config, preferences: { storeFile: preferencesFile },
      enqueueSessionCommand: async (kind, sessionId, input) => commands.push({ kind, sessionId, ...input }) });
  } });
  t.after(async () => { await h.cleanup(); delete process.env.INTERNAL_BYPASS_TOKEN; });
  const { buildAgentBusMcpServer } = await import('../modules/agent-bus/mcp.mjs');
  const { buildInProcessFastifyRequest } = await import('../modules/agent-bus/in-process-mcp.mjs');
  const { buildInternalBypassHeaders } = await import('../modules/platform/auth.mjs');
  const { AGENT_BUS_AGENT_TOOL_SCOPES } = await import('../modules/agent-bus/mcp-auth.mjs');
  const requestImpl = buildInProcessFastifyRequest({ app: h.app, buildHeaders: () => buildInternalBypassHeaders({ authToken: h.authToken, bypassToken: 'pr-watch-test' }) });
  const mcp = buildAgentBusMcpServer({ requestImpl });
  const context = (ref) => ({ authenticated: true, principal: { type: 'agent', ...ref }, toolScopes: [...AGENT_BUS_AGENT_TOOL_SCOPES], threadAllowlist: ['@member'] });
  const call = (name, args, ref = creator) => mcp.callTool(name, args, context(ref));
  // Use the plugin's production notification/lifecycle wiring with an injected GitHub boundary.
  poller = h.app.githubAgents.poller;
  poller.config = { enabled: true, env: { TEST_GITHUB_TOKEN: 'test-only' } };
  poller.now = () => now;
  poller.fetchImpl = async (url, init) => {
    calls.push(url);
    const path = new URL(url).pathname;
    if (path === '/graphql') {
      const { variables } = JSON.parse(init.body);
      assert.deepEqual(variables, { owner: 'octo', repo: 'demo', sha: pr.head.sha });
      return new Response(JSON.stringify(checks), { status: 200 });
    }
    return new Response(JSON.stringify(path.endsWith('/reviews') ? reviews : pr), { status: 200 });
  };
  const thread = await h.store.createThread({ title: 'PR room', participants, createdBy: creator });
  const watch = (number = 1, thread_id = thread.id) => call('watch_pr', { repo: 'octo/demo', number, ...(thread_id ? { thread_id } : {}) });
  return { h, store, preferencesFile, call, requestImpl, poller, thread, watch, calls, commands,
    setPr: (patch) => { pr = { ...pr, ...patch }; }, setReviews: (value) => { reviews = value; }, setChecks: (value) => { checks = value; }, advance: (ms) => { now += ms; } };
}

test('authenticated MCP/REST create, persist, update and remove watches', async (t) => {
  const s = await setup(t);
  await assert.rejects(s.call('watch_pr', { repo: 'missing/repo', number: 1 }), /not configured/);
  await assert.rejects(s.call('watch_pr', { repo: 'octo/demo', number: 0 }), /watch_pr: argument "number" must be >= 1/);
  await assert.rejects(s.call('watch_pr', { repo: 'octo/demo', number: 1, creator: successor }), /watch_pr: unknown argument "creator"/);
  const result = await s.call('watch_pr', { repo: 'octo/demo', number: 1 });
  assert.deepEqual(result.structuredContent, { repo: 'octo/demo', number: 1, status: 'watching' });
  assert.deepEqual((await s.store.listWatches())[0].creator, creator);
  await s.watch();
  assert.equal((await s.store.listWatches()).length, 1);
  await s.store.upsertRepo({ owner: 'octo', repo: 'demo', authRef: 'TEST_GITHUB_TOKEN', enabled: true, prEnabled: false, issueEnabled: false });
  const { buildGithubAgentRepoStore } = await import('../modules/integrations/github-agents.mjs');
  const reloaded = buildGithubAgentRepoStore({ storeFile: join(s.h.stateDir, 'repos.json'), env: { APP_STATE_STORAGE: 'file' } });
  assert.equal((await reloaded.listWatches()).length, 1);
  await reloaded.close();
  assert.equal((await s.requestImpl('/api/agents/github/watches')).watches.length, 1);
  await s.call('unwatch_pr', { repo: 'octo/demo', number: 1 });
  assert.deepEqual(await s.store.listWatches(), []);
  await assert.rejects(s.requestImpl('/api/agents/github/watches', { method: 'POST', body: { repo: 'octo/demo', number: 2, creator } }), /Authenticated agent/);
});

test('github_agent_status reports stored spawn keys, watch and reviewers without calling GitHub', async (t) => {
  const s = await setup(t);
  await s.watch(7);
  await s.store.updateRepo('octo/demo', { enabled: true, prEnabled: true, spawnedItemKeys: ['pr:7', 'pr:70', 'pr:7@bbb222', 'issue:7'] });
  await s.store.updateWatch('octo/demo', 7, { headSha: 'bbb222', lastReviewId: 3, mergeableState: 'clean' });
  const meta = (number, head) => ({ github_repo: 'octo/demo', github_kind: 'pr', github_number: number, ...(head ? { github_head_sha: head } : {}) });
  s.poller.listExistingSessions = async () => [
    { id: 'rev-old', backendType: 'codex', source: 'github-agent', created: 1, endedAt: 2, metadata: meta(7, 'aaa111') },
    { id: 'rev-new', backendType: 'codex', source: 'github-agent', created: 3, status: 'running', metadata: meta(7, 'bbb222') },
    { id: 'other-pr', backendType: 'codex', source: 'github-agent', created: 4, metadata: meta(70) },
    { id: 'manual', backendType: 'claude', source: 'dashboard', created: 5, metadata: meta(7) },
  ];
  const status = (await s.call('github_agent_status', { repo: 'octo/demo', pr: 7 })).structuredContent;
  assert.deepEqual(status, { repo: 'octo/demo', pr: 7, enabled: true, prEnabled: true, spawnKeys: ['pr:7', 'pr:7@bbb222'],
    watch: { headSha: 'bbb222', lastReviewId: 3, mergeableState: 'clean', creator },
    reviewers: [
      { id: 'rev-old', kind: 'codex', state: 'ended', created: 1, endedAt: 2, headSha: 'aaa111' },
      { id: 'rev-new', kind: 'codex', state: 'running', created: 3, endedAt: null, headSha: 'bbb222' },
    ] });
  assert.deepEqual((await s.call('github_agent_status', { repo: 'octo/demo', pr: 99 })).structuredContent,
    { repo: 'octo/demo', pr: 99, enabled: true, prEnabled: true, spawnKeys: [], watch: null, reviewers: [] });
  assert.equal(s.calls.length, 0);
});

test('authenticated operator can delete an agent watch linked to a room it does not own', async (t) => {
  const s = await setup(t);
  await s.watch();
  const result = await s.h.app.inject({ method: 'DELETE', url: '/api/agents/github/watches',
    headers: { authorization: `Bearer ${s.h.authToken}` }, payload: { repo: 'octo/demo', number: 1 } });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.json().watch.creator, creator);
  assert.deepEqual(await s.store.listWatches(), []);
});

test('pollRepo reviews a moved trusted head once, after the live reviewer ends, without touching lastSeen', async (t) => {
  const s = await setup(t);
  await s.watch();
  await s.store.upsertRepo({ owner: 'octo', repo: 'demo', authRef: 'TEST_GITHUB_TOKEN', enabled: true, prEnabled: true, issueEnabled: false });
  const launches = [];
  let sessions = [];
  let launch = async () => ({ sessionId: `sess_${launches.length}` });
  Object.assign(s.poller, {
    resolveScratchWorkDir: async () => '/tmp/github-agents-scratch',
    listExistingSessions: async () => sessions,
    sessionLauncher: async (input) => { launches.push(input.metadata.github_number); return launch(); },
  });
  s.poller.config.workDir = '/tmp/github-agents';
  const list = s.poller.fetchImpl;
  s.poller.fetchImpl = async (url, init) => (new URL(url).pathname.endsWith('/pulls') ? new Response(JSON.stringify([await (await list(`${url}/1`)).json()])) : list(url, init));
  const poll = async (lastSeenPrNumber = 5) => {
    await s.store.updateRepo('octo/demo', { lastSeenPrNumber });
    const result = await s.poller.pollRepo(await s.store.getRepo('octo/demo'));
    return { lastSeen: (await s.store.getRepo('octo/demo')).lastSeenPrNumber, head: (await s.store.listWatches())[0].headSha, result };
  };
  s.setPr({ number: 1, title: 'Fix', author_association: 'MEMBER' });
  assert.equal((await poll()).head, 'abcdef123');
  s.setPr({ head: { sha: 'bbb222' } });
  sessions = [{ id: 'old', source: 'dashboard', workDir: '/tmp/github-agents/worktrees/octo-demo/pr-1-abc/demo' }];
  assert.deepEqual([(await poll()).head, launches], ['abcdef123', []]);
  sessions = [];
  launch = async () => ({ sessionId: '' });
  assert.deepEqual(await poll().then(({ lastSeen, head }) => [lastSeen, head]), [5, 'abcdef123']);
  s.poller.spawnBackoff.clear();
  launch = async () => ({ sessionId: `sess_${launches.length}` });
  assert.deepEqual(await poll().then(({ lastSeen, head }) => [lastSeen, head]), [5, 'bbb222']);
  s.setReviews([{ id: 1, state: 'COMMENTED', commit_id: 'bbb222' }]);
  await poll();
  s.setPr({ head: { sha: 'ccc333' }, author_association: 'NONE' });
  await poll();
  assert.deepEqual(launches, [1, 1]);
  s.setPr({ head: { sha: 'ddd444' }, author_association: 'MEMBER' });
  assert.equal((await poll(0)).head, 'ddd444');
  s.setReviews([{ id: 2, state: 'COMMENTED', commit_id: 'ddd444' }]);
  await poll();
  assert.deepEqual(launches, [1, 1, 1]);
});

test('pollRepo ends an idle reviewer after a new review or a moved head, and only a moved head spawns', async (t) => {
  const s = await setup(t);
  await s.watch();
  await s.store.upsertRepo({ owner: 'octo', repo: 'demo', authRef: 'TEST_GITHUB_TOKEN', enabled: true, prEnabled: true, issueEnabled: false, lastSeenPrNumber: 5 });
  const launches = [];
  const deleted = [];
  let execution = 'unknown';
  const reviewer = { id: 'rev', source: 'github-agent', metadata: { github_repo: 'octo/demo', github_kind: 'pr', github_number: 1 } };
  let sessions = [reviewer];
  Object.assign(s.poller, {
    resolveScratchWorkDir: async () => '/tmp/github-agents-scratch',
    listExistingSessions: async () => sessions,
    getSession: async () => ({ canonicalState: { execution } }),
    deleteSession: async (session) => { deleted.push(session.id); sessions = []; },
    sessionLauncher: async (input) => { launches.push(input.metadata.github_number); return { sessionId: `sess_${launches.length}` }; },
  });
  const list = s.poller.fetchImpl;
  s.poller.fetchImpl = async (url, init) => (new URL(url).pathname.endsWith('/pulls') ? new Response(JSON.stringify([await (await list(`${url}/1`)).json()])) : list(url, init));
  const poll = async () => {
    await s.poller.pollRepo(await s.store.getRepo('octo/demo'));
    return [(await s.store.listWatches())[0].headSha, deleted.length, launches.length];
  };
  const review = (id) => s.setReviews([{ id, user: { login: 'bot' }, state: 'COMMENTED', body: 'VERDICT: OK' }]);
  s.setPr({ number: 1, title: 'Fix', author_association: 'MEMBER' });
  await poll();
  review(1);
  assert.deepEqual(await poll(), ['abcdef123', 0, 0]);
  execution = 'working';
  review(2);
  assert.deepEqual(await poll(), ['abcdef123', 0, 0]);
  execution = 'idle';
  review(3);
  assert.deepEqual(await poll(), ['abcdef123', 1, 0]);
  sessions = [reviewer];
  s.setPr({ head: { sha: 'bbb222' } });
  execution = 'working';
  assert.deepEqual(await poll(), ['abcdef123', 1, 0]);
  s.poller.getSession = null;
  assert.deepEqual(await poll(), ['abcdef123', 1, 0]);
  s.poller.getSession = async () => ({ canonicalState: { execution: 'idle' } });
  assert.deepEqual(await poll(), ['bbb222', 2, 1]);
  sessions = [{ ...reviewer, id: 'rev2' }];
  assert.deepEqual(await poll(), ['bbb222', 2, 1]);
});

test('reviews and conflicts notify once, re-arm, ignore comments, and follow room transfer', async (t) => {
  const s = await setup(t);
  await s.watch();
  await s.poller.pollOnce();
  assert.equal(s.commands.length, 0);
  assert.equal(s.calls.length, 3);
  s.setPr({ comments: 4, mergeable_state: 'dirty' });
  s.setReviews([{ id: 11, user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', body: 'intro\nVERDICT: BLOCKING 6 | NON-BLOCKING 1\n' + Array.from({ length: 7 }, (_, n) => `- [B] finding ${n}`).join('\n') }]);
  await s.poller.pollOnce();
  await s.poller.pollOnce();
  assert.equal(s.commands.length, 2);
  assert.match(s.commands[0].text, /^\[PR_WATCH\] PR octo\/demo#1 review by reviewer \(CHANGES_REQUESTED\): VERDICT:/);
  assert.equal(s.commands[0].text.split('\n').length, 6);
  assert.match(s.commands[1].text, /conflict/);
  await s.call('room_transfer', { thread_id: s.thread.id, to: { kind: successor.kind, session_id: successor.sessionId } });
  s.setPr({ mergeable_state: 'clean' });
  await s.poller.pollOnce();
  s.setPr({ mergeable_state: 'dirty' });
  s.setReviews([{ id: 12, user: { login: 'other' }, state: 'COMMENTED', body: '\n' + 'x'.repeat(250) + '\nignored' }]);
  await s.poller.pollOnce();
  assert.equal(s.commands.length, 4);
  assert.equal(s.commands[2].text.split(': ')[1].length, 200);
  assert.equal(s.commands[2].sessionId, successor.sessionId);
  assert.equal(s.commands[3].sessionId, successor.sessionId);
  s.setPr({ comments: 9 });
  await s.poller.pollOnce();
  assert.equal(s.commands.length, 4);
});

// GraphQL statusCheckRollup shape: check runs carry status/conclusion, commit statuses carry state.
const rollup = (...nodes) => ({ data: { repository: { object: { statusCheckRollup: { contexts: { nodes } } } } } });
const run = (name, status, conclusion = null, extra = {}) => ({ name, status, conclusion, detailsUrl: `https://ci.example/${name}`, title: null, summary: null, ...extra });
const status = (context, state) => ({ context, state, targetUrl: `https://ci.example/${context}`, description: `${context} ${state.toLowerCase()}` });

test('failed head checks notify once per head with names, links and summaries; pending and passing stay silent', async (t) => {
  const s = await setup(t);
  await s.watch();
  const texts = () => s.commands.map((item) => item.text);
  const rollupCalls = () => s.calls.filter((url) => url.endsWith('/graphql')).length;
  s.setChecks(rollup(run('test', 'IN_PROGRESS'), run('lint', 'COMPLETED', 'FAILURE'), status('deploy', 'PENDING')));
  await s.poller.pollOnce();
  assert.deepEqual(texts(), [], 'pending checks wait until every check is final');
  s.setChecks(rollup(run('test', 'COMPLETED', 'TIMED_OUT', { title: 'Tests  timed out', summary: `${'x'.repeat(400)}\n` }), run('lint', 'COMPLETED', 'FAILURE'),
    run('build', 'COMPLETED', 'SUCCESS'), status('deploy', 'ERROR')));
  await s.poller.pollOnce();
  assert.deepEqual(texts(), [`[PR_WATCH] PR octo/demo#1 checks failed on head abcdef123
CI failed on your PR head: fix it, push, and keep watching.
- test (timed_out) https://ci.example/test Tests timed out: ${'x'.repeat(283)}
- lint (failure) https://ci.example/lint
- deploy (error) https://ci.example/deploy deploy error`]);
  const callsAfterFailure = rollupCalls();
  await s.poller.pollOnce();
  assert.equal(texts().length, 1, 'a repeated poll does not notify again');
  assert.equal(rollupCalls(), callsAfterFailure, 'a notified head is not re-fetched');

  s.setPr({ head: { sha: 'bbb222' } });
  s.setChecks(rollup(run('test', 'COMPLETED', 'CANCELLED')));
  await s.poller.pollOnce();
  await s.poller.pollOnce();
  assert.equal(texts().length, 2, 'a new head with a failure notifies again');
  assert.match(texts()[1], /checks failed on head bbb222\n.*\n- test \(cancelled\) https:\/\/ci\.example\/test$/);

  s.setPr({ head: { sha: 'ccc333' } });
  s.setChecks(rollup(run('test', 'QUEUED')));
  await s.poller.pollOnce();
  s.setChecks(rollup(run('test', 'COMPLETED', 'SUCCESS'), status('deploy', 'SUCCESS')));
  await s.poller.pollOnce();
  assert.equal(texts().length, 2, 'checks passing after a failure send nothing');

  const { buildGithubAgentRepoStore } = await import('../modules/integrations/github-agents.mjs');
  const reloaded = buildGithubAgentRepoStore({ storeFile: join(s.h.stateDir, 'repos.json'), env: { APP_STATE_STORAGE: 'file' } });
  assert.equal((await reloaded.listWatches())[0].ciNotified, 'bbb222:test', 'the notified key persists across restarts');
  await reloaded.close();
});

test('merge notifies the room owner, leaves the room open and removes the watch', async (t) => {
  const s = await setup(t);
  await s.watch();
  s.setPr({ merged: true, state: 'closed', merge_commit_sha: '123456789' });
  await s.poller.pollOnce();
  await s.poller.pollOnce();
  assert.equal(s.h.store.getThread(s.thread.id).thread.status, 'open');
  assert.deepEqual(s.h.deletedSessions.claude, []);
  assert.deepEqual(s.commands.map((item) => [item.sessionId, item.text]), [[creator.sessionId, '[PR_WATCH] PR octo/demo#1 merged (1234567)']]);
  assert.deepEqual(await s.store.listWatches(), []);
});

test('merge records a durable session ledger entry with journal and hook rollups; missing data is null', async (t) => {
  const s = await setup(t);
  const { FileJournalStore } = await import('../modules/sessions/journal-store.mjs');
  const { registerProtocolSessionProvider } = await import('../modules/sessions/protocol-session-registry.mjs');
  const { buildHookSessionPaths, registerHookSessionRegistry } = await import('../modules/agent/hook-events.mjs');
  const journal = new FileJournalStore({ rootDir: join(s.h.stateDir, 'journal'), fsync: 'never' });
  await journal.init();
  const transport = (event, disposition = 'applied') => journal.append('stream-1', { type: 'transport.event', data: { disposition, event } });
  await journal.append('stream-1', { type: 'turn.created', data: { turnId: 't1' } });
  await transport({ type: 'usage', turnId: 't1', inputTokens: 9, outputTokens: 9, cacheReadTokens: 9, cacheWriteTokens: 9, costUsd: 0 });
  await transport({ type: 'usage', turnId: 't1', inputTokens: 10, outputTokens: 20, cacheReadTokens: 100, cacheWriteTokens: 5, costUsd: 0.5 });
  await transport({ type: 'tool.call', turnId: 't1', toolCallId: 'a' });
  await transport({ type: 'tool.update', turnId: 't1', toolCallId: 'a', status: 'failed' });
  await transport({ type: 'tool.update', turnId: 't1', toolCallId: 'b', status: 'failed' }, 'stale');
  await journal.append('stream-1', { type: 'turn.created', data: { turnId: 't2' } });
  await transport({ type: 'tool.call', turnId: 't2', toolCallId: 'c' });
  await transport({ type: 'tool.update', turnId: 't2', toolCallId: 'c', status: 'completed' });
  await transport({ type: 'usage', turnId: 't2', inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.75 });
  t.after(registerProtocolSessionProvider('claude', { service: { journal } }));
  const workDir = join(s.h.stateDir, 'tmux-work');
  t.after(registerHookSessionRegistry('codex', () => new Map([['tmux-1', { workDir }]])));
  const { eventsPath } = await buildHookSessionPaths({ workDir, provider: 'codex', sessionId: 'tmux-1' });
  await mkdir(dirname(eventsPath), { recursive: true });
  await writeFile(eventsPath, [
    { eventName: 'UserPromptSubmit', transcriptPath: '/transcripts/tmux-1.jsonl', payload: {} },
    { eventName: 'PreToolUse', payload: { tool_use_id: 'x' } },
    { eventName: 'PostToolUse', payload: { tool_use_id: 'x' } },
    { eventName: 'PreToolUse', payload: { tool_use_id: 'y' } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\nnot json\n');
  await s.call('watch_pr', { repo: 'octo/demo', number: 1 }, { kind: 'claude', sessionId: 'stream-1' });
  await s.call('watch_pr', { repo: 'octo/demo', number: 2 }, { kind: 'codex', sessionId: 'tmux-1' });
  await s.watch(3);
  s.setPr({ merged: true, state: 'closed', merge_commit_sha: 'merge123', merged_at: '2026-11-08T00:00:00Z' });
  await s.poller.pollOnce();
  const nulls = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, turns: null, toolCalls: null, failedToolCalls: null, transcriptPath: null };
  const entry = (number, creatorRef, rollup) => ({ repo: 'octo/demo', number, mergeSha: 'merge123', headSha: 'abcdef123',
    sessionId: creatorRef.sessionId, kind: creatorRef.kind, thread_id: number === 3 ? s.thread.id : null, mergedAt: '2026-11-08T00:00:00Z', rollup });
  const expected = [
    entry(3, creator, nulls),
    entry(2, { kind: 'codex', sessionId: 'tmux-1' }, { ...nulls, turns: 1, toolCalls: 2, failedToolCalls: 1, transcriptPath: '/transcripts/tmux-1.jsonl' }),
    entry(1, { kind: 'claude', sessionId: 'stream-1' }, { ...nulls, inputTokens: 11, outputTokens: 22, cacheReadTokens: 103, cacheWriteTokens: 9, costUsd: 0.75, turns: 2, toolCalls: 2, failedToolCalls: 1 }),
  ];
  assert.deepEqual(await s.store.listWatches(), []);
  assert.deepEqual((await s.requestImpl('/api/agents/github/ledger')).entries, expected);
  assert.deepEqual((await s.requestImpl('/api/agents/github/ledger?limit=1')).entries, expected.slice(0, 1));
  const { buildGithubAgentRepoStore } = await import('../modules/integrations/github-agents.mjs');
  const reloaded = buildGithubAgentRepoStore({ storeFile: join(s.h.stateDir, 'repos.json'), env: { APP_STATE_STORAGE: 'file' } });
  assert.deepEqual(await reloaded.listLedger(), expected);
  await reloaded.close();
});

// saved: Settings values in the preferences store; config: the env defaults they override.
async function gradingSetup(t, env, saved = { graderSampleRate: 1 }, config = {}) {
  const s = await setup(t, { enabled: false, graderModel: 'claude-sonnet-5-5', ...config });
  const { updateAgentProviderPreferences } = await import('../modules/agent/provider-preferences.mjs');
  await updateAgentProviderPreferences(saved, { storeFile: s.preferencesFile });
  const { buildHookSessionPaths, registerHookSessionRegistry } = await import('../modules/agent/hook-events.mjs');
  const workDir = join(s.h.stateDir, 'tmux-work');
  t.after(registerHookSessionRegistry('codex', () => new Map(['tmux-1', 'tmux-2'].map((id) => [id, { workDir }]))));
  for (const sessionId of ['tmux-1', 'tmux-2']) {
    const { eventsPath } = await buildHookSessionPaths({ workDir, provider: 'codex', sessionId });
    await mkdir(dirname(eventsPath), { recursive: true });
    await writeFile(eventsPath, JSON.stringify({ eventName: 'UserPromptSubmit', transcriptPath: `/transcripts/${sessionId}.jsonl`, payload: {} }));
  }
  const spawns = [];
  const statuses = new Map();
  const terminated = [];
  s.poller.config = { ...s.poller.config, workDir: s.h.stateDir, repoPaths: { 'octo/demo': '/operator/checkout/demo' }, env: { ...s.poller.config.env, ...env } };
  s.poller.grading = { ...s.poller.grading, terminate: (task) => terminated.push(task.taskId), tasks: () => ({
    spawn: async (parentTaskId, taskKey, spec) => {
      spawns.push({ parentTaskId, taskKey, spec });
      statuses.set(`task-${spawns.length}`, { state: 'working', result: null });
      return { taskId: `task-${spawns.length}`, sessionId: `grader-${spawns.length}` };
    },
    status: async (taskId) => ({ taskId, ...statuses.get(taskId) }),
  }) };
  return { s, spawns, statuses, terminated };
}

test('merged sessions with a transcript get one grader task whose JSON grade lands on the ledger entry', async (t) => {
  const { s, spawns, statuses, terminated } = await gradingSetup(t, { CADRE_ALLOW_SIDE_EFFECTS: '1' }, { graderSampleRate: 1, graderModel: 'claude-haiku-5-5' });
  await s.call('watch_pr', { repo: 'octo/demo', number: 1 }, { kind: 'codex', sessionId: 'tmux-1' });
  await s.call('watch_pr', { repo: 'octo/demo', number: 2 }, { kind: 'codex', sessionId: 'tmux-2' });
  await s.watch(3);
  s.setPr({ merged: true, state: 'closed', merge_commit_sha: 'merge123', merged_at: '2026-11-08T00:00:00Z' });
  await s.poller.pollOnce();

  assert.deepEqual(spawns.map((item) => item.taskKey), ['grade:octo/demo#1', 'grade:octo/demo#2'], 'PR 3 has no transcript');
  const { spec } = spawns[0];
  assert.equal(spawns[0].parentTaskId, null);
  assert.equal(spec.provider, 'claude');
  assert.equal(spec.model, 'claude-haiku-5-5', 'the model saved in Settings overrides the env default');
  assert.match(spec.workDir, /scratch\/octo-demo\/grade-1-/);
  assert.ok(spawns.every((item) => !item.spec.workDir.startsWith('/operator/checkout')), 'never the configured clone');
  assert.match(spec.initialPrompt, /contents\/AGENTS\.md\?ref=/);
  assert.match(spec.initialPrompt, /# Session Grade/);
  assert.match(spec.initialPrompt, /Transcript: \/transcripts\/tmux-1\.jsonl/);
  assert.match(spec.initialPrompt, /gh pr diff 1 -R octo\/demo/);
  const ledger = async () => Object.fromEntries((await s.store.listLedger()).map((entry) => [entry.number, entry]));
  assert.equal((await ledger())[1].gradeTaskId, 'task-1');
  assert.equal((await ledger())[1].graderModel, 'claude-haiku-5-5');
  assert.equal((await ledger())[3].gradeTaskId, undefined);

  await s.poller.pollOnce();
  assert.equal((await ledger())[1].gradedAt, undefined, 'a working grader leaves the entry pending');

  const grade = { session: '/transcripts/tmux-1.jsonl', pr: 1, scores: { efficiency: { score: 0.5, pass: false, reason: 'retries', evidence: ['tool call 3'] } } };
  const done = (text) => ({ state: 'completed', result: { state: 'completed', output: [{ type: 'message.committed', blocks: [{ type: 'text', text }] }] } });
  statuses.set('task-1', done(`Graded.\n\`\`\`json\n${JSON.stringify(grade)}\n\`\`\``));
  statuses.set('task-2', done('I could not finish the grade.'));
  await s.poller.pollOnce();
  const graded = await ledger();
  assert.deepEqual(graded[1].grade, grade);
  assert.ok(graded[1].gradedAt);
  assert.equal(graded[2].grade, null);
  assert.match(graded[2].gradeError, /malformed grade: no fenced json/);
  assert.deepEqual(terminated.sort(), ['task-1', 'task-2']);

  await s.poller.pollOnce();
  assert.equal(spawns.length, 2, 'graded and malformed entries are never retried');
  const trend = await s.requestImpl('/api/agents/github/ledger/trend');
  assert.deepEqual(trend.days, [{ day: '2026-11-08', rubrics: { efficiency: { count: 1, passRate: 0, meanScore: 0.5 } } }]);
});

for (const [name, env, saved, config] of [
  ['side-effect loops are suppressed', { PORT: '4511' }, { graderSampleRate: 1 }],
  ['no sample rate is configured', { CADRE_ALLOW_SIDE_EFFECTS: '1' }, {}],
  ['Settings saves a rate of 0 over an env rate of 1', { CADRE_ALLOW_SIDE_EFFECTS: '1' }, { graderSampleRate: 0 }, { graderSampleRate: 1 }],
]) {
  test(`merged sessions are not graded while ${name}`, async (t) => {
    const { s, spawns } = await gradingSetup(t, env, saved, config);
    await s.call('watch_pr', { repo: 'octo/demo', number: 1 }, { kind: 'codex', sessionId: 'tmux-1' });
    s.setPr({ merged: true, state: 'closed', merge_commit_sha: 'merge123', merged_at: '2026-11-08T00:00:00Z' });
    await s.poller.pollOnce();
    assert.equal(spawns.length, 0);
    assert.equal((await s.store.listLedger())[0].gradeTaskId, undefined);
  });
}

test('close leaves room open; no room owner falls back to creator; missing sessions drop', async (t) => {
  const s = await setup(t);
  const unowned = await s.h.store.createThread({ title: 'Unowned', participants, createdBy: creator });
  await s.watch(1, unowned.id);
  await s.h.store.transferThread(unowned.id, { kind: 'user', sessionId: 'operator' });
  s.setPr({ state: 'closed' });
  await s.poller.pollOnce();
  await s.poller.pollOnce();
  assert.equal(s.commands.length, 1);
  assert.equal(s.commands[0].sessionId, creator.sessionId);
  assert.match(s.commands[0].text, /closed without merge$/);
  assert.equal(s.h.store.getThread(unowned.id).thread.status, 'open');
  await s.watch(2, null);
  s.h.sessionCatalog.pi.delete(creator.sessionId);
  await s.poller.pollOnce();
  assert.equal(s.commands.length, 1);
  assert.deepEqual(await s.store.listWatches(), []);
});

test('seven day expiry sends once without fetch; disabled and suppressed ticks leave watches alone', async (t) => {
  const s = await setup(t);
  await s.watch();
  await s.poller.pollOnce({ suppressSpawn: true });
  assert.deepEqual(s.calls, []);
  s.poller.config.enabled = false;
  await s.poller.pollOnce();
  assert.deepEqual(s.calls, []);
  s.advance(7 * 24 * 60 * 60 * 1000);
  s.poller.config.enabled = true;
  await s.poller.pollOnce();
  await s.poller.pollOnce();
  assert.deepEqual(s.calls, []);
  assert.equal(s.commands.length, 1);
  assert.match(s.commands[0].text, /watch expired after 7 days$/);
  assert.deepEqual(await s.store.listWatches(), []);
});

test('one watch fetch error does not abort other watches', async (t) => {
  const s = await setup(t);
  await s.watch();
  await s.watch(2);
  const fetch = s.poller.fetchImpl;
  s.poller.fetchImpl = (url) => url.endsWith('/1') ? Promise.reject(new Error('offline')) : fetch(url);
  s.setPr({ state: 'closed' });
  await s.poller.pollOnce();
  assert.equal(s.commands.length, 1);
  assert.match(s.commands[0].text, /#2 closed/);
  assert.equal((await s.store.listWatches())[0].number, 1);
});


test('merge notifies and deletes watch when linked room is missing, closed, or a DM', async (t) => {
  const s = await setup(t);
  const dm = await s.h.store.createThread({ title: 'DM', participants, createdBy: creator });
  const missing = await s.h.store.createThread({ title: 'Deleted later', participants, createdBy: creator });
  await s.h.store.closeThread(s.thread.id);
  await s.watch(1, missing.id);
  await s.h.store.deleteThread(missing.id);
  await s.watch(2, s.thread.id);
  await s.watch(3, dm.id);
  await s.h.store.updateThreadMetadata(dm.id, { dm: true });
  s.setPr({ merged: true, state: 'closed' });
  await s.poller.pollOnce();
  await s.poller.pollOnce();
  assert.equal(s.commands.length, 3);
  assert.match(s.commands[0].text, /#1 merged/);
  assert.match(s.commands[1].text, /#2 merged/);
  assert.match(s.commands[2].text, /#3 merged/);
  assert.equal(s.h.store.getThread(dm.id).thread.status, 'open');
  assert.deepEqual(s.h.deletedSessions.claude, []);
  assert.deepEqual(await s.store.listWatches(), []);
});

test('reviews advance one page per tick so reviews beyond the first 100 are seen', async (t) => {
  const s = await setup(t);
  await s.watch();
  const reviews = Array.from({ length: 101 }, (_, index) => ({ id: index + 1, state: 'COMMENTED', body: `Review ${index + 1}` }));
  const fetch = s.poller.fetchImpl;
  s.poller.fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith('/reviews')) return fetch(url, init);
    s.calls.push(url);
    assert.equal(parsed.searchParams.get('per_page'), '100');
    const page = Number(parsed.searchParams.get('page'));
    return new Response(JSON.stringify(reviews.slice((page - 1) * 100, page * 100)), { status: 200 });
  };
  await s.poller.pollOnce();
  assert.equal(s.commands.length, 100);
  await s.poller.pollOnce();
  await s.poller.pollOnce();
  assert.equal(s.commands.length, 101);
  assert.match(s.commands[100].text, /Review 101$/);
  assert.equal(s.calls.length, 9);
});


test('watch linking, rewatching and removal require creator or current room ownership', async (t) => {
  const s = await setup(t);
  const args = { repo: 'octo/demo', number: 1, thread_id: s.thread.id };
  await assert.rejects(s.call('watch_pr', args, successor), (error) => error.statusCode === 403);
  await assert.rejects(s.call('watch_pr', { ...args, thread_id: 'thr_missing' }), (error) => error.statusCode === 404);
  const dm = await s.h.store.createThread({ title: 'DM', participants, createdBy: creator, metadata: { dm: true } });
  await assert.rejects(s.call('watch_pr', { ...args, thread_id: dm.id }), (error) => error.statusCode === 403);
  await s.watch();
  await s.store.updateWatch('octo/demo', 1, { lastReviewId: 42 });
  const original = (await s.store.listWatches())[0];
  await assert.rejects(s.call('watch_pr', { repo: 'octo/demo', number: 1 }, successor), (error) => error.statusCode === 403);
  await assert.rejects(s.call('unwatch_pr', { repo: 'octo/demo', number: 1 }, successor), (error) => error.statusCode === 403);
  assert.deepEqual((await s.store.listWatches())[0], original);
  await s.call('room_transfer', { thread_id: s.thread.id, to: { kind: successor.kind, session_id: successor.sessionId } });
  s.advance(1000);
  await s.call('watch_pr', args, successor);
  const updated = (await s.store.listWatches())[0];
  assert.deepEqual(updated.creator, creator);
  assert.equal(updated.createdAtMs, original.createdAtMs);
  assert.equal(updated.lastReviewId, 42);
  await s.call('unwatch_pr', { repo: 'octo/demo', number: 1 }, successor);
  assert.deepEqual(await s.store.listWatches(), []);
  await s.watch(2, null);
  await s.requestImpl('/api/agents/github/watches', { method: 'DELETE', body: { repo: 'octo/demo', number: 2 } });
  assert.deepEqual(await s.store.listWatches(), []);
});
