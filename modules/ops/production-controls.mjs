import { randomBytes } from 'node:crypto';
import { config } from '../../config.mjs';
import { queueControlEvent } from './control-events.mjs';
import { buildPostgresJsonStore } from './postgres-json-store.mjs';
import { legacyRootStatePath, runtimeStatePath } from './runtime-state.mjs';

const DEFAULT_STORE_FILE = runtimeStatePath('production_controls.json');
const LEGACY_STORE_FILE = legacyRootStatePath('production_controls.json');

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const normalized = normalizeText(value).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function generateId(prefix = 'pc') {
  return `${prefix}_${randomBytes(6).toString('hex')}`;
}

export class ProductionControlDisabledError extends Error {
  constructor(message, {
    flagKey = '',
    envVar = '',
    module = '',
    operation = '',
    detail = '',
    controlSource = '',
  } = {}) {
    super(message);
    this.name = 'ProductionControlDisabledError';
    this.code = 'production_control_disabled';
    this.statusCode = 503;
    this.flagKey = normalizeText(flagKey);
    this.envVar = normalizeText(envVar);
    this.module = normalizeText(module);
    this.operation = normalizeText(operation);
    this.detail = normalizeText(detail);
    this.controlSource = normalizeText(controlSource);
  }
}

const FLAG_DEFINITIONS = [
  {
    key: 'agentBus.deliveryReplay',
    module: 'agentBus',
    operation: 'delivery_replay',
    envVar: 'PC_FLAG_AGENT_BUS_DELIVERY_REPLAY_ENABLED',
    description: 'Allows failed or timed-out Agent Bus deliveries to be replayed into target sessions.',
    configPath: ['productionControls', 'agentBusDeliveryReplayEnabled'],
    defaultEnabled: true,
  },
];

function readFromConfigPath(source, path = []) {
  return path.reduce((current, key) => (current && typeof current === 'object' ? current[key] : undefined), source);
}

function normalizeOverrideEntry(flagKey, value = {}) {
  return {
    flagKey: normalizeText(flagKey),
    enabled: normalizeBoolean(value?.enabled, true),
    reason: normalizeText(value?.reason || ''),
    changedAt: normalizeText(value?.changedAt || '') || new Date().toISOString(),
    changedBy: normalizeText(value?.changedBy || '') || 'operator',
    source: 'runtime_override',
  };
}

function normalizeAuditEntry(entry = {}) {
  return {
    id: normalizeText(entry.id || '') || generateId('pcaudit'),
    flagKey: normalizeText(entry.flagKey || ''),
    module: normalizeText(entry.module || ''),
    operation: normalizeText(entry.operation || ''),
    action: normalizeText(entry.action || '') || 'override_set',
    previousEnabled: normalizeBoolean(entry.previousEnabled, false),
    nextEnabled: normalizeBoolean(entry.nextEnabled, false),
    previousSource: normalizeText(entry.previousSource || ''),
    nextSource: normalizeText(entry.nextSource || ''),
    reason: normalizeText(entry.reason || ''),
    changedBy: normalizeText(entry.changedBy || '') || 'operator',
    metadata: entry.metadata && typeof entry.metadata === 'object' ? clone(entry.metadata) : {},
    createdAt: normalizeText(entry.createdAt || '') || new Date().toISOString(),
  };
}

function normalizeState(raw = {}, flagMap = new Map()) {
  const overrides = {};
  if (raw?.overrides && typeof raw.overrides === 'object') {
    for (const [flagKey, value] of Object.entries(raw.overrides)) {
      if (!flagMap.has(flagKey)) continue;
      overrides[flagKey] = normalizeOverrideEntry(flagKey, value);
    }
  }
  const audit = Array.isArray(raw?.audit)
    ? raw.audit
      .map((entry) => normalizeAuditEntry(entry))
      .filter((entry) => flagMap.has(entry.flagKey))
    : [];
  return {
    version: 1,
    overrides,
    audit,
  };
}

