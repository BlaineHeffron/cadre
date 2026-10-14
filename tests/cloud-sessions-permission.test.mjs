import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudSessionsPlugin } from '../modules/integrations/cloud-sessions-plugin.mjs';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';
import { cloudSession, fixture, memoryStore } from './helpers/cloud-sessions-fixture.mjs';

// Its own file: the queue's state dir and the harness's AUTH_TOKEN must be set before their modules load.
test('a cloud permission prompt becomes one operator-only queue item whose answer is posted to the session', async (t) => {
  const f = await fixture(t);
  const stateDir = await mkdtemp(join(tmpdir(), 'cadre-cloud-permission-'));
  Object.assign(process.env, { CADRE_STATE_DIR: stateDir, BROWSER_SESSION_SECRET: 'cloud-permission-test', INTERNAL_BYPASS_TOKEN: 'cloud-permission-test' });
  t.after(async () => {
    for (const key of ['CADRE_STATE_DIR', 'BROWSER_SESSION_SECRET', 'INTERNAL_BYPASS_TOKEN']) delete process.env[key];
    await rm(stateDir, { recursive: true, force: true });
  });
  let shape = {};
  const ask = (requestId) => {
    shape = { worker_status: 'requires_action', external_metadata: {
      post_turn_summary: { needs_action: `Approve or deny claude-code-remote — Delete Trigger (${requestId})` },
      pending_action: { tool_name: 'mcp__claude-code-remote__delete_trigger', display_tool_name: 'claude-code-remote', action_description: 'Delete Trigger',
        request_id: requestId, tool_use_id: `toolu_${requestId}`, input: { trigger_id: 'trig_1' } },
    } };
  };
  f.routes['GET /v1/code/sessions/cse_p'] = () => [200, { response_shape: cloudSession('cse_p', shape) }];
  const posted = [];
  f.routes['POST /v1/code/sessions/cse_p/events'] = (_url, body) => { posted.push(JSON.parse(body)); return [200, { results: [{ sequence_num: 9 }] }]; };

  const commands = [];
  const { commandCenterAIPlugin } = await import('../modules/integrations/command-center-ai.mjs');
  const h = await createAgentBusHarness({ pollMs: 60000, beforeReady: async (app) => {
    await app.register(commandCenterAIPlugin, { enqueueSessionCommand: async (kind, sessionId, input) => { commands.push({ kind, sessionId, ...input }); return { ok: true }; } });
    await cloudSessionsPlugin(app, { store: memoryStore(), cloudOpts: f.opts });
  } });
  t.after(() => h.cleanup());
  const { buildMonitorMcpServer } = await import('../modules/platform/monitor-mcp.mjs');
  const { buildInProcessFastifyRequest } = await import('../modules/agent-bus/in-process-mcp.mjs');
  const { buildInternalBypassHeaders, createBrowserSessionCookieValue, BROWSER_SESSION_COOKIE } = await import('../modules/platform/auth.mjs');
  const request = buildInProcessFastifyRequest({ app: h.app, buildHeaders: () => buildInternalBypassHeaders({ authToken: h.authToken }) });
  const mcp = buildMonitorMcpServer({ requestImpl: request });
  const owner = { kind: 'claude', sessionId: 'claude-1' };
  const asOwner = { authContext: { authenticated: true, principal: { type: 'agent', ...owner } } };
  const operator = { cookie: `${BROWSER_SESSION_COOKIE}=${createBrowserSessionCookieValue()}` };
  const step = () => h.app.agentBusLifecycle.cloudSessions.step();
  const items = async () => (await h.app.inject({ url: '/api/command-center/work-queue?status=all', headers: operator })).json().items.filter((item) => item.source === 'cloud_session');
  const answer = (id, optionId) => h.app.inject({ method: 'POST', url: `/api/command-center/work-queue/${id}/answer`, headers: operator, payload: { optionId } });
  const notices = () => h.store.listThreads().filter((item) => item.metadata?.dm).flatMap((item) => h.store.getThread(item.id).messages).filter((m) => m.from.kind === 'cloud').map((m) => m.body);

  await mcp.handleToolCall('cloud_watch', { id: 'cse_p' }, asOwner);
  ask('req_1');
  await step();
  await step();
  const [item] = await items();
  assert.equal((await items()).length, 1);
  assert.equal(item.status, 'open');
  assert.equal(item.question, 'Allow claude-code-remote — Delete Trigger?');
  assert.match(item.details, /Input: \{"trigger_id":"trig_1"\}/);
  assert.deepEqual(item.options.map((option) => option.id), ['approve', 'reject']);
  assert.match(notices().join('\n'), /needs action: Approve or deny claude-code-remote — Delete Trigger \(req_1\)/);

  // No agent can answer: not the queue item, and not the allow route directly.
  await assert.rejects(mcp.handleToolCall('monitor_answer_human_queue_item', { id: item.id, optionId: 'approve' }, asOwner), /authenticated operator/);
  await assert.rejects(request('/api/cloud/sessions/cse_p/permission', { method: 'POST', body: { request_id: 'req_1' }, ...asOwner }), /Only the operator/);
  assert.equal(posted.length, 0);

  // The operator's Approve posts the allow control_response with the pending input, once.
  assert.equal((await answer(item.id, 'approve')).statusCode, 200);
  assert.equal(posted.length, 1);
  const [event] = posted[0].events;
  assert.equal(posted[0].session_id, 'cse_p');
  assert.equal(event.payload.type, 'control_response');
  assert.deepEqual(event.payload.response, { subtype: 'success', request_id: 'req_1',
    response: { behavior: 'allow', updatedInput: { trigger_id: 'trig_1' }, toolUseID: 'toolu_req_1' } });
  assert.match(commands.at(-1).text, /^\[OPERATOR_ACTION\] approved · POST \/api\/cloud\/sessions\/cse_p\/permission → 200/);
  await step();
  assert.equal(posted.length, 1);

  // A request that clears by itself withdraws its item.
  ask('req_2');
  await step();
  const second = (await items()).find((entry) => entry.status === 'open');
  assert.match(second.operatorAction.body.request_id, /req_2/);
  shape = {};
  await step();
  assert.equal((await items()).find((entry) => entry.id === second.id).status, 'withdrawn');

  // Reject is posted as a deny, once; a stale Approve is refused rather than posted.
  ask('req_3');
  await step();
  const third = (await items()).find((entry) => entry.status === 'open');
  assert.equal((await answer(third.id, 'reject')).statusCode, 200);
  await step();
  await step();
  assert.equal(posted.length, 2);
  assert.deepEqual(posted[1].events[0].payload.response.response, { behavior: 'deny', message: 'Denied by the operator', toolUseID: 'toolu_req_3' });
  const stale = await h.app.inject({ method: 'POST', url: '/api/cloud/sessions/cse_p/permission', headers: operator, payload: { request_id: 'req_1' } });
  assert.equal(stale.statusCode, 409);
  assert.equal(posted.length, 2);
  assert.equal((await items()).length, 3);
});
