import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';

async function room(harness, participants, metadata = {}) {
  const response = await harness.app.inject({ method: 'POST', url: '/api/agent-bus/threads', headers: harness.authHeaders,
    payload: { title: 'room', participants, metadata } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().thread;
}

test('participant directory lists adapter-backed session rosters', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  const response = await h.app.inject({ method: 'GET', url: '/api/agent-bus/participants', headers: h.authHeaders });
  assert.equal(response.statusCode, 200, response.body);
  const payload = response.json();
  assert.deepEqual(payload.supportedKinds, ['claude', 'codex', 'pi', 'deepseek', 'codex-app-server']);
  assert.equal(payload.sessions.codex[0].id, 'codex-1');
});

test('room broadcasts create one message and N-1 deliveries', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  h.sessionCatalog.pi.add('pi-2');
  const thread = await room(h, [{ kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' }, { kind: 'pi', sessionId: 'pi-2' }]);
  const response = await h.app.inject({ method: 'POST', url: '/api/agent-bus/messages', headers: h.authHeaders,
    payload: { threadId: thread.id, from: { kind: 'codex', sessionId: 'codex-1' }, body: 'hello' } });
  assert.equal(response.statusCode, 200, response.body);
  const snapshot = h.store.getThread(thread.id);
  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.messages[0].type, 'message');
  assert.equal('to' in snapshot.messages[0], false);
  assert.equal(snapshot.deliveries.length, 2);
  assert.deepEqual(new Set(snapshot.deliveries.map((item) => item.status)), new Set(['injected']));
});

test('dead target fails its delivery and leaves room open', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  const thread = await room(h, [{ kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'dead' }]);
  await h.app.inject({ method: 'POST', url: '/api/agent-bus/messages', headers: h.authHeaders,
    payload: { threadId: thread.id, from: { kind: 'codex', sessionId: 'codex-1' }, body: 'hello' } });
  assert.equal(h.store.getThread(thread.id).deliveries[0].status, 'failed');
  assert.equal(h.store.getThread(thread.id).thread.status, 'open');
});

test('busy target remains queued and later messages preserve single-flight FIFO', async (t) => {
  const h = await createAgentBusHarness({ pollMs: 20 }); t.after(() => h.cleanup());
  h.sessionStates.claude.set('claude-1', { state: 'working', needsInput: false });
  const thread = await room(h, [{ kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' }]);
  for (const body of ['one', 'two']) await h.app.inject({ method: 'POST', url: '/api/agent-bus/messages', headers: h.authHeaders,
    payload: { threadId: thread.id, from: { kind: 'codex', sessionId: 'codex-1' }, body } });
  const deliveries = h.store.getThread(thread.id).deliveries;
  assert.deepEqual(deliveries.map((item) => item.status), ['queued', 'queued']);
  assert.equal(deliveries[0].holdReason, 'target_busy');
  assert.equal(deliveries[0].willInjectWhenIdle, true);
  assert.equal(h.injected.claude.length, 0);
});

test('close archives without terminating; end skips participants shared with another open non-DM room', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  const refs = [{ kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' }];
  const first = await room(h, refs);
  const closed = await h.app.inject({ method: 'POST', url: `/api/agent-bus/threads/${first.id}/close`, headers: h.authHeaders, payload: {} });
  assert.equal(closed.statusCode, 200); assert.deepEqual(h.deletedSessions.codex, []); assert.deepEqual(h.deletedSessions.claude, []);
  const second = await room(h, refs); await room(h, [{ kind: 'codex', sessionId: 'codex-1' }, { kind: 'pi', sessionId: 'pi-1' }]);
  const ended = await h.app.inject({ method: 'POST', url: `/api/agent-bus/threads/${second.id}/end`, headers: h.authHeaders, payload: {} });
  assert.equal(ended.statusCode, 200, ended.body);
  assert.deepEqual(ended.json().skipped, [{ kind: 'codex', sessionId: 'codex-1' }]);
  assert.deepEqual(h.deletedSessions.claude, ['claude-1']);
});

test('DM get-or-create is idempotent, rejects self-DM, reopens archived pair rooms, and 404s unknown targets', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  const payload = { from: { kind: 'codex', sessionId: 'codex-1' }, target: { kind: 'claude', sessionId: 'claude-1' }, body: 'hi' };
  const one = await h.app.inject({ method: 'POST', url: '/api/agent-bus/dm', headers: h.authHeaders, payload });
  const two = await h.app.inject({ method: 'POST', url: '/api/agent-bus/dm', headers: h.authHeaders, payload: { ...payload, body: 'again' } });
  assert.equal(one.json().thread.id, two.json().thread.id);
  const self = await h.app.inject({ method: 'POST', url: '/api/agent-bus/dm', headers: h.authHeaders,
    payload: { ...payload, target: payload.from } });
  assert.equal(self.statusCode, 400);
  await h.app.inject({ method: 'POST', url: `/api/agent-bus/threads/${one.json().thread.id}/close`, headers: h.authHeaders, payload: {} });
  const reopened = await h.app.inject({ method: 'POST', url: '/api/agent-bus/dm', headers: h.authHeaders, payload });
  assert.equal(reopened.json().thread.id, one.json().thread.id);
  assert.equal(reopened.json().thread.status, 'open');
  const missing = await h.app.inject({ method: 'POST', url: '/api/agent-bus/dm', headers: h.authHeaders,
    payload: { from: payload.from, target: { kind: 'claude', sessionId: 'no-such' }, body: 'x' } });
  assert.equal(missing.statusCode, 404);
});

test('human DM participants stay in the roster without injection deliveries or failure alerts', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  const opened = await h.app.inject({ method: 'POST', url: '/api/agent-bus/dm', headers: h.authHeaders, payload: {
    from: { kind: 'user', sessionId: 'dashboard' }, target: { kind: 'codex', sessionId: 'codex-1' }, body: 'hello',
  } });
  assert.equal(opened.statusCode, 200, opened.body);
  const thread = opened.json().thread;
  assert.deepEqual(thread.participants.map(({ kind, sessionId }) => ({ kind, sessionId })), [
    { kind: 'user', sessionId: 'dashboard' }, { kind: 'codex', sessionId: 'codex-1' },
  ]);

  const reply = await h.app.inject({ method: 'POST', url: '/api/agent-bus/messages', headers: h.authHeaders, payload: {
    threadId: thread.id, from: { kind: 'codex', sessionId: 'codex-1' }, body: 'hi human',
  } });
  assert.equal(reply.statusCode, 200, reply.body);
  assert.deepEqual(reply.json().deliveries, []);
  assert.equal(h.store.getThread(thread.id).deliveries.length, 1);
  assert.equal(h.wsEvents.some((event) => event.channel === 'agent-bus:alerts' && event.type === 'delivery_failed'), false);
});

test('message text and legacy loop metadata have no terminal or controller behavior', async (t) => {
  const h = await createAgentBusHarness({ pollMs: 10 }); t.after(() => h.cleanup());
  const thread = await room(h, [{ kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' }],
    { managerLoop: { status: 'running', phase: 'worker_running' }, source: 'legacy' });
  await h.app.inject({ method: 'POST', url: '/api/agent-bus/messages', headers: h.authHeaders,
    payload: { threadId: thread.id, from: { kind: 'codex', sessionId: 'codex-1' }, body: 'blocked forever' } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const snapshot = h.store.getThread(thread.id);
  assert.equal(snapshot.thread.status, 'open');
  assert.equal(snapshot.thread.metadata.managerLoop, undefined);
  assert.equal(snapshot.thread.metadata.source, 'legacy');
  assert.equal(snapshot.messages.length, 1);
});

test('room send accepts type result and dedupes identical bodies', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  const thread = await room(h, [{ kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' }]);
  const first = await h.app.inject({ method: 'POST', url: '/api/agent-bus/messages', headers: h.authHeaders,
    payload: { threadId: thread.id, from: { kind: 'codex', sessionId: 'codex-1' }, body: 'done', type: 'result' } });
  const second = await h.app.inject({ method: 'POST', url: '/api/agent-bus/messages', headers: h.authHeaders,
    payload: { threadId: thread.id, from: { kind: 'codex', sessionId: 'codex-1' }, body: 'done', type: 'result' } });
  assert.equal(first.json().message.type, 'result');
  assert.equal(second.json().deduped, true);
  const reply = await h.app.inject({ method: 'POST', url: '/api/agent-bus/messages', headers: h.authHeaders,
    payload: { threadId: thread.id, from: { kind: 'codex', sessionId: 'codex-1' }, body: 'done', type: 'result', replyTo: first.json().message.id } });
  assert.equal(reply.json().deduped, undefined);
  const asMessage = await h.app.inject({ method: 'POST', url: '/api/agent-bus/messages', headers: h.authHeaders,
    payload: { threadId: thread.id, from: { kind: 'codex', sessionId: 'codex-1' }, body: 'done' } });
  assert.equal(asMessage.json().deduped, undefined);
  assert.equal(h.store.getThread(thread.id).messages.length, 3);
});

test('killing one participant drops it from the room and fails queued deliveries', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  h.sessionStates.claude.set('claude-1', { state: 'working', needsInput: false });
  const thread = await room(h, [{ kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' }]);
  await h.app.inject({ method: 'POST', url: '/api/agent-bus/messages', headers: h.authHeaders,
    payload: { threadId: thread.id, from: { kind: 'codex', sessionId: 'codex-1' }, body: 'hello' } });
  const killed = await h.app.inject({ method: 'DELETE', url: '/api/claude/sessions/claude-1', headers: h.authHeaders });
  assert.equal(killed.statusCode, 200, killed.body);
  const snapshot = h.store.getThread(thread.id);
  assert.equal(snapshot.thread.status, 'open');
  assert.deepEqual(snapshot.thread.participants, [{ kind: 'codex', sessionId: 'codex-1' }]);
  assert.equal(snapshot.deliveries[0].status, 'failed');
  assert.equal(snapshot.deliveries[0].error, 'session_deleted');
});

test('killing the last agent participant closes the room', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  const thread = await room(h, [{ kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' }]);
  const first = await h.app.inject({ method: 'DELETE', url: '/api/codex/sessions/codex-1', headers: h.authHeaders });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(h.store.getThread(thread.id).thread.status, 'open');
  const killed = await h.app.inject({ method: 'DELETE', url: '/api/claude/sessions/claude-1', headers: h.authHeaders });
  assert.equal(killed.statusCode, 200, killed.body);
  assert.equal(h.store.getThread(thread.id).thread.status, 'closed');
  assert.deepEqual(h.store.getThread(thread.id).thread.participants, []);
});

test('session deletion stays terminal and revokes credentials when room cleanup fails', async (t) => {
  const revocations = [];
  const credentialStore = { async init() {}, readiness() { return {}; },
    async revoke(options) { revocations.push(options); } };
  const h = await createAgentBusHarness({ credentialStore }); t.after(() => h.cleanup());
  await room(h, [{ kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' }]);
  h.store.removeThreadParticipant = async () => { throw new Error('simulated_bus_persist_failure'); };

  const killed = await h.app.inject({ method: 'DELETE', url: '/api/claude/sessions/claude-1', headers: h.authHeaders });

  assert.equal(killed.statusCode, 200, killed.body);
  assert.equal(killed.json().status, 'terminated');
  assert.equal(h.sessionCatalog.claude.has('claude-1'), false);
  assert.deepEqual(revocations, [{ principal: { type: 'agent', kind: 'claude', sessionId: 'claude-1' },
    reason: 'session_deleted' }]);
});

test('hung credential revocation does not prevent bounded room cleanup', async (t) => {
  const credentialStore = { async init() {}, readiness() { return {}; },
    async revoke() { return new Promise(() => {}); } };
  const h = await createAgentBusHarness({ credentialStore, sessionDeleteTimeoutMs: 250 });
  t.after(() => h.cleanup());
  const thread = await room(h, [
    { kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' },
  ]);

  const killed = await h.app.inject({ method: 'DELETE', url: '/api/claude/sessions/claude-1', headers: h.authHeaders });

  assert.equal(killed.statusCode, 200, killed.body);
  assert.equal(killed.json().status, 'terminated');
  assert.deepEqual(h.store.getThread(thread.id).thread.participants, [{ kind: 'codex', sessionId: 'codex-1' }]);
});
