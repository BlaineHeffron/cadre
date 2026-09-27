import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAgentSessionWorktree, createGithubIssueWorktree, createGithubPullRequestWorktree, createInvestigationWorktree, reapWorktrees, removeAgentSessionWorktree } from '../modules/fleet/git-worktree.mjs';

const execFileAsync = promisify(execFile);

const tempDirs = [];
const originalPath = process.env.PATH;

afterEach(async () => {
  process.env.PATH = originalPath;
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd });
}

async function initRepo(root) {
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await git(repo, ['init', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.invalid']);
  await git(repo, ['config', 'user.name', 'Test User']);
  await writeFile(join(repo, 'README.md'), 'root\n');
  await git(repo, ['add', 'README.md']);
  await git(repo, ['commit', '-m', 'initial']);
  return repo;
}

async function addWorktree(repo, branch, path) {
  await mkdir(dirname(path), { recursive: true });
  await git(repo, ['worktree', 'add', '-b', branch, path, 'HEAD']);
  return path;
}

async function agePath(path, ageMs = 600_000) {
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
}

describe('git worktree helper', () => {
  it('creates agent session worktrees from origin/main before origin/master', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-agent-worktree-test-'));
    tempDirs.push(root);
    const binDir = join(root, 'bin');
    const repo = join(root, 'BusinessOS');
    const baseDir = join(root, 'agent-worktrees');
    const logPath = join(root, 'git.log');
    await mkdir(binDir, { recursive: true });
    await mkdir(repo, { recursive: true });
    await writeFile(join(binDir, 'git'), [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$GIT_TEST_LOG"',
      'if [ "$3" = "rev-parse" ] && [ "$4" = "--show-toplevel" ]; then printf "%s\\n" "$GIT_TEST_REPO"; exit 0; fi',
      'if [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then echo abc123; exit 0; fi',
      'if [ "$3" = "branch" ] && [ "$4" = "--show-current" ]; then echo feature; exit 0; fi',
      'if [ "$3" = "fetch" ] && [ "$6" = "main" ]; then exit 0; fi',
      'if [ "$3" = "rev-parse" ] && [ "$4" = "--verify" ] && [ "$5" = "origin/main^{commit}" ]; then echo def456; exit 0; fi',
      'if [ "$3" = "worktree" ] && [ "$4" = "add" ]; then mkdir -p "$7"; exit 0; fi',
      'exit 2',
      '',
    ].join('\n'));
    await chmod(join(binDir, 'git'), 0o755);
    process.env.PATH = `${binDir}:${originalPath || ''}`;
    process.env.GIT_TEST_LOG = logPath;
    process.env.GIT_TEST_REPO = repo;

    const result = await createAgentSessionWorktree({
      repoPath: repo,
      baseDir,
      displayName: 'Fix login',
      nowMs: 36,
    });

    assert.equal(result.repoPath, repo);
    assert.equal(result.worktreePath, join(baseDir, 'worktrees', 'agents', 'Fix-login-10', 'BusinessOS'));
    assert.equal(result.branch, 'dueno-fleet/agent/Fix-login-10');
    assert.equal(result.baseRef, 'origin/main');
    await stat(result.worktreePath);
    const log = await readFile(logPath, 'utf8');
    assert.match(log, /fetch --quiet origin main/);
    assert.match(log, /worktree add -b dueno-fleet\/agent\/Fix-login-10 .* def456/);
    assert.doesNotMatch(log, /origin master/);
  });

  it('falls back to origin/master for agent session worktrees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-agent-worktree-test-'));
    tempDirs.push(root);
    const binDir = join(root, 'bin');
    const repo = join(root, 'LegacyRepo');
    const baseDir = join(root, 'agent-worktrees');
    const logPath = join(root, 'git.log');
    await mkdir(binDir, { recursive: true });
    await mkdir(repo, { recursive: true });
    await writeFile(join(binDir, 'git'), [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$GIT_TEST_LOG"',
      'if [ "$3" = "rev-parse" ] && [ "$4" = "--show-toplevel" ]; then printf "%s\\n" "$GIT_TEST_REPO"; exit 0; fi',
      'if [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then echo abc123; exit 0; fi',
      'if [ "$3" = "branch" ] && [ "$4" = "--show-current" ]; then echo feature; exit 0; fi',
      'if [ "$3" = "rev-parse" ] && [ "$4" = "--verify" ] && [ "$5" = "origin/main^{commit}" ]; then exit 2; fi',
      'if [ "$3" = "fetch" ] && [ "$6" = "master" ]; then exit 0; fi',
      'if [ "$3" = "rev-parse" ] && [ "$4" = "--verify" ] && [ "$5" = "origin/master^{commit}" ]; then echo def456; exit 0; fi',
      'if [ "$3" = "worktree" ] && [ "$4" = "add" ]; then mkdir -p "$7"; exit 0; fi',
      'exit 2',
      '',
    ].join('\n'));
    await chmod(join(binDir, 'git'), 0o755);
    process.env.PATH = `${binDir}:${originalPath || ''}`;
    process.env.GIT_TEST_LOG = logPath;
    process.env.GIT_TEST_REPO = repo;

    const result = await createAgentSessionWorktree({
      repoPath: repo,
      baseDir,
      displayName: 'Legacy fix',
      nowMs: 72,
    });

    assert.equal(result.baseRef, 'origin/master');
    const log = await readFile(logPath, 'utf8');
    assert.match(log, /fetch --quiet origin main/);
    assert.match(log, /fetch --quiet origin master/);
    assert.match(log, /worktree add -b dueno-fleet\/agent\/Legacy-fix-20 .* def456/);
  });

  it('creates a branch worktree from current HEAD without commit, push, or fetch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-worktree-test-'));
    tempDirs.push(root);
    const binDir = join(root, 'bin');
    const repo = join(root, 'BusinessOS');
    const baseDir = join(root, 'investigations');
    const logPath = join(root, 'git.log');
    await mkdir(binDir, { recursive: true });
    await mkdir(repo, { recursive: true });
    await writeFile(join(binDir, 'git'), [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$GIT_TEST_LOG"',
      'if [ "$3" = "rev-parse" ] && [ "$4" = "--show-toplevel" ]; then printf "%s\\n" "$GIT_TEST_REPO"; exit 0; fi',
      'if [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then echo abc123; exit 0; fi',
      'if [ "$3" = "branch" ] && [ "$4" = "--show-current" ]; then echo main; exit 0; fi',
      'if [ "$3" = "worktree" ] && [ "$4" = "add" ]; then mkdir -p "$7"; exit 0; fi',
      'exit 2',
      '',
    ].join('\n'));
    await chmod(join(binDir, 'git'), 0o755);
    process.env.PATH = `${binDir}:${originalPath || ''}`;
    process.env.GIT_TEST_LOG = logPath;
    process.env.GIT_TEST_REPO = repo;

    const result = await createInvestigationWorktree({
      repoPath: repo,
      baseDir,
      incidentId: 'fleetinc_test',
    });

    assert.equal(result.repoPath, repo);
    assert.equal(result.worktreePath, join(baseDir, 'worktrees', 'fleetinc_test', 'BusinessOS'));
    assert.equal(result.branch, 'dueno-fleet/fleetinc_test');
    assert.equal(result.sourceBranch, 'main');
    assert.equal(result.sourceHead, 'abc123');
    await stat(result.worktreePath);
    const log = await readFile(logPath, 'utf8');
    assert.match(log, /worktree add -b dueno-fleet\/fleetinc_test/);
    assert.doesNotMatch(log, /\bcommit\b/);
    assert.doesNotMatch(log, /\bpush\b/);
    assert.doesNotMatch(log, /\bfetch\b/);
  });

  it('creates GitHub issue worktrees from the fetched remote default branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-github-issue-worktree-test-'));
    tempDirs.push(root);
    const binDir = join(root, 'bin');
    const repo = join(root, 'BusinessOS');
    const baseDir = join(root, 'github-agents');
    const logPath = join(root, 'git.log');
    await mkdir(binDir, { recursive: true });
    await mkdir(repo, { recursive: true });
    await writeFile(join(binDir, 'git'), [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$GIT_TEST_LOG"',
      'if [ "$3" = "rev-parse" ] && [ "$4" = "--show-toplevel" ]; then printf "%s\\n" "$GIT_TEST_REPO"; exit 0; fi',
      'if [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then echo abc123; exit 0; fi',
      'if [ "$3" = "branch" ] && [ "$4" = "--show-current" ]; then echo stale-feature; exit 0; fi',
      'if [ "$3" = "ls-remote" ]; then printf "ref: refs/heads/main\\tHEAD\\n"; exit 0; fi',
      'if [ "$3" = "fetch" ] && [ "$6" = "main" ]; then exit 0; fi',
      'if [ "$3" = "rev-parse" ] && [ "$4" = "--verify" ] && [ "$5" = "origin/main^{commit}" ]; then echo def456; exit 0; fi',
      'if [ "$3" = "worktree" ] && [ "$4" = "add" ]; then mkdir -p "$7"; exit 0; fi',
      'exit 2',
      '',
    ].join('\n'));
    await chmod(join(binDir, 'git'), 0o755);
    process.env.PATH = `${binDir}:${originalPath || ''}`;
    process.env.GIT_TEST_LOG = logPath;
    process.env.GIT_TEST_REPO = repo;

    const result = await createGithubIssueWorktree({
      repoPath: repo,
      baseDir,
      repoId: 'octocat/BusinessOS',
      issueNumber: 184,
      itemId: '1782235397319',
    });

    assert.equal(result.repoPath, repo);
    assert.equal(result.worktreePath, join(baseDir, 'worktrees', 'octocat-BusinessOS', 'issue-184-1782235397319', 'BusinessOS'));
    assert.equal(result.branch, 'dueno-fleet/issue/issue-184-1782235397319');
    assert.equal(result.sourceBranch, 'stale-feature');
    assert.equal(result.sourceHead, 'abc123');
    assert.equal(result.baseRef, 'origin/main');
    assert.equal(result.baseHead, 'def456');
    await stat(result.worktreePath);
    const log = await readFile(logPath, 'utf8');
    assert.match(log, /worktree add -b dueno-fleet\/issue\/issue-184-1782235397319/);
    assert.doesNotMatch(log, /\scommit(?:\s|$)/);
    assert.doesNotMatch(log, /\bpush\b/);
    assert.match(log, /fetch --quiet origin main/);
    assert.match(log, /worktree add -b .* def456/);
  });

  it('checks out a PR head while recording the fetched remote default base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-github-pr-worktree-test-'));
    tempDirs.push(root);
    const binDir = join(root, 'bin');
    const repo = join(root, 'Demo');
    const baseDir = join(root, 'github-agents');
    const logPath = join(root, 'git.log');
    await mkdir(binDir, { recursive: true });
    await mkdir(repo, { recursive: true });
    await writeFile(join(binDir, 'git'), [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$GIT_TEST_LOG"',
      'if [ "$3" = "rev-parse" ] && [ "$4" = "--show-toplevel" ]; then printf "%s\\n" "$GIT_TEST_REPO"; exit 0; fi',
      'if [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then echo stale123; exit 0; fi',
      'if [ "$3" = "branch" ] && [ "$4" = "--show-current" ]; then echo stale-feature; exit 0; fi',
      'if [ "$3" = "ls-remote" ]; then printf "ref: refs/heads/master\\tHEAD\\n"; exit 0; fi',
      'if [ "$3" = "fetch" ] && [ "$6" = "master" ]; then exit 0; fi',
      'if [ "$3" = "rev-parse" ] && [ "$5" = "origin/master^{commit}" ]; then echo base456; exit 0; fi',
      'if [ "$3" = "fetch" ] && [ "$5" = "pull/9/head" ]; then exit 0; fi',
      'if [ "$3" = "rev-parse" ] && [ "$5" = "FETCH_HEAD^{commit}" ]; then echo pr789; exit 0; fi',
      'if [ "$3" = "worktree" ] && [ "$4" = "add" ]; then mkdir -p "$7"; exit 0; fi',
      'exit 2',
      '',
    ].join('\n'));
    await chmod(join(binDir, 'git'), 0o755);
    process.env.PATH = `${binDir}:${originalPath || ''}`;
    process.env.GIT_TEST_LOG = logPath;
    process.env.GIT_TEST_REPO = repo;

    const result = await createGithubPullRequestWorktree({ repoPath: repo, baseDir, repoId: 'octo/demo', prNumber: 9, itemId: '42' });

    assert.equal(result.baseRef, 'origin/master');
    assert.equal(result.baseHead, 'base456');
    assert.equal(result.pullHead, 'pr789');
    const log = await readFile(logPath, 'utf8');
    assert.match(log, /fetch --quiet origin master/);
    assert.match(log, /worktree add -b .* pr789/);
  });

  it('reaps only old dueno-fleet worktrees under managed bases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-worktree-reap-'));
    tempDirs.push(root);
    const repo = await initRepo(root);
    const baseDir = join(root, 'managed');
    const managed = await addWorktree(repo, 'dueno-fleet/old', join(baseDir, 'worktrees', 'old', 'repo'));
    const unmanagedBranch = await addWorktree(repo, 'feature/keep', join(baseDir, 'worktrees', 'feature', 'repo'));
    const unmanagedPath = await addWorktree(repo, 'dueno-fleet/outside', join(root, 'outside', 'repo'));
    await agePath(managed);
    await agePath(unmanagedBranch);
    await agePath(unmanagedPath);

    const result = await reapWorktrees({
      enabled: true,
      sourceRepos: [repo],
      baseDirs: [baseDir],
      minAgeSec: 300,
      force: false,
      now: () => Date.now(),
    });

    assert.deepEqual(result.reaped.map((item) => item.branch), ['dueno-fleet/old']);
    await assert.rejects(stat(managed));
    await stat(unmanagedBranch);
    await stat(unmanagedPath);
    const branches = (await git(repo, ['branch', '--list'])).stdout;
    assert.doesNotMatch(branches, /dueno-fleet\/old/);
    assert.match(branches, /feature\/keep/);
    assert.match(branches, /dueno-fleet\/outside/);
  });

  it('skips too-new and dirty worktrees unless force is enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-worktree-reap-'));
    tempDirs.push(root);
    const repo = await initRepo(root);
    const baseDir = join(root, 'managed');
    const fresh = await addWorktree(repo, 'dueno-fleet/fresh', join(baseDir, 'worktrees', 'fresh', 'repo'));
    const dirty = await addWorktree(repo, 'dueno-fleet/dirty', join(baseDir, 'worktrees', 'dirty', 'repo'));
    await writeFile(join(dirty, 'dirty.txt'), 'dirty\n');
    await agePath(dirty);

    const skipped = await reapWorktrees({
      enabled: true,
      sourceRepos: [repo],
      baseDirs: [baseDir],
      minAgeSec: 300,
      force: false,
      now: () => Date.now(),
    });

    assert.equal(skipped.reaped.length, 0);
    assert.equal(skipped.skipped.some((item) => item.branch === 'dueno-fleet/fresh' && item.reason === 'too_new'), true);
    assert.equal(skipped.skipped.some((item) => item.branch === 'dueno-fleet/dirty' && item.reason === 'dirty'), true);
    await stat(fresh);
    await stat(dirty);

    const forced = await reapWorktrees({
      enabled: true,
      sourceRepos: [repo],
      baseDirs: [baseDir],
      minAgeSec: 300,
      force: true,
      now: () => Date.now(),
    });

    assert.deepEqual(forced.reaped.map((item) => item.branch), ['dueno-fleet/dirty']);
    await stat(fresh);
    await assert.rejects(stat(dirty));
  });

  it('respects disabled state and per-pass cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-worktree-reap-'));
    tempDirs.push(root);
    const repo = await initRepo(root);
    const baseDir = join(root, 'managed');
    const one = await addWorktree(repo, 'dueno-fleet/one', join(baseDir, 'worktrees', 'one', 'repo'));
    const two = await addWorktree(repo, 'dueno-fleet/two', join(baseDir, 'worktrees', 'two', 'repo'));
    await agePath(one);
    await agePath(two);

    const disabled = await reapWorktrees({ enabled: false, sourceRepos: [repo], baseDirs: [baseDir], minAgeSec: 0 });
    assert.equal(disabled.reaped.length, 0);
    await stat(one);
    await stat(two);

    const capped = await reapWorktrees({
      enabled: true,
      sourceRepos: [repo],
      baseDirs: [baseDir],
      minAgeSec: 0,
      maxPerPass: 1,
      force: true,
    });

    assert.equal(capped.reaped.length, 1);
    assert.equal(capped.skipped.some((item) => item.reason === 'cap_reached'), true);
  });

  it('force-removes a managed worktree, deletes its branch, and prunes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-worktree-remove-'));
    tempDirs.push(root);
    const repo = await initRepo(root);
    const worktreePath = join(root, 'worktrees', 'session', 'repo');
    await addWorktree(repo, 'dueno-fleet/session-1', worktreePath);

    const result = await removeAgentSessionWorktree({
      repoPath: repo,
      worktreePath,
      branch: 'dueno-fleet/session-1',
      force: true,
    });

    assert.equal(result.removed, true);
    assert.equal(result.pruned, true);
    const list = await git(repo, ['worktree', 'list', '--porcelain']);
    assert.equal(list.stdout.includes(worktreePath), false);
    const branches = await git(repo, ['branch', '--list', 'dueno-fleet/session-1']);
    assert.equal(String(branches.stdout || '').trim(), '');
  });
});
