import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { buildAgentBusMcpRequest, buildAgentBusMcpServer } from '../modules/agent-bus/mcp.mjs';
import { AGENT_BUS_AGENT_TOOL_SCOPES } from '../modules/agent-bus/mcp-auth.mjs';

const context = { authenticated: true, principal: { type: 'agent', kind: 'codex', sessionId: 'c1' },
  toolScopes: [...AGENT_BUS_AGENT_TOOL_SCOPES], threadAllowlist: ['@member'] };

test('MCP exposes the clean room/DM/directory surface and no old bus or manager-loop aliases', async () => {
  const server = buildAgentBusMcpServer({ requestImpl: async () => ({ sessions: [] }) });
  const listed = await server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { authContext: context });
  const names = listed.result.tools.map((tool) => tool.name);
  for (const name of ['room_send', 'room_context', 'room_list', 'room_close', 'room_end', 'room_transfer', 'agent_dm', 'agent_directory']) {
    assert.ok(names.includes(name));
  }
  assert.equal(names.some((name) => name.startsWith('agent_bus_')), false);
  assert.equal(names.some((name) => name.includes('manager_loop') || name === 'monitor_bootstrap_thread'), false);
  const prompts = await server.handleRequest({ jsonrpc: '2.0', id: 2, method: 'prompts/list', params: {} }, { authContext: context });
  assert.deepEqual(prompts.result.prompts.map((prompt) => prompt.name), ['collaboration_guidance']);
  const guidance = await server.handleRequest({ jsonrpc: '2.0', id: 3, method: 'prompts/get',
    params: { name: 'collaboration_guidance' } }, { authContext: context });
  const text = guidance.result.messages[0].content.text;
  for (const name of ['room_send', 'room_context', 'room_list', 'room_close', 'room_end', 'room_transfer', 'agent_dm', 'agent_directory']) {
    assert.match(text, new RegExp(name));
  }
  assert.doesNotMatch(text, /agent_bus_|ack/);
});

test('room sends and DMs pin the authenticated sender server-side', async () => {
  const calls = [];
  const thread = { id: 'thr_1', participants: [{ kind: 'codex', sessionId: 'c1' }, { kind: 'claude', sessionId: 'a1' }] };
  const server = buildAgentBusMcpServer({ requestImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith('/api/agent-bus/threads/thr_1')) return { thread, messages: [], deliveries: [] };
    if (path === '/api/agent-bus/messages') return { message: { id: 'msg_1' }, deliveries: [] };
    if (path === '/api/agent-bus/dm') return { message: { id: 'msg_2' }, deliveries: [] };
    throw new Error(`Unexpected ${path}`);
  } });
  await assert.rejects(server.callTool('room_send', { thread_id: 'thr_1', body: 'hi', from_kind: 'pi', from_session_id: 'spoof' }, context), /room_send: unknown argument/);
  assert.equal(calls.length, 0);
  await server.callTool('room_send', { thread_id: 'thr_1', body: 'hi' }, context);
  await server.callTool('agent_dm', { kind: 'claude', session_id: 'a1', body: 'dm' }, context);
  assert.deepEqual(calls.find((item) => item.path === '/api/agent-bus/messages').options.body.from,
    { kind: 'codex', sessionId: 'c1' });
  assert.deepEqual(calls.find((item) => item.path === '/api/agent-bus/dm').options.body.from,
    { kind: 'codex', sessionId: 'c1' });
});

