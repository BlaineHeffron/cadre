import { basename } from 'node:path';

const EXECUTABLE_SCAN_TOKEN_LIMIT = 6;

export function classifyExecutableArgs(args = '') {
  const tokens = String(args || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { cli: '', provider: '', runtime: '' };

  for (const [index, token] of tokens.slice(0, EXECUTABLE_SCAN_TOKEN_LIMIT).entries()) {
    const name = basename(stripQuotes(token)).toLowerCase();
    if (name === 'claude') return { cli: 'claude', provider: 'anthropic', runtime: 'claude' };
    if (name === 'codex') return { cli: 'codex', provider: 'openai', runtime: 'codex' };
    if (name === 'pi') return { cli: 'pi', provider: piProviderFromArgs(tokens.slice(index + 1)), runtime: 'pi' };
  }

  return { cli: '', provider: '', runtime: '' };
}

function piProviderFromArgs(tokens = []) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = stripQuotes(tokens[index]);
    const inline = token.match(/^--provider=(.+)$/);
    const value = inline?.[1] || (token === '--provider' ? stripQuotes(tokens[index + 1]) : '');
    const provider = String(value || '').trim().toLowerCase();
    if (['xai', 'google', 'opencode-go', 'openrouter'].includes(provider)) return provider;
  }
  return '';
}

export async function classifyTmuxSession(execFn, sessionName) {
  const { stdout, code } = await execFn('tmux', [
    'list-panes', '-s', '-t', sessionName, '-F', '#{pane_pid}',
  ]);
  if (code !== 0 || !String(stdout || '').trim()) return { cli: '', provider: '', runtime: '' };
  const panePid = String(stdout).trim().split('\n')[0];
  return classifyProcessTree(execFn, panePid);
}

export async function classifyProcessTrees(execFn, roots, { maxDepth = 8 } = {}) {
  const normalizedRoots = roots instanceof Map ? roots : new Map(Object.entries(roots || {}));
  if (normalizedRoots.size === 0) return new Map();

  const snapshot = await readProcessSnapshot(execFn);
  if (!snapshot) return null;

  return new Map(Array.from(normalizedRoots)
    .filter(([, rootPid]) => snapshot.argsByPid.has(String(rootPid || '').trim()))
    .map(([key, rootPid]) => [
      key,
      classifyProcessTreeSnapshot(snapshot, rootPid, { maxDepth }),
    ]));
}

export async function classifyProcessTree(execFn, rootPid, { maxDepth = 8 } = {}) {
  const pending = [{ pid: String(rootPid || '').trim(), depth: 0 }];
  const visited = new Set();

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current.pid || visited.has(current.pid) || current.depth > maxDepth) continue;
    visited.add(current.pid);

    const args = await processArgs(execFn, current.pid);
    const classification = classifyExecutableArgs(args);
    if (classification.cli) return classification;

    for (const child of await childProcesses(execFn, current.pid)) {
      pending.push({ pid: child.pid, depth: current.depth + 1 });
    }
  }

  return { cli: '', provider: '', runtime: '' };
}

export async function collectDescendantPids(execFn, rootPid, { maxDepth = 12 } = {}) {
  const pids = new Set();
  const pending = [{ pid: String(rootPid || '').trim(), depth: 0 }];

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current.pid || pids.has(current.pid) || current.depth > maxDepth) continue;
    pids.add(current.pid);
    for (const child of await childProcesses(execFn, current.pid)) {
      pending.push({ pid: child.pid, depth: current.depth + 1 });
    }
  }

  return pids;
}

export async function collectTmuxProcessTreePids(execFn) {
  const pids = new Set();
  const { stdout, code } = await execFn('tmux', ['list-panes', '-a', '-F', '#{pane_pid}']);
  if (code !== 0 || !String(stdout || '').trim()) return pids;

  const panePids = String(stdout).trim().split('\n').filter(Boolean);
  const snapshot = await readProcessSnapshot(execFn);
  if (!snapshot) {
    for (const pid of panePids) {
      for (const descendant of await collectDescendantPids(execFn, pid)) {
        pids.add(descendant);
      }
    }
    return pids;
  }

  for (const pid of panePids) {
    if (snapshot.argsByPid.has(String(pid || '').trim())) {
      collectDescendantPidsFromSnapshot(snapshot, pid, pids);
      continue;
    }
    for (const descendant of await collectDescendantPids(execFn, pid)) {
      pids.add(descendant);
    }
  }

  return pids;
}

