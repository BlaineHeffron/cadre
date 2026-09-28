import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'node:test';
import { AsyncEventQueue, createBaseCapabilities, createTransportEvent } from '../modules/agent/agent-transport.mjs';
import { AgentBusStore } from '../modules/agent-bus/store.mjs';
import { FileJournalStore } from '../modules/sessions/journal-store.mjs';
import { SessionService } from '../modules/sessions/session-service.mjs';
import { createSessionStateTracker } from '../modules/session-state/tracker.mjs';
import { TaskService } from '../modules/sessions/task-service.mjs';

// A disposable provider implementing the public transport contract. Stores and
// service projections below are real; fixture controls only provider responses.
class Provider {
  queue = new AsyncEventQueue();
  calls = [];
  steerCalls = [];
  closed = false;
  emit(type, data = {}) { this.queue.push(createTransportEvent(type, data, { attemptId: this.spec.attemptId })); }
  capabilities() { return createBaseCapabilities({ protocol: { name: 'fixture', version: '1' },
    turn: { steer: true }, sessionOps: { resume: 'supported' }, effectiveModel: this.model || 'fixture-model',
    modelEvidence: { source: 'fixture/thread-start-response' } }); }
  async start(spec) { this.spec = spec; this.threadId = spec.protocolSessionId || `provider-${spec.sessionId}`; return { protocolSessionId: this.threadId, negotiated: this.capabilities() }; }
  async attach(spec) {
    this.attached = spec.protocolSessionId;
    const result = await this.start(spec);
    try { result.negotiated = { ...result.negotiated, startup: { reconciliation: JSON.parse(await readFile(join(spec.cwd, 'provider-history.json'), 'utf8')) } }; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return result;
  }
  async completeWithoutReceipt(text) {
    const providerTurnId = `p-${this.current.turnId}`;
    await writeFile(join(this.spec.cwd, 'provider-history.json'), JSON.stringify({
      providerThreadId: this.threadId, providerTurnId, evidence: { source: 'provider/read', accepted: true, settled: true, quiescent: true },
      turn: { id: providerTurnId, status: 'completed', items: [{ type: 'agentMessage', text }] },
    }));
    this.queue.close();
  }
  prompt(input) {
    this.calls.push(input); this.current = input;
    if (!this.loseAdmission) this.emit('turn.started', { turnId: input.turnId, providerTurnId: `p-${input.turnId}`, evidence: { accepted: true } });
    if (this.rejectPrompt) {
      const evidence = { accepted: false, settled: this.rejectPrompt === 'known', quiescent: this.rejectPrompt === 'known' };
      if (evidence.settled) this.emit('turn.settled', { turnId: input.turnId, error: { code: 'provider_rejected', message: 'Fixture rejection' }, evidence });
      return Promise.reject(Object.assign(new Error('Fixture rejection'), { code: 'provider_rejected', evidence }));
    }
    return new Promise((resolve) => { this.resolve = resolve; });
  }
  settle(text = 'answer') {
    const turnId = this.current.turnId;
    this.emit('message.committed', { turnId, blocks: [{ type: 'text', text }] });
    this.emit('turn.settled', { turnId, stopReason: 'end_turn', evidence: { accepted: true, settled: true, quiescent: true } });
    this.resolve?.({ stopReason: 'end_turn' });
  }
  async steer(input) { this.steerCalls.push(input); this.steerStarted?.(); await this.steerGate; return { accepted: true, providerTurnId: input.expectedTurnId }; }
  async cancel(input) { this.cancelled = input; return { mode: 'best_effort' }; }
  async answerInteraction() { return {}; }
  events() { return this.queue; }
  snapshot() { return {}; }
  async terminate() { this.closed = true; this.queue.close(); return { ok: true, status: 'terminated', residual: [] }; }
}
const fixtures = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.tasks.close(); await f.service.close(); await f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dueno-task-test-'));
  const workDir = join(root, 'work'); await mkdir(workDir);
  const f = { root, workDir, providers: [], time: Date.now(), options };
  f.open = async () => {
    f.store = new AgentBusStore({ stateDir: join(root, 'bus'), ...options.store }); await f.store.init();
    f.journal = new FileJournalStore({ rootDir: join(root, 'journal') });
    f.service = new SessionService({ journal: f.journal, provider: 'fixture', stateTracker: createSessionStateTracker(), transportFactory: () => {
      const p = new Provider(); if (options.model) p.model = options.model; f.providers.push(p); return p;
    } });
    await f.service.init();
    f.tasks = new TaskService({ store: f.store, sessionServiceForProvider: () => options.binding?.(f) || f.service,
      now: () => f.time, retentionMs: 10, startupTimeoutMs: 500, ...options.task });
    await f.tasks.init();
  };
  f.restart = async () => { await f.tasks.close(); await f.service.close(); await f.store.close(); await f.open(); };
  f.spec = (extra = {}) => ({ provider: 'fixture', model: 'fixture-model', workDir, permissionMode: 'workspace-write', parentRef: { kind: 'user', sessionId: 'parent' }, ...extra });
  f.spawn = (key = 'child', extra = {}) => f.tasks.spawn(null, key, f.spec(extra));
  f.handshake = async (task) => {
    await f.tasks.observeHandshake(task.taskId, { kind: 'fixture', sessionId: task.sessionId, threadId: task.taskId, operation: 'room_context' });
    const { message } = await f.store.createMessage({ threadId: task.taskId, from: { kind: 'fixture', sessionId: task.sessionId }, body: 'startup receipt' });
    await f.tasks.observeHandshake(task.taskId, { kind: 'fixture', sessionId: task.sessionId, threadId: task.taskId, operation: 'room_send', messageId: message.id });
    f.providers.find((p) => p.spec.sessionId === task.sessionId).settle('bootstrap only');
    await until(() => f.service.get(task.sessionId).turns.find((turn) => turn.idempotencyKey.startsWith('bootstrap:'))?.status === 'settled');
    await f.tasks.reconcile(task.taskId);
  };
  await f.open(); fixtures.push(f); return f;
}
async function until(check) {
  for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('Fixture did not settle');
}
async function finish(f, task, answer = 'durable answer') {
  const p = f.providers.find((p) => p.spec.sessionId === task.sessionId);
  const turnId = p.current.turnId;
  p.settle(answer);
  await until(() => ['settled', 'cancelled'].includes(f.service.get(task.sessionId).turns.find((turn) => turn.turnId === turnId)?.status));
  await f.tasks.reconcile(task.taskId);
}

