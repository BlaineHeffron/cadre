import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { exec } from '../../lib/exec.mjs';
import { buildAgentProviderCatalog } from '../agent/provider-interface.mjs';
import { listClaudeModels } from '../sessions/claude-models.mjs';
import { listCodexModels } from '../sessions/codex-models.mjs';
import { createAgentSession, enqueueAgentSessionCommand } from '../sessions/index.mjs';
import { config } from '../../config.mjs';
import { BROWSER_SESSION_COOKIE, createBrowserSessionCookieValue } from '../platform/auth.mjs';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CODEX_MODEL, getPreferredModelForProvider } from '../sessions/provider-models.mjs';
import {
  getAgentProviderPreferencesSync,
} from '../agent/provider-preferences.mjs';
import { legacyRootStatePath, runtimeStatePath } from '../ops/runtime-state.mjs';
import {
  promptProfileStartupTask,
  resolvePromptProfile,
} from './prompt-profile-catalog.mjs';
import { FLEET_SUPERVISOR_MCP_CREDENTIAL_PROFILE } from './mcp-launch-preflight.mjs';

export const OPERATOR_ACTION_ROUTES = [
  { method: 'POST', path: /^\/api\/agents\/github$/ },
  { method: 'DELETE', path: /^\/api\/agents\/github\/watches$/ },
  { method: 'POST', path: /^\/api\/agent-bus\/threads\/[A-Za-z0-9_-]+\/end$/ },
];

function validateOperatorAction(action) {
  if (!action || typeof action.path !== 'string' || action.path.trim() !== action.path || !OPERATOR_ACTION_ROUTES.some(({ method, path }) => method === action.method && path.test(action.path))) {
    const error = new Error('Operator action method/path is not allowlisted');
    error.statusCode = 400;
    throw error;
  }
  return { method: action.method, path: action.path, ...(action.body !== undefined ? { body: structuredClone(action.body) } : {}) };
}

// ── State ──

const DATA_DIR = runtimeStatePath('command_center');
const LEGACY_DATA_DIR = legacyRootStatePath('command_center');
let activeSession = null; // { id, sessionName, startedAt, compactInterval }
let activeSupervisorSession = null;
let compactInterval = null;
let supervisorCompactInterval = null;
let workQueueSeq = 0;
const humanWorkQueue = [];
let humanWorkQueueLoaded = false;

const COMPACT_INTERVAL_MS = 15 * 60_000; // Auto-compact every 15 minutes
const WORK_QUEUE_PATH = resolve(DATA_DIR, 'work-queue.json');
const LEGACY_WORK_QUEUE_PATH = resolve(LEGACY_DATA_DIR, 'work-queue.json');
const DEFAULT_COMMAND_CENTER_MODEL = DEFAULT_CODEX_MODEL;
const DEFAULT_COMMAND_CENTER_PROVIDER = 'codex';
const DEFAULT_COMMAND_CENTER_THINKING_LEVEL = 'medium';

const COMMAND_CENTER_PROVIDER_DEFAULTS = Object.freeze({
  codex: DEFAULT_COMMAND_CENTER_MODEL,
  claude: DEFAULT_CLAUDE_MODEL,
});

export function normalizeCommandCenterProvider(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'anthropic') return 'claude';
  return normalized === 'codex' || normalized === 'claude' ? normalized : '';
}

function inferCommandCenterProviderFromModel(model = '') {
  const normalized = String(model || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.startsWith('claude')) return 'claude';
  if (normalized.startsWith('gpt') || normalized.includes('codex')) return 'codex';
  return '';
}

function defaultCommandCenterModelForProvider(provider = '') {
  return COMMAND_CENTER_PROVIDER_DEFAULTS[provider] || '';
}

function isCommandCenterProviderEnabled(provider = '', preferences = getAgentProviderPreferencesSync()) {
  return buildAgentProviderCatalog(preferences)
    .some((entry) => entry.id === provider && entry.enabled);
}

