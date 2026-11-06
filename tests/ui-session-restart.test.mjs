// The session header's Restart session action in headless Chromium against a stubbed API.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

test('Actions ▾ offers Restart session: an idle session restarts at once, a busy one asks first', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = Fastify();
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); });
  await app.register(fastifyStatic, { root: `${root}public`, prefix: '/' });
  await app.register(fastifyStatic, { root: `${root}node_modules`, prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(`${root}public/index.html`, 'utf8');
  app.get('/session', (_req, reply) => reply.type('text/html').send(index.replace('<script type="module" src="/app/app.mjs"></script>', `<script type="module">
    import { h, render } from 'preact';
    import { isAuthenticated } from '/app/state.mjs';
    import { AgentSessionDetailPage } from '/pages/agent-session-detail.mjs';
    isAuthenticated.value = true;
    render(h('main', { class: 'main' }, h(AgentSessionDetailPage, { id: 'a1', provider: 'claude' })), document.getElementById('app'));
  </script>`)));
  let status = 'ready';
  const restarts = [];
  app.get('/api/claude/sessions/:id', (req) => ({ id: req.params.id, content: '● Done.', state: { status }, sessionName: `claude-${req.params.id}` }));
  app.post('/api/claude/sessions/:id/restart', (req) => { restarts.push(req.params.id); return { id: req.params.id, resumed: true }; });
  app.post('/api/*', () => ({ ok: true }));
  app.get('/api/*', () => ({ sessions: [] }));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const dialogs = [];
  let accept = false;
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); return accept ? dialog.accept() : dialog.dismiss(); });
  const restart = async () => {
    await page.locator('.claude-session-header summary', { hasText: 'Actions' }).click();
    await page.getByRole('button', { name: 'Restart session', exact: true }).click();
  };

  // Idle: no question, straight to the restart.
  await page.goto(`${origin}/session`);
  await page.getByText('Done.').waitFor();
  const restarted = () => page.waitForResponse((res) => res.url().endsWith('/api/claude/sessions/a1/restart'));
  await Promise.all([restarted(), restart()]);
  assert.deepEqual([restarts, dialogs], [['a1'], []]);

  // Mid-turn: it asks; declining leaves the session alone, accepting restarts it.
  status = 'working';
  await page.goto(`${origin}/session`);
  await page.getByText('Done.').waitFor();
  await restart();
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0], /not idle/);
  assert.deepEqual(restarts, ['a1']);
  accept = true;
  await Promise.all([restarted(), restart()]);
  assert.deepEqual(restarts, ['a1', 'a1']);
  assert.deepEqual(errors, []);
});
