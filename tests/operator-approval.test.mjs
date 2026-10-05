import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';
import { config } from '../config.mjs';
import { authPlugin, createBrowserSessionCookieValue, BROWSER_SESSION_COOKIE } from '../modules/platform/auth.mjs';
import { buildInProcessFastifyRequest } from '../modules/agent-bus/in-process-mcp.mjs';
import { buildMonitorMcpServer } from '../modules/platform/monitor-mcp.mjs';
import { githubAgentsPlugin } from '../modules/integrations/github-agents-plugin.mjs';
import { buildGithubAgentRepoStore } from '../modules/integrations/github-agents.mjs';

// Import the queue after choosing its hermetic on-disk store.
test('operator actions use the real queue, auth, MCP transport and GitHub routes', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-operator-approval-'));
  const priorDir = process.env.CADRE_STATE_DIR;
  const priorSecret = config.auth.browserSessionSecret;
  process.env.CADRE_STATE_DIR = dir;
  config.auth.browserSessionSecret = 'operator-approval-browser-fixture';
  t.after(async () => {
    if (priorDir === undefined) delete process.env.CADRE_STATE_DIR;
    else process.env.CADRE_STATE_DIR = priorDir;
    config.auth.browserSessionSecret = priorSecret;
    await rm(dir, { recursive: true, force: true });
  });
  const { commandCenterAIPlugin, OPERATOR_ACTION_ROUTES } = await import('../modules/integrations/command-center-ai.mjs');
  const app = Fastify();
  t.after(() => app.close());
  const commands = [];
  const executions = [];
  await app.register(authPlugin, { token: 'fixture-token', internalBypassToken: 'fixture-bypass' });
  app.addHook('preHandler', async (req) => {
    if (req.method !== 'GET' && req.url.startsWith('/api/agents/github')) executions.push({ principal: req.duenoAuth.principal, body: req.body });
  });
  const repoStore = buildGithubAgentRepoStore({ storeFile: join(dir, 'github-repos.json'), env: { APP_STATE_STORAGE: 'file' } });
  await app.register(githubAgentsPlugin, { repoStore, config: { enabled: false }, env: {}, fetchImpl: () => { throw new Error('No network allowed'); } });
  await app.register(commandCenterAIPlugin, { enqueueSessionCommand: async (kind, sessionId, input) => { commands.push({ kind, sessionId, ...input }); return { ok: true }; } });
  if (process.env.CHROMIUM_BIN) {
    const root = fileURLToPath(new URL('../', import.meta.url));
    await app.register(fastifyStatic, { root: join(root, 'public'), prefix: '/' });
    await app.register(fastifyStatic, { root: join(root, 'node_modules'), prefix: '/vendor/npm/', decorateReply: false });
    const index = await readFile(join(root, 'public/index.html'), 'utf8');
    app.get('/queue-fixture', async (_req, reply) => reply.type('text/html').send(index.replace(
      '<script type="module" src="/app/app.mjs"></script>',
      `<script type="module">import { h, render } from 'preact'; import { CommandQueuePage } from '/pages/command-queue.mjs'; render(h(CommandQueuePage), document.getElementById('app'));</script>`,
    )));
  }
  const requestImpl = buildInProcessFastifyRequest({ app, buildHeaders: () => ({
    authorization: 'Bearer fixture-token', 'x-dueno-internal': 'fixture-bypass', 'x-dueno-internal-ts': new Date().toISOString(),
  }) });
  const monitor = buildMonitorMcpServer({ requestImpl });
  const authContext = { authenticated: true, principal: { type: 'agent', kind: 'codex', sessionId: 'requester' } };
  const call = (name, args) => monitor.handleToolCall(name, args, { authContext });
  const operatorHeaders = { cookie: `${BROWSER_SESSION_COOKIE}=${createBrowserSessionCookieValue()}` };
  const action = { method: 'POST', path: '/api/agents/github', body: { owner: 'octo', repo: 'demo', authRef: 'FIXTURE_GITHUB_REF', enabled: false } };
  const create = (operatorAction = action) => call('monitor_add_human_queue_item', {
    question: 'Configure this repo?', details: 'Needed for the task.', operatorAction,
    sessionKind: 'claude', sessionId: 'forged-target', passThrough: false, options: [{ id: 'fake', label: 'Fake' }], allowFreeform: true,
  });
  const answer = (id, optionId = 'approve') => app.inject({ method: 'POST', url: `/api/command-center/work-queue/${id}/answer`, headers: operatorHeaders, payload: { optionId } });

  await t.test('allowlisted action executes once as the dashboard operator and reports to the authenticated requester', async () => {
    const { id } = await create();
    const queue = (await app.inject({ url: '/api/command-center/work-queue', headers: operatorHeaders })).json();
    const item = queue.items.find((entry) => entry.id === id);
    assert.equal(item.sessionId, 'requester');
    assert.equal(item.sessionKind, 'codex');
    assert.equal(item.passThrough, true);
    assert.equal(item.allowFreeform, false);
    assert.deepEqual(item.options.map((option) => option.label), ['Approve and run', 'Reject']);
    await assert.rejects(call('monitor_answer_human_queue_item', { id, optionId: 'approve' }), /authenticated operator/);
    assert.equal((await answer(id, 'fake')).statusCode, 400);
    const responses = await Promise.all([answer(id), answer(id)]);
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409]);
    const result = responses.find((response) => response.statusCode === 200).json();
    assert.equal(result.operatorActionResult.statusCode, 200);
    assert.equal(executions.length, 1);
    assert.equal(executions[0].principal.type, 'ui');
    assert.equal(executions[0].principal.kind, 'dashboard');
    assert.deepEqual(executions[0].body, action.body);
    assert.equal((await repoStore.getRepo('octo/demo')).enabled, false);
    assert.equal((await answer(id)).statusCode, 409);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].sessionId, 'requester');
    assert.match(commands[0].text, /^\[OPERATOR_ACTION\] approved · POST \/api\/agents\/github → 200 · /);
    assert.ok(result.operatorActionResult.response.length <= 300);
    const persisted = JSON.parse(await readFile(join(dir, 'command_center/work-queue.json'), 'utf8'));
    assert.equal(persisted.items.find((entry) => entry.id === id).operatorActionResult.statusCode, 200);
    const reloaded = await import('../modules/integrations/command-center-ai.mjs?operatorApprovalReload');
    await assert.rejects(reloaded.answerHumanQueueItem(id, { optionId: 'approve' }, {
      principal: { type: 'ui' }, executeOperatorAction: () => { throw new Error('Must not execute after reload'); },
    }), /already routed/);
  });

  await t.test('reject never executes and sends one rejected line', async () => {
    const { id } = await create();
    const result = (await answer(id, 'reject')).json();
    assert.equal(result.operatorActionResult.status, 'rejected');
    assert.equal(executions.length, 1);
    assert.match(commands.at(-1).text, /^\[OPERATOR_ACTION\] rejected/);
    assert.equal((await answer(id)).statusCode, 409);
  });

  await t.test('creation rejects unapproved methods and noncanonical paths', async () => {
    for (const invalid of [
      { ...action, method: 'GET' }, { ...action, method: 'post' },
      { ...action, path: '/api/command-center/stop' }, { ...action, path: '/api/agents/github?x=1' },
      { ...action, path: '/api/agents/github/../github' }, { ...action, path: '/api/agents/github\n' },
      { ...action, path: '/api/agent-bus/threads/%2e%2e/end' },
    ]) await assert.rejects(create(invalid), /not allowlisted/);
    const anonymous = await app.inject({ method: 'POST', url: '/api/command-center/work-queue', headers: operatorHeaders, payload: { question: 'Run?', operatorAction: action, sessionId: 'forged' } });
    assert.equal(anonymous.statusCode, 403);
  });

  await t.test('removing an allowlist entry after creation blocks execution', async () => {
    const { id } = await create();
    const removed = OPERATOR_ACTION_ROUTES.shift();
    try {
      const result = (await answer(id)).json();
      assert.equal(result.operatorActionResult.status, 'blocked');
      assert.match(result.operatorActionResult.error, /not allowlisted/);
      assert.equal(executions.length, 1);
      assert.match(commands.at(-1).text, /not allowlisted/);
    } finally { OPERATOR_ACTION_ROUTES.unshift(removed); }
  });

  await t.test('route failures are recorded and delivered without retries', async () => {
    const { id } = await create({ ...action, body: { owner: '' } });
    const result = (await answer(id)).json();
    assert.equal(result.operatorActionResult.statusCode, 400);
    assert.match(commands.at(-1).text, /→ 400/);
    assert.equal((await answer(id)).statusCode, 409);
  });

  await t.test('dashboard renders exact request and approving uses the answer API', { skip: !process.env.CHROMIUM_BIN }, async () => {
    const { id } = await create();
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
    try {
      const context = await browser.newContext();
      await context.addCookies([{ name: BROWSER_SESSION_COOKIE, value: createBrowserSessionCookieValue(), url: origin }]);
      const page = await context.newPage();
      await page.goto(`${origin}/queue-fixture`);
      const row = page.locator('.dashboard-action-row').filter({ has: page.getByRole('button', { name: 'Approve and run', exact: true }) });
      await row.waitFor();
      assert.equal(await row.locator('pre').textContent(), `${action.method} ${action.path}\n${JSON.stringify(action.body, null, 2)}`);
      assert.equal(await row.getByRole('button', { name: 'Reject', exact: true }).count(), 1);
      assert.equal(await row.locator('input[name=answer]').count(), 0);
      const response = page.waitForResponse((response) => response.url().endsWith(`/work-queue/${id}/answer`) && response.request().method() === 'POST');
      await row.getByRole('button', { name: 'Approve and run', exact: true }).click();
      assert.equal((await response).status(), 200);
      assert.equal(commands.at(-1).sessionId, 'requester');
    } finally { await browser.close(); }
  });
});
