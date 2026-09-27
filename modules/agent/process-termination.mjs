import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { classifyExecutableArgs } from './tmux-classifier.mjs';

const POLL_MS = 100;
const TERM_GRACE_MS = 500;
const KILL_GRACE_MS = 500;
const ROOT_ASCENT_LIMIT = 2;
const COMMAND_MAX = 240;

function parseProcStat(stat = '') {
  const closeParen = String(stat || '').lastIndexOf(')');
  if (closeParen < 0) return null;
  const fields = String(stat).slice(closeParen + 1).trim().split(/\s+/);
  if (fields.length < 20) return null;
  return { state: fields[0] || '', ppid: String(fields[1] || ''), starttime: String(fields[19] || '') };
}

export async function readProcIdentity(pid, { readFileImpl = readFile } = {}) {
  const normalizedPid = String(pid || '').trim();
  if (!/^\d+$/.test(normalizedPid)) return null;
  try {
    const stat = parseProcStat(await readFileImpl(`/proc/${normalizedPid}/stat`, 'utf8'));
    if (!stat?.starttime) return null;
    const cmdline = String(await readFileImpl(`/proc/${normalizedPid}/cmdline`, 'utf8')).replace(/\0/g, ' ').trim();
    const confirmed = parseProcStat(await readFileImpl(`/proc/${normalizedPid}/stat`, 'utf8'));
    if (!confirmed || confirmed.starttime !== stat.starttime) return null;
    return { pid: normalizedPid, ppid: confirmed.ppid, state: confirmed.state, starttime: confirmed.starttime, cmdline };
  } catch {
    return null;
  }
}

function bufferEnvironmentValue(buffer, name) {
  const prefix = Buffer.from(`${name}=`);
  let start = 0;
  while (start < buffer.length) {
    let end = buffer.indexOf(0, start);
    if (end < 0) end = buffer.length;
    const entry = buffer.subarray(start, end);
    if (entry.length >= prefix.length && entry.subarray(0, prefix.length).equals(prefix)) {
      return entry.subarray(prefix.length).toString('utf8');
    }
    start = end + 1;
  }
  return '';
}

export async function readProcessEnvironmentValue(pid, name, { readFileImpl = readFile } = {}) {
  if (!/^\d+$/u.test(String(pid || '')) || !/^[A-Z][A-Z0-9_]*$/u.test(String(name || ''))) return '';
  try {
    return bufferEnvironmentValue(await readFileImpl(`/proc/${pid}/environ`), name);
  } catch {
    return '';
  }
}

export async function findProcessIdentitiesByEnvironment(name, expected, {
  readdirImpl = readdir,
  readFileImpl = readFile,
  readIdentityFn = (pid) => readProcIdentity(pid, { readFileImpl }),
} = {}) {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(String(name || '')) || !String(expected || '')) return [];
  const entries = await readdirImpl('/proc', { withFileTypes: true });
  const identities = [];
  for (const entry of entries) {
    const pid = typeof entry === 'string' ? entry : entry.name;
    if (!/^\d+$/u.test(pid) || (typeof entry !== 'string' && !entry.isDirectory())) continue;
    let environment;
    try {
      environment = await readFileImpl(`/proc/${pid}/environ`);
    } catch {
      continue;
    }
    if (bufferEnvironmentValue(environment, name) !== String(expected)) continue;
    const identity = await readIdentityFn(pid);
    if (identity && identity.state !== 'Z') identities.push(identity);
  }
  return mergeProcessIdentities(identities);
}

export async function snapshotProcessTrees(rootPids, {
  readdirImpl = readdir,
  readIdentityFn = readProcIdentity,
  maxDepth = 64,
} = {}) {
  const entries = await readdirImpl('/proc', { withFileTypes: true });
  const identities = new Map();
  const children = new Map();
  for (const entry of entries) {
    const pid = typeof entry === 'string' ? entry : entry.name;
    if (!/^\d+$/u.test(pid) || (typeof entry !== 'string' && !entry.isDirectory())) continue;
    const identity = await readIdentityFn(pid);
    if (!identity || identity.state === 'Z') continue;
    identities.set(identity.pid, identity);
    const siblings = children.get(identity.ppid) || [];
    siblings.push(identity.pid);
    children.set(identity.ppid, siblings);
  }

  const collected = [];
  const visited = new Set();
  const pending = [...new Set((rootPids || []).map((pid) => String(pid || '').trim()).filter(Boolean))]
    .map((pid) => ({ pid, depth: 0 }));
  while (pending.length > 0) {
    const current = pending.shift();
    if (visited.has(current.pid) || current.depth > maxDepth) continue;
    visited.add(current.pid);
    const identity = identities.get(current.pid);
    if (!identity) continue;
    collected.push({ ...identity, depth: current.depth });
    for (const childPid of children.get(current.pid) || []) {
      pending.push({ pid: childPid, depth: current.depth + 1 });
    }
  }
  return collected.sort((left, right) => right.depth - left.depth)
    .map(({ depth: _depth, ...identity }) => identity);
}

function processResidual(identity = {}) {
  const command = String(identity.cmdline || '');
  return {
    type: 'process',
    pid: Number(identity.pid),
    command: command.length > COMMAND_MAX ? `${command.slice(0, COMMAND_MAX - 1)}…` : command,
  };
}

