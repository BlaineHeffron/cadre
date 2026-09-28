import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'node:test';
import { AsyncEventQueue, createBaseCapabilities, createTransportEvent, unsupportedCapability } from '../modules/agent/agent-transport.mjs';
import { FileJournalStore } from '../modules/sessions/journal-store.mjs';
import { reduceSessionEvent, SessionService } from '../modules/sessions/session-service.mjs';
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

async function fixture({ factory, auditStore = null, attachmentStore = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dueno-session-service-'));
  roots.push(root);
  const workDir = join(root, 'work');
  await mkdir(workDir);
  const journal = new FileJournalStore({ rootDir: join(root, 'journal') });
  const service = new SessionService({
    journal, transportFactory: factory, deliveryAuditStore: auditStore, attachmentStore,
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
