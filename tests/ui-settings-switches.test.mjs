// The real Settings page in headless Chromium against a stubbed API: on/off settings are labelled switches.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

test('settings uses labelled switches that reflect and change their state', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = Fastify();
  // One hook, browser first: while it is open, its keep-alive connections hold app.close().
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
  app.put('/api/agent-provider-preferences', (_req, reply) => reply.code(500).send({ error: 'disk full' }));
  app.get('/api/machines', () => ({ role: 'hub', canAdd: false, machines: [] }));
  app.get('/api/*', () => ({}));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/fixture`, { waitUntil: 'networkidle' });

  for (const name of ['Enable Claude-backed workflows', 'Phone notifications', 'Sound', 'Approval prompts only', 'Low data mode']) {
    await page.getByRole('switch', { name: new RegExp(`^${name}`) }).waitFor();
  }
  // Settings shows on/off state as switches, not "Name: On" buttons.
  assert.equal(await page.getByRole('button', { name: /: (On|Off)$/ }).count(), 0);

  const sound = page.getByRole('switch', { name: /^Sound/ });
  const before = await sound.isChecked();
  await sound.click();
  await page.locator('.setting-switch', { hasText: /^Sound/ }).locator(before ? 'input:not(:checked)' : 'input:checked').waitFor();
  assert.equal(await sound.isChecked(), !before);
  // A save that fails puts the switch back where it was.
  const headroom = page.getByRole('switch', { name: 'Enable Headroom context compression' });
  assert.equal(await headroom.isChecked(), true);
  // On reads at a glance: a white knob on the accent track; off keeps a grey knob.
  const knob = (el) => getComputedStyle(el, '::before').backgroundColor;
  assert.equal(await headroom.evaluate(knob), 'rgb(255, 255, 255)');
  assert.equal(await headroom.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(2, 119, 189)');
  assert.equal(await page.locator('.switch:not(:checked)').first().evaluate(knob), 'rgb(208, 208, 222)');
  await headroom.click();
  await page.waitForResponse((response) => response.url().endsWith('/api/agent-provider-preferences'));
  await page.locator('.setting-switch', { hasText: 'Headroom' }).locator('input:checked').waitFor();
  // Page titles share one style across pages.
  assert.equal(await page.locator('h1').first().evaluate((el) => getComputedStyle(el).fontSize), '18px');
  assert.ok((await page.locator('.settings-shell').boundingBox()).width <= 960, 'settings rows keep a readable width');
  // Switch hints are read, so they use the 13px step in secondary grey.
  const hint = await page.locator('.setting-switch-hint').first().evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).color]);
  assert.deepEqual(hint, ['13px', 'rgb(208, 208, 222)']);
  // Logout is a danger secondary: light-red text on the neutral border.
  const logout = page.getByRole('button', { name: 'Logout' });
  assert.deepEqual(await logout.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).borderTopColor]), ['rgb(255, 161, 152)', 'rgb(42, 42, 62)']);
  // Card notes read at the same 13px secondary as the switch hints.
  assert.deepEqual(await page.locator('.note').first().evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).color]), ['13px', 'rgb(208, 208, 222)']);
  assert.deepEqual(errors, []);
});
