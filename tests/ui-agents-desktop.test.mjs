// The real Agents page at desktop width in headless Chromium against a stubbed API.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

const sessions = [
  { id: 'a1', displayName: 'first task', workDir: '/home/me/repo', tmuxSession: 'claude-a1', state: { status: 'working' } },
  { id: 'b2', displayName: 'second task', workDir: '/home/me/repo', tmuxSession: 'claude-b2', state: { status: 'ready' } },
];

test('desktop Agents page shows bulk actions only for a selection and folds session extras into one menu', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = Fastify();
  t.after(() => app.close());
  await app.register(fastifyStatic, { root: `${root}public`, prefix: '/' });
  await app.register(fastifyStatic, { root: `${root}node_modules`, prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(`${root}public/index.html`, 'utf8');
  app.get('/fixture', (_req, reply) => reply.type('text/html').send(index.replace('<script type="module" src="/app/app.mjs"></script>', `<script type="module">
    import { h, render } from 'preact';
    import { isAuthenticated } from '/app/state.mjs';
    import { AgentsPage } from '/pages/agents.mjs';
    isAuthenticated.value = true;
    render(h(AgentsPage, {}), document.getElementById('app'));
  </script>`)));
  app.get('/api/claude/sessions', () => ({ sessions }));
  app.get('/api/claude/sessions/:id', (req) => ({ id: req.params.id, content: 'pane text', state: { status: 'working' }, sessionName: `claude-${req.params.id}` }));
  app.get('/api/*', () => ({ sessions: [] }));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/fixture`);

  const rows = page.locator('.agent-rail-row');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 2);
  // A row is its status, title and one checkbox; Start loop lives on the session itself.
  assert.equal(await rows.getByRole('button', { name: 'Start loop' }).count(), 0);
  assert.equal(await rows.first().locator('.status-badge').textContent(), '▶Working');

  const toolbar = page.locator('.agents-desktop-toolbar');
  for (const name of ['Prompt', 'Esc', 'Kill']) assert.equal(await toolbar.getByRole('button', { name, exact: true }).count(), 0, name);
  await page.getByRole('checkbox', { name: 'Bulk select first task' }).check();
  assert.equal(await toolbar.getByText('1 selected').isVisible(), true);
  for (const name of ['Prompt', 'Esc', 'Kill']) assert.equal(await toolbar.getByRole('button', { name, exact: true }).isVisible(), true, name);

  const header = page.locator('.claude-session-header');
  await header.getByRole('button', { name: 'Rendered Transcript' }).waitFor();
  assert.equal(await header.getByRole('button', { name: 'Kill' }).isVisible(), false);
  await header.getByLabel('More session actions').click();
  for (const name of ['Copy ID', 'Refresh', 'Kill']) assert.equal(await header.getByRole('button', { name, exact: true }).isVisible(), true, name);
  assert.deepEqual(errors, []);
});
