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
const room = (id, title, count, metadata = {}) => ({
  thread: { id, title, status: 'open', participants, updatedAt: 1, metadata },
  messages: Array.from({ length: count }, (_, i) => ({
    id: `${id}-m${i}`, threadId: id, from: participants[i % 2], type: 'message', createdAt: i + 1, body: `${title} message ${i} ${'words '.repeat(20)}`,
  })),
  deliveries: [],
});
// The second room carries enough bootstrap status to overflow a short Info panel.
const bootstrapStatus = Array.from({ length: 12 }, (_, i) => ({ participant: participants[i % 2], status: 'completed', created: true, completedAt: 1 }));
const rooms = { r1: room('r1', 'Long room', 60), r2: room('r2', 'Other room', 80, { bootstrapStatus }) };

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
    import { signal } from '@preact/signals';
    import { isAuthenticated } from '/app/state.mjs';
    import { Nav } from '/components/nav.mjs';
    import { AgentCollabPage } from '/pages/agent-collab.mjs';
    isAuthenticated.value = true;
    // Changes the room in place, as the router does, without a reload.
    const room = signal(${JSON.stringify(req.query.id || '')});
    window.openRoom = (id) => { room.value = id; };
    const App = () => html\`<\${Nav} /><main class="main"><\${AgentCollabPage} id=\${room.value} /></main>\`;
    render(html\`<\${App} />\`, document.getElementById('app'));
  </script>`)));
  app.get('/api/agent-bus/threads', () => ({ threads: Object.values(rooms).map((r) => r.thread) }));
  app.get('/api/agent-bus/threads/:id', (req, reply) => rooms[req.params.id] || reply.code(404).send({ error: 'not found' }));
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
    await page.locator('.collab-message-card', { hasText: 'Long room message 59' }).waitFor();
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
  const scrollToTop = () => page.locator('.collab-feed').evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  const settle = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 50))));
  await scrollToTop();
  await send('fresh while reading');
  await settle();
  assert.equal(await page.locator('.collab-feed').evaluate((el) => el.scrollTop), 0);

  // Opening another room after scrolling up starts that room at its newest message.
  // The new room's messages can commit before the scroll lands, so repeat the switch a few times.
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [from, to, last] of Array(3).fill([['r1', 'r2', 'Other room message 79'], ['r2', 'r1', 'Long room message 59']]).flat()) {
    await page.evaluate((id) => window.openRoom(id), from);
    await settle();
    await scrollToTop();
    await page.evaluate((id) => window.openRoom(id), to);
    await page.locator('.collab-message-card', { hasText: last }).waitFor();
    await settle();
    assert.equal((await feed()).atBottom, true, `${to} opens at the bottom`);
  }

  // Info is bounded by the room pane on a short window, so all of it can be scrolled to.
  await page.evaluate(() => window.openRoom('r2'));
  await page.locator('.collab-message-card', { hasText: 'Other room message 79' }).waitFor();
  await page.setViewportSize({ width: 1366, height: 650 });
  await page.locator('.collab-room-info > summary').click();
  const [panel, pane] = await Promise.all(['.collab-room-info-panel', '.collab-detail'].map((sel) => page.locator(sel).boundingBox()));
  assert.ok(panel.y + panel.height <= pane.y + pane.height, `Info panel ${JSON.stringify(panel)} inside pane ${JSON.stringify(pane)}`);
  // Info closes when another room opens.
  await page.evaluate(() => window.openRoom('r1'));
  await page.locator('.collab-message-card', { hasText: 'Long room message 59' }).waitFor();
  assert.equal(await page.locator('.collab-room-info-panel').isVisible(), false);

  // Phone with no room, or one that fails to load, shows the rail rather than a dead-end pane.
  await page.setViewportSize({ width: 390, height: 760 });
  for (const path of ['/fixture', '/fixture?id=gone']) {
    await page.goto(`${origin}${path}`);
    await page.locator('.collab-thread-item', { hasText: 'Long room' }).waitFor();
    await settle();
    assert.equal(await page.locator('.collab-detail').isVisible(), false, path);
    assert.equal(await page.locator('.collab-rail').isVisible(), true, path);
    // The full-width rail drops its divider; the shell's own border frames it.
    assert.equal(await page.locator('.collab-rail').evaluate((el) => getComputedStyle(el).borderRightWidth), '0px', path);
    assert.equal(await pageScrolls(), false, path);
  }
  assert.deepEqual(errors, []);
});
