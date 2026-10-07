import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { exec } from '../lib/exec.mjs';
import { createManagedWorktree, cleanupManagedWorktree, sweepManagedWorktrees } from '../modules/agent-bus/managed-worktrees.mjs';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';

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
  await git(repo, 'push', 'origin', 'topic');
  return { root, repo, metadata, head, options: { baseDir } };
}
async function pushConfig(f, text) {
  if (text === undefined) await git(f.repo, 'rm', '-q', '--cached', '.cadre/worktree.json');
  else { await writeFile(resolve(f.repo, '.cadre/worktree.json'), text); await git(f.repo, 'add', '.cadre/worktree.json'); }
  await git(f.repo, 'commit', '-m', 'config'); await git(f.repo, 'push', 'origin', 'main');
}
const exists = async (path) => !!await stat(path).catch(() => null);

for (const [name, change, reason] of [
  ['dirty', async (f) => writeFile(resolve(f.metadata.path, 'file'), 'dirty'), 'dirty or untracked files: file'],
  ['untracked with hidden user configuration', async (f) => { await git(f.repo, 'config', 'status.showUntrackedFiles', 'no'); await writeFile(resolve(f.metadata.path, 'untracked'), 'data'); }, 'dirty or untracked files: untracked'],
  ['unpushed', async (f) => { await writeFile(resolve(f.metadata.path, 'file'), 'extra'); await git(f.metadata.path, 'commit', '-am', 'extra'); }, 'unpushed commits'],
  ['unpushed on a switched branch', async (f) => { await git(f.metadata.path, 'checkout', '-q', '-b', 'next'); await writeFile(resolve(f.metadata.path, 'file'), 'next'); await git(f.metadata.path, 'commit', '-am', 'next'); }, 'unpushed commits'],
  ['failed fetch', async (f) => git(f.repo, 'remote', 'set-url', 'origin', resolve(f.root, 'missing')), 'git fetch failed'],
  ['untracked .agent_bus notes', async (f) => { await mkdir(resolve(f.metadata.path, '.agent_bus/hooks'), { recursive: true }); await writeFile(resolve(f.metadata.path, '.agent_bus/notes'), 'precious'); }, 'dirty or untracked files: .agent_bus/notes'],
  ['many untracked', async (f) => { for (const name of ['u1', 'u2', 'u3', 'u4', 'u5']) await writeFile(resolve(f.metadata.path, name), 'data'); }, 'dirty or untracked files: u1, u2, u3, ... +2 more'],
  ['staged rename', async (f) => git(f.metadata.path, 'mv', 'file', 'moved'), 'dirty or untracked files: file, moved'],
  ['new ignored', async (f) => { await mkdir(resolve(f.metadata.path, 'cache')); await writeFile(resolve(f.metadata.path, 'cache/new'), 'data'); }, 'new ignored files: cache/new'],
  ['shared room', async (f) => { f.options.rooms = [{ id: 'other', status: 'open', metadata: { worktree: { path: resolve(f.metadata.path, 'subdir') } } }]; }, 'shared with another room or live session'],
  ['interrupted session', async (f) => { f.options.sessions = [{ lifecycle: 'interrupted', workDir: f.metadata.path }]; }, 'shared with another room or live session'],
  ['shared session', async (f) => { f.options.sessions = [{ workDir: resolve(f.metadata.path, 'subdir') }]; }, 'shared with another room or live session'],
  ['marker missing', async (f) => rm(resolve(f.metadata.path, await git(f.metadata.path, 'rev-parse', '--git-dir'), 'cadre-room.json')), 'marker missing'],
  ['marker mismatch', async (f) => { f.metadata = { ...f.metadata, baseHead: f.head }; }, 'marker mismatch: baseHead'],
  ['disposable mismatch', async (f) => { f.metadata = { ...f.metadata, disposable: ['dist/**'] }; }, 'marker mismatch: disposable'],
  ['metadata outside base', async (f) => { f.options.baseDir = resolve(f.root, 'elsewhere'); }, 'path outside managed base'],
]) test(`managed worktree keeps ${name}`, async (t) => {
  const f = await fixture(t); await change(f);
  const result = await cleanupManagedWorktree(f.metadata, f.options);
  assert.equal(result.reason, reason); assert.equal(result.removed, false);
  assert.equal(await exists(f.metadata.path), true);
});

test('pushed and clean removes worktree and branch', async (t) => {
  const f = await fixture(t);
  const result = await cleanupManagedWorktree(f.metadata, f.options);
  assert.equal(result.removed, true); assert.equal(result.branchKept, false);
  assert.equal(await exists(f.metadata.path), false);
  assert.equal((await exec('git', ['-C', f.repo, 'show-ref', '--verify', 'refs/heads/topic'])).code, 128);
});