test('concurrent spawn and retry after restart preserve task identity without a second launch', async () => {
  const f = await fixture();
  const spawned = await Promise.all(Array.from({ length: 5 }, () => f.spawn()));
  assert.equal(new Set(spawned.map((task) => task.taskId)).size, 1);
  assert.equal(f.providers.length, 1);
  const task = spawned[0];
  assert.equal(task.startup.state, 'awaiting_handshake');
  assert.equal(f.providers[0].calls.length, 1);
  await f.restart();
  const retried = await f.spawn();
  assert.equal(retried.taskId, task.taskId);
  assert.equal(retried.state, 'unknown');
  assert.equal(f.providers.length, 1);
});

test('bootstrap requires exact authenticated room read then reply and gates ordinary task input', async () => {
  const f = await fixture();
  const task = await f.spawn('initial', { initialPrompt: 'actual work' });
  assert.equal(f.providers[0].calls.length, 1);
  assert.match(f.providers[0].calls[0].idempotencyKey, /^bootstrap:/);
  await assert.rejects(f.tasks.observeHandshake(task.taskId, { kind: 'fixture', sessionId: 'impostor', threadId: task.taskId, operation: 'room_context' }), { code: 'handshake_identity_mismatch' });
  await f.handshake(task);
  assert.equal((await f.tasks.status(task.taskId)).startup.state, 'ready');
  assert.equal(f.providers[0].calls.length, 2);
  assert.equal(f.providers[0].calls[1].blocks[0].text, 'actual work');
  assert.equal((await f.tasks.wait([task.taskId])).results.length, 0);
  await finish(f, task);
  assert.equal((await f.tasks.wait([task.taskId])).results.length, 1);
});

test('handshake mismatch and missing room evidence fail closed', async () => {
  const f = await fixture({ model: 'wrong-model' });
  const task = await f.spawn(); await f.handshake(task);
  assert.equal((await f.tasks.status(task.taskId)).startup.error.code, 'model_mismatch');
  await assert.rejects(f.tasks.send(task.taskId, 'work', 'work'), { code: 'task_not_admitting' });
  const other = await f.spawn('missing'); f.time += 600;
  await f.tasks.reconcile(other.taskId);
  assert.equal((await f.tasks.status(other.taskId)).startup.error.code, 'handshake_timeout');
});

