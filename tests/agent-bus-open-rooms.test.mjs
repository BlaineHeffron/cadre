import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { renderBusEnvelope } from '../modules/agent-bus/envelope.mjs';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';

const owner = { kind: 'pi', sessionId: 'pi-1' };
const outsider = { kind: 'deepseek', sessionId: 'deepseek-1' };
const participants = [{ kind: 'claude', sessionId: 'claude-1' }, { kind: 'codex', sessionId: 'codex-1' }];

async function setup(t) {
  process.env.INTERNAL_BYPASS_TOKEN = 'open-rooms-test-bypass';
  const h = await createAgentBusHarness({ pollMs: 60000 });
  t.after(async () => { await credentials.close(); await h.cleanup(); delete process.env.INTERNAL_BYPASS_TOKEN; });
  const { buildAgentBusMcpServer } = await import('../modules/agent-bus/mcp.mjs');
  const { buildInProcessFastifyRequest } = await import('../modules/agent-bus/in-process-mcp.mjs');
  const { buildInternalBypassHeaders } = await import('../modules/platform/auth.mjs');
  const { AgentBusCredentialStore, AGENT_BUS_AGENT_TOOL_SCOPES } = await import('../modules/agent-bus/mcp-auth.mjs');
  const credentials = new AgentBusCredentialStore({ stateFile: join(h.stateDir, 'test-credentials.json') });
  const tokens = new Map();
  for (const ref of [owner, outsider, ...participants]) {
    const issued = await credentials.issue({ principal: { type: 'agent', ...ref }, attemptGeneration: 1,
      toolScopes: [...AGENT_BUS_AGENT_TOOL_SCOPES] });
    tokens.set(ref, issued.token);
  }
  const requestImpl = buildInProcessFastifyRequest({ app: h.app, buildHeaders: () => buildInternalBypassHeaders({ authToken: h.authToken, bypassToken: 'open-rooms-test-bypass' }) });
  const mcp = buildAgentBusMcpServer({ requestImpl, credentialStore: credentials });
  const thread = await h.store.createThread({ title: 'Open room', participants, createdBy: owner });
  return { h, thread, call: async (name, args, ref = owner) => mcp.callTool(name, args, await credentials.authenticate(tokens.get(ref))), requestImpl };
}

