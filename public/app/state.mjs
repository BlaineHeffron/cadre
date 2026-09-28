import { signal, computed } from '@preact/signals';
import { isKnownAgentProvider, providerDescriptor } from './providers.mjs';
import { sessionTitle } from './agent-bus-ui.mjs';

// Auth state
export const authChecked = signal(false);
export const isAuthenticated = signal(false);

// Connection state
export const wsConnected = signal(false);

// Threat state
export const alerts = signal([]);
export const unreadAlerts = computed(() => alerts.value.filter(a => !a.acknowledged).length);

// Tmux state
export const tmuxSessions = signal([]);

// Claude sessions state
export const claudeSessions = signal([]);
export const claudePromptNotifications = signal([]);

// Codex sessions state
export const codexSessions = signal([]);
export const codexPromptNotifications = signal([]);

// Pi sessions
export const piSessions = signal([]);
export const piPromptNotifications = signal([]);

// DeepSeek Harness ACP sessions
export const deepseekSessions = signal([]);
export const deepseekPromptNotifications = signal([]);

// Agent collaboration state
export const agentThreads = signal([]);
export const agentBusAlerts = signal([]);
export const agentBusMcpHealth = signal(null);
export const openAgentThreadCount = computed(() =>
  agentThreads.value.filter(t => t.status === 'open').length
);
export const unreadAgentAlerts = computed(() => agentBusAlerts.value.length);

// Track which sessions the user has seen (visited detail page)
const SEEN_KEY = 'dueno_seen_sessions';
const CLAUDE_ATTENTION_SEEN_KEY = 'dueno_seen_claude_prompt_notifications';
const CODEX_ATTENTION_SEEN_KEY = 'dueno_seen_codex_prompt_notifications';
export const seenSessionIds = signal(loadSeen());
export const seenCodexSessionIds = signal(loadSeen('dueno_seen_codex_sessions'));
export const seenPiSessionIds = signal(loadSeen('dueno_seen_pi_sessions'));
export const seenDeepseekSessionIds = signal(loadSeen('dueno_seen_deepseek_sessions'));
export const seenClaudePromptNotificationKeys = signal(loadSeen(CLAUDE_ATTENTION_SEEN_KEY));
export const seenCodexPromptNotificationKeys = signal(loadSeen(CODEX_ATTENTION_SEEN_KEY));
export const seenPiPromptNotificationKeys = signal(loadSeen('dueno_seen_pi_prompt_notifications'));
export const seenDeepseekPromptNotificationKeys = signal(loadSeen('dueno_seen_deepseek_prompt_notifications'));

function isSeenWaitingPrompt(session, seenStore) {
  return session?.state?.status === 'ready'
    && session?.attention?.active
    && session.attention.kind === 'prompt_ready'
    && seenStore.value.has(session.attention.key);
}

export const claudeNeedsInput = computed(() =>
  claudeSessions.value.filter((session) =>
    session?.state?.capabilities?.needsAttention === true
      && !isSeenWaitingPrompt(session, seenClaudePromptNotificationKeys)
  ).length
);

export const codexNeedsInput = computed(() =>
  codexSessions.value.filter((session) =>
    session?.state?.capabilities?.needsAttention === true
      && !isSeenWaitingPrompt(session, seenCodexPromptNotificationKeys)
  ).length
);

export const piNeedsInput = computed(() =>
  piSessions.value.filter((session) =>
    session?.state?.capabilities?.needsAttention === true
      && !isSeenWaitingPrompt(session, seenPiPromptNotificationKeys)
  ).length
);

export const deepseekNeedsInput = computed(() =>
  deepseekSessions.value.filter((session) => session?.state?.capabilities?.needsAttention === true).length
);

export function sessionStoreForKind(kind) {
  if (kind === 'claude') return claudeSessions;
  if (kind === 'pi') return piSessions;
  if (kind === 'deepseek') return deepseekSessions;
  return codexSessions;
}