test('a refused Cadre connection reports a restart instead of a bare ECONNREFUSED', async () => {
  const listener = createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${listener.address().port}`;
  await new Promise((resolve) => listener.close(resolve));
  for (const server of [buildAgentBusMcpServer({ requestImpl: buildAgentBusMcpRequest({ baseUrl }) }), buildAgentBusMcpServer({ baseUrl })]) {
    await assert.rejects(server.callTool('agent_dm', { kind: 'claude', session_id: 'a1', body: 'dm' }, context),
      { code: 'server_restarting', message: 'Cadre server is restarting; retry in a few seconds' });
  }
});

test('room context defaults to truncated bodies and omits deliveries', async () => {
  const longBody = 'x'.repeat(3800);
  const server = buildAgentBusMcpServer({ requestImpl: async (path) => {
    assert.match(path, /deliveryLimit=0/);
    return {
      thread: { id: 'thr_1', title: 'Work', status: 'open', participants: [
        { kind: 'codex', sessionId: 'c1', session_capabilities: { canSendNow: false }, can_send_now_reason: 'Provider reports working', canonical_status: 'working' },
      ] },
      messageCount: 1,
      messages: [{ id: 'msg_1', from: { kind: 'claude', sessionId: 'a1' }, type: 'message', createdAt: 1, body: longBody }],
      deliveries: [{ id: 'del_1', resolution: { hash: 'abc' } }],
    };
  } });
  const result = await server.callTool('room_context', { thread_id: 'thr_1' }, context);
  const payload = JSON.parse(result.content.find((item) => item.type === 'text').text);
  assert.equal(result.structuredContent, undefined);
  assert.equal(payload.messages[0].truncated, true);
  assert.equal(payload.messages[0].body.length, 3000);
  assert.equal(payload.messages[0].bodyLength, 3800);
  assert.equal(payload.messages[0].nextOffset, 3000);
  assert.equal(payload.deliveries, undefined);
  assert.equal(payload.messageCount, 1);
  assert.deepEqual(payload.thread, { id: 'thr_1', title: 'Work', status: 'open' });
});

test('room context halves full-report retrieval bytes and restores opt-in metadata', async (t) => {
  const deliveryHealth = { queued: 2, held: 1, injected: 12, failed: 0, cancelled: 0,
    oldestQueuedAt: 1700000000000, oldestQueuedAgeMs: 2000, overdue: false };
  const participants = ['codex', 'claude'].map((kind, i) => ({
    kind, sessionId: `reviewer-${i}`, session_capabilities: { canSendNow: false },
    can_send_now_reason: 'Free-text prompt is not yet stable', canonical_status: 'working',
  }));
  const messages = Array.from({ length: 5 }, (_, i) => ({
    id: `msg_${i}`, from: { kind: 'claude', sessionId: 'reviewer-1' },
    type: i === 4 ? 'result' : 'message', createdAt: 1700000000000 + i,
    body: (i === 4 ? 'Review report: tests passed.\n' : 'Implementation progress.\n').repeat(100).slice(0, i === 4 ? 2500 : 441),
  }));
  const server = buildAgentBusMcpServer({ requestImpl: async () => ({
    thread: { id: 'thr_1', title: 'Implementation and review', status: 'open', health: 'ok',
      metadata: { deliveryHealth }, participants }, messageCount: 5, messages,
  }) });
  const result = await server.callTool('room_context', { thread_id: 'thr_1' }, context);
  const payload = JSON.parse(result.content[0].text);
  const detailed = JSON.parse((await server.callTool('room_context', { thread_id: 'thr_1', metadata: true }, context)).content[0].text);
  assert.equal(result.structuredContent, undefined);
  assert.equal(payload.messages.length, 5);
  assert.equal(payload.messages[4].body.length, 2500);
  assert.equal(payload.messages[4].truncated, false);
  assert.equal(payload.thread.health, undefined);
  assert.equal(payload.thread.deliveryHealth, undefined);
  assert.equal(payload.thread.participants, undefined);
  assert.equal(detailed.thread.health, 'ok');
  assert.deepEqual(detailed.thread.deliveryHealth, deliveryHealth);
  assert.deepEqual(detailed.thread.participants, participants.map((item) => ({
    kind: item.kind, sessionId: item.sessionId, canSendNow: false,
    canSendNowReason: item.can_send_now_reason, status: item.canonical_status,
  })));
  // The previous default included metadata, 1,200-char bodies, and both JSON copies.
  const oldPayload = JSON.parse((await server.callTool('room_context', {
    thread_id: 'thr_1', metadata: true, body_limit: 1200,
  }, context)).content[0].text);
  const oldResultBytes = (payload) => Buffer.byteLength(JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload,
  }));
  const before = oldResultBytes(oldPayload);
  let fullBefore = before;
  let report = oldPayload.messages[4];
  let oldReportBody = report.body;
  while (report.truncated) {
    const page = JSON.parse((await server.callTool('room_context', {
      thread_id: 'thr_1', metadata: true, body_limit: 1200,
      message_id: report.id, body_offset: report.nextOffset,
    }, context)).content[0].text);
    fullBefore += oldResultBytes(page);
    report = page.messages[0];
    oldReportBody += report.body;
  }
  assert.equal(oldReportBody, payload.messages[4].body);
  const after = Buffer.byteLength(JSON.stringify(result));
  t.diagnostic(`room_context initial bytes: ${before} -> ${after} (${(100 * (1 - after / before)).toFixed(1)}% smaller); full report: ${fullBefore} -> ${after} (${(100 * (1 - after / fullBefore)).toFixed(1)}% smaller)`);
  assert.ok(after < before, `${before} -> ${after}`);
  assert.ok(after <= fullBefore / 2, `${fullBefore} -> ${after}`);
});

test('room context exposes queued age and detailed hold reason when deliveries are requested', async () => {
  const now = Date.now();
  const server = buildAgentBusMcpServer({ requestImpl: async () => ({
    thread: { id: 'thr_1', participants: [{ kind: 'codex', sessionId: 'c1' }] },
    messages: [],
    deliveries: [
      { id: 'held', status: 'queued', createdAt: now - 120_000, holdReason: 'can_send_false', holdDetail: 'Free-text prompt is not yet stable' },
      { id: 'pending', status: 'queued', createdAt: now + 60_000 },
      { id: 'injected', status: 'injected', createdAt: now - 120_000 },
      { id: 'failed', status: 'failed', createdAt: now - 120_000, holdReason: 'backoff' },
    ],
  }) });
  const result = await server.callTool('room_context', { thread_id: 'thr_1', deliveries: true }, context);
  const [held, pending, injected, failed] = JSON.parse(result.content[0].text).deliveries;
  assert.ok(held.held_for_s >= 120 && held.held_for_s < 125);
  assert.equal(held.hold_reason, 'Free-text prompt is not yet stable');
  assert.equal(held.holdReason, 'can_send_false');
  assert.equal(pending.held_for_s, 0);
  assert.equal(pending.hold_reason, null);
  assert.equal(injected.held_for_s, 0);
  assert.equal(injected.hold_reason, null);
  assert.equal(failed.held_for_s, 0);
  assert.equal(failed.hold_reason, 'backoff');
});

test('room context pages a truncated body with message_id and body_offset', async () => {
  const longBody = 'x'.repeat(3800);
  const paths = [];
  const server = buildAgentBusMcpServer({ requestImpl: async (path) => {
    paths.push(path);
    return {
      thread: { id: 'thr_1', title: 'Work', status: 'open', participants: [{ kind: 'codex', sessionId: 'c1' }] },
      messageCount: 1,
      messages: [{ id: 'msg_1', from: { kind: 'claude', sessionId: 'a1' }, type: 'message', createdAt: 1, body: longBody }],
    };
  } });
  const first = JSON.parse((await server.callTool('room_context', { thread_id: 'thr_1' }, context)).content[0].text).messages[0];
  const result = await server.callTool('room_context', {
    thread_id: 'thr_1', message_id: 'msg_1', body_offset: first.nextOffset,
  }, context);
  const message = JSON.parse(result.content.find((item) => item.type === 'text').text).messages[0];
  assert.equal(message.body, 'x'.repeat(800));
  assert.equal(message.truncated, false);
  assert.equal(first.body + message.body, longBody);
  assert.equal(message.bodyLength, 3800);
  assert.equal(message.nextOffset, undefined);
  assert.ok(paths.some((path) => /messageLimit=500/.test(path)));
});

test('room context ignores body_offset without message_id', async () => {
  const server = buildAgentBusMcpServer({ requestImpl: async () => ({
    thread: { id: 'thr_1', title: 'Work', status: 'open', participants: [{ kind: 'codex', sessionId: 'c1' }] },
    messageCount: 1,
    messages: [{ id: 'msg_1', from: { kind: 'claude', sessionId: 'a1' }, type: 'message', createdAt: 1, body: 'hello-world' }],
  }) });
  const result = await server.callTool('room_context', {
    thread_id: 'thr_1', body_offset: 6, body_limit: 0,
  }, context);
  const message = JSON.parse(result.content[0].text).messages[0];
  assert.equal(message.body, 'hello-world');
  assert.equal(message.truncated, false);
  assert.equal(message.nextOffset, undefined);
});

test('room context reports missing message_id and skips since/after', async () => {
  const server = buildAgentBusMcpServer({ requestImpl: async () => ({
    thread: { id: 'thr_1', title: 'Work', status: 'open', participants: [{ kind: 'codex', sessionId: 'c1' }] },
    messageCount: 2,
    messages: [
      { id: 'msg_1', from: { kind: 'claude', sessionId: 'a1' }, type: 'message', createdAt: 10, body: 'a' },
      { id: 'msg_2', from: { kind: 'codex', sessionId: 'c1' }, type: 'message', createdAt: 20, body: 'b' },
    ],
  }) });
  const missing = await server.callTool('room_context', {
    thread_id: 'thr_1', message_id: 'msg_missing', since: 'msg_1',
  }, context);
  assert.equal(JSON.parse(missing.content[0].text).messageCount, 0);
  assert.equal(JSON.parse(missing.content[0].text).missingMessageId, 'msg_missing');
  const hit = await server.callTool('room_context', {
    thread_id: 'thr_1', message_id: 'msg_1', since: 'msg_1', after: '9999',
  }, context);
  assert.equal(JSON.parse(hit.content[0].text).messages[0].id, 'msg_1');
  assert.equal(JSON.parse(hit.content[0].text).messages[0].body, 'a');
});

test('room context since/after counts only filtered messages', async () => {
  const server = buildAgentBusMcpServer({ requestImpl: async () => ({
    thread: { id: 'thr_1', title: 'Work', status: 'open', participants: [{ kind: 'codex', sessionId: 'c1' }] },
    messageCount: 3,
    messages: [
      { id: 'msg_1', from: { kind: 'claude', sessionId: 'a1' }, type: 'message', createdAt: 10, body: 'a' },
      { id: 'msg_2', from: { kind: 'codex', sessionId: 'c1' }, type: 'message', createdAt: 20, body: 'b' },
      { id: 'msg_3', from: { kind: 'codex', sessionId: 'c1' }, type: 'message', createdAt: 30, body: 'c' },
    ],
  }) });
  const result = await server.callTool('room_context', { thread_id: 'thr_1', since: 'msg_1' }, context);
  assert.equal(JSON.parse(result.content[0].text).messageCount, 2);
  assert.equal(JSON.parse(result.content[0].text).totalMessageCount, 3);
});

test('room context is open to nonparticipants', async () => {
  const server = buildAgentBusMcpServer({ requestImpl: async () => ({ thread: { id: 'thr_other', participants: [
    { kind: 'claude', sessionId: 'a1' }, { kind: 'pi', sessionId: 'p1' },
  ] } }) });
  assert.equal(JSON.parse((await server.callTool('room_context', { thread_id: 'thr_other' }, context)).content[0].text).thread.id, 'thr_other');
});

test('room list pins the caller and returns only the compact participant-scoped room shape', async () => {
  const calls = [];
  const server = buildAgentBusMcpServer({ requestImpl: async (path) => {
    calls.push(path);
    return { threads: [{ id: 'thr_1', title: 'Work', status: 'open', participants: [{ kind: 'codex', sessionId: 'c1' }],
      metadata: {} }, { id: 'thr_dm', title: 'DM', status: 'closed', participants: [{ kind: 'codex', sessionId: 'c1' }],
      metadata: { dm: true }, projectKey: 'hidden' }] };
  } });
  await assert.rejects(server.callTool('room_list', { kind: 'claude', session_id: 'spoof' }, context), /room_list: unknown argument/);
  assert.equal(calls.length, 0);
  const result = await server.callTool('room_list', {}, context);
  assert.equal(calls[0], '/api/agent-bus/threads/by-participant?kind=codex&sessionId=c1&status=all');
  assert.deepEqual(result.structuredContent.rooms, [
    { id: 'thr_1', title: 'Work', kind: 'room', status: 'open' },
    { id: 'thr_dm', title: 'DM', kind: 'dm', status: 'closed' },
  ]);
});

test('room creator can read, address, and close without being a participant', async () => {
  const owner = { authenticated: true, principal: { type: 'agent', kind: 'claude', sessionId: 'coord' },
    toolScopes: [...AGENT_BUS_AGENT_TOOL_SCOPES], threadAllowlist: ['@member'] };
  const thread = {
    id: 'thr_owned',
    createdBy: { kind: 'claude', sessionId: 'coord' },
    participants: [{ kind: 'codex', sessionId: 'c1' }, { kind: 'pi', sessionId: 'p1' }],
  };
  const calls = [];
  const server = buildAgentBusMcpServer({ requestImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith('/api/agent-bus/threads/thr_owned?')) return { thread, messages: [], deliveries: [] };
    if (path === '/api/agent-bus/messages') return { message: { id: 'msg_owned' }, deliveries: [] };
    if (path.endsWith('/close')) return { status: 'closed', preserved: thread.participants };
    if (path.endsWith('/end')) return { status: 'ended' };
    if (path.includes('/threads/by-participant')) return { threads: [thread] };
    throw new Error(`Unexpected ${path}`);
  } });
  const contextResult = await server.callTool('room_context', { thread_id: 'thr_owned' }, owner);
  assert.equal(JSON.parse(contextResult.content[0].text).thread.id, 'thr_owned');
  const sent = await server.callTool('room_send', { thread_id: 'thr_owned', body: 'status' }, owner);
  assert.equal(sent.structuredContent.message_id || 'msg_owned', 'msg_owned');
  assert.deepEqual(calls.find((item) => item.path === '/api/agent-bus/messages').options.body.from,
    { kind: 'claude', sessionId: 'coord' });
  const closed = await server.callTool('room_close', { thread_id: 'thr_owned' }, owner);
  assert.equal(closed.structuredContent.status, 'closed');
  assert.equal((await server.callTool('room_end', { thread_id: 'thr_owned' }, owner)).structuredContent.status, 'ended');
  assert.deepEqual(calls.find((item) => item.path.endsWith('/end')).options.body, {});
  const listed = await server.callTool('room_list', {}, owner);
  assert.equal(listed.structuredContent.rooms.some((room) => room.id === 'thr_owned'), true);
});

test('room lifecycle dispatch preserves actor context for route ownership checks', async () => {
  const calls = [];
  const memberThread = { id: 'thr_1', participants: [{ kind: 'codex', sessionId: 'c1' }, { kind: 'claude', sessionId: 'a1' }] };
  const server = buildAgentBusMcpServer({ requestImpl: async (path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith('/api/agent-bus/threads/thr_1?')) return { thread: memberThread };
    if (path.endsWith('/close')) return { status: 'closed', preserved: memberThread.participants };
    if (path.endsWith('/end')) return { status: 'ended', skipped: [] };
    if (path.startsWith('/api/agent-bus/threads/thr_other?')) return { thread: { id: 'thr_other', participants: [] } };
    throw new Error(`Unexpected ${path}`);
  } });
  const closed = await server.callTool('room_close', { thread_id: 'thr_1' }, context);
  assert.equal(closed.structuredContent.status, 'closed');
  assert.equal((await server.callTool('room_end', { thread_id: 'thr_1' }, context)).structuredContent.status, 'ended');
  assert.equal((await server.callTool('room_close', { thread_id: 'thr_other' }, context)).structuredContent.status, 'closed');
  assert.equal(calls.find((item) => item.path.endsWith('/close')).options.authContext.principal.sessionId, 'c1');
  const ui = { authenticated: true, principal: { type: 'ui', kind: 'dashboard', sessionId: 'local' },
    toolScopes: ['room_end'], threadAllowlist: ['*'] };
  const ended = await server.callTool('room_end', { thread_id: 'thr_1' }, ui);
  assert.equal(ended.structuredContent.status, 'ended');
});

test('agent_directory unifies provider rosters with display name and canonical state', async () => {
  const server = buildAgentBusMcpServer({ requestImpl: async (path) => ({ sessions: path.includes('codex')
    ? [{ id: 'c1', displayName: 'Builder', state: { status: 'ready' } }] : [] }) });
  const result = await server.callTool('agent_directory', {}, context);
  assert.deepEqual(result.structuredContent.agents, [{ kind: 'codex', sessionId: 'c1', displayName: 'Builder', state: 'ready' }]);
});