for (const recorded of ['pushed', 'unpushed']) test(`a worktree switched to another pushed branch is removed; a ${recorded} recorded branch is ${recorded === 'pushed' ? 'deleted' : 'kept'}`, async (t) => {
  const f = await fixture(t);
  await git(f.metadata.path, 'checkout', '-q', '-b', 'next');
  await writeFile(resolve(f.metadata.path, 'file'), 'next\n'); await git(f.metadata.path, 'commit', '-qam', 'next');
  await git(f.metadata.path, 'push', '-q', 'origin', 'next');
  const local = await git(f.repo, 'commit-tree', '-p', 'topic', '-m', 'local only', 'topic^{tree}');
  if (recorded === 'unpushed') await git(f.repo, 'branch', '-f', 'topic', local);
  const result = await cleanupManagedWorktree(f.metadata, f.options);
  assert.equal(result.removed, true); assert.equal(await exists(f.metadata.path), false);
  if (recorded === 'pushed') {
    assert.equal(result.report, 'worktree: removed');
    assert.equal((await exec('git', ['-C', f.repo, 'show-ref', '--verify', 'refs/heads/topic'])).code, 128);
  } else {
    assert.equal(result.report, 'worktree: removed (branch kept: unpushed commits)');
    assert.equal(await git(f.repo, 'rev-parse', 'topic'), local);
  }
});

test('baseline external node_modules symlink is unlinked without touching target', async (t) => {
  const f = await fixture(t, 'mkdir -p "$CADRE_REPO_ROOT/../shared"; ln -s "$CADRE_REPO_ROOT/../shared" node_modules');
  const target = resolve(f.root, 'shared'); await writeFile(resolve(target, 'precious'), 'keep');
  // The baseline was recorded while the link was dangling; git still lists the ignored symlink.
  assert.ok(f.metadata.ignoredBaseline.includes('node_modules'));

  const result = await cleanupManagedWorktree(f.metadata, f.options);
  assert.equal(result.removed, true); assert.equal(await exists(f.metadata.path), false);
  assert.equal(await readFile(resolve(target, 'precious'), 'utf8'), 'keep');
});

test('cleanup uses the base ref policy recorded at creation, not the local checkout', async (t) => {
  const f = await fixture(t);
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
  const f = await fixture(t);
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
  const f = await fixture(t);
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
  await git(metadata.path, 'merge', '--ff-only', f.head);
  const ended = await h.app.inject({ method: 'POST', url: `/api/agent-bus/threads/${metadata.roomId}/end`, headers: h.authHeaders, payload: {} });
  assert.equal(ended.statusCode, 200, ended.body);
  assert.equal(ended.json().worktree.removed, true, ended.body);
  assert.equal(await exists(metadata.path), false);
});

for (const merge of ['operator', 'reviewer']) test(`${merge}-merge room: merges only notify, room_end removes a multi-PR worktree`, async (t) => {
  const f = await fixture(t, '', { merge });
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
    title: 'Multi', worktree: { repo: f.repo, branch: 'auto', base: 'origin/main' },
    participants: [{ kind: 'codex', create: true }, { kind: 'claude', create: true }],
  } });
  assert.equal(response.statusCode, 200, response.body);
  // Collab rooms are owned by the coordinator agent, which receives merge notifications and results.
  const owner = { kind: 'pi', sessionId: 'pi-1' };
  const room = await h.store.transferThread(response.json().thread.id, owner);
  const { path } = room.metadata.worktree;
  const prs = {};
  const poller = h.app.githubAgents.poller;
  poller.config = { enabled: true, env: { TEST_GITHUB_TOKEN: 'test-only' } };
  poller.fetchImpl = async (url) => {
    const { pathname } = new URL(url);
    return new Response(JSON.stringify(pathname.endsWith('/reviews') ? [] : prs[pathname.split('/').at(-1)]), { status: 200 });
  };
  for (const [number, branch] of [[2, 'auto'], [3, 'auto-next']]) {
    if (branch !== 'auto') await git(path, 'checkout', '-q', '-b', branch);
    await writeFile(resolve(path, 'file'), `${branch}\n`); await git(path, 'commit', '-qam', branch);
    await git(path, 'push', '-q', 'origin', branch);
    const sha = await git(path, 'rev-parse', 'HEAD');
    await h.app.githubAgents.repoStore.putWatch({ repo: 'test/repo', number, thread_id: room.id }, owner);
    prs[number] = { number, state: 'closed', merged: true, merge_commit_sha: sha, head: { sha, ref: branch } };
    await poller.pollOnce();
    assert.equal(commands.at(-1).text, `[PR_WATCH] PR test/repo#${number} merged (${sha.slice(0, 7)})`);
    assert.equal(commands.at(-1).sessionId, owner.sessionId);
    assert.equal(h.store.getThread(room.id).thread.status, 'open');
    assert.deepEqual(Object.values(h.deletedSessions).flat(), []);
  }
  assert.deepEqual(await h.app.githubAgents.repoStore.listWatches(), []);
  if (merge === 'reviewer') {
    // The reviewer merged; its later report still reaches the owner because the merge did not end the room.
    const posted = await h.app.inject({ method: 'POST', url: '/api/agent-bus/messages', headers: h.authHeaders,
      payload: { threadId: room.id, from: room.participants[0], type: 'result', summary: 'merged · PR #3 · done', body: 'DIRECTOR REPORT: merged' } });
    assert.equal(posted.statusCode, 200, posted.body);
    assert.ok(posted.json().deliveries.some((delivery) => delivery.target.sessionId === owner.sessionId && delivery.status !== 'failed'), posted.body);
  }
  const ended = await h.app.inject({ method: 'POST', url: `/api/agent-bus/threads/${room.id}/end`, headers: h.authHeaders, payload: {} });
  assert.equal(ended.statusCode, 200, ended.body);
  assert.equal(ended.json().worktree.report, 'worktree: removed', ended.body);
  assert.equal(await exists(path), false);
  assert.equal((await exec('git', ['-C', f.repo, 'show-ref', '--verify', 'refs/heads/auto'])).code, 128);
});

