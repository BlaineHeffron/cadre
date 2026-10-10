import { AgentBusStore } from './store.mjs';
import { createAgentAdapters } from './adapters.mjs';
import { config } from '../../config.mjs';
import { getAgentProviderPreferencesSync } from '../agent/provider-preferences.mjs';
import { getProductionControlRegistry } from '../ops/production-controls.mjs';
import { createAgentBusParticipants } from './participants.mjs';
import { createAgentBusDelivery } from './delivery.mjs';
import { createAgentBusObserver } from './observer.mjs';
import { registerAgentBusRoutes } from './routes.mjs';
import { getAgentBusCredentialStore } from './mcp-auth.mjs';
import { onAgentSessionDeleted } from '../agent/session-delete-events.mjs';
import { TaskService } from '../sessions/task-service.mjs';
import { getProtocolSessionProvider } from '../sessions/protocol-session-registry.mjs';
import { registerTaskRoutes } from './task-routes.mjs';

function broadcast(wsManager, channel, type, data) { wsManager?.broadcast?.(channel, type, data); }
function isAgentRef(value) { return Boolean(value && typeof value.kind === 'string' && String(value.sessionId || '').trim()); }
function participantKey(ref) { return `${ref.kind}:${ref.sessionId}`; }
function participantRef(ref) { return { kind: ref?.kind || '', sessionId: ref?.sessionId || '' }; }
function threadHasParticipant(thread, ref) {
  return (thread?.participants || []).some((item) => participantKey(item) === participantKey(ref));
}
function threadHasOwner(thread, ref) {
  return isAgentRef(thread?.createdBy) && participantKey(thread.createdBy) === participantKey(ref);
}
function uniqueAgentRefs(refs = []) {
  const seen = new Set();
  return refs.filter((ref) => isAgentRef(ref) && !seen.has(participantKey(ref)) && seen.add(participantKey(ref)));
}
function normalizeCollectionLimit(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function summarizeThreadMetadata(metadata = {}) {
  const summary = {};
  for (const key of ['source', 'closeReason', 'dmKey', 'dm', 'deliveryHealth']) if (metadata[key] !== undefined) summary[key] = metadata[key];
  if (Array.isArray(metadata.bootstrapWarnings) && metadata.bootstrapWarnings.length) summary.bootstrapWarnings = metadata.bootstrapWarnings;
  return summary;
}
function normalizeThreadSummary(thread, { includeFullMetadata = false } = {}) {
  return { id: thread.id, title: thread.title, projectKey: thread.projectKey, status: thread.status,
    health: thread.health || 'ok', participants: thread.participants || [], createdBy: thread.createdBy || null,
    live_process_count: thread.live_process_count || 0,
    createdAt: thread.createdAt, updatedAt: thread.updatedAt,
    metadata: includeFullMetadata ? (thread.metadata || {}) : summarizeThreadMetadata(thread.metadata || {}) };
}
function threadMatchesStatusFilter(thread, status = '') {
  const normalized = String(status || '').trim();
  return !normalized || normalized === 'all' || thread.status === normalized || (normalized === 'stale' && thread.health === 'stale');
}
function buildStateSnapshotEntry(snapshot, enriched, { includeMessages, includeDeliveries, messageLimit, deliveryLimit,
  includeFullThreadMetadata = false }) {
  const slice = (items, limit) => limit === null ? items : (limit > 0 ? items.slice(-limit) : []);
  const messages = snapshot.messages || [];
  const deliveries = snapshot.deliveries || [];
  const selectedMessages = includeMessages ? slice(messages, messageLimit) : undefined;
  const selectedDeliveries = includeDeliveries ? slice(deliveries, deliveryLimit) : undefined;
  return { thread: normalizeThreadSummary(enriched, { includeFullMetadata: includeFullThreadMetadata }),
    messageCount: messages.length, deliveryCount: deliveries.length,
    latestMessageAt: messages.at(-1)?.createdAt || null, latestDeliveryAt: deliveries.at(-1)?.lastAttemptAt || null,
    messages: selectedMessages, deliveries: selectedDeliveries,
    messagesTruncated: includeMessages ? selectedMessages.length < messages.length : undefined,
    deliveriesTruncated: includeDeliveries ? selectedDeliveries.length < deliveries.length : undefined };
}

export async function agentBusPlugin(app, { wsManager, productionControls = getProductionControlRegistry(),
  store = new AgentBusStore(), credentialStore = getAgentBusCredentialStore(), taskService = null, managedWorktreeBaseDir,
  sessionDeliveryAuditStore = null } = {}) {
  if (!app.hasDecorator('agentBusLifecycle')) app.decorate('agentBusLifecycle', {});
  store.setLogger?.(app.log);
  const adapters = createAgentAdapters();
  const observedSessions = new Set();
  const deliveryInFlight = new Set();
  const sessionDeliveryInFlight = new Set();
  const observerInFlightByRef = new Map();
  await store.init();
  await credentialStore.init();
  taskService ||= new TaskService({ store, sessionServiceForProvider: getProtocolSessionProvider, startupTimeoutMs: 120_000, logger: app.log });
  await taskService.init();
  registerTaskRoutes({ app, store, service: taskService });

  app.get('/api/agent-bus/auth/readiness', async () => {
    const sessions = [];
    for (const [kind, adapter] of Object.entries(adapters)) {
      try { for (const session of await adapter.listSessions(app)) if (session?.id) sessions.push({ kind, sessionId: session.id }); }
      catch {}
    }
    return credentialStore.readiness(sessions);
  });

  function broadcastAlert(type, data, level = 'warn') {
    app.log[level === 'error' ? 'error' : 'warn']({ type, ...data }, 'Agent bus alert');
    broadcast(wsManager, 'agent-bus:alerts', type, data);
  }
  function pruneObservedParticipant(ref) {
    if (store.listThreads({ status: 'open' }).some((thread) => threadHasParticipant(thread, ref))) return false;
    return observedSessions.delete(participantKey(ref));
  }

  const participants = createAgentBusParticipants({ app, store, adapters,
    readProviderPreferences: () => getAgentProviderPreferencesSync(), isAgentRef, participantKey,
    defaultThinkingLevelForKind: () => 'medium' });

  async function enrichThread(thread, snapshot = store.getThread(thread.id), runtimeCache = new Map()) {
    const next = structuredClone(thread);
    const deliveryHealth = { queued: 0, held: 0, injected: 0, failed: 0, cancelled: 0, oldestQueuedAt: null, oldestQueuedAgeMs: 0 };
    for (const item of snapshot?.deliveries || []) {
      if (item.status === 'failed') deliveryHealth.failed++;
      if (item.status === 'injected') deliveryHealth.injected++;
      if (item.resolution === 'cancelled') deliveryHealth.cancelled++;
      if (item.status !== 'queued') continue;
      deliveryHealth.queued++;
      if (item.holdReason) deliveryHealth.held++;
      const createdAt = Number(item.createdAt || store.getMessage(item.messageId)?.createdAt || 0);
      deliveryHealth.oldestQueuedAt = Math.min(deliveryHealth.oldestQueuedAt ?? createdAt, createdAt);
    }
    if (deliveryHealth.queued) deliveryHealth.oldestQueuedAgeMs = Math.max(0, Date.now() - deliveryHealth.oldestQueuedAt);
    deliveryHealth.overdue = deliveryHealth.queued > 0 && deliveryHealth.oldestQueuedAgeMs >= config.agentBus.queuedTimeoutMs;
    const details = [];
    for (const participant of next.participants || []) {
      const runtime = await participants.getParticipantRuntime(participant, runtimeCache);
      details.push({ ...participant, activity_status: runtime.activity_status, live_process_count: runtime.live_process_count,
        session_state: runtime.session_state, canonical_status: runtime.canonical_status, session_detail: runtime.session_detail,
        session_capabilities: runtime.capabilities,
        can_send_now_reason: runtime.capabilities?.canSendNow === true ? null : (runtime.session_reason || runtime.session_detail),
        display_name: runtime.display_name, session_name: runtime.session_name });
    }
    next.participants = details;
    next.live_process_count = details.reduce((sum, item) => sum + Number(item.live_process_count || 0), 0);
    next.health = deliveryHealth.failed ? 'failed' : (deliveryHealth.overdue || details.some((item) => !item.live_process_count) ? 'stale' : 'ok');
    next.metadata = { ...(next.metadata || {}), deliveryHealth };
    return next;
  }
  async function threadSnapshot(threadId) {
    const snapshot = store.getThread(threadId);
    if (!snapshot) return null;
    snapshot.thread = await enrichThread(snapshot.thread, snapshot);
    return snapshot;
  }
  async function broadcastThreadSummary(threadId) {
    const snapshot = store.getThread(threadId); if (!snapshot) return;
    const thread = normalizeThreadSummary(await enrichThread(snapshot.thread, snapshot));
    broadcast(wsManager, 'agent-bus:threads', 'thread_updated', { thread });
    broadcast(wsManager, `agent-bus:thread:${threadId}`, 'thread_updated', { thread });
  }
  async function broadcastThreadSnapshot(threadId) {
    const snapshot = await threadSnapshot(threadId);
    if (snapshot) broadcast(wsManager, `agent-bus:thread:${threadId}`, 'snapshot', snapshot);
  }

  const delivery = createAgentBusDelivery({ app, store, adapters, wsManager, observedSessions, deliveryInFlight,
    sessionDeliveryInFlight, broadcast, broadcastAlert, resolveAgentSession: participants.resolveAgentSession });

  registerAgentBusRoutes({ app, store, adapters, wsManager, productionControls, observedSessions, deliveryInFlight,
    readProviderPreferences: () => getAgentProviderPreferencesSync(), broadcast, broadcastAlert, broadcastThreadSnapshot,
    broadcastThreadSummary, enrichThread, normalizeThreadSummary, threadMatchesStatusFilter, buildStateSnapshotEntry,
    normalizeCollectionLimit, participantKey, participantRef, threadHasParticipant, threadHasOwner, uniqueAgentRefs, isAgentRef,
    pruneObservedParticipant, taskService, managedWorktreeBaseDir, ...participants, ...delivery });

  createAgentBusObserver({ app, store, adapters, wsManager, observedSessions, deliveryInFlight, observerInFlightByRef,
    sessionDeliveryAuditStore,
    hookEventsRetentionDays: config.hookEventsRetentionDays,
    observerIntervalMs: config.agentBus.pollMs, observerSessionTimeoutMs: Math.max(5000, config.agentBus.pollMs * 5),
    broadcast, broadcastAlert, broadcastThreadSnapshot, broadcastThreadSummary, threadSnapshot, enrichThread,
    normalizeThreadSummary, pruneObservedParticipant, deliverMessage: delivery.deliverMessage,
    failDelivery: delivery.failDelivery });

  const stopSessionDelete = onAgentSessionDeleted(async ({ kind, sessionId }) => {
    const ref = { kind, sessionId };
    const revocation = Promise.resolve().then(() => credentialStore.revoke({
      principal: { type: 'agent', kind, sessionId }, reason: 'session_deleted',
    })).catch(() => {});
    try {
      for (const item of store.listDeliveries()) {
        if (item.status !== 'queued' || participantKey(item.target) !== participantKey(ref)) continue;
        const message = store.getMessage(item.messageId);
        if (message) await delivery.failDelivery(message, item, new Error('session_deleted'));
      }
      for (const thread of store.listThreads({ status: 'open' })) {
        if (!threadHasParticipant(thread, ref)) continue;
        const updated = await store.removeThreadParticipant(thread.id, ref);
        if (!updated) continue;
        const agentsLeft = (updated.participants || []).filter((item) => item.kind !== 'user');
        if (updated.metadata?.dm || agentsLeft.length === 0) {
          await store.closeThread(updated.id, 'session_deleted');
        }
        pruneObservedParticipant(ref);
        await broadcastThreadSummary(updated.id);
      }
    } catch (error) {
      app.log.error({ kind, sessionId, err: error.message }, 'Agent bus session deletion cleanup failed');
      throw error;
    } finally {
      await revocation;
    }
  });
  app.addHook('onClose', async () => { stopSessionDelete(); await taskService.close(); });
}
