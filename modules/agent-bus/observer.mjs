import { stat } from 'node:fs/promises';
import { buildHookSessionPaths, createHookEventRetention, knownSessions, readHookEventsSince } from '../agent/hook-events.mjs';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import { shouldSuppressSideEffectLoops } from '../platform/side-effect-loops.mjs';

const RECOVERY_GRACE_MS = 2000;

function terminalLookupError(err = {}) {
  const status = Number(err.statusCode || err.payload?.statusCode || 0);
  return status === 404 || err.code === 'session_not_found' || err.payload?.sessionEnded === true
    || err.payload?.state?.status === 'ended';
}

export function createAgentBusObserver({ app, store, adapters, wsManager, observedSessions, deliveryInFlight,
  observerInFlightByRef, observerIntervalMs, observerSessionTimeoutMs, broadcast, broadcastAlert,
  broadcastThreadSnapshot, broadcastThreadSummary, threadSnapshot, enrichThread, normalizeThreadSummary,
  pruneObservedParticipant, deliverMessage, failDelivery, hookEventsRetentionDays = 7 }) {
  const hookRetention = createHookEventRetention({
    retentionDays: hookEventsRetentionDays,
    store: buildPostgresJsonStore({ namespace: 'hook_event_roots', filePath: runtimeStatePath('hook_event_roots.json') }),
  });
  let lastHookSweep = Date.now();
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

  // A spawn_session child's turn with no background work goes to its spawner as one DM result, keyed by the Stop
  // record's position in the append-only hook log, unless the child wrote that DM itself during the
  // turn. A failed send leaves the cursor in place to retry; after a restart the keys make the replay
  // from the start a no-op.
  const spawnResultCursors = new Map();
  async function returnSpawnResults() {
    const sessions = [...knownSessions()].filter((session) => session.metadata?.spawnedBy);
    await Promise.allSettled(sessions.map(async (session) => {
      const key = `${session.provider}:${session.id}`;
      const hookFile = { workDir: session.workDir, provider: session.provider, sessionId: session.id };
      const prior = spawnResultCursors.get(key) || { cursor: 0, index: 0, turnStartedAt: 0, size: 0 };
      const { size } = await stat((await buildHookSessionPaths(hookFile)).eventsPath);
      if (size === prior.size) return;
      const { events, cursor } = await readHookEventsSince({ ...hookFile, cursor: prior.cursor });
      let { turnStartedAt } = prior;
      for (const [offset, event] of events.entries()) {
        const at = Date.parse(event.loggedAt);
        if (event.eventName === 'UserPromptSubmit') turnStartedAt = at;
        if (event.eventName !== 'Stop' || !event.lastAssistantMessage?.trim()) continue;
        if (Array.isArray(event.payload?.background_tasks) && event.payload.background_tasks.length) continue;
        let outstanding = false;
        for (const child of sessions) {
          if (child.metadata.spawnedBy.kind !== session.provider || child.metadata.spawnedBy.sessionId !== session.id
            || (child.endedAt && !(child.resumedAt > child.endedAt)) || child.lifecycle === 'ended'
            || new Date(child.created ?? child.createdAt ?? 0).getTime() > at) continue;
          const { events: childEvents } = await readHookEventsSince({ workDir: child.workDir, provider: child.provider, sessionId: child.id });
          const history = childEvents.filter((item) => Date.parse(item.loggedAt) <= at);
          // Log positions keep a re-prompt after a Stop outstanding even within one clock millisecond.
          const prompt = history.findLastIndex((item) => item.eventName === 'UserPromptSubmit');
          const stop = history.findLastIndex((item) => item.eventName === 'Stop');
          const background = history[stop]?.payload?.background_tasks;
          if (prompt < 0 || stop < prompt || (Array.isArray(background) && background.length)) {
            outstanding = true; break;
          }
        }
        if (outstanding) continue;
        const result = await app.agentBusLifecycle.directMessage({ from: { kind: session.provider, sessionId: session.id },
          target: session.metadata.spawnedBy, body: event.lastAssistantMessage, type: 'result',
          idempotencyKey: `spawn-result:${key}:${prior.index + offset}`, skipIfSentBetween: [turnStartedAt, at] });
        if (result.statusCode !== 200 && result.statusCode !== 410) {
          return app.log.warn({ session: key, error: result.payload?.error }, 'Spawn result return failed; retrying');
        }
      }
      spawnResultCursors.set(key, { cursor, index: prior.index + events.length, turnStartedAt, size });
    }));
  }

  async function observeSessions() {
    await Promise.allSettled([...observedSessions].map(observeSession));
    await returnSpawnResults();
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
    try {
      await observeSessions();
      if (!shouldSuppressSideEffectLoops() && Date.now() - lastHookSweep >= 3_600_000) {
        lastHookSweep = Date.now();
        void app.agentBusLifecycle?.sweepWorktrees?.().catch((err) => app.log.warn({ err: err.message }, 'Managed worktree sweep failed'));
        void hookRetention.sweep().catch((err) => app.log.warn({ err: err.message }, 'Hook event retention failed'));
      }
    }
    catch (err) { broadcastAlert('observer_error', { error: err.message }, 'error'); }
    finally { running = false; }
  }, observerIntervalMs);
  interval.unref?.();

  app.addHook('onClose', async () => {
    clearInterval(interval);
    await hookRetention.close();
    if (typeof store.close === 'function') await store.close();
  });
}
