import test from 'node:test';
import { config } from '../config.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';
import { buildAgentBusMcpServer } from '../modules/agent-bus/mcp.mjs';
import { buildInProcessFastifyRequest } from '../modules/agent-bus/in-process-mcp.mjs';
import { buildMonitorMcpServer } from '../modules/platform/monitor-mcp.mjs';
import { AgentBusCredentialStore } from '../modules/agent-bus/mcp-auth.mjs';
import { buildInternalBypassHeaders } from '../modules/platform/auth.mjs';
import { agentInterfacePlugin, buildAgentSessionIdempotencyStore } from '../modules/agent/interface.mjs';
import { scheduledAgentsPlugin } from '../modules/integrations/scheduled-agents-plugin.mjs';
import { buildScheduledAgentStore } from '../modules/integrations/scheduled-agents.mjs';
import { githubAgentsPlugin } from '../modules/integrations/github-agents-plugin.mjs';
import { buildGithubAgentRepoStore } from '../modules/integrations/github-agents.mjs';
import { audioPlugin } from '../modules/audio/index.mjs';
import { buildAudioRecordingStore } from '../modules/audio/recordings.mjs';
import { sessionDeliveryAuditPlugin, buildSessionDeliveryAuditStore } from '../modules/sessions/delivery-audit.mjs';

const marker = 'PRIVATE_INPUT_DO_NOT_ECHO';
function memoryState() {
  let saved;
  return { load: async () => saved, save: async (next) => { saved = structuredClone(next); }, close: async () => {} };
}

async function setup(t) {
  const previousEnv = { INTERNAL_BYPASS_TOKEN: process.env.INTERNAL_BYPASS_TOKEN, CADRE_STATE_DIR: process.env.CADRE_STATE_DIR };
  process.env.INTERNAL_BYPASS_TOKEN = 'outputs-test-bypass';
  const previousAuth = { ...config.auth };
  config.auth.token = 'test-token';
  config.auth.internalBypassToken = 'outputs-test-bypass';
  let schedules, recordings, repos, audit;
  const h = await createAgentBusHarness({ authToken: 'test-token', pollMs: 60000, beforeReady: async (app, dir) => {
    process.env.CADRE_STATE_DIR = dir;
    const { commandCenterAIPlugin } = await import(`../modules/integrations/command-center-ai.mjs?outputs=${dir}`);
    await app.register(commandCenterAIPlugin);
    await app.register(agentInterfacePlugin, {
      idempotencyStore: buildAgentSessionIdempotencyStore({ stateStore: memoryState() }),
      getPreferences: async () => ({ claudeEnabled: true, codexEnabled: true }),
    });
    schedules = buildScheduledAgentStore({ stateStore: memoryState() });
    await app.register(scheduledAgentsPlugin, { store: schedules, config: { enabled: false } });
    recordings = buildAudioRecordingStore({ stateStore: memoryState() });
    const inbox = join(dir, 'inbox');
    await mkdir(inbox);
    await writeFile(join(inbox, 'meeting.txt'), marker);
    await app.register(audioPlugin, { store: recordings, config: { ingestEnabled: false, inboxDir: inbox, actionWorkDir: join(dir, 'actions') },
      sessionLauncher: async () => ({ id: 'codex-1', backendType: 'codex' }) });
    repos = buildGithubAgentRepoStore({ stateStore: memoryState() });
    await app.register(githubAgentsPlugin, { repoStore: repos, config: { enabled: false }, fetchImpl: () => { throw new Error('No GitHub requests in tests'); } });
    audit = buildSessionDeliveryAuditStore({ stateStore: memoryState() });
    await app.register(sessionDeliveryAuditPlugin, { store: audit });
  } });
  const credentials = new AgentBusCredentialStore({ store: memoryState() });
  t.after(async () => { await credentials.close(); await h.cleanup(); for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } Object.assign(config.auth, previousAuth); });
  const issued = await credentials.issue({ principal: { type: 'agent', kind: 'pi', sessionId: 'pi-1' }, attemptGeneration: 1, toolScopes: ['*'], threadAllowlist: ['*'] });
  const context = await credentials.authenticate(issued.token);
  const requestImpl = buildInProcessFastifyRequest({ app: h.app, buildHeaders: () => buildInternalBypassHeaders({ authToken: h.authToken, bypassToken: 'outputs-test-bypass' }) });
  const monitor = buildMonitorMcpServer({ requestImpl });
  const mcp = buildAgentBusMcpServer({ requestImpl, credentialStore: credentials,
    extraTools: monitor.allTools.map((tool) => ({ ...tool, handler: (args, context) => monitor.handleToolCall(tool.name, args, context) })) });
  async function call(name, args = {}, keys) {
    const response = await mcp.handleRequest({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args } }, { authContext: context });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    const result = response.result;
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    if (keys) {
      assert.deepEqual(Object.keys(result.structuredContent).sort(), keys.sort(), name);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE_INPUT_DO_NOT_ECHO|startup_prompt|initialPrompt|bodyHash|textHash/, name);
    }
    return result.structuredContent;
  }
  return { h, call, mcp, requestImpl, context, schedules, recordings, repos, audit };
}

