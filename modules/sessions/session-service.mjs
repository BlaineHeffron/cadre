import { randomUUID } from 'node:crypto';
import { assertAgentTransport } from '../agent/agent-transport.mjs';
import {
  assertPromptBlocksSupported,
  negotiatePromptCapabilities,
  normalizePromptCapabilities,
} from '../agent/prompt-blocks.mjs';
import { incrementOpsCounter, recordOpsTiming } from '../ops/observability.mjs';
import { canonicalSessionStateId } from '../session-state/contract.mjs';
import { sessionStateTracker } from '../session-state/tracker.mjs';
import { recordSessionDeliveryAudit } from './delivery-audit.mjs';
import { assertSessionDeletable } from './journal-store.mjs';

const ACTIVE_TURNS = new Set(['queued', 'admitted', 'inflight']);
const UNSETTLED_INTERACTIONS = new Set(['open', 'answer_timeout']);
// Not representable by an HTTP/MCP caller's source string or JSON body.
export const TASK_ADMISSION = Symbol('task admission');
const TRANSITIONS = Object.freeze({
  created: new Set(['starting', 'interrupted']),
  starting: new Set(['ready', 'ended', 'interrupted']),
  ready: new Set(['working', 'ended', 'interrupted']),
  working: new Set(['blocked', 'cancelling', 'ready', 'ended', 'interrupted']),
  blocked: new Set(['working', 'cancelling', 'ended', 'interrupted']),
  cancelling: new Set(['ready', 'ended', 'interrupted']),
  interrupted: new Set(['starting']),
  ended: new Set([]),
});

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function text(value) {
  return String(value || '').trim();
}

function transportErrorKind(value) {
  const normalized = text(value).toLowerCase();
  const allowed = new Set([
    'transport_eof', 'transport_closed', 'transport_read_error', 'transport_write_error',
    'transport_not_writable', 'frame_no_newline', 'frame_oversize', 'malformed_frame',
    'request_timeout', 'enoent', 'iterator_failed', 'connection_closed',
  ]);
  return allowed.has(normalized) ? normalized : 'other';
}

function newSession({ sessionId, provider, displayName, workDir, permissionMode, model, mcpCapabilities, createdAt, taskId = null }) {
  return {
    id: sessionId,
    taskId,
    provider,
    displayName,
    workDir,
    permissionMode,
    model,
    mcpCapabilities: clone(mcpCapabilities) || null,
    createdAt,
    updatedAt: createdAt,
    lifecycle: 'created',
    detail: 'Created',
    generation: 0,
    attempts: [],
    turns: [],
    interactions: [],
    transcript: [],
    diagnostics: [],
    activeAttemptId: null,
    activeTurnId: null,
    negotiated: null,
    nonResumable: false,
    endedWithHistory: false,
    revision: 0,
    _appliedEventIds: new Set(),
    transport: null,
    consumePromise: null,
  };
}

function publicSession(session) {
  const {
    transport: _transport,
    consumePromise: _consumePromise,
    _appliedEventIds: _appliedEventIds,
    ...value
  } = session;
  return clone(value);
}

// A provider conversation is proven to exist once a turn settled on an attempt bound to it; only then attach.
export function resumableProtocolSessionId(session) {
  if (session?.negotiated?.sessionOps?.resume !== 'supported') return null;
  const proven = new Set(session.turns.filter((turn) => turn.status === 'settled')
    .map((turn) => session.attempts.find((attempt) => attempt.generation === turn.generation)?.protocolSessionId));
  return session.attempts.findLast((attempt) => attempt.protocolSessionId && proven.has(attempt.protocolSessionId))?.protocolSessionId || null;
}

function applyInterruptedProjection(session, event, {
  attemptId = session.activeAttemptId,
  reason = 'transport_error',
  detail = 'Structured attempt was interrupted',
  turnMessage = 'Transport ended with an uncertain in-flight turn',
} = {}) {
  session.lifecycle = 'interrupted';
  session.detail = detail;
  session.nonResumable = true;
  session.endedWithHistory = true;
  session.activeAttemptId = null;
  session.activeTurnId = null;
  const attempt = session.attempts.find((item) => item.attemptId === attemptId);
  if (attempt && !attempt.endedAt) {
    attempt.endedAt = event.recordedAt;
    attempt.endReason = reason;
  }
  for (const turn of session.turns) {
    if (!ACTIVE_TURNS.has(turn.status)) continue;
    turn.status = 'unknown';
    turn.error = { code: 'outcome_unknown', message: turnMessage };
    turn.evidence = { ...turn.evidence, settled: false, quiescent: false };
  }
}

