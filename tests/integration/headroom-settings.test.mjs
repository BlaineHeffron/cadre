// CHROMIUM_BIN=/path/to/chromium node --test tests/integration/headroom-settings.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';
import { agentProviderPreferencesPlugin } from '../../modules/agent/provider-preferences.mjs';

test('Settings renders Headroom enabled, saves off across reload, and enables it again', {
  skip: !process.env.CHROMIUM_BIN, timeout: 30000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-headroom-ui-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const app = Fastify();
  t.after(() => app.close());
  await app.register(agentProviderPreferencesPlugin, { storeFile: join(dir, 'preferences.json') });
  await app.register(fastifyStatic, { root: join(root, 'public'), prefix: '/' });
  await app.register(fastifyStatic, { root: join(root, 'node_modules'), prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(join(root, 'public/index.html'), 'utf8');
  app.get('/settings-fixture', async (_req, reply) => reply.type('text/html').send(index.replace(
    '<script type="module" src="/app/app.mjs"></script>',
    `<script type="module">
      import { h, render } from 'preact';
      import { SettingsPage } from '/pages/settings.mjs';
      import { isAuthenticated } from '/app/state.mjs';
      isAuthenticated.value = true;
      render(h(SettingsPage, {}), document.getElementById('app'));
    </script>`,
  )));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/settings-fixture`);
  const toggle = page.getByLabel('Enable Headroom context compression', { exact: true });
  await toggle.waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('label')].find((label) => label.textContent.includes('Enable Headroom')).querySelector('input').disabled);
  assert.equal(await toggle.isChecked(), true);
  for (const enabled of [false, true]) {
    const saved = page.waitForResponse((response) => response.url().endsWith('/api/agent-provider-preferences') && response.request().method() === 'PUT');
    await toggle.setChecked(enabled);
    assert.equal((await (await saved).json()).headroomEnabled, enabled);
    const loaded = page.waitForResponse((response) => response.url().endsWith('/api/agent-provider-preferences') && response.request().method() === 'GET');
    await page.reload();
    await loaded;
    await page.waitForFunction((expected) => {
      const input = [...document.querySelectorAll('label')].find((label) => label.textContent.includes('Enable Headroom'))?.querySelector('input');
      return input && !input.disabled && input.checked === expected;
    }, enabled);
    assert.equal(await toggle.isChecked(), enabled);
  }
  assert.deepEqual(errors, []);
});
