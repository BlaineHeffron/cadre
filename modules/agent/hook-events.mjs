import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { deriveHookState } from '../session-state/providers/hook.mjs';

const HOOKS_DIRNAME = join('.agent_bus', 'hooks');
const STATE_DIRNAME = join(HOOKS_DIRNAME, 'state');

function normalizeText(value = '') {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeFileToken(value = '') {
  return String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'unknown';
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveHookProjectRoot(startCwd = '') {
  const fallback = resolve(startCwd || process.cwd());
  let current = fallback;
  while (true) {
    if (await pathExists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (!parent || parent === current) return fallback;
    current = parent;
  }
}

export async function buildHookSessionPaths({ workDir = '', provider = '', sessionId = '' } = {}) {
  const rootDir = await resolveHookProjectRoot(workDir || process.cwd());
  const safeProvider = sanitizeFileToken(provider || 'unknown');
  const safeSessionId = sanitizeFileToken(sessionId || 'unknown');
  const hooksDir = join(rootDir, HOOKS_DIRNAME);
  const stateDir = join(rootDir, STATE_DIRNAME);
  return {
    rootDir,
    hooksDir,
    stateDir,
    eventsPath: join(hooksDir, `${safeProvider}-${safeSessionId}.jsonl`),
    statePath: join(stateDir, `${safeProvider}-${safeSessionId}.json`),
  };
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return {};
  }
}

async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tmpPath, JSON.stringify(value, null, 2));
  await rename(tmpPath, path);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function acquireStateFileLock(path) {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      return lockPath;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (Date.now() - startedAt > 5000) {
        const info = await stat(lockPath).catch(() => null);
        if (info && Date.now() - info.mtimeMs > 5000) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => {});
          continue;
        }
      }
      await sleep(10);
    }
  }
}

async function withStateFileLock(path, fn) {
  const lockPath = await acquireStateFileLock(path);
  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

function mergeStateSlot(priorState = {}, slotName = '', slotValue = {}) {
  if (!slotName) return { ...priorState };
  return {
    ...priorState,
    [slotName]: slotValue,
  };
}

function mergeSessionMetadata(priorState = {}, event = {}) {
  const prior = priorState?.session && typeof priorState.session === 'object' ? priorState.session : {};
  const next = {
    ...prior,
    provider: normalizeText(event.provider) || prior.provider || '',
    cliSessionId: normalizeText(event.sessionId) || prior.cliSessionId || '',
    duenoSessionId: normalizeText(event.duenoSessionId) || prior.duenoSessionId || '',
    cwd: normalizeText(event.cwd) || prior.cwd || '',
    transcriptPath: normalizeText(event.transcriptPath) || prior.transcriptPath || '',
    model: normalizeText(event.model) || prior.model || '',
    updatedAt: event.loggedAt || new Date().toISOString(),
  };
  return mergeStateSlot(priorState, 'session', next);
}

export async function recordHookPayload(payload = {}, {
  provider = '',
  duenoSessionId = '',
} = {}) {
  const sessionId = normalizeText(payload.session_id);
  const storageSessionId = normalizeText(duenoSessionId) || sessionId;
  const workDir = normalizeText(payload.cwd) || process.cwd();
  const eventName = normalizeText(payload.hook_event_name);
  const lastAssistantMessage = typeof payload.last_assistant_message === 'string'
    ? payload.last_assistant_message
    : '';
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  const paths = await buildHookSessionPaths({ workDir, provider, sessionId: storageSessionId });
  const result = await withStateFileLock(paths.statePath, async () => {
    const priorState = await readJsonFile(paths.statePath);
    const loggedAt = Date.now();
    const event = {
      loggedAt: new Date(loggedAt).toISOString(),
      provider: normalizeText(provider || payload.provider || 'unknown'),
      sessionId,
      duenoSessionId: normalizeText(duenoSessionId),
      eventName,
      payload: payload && typeof payload === 'object' ? payload : {},
      turnId: normalizeText(payload.turn_id || payload.tool_use_id || ''),
      cwd: workDir,
      transcriptPath: normalizeText(payload.transcript_path || ''),
      model: normalizeText(payload.model || ''),
      prompt: eventName === 'UserPromptSubmit' ? prompt : '',
      lastAssistantMessage: eventName === 'Stop' ? lastAssistantMessage : '',
      stopHookActive: payload.stop_hook_active === true,
      blockedByHook: false,
    };
    const derivedHookState = deriveHookState({
      provider: event.provider,
      eventName,
      payload,
      at: loggedAt,
    });
    let mergedState = mergeSessionMetadata(priorState, event);
    mergedState = mergeStateSlot(mergedState, 'hook', derivedHookState);
    delete mergedState.pendingBusMessage;

    await mkdir(paths.hooksDir, { recursive: true });
    await appendFile(paths.eventsPath, `${JSON.stringify(event)}\n`);
    await writeJsonFile(paths.statePath, mergedState);
    return { event, stopDecision: null };
  });

  return { ...result, paths };
}

export async function recordRuntimeHookEvent({
  workDir = '',
  provider = '',
  sessionId = '',
  eventName = '',
  data = {},
} = {}) {
  const normalizedEventName = normalizeText(eventName);
  if (!normalizedEventName) {
    throw new Error('Missing eventName for runtime hook event');
  }

  const paths = await buildHookSessionPaths({ workDir, provider, sessionId });
  const loggedAt = Date.now();
  const event = {
    loggedAt: new Date(loggedAt).toISOString(),
    provider: normalizeText(provider || 'unknown'),
    sessionId: normalizeText(sessionId),
    eventName: normalizedEventName,
    source: 'runtime',
    data: data && typeof data === 'object' ? data : {},
  };
  await withStateFileLock(paths.statePath, async () => {
    const priorState = await readJsonFile(paths.statePath);
    const nextState = mergeStateSlot(priorState, 'runtime', deriveHookState({
      provider: event.provider,
      eventName: normalizedEventName,
      data: event.data,
      at: loggedAt,
      source: 'runtime',
    }));

    await mkdir(paths.hooksDir, { recursive: true });
    await appendFile(paths.eventsPath, `${JSON.stringify(event)}\n`);
    await writeJsonFile(paths.statePath, nextState);
  });
  return { event, paths };
}

export async function readHookEventsSince({ workDir = '', provider = '', sessionId = '', cursor = 0 } = {}) {
  const paths = await buildHookSessionPaths({ workDir, provider, sessionId });
  try {
    const content = await readFile(paths.eventsPath, 'utf8');
    const safeCursor = Number.isFinite(Number(cursor)) ? Math.max(0, Number(cursor)) : 0;
    const nextCursor = content.length;
    if (safeCursor >= nextCursor) {
      return { events: [], cursor: nextCursor, path: paths.eventsPath };
    }
    const slice = content.slice(safeCursor);
    const events = slice
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return { events, cursor: nextCursor, path: paths.eventsPath };
  } catch {
    return { events: [], cursor: 0, path: paths.eventsPath };
  }
}
