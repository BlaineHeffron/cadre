import { computed, signal } from '@preact/signals';
import { agentBusAlerts, agentThreads, claudeSessions, codexSessions, deepseekSessions, piSessions, sessionPromptNotifications } from './state.mjs';
import { providerDescriptor } from './providers.mjs';
import { sessionTitle } from './agent-bus-ui.mjs';

export const NOTIFICATION_PREFS_KEY = 'dueno_notification_prefs';
const DISMISSED_KEY = 'dueno_dismissed_attention_items';

const DEFAULT_PREFS = Object.freeze({
  browser: true,
  sound: true,
  approvalOnly: false,
  mutedSessions: [],
});

function readPrefs() {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTIFICATION_PREFS_KEY) || '{}') || {};
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      mutedSessions: Array.isArray(parsed.mutedSessions) ? parsed.mutedSessions : [],
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export const notificationPrefs = signal(readPrefs());
export const dismissedAttentionItemIds = signal(loadDismissed());

function savePrefs(next) {
  notificationPrefs.value = {
    ...DEFAULT_PREFS,
    ...next,
    mutedSessions: Array.isArray(next?.mutedSessions) ? next.mutedSessions : [],
  };
  localStorage.setItem(NOTIFICATION_PREFS_KEY, JSON.stringify(notificationPrefs.value));
}

export function getNotificationPrefs() {
  return notificationPrefs.value;
}

export function updateNotificationPrefs(patch = {}) {
  savePrefs({ ...notificationPrefs.value, ...patch });
}

export function isSoundEnabled() {
  return notificationPrefs.value.sound !== false;
}

export function setSoundEnabled(enabled) {
  updateNotificationPrefs({ sound: Boolean(enabled) });
}

// The browser permission cannot be revoked from a page, so this is the in-app off switch.
export function isBrowserNotificationsEnabled() {
  return notificationPrefs.value.browser !== false;
}

export function setBrowserNotificationsEnabled(enabled) {
  updateNotificationPrefs({ browser: Boolean(enabled) });
}

export function isApprovalOnlyEnabled() {
  return notificationPrefs.value.approvalOnly === true;
}

export function setApprovalOnlyEnabled(enabled) {
  updateNotificationPrefs({ approvalOnly: Boolean(enabled) });
}

export function sessionMuteKey(kind, id) {
  return `${kind}:${id}`;
}

export function isSessionMuted(kind, id) {
  return notificationPrefs.value.mutedSessions.includes(sessionMuteKey(kind, id));
}

export function setSessionMuted(kind, id, muted) {
  const key = sessionMuteKey(kind, id);
  const current = new Set(notificationPrefs.value.mutedSessions);
  if (muted) current.add(key);
  else current.delete(key);
  updateNotificationPrefs({ mutedSessions: [...current].sort() });
}

export function shouldNotifyForSession(kind, id, state = '') {
  if (isSessionMuted(kind, id)) return false;
  if (isApprovalOnlyEnabled() && !isDecisionState(state)) return false;
  return true;
}

export function isDecisionState(state = '') {
  return state === 'blocked';
}

function loadDismissed() {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]')); }
  catch { return new Set(); }
}

function saveDismissed(items) {
  localStorage.setItem(DISMISSED_KEY, JSON.stringify([...items]));
}

export function dismissAttentionItem(id) {
  if (!id) return;
  const next = new Set(dismissedAttentionItemIds.value);
  next.add(id);
  dismissedAttentionItemIds.value = next;
  saveDismissed(next);
}

export function clearDismissedAttentionItems() {
  dismissedAttentionItemIds.value = new Set();
  saveDismissed(dismissedAttentionItemIds.value);
}

function createdAt(value) {
  const number = Number(value || 0);
  if (!number) return 0;
  return number > 1e12 ? number : number * 1000;
}

function sessionRank(state = '') {
  if (isDecisionState(state)) return 0;
  return 1;
}

function sessionSnippet(session = {}) {
  return String(
    session?.state?.interaction?.detail
    || session?.state?.reason
    || ''
  ).trim();
}

function optionLabel(option) {
  if (typeof option === 'string') return option.trim();
  return String(option?.label || option?.text || '').trim();
}

