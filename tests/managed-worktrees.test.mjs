import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile, readFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { exec } from '../lib/exec.mjs';
import { createManagedWorktree, cleanupManagedWorktree, sweepManagedWorktrees, linkManagedWorktreePr } from '../modules/agent-bus/managed-worktrees.mjs';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';
import { GithubAgentPoller } from '../modules/integrations/github-agents.mjs';

async function git(path, ...args) {
  const result = await exec('git', ['-C', path, ...args], { env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}
async function fixture(t, setup = '', config = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'cadre-managed-'));
  // Runs before later-registered harness cleanup, which may still be writing hook state under the repo.
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const repo = resolve(root, 'repo'), remote = resolve(root, 'remote'), baseDir = resolve(root, 'managed');
  await mkdir(repo); await mkdir(remote);
  await git(remote, 'init', '--bare', '--initial-branch=main');
  await git(repo, 'init', '--initial-branch=main');
  await git(repo, 'config', 'user.name', 'Test'); await git(repo, 'config', 'user.email', 'test@example.invalid');
  await mkdir(resolve(repo, '.cadre'));
  await writeFile(resolve(repo, '.cadre/worktree.json'), JSON.stringify({ cleanup: 'on-merge', setup, ...config }));
  await writeFile(resolve(repo, '.gitignore'), 'node_modules/\ncache/\ndist/\nart/\n');
  await writeFile(resolve(repo, 'file'), 'base\n');
  await git(repo, 'add', '.'); await git(repo, 'commit', '-m', 'base');
  await git(repo, 'remote', 'add', 'origin', remote); await git(repo, 'push', '-u', 'origin', 'main');
  const metadata = await createManagedWorktree({ repo, branch: 'topic', base: 'origin/main', roomId: 'thr_test', baseDir });
  await writeFile(resolve(metadata.path, 'file'), 'changed\n');
  await git(metadata.path, 'commit', '-am', 'change');
  const head = await git(metadata.path, 'rev-parse', 'HEAD');
  await git(repo, 'push', 'origin', `${head}:refs/pull/1/head`);
  let pr = { merged: true, number: 1, head: { sha: head } };
  const poller = new GithubAgentPoller({ repoStore: { getRepo: async () => ({ owner: 'test', repo: 'repo' }) },
    config: { env: {} }, fetchImpl: async () => ({ ok: true, status: 200, json: async () => pr }) });
  await linkManagedWorktreePr(metadata, { repo: 'test/repo', number: 1 });
  metadata.pr = { repo: 'test/repo', number: 1 };
  const options = { baseDir, getPr: (value) => poller.getWorktreePr(value) };
  return { root, repo, metadata, head, options, setPr: (value) => { pr = value; } };
}
async function pushConfig(f, text) {
  if (text === undefined) await git(f.repo, 'rm', '-q', '--cached', '.cadre/worktree.json');
  else { await writeFile(resolve(f.repo, '.cadre/worktree.json'), text); await git(f.repo, 'add', '.cadre/worktree.json'); }
  await git(f.repo, 'commit', '-m', 'config'); await git(f.repo, 'push', 'origin', 'main');
}
const exists = async (path) => !!await stat(path).catch(() => null);

for (const [name, change, reason] of [
  ['dirty', async (f) => writeFile(resolve(f.metadata.path, 'file'), 'dirty'), 'dirty or untracked files'],
  ['untracked with hidden user configuration', async (f) => { await git(f.repo, 'config', 'status.showUntrackedFiles', 'no'); await writeFile(resolve(f.metadata.path, 'untracked'), 'data'); }, 'dirty or untracked files'],
  ['unpushed', async (f) => { await writeFile(resolve(f.metadata.path, 'file'), 'extra'); await git(f.metadata.path, 'commit', '-am', 'extra'); }, 'unpushed commits not in PR'],
  ['not merged', async (f) => f.setPr({ merged: false, number: 1, head: { sha: f.head } }), 'PR not merged'],
  ['untracked .agent_bus notes', async (f) => { await mkdir(resolve(f.metadata.path, '.agent_bus/hooks'), { recursive: true }); await writeFile(resolve(f.metadata.path, '.agent_bus/notes'), 'precious'); }, 'dirty or untracked files'],
  ['new ignored', async (f) => { await mkdir(resolve(f.metadata.path, 'cache')); await writeFile(resolve(f.metadata.path, 'cache/new'), 'data'); }, 'new ignored files'],
  ['shared room', async (f) => { f.options.rooms = [{ id: 'other', status: 'open', metadata: { worktree: { path: resolve(f.metadata.path, 'subdir') } } }]; }, 'shared with another room or live session'],
  ['interrupted session', async (f) => { f.options.sessions = [{ lifecycle: 'interrupted', workDir: f.metadata.path }]; }, 'shared with another room or live session'],
  ['shared session', async (f) => { f.options.sessions = [{ workDir: resolve(f.metadata.path, 'subdir') }]; }, 'shared with another room or live session'],
  ['missing PR head', async (f) => f.setPr({ merged: true, number: 1 }), 'PR not merged'],
  ['GitHub failure', async (f) => { f.options.getPr = async () => { throw new Error('GitHub unavailable'); }; }, 'GitHub unavailable'],
  ['branch changed', async (f) => git(f.metadata.path, 'checkout', '-q', '-b', 'next'), 'branch changed from topic to next'],
  ['marker missing', async (f) => rm(resolve(f.metadata.path, await git(f.metadata.path, 'rev-parse', '--git-dir'), 'cadre-room.json')), 'marker missing'],
  ['marker mismatch', async (f) => { f.metadata = { ...f.metadata, baseHead: f.head }; }, 'marker mismatch: baseHead'],
  ['metadata outside base', async (f) => { f.options.baseDir = resolve(f.root, 'elsewhere'); }, 'path outside managed base'],
]) test(`managed worktree keeps ${name}`, async (t) => {
  const f = await fixture(t); await change(f);
  const result = await cleanupManagedWorktree(f.metadata, f.options);
  assert.equal(result.reason, reason); assert.equal(result.removed, false);
  assert.equal(await exists(f.metadata.path), true);
  assert.equal(await git(f.repo, 'rev-parse', 'topic'), await git(f.metadata.path, 'rev-parse', 'HEAD'));
});

