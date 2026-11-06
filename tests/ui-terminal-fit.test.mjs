// The session terminal in headless Chromium: it fills the column, short histories read from the top, long ones stick to the bottom.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

test('full-height terminal fills the column, starts a short history at the top and keeps streaming output pinned to the bottom', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = Fastify();
  // One hook, browser first: while it is open, its keep-alive connections hold app.close().
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); });
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
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/fixture`);

  const terminal = page.locator('.terminal');
  await terminal.getByText('Waiting…').waitFor();
  const [pane, body, controls] = await Promise.all([terminal, page.locator('.terminal-body'), page.locator('#controls')].map((l) => l.boundingBox()));
  assert.ok(body.y - pane.y < 24, `short history starts ${body.y - pane.y}px below the pane top`);
  // The transcript fills the column, so the controls stay pinned to its bottom edge.
  assert.equal(Math.round(pane.height), 520, 'a short history still fills the space above the controls');
  assert.equal(Math.round(controls.y + controls.height - pane.y), 600, 'the controls sit at the bottom of the column');
  // Nothing has scrolled, so the top fade is hidden and the first line reads at full strength.
  const fade = () => terminal.evaluate((el) => getComputedStyle(el, '::before').opacity);
  assert.equal(await fade(), '0');

  // A reply with a paragraph, a numbered list (one item wrapped), nested bullets, code and a closing
  // paragraph: every line of prose and list reads in the sans font; only the code stays monospace.
  await page.evaluate((text) => window.show(text), [
    '\x1b[38;5;231m●\x1b[39m The opening paragraph of the reply.',
    '',
    '  It will:',
    '  1. Find the cause. The likely suspects are the recent changes to how the',
    '     transcript fills the panel.',
    '  2. Fix it.',
    '  - A bullet',
    '    - A nested bullet',
    '',
    '      const answer = 42;',
    '',
    '  It won\'t merge or deploy.',
  ].join('\n'));
  await terminal.getByText('merge or deploy').waitFor();
  const fonts = await terminal.evaluate((el) => {
    const font = (text) => {
      const walker = document.createTreeWalker(el.querySelector('.terminal-body'), NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent.includes(text)) return getComputedStyle(node.parentElement).fontFamily;
      return null;
    };
    return Object.fromEntries(['opening paragraph', 'It will:', 'Find the cause', 'transcript fills', 'Fix it.', 'A bullet', 'A nested bullet', 'merge or deploy', 'const answer'].map((t) => [t, font(t)]));
  });
  const sans = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  for (const [text, family] of Object.entries(fonts)) {
    if (text === 'const answer') assert.notEqual(family, sans, 'code stays monospace');
    else assert.equal(family, sans, `"${text}" reads in the prose font`);
  }

  // A user prompt as tmux captures it: one background from ❯ to the reset on the blank line under
  // it, with wrapped lines, a bold word (a mid-line reset) and a blank-separated last paragraph
  // inside. It reads as one card in one font, with no per-line fill.
  const bg = '\x1b[38;5;246m\x1b[48;5;237m';
  const word = (w) => `\x1b[38;5;231m${w}\x1b[39m`;
  await page.evaluate((text) => window.show(text), [
    `${bg}❯ ${word('First line of a long pasted prompt that the CLI wrapped at its width ')}`,
    `  ${word('and carried on here.')}`,
    `  ${word('A ')}\x1b[1mbold\x1b[0m${bg}${word(' second line.')}`,
    '',
    `  ${word('Use the image as part of your next response.')}`,
    '\x1b[49m',
    '  \x1b[38;5;246mCalled dueno (ctrl+o to expand)\x1b[39m',
    '',
    '● The reply.',
  ].join('\n'));
  await terminal.getByText('The reply.').waitFor();
  const card = await terminal.evaluate((el) => {
    const cards = el.querySelectorAll('.ansi-prompt');
    const fonts = new Set();
    const walker = document.createTreeWalker(cards[0], NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent.trim()) fonts.add(getComputedStyle(node.parentElement).fontFamily);
    const fills = [...cards[0].querySelectorAll('span')].map((span) => getComputedStyle(span).backgroundColor).filter((c) => c !== 'rgba(0, 0, 0, 0)');
    return { count: cards.length, rects: cards[0].getClientRects().length, text: cards[0].textContent, fonts: [...fonts], fills, outside: el.querySelector('.terminal-body').textContent.includes('Called dueno') && !cards[0].textContent.includes('Called dueno') };
  });
  assert.equal(card.count, 1, 'the prompt is one card');
  assert.equal(card.rects, 1, 'one continuous box');
  assert.equal(card.text, '❯ First line of a long pasted prompt that the CLI wrapped at its width \n  and carried on here.\n  A bold second line.\n\n  Use the image as part of your next response.\n', 'text unchanged');
  assert.equal(card.fonts.length, 1, `one font across the prompt: ${card.fonts.join(' | ')}`);
  assert.deepEqual(card.fills, [], 'no per-line highlight inside the card');
  assert.equal(card.outside, true, 'the result under the prompt stays outside the card');

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
  // Pinned to the newest output, the view is snapped to a whole line at the top edge, so it needs
  // no fade and no row shows half-cut.
  assert.equal(await fade(), '0', 'no fade while pinned to the bottom');
  const cutRows = () => terminal.evaluate((el) => {
    const top = el.getBoundingClientRect().top + el.clientTop;
    const walker = document.createTreeWalker(el.querySelector('.terminal-body'), NodeFilter.SHOW_TEXT);
    const cut = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const match of node.textContent.matchAll(/[^\n]+/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const { top: rowTop, bottom } = range.getBoundingClientRect();
        if (rowTop < top - 1 && bottom > top + 1) cut.push(match[0]);
      }
    }
    return cut;
  });
  assert.deepEqual(await cutRows(), []);
  // Resizing the pinned pane (composer growth, a phone keyboard) re-snaps it without piling up
  // blank space under the newest line: the snap padding stays under one row.
  for (let step = 1; step <= 8; step++) {
    await page.evaluate((h) => { document.querySelector('#app > div').style.height = `${h}px`; }, 600 - step * 7);
    await page.waitForTimeout(80);
    const [pad, row] = await terminal.evaluate((el) => [parseFloat(el.querySelector('.terminal-body').style.paddingBottom) || 0, parseFloat(getComputedStyle(el).lineHeight)]);
    assert.ok(pad < row, `step ${step}: ${pad}px of snap padding with ${row}px rows`);
    assert.deepEqual(await cutRows(), [], `step ${step}: no half-cut row at the top`);
  }
  await page.evaluate(() => { document.querySelector('#app > div').style.height = '600px'; });
  // Once the reader scrolls up, new output no longer drags the view down.
  await terminal.hover();
  await page.mouse.wheel(0, -2000);
  await page.waitForFunction(() => { const el = document.querySelector('.terminal'); return el.scrollHeight - el.clientHeight - el.scrollTop > 200; });
  const readingAt = await terminal.evaluate((el) => el.scrollTop);
  assert.equal(await fade(), '1', 'rows scrolled past the top fade while reading history');
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
  assert.deepEqual(await page.getByText('Load earlier output').evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).fontSize]), ['rgb(224, 224, 224)', '13px']);
  await page.getByText('Load earlier output').click();
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
  await page.getByText('Load earlier output').click();
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
  // Pinned again, whatever the history's length, the Load earlier pill sits whole above the
  // transcript (never under its top edge) and stays clickable.
  await terminal.evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
  const pill = page.locator('.terminal-load-more');
  for (let n = 20; n <= 26; n++) {
    await show(lines(n), false);
    await terminal.getByText(`line ${n - 1}`).waitFor({ state: 'attached' });
    await page.waitForTimeout(150);
    const [pillBox, paneBox] = await Promise.all([pill, terminal].map((l) => l.boundingBox()));
    assert.ok(pillBox.y >= 0 && pillBox.y + pillBox.height <= paneBox.y + 0.5, `${n} lines: pill ${pillBox.y}..${pillBox.y + pillBox.height}, pane from ${paneBox.y}`);
  }
  const loads = await page.evaluate(() => window.loads);
  await pill.click();
  assert.equal(await page.evaluate(() => window.loads), loads + 1, 'the pill stays clickable');
  assert.deepEqual(errors, []);
});