export function getDefaultCommandCenterTarget(preferences = getAgentProviderPreferencesSync()) {
  if (isCommandCenterProviderEnabled('codex', preferences)) {
    return {
      provider: 'codex',
      model: DEFAULT_COMMAND_CENTER_MODEL,
      backendType: 'codex',
      runtime: 'codex',
      thinkingLevel: DEFAULT_COMMAND_CENTER_THINKING_LEVEL,
    };
  }
  return {
    provider: 'claude',
    model: defaultCommandCenterModelForProvider('claude'),
    backendType: 'claude',
    runtime: 'claude',
    thinkingLevel: '',
  };
}

export function resolveCommandCenterTarget({ model, provider } = {}, preferences = getAgentProviderPreferencesSync()) {
  const requestedModel = String(model || '').trim();
  const inferredProvider = inferCommandCenterProviderFromModel(requestedModel);
  const requestedProvider = normalizeCommandCenterProvider(provider) || inferredProvider;
  const defaultTarget = getDefaultCommandCenterTarget(preferences);
  const resolvedProvider = isCommandCenterProviderEnabled(requestedProvider, preferences)
    ? requestedProvider
    : defaultTarget.provider;
  const modelMatchesProvider = requestedModel && inferCommandCenterProviderFromModel(requestedModel) === resolvedProvider;

  return {
    provider: resolvedProvider,
    model: modelMatchesProvider ? requestedModel : (defaultCommandCenterModelForProvider(resolvedProvider) || defaultTarget.model),
    backendType: resolvedProvider === 'codex' ? 'codex' : 'claude',
    runtime: resolvedProvider === 'codex' ? 'codex' : 'claude',
    thinkingLevel: resolvedProvider === 'codex' ? DEFAULT_COMMAND_CENTER_THINKING_LEVEL : '',
  };
}

async function resolveCommandCenterTargetDiscovered(
  { model, provider } = {},
  preferences = getAgentProviderPreferencesSync(),
  getPreferredModel = getPreferredModelForProvider,
) {
  const resolved = resolveCommandCenterTarget({ model, provider }, preferences);
  if (String(model || '').trim()) return resolved;

  if (resolved.provider === 'codex') {
    return {
      ...resolved,
      model: await getPreferredModel('codex').catch(() => resolved.model || DEFAULT_COMMAND_CENTER_MODEL),
    };
  }

  if (resolved.provider === 'claude') {
    return {
      ...resolved,
      model: await getPreferredModel('claude', { fast: false }).catch(() => resolved.model || DEFAULT_CLAUDE_MODEL),
    };
  }

  return resolved;
}

export function buildCommandCenterModelCatalog({
  preferences = getAgentProviderPreferencesSync(),
  codexModels = [],
  claudeModels = [],
} = {}) {
  const defaultTarget = getDefaultCommandCenterTarget(preferences);
  const providerEntries = [];
  const available = [];

  if (isCommandCenterProviderEnabled('codex', preferences)) {
    providerEntries.push({ id: 'codex', label: 'Codex' });
    available.push(...(codexModels || []).map((model) => ({ ...model, provider: 'codex' })));
  }

  if (isCommandCenterProviderEnabled('claude', preferences)) {
    providerEntries.push({ id: 'claude', label: 'Claude' });
    available.push(...(claudeModels || []).map((model) => ({ ...model, provider: 'claude' })));
  }

  return {
    defaultProvider: defaultTarget.provider,
    defaultModel: defaultTarget.model,
    providers: providerEntries,
    available,
  };
}

function promptProfileIdForMode(mode = 'command_center') {
  return mode === 'fleet_supervisor' ? 'fleet-supervisor' : 'command-center';
}

function buildStartupPrompt({ mode = 'command_center' } = {}) {
  return promptProfileStartupTask(resolvePromptProfile({ promptProfile: promptProfileIdForMode(mode) }));
}

// ── Auto-compact ──

function startAutoCompact(session, log, enqueueSessionCommand = enqueueAgentSessionCommand) {
  stopAutoCompact();

  compactInterval = setInterval(async () => {
    try {
      await enqueueSessionCommand(session.backendType, session.id, {
        source: 'command_center_auto_compact',
        operation: 'compact',
        text: '/compact',
        enter: true,
      });
      log.info({ sessionName: session.sessionName }, 'Command center AI auto-compacted');
    } catch (e) {
      log.warn({ sessionName: session.sessionName, err: e.message }, 'Auto-compact failed — session may have exited');
      stopAutoCompact();
    }
  }, COMPACT_INTERVAL_MS);
  compactInterval.unref?.();
}