test('merged and clean removes worktree and branch', async (t) => {
  const f = await fixture(t);
  await git(f.repo, 'merge', '--ff-only', 'topic');
  const result = await cleanupManagedWorktree(f.metadata, f.options);
  assert.equal(result.removed, true); assert.equal(result.branchKept, false);
  assert.equal(await exists(f.metadata.path), false);
  assert.equal((await exec('git', ['-C', f.repo, 'show-ref', '--verify', 'refs/heads/topic'])).code, 128);
});

test('patch-id containment removes worktree but retains unmerged branch tip', async (t) => {
  const f = await fixture(t);
  await git(f.repo, 'merge', '--squash', 'topic'); await git(f.repo, 'commit', '-m', 'squashed');
  const squash = await git(f.repo, 'rev-parse', 'HEAD');
  await git(f.repo, 'push', 'origin', `+${squash}:refs/pull/1/head`);
  f.setPr({ merged: true, number: 1, head: { sha: squash } });
  const result = await cleanupManagedWorktree(f.metadata, f.options);
  assert.equal(result.removed, true); assert.equal(result.branchKept, true);
  assert.match(result.report, /branch kept/); assert.equal(await exists(f.metadata.path), false);
  assert.equal(await git(f.repo, 'rev-parse', 'topic'), f.head);
});

test('baseline external node_modules symlink is unlinked without touching target', async (t) => {
  const f = await fixture(t, 'mkdir -p "$CADRE_REPO_ROOT/../shared"; ln -s "$CADRE_REPO_ROOT/../shared" node_modules');
  const target = resolve(f.root, 'shared'); await writeFile(resolve(target, 'precious'), 'keep');
  // The baseline was recorded while the link was dangling; git still lists the ignored symlink.
  assert.ok(f.metadata.ignoredBaseline.includes('node_modules'));
  await git(f.repo, 'merge', '--ff-only', 'topic');
  const result = await cleanupManagedWorktree(f.metadata, f.options);
  assert.equal(result.removed, true); assert.equal(await exists(f.metadata.path), false);
  assert.equal(await readFile(resolve(target, 'precious'), 'utf8'), 'keep');
});

test('cleanup uses the base ref policy recorded at creation, not the local checkout', async (t) => {
  const f = await fixture(t); await git(f.repo, 'merge', '--ff-only', 'topic');
  assert.equal(f.metadata.cleanup, 'on-merge');
  await rm(resolve(f.repo, '.cadre'), { recursive: true });
  assert.equal((await cleanupManagedWorktree(f.metadata, f.options)).removed, true);
  assert.equal(await exists(f.metadata.path), false);
});

test('base ref cleanup off keeps the worktree despite local on-merge config', async (t) => {
  const f = await fixture(t); await pushConfig(f, JSON.stringify({ cleanup: 'off' }));
  await writeFile(resolve(f.repo, '.cadre/worktree.json'), JSON.stringify({ cleanup: 'on-merge' }));
  const metadata = await createManagedWorktree({ repo: f.repo, branch: 'off', roomId: 'thr_off', baseDir: f.options.baseDir });
  assert.equal(metadata.cleanup, 'off');
  assert.equal((await cleanupManagedWorktree(metadata, f.options)).reason, 'cleanup off');
  assert.equal(await exists(metadata.path), true);
});

test('legacy metadata without a recorded cleanup policy is kept', async (t) => {
  const f = await fixture(t); await git(f.repo, 'merge', '--ff-only', 'topic');
  const { cleanup, ...legacy } = f.metadata;
  const marker = resolve(f.repo, '.git/worktrees/repo/cadre-room.json');
  const { cleanup: recorded, ...legacyMarker } = JSON.parse(await readFile(marker, 'utf8'));
  assert.equal(cleanup, recorded);
  await writeFile(marker, JSON.stringify(legacyMarker));
  assert.equal((await cleanupManagedWorktree(legacy, f.options)).reason, 'cleanup policy not recorded');
  assert.equal(await exists(f.metadata.path), true);
});

