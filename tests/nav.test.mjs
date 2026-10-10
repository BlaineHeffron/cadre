import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

test('phone navigation keeps frequent routes visible and overflow reachable; desktop retains links', {
  skip: !process.env.CHROMIUM_BIN, timeout: 30000,
}, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = Fastify();
  t.after(() => app.close());
  await app.register(fastifyStatic, { root: join(root, 'public'), prefix: '/' });
  await app.register(fastifyStatic, { root: join(root, 'node_modules'), prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(join(root, 'public/index.html'), 'utf8');
  app.get('/nav-fixture', async (_req, reply) => reply.type('text/html').send(index.replace(
    '<script type="module" src="/app/app.mjs"></script>',
    `<script type="module">
      import { h, render } from 'preact';
      import Router from 'preact-router';
      import { Nav } from '/components/nav.mjs';
      import { queueOpenCount, alerts, claudeSessions } from '/app/state.mjs';
      queueOpenCount.value = 12;
      alerts.value = [{ acknowledged: false }, { acknowledged: false }];
      claudeSessions.value = Array.from({ length: 123 }, (_, id) => ({ id: String(id) }));
      render(h('div', {}, h(Nav), h(Router, {}, h('main', { default: true }, 'Navigation fixture'))), document.getElementById('app'));
    </script>`,
  )));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/nav-fixture`);
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await nav.waitFor();
  if (process.env.NAV_SCREENSHOT) await page.screenshot({ path: process.env.NAV_SCREENSHOT });
  const more = nav.getByRole('button', { name: 'More navigation items' });
  const bell = nav.getByRole('menuitem', { name: 'Prompt-ready session notifications' });
  for (const width of [390, 320, 600]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of ['Queue', 'Capture', 'Agents']) {
      const link = nav.getByRole('link', { name: new RegExp(`^${name}`) });
      assert.equal(await link.isVisible(), true, `${name} at ${width}px`);
      const box = await link.boundingBox();
      assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= width);
      await link.click();
      assert.equal(new URL(page.url()).pathname, (await link.getAttribute('href')));
    }
    assert.equal(await bell.isVisible(), false);
    assert.equal(await nav.getByRole('link', { name: 'Command Center', exact: true }).isVisible(), false);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await more.click();
  assert.equal(await more.getAttribute('aria-expanded'), 'true');
  if (process.env.NAV_SCREENSHOT) await page.screenshot({ path: process.env.NAV_SCREENSHOT.replace('.png', '-overflow.png') });
  for (const name of ['Command Center', 'Fleet', 'GitHub', 'Collab', 'Schedules', 'Loop Sessions', 'Tmux', 'Saved Notes', 'Skills', 'Recordings', 'Threats', 'Files', 'Settings']) {
    const item = nav.getByRole('menuitem', { name: new RegExp(`^${name}(?:$|\\s)`) });
    assert.equal(await item.isVisible(), true, name);
    await item.click();
    assert.equal(await more.getAttribute('aria-expanded'), 'false');
    assert.equal(new URL(page.url()).pathname, ({ 'Command Center': '/', GitHub: '/github-agents', Schedules: '/scheduled-agents', 'Loop Sessions': '/loop-sessions', 'Saved Notes': '/capture/notes' })[name] || `/${name.toLowerCase()}`);
    await more.click();
  }
  await bell.click();
  assert.equal(await nav.getByText('No unseen prompt-ready sessions').isVisible(), true);
  await page.evaluate(async () => {
    const { claudePromptNotifications } = await import('/app/state.mjs');
    claudePromptNotifications.value = [{ kind: 'claude', sessionId: 'fixture', sessionName: 'Ready fixture', route: '/claude/fixture', label: 'Ready', detail: 'Awaiting prompt' }];
  });
  await nav.getByRole('menuitem', { name: 'Ready fixture Ready Awaiting prompt' }).click();
  assert.equal(new URL(page.url()).pathname, '/claude/fixture');
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  await more.click();
  await page.keyboard.press('Escape');
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  await more.click();
  await page.mouse.click(2, 800);
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const name of ['Command Center', 'Queue', 'Capture', 'Fleet', 'GitHub', 'Agents', 'Collab', 'Schedules', 'Loop Sessions', 'Tmux']) {
    assert.equal(await nav.getByRole('link', { name: new RegExp(`^${name}`) }).isVisible(), true);
  }
  await nav.getByRole('link', { name: 'Fleet', exact: true }).click();
  assert.equal(await more.evaluate((el) => el.classList.contains('active')), false);
  await more.click();
  await nav.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  assert.equal(new URL(page.url()).pathname, '/settings');
  assert.deepEqual(errors, []);
});