function stopAutoCompact() {
  if (compactInterval) {
    clearInterval(compactInterval);
    compactInterval = null;
  }
}

function stopSupervisorAutoCompact() {
  if (supervisorCompactInterval) {
    clearInterval(supervisorCompactInterval);
    supervisorCompactInterval = null;
  }
}

function startSupervisorAutoCompact(session, log, enqueueSessionCommand = enqueueAgentSessionCommand) {
  stopSupervisorAutoCompact();

  supervisorCompactInterval = setInterval(async () => {
    try {
      await enqueueSessionCommand(session.backendType, session.id, {
        source: 'fleet_supervisor_auto_compact',
        operation: 'compact',
        text: '/compact',
        enter: true,
      });
      log.info({ sessionName: session.sessionName }, 'Fleet supervisor auto-compacted');
    } catch (e) {
      log.warn({ sessionName: session.sessionName, err: e.message }, 'Fleet supervisor auto-compact failed');
      stopSupervisorAutoCompact();
    }
  }, COMPACT_INTERVAL_MS);
  supervisorCompactInterval.unref?.();
}

function normalizeQueueOption(option = {}, index = 0) {
  if (typeof option === 'string') {
    return { id: `option_${index + 1}`, label: option, value: option };
  }
  const label = String(option.label || option.value || option.text || '').trim();
  return {
    id: String(option.id || `option_${index + 1}`).trim(),
    label,
    value: String(option.value || label).trim(),
    description: String(option.description || '').trim(),
  };
}

function queueEvent(type, detail = {}) {
  return {
    type,
    at: new Date().toISOString(),
    ...detail,
  };
}

function normalizeHumanQueueItem(item = {}) {
  const normalized = {
    ...item,
    deliveryStatus: String(item.deliveryStatus || item.delivery_status || '').trim(),
    events: Array.isArray(item.events) ? item.events : [],
  };
  const delivery = normalized.answer?.delivery || null;
  if (!normalized.deliveryStatus) {
    if (delivery?.routed === true) normalized.deliveryStatus = 'routed';
    else if (delivery?.error) normalized.deliveryStatus = 'failed';
    else if (normalized.passThrough) normalized.deliveryStatus = 'none';
    else normalized.deliveryStatus = normalized.status === 'answered' ? 'supervisor' : 'none';
  }
  if (normalized.status === 'answered' && normalized.passThrough && delivery?.routed === true) {
    normalized.status = 'routed';
  }
  if (normalized.status === 'answered' && normalized.passThrough && delivery?.error) {
    normalized.status = 'delivery_failed';
  }
  return normalized;
}

async function ensureHumanWorkQueueLoaded() {
  if (humanWorkQueueLoaded) return;
  humanWorkQueueLoaded = true;
  const raw = await readFile(WORK_QUEUE_PATH, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }) || await readFile(LEGACY_WORK_QUEUE_PATH, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  if (!raw) return;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  humanWorkQueue.splice(0, humanWorkQueue.length, ...items.filter((item) => item?.id).map(normalizeHumanQueueItem));
  workQueueSeq = Math.max(
    Number(parsed?.seq || 0),
    ...humanWorkQueue.map((item) => Number(String(item.id || '').split('_').pop()) || 0),
  );
}

async function persistHumanWorkQueue() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(WORK_QUEUE_PATH, `${JSON.stringify({ seq: workQueueSeq, items: humanWorkQueue }, null, 2)}\n`);
}

function serializeWorkQueueSync({ status = 'open' } = {}) {
  const normalizedStatus = String(status || 'open').trim().toLowerCase();
  const items = humanWorkQueue
    .filter((item) => normalizedStatus === 'all' || item.status === normalizedStatus)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return {
    status: normalizedStatus,
    openCount: humanWorkQueue.filter((item) => item.status === 'open').length,
    itemCount: items.length,
    items,
  };
}

export async function serializeWorkQueue({ status = 'open' } = {}) {
  await ensureHumanWorkQueueLoaded();
  return serializeWorkQueueSync({ status });
}

