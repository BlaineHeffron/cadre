// The session header's Hand off… action in headless Chromium against a stubbed API.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

test('Actions ▾ Hand off… picks a provider and model, starts the handoff and opens the new session', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = Fastify();
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); });
  await app.register(fastifyStatic, { root: `${root}public`, prefix: '/' });
  await app.register(fastifyStatic, { root: `${root}node_modules`, prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(`${root}public/index.html`, 'utf8');
  app.get('/session', (_req, reply) => reply.type('text/html').send(index.replace('<script type="module" src="/app/app.mjs"></script>', `<script type="module">
    import { h, render } from 'preact';
    import Router from 'preact-router';
    import { isAuthenticated } from '/app/state.mjs';
    import { AgentSessionDetailPage } from '/pages/agent-session-detail.mjs';
    import { ToastContainer } from '/components/toast.mjs';
    isAuthenticated.value = true;
    const Page = ({ id, kind }) => h(AgentSessionDetailPage, { id, provider: kind });
    render(h('main', { class: 'main' }, h(Router, null, h(Page, { path: '/session', id: 'a1', kind: 'claude' }), h(Page, { path: '/:kind/:id' })), h(ToastContainer)), document.getElementById('app'));
  </script>`)));
  const handoffs = [];
  const fake = { status: 'ready' };
  app.get('/api/claude/sessions/:id', (req) => ({
    id: req.params.id, content: '● Done.', state: { status: fake.status }, sessionName: `claude-${req.params.id}`, provider: 'anthropic',
    model: 'claude-opus-5-5', workDir: '/work/app', attachCommand: 'tmux attach -t claude-a1',
    handoffTo: handoffs.length ? { sessionId: 'c0dex1', kind: 'codex', provider: 'codex', model: 'gpt-6.1-sol' } : null,
  }));
  app.get('/api/codex/sessions/:id', (req) => ({
    id: req.params.id, content: 'Continuing.', state: { status: 'working' }, sessionName: `codex-${req.params.id}`, provider: 'codex',
    handoffFrom: { sessionId: 'a1', kind: 'claude', provider: 'claude', model: 'claude-opus-5-5' },
  }));
  app.get('/api/agent-bus/model-catalog', () => ({
    providers: [{ id: 'claude', label: 'Claude', defaultModel: 'claude-opus-5-5' }, { id: 'codex', label: 'Codex', defaultModel: 'gpt-6.1-sol' }, { id: 'xai', label: 'xAI (pi)', defaultModel: 'grok-5' }],
    models: { claude: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }], codex: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }], xai: [{ id: 'grok-5' }] },
  }));
  app.get('/api/agents/providers', () => ({ providers: [{ id: 'claude' }, { id: 'codex' }, { id: 'xai' }] }));
  app.post('/api/agents/sessions/:id/handoff', (req, reply) => {
    if (fake.status === 'working') return reply.code(409).send({ error: 'Session a1 is mid-turn (working)', code: 'handoff_source_busy' });
    handoffs.push({ id: req.params.id, body: req.body });
    return { id: 'c0dex1', backendType: 'codex', provider: 'codex', sessionName: 'codex-c0dex1', dropped: [] };
  });
  app.post('/api/*', () => ({ ok: true }));
  app.get('/api/*', () => ({ sessions: [] }));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const openDialog = async () => {
    await page.locator('.claude-session-header summary', { hasText: 'Actions' }).click();
    await page.getByRole('button', { name: 'Hand off…', exact: true }).click();
    return page.getByRole('dialog', { name: 'Hand off to another model' });
  };

  // Mid-turn: the server refuses and the page says why.
  fake.status = 'working';
  await page.goto(`${origin}/session`);
  await page.getByText('Done.').waitFor();
  let dialog = await openDialog();
  await dialog.getByRole('button', { name: 'Hand off', exact: true }).click();
  await page.getByText('Hand off failed: Session a1 is mid-turn (working)').waitFor();
  assert.equal(handoffs.length, 0);

  // Idle: the picker starts on this session's provider and model, from the shared catalog.
  fake.status = 'ready';
  await page.goto(`${origin}/session`);
  await page.getByText('Done.').waitFor();
  dialog = await openDialog();
  await dialog.getByText('/work/app').waitFor();
  const provider = dialog.getByLabel('Provider');
  const model = dialog.getByLabel('Model');
  await dialog.locator('option[value="xai"]').waitFor({ state: 'attached' });
  assert.equal(await provider.inputValue(), 'claude');
  assert.equal(await model.inputValue(), 'claude-opus-5-5');
  await provider.selectOption('codex');
  assert.equal(await model.inputValue(), 'gpt-6.1-sol');
  await model.selectOption('gpt-6-luna');
  await dialog.getByLabel('Thinking level').selectOption('high');
  await dialog.getByRole('button', { name: 'Hand off', exact: true }).click();

  // It opens the new session, which links back to the one it continues.
  await page.getByText('Continuing.').waitFor();
  assert.deepEqual(handoffs, [{ id: 'a1', body: { provider: 'codex', model: 'gpt-6-luna', thinkingLevel: 'high' } }]);
  assert.equal(new URL(page.url()).pathname, '/codex/c0dex1');
  assert.equal(await page.getByRole('link', { name: 'Continued from a1' }).getAttribute('href'), '/claude/a1');

  // The source now links forward.
  await page.goto(`${origin}/session`);
  assert.equal(await page.getByRole('link', { name: 'Handed off to c0dex1' }).getAttribute('href'), '/codex/c0dex1');
  if (process.env.HANDOFF_SCREENSHOT) {
    await openDialog();
    await page.screenshot({ path: process.env.HANDOFF_SCREENSHOT });
  }
  assert.deepEqual(errors, []);
});