export function seenSessionStoreForKind(kind) {
  if (kind === 'claude') return seenSessionIds;
  if (kind === 'pi') return seenPiSessionIds;
  if (kind === 'deepseek') return seenDeepseekSessionIds;
  return seenCodexSessionIds;
}

function seenPromptStoreForKind(kind) {
  if (kind === 'claude') return seenClaudePromptNotificationKeys;
  if (kind === 'pi') return seenPiPromptNotificationKeys;
  if (kind === 'deepseek') return seenDeepseekPromptNotificationKeys;
  return seenCodexPromptNotificationKeys;
}

function promptNotificationsStoreForKind(kind) {
  if (kind === 'claude') return claudePromptNotifications;
  if (kind === 'pi') return piPromptNotifications;
  if (kind === 'deepseek') return deepseekPromptNotifications;
  return codexPromptNotifications;
}

export function setClaudeSessions(sessions) {
  claudeSessions.value = Array.isArray(sessions) ? sessions : [];
  pruneSeenSessionsForKind('claude');
}

export function setCodexSessions(sessions) {
  codexSessions.value = Array.isArray(sessions) ? sessions : [];
  pruneSeenSessionsForKind('codex');
}

export function setPiSessions(sessions) {
  piSessions.value = Array.isArray(sessions) ? sessions : [];
  pruneSeenSessionsForKind('pi');
}

export function setDeepseekSessions(sessions) {
  deepseekSessions.value = Array.isArray(sessions) ? sessions : [];
  pruneSeenSessionsForKind('deepseek');
}

export function removeSessionForKind(kind, id) {
  const store = sessionStoreForKind(kind);
  const next = store.value.filter((session) => session.id !== id);
  if (next.length === store.value.length) return;
  store.value = next;
}

export function markSessionSeen(id) {
  markSessionSeenForKind('claude', id);
}

export function markCodexSessionSeen(id) {
  markSessionSeenForKind('codex', id);
}

export function markSessionSeenForKind(kind, id) {
  markSeen(id, seenSessionStoreForKind(kind), providerDescriptor(kind).sessionStorageKey);
}

export function markClaudePromptNotificationSeen(key) {
  markPromptNotificationSeen('claude', key);
}

export function markCodexPromptNotificationSeen(key) {
  markPromptNotificationSeen('codex', key);
}

export function markPromptNotificationSeen(kind, key) {
  markSeen(key, seenPromptStoreForKind(kind), providerDescriptor(kind).attentionStorageKey);
  syncPromptNotifications(kind);
}

export function markClaudeSessionAttentionSeen(session) {
  markSessionAttentionSeen('claude', session);
}

export function markCodexSessionAttentionSeen(session) {
  markSessionAttentionSeen('codex', session);
}

export function markSessionAttentionSeen(kind, session) {
  const key = session?.attention?.key;
  if (!key || session?.attention?.kind !== 'prompt_ready' || session?.attention?.active !== true) return;
  markPromptNotificationSeen(kind, key);
}

function markSeen(id, store, key) {
  const next = new Set(store.value);
  next.add(id);
  store.value = next;
  localStorage.setItem(key, JSON.stringify([...next]));
}

// Prune seen IDs that no longer exist (keep localStorage tidy)
export function pruneSeenSessions() {
  pruneSeenSessionsForKind('claude');
}

export function pruneSeenCodexSessions() {
  pruneSeenSessionsForKind('codex');
}

export function pruneSeenSessionsForKind(kind) {
  pruneSeenStore(sessionStoreForKind(kind), seenSessionStoreForKind(kind), providerDescriptor(kind).sessionStorageKey);
  syncPromptNotifications(kind);
}

function pruneSeenStore(sessionStore, seenStore, key) {
  const activeIds = new Set(sessionStore.value.map(s => s.id));
  const pruned = new Set([...seenStore.value].filter(id => activeIds.has(id)));
  if (pruned.size !== seenStore.value.size) {
    seenStore.value = pruned;
    localStorage.setItem(key, JSON.stringify([...pruned]));
  }
}