test('nonmembers read and post without subscribing; all scope lists only open rooms', async (t) => {
  const { h, thread, call } = await setup(t);
  const closed = await h.store.createThread({ title: 'Archived', participants: [], createdBy: owner });
  await h.store.closeThread(closed.id);
  assert.equal(JSON.parse((await call('room_context', { thread_id: thread.id }, outsider)).content[0].text).thread.id, thread.id);
  await call('room_send', { thread_id: thread.id, body: 'Observer contribution' }, outsider);
  assert.deepEqual(h.store.getThread(thread.id).thread.participants, participants);
  const history = await call('room_context', { thread_id: thread.id }, outsider);
  assert.equal(JSON.parse(history.content[0].text).messages[0].body, 'Observer contribution');
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

test('owner end cancels pending deliveries and preserves shared participants', async (t) => {
  const { h, thread, call } = await setup(t);
  await h.store.createThread({ title: 'Shared', participants: [participants[1]], createdBy: owner });
  const record = await h.store.createMessage({ threadId: thread.id, from: outsider, targets: [participants[0]], body: 'Pending' });
  await assert.rejects(call('room_end', { thread_id: thread.id }, outsider), (err) => err.statusCode === 403);
  assert.equal(h.store.getThread(thread.id).thread.status, 'open');
  const ended = await call('room_end', { thread_id: thread.id });
  assert.equal(ended.structuredContent.status, 'ended');
  assert.deepEqual(ended.structuredContent.results.filter((r) => r.status === 'skipped').map((r) => r.session_id), [participants[1].sessionId]);
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

test('outsiders close and reopen non-DM rooms while participants live without terminating them', async (t) => {
  const { h, thread, call } = await setup(t);
  assert.equal((await call('room_close', { thread_id: thread.id }, outsider)).structuredContent.status, 'closed');
  assert.equal((await call('room_reopen', { thread_id: thread.id }, outsider)).structuredContent.status, 'open');
  assert.deepEqual(h.store.getThread(thread.id).thread.participants, participants);
  for (const { kind, sessionId } of participants) {
    assert.equal(h.sessionCatalog[kind].has(sessionId), true);
    assert.deepEqual(h.deletedSessions[kind], []);
  }
});

test('outsiders cannot read, send, close or reopen DMs or discover them in all-open listing', async (t) => {
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
  assert.equal(JSON.parse((await call('room_context', { thread_id: dm.id }, participants[1])).content[0].text).messages[0].body, 'Private history');
  assert.equal((await call('room_list', {}, participants[1])).structuredContent.rooms.some((room) => room.id === dm.id), true);
  await assert.rejects(call('room_close', { thread_id: dm.id }, outsider), (err) => err.statusCode === 403);
  await call('room_close', { thread_id: dm.id, cancel_pending: true }, participants[0]);
  await assert.rejects(call('room_reopen', { thread_id: dm.id }, outsider), (err) => err.statusCode === 403);
  await call('room_reopen', { thread_id: dm.id }, participants[1]);
  assert.equal(h.store.getThread(dm.id).thread.status, 'open');
  assert.equal(h.store.getThread(dm.id).messages.length, 1);
});

test('a DM participant may archive while both participant sessions are alive', async (t) => {
  const { h, call } = await setup(t);
  const dm = await h.store.createThread({ participants, metadata: { dm: true } });
  assert.equal(dm.createdBy, null);
  const closed = await call('room_close', { thread_id: dm.id }, participants[0]);
  assert.equal(closed.structuredContent.status, 'closed');
  assert.equal(h.store.getThread(dm.id).thread.status, 'closed');
  for (const { kind, sessionId } of participants) {
    assert.equal(h.sessionCatalog[kind].has(sessionId), true);
    assert.deepEqual(h.deletedSessions[kind], []);
  }
});


test('poster summaries persist through MCP room and DM calls and compact contexts', async (t) => {
  const { h, thread, call, requestImpl } = await setup(t);
  const summary = 'ready · PR #42 · Summary delivery works';
  const body = 'Full report\n' + 'details '.repeat(200);
  const sent = await call('room_send', { thread_id: thread.id, body, summary, type: 'result' });
  const stored = h.store.getMessage(sent.structuredContent.message_id);
  assert.equal(stored.metadata.summary, summary);
  const compact = await call('room_context', { thread_id: thread.id, summary_only: true });
  assert.equal(JSON.parse(compact.content[0].text).messages[0].summary, summary);
  assert.equal(JSON.parse(compact.content[0].text).messages[0].body, undefined);
  const envelope = renderBusEnvelope(stored);
  assert.ok(envelope.includes(summary));
  assert.ok(envelope.includes(`Body length: ${body.length} characters`));
  assert.ok(envelope.includes(`Full body: room_context(thread_id="${thread.id}", message_id="${stored.id}")`));
  assert.equal(envelope.includes(body), false);
  const page = await call('room_context', { thread_id: thread.id, message_id: stored.id });
  assert.equal(JSON.parse(page.content[0].text).messages[0].body, body);

  const fallback = '\n  \n' + 'f'.repeat(201) + '\nOther details';
  await call('room_send', { thread_id: thread.id, body: fallback });
  const history = await call('room_context', { thread_id: thread.id, summary_only: true });
  assert.equal(JSON.parse(history.content[0].text).messages[1].summary, 'f'.repeat(199) + '…');
  assert.equal(JSON.parse((await call('room_context', { thread_id: thread.id, bodies: false })).content[0].text).messages[0].summary, undefined);
  const changed = await call('room_send', { thread_id: thread.id, body, summary: 'Updated summary', type: 'result' });
  assert.notEqual(changed.structuredContent.message_id, stored.id);

  const dm = await call('agent_dm', { kind: 'claude', session_id: 'claude-1', body, summary });
  const dmMessage = h.store.getMessage(dm.structuredContent.message_id);
  assert.equal(dmMessage.metadata.summary, summary);
  assert.equal(dmMessage.metadata.dm, true);
  const dmEnvelope = renderBusEnvelope(dmMessage);
  assert.ok(dmEnvelope.includes(summary));
  assert.ok(dmEnvelope.includes(`Full body: room_context(thread_id="${dmMessage.threadId}", message_id="${dmMessage.id}")`));
  assert.equal(dmEnvelope.includes(body), false);
  assert.equal(JSON.parse((await call('room_context', { thread_id: dmMessage.threadId, summary_only: true })).content[0].text).messages[0].summary, summary);

  for (const tool of ['room_send', 'agent_dm']) {
    const args = tool === 'room_send' ? { thread_id: thread.id } : { kind: 'claude', session_id: 'claude-1' };
    await assert.rejects(call(tool, { ...args, body: 'Rejected', summary: 'x'.repeat(201) }), /argument "summary" must NOT have more than 200 characters/);
    await assert.rejects(call(tool, { ...args, body: 'Rejected', summary: 42 }), /argument "summary" must be string/);
  }
  for (const [path, args] of [
    ['/api/agent-bus/messages', { threadId: thread.id, from: owner }],
    ['/api/agent-bus/dm', { from: owner, target: participants[0] }],
  ]) {
    await assert.rejects(requestImpl(path, { method: 'POST', body: { ...args, body: 'Rejected', summary: 'x'.repeat(201) } }), (err) => err.statusCode === 400 && /summary/.test(err.payload?.message));
  }
  for (const summary of ['', '   ']) {
    const sent = await call('room_send', { thread_id: thread.id, body: 'Fallback headline\n' + 'd'.repeat(1200), summary });
    const message = h.store.getMessage(sent.structuredContent.message_id);
    assert.match(renderBusEnvelope(message), /Summary: Fallback headline/);
    assert.equal(JSON.parse((await call('room_context', { thread_id: thread.id, message_id: message.id, summary_only: true })).content[0].text).messages[0].summary, 'Fallback headline');
  }
  const boundary = await call('room_send', { thread_id: thread.id, body: 'Accepted', summary: 'x'.repeat(200) });
  assert.equal(h.store.getMessage(boundary.structuredContent.message_id).metadata.summary.length, 200);
});


test('room end starts both participant deletes before either resolves', async (t) => {
  const { h, thread, call } = await setup(t);
  let release;
  const latch = new Promise((resolve) => { release = resolve; });
  t.after(release);
  const started = [];
  let bothStarted;
  const both = new Promise((resolve) => { bothStarted = resolve; });
  for (const participant of participants) {
    h.deleteResponders[participant.kind] = async (id) => {
      started.push(id);
      if (started.length === 2) bothStarted();
      await latch;
    };
  }
  const ending = call('room_end', { thread_id: thread.id });
  await Promise.race([both, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Deletes did not start concurrently')), 2000);
    timer.unref();
  })]);
  assert.deepEqual(started.sort(), participants.map((p) => p.sessionId).sort());
  release();
  assert.deepEqual((await ending).structuredContent.results.map((r) => r.status), ['terminated', 'terminated']);
});

test('room end ignores the late outcome of an in-flight delivery', { timeout: 5000 }, async (t) => {
  const { h, thread, call, requestImpl } = await setup(t);
  let release;
  const latch = new Promise((resolve) => { release = resolve; });
  t.after(release);
  let started;
  const writing = new Promise((resolve) => { started = resolve; });
  h.inputResponders.claude = async () => { started(); await latch; };
  const sending = requestImpl('/api/agent-bus/messages', { method: 'POST', body: {
    threadId: thread.id, from: participants[1], body: 'In flight', deliveryMode: 'wait',
  } });
  await writing;
  const ended = await call('room_end', { thread_id: thread.id });
  assert.equal(ended.structuredContent.status, 'ended');
  const snapshot = h.store.getThread(thread.id);
  const delivery = snapshot.deliveries.find((d) => d.target.kind === 'claude');
  assert.equal(delivery.resolution, 'cancelled');
  release();
  await sending;
  assert.equal(h.store.getDelivery(delivery.id).resolution, 'cancelled');
  assert.equal(h.store.getDelivery(delivery.id).status, 'failed');
});