function broadcastWorkQueue(wsManager, type = 'updated') {
  wsManager?.broadcast?.('command-center:work-queue', type, serializeWorkQueueSync({ status: 'all' }));
}

export async function addHumanQueueItem(input = {}, { wsManager, persist = true, principal } = {}) {
  await ensureHumanWorkQueueLoaded();
  const operatorAction = input.operatorAction === undefined ? null : validateOperatorAction(input.operatorAction);
  if (operatorAction && (principal?.type !== 'agent' || !['claude', 'codex', 'pi'].includes(principal?.kind) || !principal?.sessionId)) {
    const error = new Error('Operator actions require an authenticated requesting session');
    error.statusCode = 403;
    throw error;
  }
  const title = String(input.title || input.question || 'Decision needed').trim();
  const question = String(input.question || title).trim();
  if (!question) {
    const error = new Error('question is required');
    error.statusCode = 400;
    throw error;
  }
  const options = Array.isArray(input.options)
    ? input.options.map(normalizeQueueOption).filter((option) => option.label)
    : [];
  const now = new Date().toISOString();
  const item = {
    id: `ccq_${Date.now()}_${++workQueueSeq}`,
    status: 'open',
    title,
    question,
    details: String(input.details || input.context || '').trim(),
    source: String(input.source || 'fleet_supervisor').trim(),
    priority: String(input.priority || 'normal').trim(),
    sessionKind: String(input.sessionKind || input.session_kind || '').trim(),
    sessionId: String(input.sessionId || input.session_id || '').trim(),
    threadId: String(input.threadId || input.thread_id || '').trim(),
    passThrough: input.passThrough === true || input.pass_through === true,
    ...(operatorAction ? {
      operatorAction,
      sessionKind: principal.kind,
      sessionId: principal.sessionId,
      passThrough: true,
    } : {}),
    options: operatorAction ? [
      { id: 'approve', label: 'Approve and run', value: 'approved' },
      { id: 'reject', label: 'Reject', value: 'rejected' },
    ] : options,
    allowFreeform: !operatorAction && input.allowFreeform !== false && input.allow_freeform !== false,
    deliveryStatus: 'none',
    events: [queueEvent('created')],
    createdAt: now,
    updatedAt: now,
    answer: null,
  };
  humanWorkQueue.unshift(item);
  if (humanWorkQueue.length > 200) humanWorkQueue.length = 200;
  if (persist) await persistHumanWorkQueue();
  broadcastWorkQueue(wsManager, 'item_created');
  return item;
}

async function maybeRouteQueueAnswer(item, answerText, { sendSessionInput } = {}) {
  if (!item.passThrough) return { mode: 'supervisor', routed: false };
  const kind = String(item.sessionKind || '').trim().toLowerCase();
  const sessionId = String(item.sessionId || '').trim();
  if (!['claude', 'codex', 'pi'].includes(kind) || !sessionId || typeof sendSessionInput !== 'function') {
    return { mode: 'pass_through', routed: false, error: 'missing_target_session' };
  }
  const text = item.operatorAction ? answerText : [
    `Answer for Command Center queue item ${item.id}:`,
    answerText,
  ].join('\n');
  try {
    const result = await sendSessionInput({ kind, sessionId, text });
    return { mode: 'pass_through', routed: true, kind, sessionId, result: result || null };
  } catch (err) {
    return { mode: 'pass_through', routed: false, kind, sessionId, error: err.message || 'route_failed' };
  }
}

