import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { authPlugin, buildInternalBypassHeaders } from '../modules/platform/auth.mjs';
import { buildInProcessFastifyRequest } from '../modules/agent-bus/in-process-mcp.mjs';
import { buildAgentBusMcpServer } from '../modules/agent-bus/mcp.mjs';
import { registerTaskRoutes, TASK_TOOLS } from '../modules/agent-bus/task-routes.mjs';
import { AgentBusCredentialStore } from '../modules/agent-bus/mcp-auth.mjs';
import { prepareAgentBusCredentialLaunch } from '../modules/integrations/mcp-launch-preflight.mjs';

const owner = { kind: 'codex', sessionId: 'parent' };
const context = { authenticated: true, principal: { type: 'agent', ...owner },
  toolScopes: TASK_TOOLS.map((tool) => tool.name), threadAllowlist: ['@member'] };

async function setup(t) {
  const room = { id: 'room', participants: [owner, { kind: 'codex', sessionId: 'other' }] };
  const tasks = { child: { taskId: 'child', ownerRef: owner, parentRef: owner, threadId: 'task-room', parentThreadId: 'room', provider: 'codex-app-server', sessionId: 'child-session' } };
  const calls = [];
  const service = { status: (id) => {
    if (!tasks[id]) throw Object.assign(new Error('Task not found'), { statusCode: 404, code: 'task_not_found' });
    return tasks[id];
  } };
  for (const action of ['spawn', 'send', 'wait', 'cancel', 'resume']) service[action] = async (...args) => {
    calls.push({ action, args }); return { state: 'queued', operation: action };
  };
  const app = Fastify();
  await app.register(authPlugin, { token: 'task-test-operator', internalBypassToken: 'task-test-internal' });
  const store = { getThread: (id) => id === room.id ? { thread: room } : null };
  app.get('/api/agent-bus/threads/:id', async () => ({ thread: room }));
  registerTaskRoutes({ app, store, service });
  await app.ready();
  t.after(() => app.close());
  const requestImpl = buildInProcessFastifyRequest({ app, buildHeaders: () => buildInternalBypassHeaders({ authToken: 'task-test-operator', bypassToken: 'task-test-internal' }) });
  const mcp = buildAgentBusMcpServer({ requestImpl, credentialStore: { recordRejectedCall: async () => {} } });
  return { app, mcp, calls, tasks, requestImpl };
}

test('task MCP crosses real HTTP auth with stable owner, consumer identity and explicit steering', async (t) => {
  const { mcp, calls } = await setup(t);
  await mcp.callTool('task_spawn', { thread_id: 'room', task_key: 'one', spec: { provider: 'codex-app-server', model: 'gpt-6-astra', workDir: '/tmp' } }, context);
  assert.deepEqual(calls[0].args[2].ownerRef, owner);
  assert.equal(calls[0].args[2].permissionMode, 'workspace-write');
  await mcp.callTool('task_send', { thread_id: 'room', task_id: 'child', message_key: 'm1', input: 'next' }, context);
  assert.equal(calls.at(-1).args[3].mode, 'queue');
  await mcp.callTool('task_send', { thread_id: 'room', task_id: 'child', message_key: 'm2', input: 'steer', mode: 'steer', expected_turn_id: 'turn1' }, context);
  assert.deepEqual(calls.at(-1).args[3], { mode: 'steer', expectedTurnId: 'turn1' });
  await mcp.callTool('task_wait', { thread_id: 'room', task_ids: ['child'], after: 'cursor', timeout_ms: 10 }, context);
  assert.deepEqual(calls.at(-1).args, [['child'], 'cursor', 10, { consumerId: 'codex:parent', limit: 50 }]);
});