export const unseenSessionCount = computed(() =>
  claudeSessions.value.filter(s => !seenSessionIds.value.has(s.id)).length
);
export const unseenCodexSessionCount = computed(() =>
  codexSessions.value.filter(s => !seenCodexSessionIds.value.has(s.id)).length
);
export const unseenPiSessionCount = computed(() =>
  piSessions.value.filter(s => !seenPiSessionIds.value.has(s.id)).length
);
export const unseenDeepseekSessionCount = computed(() =>
  deepseekSessions.value.filter(s => !seenDeepseekSessionIds.value.has(s.id)).length
);

export const sessionPromptNotifications = computed(() =>
  [...claudePromptNotifications.value, ...codexPromptNotifications.value, ...piPromptNotifications.value, ...deepseekPromptNotifications.value]
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
);
export const unseenSessionPromptNotificationCount = computed(() =>
  sessionPromptNotifications.value.length
);

// UI state
export const currentRoute = signal('/');
export const toasts = signal([]);

// Global state object for convenience
export const state = {
  authChecked,
  isAuthenticated,
  wsConnected,
  alerts,
  unreadAlerts,
  tmuxSessions,
  claudeSessions,
  claudeNeedsInput,
  codexSessions,
  codexNeedsInput,
  piSessions,
  piNeedsInput,
  deepseekSessions,
  deepseekNeedsInput,
  claudePromptNotifications,
  codexPromptNotifications,
  piPromptNotifications,
  deepseekPromptNotifications,
  sessionPromptNotifications,
  unseenSessionPromptNotificationCount,
  agentThreads,
  agentBusAlerts,
  agentBusMcpHealth,
  openAgentThreadCount,
  unreadAgentAlerts,
  currentRoute,
  toasts,
};

export async function refreshAuthStatus() {
  try {
    const response = await fetch('/api/auth/status', { credentials: 'same-origin' });
    const payload = response.ok ? await response.json() : { authenticated: false };
    isAuthenticated.value = payload?.authenticated === true;
  } catch {
    isAuthenticated.value = false;
  } finally {
    authChecked.value = true;
  }
}

export async function initAuth() {
  localStorage.removeItem('dueno_token');
  const pairCode = /^#pair=([\w-]+)$/.exec(window.location.hash)?.[1];
  if (pairCode) {
    // Scrub the single-use code from the address bar and history before redeeming it.
    window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
    try {
      await loginWithToken({ pairCode });
      authChecked.value = true;
    } catch (error) {
      addToast(`Pairing failed: ${error.message}`, 'error');
      await refreshAuthStatus(); // a spent link must not hide an existing session
    }
    return;
  }
  await refreshAuthStatus();
}

export async function loginWithToken(t) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(typeof t === 'string' ? { token: t } : t),
  });
  if (!response.ok) {
    let payload = {};
    try { payload = await response.json(); } catch {}
    throw new Error(payload.error || `Login failed: HTTP ${response.status}`);
  }
  isAuthenticated.value = true;
  localStorage.removeItem('dueno_token');
}

export async function logoutBrowserSession() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
  isAuthenticated.value = false;
  localStorage.removeItem('dueno_token');
}

export function addToast(message, type = 'info', duration = 5000) {
  const id = Date.now();
  toasts.value = [...toasts.value, { id, message, type }];
  if (duration > 0) {
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.id !== id);
    }, duration);
  }
}

function loadSeen(key = SEEN_KEY) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); }
  catch { return new Set(); }
}

function providerLabelForKind(kind) {
  return providerDescriptor(kind).label;
}

function sessionRecord(kind, sessionId) {
  return sessionStoreForKind(kind).value.find((session) => session.id === sessionId) || null;
}

