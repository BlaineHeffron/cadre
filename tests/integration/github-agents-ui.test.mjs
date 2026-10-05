// CHROMIUM_BIN=/path/to/chromium node --test tests/integration/github-agents-ui.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { chromium } from 'playwright-core';

test('GitHub page edits settings, cancels drafts, confirms deletes, and manages PR watches', {
  skip: !process.env.CHROMIUM_BIN, timeout: 30000,
}, async (t) => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const app = Fastify();
  t.after(() => app.close());
  let socket;
  let subscribed;
  const subscription = new Promise((resolve) => { subscribed = resolve; });
  await app.register(fastifyWebsocket);
  app.get('/ws', { websocket: true }, (connection) => {
    socket = connection;
    connection.on('message', (message) => {
      const payload = JSON.parse(message.toString());
      if (payload.action === 'subscribe' && payload.channel === 'github:agents') subscribed();
    });
  });
  const requests = [];
  let repo = { id: 'octo/demo', owner: 'octo', repo: 'demo', authRef: 'OLD_REF', enabled: true,
    prEnabled: true, issueEnabled: true, autoReviewEnabled: true, lastSeenPrNumber: 20, lastSeenIssueNumber: 19 };
  let watches = [{ repo: 'octo/demo', number: 42, thread_id: 'thr_test', creator: { kind: 'codex', sessionId: 'sess_test' },
    createdAtMs: Date.now() - 120000, mergeableState: 'clean' }];
  let watchLoads = 0;
  app.get('/api/agents/github', async () => ({ enabled: true, repos: repo ? [repo] : [] }));
  app.post('/api/agents/github', async (req) => {
    requests.push({ method: req.method, body: req.body });
    repo = { ...repo, ...req.body, authRef: 'SAVED_REF' };
    return { repo };
  });
  app.delete('/api/agents/github/:id', async (req) => {
    requests.push({ method: req.method, id: req.params.id }); repo = null; watches = []; return { ok: true };
  });
  app.get('/api/agents/github/watches', async () => { watchLoads++; return { watches }; });
  app.delete('/api/agents/github/watches', async (req) => {
    requests.push({ method: req.method, body: req.body }); watches = []; return { watch: null };
  });
  app.post('/api/agents/github/poll-now', async () => {
    watches = watches.map((watch) => ({ ...watch, mergeableState: 'dirty' })); return { results: [] };
  });
  await app.register(fastifyStatic, { root: join(root, 'public'), prefix: '/' });
  await app.register(fastifyStatic, { root: join(root, 'node_modules'), prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(join(root, 'public/index.html'), 'utf8');
  app.get('/github-fixture', async (_req, reply) => reply.type('text/html').send(index.replace(
    '<script type="module" src="/app/app.mjs"></script>',
    `<script type="module">
      import { h, render } from 'preact';
      import { connectWs } from '/app/ws-client.mjs';
      import { isAuthenticated } from '/app/state.mjs';
      import { GitHubAgentsPage } from '/pages/github-agents.mjs';
      isAuthenticated.value = true;
      render(h(GitHubAgentsPage, {}), document.getElementById('app'));
      connectWs();
    </script>`,
  )));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/github-fixture`);
  const card = page.locator('[data-github-repo="octo/demo"]');
  const watch = page.locator('[data-pr-watch="octo/demo#42"]');
  await watch.waitFor();
  assert.equal(await watch.getByRole('link', { name: 'octo/demo#42' }).getAttribute('href'), 'https://github.com/octo/demo/pull/42');
  assert.equal(await watch.getByRole('link', { name: 'thr_test' }).getAttribute('href'), '/collab/thr_test');
  assert.match(await watch.textContent(), /codex:sess_test.*created 2m ago.*mergeable clean/);
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await card.getByLabel('Owner', { exact: true }).getAttribute('readonly'), '');
  assert.equal(await card.getByLabel('Repo', { exact: true }).getAttribute('readonly'), '');
  await card.getByLabel('Auth ref').fill('new-ref!');
  for (const label of ['Enabled', 'PRs', 'Issues', 'Auto review']) await card.getByLabel(label, { exact: true }).uncheck();
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await card.getByRole('button', { name: 'Edit', exact: true }).waitFor();
  assert.deepEqual(requests[0], { method: 'POST', body: { owner: 'octo', repo: 'demo', authRef: 'NEWREF',
    enabled: false, prEnabled: false, issueEnabled: false, autoReviewEnabled: false } });
  assert.match(await card.textContent(), /auth ref SAVED_REF/);
  assert.match(await card.textContent(), /last PR #20 · last issue #19/);
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await card.getByLabel('Auth ref').fill('CANCELLED');
  await card.getByLabel('PRs', { exact: true }).check();
  await card.getByRole('button', { name: 'Cancel', exact: true }).click();
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  assert.equal(await card.getByLabel('Auth ref').inputValue(), 'SAVED_REF');
  assert.equal(await card.getByLabel('PRs', { exact: true }).isChecked(), false);
  await card.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(requests.length, 1);
  await card.getByRole('button', { name: 'Poll now', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-pr-watch]').textContent.includes('mergeable dirty'));
  assert.ok(watchLoads >= 2);
  await subscription;
  watches = watches.map((item) => ({ ...item, mergeableState: 'blocked' }));
  socket.send(JSON.stringify({ channel: 'github:agents', type: 'snapshot', data: {} }));
  await page.waitForFunction(() => document.querySelector('[data-pr-watch]').textContent.includes('mergeable blocked'));
  for (const button of [watch.getByRole('button', { name: 'Remove' }), card.getByRole('button', { name: 'Delete' })]) {
    page.once('dialog', async (dialog) => { assert.equal(dialog.type(), 'confirm'); await dialog.dismiss(); });
    await button.click();
    assert.equal(requests.length, 1);
  }
  page.once('dialog', (dialog) => dialog.accept());
  await watch.getByRole('button', { name: 'Remove' }).click();
  await watch.waitFor({ state: 'detached' });
  assert.deepEqual(requests[1], { method: 'DELETE', body: { repo: 'octo/demo', number: 42 } });
  page.once('dialog', (dialog) => dialog.accept());
  await card.getByRole('button', { name: 'Delete' }).click();
  await card.waitFor({ state: 'detached' });
  assert.deepEqual(requests[2], { method: 'DELETE', id: 'octo/demo' });
  assert.deepEqual(errors, []);
});
