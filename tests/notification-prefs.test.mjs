import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

globalThis.localStorage = makeLocalStorage();

const prefs = await import('../public/app/notification-prefs.mjs');

describe('notification preferences', () => {
  beforeEach(() => {
    localStorage.clear();
    prefs.updateNotificationPrefs({ browser: true, sound: true, approvalOnly: false, mutedSessions: [] });
  });

  it('limits approval-only mode to blocked sessions and honors per-session mutes', () => {
    assert.equal(prefs.shouldNotifyForSession('claude', 'claude-1', 'ready'), true);
    prefs.setApprovalOnlyEnabled(true);
    assert.equal(prefs.shouldNotifyForSession('claude', 'claude-1', 'ready'), false);
    assert.equal(prefs.shouldNotifyForSession('claude', 'claude-1', 'blocked'), true);
    prefs.setSessionMuted('claude', 'claude-1', true);
    assert.equal(prefs.shouldNotifyForSession('claude', 'claude-1', 'blocked'), false);
    assert.equal(prefs.shouldNotifyForSession('claude', 'claude-2', 'blocked'), true);
  });

  it('turns browser notifications off and persists the choice', () => {
    assert.equal(prefs.isBrowserNotificationsEnabled(), true);
    prefs.setBrowserNotificationsEnabled(false);
    assert.equal(prefs.isBrowserNotificationsEnabled(), false);
    assert.equal(JSON.parse(localStorage.getItem(prefs.NOTIFICATION_PREFS_KEY)).browser, false);
  });
});
