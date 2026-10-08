import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const HOOKS_DIRNAME = join('.agent_bus', 'hooks');
const STATE_DIRNAME = join(HOOKS_DIRNAME, 'state');

export const CODEX_HOOK_ACTIVITY = Object.freeze({
  SessionStart: 'starting',
  UserPromptSubmit: 'working',
  PreToolUse: 'tool_running',
  PostToolUse: 'working',
  PermissionRequest: 'needs_permission',
  PreCompact: 'compacting',
  PostCompact: 'working',
  SubagentStart: 'working',
  SubagentStop: 'working',
  Stop: 'prompt_ready',
});

export const CLAUDE_HOOK_ACTIVITY = Object.freeze({
  ...CODEX_HOOK_ACTIVITY,
});

export const CODEX_HOOK_LIFECYCLE = Object.freeze({
  SessionStart: 'running',
});

export const CLAUDE_HOOK_LIFECYCLE = Object.freeze({
  ...CODEX_HOOK_LIFECYCLE,
  SessionEnd: 'ended',
});

const RUNTIME_ACTIVITY = Object.freeze({
  SessionPromptReady: 'prompt_ready',
  SessionPermissionNeeded: 'needs_permission',
  SessionBusy: 'working',
  SessionToolStarted: 'tool_running',
  SessionToolFinished: 'working',
});

const ACTIVE_ACTIVITIES = new Set(['starting', 'working', 'tool_running', 'compacting']);
const WAITING_ACTIVITIES = new Set(['needs_permission', 'prompt_ready', 'done_idle']);
export const HOOK_STATE_TTL_MS = 90000;

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