export async function answerHumanQueueItem(id, input = {}, {
  wsManager,
  sendSessionInput,
  enqueueSessionCommand = enqueueAgentSessionCommand,
  principal,
  executeOperatorAction,
  persist = true,
} = {}) {
  await ensureHumanWorkQueueLoaded();
  const item = humanWorkQueue.find((entry) => entry.id === id);
  if (!item) {
    const error = new Error('Queue item not found');
    error.statusCode = 404;
    throw error;
  }
  if (item.operatorAction && principal?.type !== 'ui') {
    const error = new Error('Operator action answers require an authenticated operator');
    error.statusCode = 403;
    throw error;
  }
  if (item.status !== 'open') {
    const error = new Error(`Queue item is already ${item.status}`);
    error.statusCode = 409;
    throw error;
  }
  const selectedOption = item.options.find((option) => option.id === input.optionId || option.value === input.optionValue) || null;
  if (item.operatorAction && !['approve', 'reject'].includes(selectedOption?.id)) {
    const error = new Error('Choose Approve and run or Reject');
    error.statusCode = 400;
    throw error;
  }
  let answerText = String(input.answer || selectedOption?.value || selectedOption?.label || '').trim();
  if (!answerText) {
    const error = new Error('answer or optionId is required');
    error.statusCode = 400;
    throw error;
  }
  if (!Array.isArray(item.events)) item.events = [];
  const answeredAt = new Date().toISOString();
  item.status = 'answered';
  item.deliveryStatus = item.passThrough ? 'pending' : 'supervisor';
  item.answer = {
    text: answerText,
    optionId: selectedOption?.id || String(input.optionId || '').trim(),
    answeredAt,
  };
  item.events.push(queueEvent('answered', { optionId: item.answer.optionId || '' }));
  if (item.operatorAction) {
    // Claim durably before injection: a crash may lose the result, but cannot rerun the action.
    if (persist) await persistHumanWorkQueue();
    const approved = selectedOption.id === 'approve';
    let result = { status: approved ? 'approved' : 'rejected' };
    if (approved) {
      try {
        const action = validateOperatorAction(item.operatorAction);
        const response = await executeOperatorAction(action);
        let compact = response.body;
        try { compact = JSON.stringify(JSON.parse(compact)); } catch { /* Plain-text response. */ }
        result = { status: 'executed', statusCode: response.statusCode, response: String(compact || '').replace(/\s+/g, ' ').slice(0, 300) };
      } catch (error) {
        result = { status: 'blocked', error: String(error.message || error).replace(/\s+/g, ' ').slice(0, 300) };
      }
    }
    item.operatorActionResult = result;
    answerText = `[OPERATOR_ACTION] ${approved ? 'approved' : 'rejected'} · ${item.operatorAction.method} ${item.operatorAction.path}${result.statusCode ? ` → ${result.statusCode}` : ''}${result.response || result.error ? ` · ${result.response || result.error}` : ''}`;
    item.answer.text = answerText;
    if (persist) await persistHumanWorkQueue();
  }
  item.answer.delivery = await maybeRouteQueueAnswer(item, answerText, { sendSessionInput });
  if (item.passThrough) {
    if (item.answer.delivery?.routed === true) {
      item.status = 'routed';
      item.deliveryStatus = 'routed';
      item.routedAt = new Date().toISOString();
      item.updatedAt = item.routedAt;
      item.events.push(queueEvent('routed', {
        kind: item.answer.delivery.kind || '',
        sessionId: item.answer.delivery.sessionId || '',
      }));
    } else {
      item.status = 'delivery_failed';
      item.deliveryStatus = 'failed';
      item.deliveryError = item.answer.delivery?.error || 'route_failed';
      item.deliveryFailedAt = new Date().toISOString();
      item.updatedAt = item.deliveryFailedAt;
      item.events.push(queueEvent('delivery_failed', { error: item.deliveryError }));
    }
  } else {
    item.updatedAt = item.answer.answeredAt;
  }
  if (persist) await persistHumanWorkQueue();
  broadcastWorkQueue(wsManager, item.status === 'routed' ? 'item_routed' : item.status === 'delivery_failed' ? 'item_delivery_failed' : 'item_answered');

  if (activeSupervisorSession?.sessionName && item.answer.delivery?.routed !== true) {
    const routeNote = item.answer.delivery?.error ? ` Delivery note: ${item.answer.delivery.error}.` : '';
    await enqueueSessionCommand(activeSupervisorSession.backendType, activeSupervisorSession.id, {
      source: 'fleet_supervisor_human_answer',
      operation: 'message',
      text: `Human queue answered. Item ${item.id}: ${answerText}${routeNote}`,
      enter: true,
    }).catch(() => {});
  }
  return item;
}

