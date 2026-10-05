import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { authPlugin, buildInternalBypassHeaders } from '../modules/platform/auth.mjs';
import { AgentBusStore } from '../modules/agent-bus/store.mjs';
import { AgentBusCredentialStore } from '../modules/agent-bus/mcp-auth.mjs';
import { agentBusPlugin } from '../modules/agent-bus/index.mjs';
import { buildAgentBusMcpServer } from '../modules/agent-bus/mcp.mjs';
import { buildInProcessFastifyRequest } from '../modules/agent-bus/in-process-mcp.mjs';
import { createCodexAppServerSessionProvider } from '../modules/sessions/codex-app-server-sessions.mjs';
import { CodexAppServerTransport } from '../modules/agent/codex-app-server-transport.mjs';
import { TASK_TOOLS } from '../modules/agent-bus/task-routes.mjs';
import { prepareAgentBusCredentialLaunch } from '../modules/integrations/mcp-launch-preflight.mjs';
import { DURABLE_TASK_RECORD_TYPE } from '../modules/sessions/task-record.mjs';

const evidence = { source: 'subprocess_fixture', cliVersion: 'fixture/0.153.4', steerExpectedTurnId: true,
  methods: ['initialize', 'thread/start', 'thread/read', 'thread/resume', 'turn/start', 'turn/steer', 'turn/interrupt', 'mcpServerStatus/list'] };