test('busy mailbox stays FIFO, duplicate sends persist once, and accepted means provider evidence', async () => {
  const f = await fixture(); const task = await f.spawn(); await f.handshake(task);
  const p = f.providers[0]; p.loseAdmission = true;
  const first = await f.tasks.send(task.taskId, 'one', 'one');
  assert.equal(first.metadata.state, 'queued');
  const duplicate = await f.tasks.send(task.taskId, 'one', 'different body');
  assert.equal(duplicate.id, first.id);
  await f.tasks.send(task.taskId, 'two', 'two');
  assert.equal(p.calls.length, 2);
  p.emit('turn.started', { turnId: p.current.turnId, evidence: { accepted: true } });
  await until(() => f.service.get(task.sessionId).turns.at(-1).evidence.accepted);
  await f.tasks.reconcile(task.taskId);
  assert.equal(f.store.getMessage(first.id).metadata.state, 'accepted');
  await finish(f, task, 'one done');
  assert.equal(p.calls.length, 3);
  assert.equal(p.current.blocks[0].text, 'two');
  assert.equal(f.store.getThread(task.taskId).deliveries.length, 0);
});

test('steering bypasses a busy ordinary queue only with the expected provider turn', async () => {
  const f = await fixture(); const task = await f.spawn(); await f.handshake(task);
  await f.tasks.send(task.taskId, 'one', 'one');
  await until(() => f.service.get(task.sessionId).turns.at(-1).providerTurnId);
  const turnId = f.service.get(task.sessionId).activeTurnId;
  await f.tasks.send(task.taskId, 'two', 'two');
  await assert.rejects(f.tasks.send(task.taskId, 'bad', 'steer', { mode: 'steer', expectedTurnId: 'wrong' }), { code: 'turn_mismatch' });
  const steer = await f.tasks.send(task.taskId, 'steer', 'direction', { mode: 'steer', expectedTurnId: turnId });
  assert.equal(steer.metadata.state, 'accepted');
  assert.equal(f.providers[0].steerCalls[0].expectedTurnId, `p-${turnId}`);
  await f.tasks.send(task.taskId, 'steer', 'direction', { mode: 'steer', expectedTurnId: turnId });
  assert.equal(f.providers[0].steerCalls.length, 1);
  await finish(f, task);
  assert.equal(f.store.getMessage(steer.id).metadata.state, 'completed');
});

test('lost admission acknowledgment and provider EOF stay unknown without replay', async () => {
  const f = await fixture(); const task = await f.spawn(); await f.handshake(task);
  f.providers[0].loseAdmission = true;
  const message = await f.tasks.send(task.taskId, 'lost', 'side effect');
  f.providers[0].queue.close();
  await until(() => f.service.get(task.sessionId).lifecycle === 'interrupted');
  await f.tasks.reconcile(task.taskId);
  assert.equal(f.store.getMessage(message.id).metadata.state, 'unknown');
  await f.restart();
  assert.equal((await f.tasks.send(task.taskId, 'lost', 'side effect')).id, message.id);
  assert.equal(f.providers[0].calls.length, 2);
  assert.equal((await f.tasks.wait([task.taskId])).results[0].data.state, 'unknown');
});

test('journal-before-publish outbox survives closed parent, compaction, restart and duplicate reconciliation', async () => {
  const f = await fixture();
  const parent = await f.store.createThread({ title: 'parent' });
  const task = await f.spawn('outbox', { threadId: parent.id }); await f.handshake(task);
  await f.tasks.send(task.taskId, 'work', 'work');
  await f.store.closeThread(parent.id);
  await finish(f, task, 'survives restart');
  assert.equal(f.store.getThread(parent.id).messages.length, 0);
  await f.journal.append(task.sessionId, { type: 'diagnostic.appended', data: { entry: { message: 'later' } } });
  await f.journal.compact(task.sessionId, { retain: 1 });
  await f.restart();
  await f.store.reopenThread(parent.id);
  await f.tasks.reconcile(); await f.tasks.reconcile();
  const results = f.store.getThread(parent.id).messages.filter((m) => m.type === 'result');
  assert.equal(results.length, 1);
  assert.match(results[0].body, /survives restart/);
  assert.equal((await f.tasks.wait([task.taskId])).results[0].data.state, 'completed');
});

test('wait cursor is a vector across independent journals and replacement attempts, consumption persists', async () => {
  const f = await fixture(); const a = await f.spawn('a'); const b = await f.spawn('b');
  await f.handshake(a); await f.handshake(b);
  await f.tasks.send(a.taskId, 'a', 'a'); await finish(f, a);
  await f.tasks.send(b.taskId, 'b', 'b'); await finish(f, b);
  const first = await f.tasks.wait([a.taskId, b.taskId]); assert.equal(first.results.length, 2);
  await f.tasks.wait([a.taskId, b.taskId], first.cursor);
  await f.restart();
  assert.equal((await f.tasks.wait([a.taskId, b.taskId])).results.length, 0);
  const replacement = await f.tasks.resume(a.taskId, 'replace');
  assert.notEqual(replacement.sessionId, a.sessionId);
  assert.equal(replacement.taskId, a.taskId);
  assert.equal(f.providers.at(-1).attached, a.providerThreadId);
  assert.equal((await f.tasks.resume(a.taskId, 'replace')).sessionId, replacement.sessionId);
  assert.equal(f.providers.at(-1).calls.length, 1);
  await f.handshake(replacement);
  await f.tasks.send(a.taskId, 'new', 'new'); await finish(f, replacement);
  const next = await f.tasks.wait([a.taskId, b.taskId], first.cursor);
  assert.equal(next.results.length, 1);
  assert.equal(next.results[0].attemptId, replacement.attemptId);
  assert.equal(Object.keys(JSON.parse(Buffer.from(next.cursor, 'base64url')).cursors).length, 3);
});

