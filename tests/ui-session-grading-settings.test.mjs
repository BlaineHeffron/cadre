// The real Settings page in headless Chromium against a stubbed API: the Session Grading card saves and toggles through its routes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

test('session grading card saves grader settings, toggles the improver and summarizes the last week', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = Fastify();
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); });
  await app.register(fastifyStatic, { root: `${root}public`, prefix: '/' });
  await app.register(fastifyStatic, { root: `${root}node_modules`, prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(`${root}public/index.html`, 'utf8');
  app.get('/fixture', (_req, reply) => reply.type('text/html').send(index.replace('<script type="module" src="/app/app.mjs"></script>', `<script type="module">
    import { h, render } from 'preact';
    import { isAuthenticated } from '/app/state.mjs';
    import { SettingsPage } from '/pages/settings.mjs';
    isAuthenticated.value = true;
    render(h(SettingsPage, {}), document.getElementById('app'));
  </script>`)));

  const today = new Date().toISOString().slice(0, 10);
  const calls = [];
  let prefs = {
    claudeEnabled: true, codexEnabled: true, piEnabled: true, headroomEnabled: true, availableSpawnTypes: ['claude', 'codex'],
    graderSampleRate: null, graderModel: null, graderModels: ['claude-sonnet-5-5', 'claude-haiku-5-5'],
    graderDefaults: { sampleRate: 0.25, model: 'claude-sonnet-5-5' },
  };
  let improver = null;
  const nextRun = Date.parse('2030-01-02T03:04:00Z');
  app.get('/api/agent-provider-preferences', () => prefs);
  app.put('/api/agent-provider-preferences', (req) => { calls.push(['PUT', req.body]); prefs = { ...prefs, ...req.body }; return prefs; });
  app.get('/api/agents/scheduled', () => ({ tasks: improver ? [improver] : [] }));
  app.post('/api/fleet/session-improve/setup', () => { calls.push(['setup']); improver = { id: 'sched_session_improve_daily', status: 'active', nextRunAtEpochMs: nextRun }; return improver; });
  app.post('/api/fleet/session-improve/run-now', () => { calls.push(['run-now']); return { task: improver, step: { spawned: 1 } }; });
  app.post('/api/agents/scheduled/:id/cancel', (req) => { calls.push(['cancel', req.params.id]); improver = { ...improver, status: 'canceled' }; return improver; });
  app.get('/api/agents/github/ledger/trend', () => ({ days: [
    { day: '2020-01-01', rubrics: { stale: { count: 9, passRate: 1, meanScore: 1 } } },
    { day: today, rubrics: { efficiency: { count: 4, passRate: 0.5, meanScore: 0.6 } } },
  ], promptChanges: [] }));
  app.get('/api/agents/github/ledger', () => ({ entries: [
    { repo: 'octo/demo', number: 8 },
    { repo: 'octo/demo', number: 7, gradedAt: `${today}T01:00:00Z`, grade: { scores: { efficiency: { score: 0.4, pass: false }, verbosity: { score: 1, pass: true } } } },
    { repo: 'octo/demo', number: 6, gradedAt: `${today}T00:00:00Z`, grade: null, gradeError: 'malformed grade' },
  ] }));
  app.get('/api/machines', () => ({ role: 'hub', canAdd: false, machines: [] }));
  app.get('/api/*', () => ({}));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/fixture`, { waitUntil: 'networkidle' });

  const card = page.locator('.card', { has: page.locator('.card-title', { hasText: 'Session Grading' }) });
  await card.getByText('25% graded').waitFor();
  // Only merge days in the last week count; a graded entry lists its failing rubrics, an errored one its error.
  assert.deepEqual(await card.locator('table').first().locator('tbody tr').allInnerTexts(), ['efficiency\t50%\t4']);
  assert.deepEqual(await card.locator('table').nth(1).locator('tbody tr').allInnerTexts(), ['octo/demo#7\tefficiency', 'octo/demo#6\tgrade error: malformed grade']);

  const rate = card.getByRole('spinbutton');
  await rate.fill('0.5');
  await rate.press('Enter');
  await card.getByText('50% graded').waitFor();
  await card.getByRole('combobox').selectOption('claude-haiku-5-5');
  await rate.fill('');
  await rate.press('Enter');
  await card.getByText('25% graded').waitFor();
  assert.deepEqual(calls.splice(0), [['PUT', { graderSampleRate: 0.5 }], ['PUT', { graderModel: 'claude-haiku-5-5' }], ['PUT', { graderSampleRate: null }]]);

  const toggle = card.getByRole('switch', { name: /^Daily improver/ });
  assert.equal(await toggle.isChecked(), false);
  assert.equal(await card.getByRole('button', { name: 'Run now' }).count(), 0);
  await toggle.click();
  await card.getByText(`Next run ${await page.evaluate((ms) => new Date(ms).toLocaleString(), nextRun)}.`).waitFor();
  await Promise.all([page.waitForResponse((response) => response.url().endsWith('/run-now')), card.getByRole('button', { name: 'Run now' }).click()]);
  await toggle.click();
  await card.getByRole('button', { name: 'Run now' }).waitFor({ state: 'detached' });
  assert.deepEqual(calls, [['setup'], ['run-now'], ['cancel', 'sched_session_improve_daily']]);
  assert.deepEqual(errors, []);
});
