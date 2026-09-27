const RECOVERY_GRACE_MS = 2000;

function terminalLookupError(err = {}) {
  const status = Number(err.statusCode || err.payload?.statusCode || 0);
  return status === 404 || err.code === 'session_not_found' || err.payload?.sessionEnded === true
    || err.payload?.state?.status === 'ended';
}

export function createAgentBusObserver({ app, store, adapters, wsManager, observedSessions, deliveryInFlight,
  observerInFlightByRef, observerIntervalMs, observerSessionTimeoutMs, broadcast, broadcastAlert,
  broadcastThreadSnapshot, broadcastThreadSummary, threadSnapshot, enrichThread, normalizeThreadSummary,
  pruneObservedParticipant, deliverMessage, failDelivery }) {
  async function recoverQueuedDeliveries() {
    const messages = new Map(store.listMessages().map((message) => [message.id, message]));
    const groups = new Map();
    for (const delivery of store.listDeliveries()) {
      if (delivery.status !== 'queued' || deliveryInFlight.has(delivery.id)) continue;
      const message = messages.get(delivery.messageId);
      const thread = message && store.getThread(message.threadId)?.thread;
      if (!message || !thread || thread.status !== 'open' || message.createdBy === 'bootstrap') continue;
      const key = `${delivery.target.kind}:${delivery.target.sessionId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ delivery, message });
    }
    for (const group of groups.values()) group.sort((a, b) => a.message.createdAt - b.message.createdAt);

    await Promise.allSettled([...groups.values()].map(async (group) => {
      for (const { delivery, message } of group) {
        const latest = store.getDelivery(delivery.id);
        if (!latest || latest.status !== 'queued') continue;
        if (latest.lastAttemptAt && Date.now() - latest.lastAttemptAt < RECOVERY_GRACE_MS) break;
        try {
          const updated = await deliverMessage(message, latest);
          if (updated.status === 'queued') break;
          await broadcastThreadSnapshot(message.threadId);
          await broadcastThreadSummary(message.threadId);
        } catch (err) {
          const failed = await failDelivery(message, latest, err);
          if (failed.status === 'queued') break;
          if (!terminalLookupError(err)) break;
        }
      }
    }));
  }

  function withTimeout(ref, promise) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Observer session timed out after ${observerSessionTimeoutMs}ms: ${ref}`)), observerSessionTimeoutMs);
    })]).finally(() => clearTimeout(timer));
  }

  function observeSession(ref) {
    if (observerInFlightByRef.has(ref)) return Promise.resolve();
    const split = ref.indexOf(':');
    if (split < 1) return Promise.resolve();
    const participant = { kind: ref.slice(0, split), sessionId: ref.slice(split + 1) };
    const adapter = adapters[participant.kind];
    if (!adapter) return Promise.resolve();
    const running = adapter.getSession(app, participant.sessionId).catch(() => pruneObservedParticipant(participant));
    observerInFlightByRef.set(ref, running);
    running.finally(() => observerInFlightByRef.delete(ref)).catch(() => {});
    return withTimeout(ref, running);
  }

  async function observeSessions() {
    await Promise.allSettled([...observedSessions].map(observeSession));
    await recoverQueuedDeliveries();
  }

  if (wsManager?.onChannel) wsManager.onChannel('agent-bus', (socket, channel, data) => {
    if (data?.action !== 'subscribe') return;
    if (channel === 'agent-bus:threads') {
      const runtimeCache = new Map();
      Promise.all(store.listThreads().map(async (thread) => normalizeThreadSummary(
        thread.status === 'open'
          ? await enrichThread(thread, store.getThread(thread.id), runtimeCache)
          : thread
      ))).then((threads) => wsManager.send(socket, channel, 'threads', { threads })).catch(() => {});
      return;
    }
    const prefix = 'agent-bus:thread:';
    if (channel.startsWith(prefix)) threadSnapshot(channel.slice(prefix.length))
      .then((snapshot) => snapshot && wsManager.send(socket, channel, 'snapshot', snapshot)).catch(() => {});
  });

  let running = false;
  const interval = setInterval(async () => {
    if (running) return;
    running = true;
    try { await observeSessions(); }
    catch (err) { broadcastAlert('observer_error', { error: err.message }, 'error'); }
    finally { running = false; }
  }, observerIntervalMs);
  interval.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(interval);
    if (typeof store.close === 'function') await store.close();
  });
}