test('cancellation persists before interrupt, fences queued work and keeps late completion output', async () => {
  const f = await fixture(); const task = await f.spawn(); await f.handshake(task);
  await f.tasks.send(task.taskId, 'one', 'one');
  const pending = await f.tasks.send(task.taskId, 'two', 'two');
  assert.equal((await f.tasks.cancel(task.taskId, 'cancel')).state, 'cancelling');
  assert.equal(f.store.getMessage(pending.id).metadata.state, 'cancelled');
  await assert.rejects(f.tasks.send(task.taskId, 'three', 'three'), { code: 'task_not_admitting' });
  await finish(f, task, 'late receipt');
  assert.equal((await f.tasks.status(task.taskId)).state, 'cancelled');
  assert.equal(f.providers[0].calls.length, 2);
  assert.match(JSON.stringify((await f.tasks.wait([task.taskId])).results), /late receipt/);
  await f.restart();
  await assert.rejects(f.tasks.resume(task.taskId, 'resume'), { code: 'task_cancelled' });
  assert.equal((await f.tasks.cancel(task.taskId, 'cancel')).state, 'cancelled');
});

test('bounded descendant scopes reject expansion and cancellation traverses only descendants', async () => {
  const f = await fixture();
  const parent = await f.spawn('parent', { scope: { providers: ['fixture'], workDirs: [f.workDir], maxDepth: 1, maxChildren: 1 } });
  await f.handshake(parent);
  const child = await f.tasks.spawn(parent.taskId, 'child', f.spec());
  await assert.rejects(f.tasks.spawn(parent.taskId, 'second', f.spec()), { code: 'task_scope_denied' });
  await assert.rejects(f.tasks.spawn(child.taskId, 'grandchild', f.spec()), { code: 'task_scope_denied' });
  const unrelated = await f.spawn('unrelated');
  await f.tasks.cancel(parent.taskId, 'stop-tree', 'descendants');
  assert.ok((await f.tasks.status(child.taskId)).cancel);
  assert.equal((await f.tasks.status(unrelated.taskId)).cancel, null);
});

test('deletion is blocked until consumed retention and preserves task tombstone identity', async () => {
  const f = await fixture(); const task = await f.spawn(); await f.handshake(task);
  await f.tasks.send(task.taskId, 'work', 'work'); await finish(f, task);
  await assert.rejects(f.store.deleteThread(task.taskId), { code: 'task_retained' });
  await assert.rejects(f.service.delete(task.sessionId), { code: 'task_retained' });
  await assert.rejects(f.journal.deleteSession(task.sessionId), { code: 'task_retained' });
  assert.equal(f.providers[0].closed, false);
  await assert.rejects(f.tasks.release(task.taskId), { code: 'task_retained' });
  const result = await f.tasks.wait([task.taskId]);
  await f.tasks.wait([task.taskId], result.cursor);
  f.time += 1000;
  await f.service.terminate(task.sessionId);
  await f.tasks.reconcile();
  await f.tasks.release(task.taskId);
  await f.service.delete(task.sessionId);
  assert.equal(await f.store.deleteThread(task.taskId), true);
  assert.ok((await f.spawn()).tombstone);
  assert.equal(f.providers.length, 1);
});

test('wait rejects forged future and cross-task cursors; timeout does not fabricate completion', async () => {
  const f = await fixture(); const task = await f.spawn(); await f.handshake(task);
  const first = await f.tasks.wait([task.taskId]);
  const value = JSON.parse(Buffer.from(first.cursor, 'base64url'));
  for (const key of Object.keys(value.cursors)) value.cursors[key] += 10000;
  await assert.rejects(f.tasks.wait([task.taskId], Buffer.from(JSON.stringify(value)).toString('base64url')), { code: 'invalid_cursor' });
  const other = await f.spawn('other');
  await assert.rejects(f.tasks.wait([other.taskId], first.cursor), { code: 'invalid_cursor' });
  const timeout = await f.tasks.wait([task.taskId], first.cursor, 10);
  assert.equal(timeout.timedOut, true); assert.equal(timeout.results.length, 0);
});

