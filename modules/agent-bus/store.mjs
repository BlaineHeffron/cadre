import { appendFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../../config.mjs';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { recordOpsTiming, registerOpsGauge } from '../ops/observability.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import { isDurableTaskRecord } from '../sessions/task-record.mjs';

const MAX_IN_MEMORY_EVENTS = 500;
const DEFAULT_PERSIST_DEBOUNCE_MS = 0;

const noopLogger = {
  debug() {},
  warn() {},
};

function makeId(prefix) {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function sanitizeThreadMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const next = { ...metadata };
  delete next.managerLoop;
  return next;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class AgentBusStore {
  constructor({ stateDir = config.agentBus.stateDir, logger = noopLogger, persistDebounceMs = DEFAULT_PERSIST_DEBOUNCE_MS,
    closedThreadRetentionDays = config.agentBus.closedThreadRetentionDays } = {}) {
    this.closedThreadRetentionDays = closedThreadRetentionDays;
    this.stateDir = resolve(stateDir);
    this.stateFile = resolve(this.stateDir, 'state.json');
    this.eventsFile = resolve(this.stateDir, 'events.ndjson');
    this.logger = logger || noopLogger;
    this.persistDebounceMs = Math.max(0, Number(persistDebounceMs) || 0);
    this.lastPersistStateBytes = 0;
    this._persistDirty = false;
    this._persistPromise = null;
    this._persistTimer = null;
    this.stateStore = buildPostgresJsonStore({
      namespace: 'agent_bus_state',
      filePath: this.stateFile,
      legacyFilePath: this.stateDir === resolve(runtimeStatePath('agent_bus')) ? resolve('.agent_bus/state.json') : undefined,
      modeEnvKey: 'AGENT_BUS_STORAGE',
      onWriteError: (err) => {
        this.logger.debug?.({ err: err?.message || err, stateFile: this.stateFile }, 'Agent bus file mirror write failed');
      },
    });
    this.state = {
      threads: [],
      messages: [],
      deliveries: [],
      events: [],
    };
    /** @type {Map<string, object[]>} threadId → messages (live references, not clones) */
    this._msgIdx = new Map();
    /** @type {Map<string, object[]>} threadId → deliveries (live references, not clones) */
    this._delIdx = new Map();
    registerOpsGauge('agent_bus_state_bytes', () => this.lastPersistStateBytes);
  }

  setLogger(logger = noopLogger) {
    this.logger = logger || noopLogger;
  }

  _rebuildIndexes() {
    this._msgIdx = new Map();
    this._delIdx = new Map();
    for (const msg of this.state.messages) {
      const arr = this._msgIdx.get(msg.threadId);
      if (arr) arr.push(msg);
      else this._msgIdx.set(msg.threadId, [msg]);
    }
    for (const del of this.state.deliveries) {
      const arr = this._delIdx.get(del.threadId);
      if (arr) arr.push(del);
      else this._delIdx.set(del.threadId, [del]);
    }
  }

  async init() {
    await mkdir(this.stateDir, { recursive: true });

    try {
      const parsed = await this.stateStore.load();
      if (parsed && typeof parsed === 'object') {
        this.state = {
          threads: Array.isArray(parsed.threads) ? parsed.threads : [],
          messages: Array.isArray(parsed.messages) ? parsed.messages : [],
          deliveries: Array.isArray(parsed.deliveries) ? parsed.deliveries : [],
          events: Array.isArray(parsed.events) ? parsed.events.slice(-MAX_IN_MEMORY_EVENTS) : [],
        };
      }
    } catch (err) {
      this.logger.warn?.({ err: err?.message || err, stateFile: this.stateFile }, 'Failed to load agent bus state');
      throw err;
    }
    this._rebuildIndexes();
    await this.pruneClosedThreads();
  }

  _snapshotState() {
    return {
      threads: this.state.threads,
      messages: this.state.messages,
      deliveries: this.state.deliveries,
    };
  }

  async persist() {
    this._persistDirty = true;
    if (!this._persistPromise) {
      this._persistPromise = new Promise((resolvePromise, rejectPromise) => {
        this._persistTimer = setTimeout(async () => {
          this._persistTimer = null;
          try {
            do {
              this._persistDirty = false;
              const snapshot = this._snapshotState();
              const startedAt = Date.now();
              this.lastPersistStateBytes = (await this.stateStore.save(snapshot)) ?? this.lastPersistStateBytes;
              recordOpsTiming('agent_bus_persist_duration_ms', Date.now() - startedAt);
            } while (this._persistDirty);
            resolvePromise();
          } catch (err) {
            this.logger.warn?.({ err: err?.message || err, stateFile: this.stateFile }, 'Failed to persist agent bus state');
            rejectPromise(err);
          } finally {
            this._persistPromise = null;
          }
        }, this.persistDebounceMs);
      });
    }
    await this._persistPromise;
  }

  async close() {
    if (this._persistDirty || this._persistPromise) {
      await this.persist();
    }
    await this.stateStore.close();
  }

  async appendEvent(type, data) {
    const event = {
      id: makeId('evt'),
      type,
      createdAt: Date.now(),
      data,
    };
    this.state.events.push(event);
    if (this.state.events.length > MAX_IN_MEMORY_EVENTS) {
      this.state.events = this.state.events.slice(-MAX_IN_MEMORY_EVENTS);
    }
    try {
      await appendFile(this.eventsFile, `${JSON.stringify(event)}\n`);
    } catch (err) {
      this.logger.debug?.({ err: err?.message || err, eventsFile: this.eventsFile }, 'Failed to append agent bus event mirror');
    }
    return event;
  }

  listThreads(filters = {}) {
    const { status, projectKey } = filters;
    return this.state.threads
      .filter((thread) => !status || thread.status === status)
      .filter((thread) => !projectKey || thread.projectKey === projectKey)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(clone);
  }

  listMessages() {
    return this.state.messages.map(clone);
  }

  listDeliveries() {
    return this.state.deliveries.map(clone);
  }

  resolveThreadId(threadId) {
    const normalized = typeof threadId === 'string' ? threadId.trim() : '';
    if (!normalized) return null;

    const exact = this.state.threads.find((item) => item.id === normalized);
    if (exact) return exact.id;

    const prefixMatches = this.state.threads.filter((item) => item.id.startsWith(normalized));
    if (prefixMatches.length === 1) return prefixMatches[0].id;

    return null;
  }

  getThread(threadId) {
    const resolvedThreadId = this.resolveThreadId(threadId);
    if (!resolvedThreadId) return null;
    const thread = this.state.threads.find((item) => item.id === resolvedThreadId);
    if (!thread) return null;

    return {
      thread: clone(thread),
      messages: (this._msgIdx.get(resolvedThreadId) || []).map(clone),
      deliveries: (this._delIdx.get(resolvedThreadId) || []).map(clone),
    };
  }

  getMessage(messageId) {
    const message = this.state.messages.find((item) => item.id === messageId);
    return message ? clone(message) : null;
  }

  getDeliveryForMessage(messageId) {
    const delivery = this.state.deliveries.find((item) => item.messageId === messageId);
    return delivery ? clone(delivery) : null;
  }

  getDelivery(deliveryId) {
    const delivery = this.state.deliveries.find((item) => item.id === deliveryId);
    return delivery ? clone(delivery) : null;
  }

  hasReply({ replyTo, from }) {
    return this.state.messages.some((message) =>
      message.replyTo === replyTo
      && message.from?.kind === from?.kind
      && message.from?.sessionId === from?.sessionId
    );
  }

  async createThread({ title, projectKey, participants, metadata, createdBy }) {
    const now = Date.now();
    const owner = createdBy?.kind && createdBy?.sessionId
      ? { kind: String(createdBy.kind), sessionId: String(createdBy.sessionId) }
      : null;
    const thread = {
      id: makeId('thr'),
      title: title?.trim() || 'Untitled thread',
      projectKey: projectKey?.trim() || '',
      status: 'open',
      participants: Array.isArray(participants) ? participants : [],
      createdBy: owner,
      createdAt: now,
      updatedAt: now,
      metadata: sanitizeThreadMetadata(metadata),
    };

    this.state.threads.push(thread);
    await this.persist();
    await this.appendEvent('thread.created', { threadId: thread.id });
    return clone(thread);
  }

  async closeThread(threadId, reason = '') {
    const resolvedThreadId = this.resolveThreadId(threadId);
    const thread = this.state.threads.find((item) => item.id === resolvedThreadId);
    if (!thread) return null;
    if (isDurableTaskRecord(thread.metadata?.task) && !thread.metadata.task.tombstone) {
      throw Object.assign(new Error('Managed task rooms remain open while task history is retained'), { code: 'task_retained', statusCode: 409 });
    }

    thread.status = 'closed';
    thread.updatedAt = Date.now();
    // Close and terminalize undelivered work in the same persisted snapshot.
    for (const delivery of this._delIdx.get(thread.id) || []) {
      if (delivery.status !== 'queued') continue;
      Object.assign(delivery, { status: 'failed', error: 'thread_closed',
        resolution: 'cancelled', cancelledAt: thread.updatedAt,
        holdReason: null, holdDetail: null, willInjectWhenIdle: false });
    }
    if (reason) {
      thread.metadata = { ...(thread.metadata || {}), closeReason: reason };
    }

    await this.persist();
    await this.appendEvent('thread.updated', { threadId: thread.id });
    return clone(thread);
  }

  async reopenThread(threadId) {
    const resolvedThreadId = this.resolveThreadId(threadId);
    const thread = this.state.threads.find((item) => item.id === resolvedThreadId);
    if (!thread) return null;
    thread.status = 'open';
    thread.updatedAt = Date.now();
    await this.persist();
    await this.appendEvent('thread.updated', { threadId: thread.id });
    return clone(thread);
  }

  async deleteThread(threadId) {
    const resolvedThreadId = this.resolveThreadId(threadId);
    const threadIndex = this.state.threads.findIndex((item) => item.id === resolvedThreadId);
    if (threadIndex === -1) return false;

    const thread = this.state.threads[threadIndex];
    const dependants = this.state.threads.filter((item) => isDurableTaskRecord(item.metadata?.task)
      && (item.id === resolvedThreadId || item.metadata.task.parentTaskId === resolvedThreadId
        || item.metadata.task.parentThreadId === resolvedThreadId));
    if (dependants.some((item) => !item.metadata.task.tombstone)) {
      throw Object.assign(new Error('Task history is retained for parent consumption'), { code: 'task_retained', statusCode: 409 });
    }

    // Keep stable task/key/result tombstones after bodies are pruned.
    if (isDurableTaskRecord(thread.metadata?.task)) thread.status = 'closed';
    else this.state.threads.splice(threadIndex, 1);
    this.state.messages = this.state.messages.filter((item) => item.threadId !== resolvedThreadId);
    this.state.deliveries = this.state.deliveries.filter((item) => item.threadId !== resolvedThreadId);
    this._msgIdx.delete(resolvedThreadId);
    this._delIdx.delete(resolvedThreadId);

    await this.persist();
    await this.appendEvent('thread.deleted', { threadId: resolvedThreadId });
    return true;
  }

  /** Drops closed threads (with messages, deliveries and room mirrors) idle past the retention window; task records and task parents are kept. */
  async pruneClosedThreads({ retentionDays = this.closedThreadRetentionDays, now = Date.now() } = {}) {
    if (!(retentionDays >= 0)) return 0;
    const cutoff = now - retentionDays * 86_400_000;
    const tasks = this.state.threads.map((item) => item.metadata?.task).filter(isDurableTaskRecord);
    const pinned = new Set(tasks.flatMap((task) => [task.parentTaskId, task.parentThreadId]));
    const doomed = new Set(this.state.threads.filter((item) => item.status === 'closed' && !isDurableTaskRecord(item.metadata?.task)
      && !pinned.has(item.id) && Number(item.updatedAt || item.createdAt || 0) <= cutoff).map((item) => item.id));
    if (!doomed.size) return 0;
    this.state.threads = this.state.threads.filter((item) => !doomed.has(item.id));
    this.state.messages = this.state.messages.filter((item) => !doomed.has(item.threadId));
    this.state.deliveries = this.state.deliveries.filter((item) => !doomed.has(item.threadId));
    this._rebuildIndexes();
    await this.persist();
    await Promise.all([...doomed].map((id) => rm(resolve(this.stateDir, 'rooms', id), { recursive: true, force: true }).catch(() => {})));
    await this.appendEvent('threads.pruned', { count: doomed.size });
    return doomed.size;
  }

  async updateThreadMetadata(threadId, patch) {
    const resolvedThreadId = this.resolveThreadId(threadId);
    const thread = this.state.threads.find((item) => item.id === resolvedThreadId);
    if (!thread) return null;

    thread.metadata = sanitizeThreadMetadata({
      ...(thread.metadata || {}),
      ...(patch && typeof patch === 'object' ? patch : {}),
    });
    thread.updatedAt = Date.now();

    await this.persist();
    await this.appendEvent('thread.updated', { threadId: thread.id });
    return clone(thread);
  }

  async addThreadParticipant(threadId, participant) {
    const resolvedThreadId = this.resolveThreadId(threadId);
    const thread = this.state.threads.find((item) => item.id === resolvedThreadId);
    if (!thread) return null;

    const next = { kind: participant?.kind, sessionId: participant?.sessionId };
    if (!next.kind || !next.sessionId) return null;
    const participants = Array.isArray(thread.participants) ? thread.participants : [];
    if (!participants.some((entry) => entry.kind === next.kind && entry.sessionId === next.sessionId)) {
      thread.participants = [...participants, next];
      thread.updatedAt = Date.now();
      await this.persist();
      await this.appendEvent('thread.updated', { threadId: thread.id });
    }

    return clone(thread);
  }

  async removeThreadParticipant(threadId, participant) {
    const resolvedThreadId = this.resolveThreadId(threadId);
    const thread = this.state.threads.find((item) => item.id === resolvedThreadId);
    if (!thread) return null;

    const keyKind = participant?.kind;
    const keySession = participant?.sessionId;
    if (!keyKind || !keySession) return clone(thread);
    const participants = Array.isArray(thread.participants) ? thread.participants : [];
    const next = participants.filter((entry) => entry.kind !== keyKind || entry.sessionId !== keySession);
    if (next.length === participants.length) return clone(thread);
    thread.participants = next;
    thread.updatedAt = Date.now();
    await this.persist();
    await this.appendEvent('thread.updated', { threadId: thread.id });
    return clone(thread);
  }

  async createMessage({ threadId, from, targets = [], type = 'message', body, artifacts, createdBy, replyTo = null, metadata = null, idempotencyKey = null }) {
    const resolvedThreadId = this.resolveThreadId(threadId);
    const thread = this.state.threads.find((item) => item.id === resolvedThreadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }

    const existing = idempotencyKey && (this._msgIdx.get(resolvedThreadId) || [])
      .find((item) => item.idempotencyKey === String(idempotencyKey));
    if (existing) {
      await this.persist();
      return { message: clone(existing), deliveries: (this._delIdx.get(resolvedThreadId) || []).filter((item) => item.messageId === existing.id).map(clone) };
    }

    if (thread.status !== 'open') throw Object.assign(new Error('Thread is closed'), { statusCode: 409 });

    const now = Date.now();
    const message = {
      id: makeId('msg'),
      ...(idempotencyKey ? { idempotencyKey: String(idempotencyKey) } : {}),
      threadId: resolvedThreadId,
      from,
      type,
      body,
      artifacts: Array.isArray(artifacts) ? artifacts : [],
      replyTo,
      priority: 'normal',
      createdAt: now,
      createdBy: createdBy || 'api',
      metadata: metadata && typeof metadata === 'object' ? clone(metadata) : {},
    };

    const deliveries = targets.map((target) => ({
      id: makeId('del'), threadId: resolvedThreadId, messageId: message.id, target,
      status: 'queued', attempts: 0, replayAttempts: 0, replayHistory: [],
      createdAt: now, lastAttemptAt: null, error: null,
    }));

    this.state.messages.push(message);
    this.state.deliveries.push(...deliveries);
    thread.updatedAt = now;

    const msgArr = this._msgIdx.get(resolvedThreadId);
    if (msgArr) msgArr.push(message);
    else this._msgIdx.set(resolvedThreadId, [message]);
    const delArr = this._delIdx.get(resolvedThreadId);
    if (delArr) delArr.push(...deliveries);
    else this._delIdx.set(resolvedThreadId, deliveries);

    await this.persist();
    await this.appendEvent('message.created', { threadId: resolvedThreadId, messageId: message.id, deliveryIds: deliveries.map((item) => item.id) });
    await this.appendRoomMessageMirror(thread, message);

    return { message: clone(message), deliveries: clone(deliveries) };
  }

  async updateMessageMetadata(messageId, patch) {
    const message = this.state.messages.find((item) => item.id === messageId);
    if (!message) throw new Error(`Message not found: ${messageId}`);
    message.metadata = { ...message.metadata, ...clone(patch) };
    await this.persist();
    return clone(message);
  }

  async updateDelivery(deliveryId, patch) {
    const delivery = this.state.deliveries.find((item) => item.id === deliveryId);
    if (!delivery) {
      throw new Error(`Delivery not found: ${deliveryId}`);
    }

    Object.assign(delivery, patch);
    await this.persist();
    await this.appendEvent('delivery.updated', { deliveryId, status: delivery.status });
    return clone(delivery);
  }

  async appendRoomMessageMirror(thread, message) {
    const dir = resolve(this.stateDir, 'rooms', thread.id);
    try {
      await mkdir(dir, { recursive: true });
      await appendFile(resolve(dir, 'messages.jsonl'), `${JSON.stringify({
        id: message.id, threadId: message.threadId, from: message.from, type: message.type,
        body: message.body, replyTo: message.replyTo, createdAt: message.createdAt,
      })}\n`);
    } catch (err) {
      this.logger.debug?.({ err: err?.message || err, dir }, 'Agent bus room message mirror write failed');
    }
  }
}
