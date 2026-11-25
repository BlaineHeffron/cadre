// The nav and Rooms page mounted as the app mounts them, in headless Chromium against a stubbed API:
// a long room fills the window, its feed scrolls on its own and the composer stays on screen.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

const participants = [{ kind: 'claude', sessionId: 'c1' }, { kind: 'codex', sessionId: 'x1' }];
const thread = { id: 'r1', title: 'Long room', status: 'open', participants, updatedAt: 1, metadata: {} };
const messages = Array.from({ length: 60 }, (_, i) => ({
  id: `m${i}`, threadId: 'r1', from: participants[i % 2], type: 'message', createdAt: i + 1, body: `Message ${i} ${'words '.repeat(20)}`,
}));

test('a long room fills the window with a self-scrolling feed that follows the newest message', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = Fastify();
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); });
  await app.register(fastifyStatic, { root: `${root}public`, prefix: '/' });
  await app.register(fastifyStatic, { root: `${root}node_modules`, prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(`${root}public/index.html`, 'utf8');
  app.get('/fixture', (req, reply) => reply.type('text/html').send(index.replace('<script type="module" src="/app/app.mjs"></script>', `<script type="module">
    import { render } from 'preact';
    import { html } from 'htm/preact';
    import { isAuthenticated } from '/app/state.mjs';
    import { Nav } from '/components/nav.mjs';
    import { AgentCollabPage } from '/pages/agent-collab.mjs';
    isAuthenticated.value = true;
    render(html\`<\${Nav} /><main class="main"><\${AgentCollabPage} id=${JSON.stringify(req.query.id || '')} /></main>\`, document.getElementById('app'));
  </script>`)));
  app.get('/api/agent-bus/threads', () => ({ threads: [thread] }));
  app.get('/api/agent-bus/threads/:id', () => ({ thread, messages, deliveries: [] }));
  let sent = 0;
  app.post('/api/agent-bus/messages', (req) => ({ message: { id: `new${sent}`, threadId: 'r1', from: req.body.from, type: 'message', createdAt: 1000 + sent++, body: req.body.body } }));
  app.get('/api/*', () => ({}));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  const visible = async (selector) => {
    const b = await page.locator(selector).first().boundingBox();
    const { height } = page.viewportSize();
    return Boolean(b) && b.y >= 0 && b.y + b.height <= height;
  };
  const feed = () => page.locator('.collab-feed').evaluate((el) => ({
    scrolls: el.scrollHeight > el.clientHeight,
    atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 2,
  }));
  const pageScrolls = () => page.evaluate(() => document.scrollingElement.scrollHeight > window.innerHeight);
  const send = async (text) => {
    await page.locator('.collab-composer textarea').fill(text);
    await page.locator('.collab-composer textarea').press('Control+Enter');
    await page.locator('.collab-message-card', { hasText: text }).waitFor();
  };

  for (const viewport of [{ width: 1600, height: 900 }, { width: 390, height: 760 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/fixture?id=r1`);
    await page.locator('.collab-message-card', { hasText: 'Message 59' }).waitFor();
    // The room opens at its newest message; only the feed scrolls and the composer is on screen.
    assert.equal(await pageScrolls(), false, `page scroll at ${viewport.width}px`);
    assert.deepEqual(await feed(), { scrolls: true, atBottom: true });
    assert.ok(await visible('.collab-composer .btn-primary'), `composer on screen at ${viewport.width}px`);
    // Metadata sits behind the Info disclosure.
    assert.equal(await page.locator('.collab-room-info-panel').isVisible(), false);
    // Phone shows the room alone with a way back; desktop shows the rail beside it.
    assert.equal(await page.locator('.collab-rail').isVisible(), viewport.width > 980);
    assert.equal(await page.locator('.collab-room-back').isVisible(), viewport.width <= 980);
  }

  // A new message keeps the feed at the bottom; once the reader scrolls up it stops following.
  await send('fresh at bottom');
  await page.waitForFunction(() => {
    const el = document.querySelector('.collab-feed');
    return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  });
  await page.locator('.collab-feed').evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await send('fresh while reading');
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 50))));
  assert.equal(await page.locator('.collab-feed').evaluate((el) => el.scrollTop), 0);

  // Phone with no room selected shows the rail, not an empty pane.
  await page.goto(`${origin}/fixture`);
  await page.locator('.collab-thread-item', { hasText: 'Long room' }).waitFor();
  assert.equal(await page.locator('.collab-detail').isVisible(), false);
  assert.equal(await pageScrolls(), false);
  assert.deepEqual(errors, []);
});