test('lost launch acknowledgment keeps one intent and does not blindly launch again', async () => {
  const f = await fixture({ binding: (value) => ({ service: value.service, start: async (spec) => {
    await value.service.start(spec); throw new Error('launch acknowledgment lost');
  } }) });
  const task = await f.spawn(); assert.equal(task.state, 'unknown');
  assert.equal((await f.spawn()).taskId, task.taskId);
  assert.equal(f.providers.length, 1);
  await f.restart();
  assert.equal((await f.spawn()).taskId, task.taskId);
  assert.equal(f.providers.length, 1);
});

test('concurrent descendant spawns cannot exceed the parent bound', async () => {
  const f = await fixture();
  const parent = await f.spawn('parent', { scope: { providers: ['fixture'], workDirs: [f.workDir], maxDepth: 1, maxChildren: 1 } });
  const results = await Promise.allSettled(['a', 'b'].map((key) => f.tasks.spawn(parent.taskId, key, f.spec())));
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.find((item) => item.status === 'rejected').reason.code, 'task_scope_denied');
});

test('mailbox overload rejects explicitly and cancellation key cannot silently expand scope', async () => {
  const f = await fixture({ task: { mailboxLimit: 1 } }); const task = await f.spawn();
  await f.tasks.send(task.taskId, 'one', 'queued during bootstrap');
  await assert.rejects(f.tasks.send(task.taskId, 'two', 'too much'), { code: 'mailbox_full' });
  await f.tasks.cancel(task.taskId, 'once');
  await assert.rejects(f.tasks.cancel(task.taskId, 'once', 'descendants'), { code: 'idempotency_conflict' });
});

test('a child cannot acknowledge its own result as parent consumption', async () => {
  const f = await fixture(); const task = await f.spawn(); await f.handshake(task);
  const first = await f.tasks.wait([task.taskId]);
  await assert.rejects(f.tasks.wait([task.taskId], first.cursor, 0, { consumerId: `fixture:${task.sessionId}` }), { code: 'task_scope_denied' });
  await f.tasks.wait([task.taskId], first.cursor, 0, { consumerId: 'user:parent' });
  assert.ok(Object.keys((await f.tasks.status(task.taskId)).consumed).length);
});

test('provider reroute metadata remains current and survives journal rebuild', async () => {
  const f = await fixture(); const task = await f.spawn(); await f.handshake(task);
  f.providers[0].emit('diagnostic', { kind: 'model_rerouted', effectiveModel: 'rerouted-model', modelEvidence: { source: 'model/rerouted' } });
  await until(() => f.service.get(task.sessionId).negotiated.effectiveModel === 'rerouted-model');
  assert.equal((await f.tasks.status(task.taskId)).effectiveModel, 'rerouted-model');
  assert.equal(f.service.get(task.sessionId).canonicalState.runtime.effectiveModel, 'rerouted-model');
  await f.restart();
  assert.equal((await f.tasks.status(task.taskId)).modelEvidence.source, 'model/rerouted');
  // A fresh tracker is rebuilt from the journal alone: interrupted, not sendable.
  const rebuilt = f.service.get(task.sessionId).canonicalState;
  assert.deepEqual([rebuilt.status, rebuilt.runtime.effectiveModel, rebuilt.capabilities.sendMessage], ['ended', 'rerouted-model', false]);
});


test('managed room closure rejects while task history is retained', async () => {
  const f = await fixture(); const task = await f.spawn(); await f.handshake(task);
  await f.tasks.send(task.taskId, 'one', 'one');
  await f.tasks.send(task.taskId, 'two', 'two');
  await assert.rejects(f.store.closeThread(task.taskId), { code: 'task_retained', statusCode: 409 });
  assert.equal(f.store.getThread(task.taskId).thread.status, 'open');
});


test('explicit provider failure evidence waits for its terminal event instead of racing interruption', async () => {
  const f = await fixture(); const task = await f.spawn(); await f.handshake(task);
  f.providers[0].rejectPrompt = 'known';
  await f.tasks.send(task.taskId, 'rejected', 'reject');
  await until(() => f.service.get(task.sessionId).turns.at(-1).status === 'settled');
  assert.equal(f.service.get(task.sessionId).lifecycle, 'ready');
  f.providers[0].rejectPrompt = false;
  await f.tasks.send(task.taskId, 'next', 'next');
  assert.equal(f.providers[0].calls.at(-1).blocks[0].text, 'next');
});

