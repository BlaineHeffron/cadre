/**
 * Browser notification + optional audio alert system.
 */

import { effect } from '@preact/signals';
import {
  notificationPrefs,
  isSoundEnabled as readSoundEnabled,
  setSoundEnabled as writeSoundEnabled,
} from './attention.mjs';
import { api } from './api.mjs';

export function isSoundEnabled() {
  return readSoundEnabled();
}

export function setSoundEnabled(enabled) {
  writeSoundEnabled(enabled);
}

export function isNotificationPermitted() {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

export async function requestPermission() {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

let audioCtx = null;

function playBeep() {
  if (!readSoundEnabled()) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.start();
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
    osc.stop(audioCtx.currentTime + 0.3);
  } catch {
    // Audio not available
  }
}

// Registered once on import; resolves to the active registration, or null when unsupported/failed.
const swReady = globalThis.navigator?.serviceWorker
  ? navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready, () => null)
  : Promise.resolve(null);

const pushSubscription = () => swReady.then((registration) => registration?.pushManager?.getSubscription() ?? null).catch(() => null);

/**
 * Show a notification via the service worker (Android Chrome rejects `new Notification`),
 * falling back to a page Notification on desktop browsers.
 * Clicks go to opts.url (sw.js handles them for service-worker notifications).
 * @param {string} title
 * @param {string} body
 * @param {{ tag?: string, url?: string, pushed?: boolean }} opts pushed: the server also sends this as Web Push
 */
export async function showNotification(title, body, opts = {}) {
  playBeep();
  if (!isNotificationPermitted()) return;
  // One source per device: a push-subscribed browser gets server-pushed alerts from sw.js.
  if (opts.pushed && await pushSubscription()) return;
  const url = opts.url || '/';
  const options = { body, tag: opts.tag || 'dueno-alert', icon: '/icons/icon.svg', data: { url } };
  const registration = await swReady;
  try {
    if (registration) return await registration.showNotification(title, options);
  } catch (error) {
    console.warn('Service worker notification failed', error);
  }
  try {
    const n = new Notification(title, options);
    n.onclick = () => {
      window.focus();
      window.location.href = url;
      n.close();
    };
  } catch (error) {
    console.warn('Notification failed', error);
  }
}

export async function isPushSubscribed() {
  return Boolean(await pushSubscription());
}

// The server applies this device's approval-only and muted-session prefs to its pushes.
const postSubscription = (subscription, { approvalOnly, mutedSessions } = notificationPrefs.value) =>
  api.post('/push/subscribe', { ...subscription.toJSON(), approvalOnly, mutedSessions });
effect(() => {
  const prefs = notificationPrefs.value;
  pushSubscription().then((subscription) => subscription && postSubscription(subscription, prefs)).catch(() => {});
});

/** Subscribe or unsubscribe this device from server-sent Web Push alerts. */
export async function setPushEnabled(enabled) {
  const pushManager = (await swReady)?.pushManager;
  if (!pushManager) throw new Error('Push needs HTTPS (on iOS, add Cadre to the Home Screen first)');
  const existing = await pushManager.getSubscription();
  if (!enabled) {
    if (!existing) return;
    // Unsubscribe locally first; the server also prunes it on the push service's 410.
    await existing.unsubscribe();
    await api.delete('/push/subscribe', { endpoint: existing.endpoint }).catch(() => {});
    return;
  }
  if (!(await requestPermission())) throw new Error('Notification permission denied');
  const { publicKey } = await api.get('/push/key');
  const applicationServerKey = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const subscription = existing || await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  await postSubscription(subscription);
}
