import { cp, lstat, mkdir, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { exec } from '../../lib/exec.mjs';
import { safeWorktreeName, resolveOriginBaseRef } from '../fleet/git-worktree.mjs';

export const managedWorktreeBase = resolve(homedir(), '.cadre', 'worktrees', 'collab');
export const worktreeSchema = { type: 'object', required: ['repo', 'branch'], additionalProperties: false,
  properties: { repo: { type: 'string', minLength: 1 }, branch: { type: 'string', minLength: 1 }, base: { type: 'string', minLength: 1 } } };
const inside = (root, path) => { const rel = relative(resolve(root), resolve(path)); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'); };
async function git(repo, args, input) {
  const result = await exec('git', ['-C', repo, ...args], { input });
  if (result.code !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.replace(/\n$/, '');
}
// Reads the base commit, not the possibly stale local checkout; creation records its cleanup policy for later cleanup.
async function configFor(repo, ref) {
  if (!await git(repo, ['ls-tree', '--name-only', ref, '--', '.cadre/worktree.json'])) return null;
  const text = await git(repo, ['show', `${ref}:.cadre/worktree.json`]);
  const config = JSON.parse(text);
  if (!config || !['off', 'on-merge'].includes(config.cleanup ?? 'off') || !['operator', 'reviewer'].includes(config.merge ?? 'operator')
    || (config.setup !== undefined && typeof config.setup !== 'string')
    || (config.copy !== undefined && (!Array.isArray(config.copy) || config.copy.some((file) => typeof file !== 'string' || !file || isAbsolute(file) || !inside(repo, resolve(repo, file)))))) throw new Error('invalid worktree config');
  return config;
}
async function ignored(path, exclusions = []) {
  const files = (await git(path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', '.', ':(exclude)node_modules', ...exclusions])).split('\0').filter(Boolean);
  const nodeModules = resolve(path, 'node_modules');
  const info = await lstat(nodeModules).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  if (info && !await git(path, ['ls-files', '--', 'node_modules'])
    && (await exec('git', ['-C', path, 'check-ignore', '--', 'node_modules'])).code === 0) files.push('node_modules');
  else if (info?.isSymbolicLink() && !inside(path, await realpath(nodeModules))) files.push('node_modules');
  return files;
}
const markerPath = async (path) => resolve(path, await git(path, ['rev-parse', '--git-dir']), 'cadre-room.json');

export async function createManagedWorktree({ repo, branch, base, roomId, baseDir = managedWorktreeBase, setupTimeoutMs = 120000 }) {
  repo = await git(repo, ['rev-parse', '--show-toplevel']);
  if (!roomId || !branch || branch.startsWith('-') || base?.startsWith('-')) throw new Error('invalid worktree arguments');
  await git(repo, ['check-ref-format', '--branch', branch]);
  await git(repo, ['fetch', 'origin']);
  base ||= (await resolveOriginBaseRef(repo)).baseRef;
  const baseHead = await git(repo, ['rev-parse', '--verify', `${base}^{commit}`]);
  const config = await configFor(repo, baseHead);
  if (!config) throw new Error(`${repo} has no .cadre/worktree.json at ${base}; managed worktrees require the repo to opt in`);
  const path = resolve(baseDir, roomId, safeWorktreeName(repo));
  if (!inside(baseDir, path) || !inside(resolve(baseDir, roomId), path)) throw new Error('invalid room id');
  await mkdir(dirname(path), { recursive: true });
  await git(repo, ['worktree', 'add', '--lock', '--reason', `cadre room ${roomId}`, '-b', branch, path, baseHead]);
  const metadata = { path, repo, branch, base, baseHead, roomId, cleanup: config.cleanup ?? 'off', merge: config.merge ?? 'operator' };
  try {
    await writeFile(await markerPath(path), JSON.stringify(metadata));
    for (const file of config.copy || []) {
      await git(repo, ['check-ignore', '--', file]);
      const source = resolve(repo, file), target = resolve(path, file);
      await mkdir(dirname(target), { recursive: true });
      if (!inside(repo, await realpath(source)) || !inside(path, await realpath(dirname(target)))) throw new Error('copy path escapes repository');
      await cp(source, target, { recursive: true, dereference: false });
    }
    if (config.setup) {
      const setup = await exec('timeout', ['-k', '5s', `${setupTimeoutMs / 1000}s`, 'bash', '-c', config.setup], { cwd: path, timeout: setupTimeoutMs + 10000,
        env: { CADRE_WORKTREE_PATH: path, CADRE_REPO_ROOT: repo } });
      if (setup.code !== 0) throw new Error('worktree setup failed');
    }
    metadata.ignoredBaseline = await ignored(path);
    await writeFile(await markerPath(path), JSON.stringify(metadata));
    return metadata;
  } catch (error) {
    try { await rollbackManagedWorktree({ repo, path, branch, baseHead }); }
    catch (rollbackError) { error.rollbackError = rollbackError.message; }
    throw error;
  }
}

async function rollbackManagedWorktree({ repo, path, branch, baseHead }) {
  // Only fresh worktrees with no launched participants use force: setup may leave files.
  await git(repo, ['worktree', 'unlock', path]);
  await unlinkExternalLinks(path);
  await git(repo, ['worktree', 'remove', '--force', path]);
  await git(repo, ['update-ref', '-d', `refs/heads/${branch}`, baseHead]);
  await git(repo, ['worktree', 'prune']);
}

export async function cleanupManagedWorktree(metadata, { getPr, rooms = [], sessions = [], baseDir = managedWorktreeBase, spawnFailed = false } = {}) {
  const keep = (reason) => ({ removed: false, reason, report: `worktree: kept (${reason})` });
  try {
    const { path, repo, branch, baseHead, roomId, ignoredBaseline, cleanup } = metadata || {};
    if (!path || !repo || !branch || !baseHead || !roomId || !Array.isArray(ignoredBaseline) || !inside(baseDir, path)) return keep('missing or invalid metadata');
    const marker = JSON.parse(await readFile(await markerPath(path), 'utf8'));
    if (marker.path !== path || marker.repo !== repo || marker.branch !== branch || marker.roomId !== roomId || marker.cleanup !== cleanup
      || marker.baseHead !== baseHead || JSON.stringify(marker.ignoredBaseline) !== JSON.stringify(ignoredBaseline)
      || await git(path, ['branch', '--show-current']) !== branch) return keep('missing or invalid metadata');
    // Undoing an untouched failed spawn is independent of the policy recorded at creation; legacy metadata has none and is kept.
    if (!spawnFailed && cleanup !== 'on-merge') return keep(cleanup ? 'cleanup off' : 'cleanup policy not recorded');
    const head = await git(path, ['rev-parse', 'HEAD']);
    if (spawnFailed) {
      if (head !== baseHead) return keep('local commits after failed spawn');
    } else {
      const pr = await getPr?.(metadata);
      if (!pr?.merged || !pr.head?.sha || !pr.number) return keep('PR not merged');
      await git(repo, ['fetch', 'origin', `pull/${pr.number}/head`]);
      const prHead = await git(repo, ['rev-parse', '--verify', `${pr.head.sha}^{commit}`]);
      if (await git(repo, ['rev-parse', 'FETCH_HEAD']) !== prHead) return keep('PR head changed during fetch');
      const ancestor = await exec('git', ['-C', repo, 'merge-base', '--is-ancestor', head, prHead]);
      if (![0, 1].includes(ancestor.code)) throw new Error('ancestry check failed');
      let contained = ancestor.code === 0;
      if (!contained) {
        const commits = (await git(path, ['rev-list', `${baseHead}..HEAD`])).split('\n').filter(Boolean);
        const patches = async (commits) => {
          const ids = [];
          for (const commit of commits) {
            const patch = await git(repo, ['show', '--pretty=format:', '--no-ext-diff', commit]);
            const id = (await git(repo, ['patch-id', '--stable'], patch)).split(' ')[0];
            if (!id) throw new Error('commit has no patch id');
            ids.push(id);
          }
          return ids;
        };
        const prCommits = (await git(repo, ['rev-list', `${baseHead}..${prHead}`])).split('\n').filter(Boolean);
        const prIds = new Set(await patches(prCommits));
        contained = commits.length > 0 && (await patches(commits)).every((id) => prIds.has(id));
      }
      const unpushed = await git(path, ['log', '--format=%H', 'HEAD', '--not', '--remotes']);
      if (!contained) return keep(unpushed ? 'unpushed commits not in PR' : 'local commits not in PR');
    }
    const busDir = await lstat(resolve(path, '.agent_bus')).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    const ownedBus = (!busDir || (busDir.isDirectory() && !busDir.isSymbolicLink())) && !await git(path, ['ls-files', '--', '.agent_bus']);
    const exclusions = ownedBus ? [':(exclude).agent_bus/hooks', ':(exclude).agent_bus/state'] : [];
    const status = (await git(path, ['-c', 'status.showUntrackedFiles=all', 'status', '--porcelain', '--untracked-files=all', '-z', '--', '.', ...exclusions])).split('\0').filter(Boolean);
    for (const entry of status) {
      if (entry === '?? node_modules' && ignoredBaseline.includes('node_modules')
        && (await lstat(resolve(path, 'node_modules'))).isSymbolicLink()
        && !inside(path, await realpath(resolve(path, 'node_modules')))) continue;
      return keep('dirty or untracked files');
    }
    if ((await ignored(path, exclusions)).some((file) => !ignoredBaseline.includes(file))) return keep('new ignored files');
    const canonicalPath = await realpath(path);
    const canonicalDir = async (dir) => {
      try { return await realpath(dir); }
      catch (error) { if (error.code !== 'ENOENT') throw error; return resolve(dir); }
    };
    const dirs = [...rooms.filter((room) => room.id !== roomId && room.status === 'open').flatMap((room) =>
      [room.metadata?.worktree?.path, room.projectKey, ...(room.participants || []).map((p) => p.workDir)]),
      ...sessions.filter((session) => session.lifecycle !== 'ended').map((session) => session.workDir)].filter(Boolean);
    for (const dir of dirs) if (inside(canonicalPath, await canonicalDir(dir))) return keep('shared with another room or live session');
    await git(repo, ['worktree', 'unlock', path]);
    try {
      await unlinkExternalLinks(path);
      if (ownedBus) for (const dir of ['hooks', 'state']) await rm(resolve(path, '.agent_bus', dir), { recursive: true, force: true });
      await git(repo, ['worktree', 'remove', path]);
    } catch (error) {
      await git(repo, ['worktree', 'lock', '--reason', `cadre room ${roomId}`, path]);
      throw error;
    }
    const deletion = await exec('git', ['-C', repo, ...(spawnFailed ? ['update-ref', '-d', `refs/heads/${branch}`, baseHead] : ['branch', '-d', branch])]);
    await git(repo, ['worktree', 'prune']);
    return { removed: true, branchKept: deletion.code !== 0, report: `worktree: removed${deletion.code !== 0 ? ` (branch kept: ${deletion.stderr.trim()})` : ''}` };
  } catch (error) { return keep(error.message); }
}

export async function sweepManagedWorktrees({ baseDir = managedWorktreeBase, getRoom, cleanup, log }) {
  let entries;
  try { entries = await readdir(baseDir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const room of entries.filter((entry) => entry.isDirectory())) {
    let repos;
    try { repos = await readdir(resolve(baseDir, room.name), { withFileTypes: true }); }
    catch (error) { log?.warn?.({ room: room.name, error: error.message }, 'Managed worktree orphan kept'); continue; }
    for (const repo of repos) {
      if (!repo.isDirectory()) continue;
      const path = resolve(baseDir, room.name, repo.name);
      try {
        const metadata = JSON.parse(await readFile(await markerPath(path), 'utf8'));
        const thread = getRoom(metadata.roomId);
        if (metadata.path !== path || metadata.roomId !== room.name || thread?.status === 'open') continue;
        if (thread && !thread.metadata?.worktree) throw new Error('missing room worktree metadata');
        const result = await cleanup(thread?.metadata?.worktree || metadata);
        log?.info?.({ path, report: result.report }, 'Managed worktree orphan sweep');
      } catch (error) { log?.warn?.({ path, error: error.message }, 'Managed worktree orphan kept'); }
    }
  }
}

async function unlinkExternalLinks(path) {
  for (const entry of await readdir(path)) {
    const file = resolve(path, entry);
    if ((await lstat(file)).isSymbolicLink() && !inside(path, await realpath(file))
      && !await git(path, ['ls-files', '-z', '--', entry])) await unlink(file);
  }
}

export async function linkManagedWorktreePr(metadata, pr) {
  const next = { ...metadata, pr };
  await writeFile(await markerPath(metadata.path), JSON.stringify(next));
  return next;
}
