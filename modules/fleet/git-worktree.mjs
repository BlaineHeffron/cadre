import { lstat, mkdir, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { exec } from '../../lib/exec.mjs';

function normalizeText(value) {
  return String(value || '').trim();
}

export function safeWorktreeName(repoPath = '') {
  const base = basename(resolve(normalizeText(repoPath) || '.'));
  return base.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
}

async function assertDirectory(path) {
  const info = await stat(path);
  if (!info.isDirectory()) throw new Error('not_directory');
}

async function git(repoPath, args) {
  const result = await exec('git', ['-C', repoPath, ...args]);
  if (result.code !== 0) {
    const error = new Error('git_command_failed');
    error.stderr = result.stderr;
    error.code = 'git_command_failed';
    throw error;
  }
  return normalizeText(result.stdout);
}

function safeBranchPart(value = '') {
  return normalizeText(value)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export async function resolveOriginBaseRef(repoRoot) {
  const remoteHead = await exec('git', ['-C', repoRoot, 'ls-remote', '--symref', 'origin', 'HEAD']).catch(() => null);
  const defaultBranch = normalizeText(remoteHead?.stdout).match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m)?.[1] || '';
  const refs = defaultBranch ? [defaultBranch] : ['main', 'master'];
  for (const ref of refs) {
    const fetch = await exec('git', ['-C', repoRoot, 'fetch', '--quiet', 'origin', ref]).catch(() => null);
    if (!fetch || fetch.code !== 0) continue;
    const remoteRef = `origin/${ref}`;
    try {
      const baseHead = await git(repoRoot, ['rev-parse', '--verify', `${remoteRef}^{commit}`]);
      return { baseRef: remoteRef, baseHead };
    } catch {
      // Try the next conventional default branch.
    }
  }
  const error = new Error('origin_base_ref_missing');
  error.code = 'origin_base_ref_missing';
  throw error;
}

export async function createAgentSessionWorktree({
  repoPath,
  baseDir,
  displayName = '',
  branchPrefix = 'dueno-fleet/agent',
  nowMs = Date.now(),
} = {}) {
  const source = resolve(normalizeText(repoPath));
  const base = resolve(normalizeText(baseDir));
  if (!source || !base) throw new Error('worktree_args_required');
  await assertDirectory(source);

  const repoRoot = await git(source, ['rev-parse', '--show-toplevel']);
  const sourceHead = await git(repoRoot, ['rev-parse', 'HEAD']);
  const sourceBranch = await git(repoRoot, ['branch', '--show-current']).catch(() => 'HEAD');
  const { baseRef, baseHead } = await resolveOriginBaseRef(repoRoot);
  const repoName = safeWorktreeName(repoRoot);
  const label = safeBranchPart(displayName) || 'session';
  const suffix = `${label}-${Math.max(0, Number(nowMs) || Date.now()).toString(36)}`;
  const branch = `${branchPrefix}/${suffix}`;
  const worktreePath = resolve(base, 'worktrees', 'agents', suffix, repoName);

  await mkdir(resolve(base, 'worktrees', 'agents', suffix), { recursive: true });
  const add = await exec('git', ['-C', repoRoot, 'worktree', 'add', '-b', branch, worktreePath, baseHead]);
  if (add.code !== 0) {
    const error = new Error('worktree_create_failed');
    error.code = 'worktree_create_failed';
    error.stderr = add.stderr;
    throw error;
  }

  return {
    repoPath: repoRoot,
    worktreePath,
    branch,
    baseRef,
    baseHead,
    sourceBranch,
    sourceHead,
    repoName,
  };
}

export async function createInvestigationWorktree({
  repoPath,
  baseDir,
  incidentId,
  branchPrefix = 'dueno-fleet',
} = {}) {
  const source = resolve(normalizeText(repoPath));
  const base = resolve(normalizeText(baseDir));
  const incident = normalizeText(incidentId);
  if (!source || !base || !incident) throw new Error('worktree_args_required');
  await assertDirectory(source);

  const repoRoot = await git(source, ['rev-parse', '--show-toplevel']);
  const sourceHead = await git(repoRoot, ['rev-parse', 'HEAD']);
  const sourceBranch = await git(repoRoot, ['branch', '--show-current']).catch(() => 'HEAD');
  const repoName = safeWorktreeName(repoRoot);
  const branch = `${branchPrefix}/${incident}`;
  const worktreePath = resolve(base, 'worktrees', incident, repoName);

  await mkdir(resolve(base, 'worktrees', incident), { recursive: true });
  const add = await exec('git', ['-C', repoRoot, 'worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
  if (add.code !== 0) {
    const error = new Error('worktree_create_failed');
    error.code = 'worktree_create_failed';
    error.stderr = add.stderr;
    throw error;
  }

  return {
    repoPath: repoRoot,
    worktreePath,
    branch,
    sourceBranch,
    sourceHead,
    repoName,
  };
}

export async function createGithubPullRequestWorktree({
  repoPath,
  baseDir,
  repoId,
  prNumber,
  itemId = '',
  branchPrefix = 'dueno-fleet',
} = {}) {
  const source = resolve(normalizeText(repoPath));
  const base = resolve(normalizeText(baseDir));
  const repoKey = normalizeText(repoId).replace(/[^a-zA-Z0-9._-]+/g, '-');
  const pr = Number(prNumber);
  const suffix = normalizeText(itemId).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 32) || `${Date.now()}`;
  if (!source || !base || !repoKey || !Number.isInteger(pr) || pr < 1) throw new Error('worktree_args_required');
  await assertDirectory(source);

  const repoRoot = await git(source, ['rev-parse', '--show-toplevel']);
  const sourceHead = await git(repoRoot, ['rev-parse', 'HEAD']);
  const sourceBranch = await git(repoRoot, ['branch', '--show-current']).catch(() => 'HEAD');
  const { baseRef, baseHead } = await resolveOriginBaseRef(repoRoot);
  const repoName = safeWorktreeName(repoRoot);
  const branch = `${branchPrefix}/pr-${pr}-${suffix}`;
  const worktreePath = resolve(base, 'worktrees', repoKey, `pr-${pr}-${suffix}`, repoName);

  const fetch = await exec('git', ['-C', repoRoot, 'fetch', 'origin', `pull/${pr}/head`]);
  if (fetch.code !== 0) {
    const error = new Error('github_pr_fetch_failed');
    error.code = 'github_pr_fetch_failed';
    error.stderr = fetch.stderr;
    throw error;
  }
  const pullHead = await git(repoRoot, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);

  await mkdir(resolve(base, 'worktrees', repoKey, `pr-${pr}-${suffix}`), { recursive: true });
  const add = await exec('git', ['-C', repoRoot, 'worktree', 'add', '-b', branch, worktreePath, pullHead]);
  if (add.code !== 0) {
    const error = new Error('worktree_create_failed');
    error.code = 'worktree_create_failed';
    error.stderr = add.stderr;
    throw error;
  }

  return {
    repoPath: repoRoot,
    worktreePath,
    branch,
    baseRef,
    baseHead,
    pullHead,
    sourceBranch,
    sourceHead,
    repoName,
  };
}

export async function createGithubIssueWorktree({
  repoPath,
  baseDir,
  repoId,
  issueNumber,
  itemId = '',
  branchPrefix = 'dueno-fleet/issue',
} = {}) {
  const source = resolve(normalizeText(repoPath));
  const base = resolve(normalizeText(baseDir));
  const repoKey = normalizeText(repoId).replace(/[^a-zA-Z0-9._-]+/g, '-');
  const issue = Number(issueNumber);
  const suffix = normalizeText(itemId).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 32) || `${Date.now()}`;
  if (!source || !base || !repoKey || !Number.isInteger(issue) || issue < 1) throw new Error('worktree_args_required');
  await assertDirectory(source);

  const repoRoot = await git(source, ['rev-parse', '--show-toplevel']);
  const sourceHead = await git(repoRoot, ['rev-parse', 'HEAD']);
  const sourceBranch = await git(repoRoot, ['branch', '--show-current']).catch(() => 'HEAD');
  const { baseRef, baseHead } = await resolveOriginBaseRef(repoRoot);
  const repoName = safeWorktreeName(repoRoot);
  const issueKey = `issue-${issue}-${suffix}`;
  const branch = `${branchPrefix}/${issueKey}`;
  const worktreePath = resolve(base, 'worktrees', repoKey, issueKey, repoName);

  await mkdir(resolve(base, 'worktrees', repoKey, issueKey), { recursive: true });
  const add = await exec('git', ['-C', repoRoot, 'worktree', 'add', '-b', branch, worktreePath, baseHead]);
  if (add.code !== 0) {
    const error = new Error('worktree_create_failed');
    error.code = 'worktree_create_failed';
    error.stderr = add.stderr;
    throw error;
  }

  return {
    repoPath: repoRoot,
    worktreePath,
    branch,
    baseRef,
    baseHead,
    sourceBranch,
    sourceHead,
    repoName,
  };
}

export async function reapWorktrees({
  enabled = false,
  sourceRepos = [],
  baseDirs = [],
  minAgeSec = 300,
  maxPerPass = 20,
  force = false,
  now = () => Date.now(),
  log = null,
} = {}) {
  const managedBases = [...new Set((baseDirs || [])
    .map((baseDir) => normalizeText(baseDir))
    .filter(Boolean)
    .map((baseDir) => resolve(baseDir, 'worktrees')))];
  const repos = [...new Set((sourceRepos || []).map((repo) => normalizeText(repo)).filter(Boolean).map((repo) => resolve(repo)))];
  const minAgeMs = Math.max(0, Number(minAgeSec || 0)) * 1000;
  const cap = Math.max(1, Number(maxPerPass || 20));
  const summary = { enabled: enabled === true, reaped: [], skipped: [], errors: [] };
  if (enabled !== true || repos.length === 0 || managedBases.length === 0) return summary;

  for (const sourceRepo of repos) {
    let repoRoot = '';
    try {
      repoRoot = await git(sourceRepo, ['rev-parse', '--show-toplevel']);
      const output = await git(repoRoot, ['worktree', 'list', '--porcelain']);
      const entries = parseWorktreePorcelain(output);
      for (const entry of entries) {
        if (summary.reaped.length >= cap) {
          summary.skipped.push({ path: entry.path, branch: entry.branch, reason: 'cap_reached' });
          continue;
        }
        const decision = await shouldReapWorktree(entry, { managedBases, minAgeMs, force, now });
        if (!decision.reap) {
          summary.skipped.push({ path: entry.path, branch: entry.branch, reason: decision.reason, ageMs: decision.ageMs });
          continue;
        }
        await removeWorktree(repoRoot, entry, { force });
        const reaped = { path: entry.path, branch: entry.branch, ageMs: decision.ageMs };
        summary.reaped.push(reaped);
        if (log?.info) log.info(reaped, 'Reaped dueno-fleet worktree');
      }
    } catch (error) {
      const item = { repoPath: sourceRepo, code: normalizeText(error?.code || error?.message || 'worktree_reap_failed') };
      summary.errors.push(item);
      if (log?.warn) log.warn(item, 'Worktree reap failed');
    }
  }
  return summary;
}

function parseWorktreePorcelain(output = '') {
  const entries = [];
  let current = null;
  for (const line of String(output || '').split('\n')) {
    if (!line.trim()) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(' ');
    const value = rest.join(' ').trim();
    if (key === 'worktree') {
      if (current) entries.push(current);
      current = { path: value, branch: '' };
    } else if (key === 'branch' && current) {
      current.branch = value.replace(/^refs\/heads\//, '');
    }
  }
  if (current) entries.push(current);
  return entries;
}

async function shouldReapWorktree(entry, { managedBases, minAgeMs, force, now }) {
  const path = resolve(normalizeText(entry.path));
  const branch = normalizeText(entry.branch);
  if (!branch.startsWith('dueno-fleet/')) return { reap: false, reason: 'branch_not_managed' };
  if (!isUnderAnyBase(path, managedBases)) return { reap: false, reason: 'path_not_managed' };
  let info;
  try {
    info = await stat(path);
  } catch {
    return { reap: false, reason: 'path_missing' };
  }
  const ageMs = Math.max(0, Number(now()) - Number(info.mtimeMs || 0));
  if (ageMs < minAgeMs) return { reap: false, reason: 'too_new', ageMs };
  const status = await exec('git', ['-C', path, 'status', '--porcelain']);
  if (status.code !== 0) return { reap: false, reason: 'status_failed', ageMs };
  if (normalizeText(status.stdout) && force !== true) return { reap: false, reason: 'dirty', ageMs };
  return { reap: true, ageMs };
}

function isUnderAnyBase(path, bases) {
  return bases.some((base) => {
    const rel = relative(base, path);
    return rel && !rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\');
  });
}

async function removeWorktree(repoRoot, entry, { force }) {
  const removeArgs = ['-C', repoRoot, 'worktree', 'remove'];
  if (force) removeArgs.push('--force');
  removeArgs.push(entry.path);
  const remove = await exec('git', removeArgs);
  if (remove.code !== 0) {
    const error = new Error('worktree_remove_failed');
    error.code = 'worktree_remove_failed';
    error.stderr = remove.stderr;
    throw error;
  }
  const branchDelete = await exec('git', ['-C', repoRoot, 'branch', '-D', entry.branch]);
  if (branchDelete.code !== 0) {
    const error = new Error('worktree_branch_delete_failed');
    error.code = 'worktree_branch_delete_failed';
    error.stderr = branchDelete.stderr;
    throw error;
  }
}

// Fail closed: a branch other than the one to delete, changes outside Cadre's untracked hook state,
// commits on no remote-tracking ref or PR head, or any error (including a missing worktree) keep it.
async function unpushedWorktreeReason(path, branch, pullRequest) {
  try {
    if (branch && await git(path, ['branch', '--show-current']) !== branch) return 'branch changed';
    const bus = await lstat(resolve(path, '.agent_bus')).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    const ownedBus = (!bus || (bus.isDirectory() && !bus.isSymbolicLink())) && !await git(path, ['ls-files', '--', '.agent_bus']);
    const exclusions = ownedBus ? [':(exclude).agent_bus/hooks', ':(exclude).agent_bus/state'] : [];
    if (await git(path, ['status', '--porcelain', '--untracked-files=all', '--', '.', ...exclusions])) return 'uncommitted changes';
    // FETCH_HEAD is per worktree, so fetches elsewhere in the repository cannot move it.
    if (pullRequest) await git(path, ['fetch', '--quiet', 'origin', `pull/${pullRequest}/head`]);
    if (await git(path, ['log', '--format=%H', 'HEAD', '--not', '--remotes', ...(pullRequest ? ['FETCH_HEAD'] : [])])) return 'unpushed commits';
    return '';
  } catch (error) {
    return error.code || error.message;
  }
}

export async function removeAgentSessionWorktree({
  repoPath = '',
  worktreePath = '',
  branch = '',
  force = true,
  keepUnpushed = false,
  pullRequest = 0,
} = {}) {
  const source = normalizeText(repoPath);
  const path = normalizeText(worktreePath);
  const branchName = normalizeText(branch);
  if (!source || !path) return { removed: false, skipped: true, reason: 'missing_worktree_metadata' };
  if (keepUnpushed) {
    const reason = await unpushedWorktreeReason(path, branchName, Number(pullRequest) || 0);
    if (reason) return { removed: false, kept: true, path, reason };
  }

  const repoRoot = await git(source, ['rev-parse', '--show-toplevel']);
  const removeArgs = ['-C', repoRoot, 'worktree', 'remove'];
  if (force) removeArgs.push('--force');
  removeArgs.push(path);
  const remove = await exec('git', removeArgs);
  if (remove.code !== 0 && !/not a working tree|is not a working tree|No such file|does not exist/i.test(remove.stderr || '')) {
    const error = new Error('worktree_remove_failed');
    error.code = 'worktree_remove_failed';
    error.stderr = remove.stderr;
    throw error;
  }

  if (branchName && branchName.startsWith('dueno-fleet/')) {
    const branchDelete = await exec('git', ['-C', repoRoot, 'branch', '-D', branchName]);
    if (branchDelete.code !== 0 && !/not found|branch .* not found|not a branch/i.test(branchDelete.stderr || '')) {
      const error = new Error('worktree_branch_delete_failed');
      error.code = 'worktree_branch_delete_failed';
      error.stderr = branchDelete.stderr;
      throw error;
    }
  }

  const prune = await exec('git', ['-C', repoRoot, 'worktree', 'prune']);
  await rmdir(dirname(path)).catch((error) => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  });

  return {
    removed: true,
    path,
    branch: branchName || null,
    pruned: prune.code === 0,
  };
}