test('real MCP actions return ids only while REST retains records and reads expose text', async (t) => {
  const { h, call, requestImpl, context, repos } = await setup(t);
  const spawnKeys = ['thread_id', 'participants'];
  const spawned = await call('spawn_session', { provider: 'codex', initialPrompt: marker, workDir: h.stateDir }, spawnKeys);
  assert.ok(spawned.participants[0].session_id);
  assert.deepEqual(Object.keys(spawned.participants[0]).sort(), ['kind', 'session_id', 'display_name'].sort());
  const pairArgs = { title: 'Pair', workDir: h.stateDir, initialTask: marker, participants: [{ provider: 'claude', display_name: 'Reviewer' }, { provider: 'codex', display_name: 'Implementer' }] };
  const pair = await call('spawn_collab_session', pairArgs, spawnKeys);
  const conference = await call('spawn_conference_session', { ...pairArgs, title: 'Conference' }, spawnKeys);
  assert.deepEqual(pair.participants.map((entry) => entry.display_name), ['Reviewer', 'Implementer']);
  assert.deepEqual(conference.participants.map((entry) => entry.display_name), ['Reviewer', 'Implementer']);
  const read = await call('room_context', { thread_id: pair.thread_id });
  assert.match(read.messages[0].body, /Thread ID/);
  assert.ok(h.store.getThread(pair.thread_id).messages[0].body.includes(marker));
  const sent = await call('room_send', { thread_id: pair.thread_id, body: marker }, ['message_id', 'delivery_count']);
  assert.equal(h.store.getMessage(sent.message_id).body, marker);
  const dm = await call('agent_dm', { kind: 'claude', session_id: 'claude-1', body: marker }, ['message_id', 'delivery_count']);
  assert.equal(h.store.getMessage(dm.message_id).body, marker);
  await call('room_transfer', { thread_id: pair.thread_id, to: { kind: 'pi', session_id: 'pi-1' } }, ['thread_id', 'status']);
  const closed = await call('room_close', { thread_id: pair.thread_id, cancel_pending: true }, ['thread_id', 'status', 'results']);
  assert.equal(closed.status, 'closed');
  const rest = await requestImpl(`/api/agent-bus/threads/${pair.thread_id}`);
  assert.equal(rest.thread.id, pair.thread_id);
  assert.equal(rest.messages.at(-1).body, marker);
  await call('room_reopen', { thread_id: pair.thread_id }, ['thread_id', 'status', 'results']);
  const ended = await call('room_end', { thread_id: conference.thread_id }, ['thread_id', 'status', 'results']);
  for (const row of ended.results) assert.deepEqual(Object.keys(row).sort(), ['session_id', 'status'].sort());
  await call('monitor_terminate_session', { session_id: 'codex-1' }, ['session_id', 'status']);

  await call('monitor_send_to_session', { type: 'claude', sessionId: 'claude-1', text: marker }, ['transaction_id', 'status']);
  const scheduled = await call('register_scheduled_agent', { prompt: marker, workDir: h.stateDir, startImmediately: false }, ['id', 'status']);
  await call('cancel_scheduled_agent', { id: scheduled.id }, ['id', 'status']);
  const loop = await call('spawn_loop_session', { kind: 'claude', session_id: 'claude-1', prompt: marker, interval_seconds: 15, max_iterations: 1 }, ['id', 'status']);
  await call('cancel_scheduled_agent', { id: loop.id }, ['id', 'status']);
  await call('monitor_step_scheduled_agents', {}, ['results']);
  const item = await call('monitor_add_human_queue_item', { title: 'Decision', question: marker }, ['id', 'status']);
  await call('monitor_answer_human_queue_item', { id: item.id, answer: marker }, ['id', 'status']);
  await call('monitor_acknowledge_human_queue_item', { id: item.id, note: marker }, ['id', 'status']);
  const dismiss = await call('monitor_add_human_queue_item', { question: marker }, ['id', 'status']);
  await call('monitor_dismiss_human_queue_item', { id: dismiss.id }, ['id', 'status']);

  await repos.upsertRepo({ owner: 'test', repo: 'outputs', enabled: false, authRef: 'TEST_GITHUB_TOKEN' });
  await call('watch_pr', { repo: 'test/outputs', number: 1, thread_id: pair.thread_id }, ['repo', 'number', 'status']);
  await call('unwatch_pr', { repo: 'test/outputs', number: 1 }, ['repo', 'number', 'status']);
  const output = 'RESULT_TEXT'.repeat(1500);
  h.sessionDetailResponders.codex = ({ sessionId }) => ({ payload: { id: sessionId, content: output, state: { state: 'ended' } } });
  const run = await call('monitor_run_agent_task', { provider: 'codex', workDir: h.stateDir, prompt: marker }, ['status', 'session_id', 'output', 'output_length']);
  assert.equal(run.output, output.slice(-12000));
  assert.equal(run.output_length, output.length);
  assert.equal(h.sessionCatalog.codex.has(run.session_id), false);
  h.sessionDetailResponders.codex = null;
  const scan = await call('monitor_scan_audio_recordings', {}, ['results']);
  assert.ok(scan.results.length);
  await call('monitor_act_on_audio_recording', { id: scan.results[0].id }, ['id', 'session_id', 'status']);
});