export async function acknowledgeHumanQueueItem(id, input = {}, { wsManager, persist = true } = {}) {
  await ensureHumanWorkQueueLoaded();
  const item = humanWorkQueue.find((entry) => entry.id === id);
  if (!item) {
    const error = new Error('Queue item not found');
    error.statusCode = 404;
    throw error;
  }
  if (!['answered', 'routed'].includes(item.status)) {
    const error = new Error('Queue item is not answerable/routeable for acknowledgement');
    error.statusCode = 400;
    throw error;
  }
  if (!Array.isArray(item.events)) item.events = [];
  const acknowledgedAt = new Date().toISOString();
  item.status = 'acknowledged';
  item.deliveryStatus = 'acknowledged';
  item.acknowledgedAt = acknowledgedAt;
  item.acknowledgement = {
    text: String(input.note || input.text || '').trim(),
    acknowledgedAt,
  };
  item.updatedAt = acknowledgedAt;
  item.events.push(queueEvent('acknowledged'));
  if (persist) await persistHumanWorkQueue();
  broadcastWorkQueue(wsManager, 'item_acknowledged');
  return item;
}

export async function dismissHumanQueueItem(id, { wsManager, sendSessionInput, persist = true } = {}) {
  await ensureHumanWorkQueueLoaded();
  const item = humanWorkQueue.find((entry) => entry.id === id);
  if (!item) {
    const error = new Error('Queue item not found');
    error.statusCode = 404;
    throw error;
  }
  if (item.status === 'dismissed') return item;
  // An open pass-through item has a session waiting on it; tell it there is no answer coming.
  if (item.status === 'open' && item.passThrough) {
    await maybeRouteQueueAnswer(item, 'Dismissed by the operator without an answer.', { sendSessionInput });
  }
  if (!Array.isArray(item.events)) item.events = [];
  item.status = 'dismissed';
  item.dismissedAt = new Date().toISOString();
  item.updatedAt = item.dismissedAt;
  item.events.push(queueEvent('dismissed'));
  if (persist) await persistHumanWorkQueue();
  broadcastWorkQueue(wsManager, 'item_dismissed');
  return item;
}

// ── Launch / manage ──

export function resetCommandCenterRuntimeStateForTests() {
  stopAutoCompact();
  stopSupervisorAutoCompact();
  activeSession = null;
  activeSupervisorSession = null;
}

async function launchManagedCommandCenterSession({
  mode = 'command_center',
  model,
  provider,
  log,
  enqueueSessionCommand,
}, {
  createSession = createAgentSession,
  scheduleStartup = setTimeout,
  getPreferences = getAgentProviderPreferencesSync,
  getPreferredModel = getPreferredModelForProvider,
} = {}) {
  const supervisor = mode === 'fleet_supervisor';
  const existing = supervisor ? activeSupervisorSession : activeSession;
  if (existing) {
    return { alreadyRunning: true, ...existing };
  }
  const resolvedTarget = await resolveCommandCenterTargetDiscovered(
    { model, provider },
    getPreferences(),
    getPreferredModel,
  );
  const result = await createSession(resolvedTarget.backendType, {
    workDir: resolvedTarget.backendType === 'codex' ? DATA_DIR : resolve('.'),
    model: resolvedTarget.model,
    provider: resolvedTarget.provider,
    thinkingLevel: resolvedTarget.thinkingLevel,
    source: supervisor ? 'fleet-supervisor-ai' : 'command-center-ai',
    displayName: supervisor ? 'Fleet Supervisor AI' : 'Command Center AI',
    promptProfile: supervisor ? 'fleet-supervisor' : 'command-center',
    mcpProfile: 'dueno',
    ...(supervisor ? { mcpCredentialProfile: FLEET_SUPERVISOR_MCP_CREDENTIAL_PROFILE } : {}),
  });

  const session = {
    id: result.id,
    sessionName: result.sessionName,
    model: resolvedTarget.model,
    provider: resolvedTarget.provider,
    backendType: resolvedTarget.backendType,
    runtime: resolvedTarget.runtime,
    thinkingLevel: resolvedTarget.thinkingLevel,
    startedAt: new Date().toISOString(),
  };

  if (supervisor) {
    activeSupervisorSession = session;
    if (log) startSupervisorAutoCompact(session, log, enqueueSessionCommand);
  } else {
    activeSession = session;
    if (log) startAutoCompact(session, log, enqueueSessionCommand);
  }

  scheduleStartup(async () => {
    try {
      const initPrompt = buildStartupPrompt({ mode });
      await enqueueSessionCommand(resolvedTarget.backendType, result.id, {
        source: supervisor ? 'fleet_supervisor_startup' : 'command_center_startup',
        operation: 'startup',
        text: initPrompt,
        enter: true,
      });
    } catch {
      // Non-fatal
    }
  }, 4000);

  return session;
}

