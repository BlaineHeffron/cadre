// The real Agents page at phone width in headless Chromium against a stubbed API.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

const sessions = [
  { id: 'a1', displayName: 'first task', workDir: '/home/me/repo', tmuxSession: 'claude-a1', state: { status: 'working' } },
  { id: 'b2', displayName: 'second task', workDir: '/home/me/repo', tmuxSession: 'claude-b2', state: { status: 'ready' } },
];

test('phone Agents page leads with sessions, keeps bulk actions folded until used, and opens a basics-first new-session form', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = Fastify();
  t.after(() => app.close());
  await app.register(fastifyStatic, { root: `${root}public`, prefix: '/' });
  await app.register(fastifyStatic, { root: `${root}node_modules`, prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(`${root}public/index.html`, 'utf8');
  app.get('/fixture', (_req, reply) => reply.type('text/html').send(index.replace('<script type="module" src="/app/app.mjs"></script>', `<script type="module">
    import { h, render } from 'preact';
    import { isAuthenticated } from '/app/state.mjs';
    import { AgentsPage } from '/pages/agents.mjs';
    isAuthenticated.value = true;
    render(h(AgentsPage, {}), document.getElementById('app'));
  </script>`)));
  app.get('/api/claude/sessions', () => ({ sessions }));
  // The built-in default profile selects no servers, so nothing has been removed and Advanced stays shut.
  const any = ['claude', 'codex', 'pi'];
  app.get('/api/agents/mcp-servers', () => ({ defaultProfileId: 'default', profiles: [{ id: 'default', serverIds: [] }, { id: 'cadre', serverIds: ['dueno'] }], servers: [{ id: 'dueno', providers: any, runtimes: any, availability: { state: 'configured' } }] }));
  app.get('/api/agents/skills', () => ({ skills: [{ id: 'review', name: 'Review' }] }));
  app.get('/api/*', () => ({ sessions: [] }));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/fixture`);

  const cards = page.locator('.session-card');
  await cards.first().waitFor();
  assert.equal(await cards.count(), 2);
  // One provider heading per run of cards, not one per card.
  assert.deepEqual(await page.locator('.agents-card-provider').allInnerTexts(), ['Claude']);
  assert.equal(await cards.first().getByRole('img', { name: 'Unread' }).isVisible(), true);
  // At two columns the heading spans the row, so cards side by side line up.
  await page.setViewportSize({ width: 960, height: 844 });
  const [left, right] = await Promise.all([0, 1].map((i) => cards.nth(i).boundingBox()));
  assert.ok(right.x > left.x && right.y === left.y, `cards at y=${left.y} and y=${right.y}`);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.getByRole('textbox', { name: 'Search agents' }).isVisible(), true);
  assert.equal(await page.getByRole('combobox', { name: 'Filter by provider' }).isVisible(), true);
  // One status vocabulary: the filter chip uses the badge's own words.
  assert.equal(await page.getByRole('button', { name: 'Needs attention', exact: true }).isVisible(), true);

  // Each card leads with one primary action; the rest wait behind its ⋯ menu.
  const first = cards.first();
  assert.equal(await first.getByRole('button', { name: 'Open', exact: true }).isVisible(), true);
  // Unread is a dot, so the status badge is the only label on the card.
  assert.equal(await first.getByText('New', { exact: true }).count(), 0);
  assert.equal(await first.getByRole('button', { name: 'Kill' }).isVisible(), false);
  await first.getByLabel('More actions for first task').click();
  for (const name of ['Copy ID', 'Start loop', 'Shift+Tab', 'Esc', 'Kill']) assert.equal(await first.getByRole('button', { name, exact: true }).isVisible(), true, name);
  await first.getByRole('button', { name: 'Copy ID', exact: true }).click();
  assert.equal(await first.getByRole('button', { name: 'Kill' }).isVisible(), false, 'choosing an item closes the menu');

  const bulk = page.locator('details.agents-bulk');
  const isOpen = () => bulk.evaluate((el) => el.open);
  assert.equal(await isOpen(), false);
  assert.equal(await page.getByRole('button', { name: /^Kill Selected/ }).isVisible(), false);
  // The first card sits above the fold.
  assert.ok((await cards.first().boundingBox()).y < 844 / 2);

  const select = cards.first().getByRole('checkbox');
  await select.check();
  assert.equal(await isOpen(), true);
  assert.equal(await page.getByRole('button', { name: 'Kill Selected (1)' }).isVisible(), true);
  await select.uncheck();
  assert.equal(await isOpen(), false);

  // Opened by hand, the panel stays open when a selection comes and goes.
  await bulk.locator('summary').click();
  await select.check();
  await select.uncheck();
  assert.equal(await isOpen(), true);

  // The new-session form leads with the basics; name and coordinator wait under Advanced.
  await page.getByRole('button', { name: 'New session', exact: true }).click();
  // Phone touch targets stay 44px tall, including the inline skill picker.
  const skillPicker = page.locator('.new-agent-prompt-tools .ctrl-inline-select');
  assert.ok((await skillPicker.boundingBox()).height >= 44, 'skill picker keeps a 44px touch target');
  const fields = page.locator('.new-agent-setup-grid .new-agent-field');
  assert.deepEqual(await fields.locator('> span').allInnerTexts(), ['Provider', 'Model', 'Thinking level']);
  const [provider, model] = await Promise.all([0, 1].map((i) => fields.nth(i).boundingBox()));
  assert.equal(provider.y, model.y, 'provider and model share a row');
  assert.ok(provider.x + provider.width <= model.x);
  const worktree = page.getByRole('checkbox', { name: /Isolated git worktree/ });
  assert.equal(await worktree.isVisible(), true);
  assert.equal(Math.round((await worktree.boundingBox()).width), 18, 'form checkboxes use the shared 18px size');
  assert.equal(await page.getByPlaceholder('Optional label').isVisible(), false);
  assert.equal(await page.getByRole('checkbox', { name: /Coordinator/ }).isVisible(), false);
  await page.locator('.new-agent-advanced > summary').click();
  assert.equal(await page.getByPlaceholder('Optional label').isVisible(), true);
  assert.equal(await page.getByRole('checkbox', { name: /Coordinator/ }).isVisible(), true);
  assert.equal(await page.getByRole('alert').count(), 0, 'no dueno warning on the empty default profile');
  // Unchecking dueno from a profile that has it still warns.
  await page.locator('.mcp-selector-control select').selectOption('cadre');
  await page.getByRole('checkbox', { name: /dueno/ }).uncheck();
  assert.match(await page.getByRole('alert').innerText(), /Cadre MCP \(dueno\) removed/);
  // The form sits over a dimmed page: a click on the backdrop closes it, but never discards a typed prompt.
  const backdrop = page.locator('.new-agent-backdrop');
  const cover = await backdrop.boundingBox();
  assert.ok(cover.x === 0 && cover.y === 0 && cover.width === 390 && cover.height === 844, 'backdrop covers the screen');
  await page.getByRole('textbox', { name: 'Initial prompt' }).fill('draft');
  await page.mouse.click(10, 20);
  assert.equal(await backdrop.count(), 1, 'a typed prompt keeps the form open');
  await page.getByRole('textbox', { name: 'Initial prompt' }).fill('');
  await page.mouse.click(10, 20);
  assert.equal(await backdrop.count(), 0, 'an empty form closes from the backdrop');
  assert.deepEqual(errors, []);
});
