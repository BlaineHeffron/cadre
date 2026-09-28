import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'node:test';
import { AsyncEventQueue, createBaseCapabilities, createTransportEvent, unsupportedCapability } from '../modules/agent/agent-transport.mjs';
import { FileJournalStore } from '../modules/sessions/journal-store.mjs';
import { reduceSessionEvent, SessionService, TASK_ADMISSION } from '../modules/sessions/session-service.mjs';
import { createSessionStateTracker } from '../modules/session-state/tracker.mjs';

const roots = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop(), { recursive: true, force: true });
});

class FakeTransport {
  constructor({ settle = false } = {}) {
    this.queue = new AsyncEventQueue();
    this.settleImmediately = settle;
    this.closed = false;
    this.promptCalls = [];
    this.open = new Map();
    this.cancelCalls = [];
    this.cancelledInteractions = [];
  }
  emit(type, payload = {}) {
    this.queue.push(createTransportEvent(type, payload, { attemptId: this.attemptId, provider: 'deepseek', transport: 'acp' }));
  }
  async start(spec) {
    this.attemptId = spec.attemptId;
    this.emit('attempt.started', { protocolSessionId: 'protocol-1' });
    return { attemptId: spec.attemptId, protocolSessionId: 'protocol-1', negotiated: this.capabilities() };
  }
  async attach() { throw unsupportedCapability('attach'); }
  async prompt(input) {
    this.current = input;
    this.promptCalls.push(input);
    this.emit('turn.started', {
      turnId: input.turnId, phase: 'admitted',
      evidence: { accepted: true, settled: false, quiescent: false },
    });
    this.emit('turn.started', {
      turnId: input.turnId, phase: 'inflight',
      evidence: { accepted: true, settled: false, quiescent: false },
    });
    if (this.settleImmediately) this.settle('end_turn');
    return new Promise((resolve, reject) => { this.resolvePrompt = resolve; this.rejectPrompt = reject; });
  }
  settle(stopReason = 'end_turn') {
    if (!this.current) return;
    this.emit('message.delta', { turnId: this.current.turnId, delta: { type: 'text', text: 'preserved output' } });
    this.emit('turn.settled', { turnId: this.current.turnId, stopReason, evidence: { accepted: true, settled: true, quiescent: true } });
    this.resolvePrompt?.({ stopReason });
    this.current = null;
  }
  permission() {
    const interactionId = `${this.attemptId}:permission`;
    this.open.set(interactionId, true);
    this.emit('interaction.requested', {
      interactionId, turnId: this.current?.turnId, kind: 'permission', toolCall: { title: 'Write file' },
      options: [{ optionId: 'allow_once', name: 'Allow once' }],
    });
    return interactionId;
  }
  async answerInteraction({ interactionId, optionId }) {
    if (!this.open.delete(interactionId)) throw new Error('not open');
    this.emit('interaction.answered', { interactionId, optionId });
    return { ok: true };
  }
  async cancelInteraction(interactionId) {
    if (!this.open.delete(interactionId)) return false;
    this.cancelledInteractions.push(interactionId);
    this.emit('interaction.cancelled', { interactionId });
    return true;
  }
  async cancel({ turnId } = {}) {
    this.cancelCalls.push(turnId);
    return { mode: 'best_effort' };
  }
  events() { return this.queue; }
  snapshot() { return { lifecycle: this.closed ? 'ended' : 'ready' }; }
  capabilities() { return createBaseCapabilities({ protocol: { name: 'acp', version: '1' } }); }
  async terminate() { this.closed = true; this.queue.close(); return { ok: true, status: 'terminated', residual: [] }; }
}

async function fixture({ factory, auditStore = null, attachmentStore = null, answerTimeoutMs } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dueno-session-service-'));
  roots.push(root);
  const workDir = join(root, 'work');
  await mkdir(workDir);
  const journal = new FileJournalStore({ rootDir: join(root, 'journal') });
  const service = new SessionService({
    journal, transportFactory: factory, deliveryAuditStore: auditStore, attachmentStore, answerTimeoutMs,
  });
  await service.init();
  return { root, workDir, journal, service };
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('state timeout');
}

