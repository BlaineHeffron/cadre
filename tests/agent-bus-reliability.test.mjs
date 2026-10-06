import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';

const refs = [{ kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' }];
async function setup(t) {
  process.env.INTERNAL_BYPASS_TOKEN = 'fleet-reliability-test-bypass';
  const h = await createAgentBusHarness({ pollMs: 20, credentialStore: { init: async () => {}, revoke: async () => {} } });
  t.after(async () => { await h.cleanup(); delete process.env.INTERNAL_BYPASS_TOKEN; });
  const thread = await h.store.createThread({ title: 'pending review', participants: refs });
  const request = (path, payload = {}, method = 'POST') => h.app.inject({ method,
    url: `/api/agent-bus/${path}`, headers: h.authHeaders, ...(method === 'GET' ? {} : { payload }) });
  const send = (body) => request('messages', { threadId: thread.id, from: refs[0], body });
  return { h, thread, request, send };
}

test('close protects pending reviews; explicit cancellation persists through reopen and reload without replay', async (t) => {
  const { h, thread, request, send } = await setup(t);
  h.sessionStates.claude.set('claude-1', { state: 'working', needsInput: false });
  await send('review one'); await send('review two');
  const rejected = await request(`threads/${thread.id}/close`);
  assert.equal(rejected.statusCode, 409, rejected.body);
  assert.equal(rejected.json().code, 'pending_deliveries');
  assert.equal(h.store.getThread(thread.id).thread.status, 'open');
  const closed = await request(`threads/${thread.id}/close`, { cancelPending: true });
  assert.equal(closed.statusCode, 200, closed.body);
  for (const delivery of h.store.getThread(thread.id).deliveries) {
    assert.equal(delivery.status, 'failed'); assert.equal(delivery.error, 'thread_closed');
    assert.equal(delivery.resolution, 'cancelled'); assert.equal(delivery.holdReason, null);
    assert.equal(delivery.willInjectWhenIdle, false); assert.ok(delivery.cancelledAt);
  }
  assert.equal((await send('late review')).statusCode, 409);
  await assert.rejects(h.store.createMessage({ threadId: thread.id, body: 'late store write' }), /closed/);
  const { AgentBusStore } = await import('../modules/agent-bus/store.mjs');
  const reloaded = new AgentBusStore({ stateDir: h.store.stateDir });
  await reloaded.init(); t.after(() => reloaded.close());
  assert.deepEqual(reloaded.getThread(thread.id).deliveries, h.store.getThread(thread.id).deliveries);
  h.sessionStates.claude.set('claude-1', { state: 'waiting_for_input', needsInput: true });
  for (let i = 0; i < 2; i++) {
    assert.equal((await request(`threads/${thread.id}/reopen`)).json().status, 'open');
    assert.equal((await request(`threads/${thread.id}/close`)).statusCode, 200);
  }
  await request(`threads/${thread.id}/reopen`);
  const replay = await request('deliveries/replay-eligible');
  assert.equal(replay.json().eligibleCount, 0);
  const single = await request(`deliveries/${h.store.getThread(thread.id).deliveries[0].id}/replay`);
  assert.equal(single.statusCode, 409);
  await delay(70);
  assert.equal(h.injected.claude.length, 0);
  assert.equal(h.store.getThread(thread.id).messages.length, 2);
});

test('close rejects injection in flight and preserve its eventual receipt', async (t) => {
  const { h, thread, request, send } = await setup(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  h.inputResponders.claude = async () => { entered(); await gate; return { statusCode: 200, payload: { ok: true } }; };
  const sending = send('review in flight');
  await started;
  try {
    for (const action of ['close']) {
      const response = await request(`threads/${thread.id}/${action}`, action === 'close' ? { cancelPending: true } : {});
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(response.json().code, 'delivery_in_flight');
    }
    assert.equal((await request(`threads/${thread.id}`, {}, 'DELETE')).statusCode, 409);
  } finally { release(); }
  assert.equal((await sending).statusCode, 200);
  // The observer can own the injection while send returns its queued receipt.
  let closed;
  for (let i = 0; i < 30; i++) {
    closed = await request(`threads/${thread.id}/close`);
    if (closed.statusCode !== 409) break;
    await delay(20);
  }
  assert.equal(closed.statusCode, 200, closed.body);
  assert.equal(h.store.getThread(thread.id).deliveries[0].status, 'injected');
  assert.deepEqual(h.deletedSessions.claude, []);
});

test('legacy closed queue resumes only after explicit reopen; held age degrades health', async (t) => {
  const { h, thread, request, send } = await setup(t);
  h.sessionStates.claude.set('claude-1', { state: 'working', needsInput: false });
  await send('old queued review');
  const delivery = h.store.getThread(thread.id).deliveries[0];
  await h.store.updateDelivery(delivery.id, { createdAt: Date.now() - 3600000 });
  const health = (await request(`threads/${thread.id}`, {}, 'GET')).json().thread;
  assert.equal(health.health, 'stale');
  assert.equal(health.metadata.deliveryHealth.queued, 1);
  assert.equal(health.metadata.deliveryHealth.held, 1);
  assert.equal(health.metadata.deliveryHealth.overdue, true);
  assert.ok(health.metadata.deliveryHealth.oldestQueuedAgeMs >= 3600000);
  // Persist the pre-fix legacy state rather than invoking today's terminalizing close.
  h.store.state.threads.find((item) => item.id === thread.id).status = 'closed';
  await h.store.updateDelivery(delivery.id, { lastAttemptAt: null });
  h.sessionStates.claude.set('claude-1', { state: 'waiting_for_input', needsInput: true });
  await delay(80); assert.equal(h.injected.claude.length, 0);
  await request(`threads/${thread.id}/reopen`);
  for (let i = 0; i < 30 && !h.injected.claude.length; i++) await delay(20);
  assert.equal(h.injected.claude.length, 1);
  assert.equal(h.store.getDelivery(delivery.id).status, 'injected');
});

test('DM preserves backend 503 and distinguishes ended sessions from absent sessions', async (t) => {
  const { h, request } = await setup(t);
  const dm = () => request('dm', { from: refs[0], target: refs[1], body: 'review' });
  h.sessionDetailResponders.claude = async () => ({ statusCode: 503, payload: { error: 'backend unavailable' } });
  const unavailable = await dm();
  assert.equal(unavailable.statusCode, 503, unavailable.body);
  assert.match(unavailable.json().message || unavailable.json().error, /backend unavailable/);
  h.sessionDetailResponders.claude = async () => ({ statusCode: 410, payload: { error: 'gone', sessionEnded: true } });
  const ended = await dm();
  assert.equal(ended.statusCode, 410); assert.equal(ended.json().code, 'session_ended');
  h.sessionDetailResponders.claude = async () => ({ statusCode: 404, payload: { error: 'absent' } });
  const missing = await dm();
  assert.equal(missing.statusCode, 404); assert.equal(missing.json().code, 'session_not_found');
});

test('DM to a live session under the wrong kind names the kind instead of reporting it ended', async (t) => {
  const { h, request } = await setup(t);
  h.sessionCatalog.codex.add('codex-2');
  // Real session routes answer unknown ids with a synthetic ended record.
  h.sessionDetailResponders.claude = async ({ sessionId }) => (sessionId === 'codex-2'
    ? { statusCode: 200, payload: { id: sessionId, sessionEnded: true } } : null);
  const wrongKind = await request('dm', { from: refs[0], target: { kind: 'claude', sessionId: 'codex-2' }, body: 'review' });
  assert.equal(wrongKind.statusCode, 404, wrongKind.body);
  assert.deepEqual(wrongKind.json(), { error: 'no claude session codex-2; a codex session with that id exists', code: 'session_kind_mismatch' });
  const unknown = await request('dm', { from: refs[0], target: { kind: 'claude', sessionId: 'no-such' }, body: 'review' });
  assert.equal(unknown.statusCode, 404); assert.equal(unknown.json().code, 'session_not_found');
});

test('MCP close cancellation and outsider reopen reach real routes with scope checks', async (t) => {
  const { h, thread, send } = await setup(t);
  await h.store.transferThread(thread.id, refs[0]);
  h.sessionStates.claude.set('claude-1', { state: 'working', needsInput: false });
  await send('pending');
  const { buildAgentBusMcpServer } = await import('../modules/agent-bus/mcp.mjs');
  const { AGENT_BUS_AGENT_TOOL_SCOPES } = await import('../modules/agent-bus/mcp-auth.mjs');
  const { buildInProcessFastifyRequest } = await import('../modules/agent-bus/in-process-mcp.mjs');
  const server = buildAgentBusMcpServer({ requestImpl: buildInProcessFastifyRequest({ app: h.app, buildHeaders: () => ({ 'x-dueno-internal': 'fleet-reliability-test-bypass', 'x-dueno-internal-ts': new Date().toISOString() }) }) });
  const context = { authenticated: true, principal: { type: 'agent', ...refs[0] },
    toolScopes: [...AGENT_BUS_AGENT_TOOL_SCOPES], threadAllowlist: ['@member'] };
  const args = { thread_id: thread.id };
  const close = async (options) => {
    for (let i = 0; i < 50; i++) {
      try { return await server.callTool('room_close', options, context); }
      catch (error) {
        if (error.code !== 'delivery_in_flight' || i === 49) throw error;
        await delay(20);
      }
    }
  };
  await assert.rejects(close(args), /pending deliveries/);
  await close({ ...args, cancel_pending: true });
  await assert.rejects(server.callTool('room_reopen', args, { ...context, toolScopes: ['room_context'] }), /does not grant/);
  await server.callTool('room_reopen', args, { ...context, principal: { type: 'agent', kind: 'codex', sessionId: 'other' } });
  await server.callTool('room_reopen', args, context);
  const snapshot = await server.callTool('room_context', { ...args, deliveries: true }, context);
  assert.equal(snapshot.structuredContent.thread.status, 'open');
  assert.equal(snapshot.structuredContent.thread.deliveryHealth.cancelled, 1);
  assert.equal(snapshot.structuredContent.deliveries[0].resolution, 'cancelled');
});


test('end fences reopen and deletion until participant termination settles', async (t) => {
  const { h, thread, request, send } = await setup(t);
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  h.deleteResponders.codex = async () => { entered(); await gate; };
  const ending = request(`threads/${thread.id}/end`);
  await started;
  try {
    assert.equal((await request(`threads/${thread.id}/reopen`)).statusCode, 409);
    assert.equal((await request(`threads/${thread.id}`, {}, 'DELETE')).statusCode, 409);
    assert.equal((await request(`threads/${thread.id}/end`)).statusCode, 409);
    assert.equal((await send('late work')).statusCode, 409);
  } finally { release(); }
  assert.equal((await ending).json().status, 'ended');
  assert.equal(h.injected.claude.length, 0);
  assert.equal((await request(`threads/${thread.id}/reopen`)).statusCode, 200);
});

test('successful injection after DM sender deletion retains receipt and clears cancellation metadata', async (t) => {
  const { h, thread, send } = await setup(t);
  await h.store.updateThreadMetadata(thread.id, { dm: true });
  const { notifyAgentSessionDeleted } = await import('../modules/agent/session-delete-events.mjs');
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  h.inputResponders.claude = async () => { entered(); await gate; return { statusCode: 200, payload: { ok: true } }; };
  const sending = send('accepted work');
  await started;
  try { await notifyAgentSessionDeleted(refs[0]); } finally { release(); }
  assert.equal((await sending).statusCode, 200);
  // Observer-owned injection may finish after the request's queued response.
  for (let i = 0; i < 50 && h.store.getThread(thread.id).deliveries[0].status !== 'injected'; i++) await delay(20);
  const receipt = h.store.getThread(thread.id).deliveries[0];
  assert.equal(receipt.status, 'injected'); assert.equal(receipt.cancelledAt, null);
  assert.equal(receipt.resolution, null); assert.equal(receipt.error, null);
});

test('lost injection acknowledgement survives store reload and replay recognizes prior delivery', async (t) => {
  const { h, thread, request, send } = await setup(t);
  let acceptedInputs = 0;
  h.inputResponders.claude = async ({ text }) => {
    acceptedInputs++;
    // Provider accepted the envelope but its response was lost at the HTTP boundary.
    return { content: text, statusCode: 502, payload: { error: 'acknowledgement lost' } };
  };
  await send('persisted result');
  // Wait for the lost-ack receipt before testing its durability across reload.
  for (let i = 0; i < 50 && h.store.getThread(thread.id).deliveries[0].status === 'queued'; i++) await delay(20);
  const original = h.store.getThread(thread.id).deliveries[0];
  assert.equal(original.status, 'failed');
  assert.equal(acceptedInputs, 1);
  await h.store.persist(); // Flush the observer-owned update before simulating reload.
  await h.store.init();
  assert.equal(h.store.getDelivery(original.id).status, 'failed');
  const replay = await request(`deliveries/${original.id}/replay`);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(h.store.getDelivery(original.id).status, 'injected');
  assert.equal(h.store.getDelivery(original.id).resolution, 'already_present');
  assert.equal(acceptedInputs, 1);
  assert.equal(h.store.getThread(thread.id).messages.length, 1);
});