function reduceSessionEvent(session, event) {
  const data = event.data || {};
  if (event.type === 'session.created') {
    const created = newSession({
      sessionId: event.sessionId,
      provider: data.provider,
      displayName: data.displayName,
      workDir: data.workDir,
      permissionMode: data.permissionMode,
      model: data.model,
      taskId: data.taskId,
      mcpCapabilities: data.mcpCapabilities,
      createdAt: data.createdAt || event.recordedAt,
    });
    created._appliedEventIds.add(event.eventId);
    return created;
  }
  if (!session) return session;
  if (!(session._appliedEventIds instanceof Set)) session._appliedEventIds = new Set();
  if (session._appliedEventIds.has(event.eventId)) return session;
  session._appliedEventIds.add(event.eventId);
  session.updatedAt = event.recordedAt;
  session.revision += 1;
  if (event.type === 'session.lifecycle') {
    session.lifecycle = data.lifecycle;
    session.detail = data.detail || data.lifecycle;
    // Starting again after an interruption: the dead attempt's prompts can no longer be answered.
    if (data.lifecycle === 'starting') {
      session.nonResumable = false;
      session.endedWithHistory = false;
      for (const interaction of session.interactions) if (UNSETTLED_INTERACTIONS.has(interaction.status)) interaction.status = 'cancelled';
    }
  } else if (event.type === 'attempt.created') {
    session.generation = Math.max(session.generation, data.generation);
    session.activeAttemptId = data.attemptId;
    session.attempts.push({
      attemptId: data.attemptId,
      generation: data.generation,
      runtimeInstanceId: data.runtimeInstanceId,
      protocolSessionId: null,
      negotiated: null,
      startedAt: event.recordedAt,
      endedAt: null,
      endReason: null,
    });
  } else if (event.type === 'attempt.bound') {
    const attempt = session.attempts.find((item) => item.attemptId === data.attemptId);
    if (attempt) {
      attempt.protocolSessionId = data.protocolSessionId || null;
      attempt.negotiated = clone(data.negotiated);
    }
    session.negotiated = clone(data.negotiated);
  } else if (event.type === 'attempt.ended') {
    const attempt = session.attempts.find((item) => item.attemptId === data.attemptId);
    if (attempt) {
      attempt.endedAt = event.recordedAt;
      attempt.endReason = data.reason || 'ended';
    }
    if (session.activeAttemptId === data.attemptId) session.activeAttemptId = null;
  } else if (event.type === 'turn.created') {
    session.turns.push({
      turnId: data.turnId,
      idempotencyKey: data.idempotencyKey,
      generation: data.generation,
      status: 'queued',
      blocks: clone(data.blocks || []),
      evidence: { accepted: false, settled: false, quiescent: false },
      createdAt: event.recordedAt,
      settledAt: null,
      stopReason: null,
      error: null,
      cancelRequested: false,
    });
    session.activeTurnId = data.turnId;
  } else if (event.type === 'turn.updated') {
    const turn = session.turns.find((item) => item.turnId === data.turnId);
    if (turn) Object.assign(turn, clone(data.patch || {}));
    if (turn && !ACTIVE_TURNS.has(turn.status)) session.activeTurnId = null;
  } else if (event.type === 'interaction.opened') {
    session.interactions.push(clone(data.interaction));
  } else if (event.type === 'interaction.updated') {
    const interaction = session.interactions.find((item) => item.interactionId === data.interactionId);
    if (interaction) Object.assign(interaction, clone(data.patch || {}));
  } else if (event.type === 'transcript.appended') {
    session.transcript.push(clone(data.entry));
  } else if (event.type === 'diagnostic.appended') {
    session.diagnostics.push(clone(data.entry));
  } else if (event.type === 'transport.event' && data.disposition === 'applied') {
    const transportEvent = data.event || {};
    const turn = transportEvent.turnId
      ? session.turns.find((item) => item.turnId === transportEvent.turnId)
      : null;
    if (transportEvent.type === 'turn.started' && turn) {
      turn.providerTurnId = transportEvent.providerTurnId || turn.providerTurnId || null;
      if (transportEvent.phase === 'admitted') turn.status = 'admitted';
      else if (transportEvent.phase === 'inflight' || !transportEvent.phase) turn.status = 'inflight';
      turn.evidence = {
        ...turn.evidence,
        accepted: turn.evidence.accepted || transportEvent.evidence?.accepted === true,
      };
    } else if (transportEvent.type === 'turn.settled' && turn) {
      const provenSettled = transportEvent.evidence?.settled === true;
      turn.status = !provenSettled ? 'unknown' : turn.cancelRequested ? 'cancelled' : 'settled';
      turn.stopReason = transportEvent.stopReason || null;
      turn.error = clone(transportEvent.error || null);
      turn.settledAt = event.recordedAt;
      turn.evidence = clone(transportEvent.evidence || { accepted: false, settled: false, quiescent: false });
      session.activeTurnId = null;
      if (!provenSettled) {
        applyInterruptedProjection(session, event, {
          reason: transportEvent.error?.code || 'transport_error',
          detail: transportEvent.error?.message || 'Transport ended with an uncertain turn outcome',
        });
      } else if (!['ended', 'interrupted'].includes(session.lifecycle)) {
        session.lifecycle = 'ready';
        session.detail = transportEvent.stopReason || transportEvent.error?.message || 'Ready for input';
      }
    } else if (transportEvent.type === 'message.delta') {
      session.transcript.push({
        type: 'message.delta', turnId: transportEvent.turnId, delta: clone(transportEvent.delta),
        eventId: transportEvent.eventId, observedAt: transportEvent.observedAt,
      });
    } else if (transportEvent.type === 'message.committed') {
      session.transcript.push({
        type: 'message.committed', turnId: transportEvent.turnId, blocks: clone(transportEvent.blocks),
        eventId: transportEvent.eventId, observedAt: transportEvent.observedAt,
      });
    } else if (transportEvent.type === 'interaction.requested') {
      session.interactions.push({
        interactionId: transportEvent.interactionId,
        generation: data.generation,
        turnId: transportEvent.turnId,
        kind: transportEvent.kind || 'permission',
        options: clone(transportEvent.options || []),
        toolCall: clone(transportEvent.toolCall || {}),
        status: 'open', answer: null, actor: null, policy: null, openedAt: event.recordedAt,
      });
      session.lifecycle = 'blocked';
      session.detail = transportEvent.toolCall?.title || 'Permission required';
    } else if (transportEvent.type === 'interaction.answered') {
      const interaction = session.interactions.find((item) => item.interactionId === transportEvent.interactionId);
      if (UNSETTLED_INTERACTIONS.has(interaction?.status)) {
        interaction.status = 'answered';
        interaction.answer = transportEvent.optionId ? { optionId: transportEvent.optionId } : { text: transportEvent.text || '' };
        interaction.answeredAt = event.recordedAt;
      }
      if (session.lifecycle === 'blocked') session.lifecycle = session.activeTurnId ? 'working' : 'ready';
    } else if (transportEvent.type === 'interaction.cancelled') {
      const interaction = session.interactions.find((item) => item.interactionId === transportEvent.interactionId);
      if (UNSETTLED_INTERACTIONS.has(interaction?.status)) {
        interaction.status = 'cancelled';
        interaction.answeredAt = event.recordedAt;
      }
    } else if (transportEvent.type === 'diagnostic' || transportEvent.type === 'transport.error') {
      if (transportEvent.kind === 'model_rerouted' && transportEvent.effectiveModel) {
        session.negotiated = { ...session.negotiated, effectiveModel: transportEvent.effectiveModel,
          modelEvidence: clone(transportEvent.modelEvidence) };
      }
      session.diagnostics.push({
        eventId: transportEvent.eventId,
        type: transportEvent.type,
        kind: transportEvent.kind,
        message: transportEvent.message,
        observedAt: transportEvent.observedAt,
      });
    } else if (transportEvent.type === 'attempt.exited' && !['ended', 'interrupted'].includes(session.lifecycle)) {
      applyInterruptedProjection(session, event, {
        reason: 'transport_exit',
        detail: transportEvent.error || (transportEvent.signal ? `Exited on ${transportEvent.signal}` : `Exited with code ${transportEvent.code}`),
      });
    }
  } else if (event.type === 'session.interrupted') {
    applyInterruptedProjection(session, event, {
      attemptId: data.attemptId,
      reason: data.reason || 'fleet_restart',
      detail: data.detail || 'Fleet restarted while the structured attempt was active',
      turnMessage: data.reason === 'fleet_restart'
        ? 'Fleet restarted with an uncertain in-flight turn'
        : 'Transport ended with an uncertain in-flight turn',
    });
  }
  return session;
}

