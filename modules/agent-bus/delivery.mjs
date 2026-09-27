import { renderBusEnvelope, sessionHasBusMessage } from './envelope.mjs';
import { isReplayEligibleDelivery } from './replay-eligible.mjs';

export function isTransientDeliveryError(err = {}) {
  return err?.code === 'command_deadline_expired' || err?.transient === true || err?.payload?.transient === true;
}

function appendReplayHistory(delivery, entry) {
  return [...(Array.isArray(delivery?.replayHistory) ? delivery.replayHistory : []), entry].slice(-20);
}

function holdReasonFor(session) {
  const status = session?.state?.status;
  const execution = session?.state?.execution;
  if (execution === 'working' || execution === 'thinking') return 'target_busy';
  if (['working', 'thinking', 'awaiting_response', 'blocked'].includes(status)) return 'target_busy';
  return 'can_send_false';
}

export function createAgentBusDelivery({ app, store, wsManager, observedSessions, deliveryInFlight,
  sessionDeliveryInFlight, broadcast, broadcastAlert, resolveAgentSession }) {
  async function markHold(message, delivery, patch) {
    const latest = store.getDelivery(delivery.id) || delivery;
    if (latest.status !== 'queued') return latest;
    const holdReason = patch.holdReason ?? latest.holdReason;
    const holdDetail = patch.holdDetail ?? latest.holdDetail;
    if (latest.status === 'queued' && latest.holdReason === holdReason
      && latest.willInjectWhenIdle === true && (latest.holdDetail || null) === (holdDetail || null)) {
      return latest;
    }
    const updated = await store.updateDelivery(delivery.id, {
      status: 'queued',
      lastAttemptAt: Date.now(),
      willInjectWhenIdle: true,
      ...patch,
    });
    broadcast(wsManager, `agent-bus:thread:${message.threadId}`, 'delivery_updated', { messageId: message.id, delivery: updated });
    return updated;
  }

  async function deliverMessage(message, delivery) {
    const current = store.getDelivery(delivery.id) || delivery;
    if (current.status !== 'queued') return current;
    if (store.getThread(message.threadId)?.thread.status !== 'open') return current;
    const target = delivery.target;
    const targetKey = `${target.kind}:${target.sessionId}`;
    if (deliveryInFlight.has(delivery.id) || sessionDeliveryInFlight.has(targetKey)) {
      return markHold(message, delivery, { holdReason: 'in_flight', holdDetail: 'another delivery is in flight for this session' });
    }
    deliveryInFlight.add(delivery.id);
    sessionDeliveryInFlight.add(targetKey);
    try {
      const adapter = await resolveAgentSession(target);
      const session = await adapter.getSession(app, target.sessionId);
      if (session?.state?.capabilities?.canSendNow !== true) {
        const holdReason = holdReasonFor(session);
        return markHold(message, delivery, {
          holdReason,
          holdDetail: session?.state?.reason || session?.state?.status || holdReason,
        });
      }
      let content = '';
      try { content = await adapter.captureSession(app, target.sessionId); } catch {}
      const pending = store.getDelivery(delivery.id) || delivery;
      if (pending.status !== 'queued' || store.getThread(message.threadId)?.thread.status !== 'open') return pending;
      const alreadyReceived = sessionHasBusMessage(content, message);
      const parent = message.replyTo ? store.getMessage(message.replyTo) : null;
      const injection = alreadyReceived
        ? { ok: true, resolution: 'already_present' }
        : await adapter.injectEnvelope(app, target.sessionId, renderBusEnvelope(message, parent), { deliveryId: delivery.id });
      observedSessions.add(targetKey);
      const latest = store.getDelivery(delivery.id) || delivery;
      const updated = await store.updateDelivery(delivery.id, {
        status: 'injected', error: null, cancelledAt: null, attempts: Number(latest.attempts || 0) + 1,
        lastAttemptAt: Date.now(), resolution: injection?.resolution || (alreadyReceived ? 'already_present' : null),
        holdReason: null, holdDetail: null, willInjectWhenIdle: false,
      });
      broadcast(wsManager, `agent-bus:thread:${message.threadId}`, 'delivery_updated', { messageId: message.id, delivery: updated });
      return updated;
    } finally {
      deliveryInFlight.delete(delivery.id);
      sessionDeliveryInFlight.delete(targetKey);
    }
  }

  async function failDelivery(message, delivery, err) {
    const latest = store.getDelivery(delivery.id) || delivery;
    if (latest.status !== 'queued') return latest;
    const failed = await store.updateDelivery(delivery.id, {
      status: isTransientDeliveryError(err) ? 'queued' : 'failed',
      attempts: Number(delivery.attempts || 0) + 1, lastAttemptAt: Date.now(), error: err.message,
      holdReason: isTransientDeliveryError(err) ? 'backoff' : null,
      holdDetail: isTransientDeliveryError(err) ? err.message : null,
      willInjectWhenIdle: isTransientDeliveryError(err),
    });
    broadcast(wsManager, `agent-bus:thread:${message.threadId}`, 'delivery_updated', { messageId: message.id, delivery: failed });
    if (failed.status === 'failed') broadcastAlert('delivery_failed', {
      threadId: message.threadId, messageId: message.id, deliveryId: failed.id, target: failed.target, error: err.message,
    });
    return failed;
  }

  async function replayDelivery(deliveryId, { requestedBy = 'operator' } = {}) {
    const delivery = store.getDelivery(deliveryId);
    if (!delivery) throw new Error(`Delivery not found: ${deliveryId}`);
    if (!isReplayEligibleDelivery(delivery)) throw new Error('Only failed deliveries may be replayed');
    const message = store.getMessage(delivery.messageId);
    if (!message) throw new Error(`Message not found: ${delivery.messageId}`);
    if (store.getThread(message.threadId)?.thread.status !== 'open') throw new Error('Reopen the room before replaying deliveries');
    const replayAttempt = Number(delivery.replayAttempts || 0) + 1;
    const queued = await store.updateDelivery(delivery.id, {
      status: 'queued', error: null, replayAttempts: replayAttempt,
      replayHistory: appendReplayHistory(delivery, { attempt: replayAttempt, requestedBy, requestedAt: Date.now() }),
    });
    try { return await deliverMessage(message, queued); }
    catch (err) { await failDelivery(message, queued, err); throw err; }
  }

  return { deliverMessage, failDelivery, replayDelivery };
}