export async function launchCommandCenterAI({
  model = DEFAULT_COMMAND_CENTER_MODEL,
  provider = DEFAULT_COMMAND_CENTER_PROVIDER,
  log,
  enqueueSessionCommand = enqueueAgentSessionCommand,
} = {}, dependencies = {}) {
  return launchManagedCommandCenterSession({
    model, provider, log, enqueueSessionCommand,
  }, dependencies);
}

export async function launchFleetSupervisorAI({
  model = DEFAULT_COMMAND_CENTER_MODEL,
  provider = DEFAULT_COMMAND_CENTER_PROVIDER,
  log,
  enqueueSessionCommand = enqueueAgentSessionCommand,
} = {}, dependencies = {}) {
  return launchManagedCommandCenterSession({
    mode: 'fleet_supervisor', model, provider, log, enqueueSessionCommand,
  }, dependencies);
}

export async function getCommandCenterStatus() {
  // Verify the tmux session is actually alive
  if (activeSession) {
    const { code } = await exec('tmux', ['has-session', '-t', activeSession.sessionName]);
    if (code !== 0) {
      // Session is dead — clean up stale state
      stopAutoCompact();
      activeSession = null;
    }
  }
  await getFleetSupervisorStatus();

  return {
    active: activeSession !== null,
    autoCompactIntervalMs: COMPACT_INTERVAL_MS,
    autoCompactRunning: compactInterval !== null,
    session: activeSession,
    supervisor: {
      active: activeSupervisorSession !== null,
      autoCompactRunning: supervisorCompactInterval !== null,
      session: activeSupervisorSession,
    },
  };
}

export async function getFleetSupervisorStatus() {
  if (activeSupervisorSession) {
    const { code } = await exec('tmux', ['has-session', '-t', activeSupervisorSession.sessionName]);
    if (code !== 0) {
      stopSupervisorAutoCompact();
      activeSupervisorSession = null;
    }
  }
  return {
    active: activeSupervisorSession !== null,
    autoCompactIntervalMs: COMPACT_INTERVAL_MS,
    autoCompactRunning: supervisorCompactInterval !== null,
    session: activeSupervisorSession,
  };
}

export async function stopCommandCenterAI() {
  stopAutoCompact();
  if (!activeSession) return { ok: false, error: 'Not running' };

  try {
    await exec('tmux', ['kill-session', '-t', activeSession.sessionName]);
  } catch {
    // May already be dead
  }

  const stopped = { ...activeSession };
  activeSession = null;
  return { ok: true, stopped };
}

export async function stopFleetSupervisorAI() {
  stopSupervisorAutoCompact();
  if (!activeSupervisorSession) return { ok: false, error: 'Not running' };

  try {
    await exec('tmux', ['kill-session', '-t', activeSupervisorSession.sessionName]);
  } catch {
    // May already be dead
  }

  const stopped = { ...activeSupervisorSession };
  activeSupervisorSession = null;
  return { ok: true, stopped };
}

async function getCommandCenterModelCatalog() {
  const preferences = getAgentProviderPreferencesSync();
  const [codexModels, claudeModels] = await Promise.all([
    preferences.codexEnabled ? listCodexModels() : Promise.resolve([]),
    preferences.claudeEnabled ? listClaudeModels() : Promise.resolve([]),
  ]);

  return buildCommandCenterModelCatalog({
    preferences,
    codexModels,
    claudeModels,
  });
}

// ── Fastify plugin ──

