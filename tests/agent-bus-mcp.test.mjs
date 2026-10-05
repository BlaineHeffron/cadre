import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentBusMcpServer } from '../modules/agent-bus/mcp.mjs';
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
  await server.callTool('room_send', { thread_id: 'thr_1', body: 'hi', from_kind: 'pi', from_session_id: 'spoof' }, context);
  await server.callTool('agent_dm', { kind: 'claude', session_id: 'a1', body: 'dm' }, context);
  assert.deepEqual(calls.find((item) => item.path === '/api/agent-bus/messages').options.body.from,
    { kind: 'codex', sessionId: 'c1' });
  assert.deepEqual(calls.find((item) => item.path === '/api/agent-bus/dm').options.body.from,
    { kind: 'codex', sessionId: 'c1' });
});

test('room context defaults to truncated bodies and omits deliveries', async () => {
  const longBody = 'x'.repeat(2000);
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
  assert.deepEqual(payload.messages, result.structuredContent.messages);
  assert.equal(payload.messages[0].truncated, true);
  assert.equal(payload.messages[0].body.length, 1200);
  assert.equal(payload.messages[0].bodyLength, 2000);
  assert.equal(payload.messages[0].nextOffset, 1200);
  assert.equal(payload.deliveries, undefined);
  assert.equal(payload.messageCount, 1);
  assert.equal(payload.thread.participants[0].canSendNowReason, 'Provider reports working');
});

test('room context pages a truncated body with message_id and body_offset', async () => {
  const longBody = 'x'.repeat(2000);
  const paths = [];
  const server = buildAgentBusMcpServer({ requestImpl: async (path) => {
    paths.push(path);
    return {
      thread: { id: 'thr_1', title: 'Work', status: 'open', participants: [{ kind: 'codex', sessionId: 'c1' }] },
      messageCount: 1,
      messages: [{ id: 'msg_1', from: { kind: 'claude', sessionId: 'a1' }, type: 'message', createdAt: 1, body: longBody }],
    };
  } });
  const result = await server.callTool('room_context', {
    thread_id: 'thr_1', message_id: 'msg_1', body_offset: 1200,
  }, context);
  const message = JSON.parse(result.content.find((item) => item.type === 'text').text).messages[0];
  assert.equal(message.body, 'x'.repeat(800));
  assert.equal(message.truncated, false);
  assert.equal(message.bodyLength, 2000);
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
  const message = result.structuredContent.messages[0];
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
  assert.equal(missing.structuredContent.messageCount, 0);
  assert.equal(missing.structuredContent.missingMessageId, 'msg_missing');
  const hit = await server.callTool('room_context', {
    thread_id: 'thr_1', message_id: 'msg_1', since: 'msg_1', after: '9999',
  }, context);
  assert.equal(hit.structuredContent.messages[0].id, 'msg_1');
  assert.equal(hit.structuredContent.messages[0].body, 'a');
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
  assert.equal(result.structuredContent.messageCount, 2);
  assert.equal(result.structuredContent.totalMessageCount, 3);
});

test('room context is open to nonparticipants', async () => {
  const server = buildAgentBusMcpServer({ requestImpl: async () => ({ thread: { id: 'thr_other', participants: [
    { kind: 'claude', sessionId: 'a1' }, { kind: 'pi', sessionId: 'p1' },
  ] } }) });
  assert.equal((await server.callTool('room_context', { thread_id: 'thr_other' }, context)).structuredContent.thread.id, 'thr_other');
});

test('room list pins the caller and returns only the compact participant-scoped room shape', async () => {
  const calls = [];
  const server = buildAgentBusMcpServer({ requestImpl: async (path) => {
    calls.push(path);
    return { threads: [{ id: 'thr_1', title: 'Work', status: 'open', participants: [{ kind: 'codex', sessionId: 'c1' }],
      metadata: {} }, { id: 'thr_dm', title: 'DM', status: 'closed', participants: [{ kind: 'codex', sessionId: 'c1' }],
      metadata: { dm: true }, projectKey: 'hidden' }] };
  } });
  const result = await server.callTool('room_list', { kind: 'claude', session_id: 'spoof' }, context);
  assert.equal(calls[0], '/api/agent-bus/threads/by-participant?kind=codex&sessionId=c1&status=all');
  assert.deepEqual(result.structuredContent.rooms, [
    { id: 'thr_1', title: 'Work', kind: 'room', status: 'open', participants: [{ kind: 'codex', sessionId: 'c1' }] },
    { id: 'thr_dm', title: 'DM', kind: 'dm', status: 'closed', participants: [{ kind: 'codex', sessionId: 'c1' }] },
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
  assert.equal(contextResult.structuredContent.thread.id, 'thr_owned');
  const sent = await server.callTool('room_send', { thread_id: 'thr_owned', body: 'status' }, owner);
  assert.equal(sent.structuredContent.message?.id || 'msg_owned', 'msg_owned');
  assert.deepEqual(calls.find((item) => item.path === '/api/agent-bus/messages').options.body.from,
    { kind: 'claude', sessionId: 'coord' });
  const closed = await server.callTool('room_close', { thread_id: 'thr_owned' }, owner);
  assert.equal(closed.structuredContent.status, 'closed');
  assert.equal((await server.callTool('room_end', { thread_id: 'thr_owned', cancel_pending: true }, owner)).structuredContent.status, 'ended');
  assert.deepEqual(calls.find((item) => item.path.endsWith('/end')).options.body, { cancelPending: true });
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
  assert.deepEqual(result.structuredContent.agents, [{ kind: 'codex', sessionId: 'c1', displayName: 'Builder', state: 'ready', canSendNow: false, canSendNowReason: null }]);
});
