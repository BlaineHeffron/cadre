// The foot of a live Claude Code pane in headless Chromium: the CLI's empty input box gives way to the
// composer, its status lines read as one strip under the transcript, and its OSC 8 link is a real link.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

test('a captured Claude Code footer renders as a status strip with a clickable link and no input-box chrome', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const pane = await readFile(new URL('./fixtures/terminal/claude-update-rc-footer.pane', import.meta.url), 'utf8');
  const app = Fastify();
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); });
  await app.register(fastifyStatic, { root: `${root}public`, prefix: '/' });
  await app.register(fastifyStatic, { root: `${root}node_modules`, prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(`${root}public/index.html`, 'utf8');
  // The session page's column: transcript, the strip, then the composer.
  app.get('/fixture', (_req, reply) => reply.type('text/html').send(index.replace('<script type="module" src="/app/app.mjs"></script>', `<script type="module">
    import { h, render } from 'preact';
    import { Terminal, CliStatus } from '/components/terminal.mjs';
    import { splitCliFooter } from '/lib/ansi-to-html.mjs';
    const { text, status } = splitCliFooter(${JSON.stringify(pane)});
    render(h('div', { style: 'display:flex; flex-direction:column; height:600px' },
      h(Terminal, { content: text, fullHeight: true, ansiColors: true, resetKey: 's1' }),
      h(CliStatus, { lines: status }),
      h('div', { id: 'composer', style: 'height:80px; flex:none' }, 'composer')), document.getElementById('app'));
  </script>`)));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/fixture`);

  const strip = page.locator('.terminal-status');
  await strip.waitFor();
  // The transcript's copyable text is the capture's own, up to the box; no rule, no dead prompt, no escape remnants.
  const body = await page.locator('.terminal-body').textContent();
  assert.ok(body.trimEnd().endsWith('❯ /mcp\n  ⎿  Reconnected to dueno.'), JSON.stringify(body.slice(-80)));
  assert.equal(await page.locator('.terminal-body .ansi-rule').count(), 0);
  assert.doesNotMatch(body + await strip.innerText(), /\]8;|─{5}|bypass permissions/);
  // One strip between the transcript and the composer, each status on one unpadded row.
  assert.deepEqual(await strip.locator(':scope > span').allInnerTexts(), ['← 1 agent', '✔ Update installed · Restart to update', '/rc']);
  const [terminal, bar, composer] = await Promise.all([page.locator('.terminal'), strip, page.locator('#composer')].map((l) => l.boundingBox()));
  assert.ok(Math.abs(bar.y - (terminal.y + terminal.height)) < 1 && Math.abs(composer.y - (bar.y + bar.height)) < 1, 'the strip sits between transcript and composer');
  assert.ok(bar.height < 40, `the strip is one tidy row, ${bar.height}px tall`);
  // The remote-control link is a real, safe link with its label as text.
  const link = strip.getByRole('link', { name: '/rc' });
  assert.deepEqual(await link.evaluate((a) => [a.href, a.target, a.rel]),
    ['https://claude.ai/code/session_00000000?from=cli', '_blank', 'noopener noreferrer']);
  assert.deepEqual(errors, []);
});