export async function commandCenterAIPlugin(app, {
  wsManager,
  enqueueSessionCommand = enqueueAgentSessionCommand,
} = {}) {
  async function sendSessionInput({ kind, sessionId, text }) {
    const normalizedKind = String(kind || '').trim().toLowerCase();
    if (!['claude', 'codex', 'pi'].includes(normalizedKind)) throw new Error('sessionKind must be claude, codex, or pi');
    return enqueueSessionCommand(normalizedKind, sessionId, {
      source: 'command_center_queue_answer',
      operation: 'message',
      text,
      enter: true,
    });
  }

  app.get('/api/command-center/status', async () => getCommandCenterStatus());

  app.get('/api/command-center/models', async (_req, reply) => {
    try {
      return await getCommandCenterModelCatalog();
    } catch (err) {
      return reply.code(500).send({ error: err.message || 'Failed to load command center models' });
    }
  });

  app.post('/api/command-center/launch', async (req) => {
    const { model, provider } = req.body || {};
    const result = await launchCommandCenterAI({ model, provider, log: app.log, enqueueSessionCommand });
    return result;
  });

  app.post('/api/command-center/supervisor/launch', async (req) => {
    const { model, provider } = req.body || {};
    return launchFleetSupervisorAI({ model, provider, log: app.log, enqueueSessionCommand });
  });

  app.post('/api/command-center/supervisor/stop', async () => {
    return stopFleetSupervisorAI();
  });

  app.get('/api/command-center/work-queue', async (req) =>
    serializeWorkQueue({ status: req.query?.status || 'open' })
  );

  app.post('/api/command-center/work-queue', async (req, reply) => {
    try {
      return await addHumanQueueItem(req.body || {}, { wsManager, principal: req.duenoAuth?.principal });
    } catch (err) {
      return reply.code(err.statusCode || 500).send({ error: err.message || 'Failed to add queue item' });
    }
  });

  app.post('/api/command-center/work-queue/:id/answer', async (req, reply) => {
    try {
      return await answerHumanQueueItem(req.params.id, req.body || {}, {
        wsManager,
        sendSessionInput,
        enqueueSessionCommand,
        principal: req.duenoAuth?.principal,
        executeOperatorAction: (action) => app.inject({
          method: action.method,
          url: action.path,
          payload: action.body ?? {},
          headers: { cookie: `${BROWSER_SESSION_COOKIE}=${createBrowserSessionCookieValue()}` },
        }),
      });
    } catch (err) {
      return reply.code(err.statusCode || 500).send({ error: err.message || 'Failed to answer queue item' });
    }
  });

  app.post('/api/command-center/work-queue/:id/acknowledge', async (req, reply) => {
    try {
      return await acknowledgeHumanQueueItem(req.params.id, req.body || {}, { wsManager });
    } catch (err) {
      return reply.code(err.statusCode || 500).send({ error: err.message || 'Failed to acknowledge queue item' });
    }
  });

  app.post('/api/command-center/work-queue/:id/dismiss', async (req, reply) => {
    try {
      return await dismissHumanQueueItem(req.params.id, { wsManager, sendSessionInput });
    } catch (err) {
      return reply.code(err.statusCode || 500).send({ error: err.message || 'Failed to dismiss queue item' });
    }
  });

  app.post('/api/command-center/stop', async () => {
    return stopCommandCenterAI();
  });

  // Send a message to the command center AI
  app.post('/api/command-center/send', async (req, reply) => {
    const status = await getCommandCenterStatus();
    if (!status.active || !activeSession) return reply.code(400).send({ error: 'Command center AI not running' });
    const { text } = req.body || {};
    if (!text) return reply.code(400).send({ error: 'Missing text' });

    try {
      return await enqueueSessionCommand(activeSession.backendType, activeSession.id, {
        source: 'command_center_api',
        operation: 'message',
        text,
        enter: true,
      });
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });

  // Force compact
  app.post('/api/command-center/compact', async (req, reply) => {
    const status = await getCommandCenterStatus();
    if (!status.active || !activeSession) return reply.code(400).send({ error: 'Not running' });
    try {
      return await enqueueSessionCommand(activeSession.backendType, activeSession.id, {
        source: 'command_center_compact',
        operation: 'compact',
        text: '/compact',
        enter: true,
      });
    } catch (err) {
      return reply.code(500).send({ error: err.message });
    }
  });
}