test('real MCP session output strips terminal controls before paging while REST stays raw', async (t) => {
  const { h, call, requestImpl } = await setup(t);
  const raw = '\x1b]0;BEL title\x07\x1b]2;ST title\x1b\\'
    + '\x1b[31mred\x1b[0m\x1b[2J\x1b[?25l\x1b[1;2H\x1b[>0c\x1b(B\x1b7\x1b8\x1bc\r\n'
    + 'progress 10%\rprogress 50%\rcomplete\nplain\ttext\r\r\nlast\x1b\r';
  for (const field of ['content', 'output']) {
    h.sessionDetailResponders.codex = () => ({ payload: { [field]: raw } });
    assert.equal((await requestImpl('/api/codex/sessions/codex-1?lines=200'))[field], raw);
    assert.deepEqual(await call('monitor_get_session_output', { type: 'codex', sessionId: 'codex-1' }), {
      session_id: 'codex-1', content: 'red\ncomplete\nplain\ttext\nlast',
    });
  }
  h.sessionDetailResponders.codex = null;
  h.content.codex = '\x1b]0;title\x07' + 'old'.repeat(5000) + '\x1b[32m' + 'recent'.repeat(2000) + '\x1b[0m';
  const tail = await call('monitor_get_session_output', { type: 'codex', sessionId: 'codex-1' });
  assert.equal(tail.content, 'recent'.repeat(2000));
  assert.equal(tail.nextOffset, 12000);
  const older = await call('monitor_get_session_output', { type: 'codex', sessionId: 'codex-1', offset: tail.nextOffset });
  assert.equal(older.content, 'old'.repeat(4000));
  assert.equal(older.nextOffset, 24000);
  const oldest = await call('monitor_get_session_output', { type: 'codex', sessionId: 'codex-1', offset: older.nextOffset });
  assert.deepEqual(oldest, { session_id: 'codex-1', content: 'old'.repeat(1000) });
});