test('close terminates an owned transport even when a lost acknowledgment interrupted its projection', async () => {
  const f = await fixture(); const task = await f.spawn(); await f.handshake(task);
  f.providers[0].rejectPrompt = 'unknown';
  await f.tasks.send(task.taskId, 'lost', 'lost');
  await until(() => f.service.get(task.sessionId).lifecycle === 'interrupted');
  assert.equal(f.providers[0].closed, false);
  await f.tasks.close(); await f.service.close();
  assert.equal(f.providers[0].closed, true);
});


test('recovery journals a newer resolved outcome on the old attempt without replaying lost work', async () => {
  const f = await fixture(); const task = await f.spawn(); await f.handshake(task);
  await f.tasks.send(task.taskId, 'work', 'side effect');
  await until(() => f.service.get(task.sessionId).turns.at(-1).providerTurnId);
  await f.providers[0].completeWithoutReceipt('completed remotely before disconnect');
  await until(() => f.service.get(task.sessionId).lifecycle === 'interrupted');
  const before = await f.tasks.wait([task.taskId]);
  assert.equal(before.results.at(-1).data.state, 'unknown');
  await f.restart();
  const resumed = await f.tasks.resume(task.taskId, 'recover');
  const after = await f.tasks.wait([task.taskId], before.cursor);
  const result = after.results.find((event) => event.data.state === 'completed');
  assert.ok(result); assert.equal(result.sessionId, task.sessionId);
  assert.equal(result.attemptId, task.attemptId);
  assert.equal(result.data.resolutionOf, before.results.at(-1).data.resultKey);
  assert.match(JSON.stringify(result.data.output), /completed remotely before disconnect/);
  assert.notEqual(resumed.sessionId, task.sessionId);
  assert.equal(f.providers[0].calls.length, 2);
  assert.equal(f.providers[1].calls.length, 1, JSON.stringify(resumed.startup));
  await f.tasks.reconcile();
  assert.equal((await f.tasks.wait([task.taskId])).results.filter((event) => event.data.state === 'completed').length, 1);
});

test('resume attaches only to a provider conversation proven by a settled turn', async () => {
  const f = await fixture(); const task = await f.spawn();
  // The bootstrap turn never settled, so the provider may hold no conversation: start fresh.
  await f.service.terminate(task.sessionId);
  const fresh = await f.tasks.resume(task.taskId, 'fresh');
  assert.equal(f.providers.at(-1).attached, undefined);
  await f.handshake(fresh);
  const proven = f.providers.at(-1).threadId;
  await f.service.terminate(fresh.sessionId);
  const attached = await f.tasks.resume(task.taskId, 'attach');
  assert.equal(f.providers.at(-1).attached, proven);
  // A failed attempt with no settled turn falls back to the latest earlier proven conversation.
  await f.service.terminate(attached.sessionId);
  await f.tasks.resume(task.taskId, 'again');
  assert.equal(f.providers.at(-1).attached, proven);
});

test('replacement parent retains child spawn identity and can consume existing child results', async () => {
  const f = await fixture();
  const parent = await f.spawn('parent', { scope: { providers: ['fixture'], workDirs: [f.workDir], maxDepth: 1, maxChildren: 2 } });
  await f.handshake(parent);
  const child = await f.tasks.spawn(parent.taskId, 'child', f.spec()); await f.handshake(child);
  await f.tasks.send(child.taskId, 'work', 'work'); await finish(f, child);
  await f.service.terminate(parent.sessionId);
  const replacement = await f.tasks.resume(parent.taskId, 'replace');
  assert.equal((await f.tasks.spawn(parent.taskId, 'child', f.spec())).taskId, child.taskId);
  assert.equal(f.providers.length, 3);
  assert.equal((await f.tasks.status(child.taskId)).currentParentRef.sessionId, replacement.sessionId);
  await assert.rejects(f.tasks.wait([child.taskId], null, 0, { consumerId: `fixture:${parent.sessionId}` }), { code: 'task_scope_denied' });
  const received = await f.tasks.wait([child.taskId], null, 0, { consumerId: `fixture:${replacement.sessionId}` });
  assert.equal(received.results.length, 1);
});

test('generic session ingress cannot bypass task cancellation with a forged source string', async () => {
  const f = await fixture(); const task = await f.spawn(); await f.handshake(task);
  await f.tasks.send(task.taskId, 'work', 'work'); await finish(f, task);
  await f.tasks.cancel(task.taskId, 'done');
  for (const source of ['api', 'agent_bus', 'task', 'task_bootstrap']) {
    await assert.rejects(f.service.prompt(task.sessionId, { blocks: [{ type: 'text', text: 'bypass' }], idempotencyKey: source, source }), { code: 'task_managed' });
  }
  assert.equal(f.providers[0].calls.length, 2);
});

