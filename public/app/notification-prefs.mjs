import { computed, signal } from '@preact/signals';
import { sessionPromptNotifications } from './state.mjs';

export const NOTIFICATION_PREFS_KEY = 'dueno_notification_prefs';

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

export const visibleSessionPromptNotifications = computed(() =>
  sessionPromptNotifications.value.filter((item) =>
    shouldNotifyForSession(item.kind, item.sessionId, 'ready')
  )
);

export const visibleSessionPromptNotificationCount = computed(() =>
  visibleSessionPromptNotifications.value.length
);
