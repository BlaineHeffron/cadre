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
  // Card paths and times are read, so they use the 13px step in secondary grey. The path is the
  // rail's short form in the body font, so it is not cut mid-word; the full path is its tooltip.
  const path = cards.first().getByTitle('/home/me/repo');
  assert.equal(await path.innerText(), 'me/repo');
  assert.deepEqual(await path.evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).color, getComputedStyle(el).fontFamily === getComputedStyle(document.body).fontFamily]), ['13px', 'rgb(208, 208, 222)', true]);
  // At two columns the heading spans the row, so cards side by side line up.
  await page.setViewportSize({ width: 960, height: 844 });
  const [left, right] = await Promise.all([0, 1].map((i) => cards.nth(i).boundingBox()));
  assert.ok(right.x > left.x && Math.abs(right.y - left.y) < 0.5, `cards at y=${left.y} and y=${right.y}`);
  await page.setViewportSize({ width: 390, height: 844 });
  // The 13px card meta wraps instead of widening the page.
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'no horizontal scroll at 390px');
  assert.equal(await page.getByRole('textbox', { name: 'Search agents' }).isVisible(), true);
  assert.equal(await page.getByRole('combobox', { name: 'Filter by provider' }).isVisible(), true);
  // One status vocabulary: the filter chip uses the badge's own words.
  assert.equal(await page.getByRole('button', { name: 'Needs attention', exact: true }).isVisible(), true);

  // Each card leads with one primary action; the rest wait behind its ⋯ menu.
  const first = cards.first();
  assert.equal(await first.getByRole('button', { name: 'Open', exact: true }).isVisible(), true);
  // The actions sit at the right of the card's meta lines rather than on a row of their own.
  const [open, foot, card] = await Promise.all([first.getByRole('button', { name: 'Open', exact: true }), first.locator('.session-card-foot'), first].map((l) => l.boundingBox()));
  assert.ok(open.x > card.x + card.width / 2 && open.x + open.width <= card.x + card.width, `Open at x=${open.x} in a card from ${card.x} to ${card.x + card.width}`);
  assert.ok(open.y >= foot.y && open.y + open.height <= foot.y + foot.height + 0.5, 'Open sits in the meta rows');
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
  // The rendered box, not just the CSS value: a long label (or CI's wider font, which made it 17px)
  // must wrap rather than squeeze the box in the phone-width dialog.
  const squeezed = await worktree.evaluate((el) => {
    const title = el.closest('label').querySelector('span');
    const before = title.firstChild.textContent;
    title.firstChild.textContent = before.repeat(4);
    const width = el.getBoundingClientRect().width;
    title.firstChild.textContent = before;
    return width;
  });
  assert.equal(squeezed, 20, 'form checkboxes keep the shared 20px size beside a long label');
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
  // The form is a named modal dialog over a dimmed page. Escape and a backdrop click close an empty
  // form, never a typed draft, and focus returns to the button that opened it.
  const dialog = page.getByRole('dialog', { name: 'New Agent Session' });
  const prompt = page.getByRole('textbox', { name: 'Initial prompt' });
  assert.equal(await dialog.isVisible(), true);
  await prompt.fill('draft');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.mouse.click(10, 20);
  assert.equal(await dialog.isVisible(), true, 'a typed prompt survives repeated Escape and a backdrop click');
  // Escape first closes an open folder picker, then still keeps the draft.
  await page.getByRole('button', { name: 'Browse', exact: true }).click();
  await page.locator('.new-agent-folder-picker').waitFor();
  await prompt.focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.new-agent-folder-picker').count(), 0, 'Escape closes the folder picker first');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  assert.equal(await dialog.isVisible(), true, 'the draft survives picker, Escape, Escape');
  assert.equal(await prompt.innerText(), 'draft');
  await prompt.fill('');
  await page.mouse.click(10, 20);
  assert.equal(await dialog.count(), 0, 'an empty form closes from the backdrop');
  const opener = page.getByRole('button', { name: 'New session', exact: true });
  await opener.click();
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Initial prompt', 'focus moves into the form');
  await page.keyboard.press('Escape');
  assert.equal(await dialog.count(), 0, 'Escape closes an empty form right after opening');
  assert.equal(await opener.evaluate((el) => el === document.activeElement), true, 'focus returns to New session');
  assert.deepEqual(errors, []);
});
