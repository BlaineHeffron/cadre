const REPLAY_ELIGIBLE_STATUSES = new Set(['failed']);

function text(value) {
  return String(value || '').trim();
}

export function isReplayEligibleDelivery(delivery = {}) {
  return REPLAY_ELIGIBLE_STATUSES.has(text(delivery.status))
    && delivery.resolution !== 'cancelled' && delivery.error !== 'thread_closed';
}

export function replayEligibleDeliverySummary(delivery = {}, thread = {}) {
  return {
    threadId: thread?.id || delivery.threadId || null,
    threadTitle: thread?.title || 'Untitled thread',
    deliveryId: delivery?.id || null,
    messageId: delivery?.messageId || null,
    status: delivery?.status || 'unknown',
    target: delivery?.target || null,
    error: delivery?.error || null,
    replayAttempts: Number(delivery?.replayAttempts || 0),
    lastAttemptAt: delivery?.lastAttemptAt || null,
  };
}

export function collectReplayEligibleDeliveriesFromState(agentBusState = {}, { limit = 10 } = {}) {
  const max = Math.max(1, Math.min(500, Number(limit || 10)));
  return (agentBusState?.threads || [])
    .flatMap((entry) =>
      (entry?.deliveries || [])
        .filter(isReplayEligibleDelivery)
        .map((delivery) => replayEligibleDeliverySummary(delivery, entry?.thread || {}))
    )
    .sort((a, b) => Number(b.lastAttemptAt || 0) - Number(a.lastAttemptAt || 0))
    .slice(0, max);
}

export function collectReplayEligibleDeliveriesFromStore(store, { limit = 50, projectKey = '' } = {}) {
  const max = Math.max(1, Math.min(200, Number(limit || 50)));
  const items = [];
  for (const thread of store.listThreads({ projectKey: text(projectKey) || undefined })) {
    const snapshot = store.getThread(thread.id);
    for (const delivery of snapshot?.deliveries || []) {
      if (!isReplayEligibleDelivery(delivery)) continue;
      items.push(replayEligibleDeliverySummary(delivery, thread));
    }
  }
  return items
    .sort((a, b) => Number(b.lastAttemptAt || 0) - Number(a.lastAttemptAt || 0))
    .slice(0, max);
}