test('late permission callbacks after cancellation retain evidence without reopening admission', async () => {
  const f = await fixture(); const task = await f.spawn(); await f.handshake(task);
  await f.tasks.send(task.taskId, 'work', 'work');
  const turnId = f.service.get(task.sessionId).activeTurnId;
  await f.tasks.cancel(task.taskId, 'stop');
  f.providers[0].emit('interaction.requested', { turnId, interactionId: 'late-permission', kind: 'permission', toolCall: { title: 'late side effect' }, options: [] });
  await until(async () => (await f.service.cursor(task.sessionId)).events.some((event) => event.data?.event?.interactionId === 'late-permission'));
  assert.equal(f.service.get(task.sessionId).interactions.some((item) => item.status === 'open'), false);
});


async function diagnosticBurst(f, task, count = 150) {
  const provider = f.providers.find((p) => p.spec.sessionId === task.sessionId);
  const observed = new Promise((resolve) => {
    const unsubscribe = f.service.subscribe((session, event) => {
      if (session.id === task.sessionId && event.data?.event?.message === `burst-${count - 1}`) {
        unsubscribe(); resolve();
      }
    });
  });
  for (let i = 0; i < count; i++) provider.emit('diagnostic', { message: `burst-${i}` });
  await observed;
}

test('observation bursts do not bury authenticated handshake or journal waits behind store writes', async () => {
  const f = await fixture({ store: { persistDebounceMs: 10 }, task: { startupTimeoutMs: 1500, now: Date.now } });
  const task = await f.spawn();
  const { message } = await f.store.createMessage({ threadId: task.taskId,
    from: { kind: 'fixture', sessionId: task.sessionId }, body: 'authenticated startup reply' });
  await diagnosticBurst(f, task);
  assert.ok(Date.now() < task.startup.deadline);
  const started = Date.now();
  const read = f.tasks.observeHandshake(task.taskId, { kind: 'fixture', sessionId: task.sessionId, threadId: task.taskId, operation: 'room_context' });
  const reply = f.tasks.observeHandshake(task.taskId, { kind: 'fixture', sessionId: task.sessionId, threadId: task.taskId, operation: 'room_send', messageId: message.id });
  const page = await f.tasks.wait([task.taskId], null, 5);
  assert.ok(Date.now() - started < 300, 'wait must not drain the observation queue');
  assert.ok(page.events.length);
  assert.equal(Object.hasOwn(page.states[0], 'negotiated'), false);
  assert.ok((await f.tasks.status(task.taskId)).negotiated.protocol.version);
  assert.deepEqual((await f.tasks.status(task.taskId)).consumed, {});
  await read; await reply;
  assert.equal((await f.tasks.status(task.taskId)).startup.state, 'ready');
});

test('unchanged completed tasks do not rewrite mailbox, result publication or task metadata', async () => {
  const f = await fixture({ store: { persistDebounceMs: 10 }, task: { startupTimeoutMs: 5000 } });
  const task = await f.spawn(); await f.handshake(task);
  await f.tasks.send(task.taskId, 'work', 'work'); await finish(f, task, 'RETAINED');
  await f.tasks.reconcile(task.taskId);
  const before = await stat(f.store.stateFile, { bigint: true });
  await diagnosticBurst(f, task);
  const page = await f.tasks.wait([task.taskId], null, 5);
  assert.equal(page.results.length, 1);
  await f.tasks.reconcile(task.taskId);
  assert.equal((await stat(f.store.stateFile, { bigint: true })).mtimeNs, before.mtimeNs);
  assert.equal(f.store.getThread(task.taskId).messages.filter((m) => m.metadata?.taskResult).length, 1);
  assert.deepEqual((await f.tasks.status(task.taskId)).consumed, {});
  await f.restart();
  assert.equal((await f.tasks.wait([task.taskId])).results.length, 1);
});

test('expired queued cursor acknowledgment cannot mutate consumption after the task lock releases', async () => {
  const f = await fixture({ task: { startupTimeoutMs: 5000 } });
  const task = await f.spawn(); await f.handshake(task);
  await f.tasks.send(task.taskId, 'work', 'work');
  const first = await f.tasks.wait([task.taskId]);
  const provider = f.providers[0];
  let release, entered;
  provider.steerGate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  provider.steerStarted = entered;
  const steering = f.tasks.send(task.taskId, 'steer', 'steer', { type: 'steer', expectedTurnId: provider.current.turnId });
  await started;
  try {
    for (const timeout of [15, 0]) {
      const start = Date.now();
      await assert.rejects(f.tasks.wait([task.taskId], first.cursor, timeout), { code: 'task_wait_timeout' });
      assert.ok(Date.now() - start < (timeout ? 300 : 2000), 'even a zero-time poll bounds acknowledgment processing');
    }
  } finally { release(); }
  await steering; await f.tasks.reconcile(task.taskId);
  assert.deepEqual((await f.tasks.status(task.taskId)).consumed, {});
  await f.tasks.wait([task.taskId], first.cursor, 100);
  assert.deepEqual((await f.tasks.status(task.taskId)).consumed, JSON.parse(Buffer.from(first.cursor, 'base64url')).cursors);
});