test('ended sessions do not block removal', async (t) => {
  const f = await fixture(t);
  f.options.sessions = [{ lifecycle: 'ended', workDir: f.metadata.path }];
  assert.equal((await cleanupManagedWorktree(f.metadata, f.options)).removed, true);
});

test('new ignored file inside an existing ignored directory blocks removal', async (t) => {
  const f = await fixture(t, 'mkdir cache; touch cache/baseline');
  assert.ok(f.metadata.ignoredBaseline.includes('cache/baseline'));
  await writeFile(resolve(f.metadata.path, 'cache/new'), 'precious');
  assert.equal((await cleanupManagedWorktree(f.metadata, f.options)).reason, 'new ignored files: cache/new');
  assert.equal(await readFile(resolve(f.metadata.path, 'cache/new'), 'utf8'), 'precious');
});

test('kept reason names the first three new ignored files inside collapsed directories', async (t) => {
  const f = await fixture(t); const cache = resolve(f.metadata.path, 'packages/sim/node_modules/.vite');
  await mkdir(cache, { recursive: true });
  for (const name of ['a', 'b', 'c', 'd', 'e']) await writeFile(resolve(cache, name), 'data');
  const result = await cleanupManagedWorktree(f.metadata, f.options);
  const reason = 'new ignored files: packages/sim/node_modules/.vite/a, packages/sim/node_modules/.vite/b, packages/sim/node_modules/.vite/c, ... +2 more';
  assert.equal(result.reason, reason); assert.equal(result.report, `worktree: kept (${reason})`);
});

test('new external node_modules link blocks removal', async (t) => {
  const f = await fixture(t); const target = resolve(f.root, 'shared'); await mkdir(target);
  await symlink(target, resolve(f.metadata.path, 'node_modules'));
  assert.equal((await cleanupManagedWorktree(f.metadata, f.options)).reason, 'dirty or untracked files: node_modules');
  assert.equal(await exists(f.metadata.path), true);
});

test('tracked external symlink is safely removed by git without modifying its target', async (t) => {
  const f = await fixture(t); const target = resolve(f.root, 'shared'); await mkdir(target);
  await writeFile(resolve(target, 'precious'), 'keep');
  await symlink(target, resolve(f.metadata.path, 'docs'));
  await git(f.metadata.path, 'add', 'docs'); await git(f.metadata.path, 'commit', '-m', 'tracked link');
  await git(f.metadata.path, 'push', 'origin', 'topic');
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

test('shared working directory through a symlink blocks removal', async (t) => {
  const f = await fixture(t); const alias = resolve(f.root, 'alias'); await symlink(f.metadata.path, alias);
  f.options.sessions = [{ workDir: alias }];
  assert.equal((await cleanupManagedWorktree(f.metadata, f.options)).reason, 'shared with another room or live session');
});

test('sweep ignores marked worktrees outside the managed base', async (t) => {
  const f = await fixture(t);
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
  await git(f.metadata.path, 'push', 'origin', 'topic');
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
  assert.equal((await cleanupManagedWorktree(f.metadata, f.options)).reason, 'new ignored files: art/source.psd');
  await rm(resolve(f.metadata.path, 'art'), { recursive: true });
  const marker = resolve(f.repo, '.git/worktrees/repo/cadre-room.json'), recorded = await readFile(marker, 'utf8');
  const { disposable, ...legacy } = f.metadata;
  const { disposable: _, ...legacyMarker } = JSON.parse(recorded);
  await writeFile(marker, JSON.stringify(legacyMarker));
  assert.equal((await cleanupManagedWorktree(legacy, f.options)).reason, 'new ignored files: packages/a/dist/index.js');
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
