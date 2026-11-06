// The session header's Restart session action in headless Chromium against a stubbed API.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

async function start(t) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = Fastify();
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); });
  await app.register(fastifyStatic, { root: `${root}public`, prefix: '/' });
  await app.register(fastifyStatic, { root: `${root}node_modules`, prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(`${root}public/index.html`, 'utf8');
  app.get('/session', (_req, reply) => reply.type('text/html').send(index.replace('<script type="module" src="/app/app.mjs"></script>', `<script type="module">
    import { h, render } from 'preact';
    import { isAuthenticated } from '/app/state.mjs';
    import { AgentSessionDetailPage } from '/pages/agent-session-detail.mjs';
    isAuthenticated.value = true;
    render(h('main', { class: 'main' }, h(AgentSessionDetailPage, { id: 'a1', provider: 'claude' })), document.getElementById('app'));
  </script>`)));
  const fake = { status: 'ready', attachCommand: 'tmux attach -t claude-a1', content: '● Done.', hold: null, accept: false, machine: null };
  const restarts = [];
  app.get('/api/claude/sessions/:id', (req) => ({ id: req.params.id, content: fake.content, state: { status: fake.status }, sessionName: `claude-${req.params.id}`, attachCommand: fake.attachCommand, machine: fake.machine }));
  app.post('/api/claude/sessions/:id/restart', async (req) => {
    restarts.push(req.params.id);
    await fake.hold;
    return { id: req.params.id, resumed: true };
  });
  app.post('/api/*', () => ({ ok: true }));
  app.get('/api/*', () => ({ sessions: [] }));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const dialogs = [];
  page.on('dialog', (dialog) => { dialogs.push(dialog.message()); return fake.accept ? dialog.accept() : dialog.dismiss(); });
  const restarted = () => page.waitForResponse((res) => res.url().endsWith('/api/claude/sessions/a1/restart'));
  return { page, origin, fake, restarts, dialogs, errors, restarted };
}

test('Actions ▾ offers Restart session: an idle session restarts at once, a busy one asks first', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
  const { page, origin, fake, restarts, dialogs, errors, restarted } = await start(t);
  const restart = async () => {
    await page.locator('.claude-session-header summary', { hasText: 'Actions' }).click();
    await page.getByRole('button', { name: 'Restart session', exact: true }).click();
  };

  // Idle: no question, straight to the restart.
  await page.goto(`${origin}/session`);
  await page.getByText('Done.').waitFor();
  await Promise.all([restarted(), restart()]);
  assert.deepEqual([restarts, dialogs], [['a1'], []]);

  // Mid-turn: it asks; declining leaves the session alone, accepting restarts it.
  fake.status = 'working';
  await page.goto(`${origin}/session`);
  await page.getByText('Done.').waitFor();
  await restart();
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0], /not idle/);
  assert.deepEqual(restarts, ['a1']);
  fake.accept = true;
  await Promise.all([restarted(), restart()]);
  assert.deepEqual(restarts, ['a1', 'a1']);

  // While a restart runs, the item is disabled, so a second click sends nothing.
  fake.status = 'ready';
  let release;
  fake.hold = new Promise((resolve) => { release = resolve; });
  await page.goto(`${origin}/session`);
  await page.getByText('Done.').waitFor();
  const first = restarted();
  await restart();
  await page.locator('.claude-session-header summary', { hasText: 'Actions' }).click();
  const pending = page.getByRole('button', { name: 'Restarting…', exact: true });
  assert.equal(await pending.isDisabled(), true);
  release();
  await first;
  await page.getByRole('button', { name: 'Restart session', exact: true }).waitFor();
  assert.deepEqual(restarts, ['a1', 'a1', 'a1']);

  // A session with no tmux pane (structured) has nothing to restart.
  fake.attachCommand = '';
  await page.goto(`${origin}/session`);
  await page.getByText('Done.').waitFor();
  await page.locator('.claude-session-header summary', { hasText: 'Actions' }).click();
  await page.getByRole('button', { name: 'Kill', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /Restart/ }).count(), 0);
  assert.deepEqual(errors, []);
});

test('Claude Code\'s "Restart to update" in the status strip is a button for the same restart', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
  const { page, origin, fake, restarts, dialogs, errors, restarted } = await start(t);
  // A real capture: the empty input box, then mode extras, the update notice and the /rc link.
  const pane = await readFile(new URL('./fixtures/terminal/claude-update-rc-footer.pane', import.meta.url), 'utf8');
  fake.content = pane;
  const strip = page.locator('.terminal-status');
  const button = strip.getByRole('button', { name: 'Restart to update', exact: true });
  const open = async () => {
    await page.goto(`${origin}/session`);
    await strip.getByText('← 1 agent').waitFor();
  };

  // The phrase is the button; the rest of the strip reads as before.
  await open();
  assert.deepEqual(await strip.locator(':scope > span').allInnerTexts(), ['← 1 agent', '✔ Update installed · Restart to update', '/rc']);
  assert.equal(await button.count(), 1);
  // Idle: it restarts at once.
  await Promise.all([restarted(), button.click()]);
  assert.deepEqual([restarts, dialogs], [['a1'], []]);

  // Mid-turn: the same question first; declined, nothing is sent.
  fake.status = 'working';
  await open();
  await button.click();
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0], /not idle/);
  assert.deepEqual(restarts, ['a1']);

  // While a restart runs the button is disabled, and so is the menu item.
  fake.status = 'ready';
  let release;
  fake.hold = new Promise((resolve) => { release = resolve; });
  await open();
  const first = restarted();
  await button.click();
  assert.equal(await button.isDisabled(), true);
  await button.click({ force: true });
  await page.locator('.claude-session-header summary', { hasText: 'Actions' }).click();
  assert.equal(await page.getByRole('button', { name: 'Restarting…', exact: true }).isDisabled(), true);
  release();
  await first;
  await page.waitForFunction(() => !document.querySelector('.terminal-status-restart')?.disabled);
  assert.deepEqual(restarts, ['a1', 'a1']);

  // In both themes the button keeps its line's colour and stands off the strip.
  for (const theme of ['dark', 'light']) {
    const look = await page.evaluate((name) => {
      document.documentElement.dataset.theme = name;
      const css = (el) => getComputedStyle(el);
      const btn = document.querySelector('.terminal-status-restart');
      return { button: css(btn).color, line: css(btn.parentElement).color, strip: css(document.querySelector('.terminal-status')).backgroundColor, bg: css(btn).backgroundColor };
    }, theme);
    assert.equal(look.button, look.line, theme);
    assert.notEqual(look.button, look.strip, theme);
    assert.equal(look.bg, 'rgba(0, 0, 0, 0)', theme);
  }

  // No update notice: no button, the strip as before.
  fake.content = pane.replace(/^.*Update installed.*$/m, '');
  await open();
  assert.deepEqual(await strip.locator(':scope > span').allInnerTexts(), ['← 1 agent', '/rc']);
  assert.equal(await strip.getByRole('button').count(), 0);

  // Where Restart is hidden (structured, remote), the notice stays plain text.
  fake.content = pane;
  for (const hidden of [{ attachCommand: '' }, { machine: { id: 'w5', url: 'http://127.0.0.1:9' } }]) {
    Object.assign(fake, { attachCommand: 'tmux attach -t claude-a1', machine: null }, hidden);
    await open();
    await strip.getByText('Restart to update').waitFor();
    assert.equal(await strip.getByRole('button').count(), 0, JSON.stringify(hidden));
  }
  assert.deepEqual(restarts, ['a1', 'a1']);
  assert.deepEqual(errors, []);
});
