const listeners = new Set();
const DEFAULT_LISTENER_TIMEOUT_MS = 5000;

export function onAgentSessionDeleted(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function notifyAgentSessionDeleted(event = {}, { timeoutMs = DEFAULT_LISTENER_TIMEOUT_MS } = {}) {
  const kind = String(event.kind || '').trim();
  const sessionId = String(event.sessionId || '').trim();
  if (!kind || !sessionId) return [];

  return Promise.allSettled([...listeners].map(async (listener) => {
    let timer;
    try {
      await Promise.race([
        listener({ kind, sessionId }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('session_delete_listener_timeout')),
            Math.max(1, Number(timeoutMs) || 1),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }));
}
