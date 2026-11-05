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
    window.loads = 0;
    window.show = (content, hasMore = false, loadingMore = false) => render(h('div', { style: 'display:flex; flex-direction:column; height:600px' },
      h(Terminal, { content, fullHeight: true, ansiColors: true, resetKey: 's1', hasMore, loadingMore, onLoadMore: () => { window.loads += 1; } }),
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
  // Streaming output keeps the view on the newest line, also while it grows inside a tool-call card.
  const streaming = (n) => `${lines(200)}\n● Bash(npm test)\n  ⎿  ${Array.from({ length: n }, (_, i) => `out ${i}`).join('\n     ')}`;
  for (const total of [20, 60]) {
    await page.evaluate((text) => window.show(text), streaming(total));
    await terminal.locator('.ansi-tool').getByText(`out ${total - 1}`).waitFor();
    await page.waitForTimeout(150);
    assert.equal(await pinned(), true, `pinned after the tool output grows to ${total} lines`);
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
  // Earlier history is one tap on a labelled pill. While the request runs, live polls (which trim
  // from the top and repeat lines like separators) keep a bottom reader pinned; when the request
  // ends with more output, the join between earlier and current output lands mid-view.
  const show = (text, loading) => page.evaluate(([t, l]) => window.show(t, true, l), [text, loading]);
  const block = (name, n) => Array.from({ length: n }, (_, i) => `${name} ${i}`).join('\n');
  const current = `────\n${block('now', 20)}\n────`;
  await show(current, false);
  // The pill's label reads in body text, not dim grey.
  assert.equal(await terminal.getByText('Load earlier output').evaluate((el) => getComputedStyle(el).color), 'rgb(224, 224, 224)');
  await terminal.getByText('Load earlier output').click();
  assert.equal(await page.evaluate(() => window.loads), 1);
  await show(current, true);
  const trimmed = `${block('now', 20).split('\n').slice(1).join('\n')}\n────\n${block('live', 10)}`;
  await show(trimmed, true);
  await terminal.getByText('live 9').waitFor({ state: 'attached' });
  await page.waitForTimeout(150);
  assert.equal(await pinned(), true, 'live polls during the load keep the view on the newest line');
  await show(`${lines(100)}\n${trimmed}`, false);
  await terminal.getByText('line 99').waitFor({ state: 'attached' });
  await page.waitForTimeout(150);
  const join = await terminal.evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const at = walker.currentNode.data.indexOf('now 1');
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(walker.currentNode, at);
      range.setEnd(walker.currentNode, at + 5);
      const box = el.getBoundingClientRect();
      return (range.getBoundingClientRect().top - box.top) / box.height;
    }
    return null;
  });
  assert.ok(join > 0.3 && join < 0.7, `join sits at ${join} of the pane height`);
  // A load that ends with nothing new (empty or failed) clears the tap and moves nothing:
  // tapping scrolled the pill into view, and the reader stays there through the next live poll.
  const settled = `${lines(100)}\n${trimmed}`;
  await terminal.getByText('Load earlier output').click();
  const reading = await terminal.evaluate((el) => el.scrollTop);
  await show(settled, true);
  await show(settled, false);
  await page.waitForTimeout(150);
  assert.equal(await terminal.evaluate((el) => el.scrollTop), reading, 'an empty load does not move the view');
  await show(`${settled}\n${block('after', 5)}`, false);
  await terminal.getByText('after 4').waitFor({ state: 'attached' });
  await page.waitForTimeout(150);
  assert.equal(await terminal.evaluate((el) => el.scrollTop), reading, 'the next live poll keeps the reader where they were');
  // The empty load cleared the tap: a later request that does add earlier output, started
  // without a tap, keeps the reader's place instead of jumping to a mid-view join.
  const grown = `${lines(150)}\n${trimmed}\n${block('after', 5)}`;
  await show(`${settled}\n${block('after', 5)}`, true);
  await show(grown, false);
  await terminal.getByText('line 149').waitFor({ state: 'attached' });
  await page.waitForTimeout(150);
  assert.equal(await terminal.evaluate((el) => el.scrollTop), reading, 'no leftover tap after an empty load');
  assert.deepEqual(errors, []);
});