test('persisted legacy room task metadata survives Fleet bus startup and ordinary room operations', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dueno-legacy-task-metadata-'));
  const seed = new AgentBusStore({ stateDir: root });
  await seed.init();
  const owner = { kind: 'user', sessionId: 'legacy-owner' };
  const values = ['existing task description', true, {}, { provider: 'codex-app-server', attempts: [{ sessionId: 'legacy' }] }];
  const rooms = [];
  for (const task of values) rooms.push(await seed.createThread({ participants: [owner], metadata: { task } }));
  await seed.close();
  const store = new AgentBusStore({ stateDir: root });
  const app = Fastify();
  t.after(async () => { await app.close(); await store.close(); await rm(root, { recursive: true, force: true }); });
  await app.register(authPlugin, { token: 'legacy-room-test', internalBypassToken: 'legacy-room-bypass' });
  await app.register(agentBusPlugin, { store, credentialStore: { init: async () => {}, revoke: async () => {} } });
  await app.ready(); // Previously failed here with unsupported_provider for undefined.
  const headers = buildInternalBypassHeaders({ authToken: 'legacy-room-test', bypassToken: 'legacy-room-bypass' });
  const forged = await app.inject({ method: 'POST', url: '/api/agent-bus/threads', headers,
    payload: { participants: [owner, { kind: 'user', sessionId: 'other' }], metadata: { task: { recordType: DURABLE_TASK_RECORD_TYPE } } } });
  assert.equal(forged.statusCode, 400);
  assert.equal(forged.json().code, 'task_metadata_reserved');
  assert.equal(store.listThreads().length, rooms.length);
  for (const [index, room] of rooms.entries()) {
    const read = await app.inject({ url: `/api/agent-bus/threads/${room.id}`, headers });
    assert.equal(read.statusCode, 200, read.body);
    assert.deepEqual(read.json().thread.metadata.task, values[index]);
    const sent = await app.inject({ method: 'POST', url: '/api/agent-bus/messages', headers,
      payload: { threadId: room.id, from: owner, body: 'Ordinary legacy room message' } });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.equal((await app.inject({ method: 'POST', url: `/api/agent-bus/threads/${room.id}/close`, headers, payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/agent-bus/threads/${room.id}`, headers })).statusCode, 200);
    assert.equal(store.getThread(room.id), null);
  }
});

test('two subprocess tasks require genuine authenticated room reads, collect results and fence delegation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dueno-task-api-'));
  let state;
  const credentials = new AgentBusCredentialStore({ mode: 'enforce', store: {
    mode: 'memory', load: async () => state, save: async (next) => { state = structuredClone(next); }, close: async () => {},
  } });
  const childContexts = new Map();
  const binding = await createCodexAppServerSessionProvider({ sessionRoot: join(root, 'sessions'), credentialStore: credentials,
    mcpCatalog: { servers: [{ id: 'dueno' }] }, modelValidator: async (model) => model,
    prepareLaunch: async (spec) => {
      const issued = await prepareAgentBusCredentialLaunch(spec);
      childContexts.set(spec.sessionId, await credentials.authenticate(issued.token));
      return issued;
    },
    transportFactory: () => new CodexAppServerTransport({ binary: process.execPath,
      argsPrefix: [resolve('tests/fixtures/codex-app-server/provider.mjs'), 'normal'], env: {}, allowedEnvKeys: [], schemaReader: async () => evidence }),
  });
  const store = new AgentBusStore({ stateDir: join(root, 'bus') });
  const app = Fastify();
  t.after(async () => { await app.close(); await binding.close(); await store.close(); await credentials.close(); await rm(root, { recursive: true, force: true }); });
  await app.register(authPlugin, { token: 'task-api-test-operator', internalBypassToken: 'task-api-test-internal' });
  await app.register(agentBusPlugin, { store, credentialStore: credentials });
  await app.ready();
  const requestImpl = buildInProcessFastifyRequest({ app, buildHeaders: () => buildInternalBypassHeaders({ authToken: 'task-api-test-operator', bypassToken: 'task-api-test-internal' }) });
  const mcp = buildAgentBusMcpServer({ requestImpl, credentialStore: credentials });
  const issued = await credentials.issue({ principal: { type: 'agent', kind: 'codex', sessionId: 'parent' },
    attemptGeneration: 1,
    threadAllowlist: ['@member'], toolScopes: ['mcp:discover', 'room_context', 'room_send', ...TASK_TOOLS.map((tool) => tool.name)] });
  const parent = await credentials.authenticate(issued.token);
  const room = await store.createThread({ participants: [{ kind: 'codex', sessionId: 'parent' }] });
  const call = async (name, args, context = parent) => (await mcp.callTool(name, args, context)).structuredContent;
  const spawn = async (key) => {
    const action = await call('task_spawn', { thread_id: room.id, task_key: key,
      spec: { provider: 'codex-app-server', workDir: root, model: 'fixture-model', initialPrompt: 'Complete this task.' } });
    assert.deepEqual(Object.keys(action).sort(), ['task_id', 'thread_id', 'session_id', 'status'].sort());
    assert.doesNotMatch(JSON.stringify(action), /Complete this task|initialPrompt|spec/);
    const status = await call('task_status', { thread_id: room.id, task_id: action.task_id });
    assert.equal(action.status, status.state);
    return status;
  };
  const children = [await spawn('one'), await spawn('two')];
  assert.equal((await spawn('one')).taskId, children[0].taskId);
  assert.equal(binding.service.list().length, 2);
  for (const child of children) {
    const context = childContexts.get(child.sessionId);
    const statusArgs = { thread_id: child.taskId, task_id: child.taskId };
    // Provider tool events alone and metadata-only authorization reads prove nothing.
    await call('task_status', statusArgs, context);
    await call('room_context', { thread_id: child.taskId, summary_only: true }, context);
    await call('room_context', { thread_id: child.taskId, bodies: false }, context);
    assert.equal(store.getThread(child.taskId).thread.metadata.task.startup.roomRead, undefined);
    await assert.rejects(call('room_send', { thread_id: child.taskId, body: 'Premature receipt' }, context), (error) => error.code === 'handshake_reply_invalid');
    await call('room_context', { thread_id: child.taskId }, context);
    await call('room_send', { thread_id: child.taskId, body: 'Authenticated child reply' }, context);
    assert.ok(store.getThread(child.taskId).thread.metadata.task.startup.roomReply.messageId);
    await assert.rejects(call('task_spawn', { thread_id: child.taskId, task_key: 'escape', spec: { provider: 'codex-app-server', model: 'fixture-model', workDir: root } }, context), (error) => error.reason === 'task_parent_required');
    await assert.rejects(call('task_wait', { thread_id: child.taskId, task_ids: [child.taskId] }, context), (error) => error.reason === 'task_consumer_required');
  }
  let cursor;
  const results = new Map();
  for (let i = 0; i < 100 && results.size < 2; i++) {
    let page;
    try {
      page = await call('task_wait', { thread_id: room.id, task_ids: children.map((child) => child.taskId), ...(cursor ? { after: cursor } : {}), timeout_ms: 0, limit: 2 });
    } catch (error) {
      assert.equal(error.code, 'task_wait_timeout');
      await delay(10);
      continue; // Retry the same supplied cursor; never skip its result page.
    }
    cursor = page.cursor;
    assert.ok(page.events.length <= 2);
    for (const result of page.results) results.set(result.taskId, result);
    if (results.size < 2) await delay(10);
  }
  assert.equal(results.size, 2);
  for (const result of results.values()) assert.equal(result.data.state, 'completed');
  const child = children[0];
  const sent = await call('task_send', { thread_id: room.id, task_id: child.taskId, message_key: 'follow-up', input: 'Follow-up input' });
  assert.deepEqual(Object.keys(sent).sort(), ['message_id', 'status']);
  assert.ok(['queued', 'accepted'].includes(sent.status));
  assert.doesNotMatch(JSON.stringify(sent), /Follow-up input/);
  const before = binding.service.get(child.sessionId).turns.length;
  const canceled = await call('task_cancel', { thread_id: room.id, task_id: child.taskId, request_key: 'cancel' });
  assert.deepEqual(Object.keys(canceled).sort(), ['task_id', 'thread_id', 'session_id', 'status'].sort());
  await assert.rejects(call('room_send', { thread_id: child.taskId, body: 'Bypass cancelled task' }), (error) => error.code === 'task_input_required');
  const direct = await requestImpl('/api/agent-bus/messages', { method: 'POST', authContext: parent,
    body: { threadId: child.taskId, from: { kind: 'codex', sessionId: 'parent' }, body: 'Bypass directly', deliveryMode: 'wait' } }).catch((error) => error);
  assert.equal(direct.code, 'task_input_required');
  assert.equal(binding.service.get(child.sessionId).turns.length, before);
  assert.equal(binding.service.list().length, 2);
  assert.ok(children.every((child) => store.getThread(child.taskId).messages.filter((message) => message.metadata.taskSend).length === (child.taskId === children[0].taskId ? 2 : 1)));
  await binding.service.terminate(children[1].sessionId);
  const resumed = await call('task_resume', { thread_id: room.id, task_id: children[1].taskId, request_key: 'replace-ended' });
  assert.deepEqual(Object.keys(resumed).sort(), ['task_id', 'thread_id', 'session_id', 'status'].sort());
  assert.notEqual(resumed.session_id, children[1].sessionId);
  assert.doesNotMatch(JSON.stringify(resumed), /Complete this task|initialPrompt/);
});
