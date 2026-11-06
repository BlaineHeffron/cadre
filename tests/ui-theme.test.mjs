// The real Settings page and index.html in headless Chromium: the theme switch, its persistence, and AA text in both modes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

const LIGHT_BG = 'rgb(249, 248, 244)';
const DARK_BG = 'rgb(28, 28, 27)';

// Contrast of each element's text against what it is drawn on (alpha layers composited up the tree).
function contrasts(selectors) {
  const parse = (value) => {
    const n = value.match(/[\d.]+/g).map(Number);
    const srgb = value.startsWith('color(');
    return { rgb: n.slice(0, 3).map((v) => (srgb ? v * 255 : v)), a: n[3] ?? 1 };
  };
  const over = (top, under) => top.rgb.map((v, i) => v * top.a + under[i] * (1 - top.a));
  const backdrop = (el) => {
    const layers = [];
    for (let node = el; node; node = node.parentElement) layers.push(parse(getComputedStyle(node).backgroundColor));
    return layers.reverse().reduce((under, layer) => over(layer, under), [255, 255, 255]);
  };
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  return selectors.map((selector) => {
    const el = document.querySelector(selector);
    const bg = backdrop(el);
    const [a, b] = [lum(over(parse(getComputedStyle(el).color), bg)), lum(bg)];
    return [selector, Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 10) / 10];
  });
}

test('theme follows the system, switches and persists from Settings, and keeps AA text in both modes', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = Fastify();
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); });
  await app.register(fastifyStatic, { root: `${root}public`, prefix: '/' });
  await app.register(fastifyStatic, { root: `${root}node_modules`, prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(`${root}public/index.html`, 'utf8');
  const appScript = '<script type="module" src="/app/app.mjs"></script>';
  // Every colour pair the transcript and settings rely on, rendered by the real components.
  app.get('/fixture', (_req, reply) => reply.type('text/html').send(index.replace(appScript, `<script type="module">
    import { h, render } from 'preact';
    import { isAuthenticated } from '/app/state.mjs';
    import { SettingsPage } from '/pages/settings.mjs';
    import { ansiToHtml } from '/lib/ansi-to-html.mjs';
    isAuthenticated.value = true;
    render(h(SettingsPage, {}), document.getElementById('app'));
    const pane = document.createElement('div');
    pane.className = 'terminal';
    pane.innerHTML = ansiToHtml('\\x1b[38;5;246mdim hint\\x1b[0m \\x1b[38;5;153mBash command\\x1b[0m \\x1b[31mred\\x1b[0m \\x1b[33myellow\\x1b[0m \\x1b[35mviolet\\x1b[0m\\n\\x1b[48;2;34;92;43m  43 + ok();\\x1b[0m\\n\\x1b[42;30m PASS \\x1b[0m');
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = '<span class="badge status-badge badge-medium">Idle</span><span class="badge status-badge badge-critical">Needs attention</span>'
      + '<span class="badge badge-warning">Low Data On</span><span class="muted" style="color:var(--text-muted)">muted</span>';
    document.body.append(pane, card);
  </script>`)));
  // The page without the app bundle: the theme must not wait for it (no flash of the other theme).
  app.get('/bare', (_req, reply) => reply.type('text/html').send(index.replace(appScript, '')));
  app.get('/api/machines', () => ({ role: 'hub', canAdd: false, machines: [] }));
  app.get('/api/*', () => ({}));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // The page shows one theme throughout: its attribute, native controls and surfaces agree.
  const expectTheme = async (name) => {
    await page.waitForFunction((n) => document.documentElement.dataset.theme === n, name);
    // Buttons fade between colours; measure the settled ones.
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
    assert.deepEqual(await page.evaluate(() => [getComputedStyle(document.documentElement).colorScheme, getComputedStyle(document.body).backgroundColor]),
      [name, name === 'light' ? LIGHT_BG : DARK_BG]);
  };
  const select = page.getByRole('combobox', { name: /^Theme/ });

  // System is the default and follows the OS live.
  await page.goto(`${origin}/fixture`, { waitUntil: 'networkidle' });
  assert.equal(await select.inputValue(), 'system');
  await expectTheme('light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectTheme('dark');

  // Text, fills and terminal colours read at AA (4.5:1) in each mode.
  const pairs = ['.note', '.setting-switch-hint', '.btn-primary', '.btn:not(.btn-primary)', '.badge-success',
    '.terminal span[style*="199"]', '.terminal span[style*="175"]', '.ansi-fg-red', '.ansi-fg-yellow', '.ansi-fg-magenta', '.ansi-line', '.ansi-bg-green',
    '.status-badge.badge-medium', '.status-badge.badge-critical', '.badge-warning', '.card .muted'];
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectTheme(scheme);
    for (const [selector, ratio] of await page.evaluate(contrasts, pairs)) assert.ok(ratio >= 4.5, `${scheme} ${selector} ${ratio}:1`);
  }

  // An explicit choice overrides the system and survives a reload.
  await select.selectOption('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme('dark');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await select.inputValue(), 'dark');
  await expectTheme('dark');
  await page.goto(`${origin}/bare`);
  await expectTheme('dark');

  await page.goto(`${origin}/fixture`, { waitUntil: 'networkidle' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await select.selectOption('light');
  await expectTheme('light');
  // Back to System: the stored choice goes and the OS decides again.
  await select.selectOption('system');
  await expectTheme('dark');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await select.inputValue(), 'system');
  assert.deepEqual(errors, []);
});