describe('SessionService', () => {
  it('reduces durable and transport-only interruption projections', () => {
    let sequence = 0;
    const event = (type, data = {}, sessionId = 'projection-session') => ({
      type, data, sessionId, eventId: `projection-${sequence += 1}`, recordedAt: sequence * 10,
    });
    let session = reduceSessionEvent(null, event('session.created', {
      provider: 'deepseek', displayName: 'Projection', workDir: '/tmp', permissionMode: 'workspace-write',
    }));
    session = reduceSessionEvent(session, event('attempt.created', {
      attemptId: 'attempt-1', generation: 1, runtimeInstanceId: 'runtime-1',
    }));
    session = reduceSessionEvent(session, event('session.lifecycle', { lifecycle: 'working', detail: 'Working' }));
    session = reduceSessionEvent(session, event('turn.created', {
      turnId: 'turn-1', idempotencyKey: 'key-1', generation: 1, blocks: [{ type: 'text', text: 'work' }],
    }));
    session = reduceSessionEvent(session, event('interaction.opened', {
      interaction: { interactionId: 'interaction-1', status: 'open', openedAt: 40 },
    }));
    session = reduceSessionEvent(session, event('transport.event', {
      disposition: 'applied', generation: 1,
      event: { type: 'interaction.cancelled', interactionId: 'interaction-1' },
    }));
    session = reduceSessionEvent(session, event('diagnostic.appended', {
      entry: { type: 'stderr', message: 'durable diagnostic' },
    }));
    session = reduceSessionEvent(session, event('transport.event', {
      disposition: 'applied', generation: 1,
      event: {
        type: 'transport.error', eventId: 'transport-error', kind: 'transport_closed',
        message: 'connection lost', observedAt: 70,
      },
    }));
    session = reduceSessionEvent(session, event('transport.event', {
      disposition: 'applied', generation: 1,
      event: {
        type: 'turn.settled', turnId: 'turn-1',
        error: { code: 'connection_closed', message: 'settlement unknown' },
        evidence: { accepted: true, settled: false, quiescent: false },
      },
    }));

    assert.equal(session.interactions[0].status, 'cancelled');
    assert.equal(session.diagnostics.length, 2);
    assert.equal(session.turns[0].status, 'unknown');
    assert.equal(session.turns[0].error.code, 'connection_closed');
    assert.equal(session.lifecycle, 'interrupted');
    assert.equal(session.detail, 'settlement unknown');
    assert.equal(session.attempts[0].endReason, 'connection_closed');

    let exited = reduceSessionEvent(null, event('session.created', { provider: 'deepseek' }, 'exit-session'));
    exited = reduceSessionEvent(exited, event('attempt.created', {
      attemptId: 'attempt-exit', generation: 1, runtimeInstanceId: 'runtime-exit',
    }, 'exit-session'));
    exited = reduceSessionEvent(exited, event('turn.created', {
      turnId: 'turn-exit', generation: 1, blocks: [],
    }, 'exit-session'));
    exited = reduceSessionEvent(exited, event('transport.event', {
      disposition: 'applied', generation: 1,
      event: { type: 'attempt.exited', signal: 'SIGTERM' },
    }, 'exit-session'));
    assert.equal(exited.lifecycle, 'interrupted');
    assert.equal(exited.detail, 'Exited on SIGTERM');
    assert.equal(exited.turns[0].status, 'unknown');
    assert.equal(exited.attempts[0].endReason, 'transport_exit');
  });

  it('rebuilds an inflight turn after Fleet restart as unknown without replaying it', { timeout: 15000 }, async () => {
    const transports = [];
    const first = await fixture({ factory: () => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    } });
    const created = await first.service.start({ workDir: first.workDir, permissionMode: 'workspace-write' });
    const turn = await first.service.prompt(created.id, {
      blocks: [{ type: 'text', text: 'uncertain work' }], idempotencyKey: 'uncertain-key',
    });
    await waitFor(() => first.service.get(created.id).turns.find((item) => item.turnId === turn.turnId)?.status === 'inflight');
    transports[0].emit('message.delta', {
      turnId: turn.turnId,
      delta: { type: 'text', text: 'one durable delta' },
    });
    await waitFor(() => first.service.get(created.id).transcript.some((entry) => entry.delta?.text === 'one durable delta'));
    await first.journal.close(); // Simulate abrupt Fleet loss: no lifecycle teardown event.

    let restartedTransportCount = 0;
    const restartedJournal = new FileJournalStore({ rootDir: join(first.root, 'journal') });
    const restarted = new SessionService({ journal: restartedJournal, transportFactory: () => {
      restartedTransportCount += 1;
      return new FakeTransport();
    } });
    await restarted.init();
    const restored = restarted.get(created.id);
    assert.equal(restored.lifecycle, 'interrupted');
    assert.equal(restored.nonResumable, true);
    assert.equal(restored.endedWithHistory, true);
    assert.equal(restored.turns[0].status, 'unknown');
    assert.equal(restored.turns[0].evidence.accepted, true);
    assert.equal(restored.turns[0].evidence.settled, false);
    assert.equal(restored.transcript[0].blocks[0].text, 'uncertain work');
    const restoredDeltas = restored.transcript.filter((entry) => entry.delta?.text === 'one durable delta');
    assert.equal(restoredDeltas.length, 1);
    assert.equal(restartedTransportCount, 0);
    transports[0].queue.close();
    await restarted.close({ interrupt: false });
  });

  it('resumes a restart-interrupted session by attaching to its provider session', { timeout: 15000 }, async () => {
    const attaches = [];
    let failAttach = true;
    class ResumableTransport extends FakeTransport {
      capabilities() { return createBaseCapabilities({ protocol: { name: 'acp', version: '1' }, sessionOps: { resume: 'supported' } }); }
      async attach(spec) {
        attaches.push(structuredClone(spec));
        if (failAttach) throw Object.assign(new Error('provider unavailable'), { code: 'provider_unavailable' });
        this.attemptId = spec.attemptId;
        this.emit('attempt.started', { protocolSessionId: spec.protocolSessionId });
        return { attemptId: spec.attemptId, protocolSessionId: spec.protocolSessionId, negotiated: this.capabilities() };
      }
    }
    const first = await fixture({ factory: () => new ResumableTransport() });
    const created = await first.service.start({ workDir: first.workDir, permissionMode: 'workspace-write', model: 'model-a' });
    await assert.rejects(first.service.resume(created.id), (error) => error.code === 'session_not_resumable' && error.statusCode === 409);
    const firstTransport = [...first.service.sessions.values()][0].transport;
    // Until a turn settles there is no proof the provider holds a conversation to resume.
    await first.service.prompt(created.id, { blocks: [{ type: 'text', text: 'hello' }], idempotencyKey: 'hello' });
    await waitFor(() => first.service.get(created.id).turns[0]?.status === 'inflight');
    firstTransport.settle();
    await waitFor(() => first.service.get(created.id).turns[0]?.status === 'settled');
    await first.service.prompt(created.id, { blocks: [{ type: 'text', text: 'needs approval' }], idempotencyKey: 'approval' });
    await waitFor(() => first.service.get(created.id).turns[1]?.status === 'inflight');
    firstTransport.permission();
    await waitFor(() => first.service.get(created.id).lifecycle === 'blocked');
    await first.journal.close(); // Abrupt Fleet loss.

    const restarted = new SessionService({
      journal: new FileJournalStore({ rootDir: join(first.root, 'journal') }), transportFactory: () => new ResumableTransport({ settle: true }),
    });
    await restarted.init();
    assert.equal(restarted.get(created.id).lifecycle, 'interrupted');
    await assert.rejects(restarted.resume('missing'), (error) => error.statusCode === 404);

    // A failed attach leaves the provider session intact, so the session stays interrupted and resumable.
    const cleaned = [];
    await assert.rejects(restarted.resume(created.id, {
      prepare: () => ({ env: { MARKER: '1' } }), cleanup: (error) => cleaned.push(error.code),
    }), /provider unavailable/);
    assert.deepEqual(cleaned, ['provider_unavailable']);
    assert.equal(restarted.get(created.id).lifecycle, 'interrupted');

    failAttach = false;
    const resumed = await restarted.resume(created.id, { prepare: (session) => ({ env: { MARKER: `${session.generation}` } }) });
    assert.equal(resumed.lifecycle, 'ready');
    assert.equal(resumed.generation, 3);
    assert.equal(resumed.nonResumable, false);
    assert.deepEqual(attaches.map((spec) => [spec.protocolSessionId, spec.permissionMode, spec.model, spec.env.MARKER, spec.cwd]), [
      ['protocol-1', 'workspace-write', 'model-a', '1', first.workDir],
      ['protocol-1', 'workspace-write', 'model-a', '2', first.workDir],
    ]);
    // The dead attempt's permission prompt can never be answered, so it no longer blocks.
    assert.deepEqual(resumed.interactions.map((item) => item.status), ['cancelled']);
    assert.equal(resumed.canonicalState.execution, 'idle');
    await restarted.prompt(created.id, { blocks: [{ type: 'text', text: 'continue' }], idempotencyKey: 'after-resume' });
    await waitFor(() => restarted.get(created.id).turns.at(-1)?.status === 'settled');
    assert.equal((await restarted.journal.read(created.id)).events
      .filter((event) => event.type === 'session.interrupted').at(-1).data.reason, 'resume_failed');
    firstTransport.queue.close();
    await restarted.close({ interrupt: false });
  });

  it('refuses to resume past a runtime that did not exit or into a task-owned session', { timeout: 15000 }, async () => {
    let exits = false;
    const attaches = [];
    class StuckTransport extends FakeTransport {
      capabilities() { return createBaseCapabilities({ protocol: { name: 'acp', version: '1' }, sessionOps: { resume: 'supported' } }); }
      async attach(spec) { attaches.push(spec); return this.start(spec); }
      async terminate() { return exits ? super.terminate() : { ok: false, status: 'still_running', residual: [1] }; }
    }
    const harness = await fixture({ factory: () => new StuckTransport({ settle: true }) });
    const created = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
    await harness.service.prompt(created.id, { blocks: [{ type: 'text', text: 'hello' }], idempotencyKey: 'hello' });
    await waitFor(() => harness.service.get(created.id).turns[0]?.status === 'settled');
    assert.equal((await harness.service.terminate(created.id)).ok, false);
    assert.equal(harness.service.get(created.id).lifecycle, 'interrupted');
    // The old process may still hold the conversation, so resume must reap it before attaching.
    await assert.rejects(harness.service.resume(created.id), (error) => error.code === 'terminate_failed');
    assert.equal(attaches.length, 0);
    exits = true;
    assert.equal((await harness.service.resume(created.id)).lifecycle, 'ready');
    assert.equal(attaches.length, 1);

    const task = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write', metadata: { taskId: 'task-1' } });
    await harness.service.prompt(task.id, { blocks: [{ type: 'text', text: 'task' }], idempotencyKey: 'task', taskAdmission: TASK_ADMISSION });
    await waitFor(() => harness.service.get(task.id).turns[0]?.status === 'settled');
    await harness.service.close({ interrupt: true });
    await assert.rejects(harness.service.resume(task.id), (error) => error.code === 'task_managed' && error.statusCode === 409);
  });

  it('journals transport interruption and keeps an unreturned prompt outcome unknown', { timeout: 15000 }, async () => {
    let transport;
    const harness = await fixture({ factory: () => { transport = new FakeTransport(); return transport; } });
    const created = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
    const turn = await harness.service.prompt(created.id, {
      blocks: [{ type: 'text', text: 'lose connection' }], idempotencyKey: 'connection-loss',
    });
    await waitFor(() => harness.service.get(created.id).turns[0]?.status === 'inflight');
    transport.closed = true;
    const failure = Object.assign(new Error('connection dropped'), { code: 'transport_closed' });
    transport.rejectPrompt(failure);
    const interrupted = await waitFor(() => harness.service.get(created.id).lifecycle === 'interrupted' && harness.service.get(created.id));
    const projectedTurn = interrupted.turns.find((item) => item.turnId === turn.turnId);
    assert.equal(projectedTurn.status, 'unknown');
    assert.equal(projectedTurn.evidence.accepted, true);
    assert.equal(projectedTurn.evidence.settled, false);
    assert.equal(projectedTurn.evidence.quiescent, false);
    assert.equal(interrupted.nonResumable, true);
    const events = await harness.journal.read(created.id);
    assert.ok(events.events.some((event) => event.type === 'session.interrupted'));
    transport.queue.close();
    await harness.service.close({ interrupt: false });
  });

  it('journals stale-generation transport events without changing the projection', { timeout: 15000 }, async () => {
    let transport;
    const harness = await fixture({ factory: () => { transport = new FakeTransport(); return transport; } });
    const created = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
    const internal = harness.service.sessions.get(created.id);
    internal.generation += 1;
    transport.emit('message.delta', { turnId: 'stale-turn', delta: { type: 'text', text: 'must not project' } });
    const stale = await waitFor(async () => {
      const page = await harness.journal.read(created.id);
      return page.events.find((event) => event.type === 'transport.event' && event.data.disposition === 'stale');
    });
    assert.equal(stale.data.event.type, 'message.delta');
    assert.equal(harness.service.get(created.id).transcript.some((entry) => entry.delta?.text === 'must not project'), false);
    transport.queue.close();
    await harness.service.close({ interrupt: false });
  });

  it('records delivery audit entries for every prompt and interaction answer with transactionId=turnId', { timeout: 15000 }, async () => {
    const entries = [];
    const auditStore = { async record(entry) { entries.push(structuredClone(entry)); return entry; } };
    let transport;
    const harness = await fixture({ auditStore, factory: () => { transport = new FakeTransport(); return transport; } });
    const created = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
    const turn = await harness.service.prompt(created.id, {
      blocks: [{ type: 'text', text: 'needs permission' }], idempotencyKey: 'permission-key',
    });
    await waitFor(() => harness.service.get(created.id).turns[0]?.status === 'inflight');
    const interactionId = transport.permission();
    await waitFor(() => harness.service.get(created.id).lifecycle === 'blocked');
    await harness.service.answerInteraction(created.id, {
      interactionId,
      optionId: 'allow_once',
      authority: {
        actor: 'dashboard:user:1',
        principalType: 'ui',
        policy: 'authenticated_operator',
        tool: 'deepseek.interaction',
        scope: 'permission.approve',
        risk: 'provider_tool_execution',
        decision: 'allowed',
      },
    });
    assert.equal(entries.length, 2);
    assert.equal(entries[0].metadata.transactionId, turn.turnId);
    assert.equal(entries[1].metadata.transactionId, turn.turnId);
    assert.equal(entries[1].metadata.operation, 'answer');
    const interaction = harness.service.get(created.id).interactions[0];
    assert.equal(interaction.status, 'answered');
    assert.equal(interaction.actor, 'dashboard:user:1');
    transport.settle();
    await waitFor(() => harness.service.get(created.id).lifecycle === 'ready');
    await harness.service.close();
  });

  it('lets exactly one of two concurrent conflicting answers reach the provider', { timeout: 15000 }, async () => {
    let transport;
    const harness = await fixture({ factory: () => { transport = new FakeTransport(); return transport; } });
    const created = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
    await harness.service.prompt(created.id, { blocks: [{ type: 'text', text: 'needs permission' }], idempotencyKey: 'race-key' });
    await waitFor(() => harness.service.get(created.id).turns[0]?.status === 'inflight');
    const interactionId = transport.permission();
    await waitFor(() => harness.service.get(created.id).lifecycle === 'blocked');
    // Like the real Claude transport: the write is slow and does not dedupe answers itself.
    const calls = [];
    transport.answerInteraction = async (input) => { calls.push(input.optionId); await new Promise((r) => setTimeout(r, 20)); return { ok: true }; };
    const { canonicalState } = harness.service.get(created.id);
    const expected = { expectedRevision: canonicalState.revision, expectedFingerprint: canonicalState.interaction.fingerprint, expectedInteractionKind: 'permission' };
    const authority = { actor: 'dashboard:user:1', principalType: 'ui', decision: 'allowed' };
    const results = await Promise.allSettled(['allow_once', 'deny'].map((optionId) => (
      harness.service.answerInteraction(created.id, { interactionId, optionId, authority, expected })
    )));
    assert.deepEqual(results.map((result) => result.status), ['fulfilled', 'rejected']);
    assert.equal(results[1].reason.statusCode, 409);
    assert.deepEqual(calls, ['allow_once']);
    const interaction = harness.service.get(created.id).interactions[0];
    assert.deepEqual([interaction.status, interaction.answer, interaction.authorityAudit.length], ['answered', { optionId: 'allow_once' }, 1]);
    transport.queue.close();
    await harness.service.close({ interrupt: false });
  });

  it('fails a hung provider answer so delete still terminates the session', { timeout: 15000 }, async () => {
    let transport;
    const harness = await fixture({ answerTimeoutMs: 50, factory: () => { transport = new FakeTransport(); return transport; } });
    const created = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
    await harness.service.prompt(created.id, { blocks: [{ type: 'text', text: 'needs permission' }], idempotencyKey: 'hung-key' });
    await waitFor(() => harness.service.get(created.id).turns[0]?.status === 'inflight');
    const interactionId = transport.permission();
    await waitFor(() => harness.service.get(created.id).lifecycle === 'blocked');
    transport.answerInteraction = () => new Promise(() => {}); // provider stopped reading its stdin
    const answering = harness.service.answerInteraction(created.id, {
      interactionId, optionId: 'allow_once', authority: { actor: 'dashboard:user:1', principalType: 'ui', decision: 'allowed' },
    });
    const deleting = harness.service.delete(created.id);
    await assert.rejects(answering, (error) => error.code === 'interaction_answer_timeout' && error.statusCode === 504);
    assert.equal((await deleting).status, 'deleted');
    assert.equal(transport.closed, true);
    assert.equal(harness.service.get(created.id), null);
    await harness.service.close({ interrupt: false });
  });

  it('fences a timed-out answer as unknown until the provider reports the outcome', { timeout: 15000 }, async () => {
    let transport;
    const harness = await fixture({ answerTimeoutMs: 50, factory: () => { transport = new FakeTransport(); return transport; } });
    const created = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
    await harness.service.prompt(created.id, { blocks: [{ type: 'text', text: 'needs permission' }], idempotencyKey: 'fence-key' });
    await waitFor(() => harness.service.get(created.id).turns[0]?.status === 'inflight');
    const interactionId = transport.permission();
    await waitFor(() => harness.service.get(created.id).lifecycle === 'blocked');
    const calls = [];
    transport.answerInteraction = (input) => { calls.push(input.optionId); return new Promise(() => {}); };
    const authority = { actor: 'dashboard:user:1', principalType: 'ui', decision: 'allowed' };
    await assert.rejects(harness.service.answerInteraction(created.id, { interactionId, optionId: 'allow_once', authority }),
      (error) => error.code === 'interaction_answer_timeout' && error.statusCode === 504);
    const fenced = harness.service.get(created.id);
    assert.deepEqual([fenced.interactions[0].status, fenced.interactions[0].outcome, fenced.interactions[0].authority.actor],
      ['answer_timeout', 'unknown', 'dashboard:user:1']);
    const { canonicalState } = fenced;
    assert.deepEqual([canonicalState.status, canonicalState.interaction.kind, canonicalState.capabilities.needsAttention,
      canonicalState.capabilities.sendMessage, canonicalState.capabilities.canAnswerInteraction], ['blocked', 'unknown_blocking', true, false, false]);
    await assert.rejects(harness.service.answerInteraction(created.id, { interactionId, optionId: 'deny', authority }),
      (error) => error.code === 'interaction_not_open' && error.statusCode === 409);
    assert.deepEqual(calls, ['allow_once']);
    // The first write lands late; the provider's report settles the interaction with the real answer.
    transport.emit('interaction.answered', { interactionId, optionId: 'allow_once' });
    await waitFor(() => harness.service.get(created.id).lifecycle === 'working');
    const settled = harness.service.get(created.id);
    assert.deepEqual([settled.interactions[0].status, settled.interactions[0].answer, settled.canonicalState.status, settled.canonicalState.capabilities.needsAttention],
      ['answered', { optionId: 'allow_once' }, 'working', false]);
    transport.queue.close();
    await harness.service.close({ interrupt: false });
  });

  it('stops projecting a fenced answer as blocking once the session ends', { timeout: 15000 }, async () => {
    let transport;
    const harness = await fixture({ answerTimeoutMs: 50, factory: () => { transport = new FakeTransport(); return transport; } });
    const created = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
    await harness.service.prompt(created.id, { blocks: [{ type: 'text', text: 'needs permission' }], idempotencyKey: 'fence-end-key' });
    await waitFor(() => harness.service.get(created.id).turns[0]?.status === 'inflight');
    const interactionId = transport.permission();
    await waitFor(() => harness.service.get(created.id).lifecycle === 'blocked');
    transport.answerInteraction = () => new Promise(() => {});
    await assert.rejects(harness.service.answerInteraction(created.id, {
      interactionId, optionId: 'allow_once', authority: { actor: 'dashboard:user:1', principalType: 'ui', decision: 'allowed' },
    }), (error) => error.code === 'interaction_answer_timeout');
    assert.equal(harness.service.get(created.id).canonicalState.capabilities.needsAttention, true);
    await harness.service.terminate(created.id);
    const { canonicalState } = harness.service.get(created.id);
    assert.deepEqual([canonicalState.interaction.kind, canonicalState.capabilities.needsAttention], ['none', false]);
    await harness.service.close({ interrupt: false });
  });

  it('records and denies an agent attempt to self-approve a permission interaction', { timeout: 15000 }, async () => {
    let transport;
    const harness = await fixture({ factory: () => { transport = new FakeTransport(); return transport; } });
    const created = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
    await harness.service.prompt(created.id, {
      blocks: [{ type: 'text', text: 'needs permission' }], idempotencyKey: 'agent-permission-key',
    });
    await waitFor(() => harness.service.get(created.id).turns[0]?.status === 'inflight');
    const interactionId = transport.permission();
    await waitFor(() => harness.service.get(created.id).lifecycle === 'blocked');
    await assert.rejects(
      harness.service.answerInteraction(created.id, {
        interactionId,
        optionId: 'allow_once',
        authority: {
          actor: 'codex:agent-1', principalType: 'agent', policy: 'self',
          tool: 'Write file', scope: 'permission.approve', risk: 'provider_tool_execution', decision: 'allowed',
        },
      }),
      (error) => error.code === 'permission_authority_required' && error.statusCode === 403,
    );
    const interaction = harness.service.get(created.id).interactions[0];
    assert.equal(interaction.status, 'open');
    assert.equal(interaction.authorityAudit.at(-1).principalType, 'agent');
    assert.equal(interaction.authorityAudit.at(-1).decision, 'denied');
    assert.equal(transport.open.has(interactionId), true);
    transport.queue.close();
    await harness.service.close({ interrupt: false });
  });

  it('cancels the active turn and every open interaction before settling', { timeout: 15000 }, async () => {
    let transport;
    const harness = await fixture({ factory: () => { transport = new FakeTransport(); return transport; } });
    const created = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
    const turn = await harness.service.prompt(created.id, {
      blocks: [{ type: 'text', text: 'cancel this work' }], idempotencyKey: 'cancel-key',
    });
    await waitFor(() => harness.service.get(created.id).turns[0]?.status === 'inflight');
    const interactionId = transport.permission();
    await waitFor(() => harness.service.get(created.id).lifecycle === 'blocked');

    const verdict = await harness.service.cancel(created.id);
    assert.deepEqual(verdict, { mode: 'best_effort' });
    assert.deepEqual(transport.cancelCalls, [turn.turnId]);
    assert.deepEqual(transport.cancelledInteractions, [interactionId]);
    const cancelling = await waitFor(() => {
      const session = harness.service.get(created.id);
      return session.interactions[0]?.status === 'cancelled' && session;
    });
    assert.equal(cancelling.lifecycle, 'cancelling');
    assert.equal(cancelling.turns[0].cancelRequested, true);
    assert.equal(cancelling.interactions[0].status, 'cancelled');

    transport.settle('cancelled');
    await waitFor(() => harness.service.get(created.id).lifecycle === 'ready');
    assert.equal(harness.service.get(created.id).turns[0].status, 'cancelled');
    assert.deepEqual(await harness.service.cancel(created.id), { mode: 'best_effort' });
    assert.deepEqual(transport.cancelCalls, [turn.turnId], 'no transport cancel is sent without an active turn');
    await harness.service.close();
  });

  it('rebuilds after compacting ephemeral journal events', { timeout: 15000 }, async () => {
    let transport;
    const harness = await fixture({
      factory: () => { transport = new FakeTransport({ settle: true }); return transport; },
    });
    const created = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
    await harness.service.prompt(created.id, {
      blocks: [{ type: 'text', text: 'keep me' }], idempotencyKey: 'keep-key',
    });
    await waitFor(() => harness.service.get(created.id).lifecycle === 'ready');
    for (let index = 0; index < 20; index += 1) {
      await harness.journal.append(created.id, { type: 'transport.event', data: { disposition: 'stale', index } });
    }
    await harness.journal.compact(created.id, { retain: 3 });
    const restoredJournal = new FileJournalStore({ rootDir: join(harness.root, 'journal') });
    const restored = new SessionService({
      journal: restoredJournal,
      transportFactory: () => new FakeTransport(),
    });
    await restored.init();
    const session = restored.get(created.id);
    assert.ok(session);
    assert.equal(session.turns[0].idempotencyKey, 'keep-key');
    assert.equal(['interrupted', 'ended'].includes(session.lifecycle), true);
    transport.queue.close();
    await harness.service.close({ interrupt: false });
    await restored.close({ interrupt: false });
  });

  it('interrupts when terminate leaves a residual runtime', { timeout: 15000 }, async () => {
    let transport;
    const harness = await fixture({ factory: () => { transport = new FakeTransport(); return transport; } });
    const created = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
    transport.terminate = async () => ({ ok: false, status: 'failed', residual: [{ pid: 1 }] });
    const verdict = await harness.service.terminate(created.id);
    assert.equal(verdict.ok, false);
    const session = harness.service.get(created.id);
    assert.equal(session.lifecycle, 'interrupted');
    assert.equal(session.nonResumable, true);
    await assert.rejects(() => harness.service.prompt(created.id, {
      blocks: [{ type: 'text', text: 'nope' }], idempotencyKey: 'after-fail',
    }), /cannot accept commands/);
    transport.queue.close();
    await harness.service.close({ interrupt: false });
  });

  it('preserves attachment refs on terminate and releases them only on true delete', async () => {
    const released = [];
    const attachmentStore = {
      async init() {},
      async releaseSession(sessionId) { released.push(sessionId); return true; },
    };
    const harness = await fixture({
      attachmentStore,
      factory: () => new FakeTransport(),
    });
    const created = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
    const terminated = await harness.service.terminate(created.id);
    assert.equal(terminated.ok, true);
    assert.deepEqual(released, [], 'ended journal history retains its attachment references');
    assert.ok(harness.service.get(created.id));
    const deleted = await harness.service.delete(created.id);
    assert.equal(deleted.status, 'deleted');
    assert.deepEqual(released, [created.id]);
    assert.equal(harness.service.get(created.id), null);
    assert.deepEqual(await harness.journal.listSessionIds(), []);
    await harness.service.close({ interrupt: false });
  });

  it('marks a prompt unknown when the RPC resolves without settlement evidence', { timeout: 15000 }, async () => {
    let transport;
    const harness = await fixture({ factory: () => { transport = new FakeTransport(); return transport; } });
    const created = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
    transport.prompt = async (input) => {
      transport.current = input;
      transport.emit('turn.started', {
        turnId: input.turnId, phase: 'inflight',
        evidence: { accepted: true, settled: false, quiescent: false },
      });
      return {};
    };
    await harness.service.prompt(created.id, {
      blocks: [{ type: 'text', text: 'no settle' }], idempotencyKey: 'no-settle',
    });
    const interrupted = await waitFor(() => harness.service.get(created.id).lifecycle === 'interrupted' && harness.service.get(created.id));
    assert.equal(interrupted.turns[0].status, 'unknown');
    transport.queue.close();
    await harness.service.close({ interrupt: false });
  });

  it('keeps consuming transport events when state observation throws', { timeout: 15000 }, async () => {
    let transport;
    const root = await mkdtemp(join(tmpdir(), 'dueno-session-service-'));
    roots.push(root);
    const workDir = join(root, 'work');
    await mkdir(workDir);
    const journal = new FileJournalStore({ rootDir: join(root, 'journal') });
    const service = new SessionService({
      journal,
      stateTracker: { ...createSessionStateTracker(), observe() { throw new Error('tracker down'); } },
      transportFactory: () => { transport = new FakeTransport({ settle: true }); return transport; },
    });
    await service.init();
    const created = await service.start({ workDir, permissionMode: 'workspace-write' });
    await service.prompt(created.id, { blocks: [{ type: 'text', text: 'ok' }], idempotencyKey: 'sink' });
    await waitFor(() => service.get(created.id).lifecycle === 'ready');
    transport.queue.close();
    await service.close();
  });
});
