import { randomBytes } from 'node:crypto';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { legacyRootStatePath, runtimeStatePath } from '../ops/runtime-state.mjs';

const DEFAULT_STORE_FILE = runtimeStatePath('session_delivery_audit.json');
const MAX_ENTRIES = 5000;
const PREVIEW_LENGTH = 240;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeId() {
  return `sdel_${randomBytes(8).toString('hex')}`;
}

function text(value) {
  return String(value || '').trim();
}

function normalizeKind(value) {
  const normalized = text(value).toLowerCase();
  return ['claude', 'codex', 'pi', 'deepseek'].includes(normalized) ? normalized : '';
}

function normalizeLimit(value, fallback = 100) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 500);
}

function previewFor(input) {
  const normalized = String(input ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > PREVIEW_LENGTH
    ? `${normalized.slice(0, PREVIEW_LENGTH - 3)}...`
    : normalized;
}

export function buildSessionDeliveryAuditStore({
  storeFile = DEFAULT_STORE_FILE,
  stateStore = null,
} = {}) {
  const backingStore = stateStore || buildPostgresJsonStore({
    namespace: 'session_delivery_audit',
    filePath: storeFile,
    legacyFilePath: legacyRootStatePath('session_delivery_audit.json'),
    modeEnvKey: 'SESSION_DELIVERY_AUDIT_STORAGE',
  });

  const state = {
    entries: [],
  };
  let ready = false;

  async function init() {
    if (ready) return;
    const loaded = await backingStore.load().catch(() => null);
    if (loaded && typeof loaded === 'object') {
      state.entries = Array.isArray(loaded.entries) ? loaded.entries : [];
    }
    ready = true;
  }

  async function persist() {
    await backingStore.save({ entries: state.entries });
  }

  async function record({
    source = 'api',
    kind,
    sessionId,
    text: inputText = '',
    enter = false,
    status = 'sent',
    error = '',
    metadata = {},
  } = {}) {
    await init();
    const now = new Date().toISOString();
    const entry = {
      id: makeId(),
      source: text(source) || 'api',
      target: {
        kind: normalizeKind(kind) || text(kind),
        sessionId: text(sessionId),
      },
      status: text(status).toLowerCase() || 'sent',
      enter: Boolean(enter),
      textLength: String(inputText ?? '').length,
      textPreview: previewFor(inputText),
      error: text(error),
      createdAt: now,
      completedAt: now,
      metadata: metadata && typeof metadata === 'object' ? clone(metadata) : {},
    };
    state.entries.unshift(entry);
    state.entries = state.entries.slice(0, MAX_ENTRIES);
    await persist();
    return clone(entry);
  }

  function list({ kind = '', sessionId = '', source = '', status = '', transactionId = '', limit = 100, offset = 0 } = {}) {
    const normalizedKind = normalizeKind(kind);
    const normalizedSessionId = text(sessionId);
    const normalizedSource = text(source);
    const normalizedStatus = text(status).toLowerCase();
    const normalizedTransactionId = text(transactionId);
    return state.entries
      .filter((entry) => !normalizedKind || entry.target?.kind === normalizedKind)
      .filter((entry) => !normalizedSessionId || entry.target?.sessionId === normalizedSessionId)
      .filter((entry) => !normalizedSource || entry.source === normalizedSource)
      .filter((entry) => !normalizedStatus || entry.status === normalizedStatus)
      .filter((entry) => !normalizedTransactionId || entry.metadata?.transactionId === normalizedTransactionId)
      .slice(Math.max(0, Number(offset) || 0), Math.max(0, Number(offset) || 0) + normalizeLimit(limit))
      .map((entry) => {
        const copy = clone(entry);
        const created = Date.parse(copy.createdAt);
        copy.ageMs = Number.isFinite(created) ? Math.max(0, Date.now() - created) : 0;
        return copy;
      });
  }

  function listAll({ kind = '', sessionId = '', source = '', status = '', transactionId = '' } = {}) {
    const normalizedKind = normalizeKind(kind);
    const normalizedSessionId = text(sessionId);
    const normalizedSource = text(source);
    const normalizedStatus = text(status).toLowerCase();
    const normalizedTransactionId = text(transactionId);
    return state.entries
      .filter((entry) => !normalizedKind || entry.target?.kind === normalizedKind)
      .filter((entry) => !normalizedSessionId || entry.target?.sessionId === normalizedSessionId)
      .filter((entry) => !normalizedSource || entry.source === normalizedSource)
      .filter((entry) => !normalizedStatus || entry.status === normalizedStatus)
      .filter((entry) => !normalizedTransactionId || entry.metadata?.transactionId === normalizedTransactionId)
      .map(clone);
  }

  async function close() {
    if (typeof backingStore.close === 'function') {
      await backingStore.close();
    }
  }

  return { init, record, list, listAll, close };
}

export async function recordSessionDeliveryAudit(store, payload) {
  if (!store || typeof store.record !== 'function') return null;
  return store.record(payload);
}

export async function sessionDeliveryAuditPlugin(app, {
  store = buildSessionDeliveryAuditStore(),
} = {}) {
  await store.init();

  app.addHook('onClose', async () => {
    await store.close();
  });

  app.get('/api/session-deliveries', async (req) => ({
    deliveries: store.list({
      kind: req.query?.kind,
      sessionId: req.query?.sessionId,
      source: req.query?.source,
      status: req.query?.status,
      transactionId: req.query?.transactionId,
      limit: req.query?.limit,
      offset: req.query?.offset,
    }),
  }));
}
