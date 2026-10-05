import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';

const creator = { kind: 'pi', sessionId: 'pi-1' };
const successor = { kind: 'deepseek', sessionId: 'deepseek-1' };
const participants = [{ kind: 'claude', sessionId: 'claude-1' }, { kind: 'codex', sessionId: 'codex-1' }];

async function setup(t) {
  process.env.INTERNAL_BYPASS_TOKEN = 'pr-watch-test';
  let now = Date.now();
  let store;
  let poller;
  const commands = [];
  const calls = [];
  let pr = { state: 'open', merged: false, mergeable_state: 'clean', head: { sha: 'abcdef123' } };
  let reviews = [];
  const h = await createAgentBusHarness({ pollMs: 60000, beforeReady: async (app, dir) => {
    const { buildGithubAgentRepoStore } = await import('../modules/integrations/github-agents.mjs');
    const { githubAgentsPlugin } = await import('../modules/integrations/github-agents-plugin.mjs');
    store = buildGithubAgentRepoStore({ storeFile: join(dir, 'repos.json'), env: { APP_STATE_STORAGE: 'file' }, now: () => now });
    await store.upsertRepo({ owner: 'octo', repo: 'demo', authRef: 'TEST_GITHUB_TOKEN', prEnabled: false, issueEnabled: false });
    await githubAgentsPlugin(app, { repoStore: store, config: { enabled: false },
      enqueueSessionCommand: async (kind, sessionId, input) => commands.push({ kind, sessionId, ...input }) });
  } });
  t.after(async () => { await h.cleanup(); delete process.env.INTERNAL_BYPASS_TOKEN; });
  const { buildAgentBusMcpServer } = await import('../modules/agent-bus/mcp.mjs');
  const { buildInProcessFastifyRequest } = await import('../modules/agent-bus/in-process-mcp.mjs');
  const { buildInternalBypassHeaders } = await import('../modules/platform/auth.mjs');
  const { AGENT_BUS_AGENT_TOOL_SCOPES } = await import('../modules/agent-bus/mcp-auth.mjs');
  const requestImpl = buildInProcessFastifyRequest({ app: h.app, buildHeaders: () => buildInternalBypassHeaders({ authToken: h.authToken, bypassToken: 'pr-watch-test' }) });
  const mcp = buildAgentBusMcpServer({ requestImpl });
  const context = { authenticated: true, principal: { type: 'agent', ...creator }, toolScopes: [...AGENT_BUS_AGENT_TOOL_SCOPES], threadAllowlist: ['@member'] };
  const call = (name, args) => mcp.callTool(name, args, context);
  // Use the plugin's production notification/lifecycle wiring with an injected GitHub boundary.
  poller = h.app.githubAgents.poller;
  poller.config = { enabled: true, env: { TEST_GITHUB_TOKEN: 'test-only' } };
  poller.now = () => now;
  poller.fetchImpl = async (url) => {
    calls.push(url);
    return new Response(JSON.stringify(new URL(url).pathname.endsWith('/reviews') ? reviews : pr), { status: 200 });
  };
  const thread = await h.store.createThread({ title: 'PR room', participants, createdBy: creator });
  const watch = (number = 1, thread_id = thread.id) => call('watch_pr', { repo: 'octo/demo', number, ...(thread_id ? { thread_id } : {}) });
  return { h, store, call, requestImpl, poller, thread, watch, calls, commands,
    setPr: (patch) => { pr = { ...pr, ...patch }; }, setReviews: (value) => { reviews = value; }, advance: (ms) => { now += ms; } };
}

test('authenticated MCP/REST create, persist, update and remove watches', async (t) => {
  const s = await setup(t);
  await assert.rejects(s.call('watch_pr', { repo: 'missing/repo', number: 1 }), /not configured/);
  await assert.rejects(s.call('watch_pr', { repo: 'octo/demo', number: 0 }), /positive integer/);
  const result = await s.call('watch_pr', { repo: 'octo/demo', number: 1, creator: successor });
  assert.deepEqual(result.structuredContent.watch.creator, creator);
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

test('reviews and conflicts notify once, re-arm, ignore comments, and follow room transfer', async (t) => {
  const s = await setup(t);
  await s.watch();
  await s.poller.pollOnce();
  assert.equal(s.commands.length, 0);
  assert.equal(s.calls.length, 2);
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

test('merge ends room, preserves shared participants, reports counts and removes watch', async (t) => {
  const s = await setup(t);
  await s.h.store.createThread({ title: 'Shared', participants: [participants[1]], createdBy: creator });
  await s.h.store.createMessage({ threadId: s.thread.id, from: creator, targets: [participants[0]], body: 'queued' });
  await s.watch();
  s.setPr({ merged: true, state: 'closed', merge_commit_sha: '123456789' });
  await s.poller.pollOnce();
  await s.poller.pollOnce();
  assert.equal(s.h.store.getThread(s.thread.id).thread.status, 'closed');
  assert.deepEqual(s.h.deletedSessions.claude, ['claude-1']);
  assert.deepEqual(s.h.deletedSessions.codex, []);
  assert.equal(s.commands.length, 1);
  assert.equal(s.commands[0].sessionId, creator.sessionId);
  assert.equal(s.commands[0].text, `[PR_WATCH] PR octo/demo#1 merged (1234567) · ended room ${s.thread.id}: 1 sessions terminated`);
  assert.deepEqual(await s.store.listWatches(), []);
});

test('close leaves room open; no room owner falls back to creator; missing sessions drop', async (t) => {
  const s = await setup(t);
  const unowned = await s.h.store.createThread({ title: 'Unowned', participants });
  await s.watch(1, unowned.id);
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


test('merge still notifies and deletes watch when linked room is missing, closed, or a DM', async (t) => {
  const s = await setup(t);
  const dm = await s.h.store.createThread({ title: 'DM', participants, createdBy: creator, metadata: { dm: true } });
  await s.h.store.closeThread(s.thread.id);
  await s.watch(1, 'thr_missing');
  await s.watch(2, s.thread.id);
  await s.watch(3, dm.id);
  s.setPr({ merged: true, state: 'closed' });
  await s.poller.pollOnce();
  await s.poller.pollOnce();
  assert.equal(s.commands.length, 3);
  assert.match(s.commands[0].text, /#1 merged/);
  assert.match(s.commands[1].text, /#2 merged/);
  assert.match(s.commands[2].text, /not ended: 400$/);
  assert.equal(s.h.store.getThread(dm.id).thread.status, 'open');
  assert.deepEqual(s.h.deletedSessions.claude, []);
  assert.deepEqual(await s.store.listWatches(), []);
});

test('reviews advance one page per tick so reviews beyond the first 100 are seen', async (t) => {
  const s = await setup(t);
  await s.watch();
  const reviews = Array.from({ length: 101 }, (_, index) => ({ id: index + 1, state: 'COMMENTED', body: `Review ${index + 1}` }));
  const fetch = s.poller.fetchImpl;
  s.poller.fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith('/reviews')) return fetch(url);
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
  assert.equal(s.calls.length, 6);
});
