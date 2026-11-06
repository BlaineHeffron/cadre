// The nav and Agents page mounted as the app mounts them, in headless Chromium against a stubbed API:
// with a session open, the view fills the window.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

test('a desktop session fills the window: full-height rail, edge-to-edge pane, reading column inside', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = Fastify();
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); });
  await app.register(fastifyStatic, { root: `${root}public`, prefix: '/' });
  await app.register(fastifyStatic, { root: `${root}node_modules`, prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(`${root}public/index.html`, 'utf8');
  app.get('/fixture', (_req, reply) => reply.type('text/html').send(index.replace('<script type="module" src="/app/app.mjs"></script>', `<script type="module">
    import { h, render } from 'preact';
    import { html } from 'htm/preact';
    import { isAuthenticated } from '/app/state.mjs';
    import { Nav } from '/components/nav.mjs';
    import { AgentsPage } from '/pages/agents.mjs';
    isAuthenticated.value = true;
    render(html\`<\${Nav} /><main class="main"><\${AgentsPage} /></main>\`, document.getElementById('app'));
  </script>`)));
  app.get('/api/claude/sessions', () => ({ sessions: [{ id: 'a1', displayName: 'first task', workDir: '/home/me/repo', tmuxSession: 'claude-a1', state: { status: 'working' } }] }));
  app.get('/api/claude/sessions/:id', (req) => ({ id: req.params.id, content: `● ${'The reply reads as prose. '.repeat(30)}`, state: { status: 'working' }, sessionName: 'claude-a1' }));
  app.get('/api/*', () => ({ sessions: [] }));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/fixture`);
  await page.locator('.terminal', { hasText: 'The reply reads as prose.' }).waitFor();

  const box = async (selector) => {
    const { x, y, width, height } = await page.locator(selector).first().boundingBox();
    return { left: Math.round(x), top: Math.round(y), right: Math.round(x + width), bottom: Math.round(y + height) };
  };
  // The toolbar and rail form one full-height sidebar from the window's top-left corner.
  const side = await box('.agents-desktop-toolbar');
  const rail = await box('.agents-desktop-rail');
  assert.deepEqual([side.left, side.top, rail.left, rail.top, rail.bottom], [0, 0, 0, side.bottom, 900]);
  assert.equal(rail.right, side.right);
  // The nav and the session sit beside it and run to the right and bottom edges.
  const nav = await box('.nav');
  const detail = await box('.agents-desktop-detail');
  assert.deepEqual([nav.left, nav.top, nav.right], [side.right, 0, 1600]);
  assert.deepEqual([detail.left, detail.top, detail.right, detail.bottom], [side.right, nav.bottom, 1600, 900]);
  // Inside the pane the transcript reads in a centred column, while its scroll area keeps the full width.
  const column = await page.locator('.terminal').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { width: el.offsetWidth, left: parseFloat(cs.paddingLeft), right: parseFloat(cs.paddingRight) };
  });
  assert.equal(column.width, detail.right - detail.left);
  assert.equal(column.left, column.right);
  assert.ok(column.width - column.left - column.right <= 880, `reading column ${column.width - column.left - column.right}px`);
  assert.equal(await page.evaluate(() => document.scrollingElement.scrollWidth), 1600);
  assert.deepEqual(errors, []);
});
