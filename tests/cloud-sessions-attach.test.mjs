import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cloudSessionsPlugin } from '../modules/integrations/cloud-sessions-plugin.mjs';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';
import { cloudSession, eventsRoute, fixture, memoryStore } from './helpers/cloud-sessions-fixture.mjs';

// Its own file: the harness must set AUTH_TOKEN before anything loads config.mjs.
test('cloud_attach relays addressed room messages to the cloud session and its replies back, never cloud to cloud; cloud_detach ends both', async (t) => {
  const f = await fixture(t);
  process.env.INTERNAL_BYPASS_TOKEN = 'cloud-attach-test';
  t.after(() => { delete process.env.INTERNAL_BYPASS_TOKEN; });
  const sendLog = join(f.dir, 'sends.log');
  const claudeBin = join(f.dir, 'claude');
  await writeFile(claudeBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(sendLog)}, JSON.stringify(args) + '\\n');
process.stdout.write(JSON.stringify({ ok: true, session_id: args[args.indexOf('--cloud') + 1] }));
`);
  await chmod(claudeBin, 0o755);
  const allSends = async () => (await readFile(sendLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const sends = async (id = 'cse_a') => (await allSends()).filter((args) => args[3] === id);
  f.events.push(
    { sequence_num: '1', event_type: 'user', source: 'client', payload: { message: { content: 'old task' } } },
    { sequence_num: '2', event_type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'old reply' }] } } },
  );
  f.routes['GET /v1/code/sessions/cse_a/events'] = eventsRoute(f.events);
  let shape = { external_metadata: {} };
  f.routes['GET /v1/code/sessions/cse_a'] = () => [200, { response_shape: cloudSession('cse_a', shape) }];
  f.routes['GET /v1/code/sessions/cse_b/events'] = eventsRoute([]);
  f.routes['GET /v1/code/sessions/cse_b'] = () => [200, { response_shape: cloudSession('cse_b', { title: 'Reviewer', external_metadata: {} }) }];

  const h = await createAgentBusHarness({ pollMs: 60000, beforeReady: (app) => cloudSessionsPlugin(app, { store: memoryStore(), cloudOpts: { ...f.opts, claudeBin } }) });
  t.after(() => h.cleanup());
  const owner = { kind: 'claude', sessionId: 'claude-1' };
  const peer = { kind: 'codex', sessionId: 'codex-1' };
  const cloud = { kind: 'cloud', sessionId: 'cse_a' };
  const cloudB = { kind: 'cloud', sessionId: 'cse_b' };
  const thread = await h.store.createThread({ title: 'cloud room', participants: [owner, peer], createdBy: owner });
  const { buildMonitorMcpServer } = await import('../modules/platform/monitor-mcp.mjs');
  const { buildInProcessFastifyRequest } = await import('../modules/agent-bus/in-process-mcp.mjs');
  const { buildInternalBypassHeaders } = await import('../modules/platform/auth.mjs');
  const request = buildInProcessFastifyRequest({ app: h.app, buildHeaders: () => buildInternalBypassHeaders({ authToken: h.authToken }) });
  const mcp = buildMonitorMcpServer({ requestImpl: request });
  const as = (ref) => ({ authContext: { authenticated: true, principal: { type: 'agent', ...ref } } });

  await assert.rejects(mcp.handleToolCall('cloud_attach', { id: 'cse_a', thread_id: thread.id }, as({ kind: 'pi', sessionId: 'pi-1' })), /Room owner or participant/);
  const attached = await mcp.handleToolCall('cloud_attach', { id: 'cse_a', thread_id: thread.id }, as(owner));
  assert.deepEqual(attached, { id: 'cse_a', thread_id: thread.id, status: 'attached' });
  assert.ok(h.store.getThread(thread.id).thread.participants.some((p) => p.kind === 'cloud' && p.sessionId === 'cse_a'));
  await mcp.handleToolCall('cloud_attach', { id: 'cse_b', thread_id: thread.id }, as(owner));
  const post = (from, body, extra = {}) => request('/api/agent-bus/messages', { method: 'POST', body: { threadId: thread.id, from, body, ...extra } });
  const cloudTargets = (sent) => sent.deliveries.filter((d) => d.target.kind === 'cloud').map((d) => d.target.sessionId).sort();

  // A cloud turn costs credits, so a message not addressed to a cloud reaches none.
  assert.deepEqual(cloudTargets(await post(peer, 'Please add tests')), []);
  assert.deepEqual(cloudTargets(await post(peer, 'Reviewer, take a look')), ['cse_b']);
  assert.deepEqual(await sends(), []);

  // Room -> cloud: an addressed message goes out through `claude -p --cloud`, without the room_send hint.
  const sent = await post(peer, 'cse_a: please add tests');
  assert.deepEqual(cloudTargets(sent), ['cse_a']);
  assert.equal(sent.deliveries.find((d) => d.target.kind === 'cloud').status, 'injected');
  const [args] = await sends();
  assert.deepEqual([args[0], args[2], args[3]], ['-p', '--cloud', 'cse_a']);
  assert.match(args[1], /from=codex:codex-1\]\ncse_a: please add tests\n\[\/ROOM_MESSAGE\]$/);
  assert.deepEqual(cloudTargets(await post(owner, '@clouds status?')), ['cse_a', 'cse_b']);
  assert.equal((await sends()).length, 2);

  // Cloud -> room: one message per turn, its final reply; progress notes stay in cloud_output.
  const fromCloudBodies = () => h.store.getThread(thread.id).messages.filter((m) => participantIs(m.from, cloud)).map((m) => m.body);
  f.events.push(
    { sequence_num: '3', event_type: 'user', source: 'client', payload: { message: { content: args[1] } } },
    { sequence_num: '4', event_type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'Reading the suite' }, { type: 'tool_use', name: 'Bash' }] } } },
    { sequence_num: '5', event_type: 'assistant', payload: { message: { content: [{ type: 'tool_use', name: 'Edit' }] } } },
    { sequence_num: '6', event_type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'Tests added' }] } } },
  );
  await h.app.agentBusLifecycle.cloudSessions.step();
  assert.deepEqual(fromCloudBodies(), []);
  f.events.push({ sequence_num: '7', event_type: 'result', payload: { result: 'Tests added' } });
  await h.app.agentBusLifecycle.cloudSessions.step();
  await h.app.agentBusLifecycle.cloudSessions.step();
  assert.deepEqual(fromCloudBodies(), ['Tests added']);
  const fromCloud = h.store.getThread(thread.id).messages.filter((m) => m.from.kind === 'cloud');
  const relayed = h.store.getThread(thread.id).deliveries.filter((d) => d.messageId === fromCloud[0].id);
  assert.deepEqual(relayed.map((d) => d.target).sort((a, b) => a.kind.localeCompare(b.kind)), [peer, owner].sort((a, b) => a.kind.localeCompare(b.kind)));
  // Never cloud to cloud, however it is addressed: that is the echo loop.
  assert.equal(relayed.some((d) => d.target.kind === cloud.kind), false);
  assert.deepEqual(cloudTargets(await post(cloudB, '@clouds cse_a: done here')), []);
  assert.equal((await sends()).length, 2);
  // A turn with no assistant text relays its result text.
  f.events.push({ sequence_num: '8', event_type: 'result', payload: { subtype: 'success', result: 'Nothing to change' } });
  await h.app.agentBusLifecycle.cloudSessions.step();
  assert.deepEqual(fromCloudBodies(), ['Tests added', 'success: Nothing to change']);

  // An owner reply in the watcher's notice DM is never forwarded; room messages still are.
  const dm = await h.app.agentBusLifecycle.directMessage({ from: cloud, target: owner, body: 'Cloud session cse_a done: ok' });
  assert.equal(dm.statusCode, 200);
  const reply = await request('/api/agent-bus/messages', { method: 'POST', body: { threadId: dm.payload.thread.id, from: owner, body: 'done, thanks', replyTo: dm.payload.message.id } });
  assert.equal(reply.deliveries[0].resolution, 'not_forwarded');
  assert.equal((await sends()).length, 2);
  // A reply to a cloud's message is addressed to that cloud.
  assert.deepEqual(cloudTargets(await post(owner, 'One more thing', { replyTo: fromCloud[0].id })), ['cse_a']);
  assert.equal((await sends()).length, 3);

  // A cloud session has no room_context, so long bodies arrive whole, up to the cap, and say when cut.
  const long = `Plan:\n${'a'.repeat(5000)}`;
  await post(peer, long, { replyTo: fromCloud[0].id });
  const whole = (await sends()).at(-1)[1];
  assert.ok(whole.includes(long));
  assert.doesNotMatch(whole, /room_context|Summary:/);
  await post(peer, 'b'.repeat(25000), { replyTo: fromCloud[0].id });
  const cut = (await sends()).at(-1)[1];
  assert.match(cut, /\nb{20000}\n\[Body truncated: showing 20000 of 25000 characters\]\n\[\/ROOM_MESSAGE\]$/);

  // An attached session finishing a turn is not DMed to its owner as done; its reply is already in the room.
  const dms = () => h.store.listThreads().filter((item) => item.metadata?.dm).flatMap((item) => h.store.getThread(item.id).messages).filter((m) => m.from.kind === 'cloud').length;
  const before = dms();
  shape = { worker_status: 'running', status_bucket: 'working', external_metadata: {} };
  await h.app.agentBusLifecycle.cloudSessions.step();
  shape = { external_metadata: { post_turn_summary: { status_detail: 'waiting on gate' } } };
  await h.app.agentBusLifecycle.cloudSessions.step();
  assert.equal(dms(), before);

  // cloud_detach: same authorization as attach; the session leaves the room both ways but stays watched.
  await assert.rejects(mcp.handleToolCall('cloud_detach', { id: 'cse_a', thread_id: thread.id }, as({ kind: 'pi', sessionId: 'pi-1' })), /Room owner or participant/);
  assert.deepEqual(await mcp.handleToolCall('cloud_detach', { id: 'cse_a', thread_id: thread.id }, as(peer)), { id: 'cse_a', thread_id: thread.id, status: 'detached' });
  assert.equal(h.store.getThread(thread.id).thread.participants.some((p) => participantIs(p, cloud)), false);
  assert.deepEqual(cloudTargets(await post(owner, '@clouds cse_a, still there?')), ['cse_b']);
  const relayedBefore = fromCloudBodies().length;
  f.events.push(
    { sequence_num: '9', event_type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'After detach' }] } } },
    { sequence_num: '10', event_type: 'result', payload: { result: 'After detach' } },
  );
  await h.app.agentBusLifecycle.cloudSessions.step();
  assert.equal(fromCloudBodies().length, relayedBefore);
  assert.ok(h.app.agentBusLifecycle.cloudSessions.get('cse_a'));
});

const participantIs = (a, b) => a.kind === b.kind && a.sessionId === b.sessionId;