test('real MCP reads honor default limits, filters, paging, and recent output tails', async (t) => {
  const { h, call, mcp, context, schedules, audit } = await setup(t);
  for (let i = 0; i < 56; i++) {
    h.sessionCatalog.codex.add(`page-${i}`);
    await h.store.createThread({ title: `Room ${i}`, participants: [{ kind: 'pi', sessionId: 'pi-1' }] });
    await schedules.register({ prompt: marker, workDir: h.stateDir, startImmediately: false });
    await audit.record({ kind: 'codex', sessionId: 'page-0', text: marker, status: 'sent' });
    await call('monitor_add_human_queue_item', { title: `Item ${i}`, question: marker }, ['id', 'status']);
  }
  for (const [name, key, limit] of [['agent_directory', 'agents', 25], ['room_list', 'rooms', 25], ['monitor_list_threads', 'threads', 25],
    ['monitor_list_codex_sessions', 'sessions', 25], ['list_scheduled_agents', 'tasks', 25], ['monitor_list_human_queue', 'items', 25], ['monitor_list_session_deliveries', 'deliveries', 25]]) {
    const page = await call(name);
    assert.equal(page[key].length, limit, name);
    assert.equal(page.nextOffset, limit, name);
    const next = await call(name, { offset: page.nextOffset });
    assert.ok(next[key].length, name);
    const ids = new Set(page[key].map((row) => row.id || `${row.kind}:${row.sessionId}`));
    assert.ok(next[key].every((row) => !ids.has(row.id || `${row.kind}:${row.sessionId}`)), name);
    assert.doesNotMatch(JSON.stringify(page), /PRIVATE_INPUT_DO_NOT_ECHO|capabilities/);
  }
  assert.equal((await call('list_scheduled_agents', { compact: false, limit: 1 })).tasks[0].prompt, marker);
  assert.equal((await call('monitor_list_human_queue', { compact: false, limit: 1 })).items[0].question, marker);
  const schedule = (await schedules.list())[0];
  const policy = { version: 1, profile: 'coordinator-v1', policyId: 'outputs', scheduleId: schedule.id, repository: 'test/outputs', repositories: ['test/outputs'], projectRoots: [h.stateDir], protectedSessionIds: [] };
  const { resolveScheduledCoordinatorPolicy } = await import('../modules/agent-bus/coordinator-policy.mjs');
  const coordinatorPolicy = resolveScheduledCoordinatorPolicy({ coordinatorControlPolicy: policy }, { scheduleId: schedule.id, workDir: h.stateDir });
  const scoped = await mcp.callTool('list_scheduled_agents', { limit: 1 }, { ...context, coordinatorPolicy });
  assert.equal(scoped.structuredContent.total, 1);
  assert.equal(scoped.structuredContent.tasks[0].id, schedule.id);
  assert.equal(scoped.structuredContent.nextOffset, undefined);
  const filtered = await call('agent_directory', { kind: 'codex', state: 'unknown', limit: 2 });
  assert.equal(filtered.agents.length, 2);
  assert.ok(filtered.agents.every((row) => row.kind === 'codex' && row.state === 'unknown'));
  const room = await h.store.createThread({ participants: [] });
  for (let i = 0; i < 12; i++) await h.store.createMessage({ threadId: room.id, from: { kind: 'pi', sessionId: 'pi-1' }, body: `${i}-${marker}`, metadata: { summary: `Summary ${i}` } });
  const recent = await call('room_context', { thread_id: room.id });
  assert.equal(recent.messages.length, 8);
  assert.ok(recent.messages[0].body.startsWith('4-'));
  const first = h.store.getThread(room.id).messages[0];
  const forward = await call('room_context', { thread_id: room.id, since: first.id, limit: 2 });
  assert.deepEqual(forward.messages.map((m) => m.id), h.store.getThread(room.id).messages.slice(1, 3).map((m) => m.id));
  const more = await call('room_context', { thread_id: room.id, since: forward.messages.at(-1).id, limit: 2 });
  assert.deepEqual(more.messages.map((m) => m.id), h.store.getThread(room.id).messages.slice(3, 5).map((m) => m.id));
  const summaries = await call('room_context', { thread_id: room.id, summary_only: true });
  assert.doesNotMatch(JSON.stringify(summaries), /PRIVATE_INPUT_DO_NOT_ECHO|bodyLength/);
  assert.ok(JSON.stringify(summaries).length < JSON.stringify(recent).length);
  h.content.codex = 'old'.repeat(5000) + 'recent'.repeat(2000);
  const tail = await call('monitor_get_session_output', { type: 'codex', sessionId: 'codex-1' });
  assert.equal(tail.content, 'recent'.repeat(2000));
  assert.equal(tail.nextOffset, 12000);
  const older = await call('monitor_get_session_output', { type: 'codex', sessionId: 'codex-1', offset: tail.nextOffset });
  assert.equal(older.content, 'old'.repeat(4000));
});


test('real MCP dispatcher rejects unknown, missing, wrong-type and enum arguments before handlers', async (t) => {
  const { mcp, context } = await setup(t);
  for (const [name, args, message] of [
    ['room_context', { threadId: 'bad' }, /room_context: unknown argument "threadId"; expected: thread_id/],
    ['room_context', {}, /room_context: missing required argument "thread_id"/],
    ['room_context', { thread_id: 12 }, /room_context: argument "thread_id" must be string/],
    ['monitor_terminate_session', { type: 'codex', sessionId: 'bad' }, /monitor_terminate_session: unknown argument "type"; expected: session_id/],
    ['monitor_terminate_session', {}, /monitor_terminate_session: missing required argument "session_id"/],
    ['monitor_terminate_session', { session_id: '' }, /monitor_terminate_session: argument "session_id" must NOT have fewer than 1 characters/],
    ['monitor_terminate_session', { session_id: '   ' }, /monitor_terminate_session: argument "session_id" must match pattern/],
    ['monitor_terminate_session', { session_id: 12 }, /monitor_terminate_session: argument "session_id" must be string/],
    ['room_list', { scope: 'bogus' }, /room_list: argument "scope" must be equal to one of the allowed values: all/],
    ['monitor_list_human_queue', { status: 'bogus' }, /monitor_list_human_queue: argument "status" must be equal to one of the allowed values/],
    ['task_status', {}, /task_status: missing required argument "thread_id"/],
    ['room_transfer', { thread_id: 'bad', to: { kind: 'codex', sessionId: 'bad' } }, /room_transfer: unknown argument "to.sessionId"; expected: kind, session_id/],
    ['room_context', null, /room_context: argument "arguments" must be object/],
    ['monitor_terminate_session', false, /monitor_terminate_session: argument "arguments" must be object/],
  ]) {
    const response = await mcp.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { authContext: context });
    assert.equal(response.error?.code, -32602, JSON.stringify(response));
    assert.match(response.error.message, message);
  }
});
