import { readFile } from 'node:fs/promises';
import { readProcIdentity } from '../../agent/process-termination.mjs';
import { classifyExecutableArgs } from '../../agent/tmux-classifier.mjs';
import { PROCESS_LIFECYCLE_FRESH_MS } from '../tracker.mjs';

const MAX_TREE_DEPTH = 12;

function text(value) {
  return String(value || '').trim();
}

function panePids(stdout = '') {
  return String(stdout || '')
    .split('\n')
    .map((value) => text(value))
    .filter((value) => /^\d+$/.test(value));
}

function isMissingSessionError(stderr = '') {
  return /can't find (?:session|pane)|no such (?:session|pane)|(?:session|pane) not found/i.test(
    String(stderr || ''),
  );
}

function isWrapperShell(cmdline = '') {
  const token = String(cmdline || '').trim().split(/\s+/)[0] || '';
  const name = token.split('/').pop().replace(/^-/, '').toLowerCase();
  return ['bash', 'sh', 'dash', 'zsh', 'fish'].includes(name);
}

export async function readProcChildPids(pid, { readFileFn = readFile } = {}) {
  const normalized = String(pid || '').trim();
  if (!/^\d+$/.test(normalized)) return [];
  try {
    const children = await readFileFn(`/proc/${normalized}/task/${normalized}/children`, 'utf8');
    return String(children || '')
      .trim()
      .split(/\s+/)
      .filter((value) => /^\d+$/.test(value));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    return null;
  }
}

function matchesExpectedCli(cmdline, expectedCli = '') {
  const cli = classifyExecutableArgs(cmdline).cli;
  if (!cli) return false;
  const expected = text(expectedCli).toLowerCase();
  return !expected || cli === expected;
}

/**
 * Walk pane pid trees. A live wrapper shell (bash -lc + tee) is not the agent.
 * Probe errors return null so callers can omit evidence instead of writing missing.
 */
export async function inspectPaneProcessTree(rootPid, {
  readIdentityFn = readProcIdentity,
  listChildrenFn = readProcChildPids,
  expectedCli = '',
} = {}) {
  const pending = [{ pid: text(rootPid), depth: 0 }];
  const visited = new Set();
  let sawLive = false;
  let rootIsWrapper = false;
  let sawUnreadableChildren = false;

  while (pending.length) {
    const current = pending.shift();
    if (!current.pid || visited.has(current.pid) || current.depth > MAX_TREE_DEPTH) continue;
    visited.add(current.pid);

    const identity = await readIdentityFn(current.pid);
    if (!identity || identity.state === 'Z') continue;
    sawLive = true;
    if (current.depth === 0) rootIsWrapper = isWrapperShell(identity.cmdline);
    if (matchesExpectedCli(identity.cmdline, expectedCli)) return 'running';

    const children = await listChildrenFn(current.pid);
    if (children == null) {
      sawUnreadableChildren = true;
      continue;
    }
    for (const child of children) {
      pending.push({ pid: text(child), depth: current.depth + 1 });
    }
  }

  if (!sawLive) return 'missing';
  // Launch uses `bash -lc '<cli> 2> >(tee ...)'`. A live wrapper without a
  // CLI child is a dead agent. A live non-wrapper pane pid (tests, or the
  // CLI itself) is running even if some descendant entries are unreadable.
  if (!rootIsWrapper) return 'running';
  if (sawUnreadableChildren) return null;
  return 'missing';
}

async function firstResolvedLifecycle(pids, options) {
  let uncertain = false;
  for (const pid of pids) {
    const lifecycle = await inspectPaneProcessTree(pid, options);
    if (lifecycle === 'running') return 'running';
    if (lifecycle == null) uncertain = true;
  }
  if (uncertain) return null;
  return pids.length ? 'missing' : null;
}

/**
 * Tmux capture success is not liveness. Probe session existence + pane pid
 * trees + /proc. Return null when the probe cannot decide.
 */
export async function resolveTmuxProcessLifecycle({
  sessionName = '',
  execFn,
  readIdentityFn = readProcIdentity,
  listChildrenFn = readProcChildPids,
  expectedCli = '',
} = {}) {
  const target = text(sessionName);
  if (!target || typeof execFn !== 'function') return null;

  const treeOptions = { readIdentityFn, listChildrenFn, expectedCli };

  try {
    const panes = await execFn('tmux', ['list-panes', '-s', '-t', target, '-F', '#{pane_pid}']);
    if (panes?.code === 0) {
      const pids = panePids(panes.stdout);
      const lifecycle = await firstResolvedLifecycle(pids, treeOptions);
      if (lifecycle || pids.length) return lifecycle;
    } else if (panes && !isMissingSessionError(panes.stderr)) {
      return null;
    }

    const exists = await execFn('tmux', ['has-session', '-t', target]);
    if (exists?.code !== 0) {
      return isMissingSessionError(exists?.stderr) || exists?.code === 1 ? 'missing' : null;
    }

    const pidMessage = await execFn('tmux', ['display-message', '-t', target, '-p', '#{pane_pid}']);
    if (pidMessage && pidMessage.code !== 0 && !isMissingSessionError(pidMessage.stderr)) {
      return null;
    }
    const fallbackPids = panePids(pidMessage?.code === 0 ? pidMessage.stdout : '');
    return await firstResolvedLifecycle(fallbackPids, treeOptions) || 'missing';
  } catch {
    return null;
  }
}

export async function observeProcessLiveness({
  sessionName = '',
  now = Date.now(),
  execFn,
  readIdentityFn = readProcIdentity,
  listChildrenFn = readProcChildPids,
  expectedCli = '',
  freshMs = PROCESS_LIFECYCLE_FRESH_MS,
} = {}) {
  const lifecycle = await resolveTmuxProcessLifecycle({
    sessionName,
    execFn,
    readIdentityFn,
    listChildrenFn,
    expectedCli,
  });
  if (!lifecycle) return Object.freeze([]);
  const observedAt = Number(now);
  const ttl = Math.max(1, Number(freshMs) || PROCESS_LIFECYCLE_FRESH_MS);
  return Object.freeze([{
    source: 'process',
    kind: 'lifecycle',
    value: { lifecycle },
    observedAt,
    expiresAt: lifecycle === 'running' ? observedAt + ttl : 0,
    fingerprint: `process:${lifecycle}`,
  }]);
}