function answerOptionsForSession(session) {
  if (session?.state?.capabilities?.canAnswerInteraction !== true) return [];
  return (Array.isArray(session?.state?.interaction?.options) ? session.state.interaction.options : [])
    .map((option, index) => ({
      key: typeof option === 'object' && option
        ? String(option.key ?? option.value ?? option.index ?? '')
        : String(index + 1),
      label: optionLabel(option),
    }))
    .filter((option) => option.key && option.label);
}

function attentionItemFromSession(kind, session) {
  const descriptor = providerDescriptor(kind);
  const status = session?.state?.status || 'unknown';
  const rank = sessionRank(status);
  const rawGeneration = session?.attention?.key
    || session?.state?.interaction?.fingerprint
    || session?.state?.revision;
  const ageAt = createdAt(session?.state?.updatedAt || session?.updatedAt || session?.created);
  const name = sessionTitle(session, kind, agentThreads.value);
  const snippet = status === 'ready'
    ? sessionSnippet(session)
    : session?.state?.reason || sessionSnippet(session);
  const answerOptions = answerOptionsForSession(session);
  return {
    id: `${sessionMuteKey(kind, session.id)}:${status}:${rawGeneration}`,
    type: 'session',
    kind,
    sessionId: session.id,
    rank,
    state: status,
    revision: session?.state?.revision,
    interactionKind: session?.state?.interaction?.kind || 'none',
    interactionFingerprint: session?.state?.interaction?.fingerprint || '',
    // A ready session only needs attention for a reason (runtime mismatch); show it.
    statusLabel: status === 'blocked'
      ? 'needs approval'
      : status === 'ready'
        ? session?.state?.reason || 'needs attention'
        : 'needs attention',
    providerLabel: descriptor.label,
    name,
    project: session.workDir || session.projectKey || '',
    route: `${descriptor.routeBase}/${session.id}`,
    snippet,
    target: session.tmuxSession || session.name || session.id,
    ageAt,
    muted: isSessionMuted(kind, session.id),
    notifySuppressed: !shouldNotifyForSession(kind, session.id, status),
    answerOptions,
  };
}

function attentionItemFromDelivery(alert) {
  const thread = agentThreads.value.find((item) => item.id === alert.threadId);
  const ageAt = createdAt(alert.createdAt || alert.lastAttemptAt);
  return {
    id: alert.id || `delivery:${alert.deliveryId || alert.messageId}`,
    type: 'delivery',
    kind: 'delivery',
    sessionId: alert.deliveryId || alert.messageId,
    rank: 1,
    state: 'failed',
    statusLabel: 'delivery failed',
    providerLabel: 'Bus',
    name: thread?.title || alert.threadId || 'Bus delivery',
    project: thread?.projectKey || '',
    route: alert.threadId ? `/collab/${alert.threadId}` : '/collab',
    snippet: String(alert.error || 'Message delivery failed.'),
    target: alert.deliveryId || alert.messageId || '',
    ageAt,
    muted: false,
    notifySuppressed: false,
  };
}

export const attentionItems = computed(() => {
  const rows = [];
  for (const [kind, sessions] of [['claude', claudeSessions], ['codex', codexSessions], ['deepseek', deepseekSessions], ['pi', piSessions]]) {
    for (const session of sessions.value) {
      if (session?.state?.capabilities?.needsAttention === true) rows.push(attentionItemFromSession(kind, session));
    }
  }
  for (const alert of agentBusAlerts.value) {
    if (alert?.type === 'delivery_failed') rows.push(attentionItemFromDelivery(alert));
  }
  return rows.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return (a.ageAt || 0) - (b.ageAt || 0);
  });
});

export const visibleAttentionItems = computed(() =>
  attentionItems.value.filter((item) => !dismissedAttentionItemIds.value.has(item.id))
);

export const attentionBadgeCount = computed(() =>
  visibleAttentionItems.value.filter((item) => item.type === 'delivery' || shouldNotifyForSession(item.kind, item.sessionId, item.state)).length
);

export const visibleSessionPromptNotifications = computed(() =>
  sessionPromptNotifications.value.filter((item) =>
    shouldNotifyForSession(item.kind, item.sessionId, 'ready')
  )
);

export const visibleSessionPromptNotificationCount = computed(() =>
  visibleSessionPromptNotifications.value.length
);
