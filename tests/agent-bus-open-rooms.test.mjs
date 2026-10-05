import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';

const owner = { kind: 'pi', sessionId: 'pi-1' };
const outsider = { kind: 'deepseek', sessionId: 'deepseek-1' };
const participants = [{ kind: 'claude', sessionId: 'claude-1' }, { kind: 'codex', sessionId: 'codex-1' }];

async function setup(t) {
  process.env.INTERNAL_BYPASS_TOKEN = 'open-rooms-test-bypass';
  const h = await createAgentBusHarness({ pollMs: 60000 });
  t.after(async () => { await h.cleanup(); delete process.env.INTERNAL_BYPASS_TOKEN; });
  const { buildAgentBusMcpServer } = await import('../modules/agent-bus/mcp.mjs');
  const { buildInProcessFastifyRequest } = await import('../modules/agent-bus/in-process-mcp.mjs');
  const { buildInternalBypassHeaders } = await import('../modules/platform/auth.mjs');
  const { AGENT_BUS_AGENT_TOOL_SCOPES } = await import('../modules/agent-bus/mcp-auth.mjs');
  const context = (ref) => ({ authenticated: true, principal: { type: 'agent', ...ref },
    toolScopes: [...AGENT_BUS_AGENT_TOOL_SCOPES], threadAllowlist: ['@member'] });
  const requestImpl = buildInProcessFastifyRequest({ app: h.app, buildHeaders: () => buildInternalBypassHeaders({ authToken: h.authToken, bypassToken: 'open-rooms-test-bypass' }) });
  const mcp = buildAgentBusMcpServer({ requestImpl });
  const thread = await h.store.createThread({ title: 'Open room', participants, createdBy: owner });
  return { h, thread, call: (name, args, ref = owner) => mcp.callTool(name, args, context(ref)), requestImpl };
}

test('nonmembers read and post without subscribing; all scope lists only open rooms', async (t) => {
  const { h, thread, call } = await setup(t);
  const closed = await h.store.createThread({ title: 'Archived', participants: [], createdBy: owner });
  await h.store.closeThread(closed.id);
  assert.equal((await call('room_context', { thread_id: thread.id }, outsider)).structuredContent.thread.id, thread.id);
  await call('room_send', { thread_id: thread.id, body: 'Observer contribution' }, outsider);
  assert.deepEqual(h.store.getThread(thread.id).thread.participants, participants);
  const history = await call('room_context', { thread_id: thread.id }, outsider);
  assert.equal(history.structuredContent.messages[0].body, 'Observer contribution');
  assert.equal((await call('room_list', {}, outsider)).structuredContent.rooms.length, 0);
  assert.deepEqual((await call('room_list', { scope: 'all' }, outsider)).structuredContent.rooms.map((room) => room.id), [thread.id]);
});

test('results deliver to an unsubscribed owner exactly once, plain messages do not', async (t) => {
  const { h, thread, call } = await setup(t);
  await call('room_send', { thread_id: thread.id, body: 'Progress' }, participants[0]);
  await call('room_send', { thread_id: thread.id, body: 'Done', type: 'result' }, participants[0]);
  let snapshot = h.store.getThread(thread.id);
  const targets = (body) => snapshot.deliveries.filter((d) => d.messageId === snapshot.messages.find((m) => m.body === body).id).map((d) => d.target);
  assert.deepEqual(targets('Progress'), [participants[1]]);
  assert.deepEqual(targets('Done'), [participants[1], owner]);
  await h.store.addThreadParticipant(thread.id, owner);
  await call('room_send', { thread_id: thread.id, body: 'Again', type: 'result' }, participants[0]);
  snapshot = h.store.getThread(thread.id);
  assert.equal(targets('Again').filter((ref) => ref.kind === owner.kind).length, 1);
  await call('room_send', { thread_id: thread.id, body: 'Owner report', type: 'result' });
  snapshot = h.store.getThread(thread.id);
  assert.equal(targets('Owner report').some((ref) => ref.kind === owner.kind), false);
});