export class SessionService {
  constructor({
    journal,
    transportFactory,
    deliveryAuditStore = null,
    attachmentStore = null,
    promptPolicy = null,
    provider = 'deepseek',
    now = () => Date.now(),
    stateTracker = sessionStateTracker,
    contentLimit = 2 * 1024 * 1024,
    diagnosticLimit = 256 * 1024,
    logger = null,
    answerTimeoutMs = 15_000,
  } = {}) {
    if (!journal) throw new TypeError('journal is required');
    if (typeof transportFactory !== 'function') throw new TypeError('transportFactory is required');
    this.journal = journal;
    this.transportFactory = transportFactory;
    this.deliveryAuditStore = deliveryAuditStore;
    this.attachmentStore = attachmentStore;
    this.promptPolicy = promptPolicy;
    this.provider = provider;
    this.now = now;
    this.stateTracker = stateTracker;
    this.contentLimit = contentLimit;
    this.diagnosticLimit = diagnosticLimit;
    this.logger = logger;
    this.answerTimeoutMs = answerTimeoutMs;
    this.sessions = new Map();
    this.listeners = new Set();
    this.commandLocks = new Map();
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this;
    await this.attachmentStore?.init?.();
    await this.journal.init();
    for (const sessionId of await this.journal.listSessionIds()) {
      const restored = await this.journal.rebuild(sessionId, reduceSessionEvent, null);
      if (!restored) continue;
      restored.taskId ||= await this.journal.rebuild(sessionId, (value, event) => event.type === 'task.linked' ? event.data.taskId : value, null);
      this.sessions.set(sessionId, restored);
      this.#observeProtocol(restored);
      if (!['ended', 'interrupted'].includes(restored.lifecycle)) {
        const activeAttemptId = restored.activeAttemptId;
        await this.#append(restored, 'session.interrupted', {
          attemptId: activeAttemptId,
          reason: 'fleet_restart',
          detail: 'Fleet restarted; attempt ended with preserved history',
        });
      }
    }
    this.initialized = true;
    return this;
  }

  list({ includeEnded = true } = {}) {
    return [...this.sessions.values()]
      .filter((session) => includeEnded || !['ended', 'interrupted'].includes(session.lifecycle))
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((session) => this.#public(session));
  }

  get(sessionId) {
    const session = this.sessions.get(String(sessionId || ''));
    return session ? this.#public(session) : null;
  }

  async start(spec = {}) {
    await this.init();
    const sessionId = text(spec.sessionId) || randomUUID();
    if (this.sessions.has(sessionId)) throw new Error(`Session already exists: ${sessionId}`);
    const permissionMode = text(spec.permissionMode);
    if (!permissionMode) throw new TypeError('permissionMode must be resolved by Fleet before session start');
    const createdAt = this.now();
    const session = newSession({
      sessionId,
      provider: text(spec.provider) || this.provider,
      displayName: text(spec.displayName),
      workDir: text(spec.workDir),
      permissionMode,
      model: text(spec.model),
      taskId: spec.metadata?.taskId || null,
      mcpCapabilities: spec.mcpCapabilities,
      createdAt,
    });
    this.sessions.set(sessionId, session);
    await this.#append(session, 'session.created', {
      provider: session.provider,
      displayName: session.displayName,
      workDir: session.workDir,
      permissionMode,
      model: session.model,
      taskId: session.taskId,
      mcpCapabilities: session.mcpCapabilities,
      createdAt,
    }, { idempotencyKey: `session:${sessionId}:created` });
    await this.#transition(session, 'starting', 'Starting structured attempt');
    return this.#launch(session, spec);
  }

  // An interrupted session resumes as a new attempt attached to its proven provider conversation.
  // prepare/cleanup run under the session lock so a concurrent resume cannot race credential issuance.
  resume(sessionId, { prepare = () => ({}), cleanup = () => {} } = {}) {
    return this.#withCommandLock(String(sessionId || ''), async () => {
      const session = this.sessions.get(String(sessionId || ''));
      if (session?.taskId) throw Object.assign(new Error('Task-owned sessions resume through task_resume'), { code: 'task_managed', statusCode: 409 });
      const resumeFrom = session?.lifecycle === 'interrupted' && resumableProtocolSessionId(session);
      if (!resumeFrom) {
        throw Object.assign(new Error(`Session is ${session?.lifecycle || 'missing'} and cannot be resumed`), {
          code: 'session_not_resumable', statusCode: session ? 409 : 404,
        });
      }
      try {
        const spec = await prepare(this.#public(session));
        await this.#transition(session, 'starting', 'Resuming structured attempt');
        // Reap a runtime left by an earlier failed attempt or terminate; its exit is stale while starting.
        if (session.transport && !(await session.transport.terminate({ grace: 500 })).ok) {
          await this.#append(session, 'session.interrupted', { reason: 'resume_failed', detail: 'Previous structured runtime did not exit' });
          throw Object.assign(new Error('Previous structured runtime did not exit'), { code: 'terminate_failed', statusCode: 409 });
        }
        await session.consumePromise;
        return await this.#launch(session, { model: session.model, ...spec, resumeFrom });
      } catch (error) {
        await cleanup(error);
        throw error;
      }
    });
  }

  async #launch(session, spec) {
    const { id: sessionId, permissionMode } = session;
    const generation = session.generation + 1;
    const attemptId = text(spec.attemptId) || randomUUID();
    const runtimeInstanceId = text(spec.runtimeInstanceId) || attemptId;
    await this.#append(session, 'attempt.created', { attemptId, runtimeInstanceId, generation });
    const startedAt = this.now();
    try {
      const transport = assertAgentTransport(this.transportFactory({ ...spec, sessionId, attemptId, generation, permissionMode }));
      session.transport = transport;
      session.consumePromise = this.#consumeTransport(session, transport, { attemptId, generation });
      const started = await transport[spec.resumeFrom ? 'attach' : 'start']({
        ...spec,
        ...(spec.resumeFrom ? { protocolSessionId: spec.resumeFrom } : {}),
        permissionMode,
        attemptId,
        instanceId: runtimeInstanceId,
        cwd: session.workDir,
        metadata: { sessionId, generation, permissionMode, ...(spec.metadata || {}) },
      });
      if (session.generation !== generation || session.lifecycle !== 'starting') {
        throw Object.assign(new Error('Startup was fenced by session termination'), { code: 'startup_fenced' });
      }
      const transportPromptCapabilities = started.negotiated?.promptCapabilities
        || started.negotiated?.attachments
        || { types: ['text', 'resource_link'] };
      const fleetPromptPolicy = this.promptPolicy
        || this.attachmentStore?.capabilities?.()
        || normalizePromptCapabilities({ types: ['text', 'resource_link'] });
      const promptCapabilities = negotiatePromptCapabilities(transportPromptCapabilities, fleetPromptPolicy);
      const negotiated = {
        ...clone(started.negotiated || {}),
        promptCapabilities,
        attachments: promptCapabilities,
      };
      await this.#append(session, 'attempt.bound', {
        attemptId,
        protocolSessionId: started.protocolSessionId,
        negotiated,
      });
      await this.#transition(session, 'ready', 'Ready for input');
      incrementOpsCounter('attempt_start', 1, { transport: 'acp', provider: session.provider, outcome: 'success' });
      recordOpsTiming('start_latency', this.now() - startedAt, { transport: 'acp', provider: session.provider, outcome: 'success' });
      this.#log('info', 'Structured attempt started', { sessionId, attemptId });
      return this.#public(session);
    } catch (error) {
      incrementOpsCounter('attempt_start', 1, { transport: 'acp', provider: session.provider, outcome: 'failed' });
      recordOpsTiming('start_latency', this.now() - startedAt, { transport: 'acp', provider: session.provider, outcome: 'failed' });
      this.#log('error', 'Structured attempt start failed', { sessionId, attemptId, error: error?.message });
      await this.#append(session, 'attempt.ended', { attemptId, reason: error?.code || 'start_failed' });
      // A failed resume leaves the provider session intact, so it stays resumable.
      if (session.lifecycle === 'starting' && session.attempts.some((attempt) => attempt.protocolSessionId)) {
        await this.#append(session, 'session.interrupted', { attemptId, reason: 'resume_failed', detail: error?.message || 'Resume failed' });
      } else if (!['ended', 'interrupted'].includes(session.lifecycle)) await this.#transition(session, 'ended', error?.message || 'Structured attempt failed to start');
      throw error;
    }
  }

  async prompt(sessionId, { blocks, idempotencyKey = randomUUID(), source = 'api', taskAdmission = null } = {}) {
    return this.#withCommandLock(String(sessionId || ''), () => this.#promptUnlocked(sessionId, { blocks, idempotencyKey, source, taskAdmission }));
  }

  async #promptUnlocked(sessionId, { blocks, idempotencyKey, source, taskAdmission }) {
    const session = this.#requireActive(sessionId);
    if (session.taskId && taskAdmission !== TASK_ADMISSION) throw Object.assign(new Error('Task-owned sessions require durable task admission'), { code: 'task_managed', statusCode: 409 });
    const existing = session.turns.find((turn) => turn.idempotencyKey === String(idempotencyKey));
    if (existing) return clone(existing);
    if (session.lifecycle !== 'ready') {
      const error = new Error(`Session is ${session.lifecycle}; wait until it is ready`);
      error.code = 'session_not_ready';
      error.statusCode = 409;
      throw error;
    }
    const promptCapabilities = assertPromptBlocksSupported(
      blocks,
      session.negotiated?.promptCapabilities || session.negotiated?.attachments,
    );
    const hasBinaryBlocks = (blocks || []).some((block) => !['text', 'resource_link'].includes(block?.type));
    if (hasBinaryBlocks && !this.attachmentStore) {
      const error = new Error('Typed binary prompts require the Fleet AttachmentStore');
      error.code = 'unsupported_capability';
      error.capability = 'attachment_store';
      error.statusCode = 400;
      throw error;
    }
    const durableBlocks = hasBinaryBlocks
      ? await this.attachmentStore.ingestTurn(session.id, blocks, promptCapabilities)
      : clone(blocks);
    const transportBlocks = hasBinaryBlocks
      ? await this.attachmentStore.hydrateBlocks(session.id, durableBlocks)
      : clone(blocks);
    const turnId = randomUUID();
    const generation = session.generation;
    await this.#append(session, 'turn.created', {
      turnId, idempotencyKey: String(idempotencyKey), generation, blocks: durableBlocks,
    }, { idempotencyKey: `turn:${idempotencyKey}` });
    await this.#appendTranscript(session, {
      type: 'user.message', turnId, blocks: durableBlocks, observedAt: this.now(),
    });
    await this.#transition(session, 'working', 'Structured agent is working');
    this.#log('info', 'Structured prompt admitted locally', { sessionId: session.id, attemptId: session.activeAttemptId, turnId });
    const promptText = (durableBlocks || []).filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
    await recordSessionDeliveryAudit(this.deliveryAuditStore, {
      source,
      kind: session.provider,
      sessionId: session.id,
      text: promptText,
      enter: true,
      status: 'sent',
      metadata: { transactionId: turnId, attemptId: session.activeAttemptId, operation: 'prompt' },
    });
    const startedAt = this.now();
    session.transport.prompt({ turnId, blocks: transportBlocks, idempotencyKey: String(idempotencyKey) })
      .then(async (settlement) => {
        recordOpsTiming('prompt_settle_latency', this.now() - startedAt, { transport: 'acp', provider: session.provider, outcome: settlement?.error ? 'failed' : 'settled' });
        const current = this.sessions.get(session.id);
        if (!current || current.generation !== generation) return;
        const turn = current.turns.find((item) => item.turnId === turnId);
        if (!turn || !ACTIVE_TURNS.has(turn.status)) return;
        if (settlement?.evidence?.settled === true || settlement?.stopReason) return;
        await this.#append(current, 'turn.updated', {
          turnId,
          patch: {
            status: 'unknown',
            error: { code: settlement?.error?.code || 'outcome_unknown', message: settlement?.error?.message || 'Prompt resolved without settlement evidence' },
            settledAt: this.now(),
            evidence: { ...turn.evidence, settled: false, quiescent: false },
          },
        });
        await this.#append(current, 'session.interrupted', {
          attemptId: current.activeAttemptId,
          reason: 'outcome_unknown',
          detail: 'Prompt resolved without settlement evidence',
        });
      })
      .catch(async (error) => {
        recordOpsTiming('prompt_settle_latency', this.now() - startedAt, { transport: 'acp', provider: session.provider, outcome: 'failed' });
        // Like successful settlements, a provider failure receipt is reduced by
        // its queued turn.settled event. Do not race that event with interruption.
        if (error?.evidence?.settled === true) return;
        const current = this.sessions.get(session.id);
        if (!current || current.generation !== generation) return;
        const turn = current.turns.find((item) => item.turnId === turnId);
        if (turn && ACTIVE_TURNS.has(turn.status)) {
          // A rejected transport promise is not a provider rejection receipt.
          await this.#append(current, 'turn.updated', {
            turnId,
            patch: {
              status: 'unknown',
              error: { code: error?.code || 'transport_error', message: error?.message || String(error) },
              settledAt: this.now(),
              evidence: { ...turn.evidence, settled: false, quiescent: false },
            },
          });
          await this.#append(current, 'session.interrupted', {
            attemptId: current.activeAttemptId,
            reason: 'transport_error',
            detail: error?.message || 'Transport ended during prompt',
          });
        }
      });
    return clone(session.turns.find((turn) => turn.turnId === turnId));
  }

  async cancel(sessionId, { turnId = null } = {}) {
    const session = this.#requireActive(sessionId);
    const active = session.turns.find((turn) => turn.turnId === (turnId || session.activeTurnId));
    if (!active) return { mode: 'best_effort' };
    await this.#append(session, 'turn.updated', { turnId: active.turnId, patch: { cancelRequested: true } });
    await this.#transition(session, 'cancelling', 'Cancellation requested');
    for (const interaction of session.interactions.filter((item) => item.status === 'open')) {
      await session.transport.cancelInteraction?.(interaction.interactionId).catch(() => {});
    }
    const result = await session.transport.cancel({ turnId: active.turnId });
    incrementOpsCounter('cancel_mode', 1, { transport: 'acp', provider: session.provider, outcome: result.mode });
    this.#log('info', 'Structured turn cancellation requested', { sessionId: session.id, attemptId: session.activeAttemptId, turnId: active.turnId, mode: result.mode });
    return result;
  }

  async steer(sessionId, { blocks, expectedTurnId, idempotencyKey, taskAdmission = null } = {}) {
    return this.#withCommandLock(String(sessionId || ''), async () => {
      const session = this.#requireActive(sessionId);
      if (session.taskId && taskAdmission !== TASK_ADMISSION) throw Object.assign(new Error('Task-owned sessions require durable task admission'), { code: 'task_managed', statusCode: 409 });
      const key = `steer:${text(idempotencyKey)}`;
      if (!text(idempotencyKey)) throw new TypeError('idempotencyKey is required');
      const prior = await this.journal.rebuild(session.id, (value, event) =>
        event.idempotencyKey === key || event.idempotencyKey === `${key}:receipt` ? event : value, null);
      if (prior) return prior.data.receipt || { status: 'unknown', expectedTurnId };
      if (!session.negotiated?.turn?.steer || typeof session.transport?.steer !== 'function') {
        throw Object.assign(new Error('Provider does not support steering'), { code: 'unsupported_capability', statusCode: 400 });
      }
      if (!expectedTurnId || session.activeTurnId !== expectedTurnId || session.lifecycle !== 'working') {
        throw Object.assign(new Error('Steering requires the expected active turn'), { code: 'turn_mismatch', statusCode: 409 });
      }
      assertPromptBlocksSupported(blocks, session.negotiated.promptCapabilities);
      await this.#append(session, 'turn.steer', { expectedTurnId, blocks }, { idempotencyKey: key });
      let receipt;
      try {
        const turn = session.turns.find((item) => item.turnId === expectedTurnId);
        receipt = await session.transport.steer({ turnId: expectedTurnId, expectedTurnId: turn.providerTurnId || expectedTurnId, blocks, idempotencyKey });
      } catch (error) {
        receipt = { status: 'unknown', error: { code: error.code || 'outcome_unknown', message: error.message } };
      }
      await this.#append(session, 'turn.steer.receipt', { expectedTurnId, receipt }, { idempotencyKey: `${key}:receipt` });
      return receipt;
    });
  }

  // Authority audits and answers share the per-session command lock so concurrent
  // answers cannot both reach the provider or overwrite each other's audit patch.
  recordInteractionAuthority(sessionId, input) {
    return this.#withCommandLock(String(sessionId || ''), () => this.#recordInteractionAuthority(sessionId, input));
  }

  async #recordInteractionAuthority(sessionId, { interactionId, authority } = {}) {
    const session = this.#requireActive(sessionId);
    const interaction = session.interactions.find((item) => item.interactionId === String(interactionId));
    if (!interaction || interaction.status !== 'open') {
      const error = new Error('Interaction is missing or already answered');
      error.code = 'interaction_not_open';
      error.statusCode = 409;
      throw error;
    }
    const audit = {
      actor: text(authority?.actor) || 'unknown',
      principalType: text(authority?.principalType) || 'unknown',
      policy: text(authority?.policy) || 'none',
      tool: text(authority?.tool) || interaction.toolCall?.title || 'unknown',
      scope: text(authority?.scope) || 'permission.approve',
      risk: text(authority?.risk) || 'provider_tool_execution',
      decision: authority?.decision === 'allowed' && text(authority?.principalType) !== 'agent'
        ? 'allowed'
        : 'denied',
      attemptId: session.activeAttemptId,
      turnId: interaction.turnId || null,
      interactionId: interaction.interactionId,
      recordedAt: this.now(),
    };
    await this.#append(session, 'interaction.updated', {
      interactionId,
      patch: { authorityAudit: [...(interaction.authorityAudit || []), audit] },
    });
    return audit;
  }

  // Stale-write guard (same contract as the tmux command gate): a UI answer built
  // against an older canonical snapshot must not land on a newer interaction.
  assertExpectedState(sessionId, { expectedRevision, expectedFingerprint, expectedInteractionKind } = {}) {
    const session = this.#requireActive(sessionId);
    const snapshot = this.stateTracker.get(canonicalSessionStateId(session.provider, session.id));
    if ((Number.isInteger(expectedRevision) && expectedRevision !== snapshot.revision)
      || (expectedFingerprint && expectedFingerprint !== snapshot.interaction.fingerprint)
      || (expectedInteractionKind && expectedInteractionKind !== snapshot.interaction.kind)) {
      throw Object.assign(new Error('Session state changed before the input could be sent'), { code: 'interaction_changed', statusCode: 409 });
    }
  }

  answerInteraction(sessionId, input) {
    return this.#withCommandLock(String(sessionId || ''), () => this.#answerInteractionUnlocked(sessionId, input));
  }

  async #answerInteractionUnlocked(sessionId, { interactionId, optionId, text: answerText, authority = null, expected = {} } = {}) {
    const session = this.#requireActive(sessionId);
    const interaction = session.interactions.find((item) => item.interactionId === String(interactionId));
    if (!interaction || interaction.status !== 'open') {
      const error = new Error('Interaction is missing or already answered');
      error.code = 'interaction_not_open';
      error.statusCode = 409;
      throw error;
    }
    const authorityAudit = await this.#recordInteractionAuthority(sessionId, { interactionId, authority });
    if (authorityAudit.decision !== 'allowed' || authorityAudit.principalType === 'agent') {
      const error = new Error('Permission interactions require an authenticated operator or a pre-approved automation policy');
      error.code = 'permission_authority_required';
      error.statusCode = 403;
      throw error;
    }
    this.assertExpectedState(sessionId, expected);
    const answer = optionId ? { optionId: String(optionId) } : { text: String(answerText || '') };
    // Answers hold the session lock, so a wedged provider write must not block
    // delete/terminate forever. The write may still land, so the interaction is
    // fenced with an unknown outcome (no retries) until the provider reports it.
    let timer;
    const timeout = Symbol('timeout');
    const result = await Promise.race([
      session.transport.answerInteraction({ interactionId, optionId, text: answerText }),
      new Promise((resolve) => { timer = setTimeout(resolve, this.answerTimeoutMs, timeout); }),
    ]).finally(() => clearTimeout(timer));
    if (result === timeout) {
      await this.#append(session, 'interaction.updated', {
        interactionId,
        patch: { status: 'answer_timeout', outcome: 'unknown', answer, actor: authorityAudit.actor, policy: authorityAudit.policy, authority: authorityAudit },
      });
      throw Object.assign(new Error('Provider did not accept the answer in time; outcome unknown'), { code: 'interaction_answer_timeout', statusCode: 504 });
    }
    await this.#append(session, 'interaction.updated', {
      interactionId,
      patch: {
        status: 'answered', answer,
        actor: authorityAudit.actor,
        policy: authorityAudit.policy,
        authority: authorityAudit,
        answeredAt: this.now(),
      },
    });
    if (session.lifecycle === 'blocked') {
      await this.#transition(session, session.activeTurnId ? 'working' : 'ready', 'Interaction answered');
    }
    recordOpsTiming('interaction_open_duration', this.now() - interaction.openedAt, { transport: 'acp', provider: session.provider, outcome: 'answered' });
    await recordSessionDeliveryAudit(this.deliveryAuditStore, {
      source: 'interaction', kind: session.provider, sessionId: session.id,
      text: optionId || answerText || '', enter: true, status: 'sent',
      metadata: {
        transactionId: interaction.turnId,
        interactionId,
        attemptId: session.activeAttemptId,
        operation: 'answer',
        actor: authorityAudit.actor,
        policy: authorityAudit.policy,
        tool: authorityAudit.tool,
        scope: authorityAudit.scope,
        risk: authorityAudit.risk,
        decision: authorityAudit.decision,
      },
    });
    this.#log('info', 'Structured interaction answered', { sessionId: session.id, attemptId: session.activeAttemptId, turnId: interaction.turnId, interactionId });
    return result;
  }

  async terminate(sessionId, { grace = 500, reason = 'terminated' } = {}) {
    const session = this.sessions.get(String(sessionId || ''));
    if (!session) return { ok: true, status: 'already_gone', residual: [] };
    if (!session.transport) {
      if (!['ended', 'interrupted'].includes(session.lifecycle)) await this.#transition(session, 'ended', reason);
      return { ok: true, status: 'already_gone', residual: [] };
    }
    const attemptId = session.activeAttemptId;
    session.generation += 1;
    const verdict = await session.transport.terminate({ grace });
    if (verdict.ok) {
      await this.#append(session, 'attempt.ended', { attemptId, reason });
      if (session.lifecycle !== 'interrupted') await this.#transition(session, 'ended', reason);
      session.transport = null;
    } else {
      await this.#append(session, 'session.interrupted', {
        attemptId,
        reason: 'terminate_failed',
        detail: verdict.status || 'Structured runtime did not exit cleanly',
      });
    }
    // A runtime that did not exit keeps its handle, so a later terminate or resume reaps it first.
    return verdict;
  }

  async delete(sessionId, { grace = 500, reason = 'deleted' } = {}) {
    const id = String(sessionId || '');
    return this.#withCommandLock(id, async () => {
      await assertSessionDeletable(this.journal, id);
      const existing = this.sessions.get(id);
      if (!existing) return { ok: true, status: 'already_gone', residual: [] };
      const verdict = await this.terminate(id, { grace, reason });
      if (!verdict.ok) return verdict;
      await existing.consumePromise?.catch(() => {});
      if (typeof this.journal.deleteSession !== 'function') {
        const error = new Error('Journal storage does not support true session deletion');
        error.code = 'session_delete_unsupported';
        error.statusCode = 500;
        throw error;
      }
      // Drop the durable references before releasing their backing blobs. If
      // blob cleanup fails, retaining the in-memory ended session makes this
      // idempotently retryable without leaving a journal that points at bytes
      // already removed.
      await this.journal.deleteSession(id);
      await this.attachmentStore?.releaseSession?.(id);
      this.sessions.delete(id);
      this.stateTracker.remove(canonicalSessionStateId(existing.provider, id));
      return { ...verdict, status: 'deleted' };
    });
  }

  async interruptForRestart() {
    for (const session of this.sessions.values()) {
      if (!session.transport) continue;
      const attemptId = session.activeAttemptId;
      if (!['ended', 'interrupted'].includes(session.lifecycle)) await this.#append(session, 'session.interrupted', {
        attemptId,
        reason: 'fleet_restart',
        detail: 'Fleet stopped; history preserved',
      });
      // Fence exit/cancel events emitted during teardown from changing the
      // recovered interrupted projection.
      session.generation += 1;
      await session.transport.terminate({ grace: 500 }).catch(() => {});
      session.transport = null;
    }
  }

  cursor(sessionId, options) { return this.journal.read(sessionId, options); }

  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener is required');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close({ interrupt = true } = {}) {
    if (interrupt) await this.interruptForRestart();
    await this.journal.close();
  }

  #requireActive(sessionId) {
    const session = this.sessions.get(String(sessionId || ''));
    if (!session) {
      const error = new Error(`Session not found: ${sessionId}`);
      error.code = 'session_not_found';
      error.statusCode = 404;
      throw error;
    }
    if (['ended', 'interrupted'].includes(session.lifecycle)) {
      const error = new Error(`Session is ${session.lifecycle} and cannot accept commands`);
      error.code = 'session_ended';
      error.statusCode = 409;
      throw error;
    }
    return session;
  }

  async #consumeTransport(session, transport, owner) {
    try {
      for await (const event of transport.events()) {
        const current = this.sessions.get(session.id);
        if (!current) break;
        const attempt = current.attempts.find((item) => item.attemptId === owner.attemptId);
        const eventTurn = event.turnId ? current.turns.find((item) => item.turnId === event.turnId) : null;
        const turnScoped = Boolean(event.turnId) || event.type === 'interaction.requested';
        const turnOwned = !turnScoped || Boolean(
          eventTurn
          && eventTurn.generation === owner.generation
          && current.activeTurnId === eventTurn.turnId
        );
        const stale = current.generation !== owner.generation
          || current.activeAttemptId !== owner.attemptId
          || attempt?.generation !== owner.generation
          || (event.type === 'interaction.requested' && eventTurn?.cancelRequested === true)
          || !turnOwned;
        await this.#append(current, 'transport.event', {
          disposition: stale ? 'stale' : 'applied', generation: owner.generation, event,
        }, {
          type: 'transport.event',
          eventId: event.eventId,
        });
        if (stale) continue;
        this.#afterTransportEvent(current, event);
      }
    } catch (error) {
      incrementOpsCounter('transport_error', 1, { transport: 'acp', provider: session.provider, outcome: transportErrorKind(error?.code || 'iterator_failed') });
      this.#log('error', 'Structured transport event stream failed', { sessionId: session.id, attemptId: owner.attemptId, error: error?.message });
    } finally {
      const current = this.sessions.get(session.id);
      if (current?.generation === owner.generation && current.activeAttemptId === owner.attemptId
        && !['ended', 'interrupted'].includes(current.lifecycle)) {
        await this.#append(current, 'session.interrupted', {
          attemptId: owner.attemptId, reason: 'transport_eof', detail: 'Provider event stream ended without a terminal receipt',
        });
      }
    }
  }

  #afterTransportEvent(session, event) {
    if (event.type === 'interaction.cancelled') {
      const interaction = session.interactions.find((item) => item.interactionId === event.interactionId);
      if (interaction) recordOpsTiming('interaction_open_duration', this.now() - interaction.openedAt, { transport: 'acp', provider: session.provider, outcome: 'cancelled' });
    } else if (event.type === 'diagnostic' || event.type === 'transport.error') {
      if (event.type === 'transport.error') incrementOpsCounter('transport_error', 1, { transport: 'acp', provider: session.provider, outcome: transportErrorKind(event.kind) });
    }
    while (session.transcript.length > 1 && Buffer.byteLength(JSON.stringify(session.transcript)) > this.contentLimit) session.transcript.shift();
    while (session.diagnostics.length > 1 && Buffer.byteLength(JSON.stringify(session.diagnostics)) > this.diagnosticLimit) session.diagnostics.shift();
  }

  async #appendTranscript(session, entry) {
    await this.#append(session, 'transcript.appended', { entry });
    let bytes = 0;
    while (session.transcript.length > 1 && (bytes = Buffer.byteLength(JSON.stringify(session.transcript))) > this.contentLimit) {
      session.transcript.shift();
    }
  }

  async #transition(session, lifecycle, detail) {
    if (session.lifecycle === lifecycle) return;
    if (lifecycle !== 'interrupted' && !TRANSITIONS[session.lifecycle]?.has(lifecycle)) {
      const error = new Error(`Invalid session lifecycle transition: ${session.lifecycle} -> ${lifecycle}`);
      error.code = 'invalid_session_transition';
      throw error;
    }
    await this.#append(session, 'session.lifecycle', { lifecycle, detail });
  }

  async #append(session, type, data, options = {}) {
    const event = await this.journal.append(session.id, { type, data: clone(data), ...options });
    reduceSessionEvent(session, event);
    this.#observeProtocol(session);
    this.#notify(session, event);
    return event;
  }

  #notify(session, event) {
    const projected = this.#public(session);
    for (const listener of [...this.listeners]) {
      try { listener(projected, clone(event)); } catch { /* listeners are isolated */ }
    }
  }

  #withCommandLock(sessionId, operation) {
    const previous = this.commandLocks.get(sessionId) || Promise.resolve();
    const next = previous.then(operation, operation);
    const tracked = next.catch(() => {});
    this.commandLocks.set(sessionId, tracked);
    return next.finally(() => {
      if (this.commandLocks.get(sessionId) === tracked) this.commandLocks.delete(sessionId);
    });
  }

  #log(level, message, fields) {
    const writer = this.logger?.[level] || this.logger?.info;
    if (typeof writer !== 'function') return;
    try { writer.call(this.logger, fields, message); } catch { /* logging cannot affect state */ }
  }

  // Canonical state comes only from the tracker, keyed like every other
  // provider session so all consumers read the same snapshot.
  #public(session) {
    return { ...publicSession(session), canonicalState: this.stateTracker.get(canonicalSessionStateId(session.provider, session.id)) };
  }

  #observeProtocol(session) {
    const execution = ['working', 'blocked', 'cancelling'].includes(session.lifecycle) ? 'working' : session.lifecycle === 'ready' ? 'idle' : 'unknown';
    const lifecycle = ['ended', 'interrupted'].includes(session.lifecycle) ? 'ended' : session.lifecycle === 'created' || session.lifecycle === 'starting' ? 'starting' : 'running';
    // An ended session has nothing left to answer, so no interaction can keep it blocked.
    const openInteraction = lifecycle !== 'ended' && session.interactions.find((item) => UNSETTLED_INTERACTIONS.has(item.status));
    // A timed-out answer keeps the session blocked but not answerable until the provider settles it.
    const fenced = openInteraction?.status === 'answer_timeout';
    const observedAt = this.now();
    try {
      this.stateTracker.observe(canonicalSessionStateId(session.provider, session.id), [
        ...(session.model ? [{ source: 'protocol', kind: 'requested_runtime', value: { requestedModel: session.model },
          observedAt, expiresAt: 0, fingerprint: `protocol:requested:${session.model}` }] : []),
        ...(session.negotiated?.effectiveModel ? [{ source: 'protocol', kind: 'effective_runtime',
          value: { effectiveModel: session.negotiated.effectiveModel, effectiveThinkingLevel: session.negotiated.effectiveThinkingLevel || null,
            evidence: clone(session.negotiated.modelEvidence) }, observedAt, expiresAt: 0,
          fingerprint: `protocol:effective:${session.revision}` }] : []),
        { source: 'protocol', kind: 'lifecycle', value: { lifecycle, clear: false }, observedAt, expiresAt: 0, fingerprint: `protocol:lifecycle:${session.revision}` },
        { source: 'protocol', kind: 'execution', value: { execution }, observedAt, expiresAt: 0, fingerprint: `protocol:execution:${session.revision}` },
        {
          source: 'protocol', kind: 'interaction',
          value: openInteraction ? {
            kind: fenced ? 'unknown_blocking' : openInteraction.kind,
            detail: fenced ? 'Answer outcome unknown; waiting for the provider' : openInteraction.toolCall?.title || 'Permission required',
            options: (fenced ? [] : openInteraction.options || []).map((option) => ({
              key: option.optionId, value: option.optionId, label: option.name || option.optionId, kind: option.kind || '',
            })),
            fingerprint: openInteraction.interactionId, stable: true,
          } : session.lifecycle === 'ready' ? { kind: 'free_text', detail: '', options: [], fingerprint: `ready:${session.revision}`, stable: true } : { kind: 'none', detail: '', options: [], fingerprint: '', stable: true },
          // The snapshot fingerprint comes from here; empty while fenced so nothing can answer it.
          observedAt, expiresAt: 0, fingerprint: fenced ? '' : openInteraction?.interactionId || `protocol:interaction:${session.revision}`,
        },
      ]);
    } catch {
      /* observation failures cannot take down the transport consumer */
    }
  }
}

export { reduceSessionEvent };