test('setup failure removes fresh worktree and branch', async (t) => {
  const f = await fixture(t);
  await pushConfig(f, JSON.stringify({ setup: 'touch leftover; exit 1' }));
  await assert.rejects(createManagedWorktree({ repo: f.repo, branch: 'failed', base: 'origin/main', roomId: 'thr_failed', baseDir: f.options.baseDir }), /setup failed/);
  assert.equal(await exists(resolve(f.options.baseDir, 'thr_failed/repo')), false);
  assert.equal((await exec('git', ['-C', f.repo, 'show-ref', '--verify', 'refs/heads/failed'])).code, 128);
});

test('config only in the local checkout rejects the worktree request', async (t) => {
  const f = await fixture(t); await pushConfig(f);
  await assert.rejects(createManagedWorktree({ repo: f.repo, branch: 'unused', roomId: 'thr_none', baseDir: f.options.baseDir }), /no \.cadre\/worktree\.json at origin\/main/);
  assert.equal(await exists(resolve(f.options.baseDir, 'thr_none')), false);
});

test('orphan sweep only removes marked closed-room worktrees', async (t) => {
  const f = await fixture(t); await git(f.repo, 'merge', '--ff-only', 'topic');
  const unmanaged = resolve(f.options.baseDir, 'thr_unmanaged/repo');
  await mkdir(resolve(f.options.baseDir, 'thr_unmanaged'));
  await git(f.repo, 'worktree', 'add', '-b', 'unmanaged', unmanaged);
  const sweep = (status) => sweepManagedWorktrees({ baseDir: f.options.baseDir, getRoom: () => ({ status, metadata: { worktree: f.metadata } }),
    cleanup: (metadata) => cleanupManagedWorktree(metadata, f.options) });
  await sweep('open'); assert.equal(await exists(f.metadata.path), true);
  await sweep('closed'); assert.equal(await exists(f.metadata.path), false);
  assert.equal(await exists(unmanaged), true);
});

for (const mode of ['managed', 'stale local config', 'setup failure', 'launch failure', 'no config (local only)']) test(`bootstrap ${mode} with real git`, async (t) => {
  const f = await fixture(t);
  const h = await createAgentBusHarness({ beforeReady: async (app) => {
    app.get('/api/codex-app-server/sessions', async () => ({ sessions: [] }));
  } }); t.after(() => h.cleanup());
  if (mode === 'setup failure') await pushConfig(f, JSON.stringify({ setup: 'touch failed; exit 1' }));
  if (mode === 'no config (local only)') await pushConfig(f);
  if (mode === 'stale local config') await rm(resolve(f.repo, '.cadre/worktree.json'));
  if (mode === 'launch failure') h.createResponders.claude = () => ({ statusCode: 400, body: { error: 'fixture startup failed' } });
  const response = await h.app.inject({ method: 'POST', url: '/api/agent-bus/bootstrap', headers: h.authHeaders, payload: {
    title: 'Managed', workDir: f.repo, worktree: { repo: f.repo, branch: 'bootstrap', base: 'origin/main' },
    participants: [{ kind: 'codex', create: true, workDir: '/wrong' }, { kind: 'claude', create: true }],
  } });
  if (!['managed', 'stale local config'].includes(mode)) {
    assert.equal(response.statusCode, 400, response.body);
    if (mode === 'no config (local only)') assert.equal(response.json().error, `${f.repo} has no .cadre/worktree.json at origin/main; managed worktrees require the repo to opt in`);
    if (mode !== 'launch failure') {
      assert.equal(h.store.listThreads().length, 0);
      assert.equal(h.createdSessions.codex.length, 0); assert.equal(h.createdSessions.claude.length, 0);
    } else {
      assert.match(response.json().error, /Participant claude:.*fixture startup failed/);
      assert.equal(response.json().worktree.removed, true, response.body);
      assert.deepEqual(h.deletedSessions.codex, [h.createdSessions.codex[0].sessionId]);
      assert.deepEqual(h.deletedSessions.claude, []);
      assert.equal(h.store.listThreads()[0].status, 'closed');
      assert.equal(h.store.getThread(h.store.listThreads()[0].id).deliveries.some((delivery) => delivery.status === 'queued'), false);
    }
    assert.doesNotMatch(await git(f.repo, 'worktree', 'list', '--porcelain'), /refs\/heads\/bootstrap/);
    assert.equal((await exec('git', ['-C', f.repo, 'show-ref', '--verify', 'refs/heads/bootstrap'])).code, 128);
    return;
  }
  assert.equal(response.statusCode, 200, response.body);
  const metadata = h.store.getThread(response.json().thread.id).thread.metadata.worktree;
  assert.equal(metadata.roomId, response.json().thread.id);
  assert.equal(h.createdSessions.codex[0].workDir, metadata.path);
  assert.equal(h.createdSessions.claude[0].workDir, metadata.path);
  if (mode === 'stale local config') return;
  await h.app.agentBusLifecycle.linkWorktreePr(metadata.roomId, { repo: 'test/repo', number: 1 });
  await git(metadata.path, 'merge', '--ff-only', f.head);
  await git(f.repo, 'merge', '--ff-only', f.head);
  h.app.agentBusLifecycle.getWorktreePr = f.options.getPr;
  const ended = await h.app.inject({ method: 'POST', url: `/api/agent-bus/threads/${metadata.roomId}/end`, headers: h.authHeaders, payload: {} });
  assert.equal(ended.statusCode, 200, ended.body);
  assert.equal(ended.json().worktree.removed, true, ended.body);
  assert.equal(await exists(metadata.path), false);
});