test('task authority rejects unowned tasks, wrong rooms and missing scopes; strips caller launch authority', async (t) => {
  const { mcp, calls, tasks, requestImpl, app } = await setup(t);
  const status = { thread_id: 'room', task_id: 'child' };
  await assert.rejects(mcp.callTool('task_status', status, { ...context, principal: { type: 'agent', kind: 'codex', sessionId: 'other' } }), (e) => e.reason === 'task_owner_required');
  tasks.child.parentThreadId = 'elsewhere';
  await assert.rejects(mcp.callTool('task_status', status, context), (e) => e.reason === 'task_thread_mismatch');
  tasks.child.parentThreadId = 'room';
  await assert.rejects(mcp.callTool('task_status', status, { ...context, toolScopes: [] }), (e) => e.reason === 'scope_missing');
  await assert.rejects(requestImpl('/api/agent-bus/tasks/status', { method: 'POST', body: status, authContext: { ...context, toolScopes: [] } }), (e) => e.reason === 'scope_missing');
  assert.equal(calls.length, 0);
  await mcp.callTool('task_spawn', { thread_id: 'room', task_key: 'one', spec: { provider: 'codex-app-server', model: 'gpt-6-astra', workDir: '/tmp', env: { EVIL: 'value' }, ownerRef: { kind: 'ui', sessionId: 'spoof' } } }, context);
  assert.equal(calls.at(-1).args[2].env, undefined);
  assert.deepEqual(calls.at(-1).args[2].ownerRef, owner);
  const unauthenticated = await app.inject({ method: 'POST', url: '/api/agent-bus/tasks/status', payload: status });
  assert.equal(unauthenticated.statusCode, 401);
});

test('replacement parent consumes child results using its current session identity', async (t) => {
  const { mcp, tasks, calls } = await setup(t);
  tasks.child.currentParentRef = { kind: 'codex', sessionId: 'other' };
  tasks.child.parentTaskId = 'parent-task';
  tasks['parent-task'] = { taskId: 'parent-task', sessionId: 'other', provider: 'codex' };
  const args = { thread_id: 'room', task_ids: ['child'], timeout_ms: 0 };
  await assert.rejects(mcp.callTool('task_wait', args, context), (e) => e.reason === 'task_consumer_required');
  await mcp.callTool('task_wait', args, { ...context, principal: { type: 'agent', ...tasks.child.currentParentRef } });
  assert.equal(calls.at(-1).args[3].consumerId, 'codex:other');
});

test('MCP task failures expose the HTTP domain code to the calling model', async (t) => {
  const { mcp } = await setup(t);
  const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'task_status', arguments: { thread_id: 'room', task_id: 'missing' },
  } };
  const response = await mcp.handleRequest(message, { authContext: context });
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.structuredContent, { error: 'Task not found', code: 'task_not_found', statusCode: 404 });
  assert.equal(JSON.parse(response.result.content[0].text).code, 'task_not_found');
  const forbidden = await mcp.handleRequest(message, { authContext: { ...context, toolScopes: [] } });
  assert.equal(forbidden.error.code, -32003);
});

test('bounded task launch credentials cannot escape through ordinary spawn tools', async () => {
  let state;
  const store = new AgentBusCredentialStore({ mode: 'enforce', store: {
    mode: 'memory', load: async () => state, save: async (next) => { state = structuredClone(next); }, close: async () => {},
  } });
  try {
    const issued = await prepareAgentBusCredentialLaunch({ backendType: 'codex-app-server', sessionId: 'bounded-child',
      toolScopes: ['mcp:discover', 'room_context', 'room_send', 'task_spawn', 'task_wait'],
      threadAllowlist: ['task-room'], inheritSpawnScopes: false, credentialStore: store });
    const auth = await store.authenticate(issued.token);
    assert.deepEqual(auth.threadAllowlist, ['task-room']);
    const mcp = buildAgentBusMcpServer({ requestImpl: async () => { throw new Error('Must not dispatch'); }, credentialStore: store });
    await assert.rejects(mcp.callTool('spawn_session', { provider: 'codex' }, auth), (e) => e.reason === 'scope_missing');
    assert.equal(auth.toolScopes.includes('*'), false);
  } finally { await store.close(); }
});
