import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { config } from '../config.mjs';
import { authPlugin, createBrowserSessionCookieValue, BROWSER_SESSION_COOKIE } from '../modules/platform/auth.mjs';
import { buildInProcessFastifyRequest } from '../modules/agent-bus/in-process-mcp.mjs';
import { buildMonitorMcpServer } from '../modules/platform/monitor-mcp.mjs';

// Import the queue after choosing its hermetic on-disk store.
test('requesters withdraw, edit, and filter queue items through the real routes and MCP tools', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-queue-requester-'));
  const priorDir = process.env.CADRE_STATE_DIR;
  const priorSecret = config.auth.browserSessionSecret;
  process.env.CADRE_STATE_DIR = dir;
  config.auth.browserSessionSecret = 'queue-requester-browser-fixture';
  t.after(async () => {
    if (priorDir === undefined) delete process.env.CADRE_STATE_DIR;
    else process.env.CADRE_STATE_DIR = priorDir;
    config.auth.browserSessionSecret = priorSecret;
    await rm(dir, { recursive: true, force: true });
  });
  const { commandCenterAIPlugin } = await import('../modules/integrations/command-center-ai.mjs');
  const app = Fastify();
  t.after(() => app.close());
  const commands = [];
  await app.register(authPlugin, { token: 'fixture-token', internalBypassToken: 'fixture-bypass' });
  await app.register(commandCenterAIPlugin, { enqueueSessionCommand: async (kind, sessionId, input) => { commands.push({ kind, sessionId, ...input }); return { ok: true }; } });
  const requestImpl = buildInProcessFastifyRequest({ app, buildHeaders: () => ({
    authorization: 'Bearer fixture-token', 'x-dueno-internal': 'fixture-bypass', 'x-dueno-internal-ts': new Date().toISOString(),
  }) });
  const monitor = buildMonitorMcpServer({ requestImpl });
  const as = (sessionId) => (name, args) => monitor.handleToolCall(name, args, { authContext: { authenticated: true, principal: { type: 'agent', kind: 'codex', sessionId } } });
  const requester = as('requester');
  const other = as('other');
  const operatorHeaders = { cookie: `${BROWSER_SESSION_COOKIE}=${createBrowserSessionCookieValue()}` };
  const create = (extra = {}) => requester('monitor_add_human_queue_item', {
    question: 'Which plan?', sessionKind: 'codex', sessionId: 'requester', passThrough: true, ...extra,
  });

  await t.test('self-dismissal is a silent withdrawal; operator dismissal still notifies', async () => {
    const own = await create();
    assert.deepEqual(await requester('monitor_dismiss_human_queue_item', { id: own.id }), { id: own.id, status: 'withdrawn' });
    assert.equal(commands.length, 0);
    const listed = await requester('monitor_list_human_queue', { status: 'withdrawn' });
    assert.deepEqual(listed.items.map((item) => item.id), [own.id]);

    const byOperator = await create();
    const response = await app.inject({ method: 'POST', url: `/api/command-center/work-queue/${byOperator.id}/dismiss`, headers: operatorHeaders, payload: {} });
    assert.equal(response.json().status, 'dismissed');
    assert.equal(commands.length, 1);
    assert.equal(commands[0].sessionId, 'requester');
    assert.match(commands[0].text, /Dismissed by the operator without an answer/);
  });

  await t.test('only the requester can edit, and only while the item is open', async () => {
    const { id } = await create({ details: 'old', options: [{ label: 'A' }] });
    assert.deepEqual(await requester('monitor_update_human_queue_item', {
      id, question: 'Which plan now?', details: 'new', options: [{ label: 'B' }, { label: 'C' }],
    }), { id, status: 'open' });
    const item = (await requester('monitor_list_human_queue', { compact: false })).items.find((entry) => entry.id === id);
    assert.equal(item.question, 'Which plan now?');
    assert.equal(item.details, 'new');
    assert.deepEqual(item.options.map((option) => option.label), ['B', 'C']);
    assert.equal(item.events.at(-1).type, 'updated');

    await assert.rejects(other('monitor_update_human_queue_item', { id, details: 'hijack' }), (error) => error.statusCode === 403);
    // The delivery target is not the requester: ownership comes from the authenticated creator.
    const forOther = await requester('monitor_add_human_queue_item', { question: 'For other?', sessionKind: 'codex', sessionId: 'other', passThrough: true });
    await assert.rejects(other('monitor_update_human_queue_item', { id: forOther.id, details: 'not mine' }), (error) => error.statusCode === 403);
    assert.deepEqual(await requester('monitor_update_human_queue_item', { id: forOther.id, details: 'mine' }), { id: forOther.id, status: 'open' });
    const untargeted = await requester('monitor_add_human_queue_item', { question: 'No target?', details: 'stale' });
    await assert.rejects(requester('monitor_update_human_queue_item', { id: untargeted.id, question: ' ', details: 'kept?' }), (error) => error.statusCode === 400);
    assert.deepEqual(await requester('monitor_update_human_queue_item', { id: untargeted.id, details: '' }), { id: untargeted.id, status: 'open' });
    const untargetedItem = (await requester('monitor_list_human_queue', { compact: false })).items.find((entry) => entry.id === untargeted.id);
    assert.equal(untargetedItem.question, 'No target?');
    assert.equal(untargetedItem.details, '');
    assert.deepEqual(await requester('monitor_dismiss_human_queue_item', { id: untargeted.id }), { id: untargeted.id, status: 'withdrawn' });
    assert.deepEqual(await requester('monitor_dismiss_human_queue_item', { id: forOther.id }), { id: forOther.id, status: 'withdrawn' });
    const asClaude = (name, args) => monitor.handleToolCall(name, args, { authContext: { authenticated: true, principal: { type: 'agent', kind: 'claude', sessionId: 'requester' } } });
    await assert.rejects(asClaude('monitor_update_human_queue_item', { id, details: 'wrong kind' }), (error) => error.statusCode === 403);
    const approval = await requester('monitor_add_human_queue_item', { question: 'Run?', operatorAction: { method: 'POST', path: '/api/agents/github', body: {} } });
    await assert.rejects(requester('monitor_update_human_queue_item', { id: approval.id, options: [{ label: 'Yes' }] }), (error) => error.statusCode === 400);
    assert.deepEqual(await requester('monitor_update_human_queue_item', { id: approval.id, details: 'more context' }), { id: approval.id, status: 'open' });
    await requester('monitor_dismiss_human_queue_item', { id });
    await assert.rejects(requester('monitor_update_human_queue_item', { id, details: 'late' }), (error) => error.statusCode === 409);
  });

  await t.test('source and sessionId filters narrow the list', async () => {
    const mine = await create({ source: 'filter-src' });
    const theirs = await other('monitor_add_human_queue_item', { question: 'Theirs?', sessionKind: 'codex', sessionId: 'other', source: 'filter-src' });
    const ids = async (args) => (await requester('monitor_list_human_queue', args)).items.map((item) => item.id).sort();
    assert.ok((await ids({ status: 'all' })).length > 2);
    assert.deepEqual(await ids({ source: 'filter-src' }), [mine.id, theirs.id].sort());
    assert.deepEqual(await ids({ source: 'filter-src', sessionId: 'other' }), [theirs.id]);
    assert.deepEqual(await ids({ source: 'missing' }), []);
  });
});