export function buildProductionControlRegistry({
  sourceConfig = config,
  controlEventRecorder = queueControlEvent,
  storeFile = DEFAULT_STORE_FILE,
  namespace = 'production_controls',
  env = process.env,
  modeEnvKey = 'APP_STATE_STORAGE',
  maxAuditEntries = 2000,
} = {}) {
  const definitions = FLAG_DEFINITIONS.map((definition) => ({ ...definition }));
  const flagMap = new Map(definitions.map((definition) => [definition.key, definition]));
  const stateStore = buildPostgresJsonStore({
    namespace,
    filePath: storeFile,
    legacyFilePath: storeFile === DEFAULT_STORE_FILE ? LEGACY_STORE_FILE : undefined,
    env,
    modeEnvKey,
  });
  let loadFailure = null;
  let authoritative = false;
  let initialState = {};
  try {
    const loaded = stateStore.loadSync?.();
    if (loaded == null) {
      authoritative = true;
    } else {
      initialState = loaded;
      authoritative = true;
    }
  } catch (error) {
    loadFailure = error;
    authoritative = false;
  }
  let state = normalizeState(initialState, flagMap);
  let loadingPromise = null;
  let saveQueue = Promise.resolve();
  let closed = false;

  function getDefinition(flagKey) {
    const definition = flagMap.get(flagKey);
    if (!definition) {
      throw new Error(`Unknown production control flag: ${flagKey}`);
    }
    return definition;
  }

  function getBaseEnabled(definition) {
    return normalizeBoolean(
      readFromConfigPath(sourceConfig, definition.configPath),
      normalizeBoolean(definition.defaultEnabled, true)
    );
  }

  function getOverride(flagKey) {
    return state.overrides[flagKey] ? clone(state.overrides[flagKey]) : null;
  }

  function getFlag(flagKey) {
    const definition = getDefinition(flagKey);
    const override = state.overrides[definition.key] || null;
    const baseEnabled = getBaseEnabled(definition);
    const enabled = override ? override.enabled : baseEnabled;
    const controlSource = override ? 'runtime_override' : 'env_config';
    return {
      key: definition.key,
      module: definition.module,
      operation: definition.operation,
      envVar: definition.envVar,
      description: definition.description,
      enabled,
      baseEnabled,
      overrideActive: Boolean(override),
      overrideEnabled: override ? override.enabled : null,
      controlSource,
      reason: override?.reason || '',
      changedAt: override?.changedAt || null,
      changedBy: override?.changedBy || null,
    };
  }

  function appendAuditEntry(entry = {}) {
    state.audit.unshift(normalizeAuditEntry(entry));
    state.audit = state.audit.slice(0, Math.max(100, Number(maxAuditEntries || 2000)));
  }

  async function persistState() {
    if (!authoritative) {
      throw loadFailure || new Error('production control state is unavailable');
    }
    const snapshot = clone(state);
    const write = saveQueue.catch(() => {}).then(() => stateStore.save(snapshot));
    saveQueue = write.catch(() => {});
    await write;
  }

  async function ready() {
    if (!loadingPromise) {
      loadingPromise = (async () => {
        const loaded = await stateStore.load();
        if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
          state = normalizeState(loaded, flagMap);
        }
        authoritative = true;
        loadFailure = null;
      })().finally(() => {
        loadingPromise = null;
      });
    }
    await loadingPromise;
  }

  function isEnabled(flagKey) {
    return Boolean(getFlag(flagKey).enabled);
  }

  function moduleStatus(moduleName) {
    const flags = definitions
      .filter((definition) => definition.module === moduleName)
      .map((definition) => getFlag(definition.key));
    const disabledFlags = flags.filter((flag) => !flag.enabled).map((flag) => flag.key);
    return {
      module: moduleName,
      enabled: disabledFlags.length === 0,
      killSwitchesActive: disabledFlags,
      overridesActive: flags.filter((flag) => flag.overrideActive).map((flag) => flag.key),
      flags,
    };
  }

  function snapshot() {
    const modules = {};
    for (const moduleName of [...new Set(definitions.map((definition) => definition.module))]) {
      modules[moduleName] = moduleStatus(moduleName);
    }
    return {
      status: Object.values(modules).some((entry) => entry.killSwitchesActive.length > 0) ? 'degraded' : 'ok',
      killSwitchesActive: definitions.filter((definition) => !getFlag(definition.key).enabled).map((definition) => definition.key),
      overridesActive: definitions.filter((definition) => getFlag(definition.key).overrideActive).map((definition) => definition.key),
      flags: definitions.map((definition) => getFlag(definition.key)),
      overrideCount: Object.keys(state.overrides).length,
      auditEntryCount: state.audit.length,
      lastChangedAt: state.audit[0]?.createdAt || null,
      modules,
    };
  }

  function getAuditHistory({ flagKey = '', module = '', action = '', changedBy = '', limit = 100 } = {}) {
    const normalizedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    return state.audit
      .filter((entry) => !flagKey || entry.flagKey === normalizeText(flagKey))
      .filter((entry) => !module || entry.module === normalizeText(module))
      .filter((entry) => !action || entry.action === normalizeText(action))
      .filter((entry) => !changedBy || entry.changedBy === normalizeText(changedBy))
      .slice(0, normalizedLimit)
      .map(clone);
  }

  function getAuditSummary({ sinceHours = 24, limit = 1000 } = {}) {
    const hasSinceHours = !(sinceHours === null || sinceHours === undefined || sinceHours === '');
    const normalizedSinceHours = hasSinceHours ? Number(sinceHours) : null;
    const cutoffMs = Number.isFinite(normalizedSinceHours)
      ? Date.now() - Math.max(0, normalizedSinceHours) * 3600_000
      : 0;
    const rows = state.audit
      .filter((entry) => {
        if (!cutoffMs) return true;
        const createdAtMs = Date.parse(entry.createdAt);
        return Number.isFinite(createdAtMs) ? createdAtMs >= cutoffMs : true;
      })
      .slice(0, Math.max(1, Math.min(5000, Number(limit) || 1000)));
    const byAction = {};
    const byFlag = {};
    const byActor = {};
    for (const entry of rows) {
      byAction[entry.action] = Number(byAction[entry.action] || 0) + 1;
      byFlag[entry.flagKey] = Number(byFlag[entry.flagKey] || 0) + 1;
      byActor[entry.changedBy] = Number(byActor[entry.changedBy] || 0) + 1;
    }
    return {
      sinceHours: Number.isFinite(normalizedSinceHours) ? normalizedSinceHours : null,
      total: rows.length,
      latestCreatedAt: rows[0]?.createdAt || null,
      byAction,
      byFlag,
      byActor,
    };
  }

  async function setOverride(flagKey, { enabled, changedBy = 'operator', reason = '', metadata = {} } = {}) {
    await ready();
    if (typeof enabled !== 'boolean') {
      throw new Error('enabled must be provided as a boolean');
    }
    const definition = getDefinition(flagKey);
    const previous = getFlag(flagKey);
    const overrideEntry = normalizeOverrideEntry(flagKey, {
      enabled,
      changedBy,
      reason,
      changedAt: new Date().toISOString(),
    });
    state.overrides[definition.key] = overrideEntry;
    const current = getFlag(flagKey);
    appendAuditEntry({
      flagKey: definition.key,
      module: definition.module,
      operation: definition.operation,
      action: 'override_set',
      previousEnabled: previous.enabled,
      nextEnabled: current.enabled,
      previousSource: previous.controlSource,
      nextSource: current.controlSource,
      reason,
      changedBy,
      metadata,
    });
    await persistState();
    if (typeof controlEventRecorder === 'function') {
      controlEventRecorder({
        type: 'production_control_override',
        severity: current.enabled ? 'info' : 'warning',
        module: definition.module,
        action: definition.operation,
        outcome: current.enabled ? 'enabled' : 'disabled',
        code: current.enabled ? 'production_control.override_enabled' : 'production_control.override_disabled',
        detail: definition.key,
        message: `Runtime override ${current.enabled ? 'enabled' : 'disabled'} ${definition.key}`,
        metadata: {
          changedBy: normalizeText(changedBy) || 'operator',
          reason: normalizeText(reason),
        },
      });
    }
    return getFlag(definition.key);
  }

  async function clearOverride(flagKey, { changedBy = 'operator', reason = '', metadata = {} } = {}) {
    await ready();
    const definition = getDefinition(flagKey);
    if (!state.overrides[definition.key]) {
      return null;
    }
    const previous = getFlag(flagKey);
    delete state.overrides[definition.key];
    const current = getFlag(flagKey);
    appendAuditEntry({
      flagKey: definition.key,
      module: definition.module,
      operation: definition.operation,
      action: 'override_cleared',
      previousEnabled: previous.enabled,
      nextEnabled: current.enabled,
      previousSource: previous.controlSource,
      nextSource: current.controlSource,
      reason,
      changedBy,
      metadata,
    });
    await persistState();
    if (typeof controlEventRecorder === 'function') {
      controlEventRecorder({
        type: 'production_control_override',
        severity: current.enabled ? 'info' : 'warning',
        module: definition.module,
        action: definition.operation,
        outcome: 'override_cleared',
        code: 'production_control.override_cleared',
        detail: definition.key,
        message: `Runtime override cleared for ${definition.key}`,
        metadata: {
          changedBy: normalizeText(changedBy) || 'operator',
          reason: normalizeText(reason),
        },
      });
    }
    return getFlag(definition.key);
  }

  function assertEnabled(flagKey, { operation = '', detail = '' } = {}) {
    const definition = getDefinition(flagKey);
    const flag = getFlag(flagKey);
    if (flag.enabled) return true;
    const sourceLabel = flag.controlSource === 'runtime_override'
      ? 'runtime override'
      : definition.envVar;
    const message = flag.controlSource === 'runtime_override'
      ? `${definition.key} is disabled by runtime override`
      : `${definition.key} is disabled by ${definition.envVar}`;
    if (typeof controlEventRecorder === 'function') {
      controlEventRecorder({
        type: 'production_control_denied',
        severity: 'warning',
        module: definition.module,
        action: operation || definition.operation,
        outcome: 'blocked',
        code: 'production_control_disabled',
        detail,
        message,
        metadata: {
          flagKey: definition.key,
          envVar: definition.envVar,
          controlSource: flag.controlSource,
          changedBy: flag.changedBy,
        },
      });
    }
    throw new ProductionControlDisabledError(
      message,
      {
        flagKey: definition.key,
        envVar: definition.envVar,
        module: definition.module,
        operation: operation || definition.operation,
        detail,
        controlSource: sourceLabel,
      }
    );
  }

  return {
    definitions: definitions.map((definition) => ({ ...definition, baseEnabled: getBaseEnabled(definition) })),
    ready,
    isEnabled,
    assertEnabled,
    getFlag,
    getOverride,
    setOverride,
    clearOverride,
    getAuditHistory,
    getAuditSummary,
    moduleStatus,
    snapshot: () => clone(snapshot()),
    async close() {
      if (closed) return;
      closed = true;
      await saveQueue.catch(() => {});
      if (typeof stateStore.close === 'function') {
        await stateStore.close();
      }
    },
  };
}

const defaultRegistry = buildProductionControlRegistry();

export function getProductionControlRegistry() {
  return defaultRegistry;
}
