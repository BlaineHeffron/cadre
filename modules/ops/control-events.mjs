import { randomBytes } from 'node:crypto';
import { buildPostgresJsonStore } from './postgres-json-store.mjs';
import { legacyRootStatePath, runtimeStatePath } from './runtime-state.mjs';

const DEFAULT_STORE_FILE = runtimeStatePath('ops_control_events.json');
const LEGACY_STORE_FILE = legacyRootStatePath('ops_control_events.json');

function normalizeText(value) {
  return String(value || '').trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function generateId(prefix = 'ocev') {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

function normalizeSeverity(value, fallback = 'info') {
  const normalized = normalizeText(value).toLowerCase();
  return ['info', 'warning', 'critical'].includes(normalized) ? normalized : fallback;
}

function normalizeLimit(value, fallback = 50, max = 200) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(numeric)));
}

function matchesFilter(candidate, expected) {
  return !expected || normalizeText(candidate) === normalizeText(expected);
}

function summarize(events = []) {
  const bySeverity = {};
  const byOutcome = {};
  const byType = {};
  const byModule = {};

  for (const event of events) {
    bySeverity[event.severity] = Number(bySeverity[event.severity] || 0) + 1;
    byOutcome[event.outcome] = Number(byOutcome[event.outcome] || 0) + 1;
    byType[event.type] = Number(byType[event.type] || 0) + 1;
    byModule[event.module] = Number(byModule[event.module] || 0) + 1;
  }

  return {
    total: events.length,
    latestCreatedAt: events[0]?.createdAt || null,
    bySeverity,
    byOutcome,
    byType,
    byModule,
  };
}

export function buildOpsControlEventStore({
  storeFile = DEFAULT_STORE_FILE,
  namespace = 'ops_control_events',
  env = process.env,
  modeEnvKey = 'APP_STATE_STORAGE',
  now = () => new Date(),
  maxEvents = 5000,
  stateStore: injectedStore,
} = {}) {
  const stateStore = injectedStore || buildPostgresJsonStore({
    namespace,
    filePath: storeFile,
    legacyFilePath: storeFile === DEFAULT_STORE_FILE ? LEGACY_STORE_FILE : undefined,
    env,
    modeEnvKey,
  });

  let loaded = false;
  let loadingPromise = null;
  let saveQueue = Promise.resolve();
  let state = {
    version: 1,
    events: [],
  };

  async function load() {
    if (loaded) return;
    if (!loadingPromise) {
      loadingPromise = (async () => {
        const raw = await stateStore.load();
        if (raw == null) {
          state = { version: 1, events: [] };
        } else if (typeof raw !== 'object' || Array.isArray(raw)) {
          const error = new Error('corrupt control event state');
          error.code = 'STATE_CORRUPT';
          throw error;
        } else {
          state = {
            version: 1,
            events: Array.isArray(raw.events) ? raw.events : [],
          };
        }
        loaded = true;
      })().finally(() => {
        loadingPromise = null;
      });
    }
    await loadingPromise;
  }

  async function save() {
    if (!loaded) throw new Error('control event state is unavailable');
    const snapshot = clone(state);
    const write = saveQueue.catch(() => {}).then(() => stateStore.save(snapshot));
    saveQueue = write.catch(() => {});
    await write;
  }

  async function recordEvent({
    type = 'control_event',
    severity = 'info',
    module = '',
    action = '',
    outcome = 'observed',
    code = '',
    detail = '',
    message = '',
    metadata = {},
    createdAt = '',
  } = {}) {
    await load();
    const event = {
      id: generateId(),
      type: normalizeText(type || 'control_event') || 'control_event',
      severity: normalizeSeverity(severity),
      module: normalizeText(module || 'ops') || 'ops',
      action: normalizeText(action || ''),
      outcome: normalizeText(outcome || 'observed') || 'observed',
      code: normalizeText(code || ''),
      detail: normalizeText(detail || ''),
      message: normalizeText(message || ''),
      metadata: metadata && typeof metadata === 'object' ? clone(metadata) : {},
      createdAt: normalizeText(createdAt || '') || now().toISOString(),
    };
    state.events.unshift(event);
    state.events = state.events.slice(0, Math.max(100, Number(maxEvents || 5000)));
    await save();
    return clone(event);
  }

  async function listEvents({
    type = '',
    severity = '',
    module = '',
    action = '',
    outcome = '',
    code = '',
    limit = 50,
  } = {}) {
    await load();
    return state.events
      .filter((event) => matchesFilter(event.type, type))
      .filter((event) => matchesFilter(event.severity, severity))
      .filter((event) => matchesFilter(event.module, module))
      .filter((event) => matchesFilter(event.action, action))
      .filter((event) => matchesFilter(event.outcome, outcome))
      .filter((event) => matchesFilter(event.code, code))
      .slice(0, normalizeLimit(limit))
      .map(clone);
  }

  async function getSummary({
    sinceHours = 24,
    limit = 1000,
  } = {}) {
    await load();
    const hasSinceHours = sinceHours !== null && sinceHours !== undefined && Number.isFinite(Number(sinceHours));
    const cutoffMs = hasSinceHours
      ? Date.now() - Math.max(0, Number(sinceHours || 0)) * 3600_000
      : 0;
    const rows = state.events
      .filter((event) => {
        if (!cutoffMs) return true;
        const createdAtMs = Date.parse(event.createdAt);
        return Number.isFinite(createdAtMs) ? createdAtMs >= cutoffMs : true;
      })
      .slice(0, normalizeLimit(limit, 1000, 5000));
    return {
      sinceHours: hasSinceHours ? Number(sinceHours) : null,
      ...summarize(rows),
    };
  }

  async function close() {
    await saveQueue.catch(() => {});
    if (typeof stateStore.close === 'function') {
      await stateStore.close();
    }
  }

  return {
    recordEvent,
    listEvents,
    getSummary,
    close,
  };
}

const defaultStore = buildOpsControlEventStore();

export function getOpsControlEventStore() {
  return defaultStore;
}

export async function recordControlEvent(event = {}) {
  return defaultStore.recordEvent(event);
}

export async function listControlEvents(query = {}) {
  return defaultStore.listEvents(query);
}

export async function getControlEventSummary(query = {}) {
  return defaultStore.getSummary(query);
}

export function queueControlEvent(event = {}, onError = null) {
  void recordControlEvent(event).catch((error) => {
    if (typeof onError === 'function') onError(error);
  });
}
