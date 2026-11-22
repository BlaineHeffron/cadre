// The real Settings page in headless Chromium against a stubbed API: the Job Providers card saves and clears per-job pairs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

test('job providers card shows env defaults, saves a provider and model per job and clears back to the env default', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
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

  const calls = [];
  let prefs = {
    claudeEnabled: true, codexEnabled: false, piEnabled: true, headroomEnabled: true, availableSpawnTypes: ['claude'],
    providerCatalog: [{ id: 'claude', label: 'Claude', enabled: true }, { id: 'codex', label: 'Codex', enabled: false }],
    jobProviders: {},
    jobDefaults: { repoQuality: { provider: 'claude', model: 'claude-opus-5-5' }, fleetHygiene: { provider: '', model: '' } },
  };
  app.get('/api/agent-provider-preferences', () => prefs);
  app.put('/api/agent-provider-preferences', (req) => {
    calls.push(req.body);
    const jobProviders = { ...prefs.jobProviders, ...req.body.jobProviders };
    for (const [job, entry] of Object.entries(jobProviders)) if (!entry) delete jobProviders[job];
    prefs = { ...prefs, jobProviders };
    return prefs;
  });
  app.get('/api/machines', () => ({ role: 'hub', canAdd: false, machines: [] }));
  app.get('/api/*', () => ({}));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/fixture`, { waitUntil: 'networkidle' });

  const card = page.locator('.card', { has: page.locator('.card-title', { hasText: 'Job Providers' }) });
  await card.getByText('Env default: claude / claude-opus-5-5.').waitFor();
  await card.getByText('Env default: inherited.').waitFor();
  const provider = card.getByRole('combobox', { name: 'repoQuality provider' });
  assert.deepEqual(await provider.locator('option').allInnerTexts(), ['Env default', 'Claude', 'Codex (disabled)']);
  assert.equal(await card.getByRole('textbox', { name: 'repoQuality model' }).count(), 0, 'no model field until a provider is saved');

  await provider.selectOption('codex');
  const model = card.getByRole('textbox', { name: 'repoQuality model' });
  await model.fill('gpt-5.5');
  await model.press('Enter');
  await page.waitForFunction(() => document.querySelector('[aria-label="repoQuality model"]')?.value === 'gpt-5.5');
  await provider.selectOption('');
  await model.waitFor({ state: 'detached' });
  assert.deepEqual(calls, [
    { jobProviders: { repoQuality: { provider: 'codex', model: '' } } },
    { jobProviders: { repoQuality: { provider: 'codex', model: 'gpt-5.5' } } },
    { jobProviders: { repoQuality: null } },
  ]);
  assert.deepEqual(errors, []);
});