test('owner transfers; live owners block claims; gone owners permit claims; operators always transfer', async (t) => {
  const { h, thread, call, requestImpl } = await setup(t);
  const args = { thread_id: thread.id, to: { kind: outsider.kind, session_id: outsider.sessionId } };
  await assert.rejects(call('room_transfer', args, outsider), (err) => err.statusCode === 403);
  h.sessionDetailResponders.pi = () => ({ statusCode: 502, error: 'Lookup unavailable' });
  await assert.rejects(call('room_transfer', args, outsider), (err) => err.statusCode === 502);
  h.sessionDetailResponders.pi = null;
  await assert.rejects(call('room_transfer', { ...args, to: { kind: 'typo', session_id: 'missing' } }), (err) => err.statusCode === 400);
  assert.deepEqual(h.store.getThread(thread.id).thread.createdBy, owner);
  await assert.rejects(call('room_transfer', { ...args, to: { kind: 'codex', session_id: 'missing' } }), (err) => err.statusCode === 400);
  await call('room_transfer', args);
  assert.deepEqual(h.store.getThread(thread.id).thread.createdBy, outsider);
  assert.deepEqual(h.store.getThread(thread.id).thread.participants, participants);
  h.sessionCatalog.deepseek.delete(outsider.sessionId);
  await assert.rejects(call('room_transfer', { thread_id: thread.id, to: { kind: owner.kind, session_id: owner.sessionId } }, participants[0]), (err) => err.statusCode === 403);
  assert.deepEqual(h.store.getThread(thread.id).thread.createdBy, outsider);
  await call('room_transfer', { thread_id: thread.id, to: { kind: participants[0].kind, session_id: participants[0].sessionId } }, participants[0]);
  assert.deepEqual(h.store.getThread(thread.id).thread.createdBy, participants[0]);
  h.sessionCatalog.deepseek.add(outsider.sessionId);
  await requestImpl(`/api/agent-bus/threads/${thread.id}/transfer`, { method: 'POST', body: { to: outsider } });
  assert.deepEqual(h.store.getThread(thread.id).thread.createdBy, outsider);
});

test('owner end requires cancellation for pending deliveries and preserves shared participants', async (t) => {
  const { h, thread, call } = await setup(t);
  await h.store.createThread({ title: 'Shared', participants: [participants[1]], createdBy: owner });
  const record = await h.store.createMessage({ threadId: thread.id, from: outsider, targets: [participants[0]], body: 'Pending' });
  await assert.rejects(call('room_end', { thread_id: thread.id }, outsider), (err) => err.statusCode === 403);
  await assert.rejects(call('room_end', { thread_id: thread.id }), (err) => err.code === 'pending_deliveries');
  assert.equal(h.store.getThread(thread.id).thread.status, 'open');
  const ended = await call('room_end', { thread_id: thread.id, cancel_pending: true });
  assert.equal(ended.structuredContent.status, 'ended');
  assert.deepEqual(ended.structuredContent.skipped, [participants[1]]);
  assert.deepEqual(h.deletedSessions.claude, ['claude-1']);
  assert.deepEqual(h.deletedSessions.codex, []);
  assert.equal(h.store.getDelivery(record.deliveries[0].id).resolution, 'cancelled');
  assert.equal(h.store.getThread(thread.id).thread.status, 'closed');
});

test('owner end refuses DM rooms', async (t) => {
  const { h, call } = await setup(t);
  const dm = await h.store.createThread({ participants, createdBy: owner, metadata: { dm: true } });
  await assert.rejects(call('room_end', { thread_id: dm.id }), /DM rooms may only be closed/);
  assert.deepEqual(h.deletedSessions.claude, []);
});

test('close requires ownership while any participant lives; any agent closes once all are gone', async (t) => {
  const { h, thread, call } = await setup(t);
  await assert.rejects(call('room_close', { thread_id: thread.id }, outsider), (err) => err.statusCode === 403);
  h.sessionCatalog.claude.delete('claude-1');
  await assert.rejects(call('room_close', { thread_id: thread.id }, participants[0]), (err) => err.statusCode === 403);
  h.sessionCatalog.codex.delete('codex-1');
  assert.equal((await call('room_close', { thread_id: thread.id }, outsider)).structuredContent.status, 'closed');
  assert.deepEqual(h.deletedSessions.codex, []);
});

test('outsiders cannot read or send in DMs or discover them in all-open listing', async (t) => {
  const { h, thread, call, requestImpl } = await setup(t);
  const dm = await h.store.createThread({ participants, metadata: { dm: true } });
  await call('room_send', { thread_id: dm.id, body: 'Private history' }, participants[0]);
  await assert.rejects(call('room_context', { thread_id: dm.id }, outsider), (err) => err.statusCode === 403);
  await assert.rejects(call('room_send', { thread_id: dm.id, body: 'Intrusion' }, outsider), (err) => err.statusCode === 403);
  await assert.rejects(requestImpl('/api/agent-bus/messages', { method: 'POST', body: {
    threadId: dm.id, from: outsider, body: 'Route intrusion', deliveryMode: 'enqueue',
  } }), (err) => err.statusCode === 403);
  assert.deepEqual((await call('room_list', { scope: 'all' }, outsider)).structuredContent.rooms.map((room) => room.id), [thread.id]);
  assert.deepEqual((await call('room_list', { scope: 'all' }, participants[0])).structuredContent.rooms.map((room) => room.id), [thread.id]);
  assert.equal((await call('room_context', { thread_id: dm.id }, participants[1])).structuredContent.messages[0].body, 'Private history');
  assert.equal((await call('room_list', {}, participants[1])).structuredContent.rooms.some((room) => room.id === dm.id), true);
  assert.equal(h.store.getThread(dm.id).messages.length, 1);
});