async function resolveHookProjectRoot(startCwd = '') {
  const fallback = resolve(startCwd || process.cwd());
  let current = fallback;
  while (true) {
    if (await pathExists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (!parent || parent === current) return fallback;
    current = parent;
  }
}

async function buildHookStatePath({ workDir = '', provider = '', sessionId = '' } = {}) {
  const rootDir = await resolveHookProjectRoot(workDir || process.cwd());
  const safeProvider = sanitizeFileToken(provider || 'unknown');
  const safeSessionId = sanitizeFileToken(sessionId || 'unknown');
  return join(rootDir, STATE_DIRNAME, `${safeProvider}-${safeSessionId}.json`);
}

function claudeNotificationActivity(payload = {}) {
  const raw = [
    payload.notification_type,
    payload.notificationType,
    payload.subtype,
    payload.type,
    payload.reason,
    payload.message,
  ].map((value) => String(value || '').toLowerCase()).join(' ');
  if (/(permission|approval|permit)/.test(raw)) return 'needs_permission';
  if (/(idle|prompt[_ -]?ready|ready)/.test(raw)) return 'prompt_ready';
  return '';
}

function runtimeActivity(data = {}) {
  const sessionState = normalizeText(data.sessionState || data.state);
  if (sessionState === 'waiting_for_input') return 'prompt_ready';
  if (sessionState === 'needs_approval' || sessionState === 'needs_confirmation') return 'needs_permission';
  if (sessionState === 'working' || sessionState === 'thinking' || sessionState === 'active') return 'working';
  if (sessionState === 'ended' || sessionState === 'missing') return 'ended';
  return '';
}

function activityForEvent({ provider = '', eventName = '', payload = {}, data = {} } = {}) {
  const normalizedProvider = normalizeText(provider || payload.provider).toLowerCase();
  const normalizedEvent = normalizeText(eventName);
  if (!normalizedEvent) return 'unknown';

  if (normalizedEvent === 'Notification' && normalizedProvider === 'claude') {
    return claudeNotificationActivity(payload) || claudeNotificationActivity(data) || 'unknown';
  }

  if (RUNTIME_ACTIVITY[normalizedEvent]) return RUNTIME_ACTIVITY[normalizedEvent];
  if (normalizedEvent === 'SessionStateChanged') return runtimeActivity(data) || 'unknown';

  const table = normalizedProvider === 'claude' ? CLAUDE_HOOK_ACTIVITY : CODEX_HOOK_ACTIVITY;
  return table[normalizedEvent] || runtimeActivity(data) || 'unknown';
}

function lifecycleForEvent({ provider = '', eventName = '', payload = {} } = {}) {
  const normalizedProvider = normalizeText(provider || payload.provider).toLowerCase();
  const normalizedEvent = normalizeText(eventName);
  const table = normalizedProvider === 'claude' ? CLAUDE_HOOK_LIFECYCLE : CODEX_HOOK_LIFECYCLE;
  return table[normalizedEvent] || 'running';
}

function normalizeHookTime(value) {
  if (value === undefined || value === null || value === '') return NaN;
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function deriveHookState({ provider = '', eventName = '', payload = {}, data = {}, at = Date.now(), source = 'hook' } = {}) {
  const activity = activityForEvent({ provider, eventName, payload, data });
  const lastHookEventAt = normalizeHookTime(at);
  return {
    lifecycle: lifecycleForEvent({ provider, eventName, payload }),
    activity,
    last_hook_event_at: Number.isFinite(lastHookEventAt) ? lastHookEventAt : Date.now(),
    last_event_name: normalizeText(eventName),
    source: normalizeText(source || 'hook'),
  };
}

export function mapHookActivityToSessionState(activity = '') {
  const normalized = normalizeText(activity);
  if (ACTIVE_ACTIVITIES.has(normalized)) return 'working';
  if (WAITING_ACTIVITIES.has(normalized)) return 'waiting_for_input';
  return '';
}

function scrapeActivityForState(state = {}) {
  if (state?.state === 'waiting_for_input') return 'prompt_ready';
  if (state?.state === 'working' || state?.state === 'thinking' || state?.state === 'active') return 'working';
  return state?.state || 'unknown';
}

function hookDetail(activity = '') {
  if (activity === 'needs_permission') return 'Needs permission';
  if (activity === 'prompt_ready') return 'Waiting for input';
  if (activity === 'tool_running') return 'Tool running';
  if (activity === 'compacting') return 'Compacting';
  if (activity === 'starting') return 'Starting';
  return 'Working';
}

function isSafeToMessageHook(hook = {}) {
  return hook.lifecycle === 'running' && hook.activity === 'prompt_ready';
}

function isSafeToMessageScrape(state = {}) {
  return state?.state === 'waiting_for_input'
    && state?.needsInput !== false
    && (!state?.inputType || state.inputType === 'text');
}

export async function reconcileHookFirstState({
  session = {},
  scrapeState = {},
  provider = '',
  now = Date.now(),
  ttlMs = HOOK_STATE_TTL_MS,
  minHookEventAt = 0,
} = {}) {
  const hook = await readHookDerivedState({
    workDir: session.workDir || process.cwd(),
    provider: provider || session.provider || session.runtime || '',
    sessionId: session.id || '',
    now,
  });
  const hookEventAt = normalizeHookTime(hook.last_hook_event_at);
  const minEventAt = normalizeHookTime(minHookEventAt);
  const hookAfterMin = !Number.isFinite(minEventAt)
    || !Number.isFinite(hookEventAt)
    || hookEventAt >= minEventAt;
  const hookFresh = hook.source === 'hook' && hook.ageMs < ttlMs && hookAfterMin;
  if (hookFresh && hook.lifecycle === 'ended') {
    return {
      state: 'ended',
      needsInput: false,
      inputType: null,
      detail: 'Session ended',
      lifecycle: hook.lifecycle,
      activity: hook.activity || 'unknown',
      state_source: 'hook',
      last_hook_event_at: hook.last_hook_event_at,
      safe_to_message: false,
    };
  }

  const hookSessionState = hookFresh ? mapHookActivityToSessionState(hook.activity) : '';
  if (hookSessionState) {
    const safeToMessage = isSafeToMessageHook(hook);
    return {
      state: hookSessionState,
      needsInput: safeToMessage,
      inputType: safeToMessage ? 'text' : null,
      detail: hookDetail(hook.activity),
      lifecycle: hook.lifecycle,
      activity: hook.activity,
      state_source: 'hook',
      last_hook_event_at: hook.last_hook_event_at,
      safe_to_message: safeToMessage,
    };
  }

  return {
    ...scrapeState,
    activity: scrapeActivityForState(scrapeState),
    state_source: 'scrape',
    safe_to_message: isSafeToMessageScrape(scrapeState),
  };
}

export async function readHookDerivedState({ workDir = '', provider = '', sessionId = '', now = Date.now() } = {}) {
  const statePath = await buildHookStatePath({ workDir, provider, sessionId });
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const hook = state?.hook && typeof state.hook === 'object' ? state.hook : {};
    const derived = {
      lifecycle: normalizeText(hook.lifecycle),
      activity: normalizeText(hook.activity),
      last_hook_event_at: hook.last_hook_event_at,
      last_event_name: normalizeText(hook.last_event_name),
      source: normalizeText(hook.source),
    };
    const eventAtMs = normalizeHookTime(derived.last_hook_event_at);
    return {
      ...derived,
      ageMs: Number.isFinite(eventAtMs) ? Math.max(0, Number(now) - eventAtMs) : Infinity,
      statePath,
    };
  } catch {
    return {
      lifecycle: '',
      activity: '',
      last_hook_event_at: '',
      last_event_name: '',
      source: '',
      ageMs: Infinity,
      statePath,
    };
  }
}

export async function readHookSessionMetadata({ workDir = '', provider = '', sessionId = '' } = {}) {
  const statePath = await buildHookStatePath({ workDir, provider, sessionId });
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    const session = state?.session && typeof state.session === 'object' ? state.session : {};
    return {
      cliSessionId: normalizeText(session.cliSessionId),
      duenoSessionId: normalizeText(session.duenoSessionId),
      cwd: normalizeText(session.cwd),
      transcriptPath: normalizeText(session.transcriptPath),
      transcriptStartOffset: Number(session.transcriptStartOffset) || 0,
      model: normalizeText(session.model),
      provider: normalizeText(session.provider),
      updatedAt: normalizeText(session.updatedAt),
      statePath,
    };
  } catch {
    return {
      cliSessionId: '',
      duenoSessionId: '',
      cwd: '',
      transcriptPath: '',
      transcriptStartOffset: 0,
      model: '',
      provider: '',
      updatedAt: '',
      statePath,
    };
  }
}
