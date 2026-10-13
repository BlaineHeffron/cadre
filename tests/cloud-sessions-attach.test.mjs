import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cloudSessionsPlugin } from '../modules/integrations/cloud-sessions-plugin.mjs';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';
import { cloudSession, eventsRoute, fixture, memoryStore } from './helpers/cloud-sessions-fixture.mjs';

// Its own file: the harness must set AUTH_TOKEN before anything loads config.mjs.
test('cloud_attach relays room messages to the cloud session and its replies back, without echoing', async (t) => {
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
  const sends = async () => (await readFile(sendLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  f.events.push(
    { sequence_num: '1', event_type: 'user', source: 'client', payload: { message: { content: 'old task' } } },
    { sequence_num: '2', event_type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'old reply' }] } } },
  );
  f.routes['GET /v1/code/sessions/cse_a/events'] = eventsRoute(f.events);
  f.routes['GET /v1/code/sessions/cse_a'] = () => [200, { response_shape: cloudSession('cse_a', { external_metadata: {} }) }];

  const h = await createAgentBusHarness({ pollMs: 60000, beforeReady: (app) => cloudSessionsPlugin(app, { store: memoryStore(), cloudOpts: { ...f.opts, claudeBin } }) });
  t.after(() => h.cleanup());
  const owner = { kind: 'claude', sessionId: 'claude-1' };
  const peer = { kind: 'codex', sessionId: 'codex-1' };
  const cloud = { kind: 'cloud', sessionId: 'cse_a' };
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

  // Room -> cloud: a peer's message goes out through `claude -p --cloud`, without the room_send hint.
  const sent = await request('/api/agent-bus/messages', { method: 'POST', body: { threadId: thread.id, from: peer, body: 'Please add tests' } });
  assert.equal(sent.deliveries.find((d) => d.target.kind === 'cloud').status, 'injected');
  const [args] = await sends();
  assert.deepEqual([args[0], args[2], args[3]], ['-p', '--cloud', 'cse_a']);
  assert.match(args[1], /from=codex:codex-1\]\nPlease add tests\n\[\/ROOM_MESSAGE\]$/);

  // Cloud -> room: new assistant text after the attach cursor comes back as the cloud participant.
  f.events.push(
    { sequence_num: '3', event_type: 'user', source: 'client', payload: { message: { content: args[1] } } },
    { sequence_num: '4', event_type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'Tests added' }, { type: 'tool_use', name: 'Bash' }] } } },
    { sequence_num: '5', event_type: 'assistant', payload: { message: { content: [{ type: 'tool_use', name: 'Edit' }] } } },
    { sequence_num: '6', event_type: 'result', payload: { result: 'Tests added' } },
  );
  await h.app.agentBusLifecycle.cloudSessions.step();
  await h.app.agentBusLifecycle.cloudSessions.step();
  const fromCloud = h.store.getThread(thread.id).messages.filter((m) => m.from.kind === 'cloud');
  assert.deepEqual(fromCloud.map((m) => m.body), ['Tests added']);
  const relayed = h.store.getThread(thread.id).deliveries.filter((d) => d.messageId === fromCloud[0].id);
  assert.deepEqual(relayed.map((d) => d.target).sort((a, b) => a.kind.localeCompare(b.kind)), [peer, owner].sort((a, b) => a.kind.localeCompare(b.kind)));
  assert.equal(relayed.some((d) => d.target.kind === cloud.kind), false);
  assert.equal((await sends()).length, 1);

  // An owner reply in the watcher's notice DM is never forwarded; room messages still are.
  const dm = await h.app.agentBusLifecycle.directMessage({ from: cloud, target: owner, body: 'Cloud session cse_a done: ok' });
  assert.equal(dm.statusCode, 200);
  const reply = await request('/api/agent-bus/messages', { method: 'POST', body: { threadId: dm.payload.thread.id, from: owner, body: 'done, thanks' } });
  assert.equal(reply.deliveries[0].resolution, 'not_forwarded');
  assert.equal((await sends()).length, 1);
  await request('/api/agent-bus/messages', { method: 'POST', body: { threadId: thread.id, from: owner, body: 'One more thing' } });
  assert.equal((await sends()).length, 2);
});