function promptDisplayName(kind, sessionId, fallback = '') {
  const session = sessionRecord(kind, sessionId);
  return String(sessionTitle(session || { id: sessionId }, kind, agentThreads.value, fallback || `${kind}-${sessionId}`)).trim();
}

function promptMeta(kind, sessionId, fallback = '') {
  const session = sessionRecord(kind, sessionId);
  const runtimeName = String(session?.displayName || fallback || session?.name || sessionId || '').trim();
  const provider = providerLabelForKind(kind);
  if (!runtimeName) return provider;
  return `${provider} · ${runtimeName}`;
}

function promptDetail(fallback = '') {
  const text = String(fallback || '').trim();
  return text || 'Waiting for your next prompt';
}

export function hasSeenPromptNotification(kind, key) {
  return seenPromptStoreForKind(kind).value.has(key);
}

export function upsertPromptNotificationFromAlert(kind, alert) {
  if (!isKnownAgentProvider(kind)) return;
  if (alert?.status !== 'ready') return;

  const seenStore = seenPromptStoreForKind(kind);
  const notificationsStore = promptNotificationsStoreForKind(kind);
  const label = providerLabelForKind(kind);
  const sessionId = String(alert?.sessionId || '');
  const key = String(
    alert?.attentionKey
    || `${sessionId}:${alert?.revision ?? 0}:${alert?.interaction?.fingerprint || 'ready'}`
  );

  if (!sessionId || seenStore.value.has(key)) return;

  const nextItem = {
    key,
    kind,
    sessionId,
    sessionName: promptDisplayName(kind, sessionId, alert.sessionName || `${kind}-${sessionId}`),
    meta: promptMeta(kind, sessionId, alert.sessionName || sessionId),
    workDir: alert.workDir || '',
    route: alert.route || `/${kind}/${sessionId}`,
    target: alert.target || alert.sessionName || `${kind}-${sessionId}`,
    detail: promptDetail(alert.interaction?.detail || alert.reason),
    label,
    createdAt: alert.createdAt || Date.now(),
  };

  notificationsStore.value = [
    nextItem,
    ...notificationsStore.value.filter((item) => item.key !== key && item.sessionId !== sessionId),
  ];
}

export function syncPromptNotifications(kind) {
  const descriptor = providerDescriptor(kind);
  const sessionStore = sessionStoreForKind(descriptor.kind);
  const seenStore = seenPromptStoreForKind(descriptor.kind);
  const notificationsStore = promptNotificationsStoreForKind(descriptor.kind);
  const storageKey = descriptor.attentionStorageKey;
  const label = descriptor.label;

  const activeSessions = sessionStore.value.filter(session =>
    session?.state?.status === 'ready'
    && session?.state?.capabilities?.canSendNow === true
    && session?.attention?.active
    && session.attention.kind === 'prompt_ready'
    && session.source !== 'bare-process'
  );

  const activeKeys = new Set(activeSessions.map(session => session.attention.key).filter(Boolean));
  const prunedSeen = new Set([...seenStore.value].filter(key => activeKeys.has(key)));
  if (prunedSeen.size !== seenStore.value.size) {
    seenStore.value = prunedSeen;
    localStorage.setItem(storageKey, JSON.stringify([...prunedSeen]));
  }

  notificationsStore.value = activeSessions
    .filter(session => !seenStore.value.has(session.attention.key))
    .map(session => ({
      key: session.attention.key,
      kind: descriptor.kind,
      sessionId: session.id,
      sessionName: promptDisplayName(descriptor.kind, session.id, session.displayName || session.name),
      meta: promptMeta(descriptor.kind, session.id, session.name || session.id),
      workDir: session.workDir || '',
      route: session.attention.route || `${descriptor.routeBase}/${session.id}`,
      target: session.attention.target || session.tmuxSession || session.name,
      detail: promptDetail(session.state?.interaction?.detail || session.state?.reason),
      label,
      createdAt: session.attention.createdAt || session.created || 0,
    }));
}