for (const mode of ['then merged', 'already merged', 'with explicit watch', 'after branch switch']) test(`room PR found by branch ${mode}`, async (t) => {
  const f = await fixture(t);
  await git(f.repo, 'config', `url.${resolve(f.root, 'remote')}.insteadOf`, 'https://github.com/test/repo.git');
  await git(f.repo, 'config', '--add', `url.${resolve(f.root, 'remote')}.insteadOf`, 'git@github.com:test/repo.git');
  await git(f.repo, 'remote', 'set-url', 'origin', 'https://github.com/test/repo.git');
  const commands = [];
  const h = await createAgentBusHarness({ beforeReady: async (app, dir) => {
    app.get('/api/codex-app-server/sessions', async () => ({ sessions: [] }));
    const { buildGithubAgentRepoStore } = await import('../modules/integrations/github-agents.mjs');
    const { githubAgentsPlugin } = await import('../modules/integrations/github-agents-plugin.mjs');
    await mkdir(resolve(dir, 'github'));
    const repoStore = buildGithubAgentRepoStore({ storeFile: resolve(dir, 'github/repos.json'), env: { APP_STATE_STORAGE: 'file' } });
    await repoStore.upsertRepo({ owner: 'test', repo: 'repo', authRef: 'TEST_GITHUB_TOKEN', prEnabled: false, issueEnabled: false });
    await githubAgentsPlugin(app, { repoStore, config: { enabled: false },
      enqueueSessionCommand: async (kind, sessionId, input) => commands.push({ kind, sessionId, ...input }) });
  } }); t.after(() => h.cleanup());
  const response = await h.app.inject({ method: 'POST', url: '/api/agent-bus/bootstrap', headers: h.authHeaders, payload: {
    title: 'Auto', worktree: { repo: f.repo, branch: 'auto', base: 'origin/main' },
    participants: [{ kind: 'codex', create: true }, { kind: 'claude', create: true }],
  } });
  assert.equal(response.statusCode, 200, response.body);
  // Collab rooms are owned by the coordinator agent, which receives the merge notification.
  const room = await h.store.transferThread(response.json().thread.id, { kind: 'pi', sessionId: 'pi-1' });
  await git(room.metadata.worktree.path, 'merge', '--ff-only', f.head);
  await git(f.repo, 'push', 'origin', `${f.head}:refs/pull/2/head`);
  const stale = { number: 1, created_at: new Date(room.createdAt - 60000).toISOString() };
  let pulls = [], pr = { number: 2, state: 'open', merged: false, head: { sha: f.head, ref: 'auto' } };
  const urls = [];
  const poller = h.app.githubAgents.poller;
  poller.config = { enabled: true, env: { TEST_GITHUB_TOKEN: 'test-only' } };
  poller.fetchImpl = async (url) => {
    urls.push(url); const { pathname } = new URL(url);
    return new Response(JSON.stringify(pathname.endsWith('/pulls') ? pulls : pathname.endsWith('/reviews') ? [] : pr), { status: 200 });
  };
  await poller.pollOnce();
  assert.deepEqual(await h.app.githubAgents.repoStore.listWatches(), []);
  pulls = [{ number: 2, created_at: new Date(Math.floor(room.createdAt / 1000) * 1000).toISOString() }, stale];
  for (const url of ['https://notgithub.com/test/repo.git', 'git@github.com.evil:test/repo.git']) {
    await git(f.repo, 'remote', 'set-url', 'origin', url);
    await poller.pollOnce();
  }
  assert.deepEqual(await h.app.githubAgents.repoStore.listWatches(), []);
  assert.equal(h.store.getThread(room.id).thread.metadata.worktree.pr, undefined);
  await git(f.repo, 'remote', 'set-url', 'origin', mode === 'already merged' ? 'git@github.com:test/repo.git' : 'https://github.com/test/repo.git');
  if (mode === 'with explicit watch') {
    const other = await h.store.createThread({ title: 'Other', participants: [], createdBy: { kind: 'pi', sessionId: 'pi-1' } });
    const explicit = await h.app.githubAgents.repoStore.putWatch({ repo: 'test/repo', number: 2, thread_id: other.id }, { kind: 'pi', sessionId: 'pi-1' });
    await poller.pollOnce();
    assert.deepEqual(await h.app.githubAgents.repoStore.listWatches(), [explicit]);
    assert.deepEqual(h.store.getThread(room.id).thread.metadata.worktree.pr, { repo: 'test/repo', number: 2 });
    return;
  }
  if (mode === 'after branch switch') {
    await poller.pollOnce();
    assert.deepEqual(h.store.getThread(room.id).thread.metadata.worktree.pr, { repo: 'test/repo', number: 2 });
    // The room moves to a follow-up branch before its first PR merges.
    const path = room.metadata.worktree.path;
    await git(path, 'checkout', '-q', '-b', 'auto-next');
    await writeFile(resolve(path, 'file'), 'next\n'); await git(path, 'commit', '-qam', 'next');
    const next = await git(path, 'rev-parse', 'HEAD');
    await git(f.repo, 'push', 'origin', `${next}:refs/pull/3/head`, `${next}:refs/heads/auto-next`);
    pr = { ...pr, state: 'closed', merged: true, merge_commit_sha: f.head };
    await poller.pollOnce();
    assert.equal(h.store.getThread(room.id).thread.status, 'open');
    assert.deepEqual(Object.values(h.deletedSessions).flat(), []);
    assert.equal(h.store.getThread(room.id).thread.metadata.worktree.branch, 'auto-next');
    assert.equal(h.store.getThread(room.id).thread.metadata.worktree.pr, undefined);
    assert.deepEqual(await h.app.githubAgents.repoStore.listWatches(), []);
    assert.match(commands.at(-1).text, /^\[PR_WATCH\] PR test\/repo#2 merged \(.*\) · room continues on auto-next$/);
    const prs = { 2: pr, 3: { number: 3, state: 'open', merged: false, head: { sha: next, ref: 'auto-next' } } };
    poller.fetchImpl = async (url) => {
      const { pathname, searchParams } = new URL(url);
      const body = pathname.endsWith('/pulls')
        ? (searchParams.get('head') === 'test:auto-next' ? [{ number: 3, created_at: new Date().toISOString() }] : pulls)
        : pathname.endsWith('/reviews') ? [] : prs[pathname.split('/').at(-1)];
      return new Response(JSON.stringify(body), { status: 200 });
    };
    await poller.pollOnce();
    assert.deepEqual((await h.app.githubAgents.repoStore.listWatches()).map((watch) => [watch.number, watch.thread_id]), [[3, room.id]]);
    assert.deepEqual(h.store.getThread(room.id).thread.metadata.worktree.pr, { repo: 'test/repo', number: 3 });
    prs[3] = { ...prs[3], state: 'closed', merged: true, merge_commit_sha: next };
    await git(f.repo, 'merge', '--ff-only', next);
    await poller.pollOnce();
    assert.equal(h.store.getThread(room.id).thread.status, 'closed');
    assert.equal(await exists(path), false);
    assert.equal((await exec('git', ['-C', f.repo, 'show-ref', '--verify', 'refs/heads/auto-next'])).code, 128);
    assert.match(commands.at(-1).text, /^\[PR_WATCH\] PR test\/repo#3 merged .* · ended room .* · worktree: removed$/);
    return;
  }
  if (mode === 'then merged') {
    // A read-only marker makes the real link write fail after the watch is stored.
    const marker = resolve(room.metadata.worktree.path, await git(room.metadata.worktree.path, 'rev-parse', '--git-dir'), 'cadre-room.json');
    await chmod(marker, 0o444);
    await poller.pollOnce();
    assert.deepEqual(await h.app.githubAgents.repoStore.listWatches(), []);
    assert.equal(h.store.getThread(room.id).thread.metadata.worktree.pr, undefined);
    await chmod(marker, 0o644);
    // A read-only store directory makes the real watch save fail after the in-memory insert.
    await chmod(resolve(h.stateDir, 'github'), 0o555);
    await poller.pollOnce().catch(() => {});
    await chmod(resolve(h.stateDir, 'github'), 0o755);
    assert.deepEqual(await h.app.githubAgents.repoStore.listWatches(), []);
    assert.equal(h.store.getThread(room.id).thread.metadata.worktree.pr, undefined);
    await poller.pollOnce();
    const [watch] = await h.app.githubAgents.repoStore.listWatches();
    assert.deepEqual([watch.number, watch.thread_id, watch.creator], [2, room.id, { kind: 'codex', sessionId: room.participants[0].sessionId }]);
    assert.equal(h.store.getThread(room.id).thread.status, 'open');
  }
  pr = { ...pr, state: 'closed', merged: true, merge_commit_sha: f.head };
  await git(f.repo, 'merge', '--ff-only', f.head);
  await poller.pollOnce();
  assert.equal(new URL(urls[0]).searchParams.get('head'), 'test:auto');
  assert.deepEqual(h.store.getThread(room.id).thread.metadata.worktree.pr, { repo: 'test/repo', number: 2 });
  assert.equal(h.store.getThread(room.id).thread.status, 'closed');
  assert.equal(await exists(room.metadata.worktree.path), false);
  assert.deepEqual(await h.app.githubAgents.repoStore.listWatches(), []);
  assert.deepEqual(commands.map((item) => item.sessionId), ['pi-1']);
  assert.match(commands[0].text, /^\[PR_WATCH\] PR test\/repo#2 merged .* · ended room .* · worktree: removed$/);
});

test('ended sessions do not block removal', async (t) => {
  const f = await fixture(t); await git(f.repo, 'merge', '--ff-only', 'topic');
  f.options.sessions = [{ lifecycle: 'ended', workDir: f.metadata.path }];
  assert.equal((await cleanupManagedWorktree(f.metadata, f.options)).removed, true);
});

test('new ignored file inside an existing ignored directory blocks removal', async (t) => {
  const f = await fixture(t, 'mkdir cache; touch cache/baseline');
  assert.ok(f.metadata.ignoredBaseline.includes('cache/baseline'));
  await writeFile(resolve(f.metadata.path, 'cache/new'), 'precious');
  assert.equal((await cleanupManagedWorktree(f.metadata, f.options)).reason, 'new ignored files');
  assert.equal(await readFile(resolve(f.metadata.path, 'cache/new'), 'utf8'), 'precious');
});

test('new external node_modules link blocks removal', async (t) => {
  const f = await fixture(t); const target = resolve(f.root, 'shared'); await mkdir(target);
  await symlink(target, resolve(f.metadata.path, 'node_modules'));
  assert.equal((await cleanupManagedWorktree(f.metadata, f.options)).reason, 'dirty or untracked files');
  assert.equal(await exists(f.metadata.path), true);
});

test('tracked external symlink is safely removed by git without modifying its target', async (t) => {
  const f = await fixture(t); const target = resolve(f.root, 'shared'); await mkdir(target);
  await writeFile(resolve(target, 'precious'), 'keep');
  await symlink(target, resolve(f.metadata.path, 'docs'));
  await git(f.metadata.path, 'add', 'docs'); await git(f.metadata.path, 'commit', '-m', 'tracked link');
  const head = await git(f.metadata.path, 'rev-parse', 'HEAD');
  await git(f.repo, 'push', 'origin', `+${head}:refs/pull/1/head`);
  f.setPr({ merged: true, number: 1, head: { sha: head } }); await git(f.repo, 'merge', '--ff-only', 'topic');
  assert.equal((await cleanupManagedWorktree(f.metadata, f.options)).removed, true);
  assert.equal(await readFile(resolve(target, 'precious'), 'utf8'), 'keep');
});

for (const touched of [false, true]) test(`partial spawn failure ${touched ? 'keeps written files' : 'removes untouched worktree'}`, async (t) => {
  const f = await fixture(t);
  const h = await createAgentBusHarness({ beforeReady: async (app) => {
    app.get('/api/codex-app-server/sessions', async () => ({ sessions: [] }));
  } }); t.after(() => h.cleanup());
  h.createResponders.claude = async ({ workDir }) => {
    if (touched) await writeFile(resolve(workDir, 'precious'), 'keep');
    throw new Error('launch failed');
  };
  const response = await h.app.inject({ method: 'POST', url: '/api/agent-bus/bootstrap', headers: h.authHeaders, payload: {
    title: 'Fail', worktree: { repo: f.repo, branch: 'partial', base: 'origin/main' },
    participants: [{ kind: 'codex', create: true }, { kind: 'claude', create: true }],
  } });
  assert.equal(response.statusCode, 400, response.body);
  assert.deepEqual(h.deletedSessions.codex, [h.createdSessions.codex[0].sessionId]);
  assert.equal(response.json().worktree.removed, !touched, response.body);
  const entry = (await git(f.repo, 'worktree', 'list', '--porcelain')).split('\n\n').find((entry) => entry.includes('refs/heads/partial'));
  if (touched) {
    assert.match(response.json().worktree.report, /kept/);
    const path = entry.split('\n')[0].slice('worktree '.length);
    assert.equal(await readFile(resolve(path, 'precious'), 'utf8'), 'keep');
    assert.match(entry, /locked cadre room/);
  } else assert.equal(entry, undefined);
});

test('setup copies gitignored files and defaults cleanup to off', async (t) => {
  const f = await fixture(t);
  await pushConfig(f, JSON.stringify({ copy: ['cache/settings'], setup: 'test -f cache/settings' }));
  await mkdir(resolve(f.repo, 'cache')); await writeFile(resolve(f.repo, 'cache/settings'), 'local');
  const metadata = await createManagedWorktree({ repo: f.repo, branch: 'copy', roomId: 'thr_copy', baseDir: f.options.baseDir });
  assert.equal(await readFile(resolve(metadata.path, 'cache/settings'), 'utf8'), 'local');
  assert.deepEqual(metadata.ignoredBaseline, ['cache/settings']);
  await writeFile(resolve(f.repo, '.cadre/worktree.json'), JSON.stringify({ cleanup: 'on-merge' }));
  assert.equal((await cleanupManagedWorktree(metadata, f.options)).reason, 'cleanup off');
});

test('setup runs from the base ref config, not dirty local config', async (t) => {
  const f = await fixture(t); await pushConfig(f, JSON.stringify({ setup: 'touch from-base' }));
  await writeFile(resolve(f.repo, '.cadre/worktree.json'), JSON.stringify({ setup: 'touch from-local' }));
  const metadata = await createManagedWorktree({ repo: f.repo, branch: 'divergent', roomId: 'thr_divergent', baseDir: f.options.baseDir });
  assert.equal(await exists(resolve(metadata.path, 'from-base')), true);
  assert.equal(await exists(resolve(metadata.path, 'from-local')), false);
});

test('setup timeout terminates child writers before rollback', async (t) => {
  const f = await fixture(t);
  const escaped = resolve(f.root, 'late-write');
  await pushConfig(f, JSON.stringify({ setup: `(sleep 0.4; touch '${escaped}') & wait` }));
  await assert.rejects(createManagedWorktree({ repo: f.repo, branch: 'timeout', base: 'origin/main', roomId: 'thr_timeout', baseDir: f.options.baseDir, setupTimeoutMs: 50 }), /setup failed/);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(await exists(escaped), false);
  assert.equal(await exists(resolve(f.options.baseDir, 'thr_timeout/repo')), false);
});

test('bootstrap injects the merge policy from the base-ref config', async (t) => {
  const f = await fixture(t);
  const h = await createAgentBusHarness({ beforeReady: async (app) => {
    app.get('/api/codex-app-server/sessions', async () => ({ sessions: [] }));
  } }); t.after(() => h.cleanup());
  const bootstrap = (branch) => h.app.inject({ method: 'POST', url: '/api/agent-bus/bootstrap', headers: h.authHeaders, payload: {
    title: 'Merge', worktree: { repo: f.repo, branch, base: 'origin/main' },
    participants: [{ kind: 'codex', create: true }, { kind: 'claude', create: true }],
  } });
  const operatorLine = 'Unless your task says otherwise: do not merge or delete the remote branch; the coordinator or operator merges.';
  assert.equal((await bootstrap('operator')).statusCode, 200);
  assert.ok(h.createdSessions.codex[0].initialPrompt.split('\n').includes(operatorLine));
  await pushConfig(f, JSON.stringify({ merge: 'reviewer' }));
  await writeFile(resolve(f.repo, '.cadre/worktree.json'), JSON.stringify({ merge: 'operator' }));
  const response = await bootstrap('reviewer');
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(h.store.getThread(response.json().thread.id).thread.metadata.worktree.merge, 'reviewer');
  for (const created of [h.createdSessions.codex[1], h.createdSessions.claude[1]]) {
    assert.ok(created.initialPrompt.split('\n').includes('Unless your task says otherwise: after approval and the project\'s gates pass, the reviewer merges the PR, then reports; do not delete the remote branch.'));
    assert.doesNotMatch(created.initialPrompt, /coordinator or operator merges/);
  }
});

test('invalid config and missing metadata fail closed', async (t) => {
  const f = await fixture(t);
  assert.equal((await cleanupManagedWorktree({ ...f.metadata, ignoredBaseline: undefined }, f.options)).reason, 'metadata missing ignoredBaseline');
  for (const config of ['{', JSON.stringify({ merge: 'anyone' }), JSON.stringify({ merge: null }), JSON.stringify({ disposable: 'dist' }),
    JSON.stringify({ disposable: ['/tmp/dist'] }), JSON.stringify({ disposable: ['../dist'] }), JSON.stringify({ disposable: [''] }),
    JSON.stringify({ disposable: [':(glob)dist/**'] }), JSON.stringify({ disposable: ['dist/'] })]) {
    await pushConfig(f, config);
    await assert.rejects(createManagedWorktree({ repo: f.repo, branch: 'invalid', roomId: 'thr_invalid', baseDir: f.options.baseDir }), /invalid worktree config|JSON/);
    assert.equal(await exists(resolve(f.options.baseDir, 'thr_invalid')), false);
  }
});

test('failed PR fetch keeps worktree even when head object exists', async (t) => {
  const f = await fixture(t); await git(f.repo, 'push', 'origin', ':refs/pull/1/head');
  assert.equal((await cleanupManagedWorktree(f.metadata, f.options)).reason, 'git fetch failed');
  assert.equal(await exists(f.metadata.path), true);
});

test('pushed local commits outside PR remain kept', async (t) => {
  const f = await fixture(t); await writeFile(resolve(f.metadata.path, 'file'), 'extra');
  await git(f.metadata.path, 'commit', '-am', 'extra'); await git(f.metadata.path, 'push', 'origin', 'topic');
  assert.equal((await cleanupManagedWorktree(f.metadata, f.options)).reason, 'local commits not in PR');
  assert.equal(await exists(f.metadata.path), true);
});

test('shared working directory through a symlink blocks removal', async (t) => {
  const f = await fixture(t); const alias = resolve(f.root, 'alias'); await symlink(f.metadata.path, alias);
  f.options.sessions = [{ workDir: alias }];
  assert.equal((await cleanupManagedWorktree(f.metadata, f.options)).reason, 'shared with another room or live session');
});

test('sweep ignores marked worktrees outside the managed base', async (t) => {
  const f = await fixture(t); await git(f.repo, 'merge', '--ff-only', 'topic');
  const outsideBase = resolve(f.root, 'outside');
  const metadata = await createManagedWorktree({ repo: f.repo, branch: 'outside', base: 'origin/main', roomId: 'thr_outside', baseDir: outsideBase });
  await sweepManagedWorktrees({ baseDir: f.options.baseDir, getRoom: () => null, cleanup: (m) => cleanupManagedWorktree(m, f.options) });
  assert.equal(await exists(f.metadata.path), false);
  assert.equal(await exists(metadata.path), true);
});

test('managed attach from repo subdirectory is rejected before worktree creation', async (t) => {
  const f = await fixture(t); await mkdir(resolve(f.repo, 'subdirectory'));
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  const response = await h.app.inject({ method: 'POST', url: '/api/agent-bus/bootstrap', headers: h.authHeaders, payload: {
    worktree: { repo: resolve(f.repo, 'subdirectory'), branch: 'attached' },
    participants: [{ kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' }],
  } });
  assert.equal(response.statusCode, 400, response.body); assert.match(response.json().error, /newly created/);
  assert.doesNotMatch(await git(f.repo, 'worktree', 'list', '--porcelain'), /refs\/heads\/attached/);
  assert.equal(h.createdSessions.codex.length, 0);
});

test('setup failure preserves original error when rollback branch CAS refuses', async (t) => {
  const f = await fixture(t);
  await pushConfig(f, JSON.stringify({ setup: 'echo setup-change >> file; git commit -am setup-change; exit 1' }));
  await assert.rejects(createManagedWorktree({ repo: f.repo, branch: 'setup-commit', roomId: 'thr_setup_commit', baseDir: f.options.baseDir }), (error) => {
    assert.equal(error.message, 'worktree setup failed'); assert.equal(error.rollbackError, 'git update-ref failed'); return true;
  });
  assert.equal(await exists(resolve(f.options.baseDir, 'thr_setup_commit/repo')), false);
  assert.notEqual(await git(f.repo, 'rev-parse', 'setup-commit'), f.metadata.baseHead);
});

test('ignored Cadre .agent_bus state alone does not block cleanup', async (t) => {
  const f = await fixture(t);
  await writeFile(resolve(f.metadata.path, '.gitignore'), 'node_modules/\ncache/\n.agent_bus/\n');
  await git(f.metadata.path, 'commit', '-am', 'ignore agent bus');
  const head = await git(f.metadata.path, 'rev-parse', 'HEAD');
  await git(f.repo, 'push', 'origin', `+${head}:refs/pull/1/head`);
  f.setPr({ merged: true, number: 1, head: { sha: head } });
  await mkdir(resolve(f.metadata.path, '.agent_bus/hooks'), { recursive: true });
  await writeFile(resolve(f.metadata.path, '.agent_bus/hooks/codex-session.jsonl'), 'hook');
  await writeFile(resolve(f.metadata.path, '.agent_bus/session.json'), 'state');
  assert.equal((await cleanupManagedWorktree(f.metadata, f.options)).removed, true);
  assert.equal(await exists(f.metadata.path), false);
});

test('disposable globs recorded at creation skip matching ignored files only', async (t) => {
  const f = await fixture(t, '', { disposable: ['packages/*/dist/**'] });
  assert.deepEqual(f.metadata.disposable, ['packages/*/dist/**']);
  await mkdir(resolve(f.metadata.path, 'packages/a/dist'), { recursive: true }); await mkdir(resolve(f.metadata.path, 'art'));
  await writeFile(resolve(f.metadata.path, 'packages/a/dist/index.js'), 'built');
  await writeFile(resolve(f.metadata.path, 'art/source.psd'), 'precious');
  assert.equal((await cleanupManagedWorktree(f.metadata, f.options)).reason, 'new ignored files');
  await rm(resolve(f.metadata.path, 'art'), { recursive: true });
  const marker = resolve(f.repo, '.git/worktrees/repo/cadre-room.json'), recorded = await readFile(marker, 'utf8');
  const { disposable, ...legacy } = f.metadata;
  const { disposable: _, ...legacyMarker } = JSON.parse(recorded);
  await writeFile(marker, JSON.stringify(legacyMarker));
  assert.equal((await cleanupManagedWorktree(legacy, f.options)).reason, 'new ignored files');
  await writeFile(marker, recorded);
  await pushConfig(f, JSON.stringify({ cleanup: 'on-merge' }));
  await writeFile(resolve(f.repo, '.cadre/worktree.json'), JSON.stringify({ cleanup: 'on-merge', disposable: [] }));
  assert.equal((await cleanupManagedWorktree(f.metadata, f.options)).removed, true);
  assert.equal(await exists(f.metadata.path), false);
});

test('symlinked Cadre state parent is kept with external content intact', async (t) => {
  const f = await fixture(t); const target = resolve(f.root, 'shared'); await mkdir(resolve(target, 'hooks'), { recursive: true });
  await writeFile(resolve(target, 'hooks/precious'), 'keep');
  await symlink(target, resolve(f.metadata.path, '.agent_bus'));
  const result = await cleanupManagedWorktree(f.metadata, f.options);
  assert.equal(result.removed, false); assert.equal(await readFile(resolve(target, 'hooks/precious'), 'utf8'), 'keep');
});
