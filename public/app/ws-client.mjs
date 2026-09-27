import { isAuthenticated, wsConnected } from './state.mjs';
import { shouldPauseRealtimeWhenHidden, shouldReduceNetworkActivity } from './network-profile.mjs';

let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let heartbeatTimeout = null;
let offlineTimer = null;
let intentionalClose = false;
let reconnectAttempt = 0;
const subscribers = new Map(); // channel → Set<callback>
const HEARTBEAT_INTERVAL_MS = 25000;
const HEARTBEAT_TIMEOUT_MS = 10000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 30000;
const OFFLINE_DEBOUNCE_MS = 2000;

export function connectWs() {
  if (ws) return;
  if (!isAuthenticated.value) return;
  if (shouldPauseRealtimeWhenHidden()) return;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws`;

  intentionalClose = false;
  ws = new WebSocket(url);

  ws.onopen = () => {
    clearTimeout(offlineTimer);
    wsConnected.value = true;
    reconnectAttempt = 0;
    startHeartbeat();
    // Re-subscribe to all channels (with metadata if available)
    for (const channel of subscribers.keys()) {
      const msg = { action: 'subscribe', channel };
      const meta = channelMeta.get(channel);
      if (meta) msg.data = meta;
      ws.send(JSON.stringify(msg));
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      const { channel, type, data } = msg;
      clearTimeout(offlineTimer);
      wsConnected.value = true;
      if (type === 'pong') {
        clearTimeout(heartbeatTimeout);
        return;
      }

      if (channel && subscribers.has(channel)) {
        for (const cb of subscribers.get(channel)) {
          cb(type, data);
        }
      }

      // Also check prefix matches
      if (channel) {
        const prefix = channel.split(':')[0];
        if (prefix !== channel && subscribers.has(prefix)) {
          for (const cb of subscribers.get(prefix)) {
            cb(type, data, channel);
          }
        }
      }
    } catch (e) {
      console.error('Malformed WS message:', e, event.data);
    }
  };

  ws.onclose = () => {
    stopHeartbeat();
    scheduleOffline();
    ws = null;
    if (intentionalClose) {
      intentionalClose = false;
      return;
    }
    if (shouldPauseRealtimeWhenHidden()) {
      return;
    }
    // Reconnect after delay
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectWs, nextReconnectDelay());
  };

  ws.onerror = () => {
    // Will trigger onclose
  };
}

export function disconnectWs() {
  clearTimeout(reconnectTimer);
  stopHeartbeat();
  if (ws) {
    intentionalClose = true;
    ws.close();
    ws = null;
  }
  setOfflineNow();
}

function scheduleOffline() {
  clearTimeout(offlineTimer);
  offlineTimer = setTimeout(() => {
    wsConnected.value = false;
    offlineTimer = null;
  }, OFFLINE_DEBOUNCE_MS);
}

function setOfflineNow() {
  clearTimeout(offlineTimer);
  offlineTimer = null;
  wsConnected.value = false;
}

function nextReconnectDelay() {
  const cap = shouldReduceNetworkActivity() ? 60000 : RECONNECT_CAP_MS;
  const base = Math.min(cap, RECONNECT_BASE_MS * (2 ** reconnectAttempt));
  reconnectAttempt += 1;
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  sendHeartbeat();
}

function stopHeartbeat() {
  clearInterval(heartbeatTimer);
  clearTimeout(heartbeatTimeout);
  heartbeatTimer = null;
  heartbeatTimeout = null;
}

function sendHeartbeat() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  clearTimeout(heartbeatTimeout);
  ws.send(JSON.stringify({ action: 'ping', ts: Date.now() }));
  heartbeatTimeout = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(4000, 'Missed pong');
    }
  }, HEARTBEAT_TIMEOUT_MS);
}

const channelMeta = new Map(); // channel → subscription metadata (lines, etc.)

/**
 * Subscribe to a WebSocket channel.
 * @param {string} channel
 * @param {function(type, data, channel?)} callback
 * @param {object} [meta] — optional metadata sent with subscribe (e.g. { lines: 200 })
 * @returns {function} unsubscribe
 */
export function subscribe(channel, callback, meta) {
  if (!subscribers.has(channel)) {
    subscribers.set(channel, new Set());
  }
  subscribers.get(channel).add(callback);
  if (meta) channelMeta.set(channel, meta);

  // Auto-connect if not connected yet
  if (!ws && isAuthenticated.value) {
    connectWs();
  }

  // Send subscribe if connected
  if (ws && ws.readyState === WebSocket.OPEN) {
    const msg = { action: 'subscribe', channel };
    const saved = channelMeta.get(channel);
    if (saved) msg.data = saved;
    ws.send(JSON.stringify(msg));
  }

  return () => {
    const subs = subscribers.get(channel);
    if (subs) {
      subs.delete(callback);
      if (subs.size === 0) {
        subscribers.delete(channel);
        channelMeta.delete(channel);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: 'unsubscribe', channel }));
        }
      }
    }
  };
}

/**
 * Send a message to a channel via WebSocket.
 */
export function sendMessage(channel, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'message', channel, data }));
  }
}

function refreshWsForNetworkState() {
  if (shouldPauseRealtimeWhenHidden()) {
    disconnectWs();
    return;
  }
  if (!ws && subscribers.size > 0 && isAuthenticated.value) {
    connectWs();
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', refreshWsForNetworkState);
}

if (typeof navigator !== 'undefined') {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (connection?.addEventListener) {
    connection.addEventListener('change', refreshWsForNetworkState);
  }
}
