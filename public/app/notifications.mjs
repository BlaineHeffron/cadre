/**
 * Browser notification + optional audio alert system.
 */

import {
  isSoundEnabled as readSoundEnabled,
  setSoundEnabled as writeSoundEnabled,
} from './attention.mjs';

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

/**
 * Show a browser notification with optional sound.
 * @param {string} title
 * @param {string} body
 * @param {{ tag?: string, url?: string, vibrate?: number[], newTab?: boolean }} opts
 */
export function showNotification(title, body, opts = {}) {
  playBeep();

  if (!isNotificationPermitted()) return;

  const n = new Notification(title, {
    body,
    tag: opts.tag || 'dueno-alert',
    icon: '/icons/icon.svg',
    vibrate: opts.vibrate || [200, 100, 200],
    requireInteraction: true,
  });

  if (opts.url) {
    n.onclick = () => {
      window.focus();
      if (opts.newTab === false) {
        window.location.hash = '';
        window.location.href = opts.url;
      } else {
        window.open(opts.url, '_blank', 'noopener');
      }
      n.close();
    };
  }

  // Auto-close after 15s
  setTimeout(() => n.close(), 15000);
}
