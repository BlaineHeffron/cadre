import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { resumableProtocolSessionId, TASK_ADMISSION } from './session-service.mjs';
import { DURABLE_TASK_RECORD_TYPE, isDurableTaskRecord } from './task-record.mjs';

// A zero-time poll still gets a finite allowance to confirm its supplied cursor.
const ACK_PROCESSING_TIMEOUT_MS = 1000;
const TERMINAL = new Set(['completed', 'cancelled', 'startup_failed', 'unknown']);
const clone = (value) => structuredClone(value);
const fail = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const keyOf = (taskId, attempt) => `${taskId}/${attempt.sessionId}/${attempt.attemptId}`;
const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw fail('invalid_task_input', `${name} is required`, 400);
  return value.trim();
};
function decodeCursor(cursor) {
  if (!cursor) return {};
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (value.v !== 1 || !value.cursors || Array.isArray(value.cursors)) throw new Error();
    for (const seq of Object.values(value.cursors)) if (!Number.isSafeInteger(seq) || seq < 0) throw new Error();
    return value.cursors;
  } catch { throw fail('invalid_cursor', 'Invalid task cursor', 400); }
}
async function bounded(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(fail('outcome_unknown', 'Provider response deadline expired')), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// One task record per bus thread; commands/results use its existing mailbox and
// the provider session journal. Subscriptions only wake durable reconciliation.
export class TaskService {
  constructor({ store, sessionServiceForProvider, handshakeVerifier = null, now = Date.now,
    startupTimeoutMs = 30_000, retentionMs = 86_400_000, mailboxLimit = 100, logger = null } = {}) {
    if (!store || typeof sessionServiceForProvider !== 'function') throw new TypeError('store and sessionServiceForProvider are required');
    Object.assign(this, { store, sessionServiceForProvider, handshakeVerifier, now, startupTimeoutMs, retentionMs, mailboxLimit, logger });
    this.locks = new Map();
    this.bindings = new Map();
    this.reconciliations = new Map();
    this.savedMetadata = new Map();
    this.publishedResults = new Set();
    this.unsubscribers = [];
    this.deadlines = new Map();
    this.closed = false;
  }

  async init() {
    await this.reconcile();
    for (const task of this.#tasks()) this.#deadline(task);
    return this;
  }

  #deadline(task) {
    clearTimeout(this.deadlines.get(task.taskId));
    if (!['starting', 'awaiting_handshake'].includes(task.startup.state)) return;
    const timer = setTimeout(() => {
      this.deadlines.delete(task.taskId);
      if (!this.closed) this.reconcile(task.taskId).catch((error) => this.logger?.warn?.({ err: error.message }, 'Task startup deadline failed'));
    }, Math.max(1, task.startup.deadline - this.now()));
    timer.unref?.();
    this.deadlines.set(task.taskId, timer);
  }

  #tasks() {
    return this.store.listThreads().filter((thread) => isDurableTaskRecord(thread.metadata?.task))
      .map((thread) => ({ ...thread.metadata.task, taskId: thread.id }));
  }

  #task(taskId) {
    const thread = this.store.getThread(taskId)?.thread;
    if (!isDurableTaskRecord(thread?.metadata?.task) || thread.id !== taskId) throw fail('task_not_found', `Task not found: ${taskId}`, 404);
    return { ...thread.metadata.task, taskId: thread.id };
  }

  #parentRef(task) {
    const parent = task.parentTaskId && this.#task(task.parentTaskId);
    return parent ? { kind: parent.provider, sessionId: parent.attempts.at(-1)?.sessionId } : task.parentRef;
  }

  async #save(task) {
    const serialized = JSON.stringify(task);
    if (this.savedMetadata.get(task.taskId) === serialized) return;
    await this.store.updateThreadMetadata(task.taskId, { task });
    if (task.tombstone) this.#forgetCaches(task);
    else this.savedMetadata.set(task.taskId, serialized);
  }

  #forgetCaches(task) {
    this.savedMetadata.delete(task.taskId);
    for (const message of this.store.getThread(task.taskId)?.messages || []) this.savedMetadata.delete(message.id);
    for (const result of task.results) this.publishedResults.delete(result.resultKey);
  }

  async #saveMessage(messageId, patch) {
    const serialized = JSON.stringify({ ...this.store.getMessage(messageId).metadata, ...patch });
    if (this.savedMetadata.get(messageId) === serialized) return;
    await this.store.updateMessageMetadata(messageId, patch);
    this.savedMetadata.set(messageId, serialized);
  }

  async #binding(provider) {
    if (this.bindings.has(provider)) return this.bindings.get(provider);
    const found = await this.sessionServiceForProvider(provider);
    const binding = found?.service ? found : { service: found };
    if (!binding.service) throw fail('unsupported_provider', `No structured task service for ${provider}; use spawn_session(parentThreadId) with room_send/room_context, or monitor_send_to_session and monitor_list_session_deliveries`, 400);
    await binding.service.init();
    this.bindings.set(provider, binding);
    this.unsubscribers.push(binding.service.subscribe((session) => {
      if (this.closed) return;
      if (session.taskId) this.reconcile(session.taskId).catch((error) => this.logger?.warn?.({ err: error.message }, 'Task reconciliation failed'));
    }));
    return binding;
  }

  #lock(key, operation) {
    const previous = this.locks.get(key) || Promise.resolve();
    const next = previous.then(operation, operation);
    const tracked = next.catch(() => {});
    this.locks.set(key, tracked);
    return next.finally(() => { if (this.locks.get(key) === tracked) this.locks.delete(key); });
  }

  async spawn(parentTaskId, taskKey, spec = {}) {
    taskKey = required(taskKey, 'taskKey');
    const parent = parentTaskId ? this.#task(parentTaskId) : null;
    const parentRef = parent ? { kind: parent.provider, sessionId: parent.attempts.at(-1).sessionId } : spec.parentRef;
    if (!parentRef?.kind || !parentRef?.sessionId) throw fail('invalid_parent', 'An authenticated parentRef is required', 400);
    const parentIdentity = parentTaskId || `${parentRef.kind}:${parentRef.sessionId}`;
    const identity = JSON.stringify([parentIdentity, taskKey]);
    return this.#lock(parentTaskId || `spawn:${parentIdentity}`, async () => {
      const existing = this.#tasks().find((task) => task.spawnKey === identity);
      if (existing) { await this.store.persist(); return this.status(existing.taskId); }
      const currentParent = parentTaskId ? this.#task(parentTaskId) : null;
      if (currentParent?.cancel || currentParent?.tombstone) throw fail('task_cancelled', 'Parent no longer admits descendants');
      const provider = required(spec.provider, 'provider');
      const workDir = resolve(required(spec.workDir, 'workDir'));
      const inherited = currentParent?.scope;
      const scope = clone(spec.scope || inherited || { providers: [provider], workDirs: [workDir], maxDepth: 0, maxChildren: 0 });
      if (!Array.isArray(scope.providers) || !Array.isArray(scope.workDirs)
        || !Number.isInteger(scope.maxDepth) || scope.maxDepth < 0 || scope.maxDepth > 8
        || !Number.isInteger(scope.maxChildren) || scope.maxChildren < 0 || scope.maxChildren > 100
        || !scope.providers.includes(provider) || !scope.workDirs.includes(workDir)) {
        throw fail('task_scope_denied', 'Task launch exceeds its resolved scope', 403);
      }
      if (inherited) {
        if (inherited.maxDepth < 1 || scope.providers.some((value) => !inherited.providers.includes(value))
          || scope.workDirs.some((value) => !inherited.workDirs.includes(value))
          || (spec.scope && scope.maxDepth >= inherited.maxDepth) || scope.maxChildren > inherited.maxChildren
          || this.#tasks().filter((task) => task.parentTaskId === parentTaskId).length >= inherited.maxChildren) {
          throw fail('task_scope_denied', 'Descendant scope exceeds parent authorization', 403);
        }
        if (!spec.scope) scope.maxDepth -= 1;
      }
      const binding = await this.#binding(provider);
      // Persist only resolved launch settings, never arbitrary environment/credentials.
      const launch = { provider, workDir, model: String(spec.model || ''), permissionMode: required(spec.permissionMode, 'permissionMode') };
      for (const field of ['displayName', 'mcpProfile', 'skills', 'thinkingLevel', 'promptProfile', 'initialPrompt']) {
        if (spec[field] != null) launch[field] = clone(spec[field]);
      }
      const task = { recordType: DURABLE_TASK_RECORD_TYPE, spawnKey: identity, taskKey, parentTaskId: parentTaskId || null,
        parentRef: clone(parentRef), owner: clone(currentParent?.owner || spec.owner || spec.ownerRef || parentRef),
        parentThreadId: currentParent?.taskId || spec.threadId || null, provider, scope, spec: launch,
        toolScopes: clone(currentParent?.toolScopes || spec.toolScopes || []),
        state: 'starting', startup: { state: 'starting' }, attempts: [], cancel: null,
        requests: {}, consumed: {}, results: [], createdAt: this.now(), tombstone: false };
      const thread = await this.store.createThread({ title: launch.displayName || taskKey, projectKey: workDir,
        participants: [parentRef], createdBy: parentRef, metadata: { task } });
      task.taskId = thread.id;
      await this.#lock(task.taskId, () => this.#start(task, binding));
      return this.status(task.taskId);
    });
  }

  async #start(task, binding, resumeFrom = null) {
    const attempt = { sessionId: randomUUID(), attemptId: randomUUID(), createdAt: this.now(), resumeFrom };
    task.attempts.push(attempt);
    task.state = 'starting';
    task.startup = { state: 'starting', deadline: this.now() + this.startupTimeoutMs };
    await this.#save(task);
    await binding.service.journal.append(attempt.sessionId, { type: 'task.linked',
      idempotencyKey: `task:${task.taskId}`, data: { taskId: task.taskId, attemptId: attempt.attemptId } });
    try {
      const { initialPrompt, ...settings } = task.spec;
      const launch = { ...settings, sessionId: attempt.sessionId, attemptId: attempt.attemptId,
        resumeFrom, threadId: task.taskId, parentThreadId: task.parentThreadId, scope: clone(task.scope), toolScopes: clone(task.toolScopes),
        metadata: { taskId: task.taskId, parentTaskId: task.parentTaskId, parentThreadId: task.parentThreadId } };
      await bounded(binding.start ? binding.start(launch) : binding.service.start(launch), this.startupTimeoutMs);
      task.state = 'awaiting_handshake';
      task.startup.state = 'awaiting_handshake';
      await this.store.addThreadParticipant(task.taskId, { kind: task.provider, sessionId: attempt.sessionId });
      await binding.service.prompt(attempt.sessionId, {
        taskAdmission: TASK_ADMISSION,
        idempotencyKey: `bootstrap:${attempt.attemptId}`, source: 'task_bootstrap',
        blocks: [{ type: 'text', text: `Startup handshake only. Call room_context for thread_id=${task.taskId}, then room_send to that same thread acknowledging your task ${task.taskId}, session ${attempt.sessionId}, attempt ${attempt.attemptId}. Do not perform task work yet. End this startup turn after the authenticated read and reply.` }],
      });
      if (task.spec.initialPrompt && task.attempts.length === 1) await this.store.createMessage({
        threadId: task.taskId, from: task.parentRef, body: task.spec.initialPrompt,
        idempotencyKey: 'send:initial', metadata: { taskSend: true, state: 'queued', mode: 'queue',
          blocks: [{ type: 'text', text: task.spec.initialPrompt }] },
      });
    } catch (error) {
      const started = binding.service.get(attempt.sessionId);
      task.state = error.code === 'outcome_unknown' || (started && !['ended', 'interrupted'].includes(started.lifecycle)) ? 'unknown' : 'startup_failed';
      task.startup = { ...task.startup, state: task.state, error: { code: error.code || 'startup_failed', message: error.message } };
      if (task.state === 'unknown') await bounded(binding.service.terminate(attempt.sessionId, { reason: 'startup_timeout' }), this.startupTimeoutMs).catch(() => {});
    }
    await this.#save(task);
    this.#deadline(task);
  }

  // Called only by authenticated server room handlers after a successful operation.
  async observeHandshake(taskId, { kind, sessionId, threadId, operation, messageId } = {}) {
    return this.#lock(taskId, async () => {
      const task = this.#task(taskId);
      if (task.provider !== kind || task.attempts.at(-1)?.sessionId !== sessionId || threadId !== taskId
        || !['room_context', 'room_send'].includes(operation)) throw fail('handshake_identity_mismatch', 'Handshake does not belong to this task attempt', 403);
      if (task.cancel || !['starting', 'awaiting_handshake'].includes(task.startup.state)) return;
      if (operation === 'room_send') {
        const message = this.store.getMessage(messageId);
        if (!task.startup.roomRead || message?.threadId !== taskId || message.from?.sessionId !== sessionId || message.from?.kind !== kind) {
          throw fail('handshake_reply_invalid', 'Handshake reply must follow its authenticated room read', 403);
        }
        task.startup.roomReply = { messageId, observedAt: this.now() };
      } else task.startup.roomRead = { ok: true, observedAt: this.now() };
      await this.#save(task);
      await this.#reconcile(task);
    });
  }

  async send(taskId, messageKey, input, mode = 'queue') {
    messageKey = required(messageKey, 'messageKey');
    const deliveryMode = typeof mode === 'string' ? mode : mode?.type || mode?.mode;
    const expectedTurnId = typeof mode === 'object' ? mode.expectedTurnId : null;
    if (!['queue', 'steer'].includes(deliveryMode)) throw fail('invalid_mode', 'mode must be queue or steer', 400);
    const blocks = typeof input === 'string' ? [{ type: 'text', text: input }] : input?.blocks || input;
    if (!Array.isArray(blocks) || !blocks.length) throw fail('invalid_task_input', 'Non-empty prompt blocks are required', 400);
    return this.#lock(taskId, async () => {
      const task = this.#task(taskId);
      const messages = this.store.getThread(taskId).messages.filter((message) => message.metadata?.taskSend);
      const existing = messages.find((message) => message.idempotencyKey === `send:${messageKey}`);
      if (existing) { await this.store.persist(); return existing; }
      if (task.cancel || task.tombstone || ['startup_failed', 'unknown'].includes(task.state)) throw fail('task_not_admitting', 'Task cannot admit new work');
      const { service: admissionService } = await this.#binding(task.provider);
      if (['ended', 'interrupted'].includes(admissionService.get(task.attempts.at(-1).sessionId)?.lifecycle)) {
        throw fail('task_not_admitting', 'Task attempt has ended; resume explicitly before sending');
      }
      if (messages.filter((message) => ['queued', 'admitting', 'accepted'].includes(message.metadata.state)).length >= this.mailboxLimit) {
        throw fail('mailbox_full', 'Task mailbox is full', 429);
      }
      if (deliveryMode === 'steer') {
        const { service } = await this.#binding(task.provider);
        const session = service.get(task.attempts.at(-1).sessionId);
        if (!session?.negotiated?.turn?.steer) throw fail('unsupported_capability', 'Provider does not support steering', 400);
        if (!expectedTurnId || session.activeTurnId !== expectedTurnId) throw fail('turn_mismatch', 'Steering requires the expected active turn');
      }
      const { message } = await this.store.createMessage({ threadId: taskId, from: task.parentRef,
        body: blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n'),
        idempotencyKey: `send:${messageKey}`, metadata: { taskSend: true, state: 'queued', blocks: clone(blocks), mode: deliveryMode, expectedTurnId } });
      await this.#reconcile(task);
      return this.store.getMessage(message.id);
    });
  }

  async status(taskId) {
    const task = this.#task(taskId);
    const { service } = await this.#binding(task.provider);
    const attempt = task.attempts.at(-1);
    const session = attempt && service.get(attempt.sessionId);
    const messages = this.store.getThread(taskId).messages.filter((message) => message.metadata?.taskSend);
    const counts = {};
    for (const message of messages) counts[message.metadata.state] = (counts[message.metadata.state] || 0) + 1;
    const oldest = messages.find((message) => message.metadata.state === 'queued');
    return { ...clone(task), threadId: task.taskId, ownerRef: clone(task.owner), currentParentRef: clone(this.#parentRef(task)), sessionId: attempt?.sessionId || null, attemptId: attempt?.attemptId || null,
      providerThreadId: session?.attempts.at(-1)?.protocolSessionId || null,
      turnId: session?.activeTurnId || null, providerTurnId: session?.turns.find((turn) => turn.turnId === session.activeTurnId)?.providerTurnId || null,
      requestedModel: task.spec.model, effectiveModel: session?.negotiated?.effectiveModel || task.startup.evidence?.effectiveModel || null,
      modelEvidence: session?.negotiated?.modelEvidence || task.startup.evidence?.modelEvidence || null, negotiated: session?.negotiated || null,
      sessionLifecycle: session?.lifecycle || null,
      mailbox: { counts, oldestQueuedAt: oldest?.createdAt || null, oldestQueuedAgeMs: oldest ? Math.max(0, this.now() - oldest.createdAt) : 0 },
      result: task.results.at(-1) || null };
  }

  async reconcile(taskId = null) {
    for (const id of taskId ? [taskId] : this.#tasks().map((task) => task.taskId)) {
      let pending = this.reconciliations.get(id);
      if (pending) pending.dirty = true;
      else {
        pending = { dirty: true };
        this.reconciliations.set(id, pending);
        pending.promise = (async () => {
          do {
            pending.dirty = false;
            // Release between passes so handshake/admission commands cannot be
            // buried beneath a stream of redundant observation callbacks.
            await this.#lock(id, () => this.#reconcile(this.#task(id)));
          } while (pending.dirty && !this.closed);
        })().finally(() => this.reconciliations.delete(id));
      }
      await pending.promise;
    }
  }

  async #reconcile(task) {
    const { service } = await this.#binding(task.provider);
    if (task.tombstone) {
      this.#forgetCaches(task);
      for (const attempt of task.attempts) await service.journal.append(attempt.sessionId, {
        type: 'task.released', idempotencyKey: `released:${task.taskId}`, data: { taskId: task.taskId, results: task.results },
      });
      return;
    }
    const active = task.attempts.at(-1);
    const session = active && service.get(active.sessionId);
    if (!session && task.state === 'starting') task.state = 'unknown';
    if (session && ['ended', 'interrupted'].includes(session.lifecycle) && !['startup_failed', 'cancelled', 'completed'].includes(task.state)) task.state = 'unknown';
    if (session && ['starting', 'awaiting_handshake'].includes(task.startup.state) && !task.cancel) {
      const evidence = this.handshakeVerifier ? await this.handshakeVerifier(clone(task), session)
        : task.startup.roomRead && task.startup.roomReply ? {
          authenticated: true, taskId: task.taskId, sessionId: active.sessionId, attemptId: active.attemptId,
          roomRead: task.startup.roomRead, roomReply: task.startup.roomReply, tools: ['room_context', 'room_send'],
          effectiveModel: session.negotiated?.effectiveModel, modelEvidence: session.negotiated?.modelEvidence,
        } : null;
      if (evidence) {
        const valid = evidence.authenticated === true && evidence.sessionId === active.sessionId
          && evidence.attemptId === active.attemptId && evidence.taskId === task.taskId
          && evidence.roomRead?.ok === true && evidence.roomReply?.messageId
          && evidence.tools?.includes('room_context') && evidence.tools?.includes('room_send')
          && evidence.effectiveModel && evidence.modelEvidence?.source && session.negotiated?.protocol?.version;
        const matched = !task.spec.model || evidence.effectiveModel === task.spec.model;
        task.startup = { ...task.startup, state: valid && matched ? 'ready' : 'startup_failed', evidence: clone(evidence),
          ...(!valid || !matched ? { error: { code: matched ? 'handshake_failed' : 'model_mismatch', message: matched ? 'Authenticated tool/model handshake failed' : 'Effective model differs from requested model' } } : {}) };
        task.state = task.startup.state;
      } else if (this.now() >= task.startup.deadline) {
        task.startup.state = 'startup_failed';
        task.startup.error = { code: 'handshake_timeout', message: 'Child did not prove authenticated room read/reply and model identity before deadline' };
        task.state = 'startup_failed';
      }
    }
    for (const attempt of task.attempts) {
      const projected = service.get(attempt.sessionId);
      const work = projected?.turns.filter((item) => !item.idempotencyKey.startsWith('bootstrap:')) || [];
      const turns = work.filter((item) => ['settled', 'cancelled', 'unknown'].includes(item.status));
      const recovered = session?.negotiated?.startup?.reconciliation;
      if (attempt !== active && recovered?.evidence?.settled === true
        && recovered.providerThreadId === projected?.attempts.at(-1)?.protocolSessionId) {
        const previous = work.find((turn) => turn.status === 'unknown' && turn.providerTurnId
          && turn.providerTurnId === recovered.providerTurnId && turn.providerTurnId === recovered.turn?.id);
        if (previous && ['completed', 'failed', 'interrupted'].includes(recovered.turn.status)) turns.push({
          ...previous, status: recovered.turn.status === 'interrupted' ? 'cancelled' : 'settled',
          evidence: recovered.evidence, error: recovered.turn.error || null, recovered,
        });
      }
      if (!work.length && (['ended', 'interrupted'].includes(projected?.lifecycle)
        || (attempt === active && ['startup_failed', 'unknown', 'cancelled'].includes(task.state)))) {
        turns.push({ turnId: null, status: attempt === active ? task.state : 'unknown',
          evidence: { settled: false, accepted: false }, error: task.startup.error || null });
      }
      for (const turn of turns) {
        const resultKey = `result:${task.taskId}:${attempt.attemptId}:${turn.turnId || 'lifecycle'}:${turn.recovered ? 2 : 1}`;
        if (this.publishedResults.has(resultKey) && task.results.some((result) => result.resultKey === resultKey)) continue;
        const outcome = await service.journal.append(attempt.sessionId, { type: 'task.result', idempotencyKey: resultKey,
          data: { taskId: task.taskId, sessionId: attempt.sessionId, attemptId: attempt.attemptId, turnId: turn.turnId,
            state: turn.status === 'settled' ? 'completed' : turn.status, evidence: clone(turn.evidence), error: clone(turn.error),
            ...(turn.recovered ? { resolutionOf: resultKey.replace(/:2$/, ':1'), providerTurnId: turn.providerTurnId, providerThreadId: turn.recovered.providerThreadId } : {}),
            output: turn.recovered ? clone(turn.recovered.turn.items || [])
              : projected?.transcript.filter((entry) => entry.turnId === turn.turnId && entry.type !== 'user.message') || [], resultKey } });
        if (!task.results.some((result) => result.resultKey === resultKey)) task.results.push({ ...outcome.data, seq: outcome.seq, recordedAt: outcome.recordedAt });
        // The journal is the outbox. A failed/closed parent mailbox never loses it.
        try {
          await this.store.createMessage({ threadId: task.parentThreadId || task.taskId,
            from: { kind: task.provider, sessionId: attempt.sessionId }, type: 'result',
            body: JSON.stringify(outcome.data), idempotencyKey: resultKey,
            metadata: { taskResult: true, taskId: task.taskId, resultKey, sessionId: attempt.sessionId, attemptId: attempt.attemptId, seq: outcome.seq } });
          this.publishedResults.add(resultKey);
          delete task.publishError;
        } catch (error) { task.publishError = { message: error.message, code: error.code || 'publish_failed' }; }
      }
    }
    const mailbox = this.store.getThread(task.taskId).messages.filter((message) => message.metadata?.taskSend);
    for (const message of mailbox) {
      const meta = message.metadata;
      if (meta.sessionId) {
        const projected = service.get(meta.sessionId);
        const turn = projected?.turns.find((item) => meta.mode === 'steer'
          ? (meta.receipt?.accepted === true || meta.receipt?.evidence?.accepted === true) && item.turnId === meta.expectedTurnId
          : item.idempotencyKey === message.idempotencyKey);
        if (turn) {
          const state = ['settled', 'cancelled'].includes(turn.status) ? (turn.status === 'settled' ? 'completed' : 'cancelled')
            : turn.status === 'unknown' ? 'unknown' : turn.evidence.accepted ? 'accepted' : 'queued';
          await this.#saveMessage(message.id, { state, turnId: turn.turnId });
        } else if (meta.state === 'admitting') await this.#saveMessage(message.id, { state: 'unknown' });
      }
    }
    if (task.cancel) {
      for (const message of mailbox.filter((item) => item.metadata.state === 'queued' && !item.metadata.sessionId)) {
        await this.#saveMessage(message.id, { state: 'cancelled', cancelledAt: task.cancel.createdAt });
      }
      const turn = session?.turns.find((item) => item.turnId === task.cancel.turnId);
      if (['cancelled', 'settled'].includes(turn?.status) || (!task.cancel.turnId && session && !session.activeTurnId)) task.state = 'cancelled';
      else if (!session || session.lifecycle === 'interrupted' || turn?.status === 'unknown') task.state = 'unknown';
      else task.state = 'cancelling';
    } else if (task.startup.state === 'ready' && !['unknown', 'startup_failed'].includes(task.state)) {
      const result = task.results.filter((item) => item.attemptId === active.attemptId).at(-1);
      task.state = session?.activeTurnId ? 'working' : result?.state || 'ready';
    }
    await this.#save(task);
    if (task.cancel || task.startup.state !== 'ready' || ['unknown', 'startup_failed'].includes(task.state) || !session
      || this.store.getThread(task.taskId).thread.status !== 'open') return;
    for (const message of this.store.getThread(task.taskId).messages.filter((item) => item.metadata?.taskSend && item.metadata.state === 'queued' && !item.metadata.sessionId)) {
      const latest = service.get(active.sessionId);
      if (message.metadata.mode !== 'steer' && latest.lifecycle !== 'ready') continue;
      await this.#saveMessage(message.id, { state: 'admitting', sessionId: active.sessionId, attemptId: active.attemptId });
      try {
        if (message.metadata.mode === 'steer') {
          const receipt = await bounded(service.steer(active.sessionId, { blocks: message.metadata.blocks, expectedTurnId: message.metadata.expectedTurnId, idempotencyKey: message.idempotencyKey, taskAdmission: TASK_ADMISSION }), this.startupTimeoutMs);
          await this.#saveMessage(message.id, { state: receipt?.accepted === true || receipt?.evidence?.accepted === true ? 'accepted' : 'unknown', receipt });
        } else {
          const turn = await service.prompt(active.sessionId, { blocks: message.metadata.blocks, idempotencyKey: message.idempotencyKey, source: 'task', taskAdmission: TASK_ADMISSION });
          await this.#saveMessage(message.id, { state: turn.evidence.accepted ? 'accepted' : 'queued', turnId: turn.turnId });
        }
      } catch (error) {
        await this.#saveMessage(message.id, { state: 'unknown', error: { code: error.code || 'outcome_unknown', message: error.message } });
      }
    }
  }

  async wait(taskIds, after = null, timeout = 0, { consumerTaskId = null, consumerId = null } = {}) {
    if (!Array.isArray(taskIds) || !taskIds.length || taskIds.length > 100) throw fail('invalid_task_input', 'wait requires 1..100 task IDs', 400);
    taskIds = [...new Set(taskIds)];
    const supplied = decodeCursor(after);
    const tasks = taskIds.map((id) => this.#task(id));
    if (consumerId && tasks.some((task) => ![this.#parentRef(task), task.owner].some((ref) => `${ref.kind}:${ref.sessionId}` === consumerId))) {
      throw fail('task_scope_denied', 'Only the authenticated parent or owner can consume task outcomes', 403);
    }
    const parentId = consumerTaskId || (tasks.every((task) => task.parentTaskId === tasks[0].parentTaskId) ? tasks[0].parentTaskId : null);
    if (parentId && tasks.some((task) => task.parentTaskId !== parentId)) throw fail('task_scope_denied', 'Consumer is not the parent of every task', 403);
    const parent = parentId ? this.#task(parentId) : null;
    const cursor = { ...parent?.consumed, ...supplied };
    const allowed = new Set(tasks.flatMap((task) => task.attempts.map((attempt) => keyOf(task.taskId, attempt))));
    for (const key of Object.keys(cursor)) if (!allowed.has(key)) delete cursor[key];
    for (const key of Object.keys(supplied)) if (!allowed.has(key)) throw fail('invalid_cursor', 'Cursor refers to another task or attempt', 400);
    for (const task of tasks) {
      const { service } = await this.#binding(task.provider);
      for (const attempt of task.attempts) {
        const key = keyOf(task.taskId, attempt);
        if (!parentId && supplied[key] == null) cursor[key] = task.consumed[key] || 0;
        if (supplied[key] != null) {
          const last = await service.journal.rebuild(attempt.sessionId, (_, event) => event.seq, 0);
          if (supplied[key] > last) throw fail('invalid_cursor', 'Cursor is ahead of the durable journal', 400);
        }
      }
    }
    const deadline = Date.now() + Math.max(0, Math.min(60_000, Number(timeout) || 0));
    // Only a supplied cursor acknowledges data. Persist before polling; a
    // timeout never acknowledges the newly returned page or an unstarted lock.
    const acknowledgementDeadline = Number(timeout) > 0 ? deadline : Date.now() + ACK_PROCESSING_TIMEOUT_MS;
    let acknowledgementExpired = false;
    const acknowledge = async (id, entries) => {
      if (!entries.length) return;
      if (Date.now() >= acknowledgementDeadline) throw fail('task_wait_timeout', 'Task acknowledgment processing deadline expired');
      const operation = this.#lock(id, async () => {
        if (acknowledgementExpired) return;
        if (Date.now() >= acknowledgementDeadline) throw fail('task_wait_timeout', 'Task acknowledgment expired while queued');
        const current = this.#task(id);
        for (const [key, seq] of entries) current.consumed[key] = Math.max(current.consumed[key] || 0, seq);
        await this.#save(current);
      });
      try {
        await bounded(operation, Math.max(0, acknowledgementDeadline - Date.now()));
      } catch (error) {
        acknowledgementExpired = true;
        if (error.code === 'outcome_unknown') throw fail('task_wait_timeout', 'Task acknowledgment persistence was not confirmed before the wait deadline');
        throw error;
      }
    };
    if (parentId) await acknowledge(parentId, Object.entries(supplied));
    else for (const task of tasks) await acknowledge(task.taskId, task.attempts.flatMap((attempt) => {
      const key = keyOf(task.taskId, attempt);
      return supplied[key] == null ? [] : [[key, supplied[key]]];
    }));
    let events = [];
    // Reconciliation is a wakeup, not the wait's completion dependency. A busy
    // task mutex or slow publication must not hide already durable journal data.
    const wakeups = taskIds.map((id) => this.reconcile(id).catch((error) => this.logger?.warn?.({ err: error.message }, 'Task reconciliation failed')));
    if (!(Number(timeout) > 0)) {
      let timer;
      try {
        await Promise.race([
          Promise.all(wakeups),
          new Promise((resolve) => {
            timer = setTimeout(resolve, ACK_PROCESSING_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    do {
      events = [];
      for (const task of taskIds.map((id) => this.#task(id))) {
        const { service } = await this.#binding(task.provider);
        for (const attempt of task.attempts) {
          const key = keyOf(task.taskId, attempt);
          const page = await service.cursor(attempt.sessionId, { after: cursor[key] || 0, limit: 10_000 });
          events.push(...page.events.map((event) => ({ ...event, taskId: task.taskId, attemptId: attempt.attemptId })));
          cursor[key] = page.cursor;
        }
      }
      if (events.length || Date.now() >= deadline) break;
      await new Promise((done) => setTimeout(done, Math.min(25, deadline - Date.now())));
    } while (!this.closed);
    // Full provider method/tool inventory remains available through status().
    const states = (await Promise.all(taskIds.map((id) => this.status(id)))).map(({ negotiated, ...state }) => state);
    return { events, results: events.filter((event) => event.type === 'task.result'), states,
      cursor: Buffer.from(JSON.stringify({ v: 1, cursors: cursor })).toString('base64url'), timedOut: !events.length && Date.now() >= deadline };
  }

  async cancel(taskId, requestKey, scope = 'task') {
    requestKey = required(requestKey, 'requestKey');
    if (scope === 'child') scope = 'task';
    if (!['task', 'descendants'].includes(scope)) throw fail('invalid_scope', 'Cancellation scope must be task or descendants', 400);
    await this.#lock(taskId, async () => {
      const task = this.#task(taskId);
      const key = `cancel:${requestKey}`;
      if (task.requests[key] && task.requests[key].scope !== scope) throw fail('idempotency_conflict', 'Cancellation key was already used with another scope');
      task.requests[key] ||= { scope, createdAt: this.now() };
      await this.#save(task);
      if (task.cancel || task.tombstone) return;
      const { service } = await this.#binding(task.provider);
      const active = task.attempts.at(-1);
      const session = service.get(active.sessionId);
      task.cancel = { requestKey, scope, createdAt: this.now(), turnId: session?.activeTurnId || null };
      task.state = 'cancelling';
      await this.#save(task); // Admission fence is durable before provider interrupt.
      try {
        task.cancel.receipt = await bounded(service.cancel(active.sessionId), this.startupTimeoutMs);
      } catch (error) { task.cancel.error = { code: error.code || 'outcome_unknown', message: error.message }; }
      await this.#save(task);
      await this.#reconcile(task);
    });
    if (scope === 'descendants') for (const child of this.#tasks().filter((task) => task.parentTaskId === taskId)) {
      await this.cancel(child.taskId, `${requestKey}:${child.taskId}`, 'descendants');
    }
    return this.status(taskId);
  }

  async resume(taskId, requestKey) {
    requestKey = required(requestKey, 'requestKey');
    return this.#lock(taskId, async () => {
      const task = this.#task(taskId);
      if (task.requests[`resume:${requestKey}`]) return this.status(taskId);
      if (task.cancel || task.tombstone) throw fail('task_cancelled', 'Cancelled tasks require a new explicit task intent');
      const binding = await this.#binding(task.provider);
      const previous = binding.service.get(task.attempts.at(-1)?.sessionId);
      if (previous && !['ended', 'interrupted'].includes(previous.lifecycle)) throw fail('task_active', 'The current attempt is still active');
      // Reap a runtime that did not exit earlier; attaching beside it would run the conversation twice.
      if (previous && !(await binding.service.terminate(previous.id)).ok) throw fail('terminate_failed', 'Previous task runtime did not exit');
      task.requests[`resume:${requestKey}`] = { createdAt: this.now() };
      await this.#save(task);
      // Attach to the latest conversation proven to exist; otherwise start fresh.
      const resumeFrom = task.attempts.map((attempt) => resumableProtocolSessionId(binding.service.get(attempt.sessionId))).findLast(Boolean);
      await this.#start(task, binding, resumeFrom || null);
      await this.#reconcile(task);
      return this.status(taskId);
    });
  }

  async release(taskId) {
    return this.#lock(taskId, async () => {
      const task = this.#task(taskId);
      if (task.tombstone) { await this.#reconcile(task); return true; }
      if (!TERMINAL.has(task.state) || this.#tasks().some((child) => child.parentTaskId === taskId && !child.tombstone)) throw fail('task_retained', 'Task or descendants are unresolved');
      const consumed = task.parentTaskId ? this.#task(task.parentTaskId).consumed : task.consumed;
      if (!task.results.length || task.results.some((result) => (consumed[keyOf(taskId, result)] || 0) < result.seq
        || this.now() < result.recordedAt + this.retentionMs)) throw fail('task_retained', 'Parent has not consumed retained outcomes');
      const { service } = await this.#binding(task.provider);
      for (const attempt of task.attempts) {
        const session = service.get(attempt.sessionId);
        if (session && !['ended', 'interrupted'].includes(session.lifecycle)) throw fail('task_retained', 'Provider session is still active');
      }
      task.tombstone = true;
      task.results = task.results.map(({ output, ...result }) => result);
      delete task.spec.skills;
      await this.#save(task);
      for (const attempt of task.attempts) await service.journal.append(attempt.sessionId, {
        type: 'task.released', idempotencyKey: `released:${taskId}`, data: { taskId, results: task.results },
      });
      return true;
    });
  }

  async close() {
    this.closed = true;
    for (const timer of this.deadlines.values()) clearTimeout(timer);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    await Promise.all([...this.locks.values()]);
    await Promise.allSettled([...this.reconciliations.values()].map((entry) => entry.promise));
    this.savedMetadata.clear();
    this.publishedResults.clear();
  }
}