test('zero-time wait sees a result published only after reconciliation', async () => {
  const f = await fixture({ task: { startupTimeoutMs: 5000 } });
  const task = await f.spawn(); await f.handshake(task);
  await f.tasks.send(task.taskId, 'work', 'work');
  await until(() => f.service.get(task.sessionId).turns.at(-1).providerTurnId);
  const turnId = f.service.get(task.sessionId).activeTurnId;
  let release;
  f.providers[0].steerGate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { f.providers[0].steerStarted = resolve; });
  const steering = f.tasks.send(task.taskId, 'steer', 'steer', { mode: 'steer', expectedTurnId: turnId });
  await started;
  f.providers[0].settle('visible after reconcile');
  await until(() => ['settled', 'cancelled'].includes(
    f.service.get(task.sessionId).turns.find((turn) => turn.turnId === turnId)?.status,
  ));
  setTimeout(release, 25);
  const page = await f.tasks.wait([task.taskId], null, 0);
  await steering;
  assert.equal(page.results.at(-1).data.state, 'completed');
});

test('in-flight cursor persistence reports timeout truthfully and permits idempotent confirmation', async () => {
  const f = await fixture({ task: { startupTimeoutMs: 5000 } });
  const task = await f.spawn(); await f.handshake(task);
  const first = await f.tasks.wait([task.taskId]);
  await f.tasks.reconcile(task.taskId);
  f.store.persistDebounceMs = 100;
  await assert.rejects(f.tasks.wait([task.taskId], first.cursor, 10), { code: 'task_wait_timeout' });
  await f.store.persist();
  f.store.persistDebounceMs = 0;
  await f.tasks.wait([task.taskId], first.cursor, 100);
  const expected = JSON.parse(Buffer.from(first.cursor, 'base64url')).cursors;
  assert.deepEqual((await f.tasks.status(task.taskId)).consumed, expected);
  await f.store.init();
  assert.deepEqual((await f.tasks.status(task.taskId)).consumed, expected);
});


test('release and close discard optimization caches while retained task outcomes survive deletion and restart', async () => {
  const f = await fixture({ task: { startupTimeoutMs: 5000 } });
  const released = await f.spawn('released'); await f.handshake(released);
  const sent = await f.tasks.send(released.taskId, 'work', 'released prompt payload');
  await finish(f, released, 'released outcome');
  const retained = await f.spawn('retained'); await f.handshake(retained);
  await f.tasks.send(retained.taskId, 'work', 'retained prompt payload');
  await finish(f, retained, 'retained outcome');
  const first = await f.tasks.wait([released.taskId]);
  const other = await f.tasks.wait([retained.taskId]);
  await f.tasks.wait([released.taskId], first.cursor);
  assert.ok(f.tasks.savedMetadata.has(sent.id));
  assert.ok(f.tasks.publishedResults.has(first.results[0].data.resultKey));
  f.time += 1000;
  await f.service.terminate(released.sessionId);
  await f.tasks.reconcile(released.taskId);
  await f.tasks.release(released.taskId);
  assert.equal(f.tasks.savedMetadata.has(released.taskId), false);
  assert.equal(f.tasks.savedMetadata.has(sent.id), false);
  assert.equal(f.tasks.publishedResults.has(first.results[0].data.resultKey), false);
  assert.ok(f.tasks.savedMetadata.has(retained.taskId));
  assert.ok(f.tasks.publishedResults.has(other.results[0].data.resultKey));
  await f.service.delete(released.sessionId);
  await f.store.deleteThread(released.taskId);
  await f.tasks.reconcile(released.taskId);
  assert.equal(f.tasks.savedMetadata.has(released.taskId), false);
  assert.deepEqual((await f.tasks.wait([retained.taskId])).results, other.results);
  const previousTasks = f.tasks;
  await f.restart();
  assert.equal(previousTasks.savedMetadata.size, 0);
  assert.equal(previousTasks.publishedResults.size, 0);
  assert.ok((await f.spawn('released')).tombstone);
  assert.deepEqual((await f.tasks.wait([retained.taskId])).results, other.results);
});
