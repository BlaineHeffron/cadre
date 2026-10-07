import { renderBusEnvelope, sessionHasBusMessage } from './envelope.mjs';
import { isReplayEligibleDelivery } from './replay-eligible.mjs';

export function isTransientDeliveryError(err = {}) {
  return err?.code === 'command_deadline_expired' || err?.transient === true || err?.payload?.transient === true;
}

function appendReplayHistory(delivery, entry) {
  return [...(Array.isArray(delivery?.replayHistory) ? delivery.replayHistory : []), entry].slice(-20);
}

const BLOCKED_NOTIFY_MS = 5 * 60_000;

// Codex submits Enter mid-turn as a steer into the running turn; Claude Code
// queues it and reads it at the next tool boundary. So working Codex and Claude
// panes accept room messages. Other providers wait for idle. Blocked,
// awaiting_response, and unknown sessions still hold.
function canDeliverNow(kind, state) {
  if (state?.capabilities?.canSendNow === true) return true;
  return ['codex', 'claude'].includes(kind) && state?.capabilities?.canQueueMessage === true
    && ['working', 'thinking'].includes(state?.status);
}

function holdReasonFor(session) {
  const status = session?.state?.status;
  const execution = session?.state?.execution;
  if (execution === 'working' || execution === 'thinking') return 'target_busy';
  if (['working', 'thinking', 'awaiting_response', 'blocked'].includes(status)) return 'target_busy';
  return 'can_send_false';
}

export function createAgentBusDelivery({ app, store, adapters, wsManager, observedSessions, deliveryInFlight,
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

  // Tell the room owner once per episode when a delivery sits behind a blocking dialog.
  async function trackBlockedHold(message, delivery, state) {
    const latest = store.getDelivery(delivery.id) || delivery;
    if (state?.status !== 'blocked') {
      if (latest.blockedSince) await store.updateDelivery(delivery.id, { blockedSince: null, blockedOwnerNotifiedAt: null });
      return;
    }
    if (!latest.blockedSince) return store.updateDelivery(delivery.id, { blockedSince: Date.now() });
    if (latest.blockedOwnerNotifiedAt || Date.now() - latest.blockedSince < BLOCKED_NOTIFY_MS) return;
    await store.updateDelivery(delivery.id, { blockedOwnerNotifiedAt: Date.now() });
    const owner = store.getThread(message.threadId)?.thread.createdBy;
    const target = delivery.target;
    if (!adapters?.[owner?.kind] || (owner.kind === target.kind && owner.sessionId === target.sessionId)) return;
    const minutes = Math.floor((Date.now() - latest.blockedSince) / 60_000);
    await store.createMessage({ threadId: message.threadId, from: { kind: 'system', sessionId: 'agent-bus' },
      targets: [{ kind: owner.kind, sessionId: owner.sessionId }], createdBy: 'agent-bus', replyTo: message.id,
      body: `Delivery to ${target.kind}:${target.sessionId} held ${minutes} min on a blocking ${state.interaction?.kind || 'unknown'} interaction. That session needs an operator answer.` });
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
      if (!canDeliverNow(target.kind, session?.state)) {
        const holdReason = holdReasonFor(session);
        const held = await markHold(message, delivery, {
          holdReason,
          holdDetail: session?.state?.reason || session?.state?.status || holdReason,
        });
        if (held.status === 'queued') await trackBlockedHold(message, held, session?.state);
        return held;
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
      // DM auto-close on sender deletion still records an accepted write to the surviving recipient.
      if (latest.status !== 'queued' && !store.getThread(message.threadId)?.thread.metadata?.dm) return latest;
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