function sameLiveProcess(expected, current) {
  return Boolean(current) && current.state !== 'Z' && String(current.starttime || '') === String(expected.starttime || '');
}

async function currentProcessIdentities(identities, readIdentityFn) {
  const live = [];
  for (const expected of identities) {
    const current = await readIdentityFn(expected.pid);
    if (sameLiveProcess(expected, current)) live.push({ ...expected, ...current });
  }
  return live;
}

async function pollProcessExit(identities, timeoutMs, { readIdentityFn, sleepFn }) {
  const deadline = Date.now() + timeoutMs;
  let live = await currentProcessIdentities(identities, readIdentityFn);
  while (live.length > 0 && Date.now() < deadline) {
    await sleepFn(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
    live = await currentProcessIdentities(live, readIdentityFn);
  }
  return live;
}

async function ownProcessLineage(readIdentityFn) {
  const protectedPids = new Set([String(process.pid)]);
  let current = await readIdentityFn(process.pid);
  while (current?.ppid && current.ppid !== '0' && !protectedPids.has(current.ppid)) {
    protectedPids.add(current.ppid);
    current = await readIdentityFn(current.ppid);
  }
  return protectedPids;
}

export function mergeProcessIdentities(...groups) {
  const merged = new Map();
  for (const identity of groups.flat()) {
    if (identity?.pid && identity?.starttime) merged.set(`${identity.pid}:${identity.starttime}`, identity);
  }
  return [...merged.values()];
}

export async function ascendOwnedCliRoot(seedPid, cli, {
  readIdentityFn = readProcIdentity,
  childPidsFn = async () => [],
  ascentLimit = ROOT_ASCENT_LIMIT,
  initialIdentity = null,
} = {}) {
  let current = initialIdentity || await readIdentityFn(seedPid);
  if (!current || current.state === 'Z' || classifyExecutableArgs(current.cmdline).cli !== cli) return null;
  const protectedPids = await ownProcessLineage(readIdentityFn);
  for (let depth = 0; depth < ascentLimit; depth += 1) {
    if (!current.ppid || current.ppid === '0' || protectedPids.has(current.ppid)) break;
    const candidate = await readIdentityFn(current.ppid);
    if (!candidate || candidate.state === 'Z' || classifyExecutableArgs(candidate.cmdline).cli !== cli) break;
    let childPids;
    try {
      childPids = await childPidsFn(candidate.pid);
    } catch {
      break;
    }
    let ownsSibling = false;
    for (const childPid of childPids) {
      if (childPid === current.pid) continue;
      const sibling = await readIdentityFn(childPid);
      if (sibling && sibling.state !== 'Z' && classifyExecutableArgs(sibling.cmdline).cli === cli) {
        ownsSibling = true;
        break;
      }
    }
    if (ownsSibling) break;
    current = candidate;
  }
  return current;
}

export async function terminateVerifiedProcesses(initialIdentities, {
  rescanFn = async () => [],
  killFn = process.kill,
  readIdentityFn = readProcIdentity,
  sleepFn = sleep,
  termGraceMs = TERM_GRACE_MS,
  killGraceMs = KILL_GRACE_MS,
} = {}) {
  let identities = mergeProcessIdentities(initialIdentities);
  const protectedPids = await ownProcessLineage(readIdentityFn);
  const unsafe = identities.find((identity) => Number(identity.pid) <= 1 || protectedPids.has(String(identity.pid)));
  if (unsafe) return { ok: false, reason: 'self_reference', residual: identities.map(processResidual) };

  const signal = async (targets, name) => {
    const notOwned = [];
    for (const expected of targets) {
      const current = await readIdentityFn(expected.pid);
      if (!sameLiveProcess(expected, current)) continue;
      try {
        killFn(Number(expected.pid), name);
      } catch (error) {
        if (error?.code === 'ESRCH') continue;
        if (error?.code === 'EPERM') notOwned.push(current);
        else throw error;
      }
    }
    return notOwned;
  };

  const termNotOwner = await signal(identities, 'SIGTERM');
  let live = await pollProcessExit(identities, termGraceMs, { readIdentityFn, sleepFn });
  identities = mergeProcessIdentities(await rescanFn(live), live);
  const lateUnsafe = identities.find((identity) => Number(identity.pid) <= 1 || protectedPids.has(String(identity.pid)));
  if (lateUnsafe) return { ok: false, reason: 'self_reference', residual: identities.map(processResidual) };
  if (identities.length === 0) return { ok: true, residual: [], reason: '' };

  const killNotOwner = await signal(identities, 'SIGKILL');
  live = await pollProcessExit(identities, killGraceMs, { readIdentityFn, sleepFn });
  if (live.length === 0) return { ok: true, residual: [], reason: '' };
  const denied = mergeProcessIdentities(termNotOwner, killNotOwner)
    .filter((identity) => live.some((entry) => entry.pid === identity.pid && entry.starttime === identity.starttime));
  return {
    ok: false,
    reason: denied.length > 0 ? 'not_owner' : 'processes_survived',
    residual: mergeProcessIdentities(live, denied).map(processResidual),
  };
}