function classifyProcessTreeSnapshot(snapshot, rootPid, { maxDepth = 8 } = {}) {
  const pending = [{ pid: String(rootPid || '').trim(), depth: 0 }];
  const visited = new Set();

  while (pending.length > 0) {
    const current = pending.shift();
    if (!current.pid || visited.has(current.pid) || current.depth > maxDepth) continue;
    visited.add(current.pid);

    const classification = classifyExecutableArgs(snapshot.argsByPid.get(current.pid) || '');
    if (classification.cli) return classification;

    for (const childPid of snapshot.childrenByPid.get(current.pid) || []) {
      pending.push({ pid: childPid, depth: current.depth + 1 });
    }
  }

  return { cli: '', provider: '', runtime: '' };
}

function collectDescendantPidsFromSnapshot(snapshot, rootPid, target, { maxDepth = 12 } = {}) {
  const pending = [{ pid: String(rootPid || '').trim(), depth: 0 }];
  while (pending.length > 0) {
    const current = pending.shift();
    if (!current.pid || target.has(current.pid) || current.depth > maxDepth) continue;
    target.add(current.pid);
    for (const childPid of snapshot.childrenByPid.get(current.pid) || []) {
      pending.push({ pid: childPid, depth: current.depth + 1 });
    }
  }
}

async function readProcessSnapshot(execFn) {
  const { stdout, code } = await execFn('ps', ['-eo', 'pid=,ppid=,args=', '--no-headers']);
  if (code !== 0) return null;

  const argsByPid = new Map();
  const childrenByPid = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)(?:\s+(.*))?$/);
    if (!match) continue;
    const [, pid, parentPid, args = ''] = match;
    argsByPid.set(pid, args.trim());
    const children = childrenByPid.get(parentPid) || [];
    children.push(pid);
    childrenByPid.set(parentPid, children);
  }
  if (argsByPid.size === 0) return null;
  return { argsByPid, childrenByPid };
}

export function isRustManagedTmuxSessionName(name = '') {
  return String(name || '').startsWith('dm-agent-');
}

export function externalSessionIdFromTmuxName(name = '') {
  const normalized = String(name || '').trim();
  if (!normalized) return '';
  return `ext-${Buffer.from(normalized, 'utf8').toString('base64url')}`;
}

export function tmuxNameFromExternalSessionId(id = '') {
  const text = String(id || '').trim();
  if (!text.startsWith('ext-')) return '';
  try {
    return Buffer.from(text.slice(4), 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

export function tmuxSessionFromTarget(target = '') {
  const text = String(target || '').trim();
  const colon = text.indexOf(':');
  if (colon >= 0) return text.slice(0, colon);
  const dot = text.indexOf('.');
  if (dot >= 0) return text.slice(0, dot);
  return text;
}

export function isRustManagedTmuxTarget(target = '') {
  return isRustManagedTmuxSessionName(tmuxSessionFromTarget(target));
}

export function rustManagedSessionFields(cli = '') {
  return {
    readOnly: true,
    externalOwner: 'rust-monitor',
    interactive: false,
    displayName: `rust-managed ${cli || 'agent'}`,
  };
}

async function processArgs(execFn, pid) {
  const { stdout, code } = await execFn('ps', ['-p', String(pid), '-o', 'args=', '--no-headers']);
  return code === 0 ? String(stdout || '').trim() : '';
}

async function childProcesses(execFn, pid) {
  const { stdout, code } = await execFn('ps', ['--ppid', String(pid), '-o', 'pid=,args=', '--no-headers']);
  if (code !== 0 || !String(stdout || '').trim()) return [];

  return String(stdout).trim().split('\n').filter(Boolean).map((line) => {
    const trimmed = line.trim();
    const spaceIdx = trimmed.indexOf(' ');
    return {
      pid: spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx).trim(),
      args: spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim(),
    };
  });
}

function stripQuotes(value = '') {
  return String(value || '').replace(/^['"]|['"]$/g, '');
}
