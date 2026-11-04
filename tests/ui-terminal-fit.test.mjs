// The session terminal in headless Chromium: short histories sit under nothing, long ones stick to the bottom.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

test('full-height terminal fits a short history and keeps streaming output pinned to the bottom', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = Fastify();
  t.after(() => app.close());
  await app.register(fastifyStatic, { root: `${root}public`, prefix: '/' });
  await app.register(fastifyStatic, { root: `${root}node_modules`, prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(`${root}public/index.html`, 'utf8');
  // A 600px column like the session page: terminal, then the controls.
  app.get('/fixture', (_req, reply) => reply.type('text/html').send(index.replace('<script type="module" src="/app/app.mjs"></script>', `<script type="module">
    import { h, render } from 'preact';
    import { Terminal } from '/components/terminal.mjs';
    window.show = (content) => render(h('div', { style: 'display:flex; flex-direction:column; height:600px' },
      h(Terminal, { content, fullHeight: true, ansiColors: true, resetKey: 's1' }),
      h('div', { id: 'controls', style: 'height:80px; flex:none' }, 'controls')), document.getElementById('app'));
    window.show('❯ run the migration\\n● Bash(npm run migrate)\\n  Waiting…');
  </script>`)));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/fixture`);

  const terminal = page.locator('.terminal');
  await terminal.getByText('Waiting…').waitFor();
  const [pane, body, controls] = await Promise.all([terminal, page.locator('.terminal-body'), page.locator('#controls')].map((l) => l.boundingBox()));
  assert.ok(body.y - pane.y < 24, `short history starts ${body.y - pane.y}px below the pane top`);
  assert.ok(controls.y - (body.y + body.height) < 24, `controls sit ${controls.y - (body.y + body.height)}px below the last line`);
  // Nothing has scrolled, so the top fade is hidden and the first line reads at full strength.
  const fade = () => terminal.evaluate((el) => getComputedStyle(el, '::before').opacity);
  assert.equal(await fade(), '0');

  const pinned = () => terminal.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop < 2);
  const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
  await page.evaluate((text) => window.show(text), lines(200));
  await terminal.getByText('line 199').waitFor();
  assert.equal(Math.round((await terminal.boundingBox()).height), 520, 'a long history fills the space above the controls');
  await page.waitForFunction(() => { const el = document.querySelector('.terminal'); return el.scrollHeight - el.clientHeight - el.scrollTop < 2; });
  // Streaming output keeps the view on the newest line.
  for (const total of [220, 260]) {
    await page.evaluate((text) => window.show(text), lines(total));
    await terminal.getByText(`line ${total - 1}`).waitFor();
    await page.waitForTimeout(150);
    assert.equal(await pinned(), true, `pinned after growing to ${total} lines`);
  }
  assert.equal(await fade(), '1', 'rows scrolled past the top fade');
  // Once the reader scrolls up, new output no longer drags the view down.
  await terminal.hover();
  await page.mouse.wheel(0, -2000);
  await page.waitForFunction(() => { const el = document.querySelector('.terminal'); return el.scrollHeight - el.clientHeight - el.scrollTop > 200; });
  const readingAt = await terminal.evaluate((el) => el.scrollTop);
  await page.evaluate((text) => window.show(text), lines(300));
  await terminal.getByText('line 299').waitFor({ state: 'attached' });
  await page.waitForTimeout(150);
  assert.equal(await pinned(), false, 'not pulled to the bottom while reading history');
  assert.equal(await terminal.evaluate((el) => el.scrollTop), readingAt, 'view stays where the reader left it');
  assert.deepEqual(errors, []);
});
