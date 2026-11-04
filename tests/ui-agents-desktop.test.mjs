// The real Agents page at desktop width in headless Chromium against a stubbed API.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

const demo = [
  { id: 'a1', displayName: 'first task', workDir: '/home/me/repo', tmuxSession: 'claude-a1', state: { status: 'working' } },
  { id: 'b2', displayName: 'second task', workDir: '/home/me/repo', tmuxSession: 'claude-b2', state: { status: 'ready' } },
];

test('desktop Agents page shows bulk actions only for a selection, folds session extras into one menu, and starts empty with a New action', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
  let sessions = demo;
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
  const blocked = { status: 'blocked', capabilities: { canAnswerInteraction: true }, interaction: { kind: 'permission', detail: 'Do you want to proceed?', fingerprint: 'q1', options: [
    { key: '1', label: 'Yes' },
    { key: '2', label: "Yes, and don't ask again for npm run migrate commands in this project" },
    { key: '3', label: 'No, and tell Claude what to do differently (esc)' },
  ] } };
  const menu = 'pane text\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don\'t ask again\n  3. No, and tell Claude what to do differently (esc)';
  app.get('/api/claude/sessions/:id', (req) => ({ id: req.params.id, content: req.params.id === 'b2' ? menu : 'pane text', state: req.params.id === 'b2' ? blocked : { status: 'working' }, sessionName: `claude-${req.params.id}` }));
  app.post('/api/*', () => ({ ok: true }));
  app.get('/api/*', () => ({ sessions: [] }));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/fixture`);

  const rows = page.locator('.agent-rail-row');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 2);
  // A row is its status, title and one checkbox; Start loop lives on the session itself.
  assert.equal(await rows.getByRole('button', { name: 'Start loop' }).count(), 0);
  assert.equal(await rows.first().locator('.status-badge').textContent(), '▶Working');
  // Calm states are tinted text, not a solid fill; checkboxes are an 18px target.
  assert.equal(await rows.first().locator('.status-badge').evaluate((el) => getComputedStyle(el).color), 'rgb(79, 195, 247)');
  assert.equal(Math.round((await rows.first().getByRole('checkbox').boundingBox()).width), 18);

  const toolbar = page.locator('.agents-desktop-toolbar');
  // Buttons, the search box and the provider select share one control height.
  const heights = await toolbar.locator('.btn, input.input, select.input').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
  assert.ok(heights.length >= 4 && new Set(heights).size === 1, `toolbar control heights ${heights}`);
  // Until something is selected the toolbar is search, provider, Filters and an icon Refresh.
  for (const name of ['Prompt', 'Esc', 'Kill']) assert.equal(await toolbar.getByRole('button', { name, exact: true }).count(), 0, name);
  assert.equal(await toolbar.getByRole('checkbox', { name: 'Select all' }).count(), 0);
  assert.equal(await toolbar.getByRole('button', { name: 'Refresh' }).innerText(), '↻');
  await page.getByRole('checkbox', { name: 'Bulk select first task' }).check();
  assert.equal(await toolbar.getByText('1 selected').isVisible(), true);
  assert.equal(await toolbar.getByRole('checkbox', { name: 'Select all' }).isVisible(), true);
  for (const name of ['Prompt', 'Esc', 'Kill']) assert.equal(await toolbar.getByRole('button', { name, exact: true }).isVisible(), true, name);
  // The bulk prompt closes with the selection and stays closed for the next one.
  const bulkPrompt = page.getByRole('textbox', { name: 'Bulk prompt to selected sessions' });
  await toolbar.getByRole('button', { name: 'Prompt', exact: true }).click();
  assert.equal(await bulkPrompt.isVisible(), true);
  await page.getByRole('checkbox', { name: 'Bulk select first task' }).uncheck();
  await page.getByRole('checkbox', { name: 'Bulk select first task' }).check();
  assert.equal(await bulkPrompt.count(), 0);

  const header = page.locator('.claude-session-header');
  await header.getByRole('button', { name: 'Rendered Transcript' }).waitFor();
  assert.equal(await header.getByRole('button', { name: 'Kill' }).isVisible(), false);
  await header.getByLabel('More session actions').click();
  for (const name of ['Copy ID', 'Refresh', 'Kill']) assert.equal(await header.getByRole('button', { name, exact: true }).isVisible(), true, name);
  await header.getByRole('button', { name: 'Refresh', exact: true }).click();
  assert.equal(await header.getByRole('button', { name: 'Kill' }).isVisible(), false, 'choosing an item closes the menu');


  // An approval keeps every answer on one row, full text in the title; composer tools are labelled.
  await rows.nth(1).locator('.agent-rail-row-main').click();
  const answers = page.locator('.control-row-primary .ctrl-btn');
  await answers.first().waitFor();
  const boxes = await answers.evaluateAll((els) => els.map((el) => {
    const { top, bottom } = el.getBoundingClientRect();
    return { top, bottom, clipped: el.scrollWidth > el.clientWidth };
  }));
  assert.ok(Math.max(...boxes.map((b) => b.top)) < Math.min(...boxes.map((b) => b.bottom)), 'answers share one row');
  assert.deepEqual(boxes.map((b) => b.clipped), [false, false, false], 'long answers wrap instead of truncating');
  assert.equal(await answers.nth(2).innerText(), 'No, and tell Claude what to do differently (esc)');
  // The terminal no longer repeats the menu the bar is showing.
  await page.locator('.terminal').getByText('pane text').waitFor();
  assert.doesNotMatch(await page.locator('.terminal').innerText(), /Do you want to proceed|2\. Yes/);
  assert.equal(await page.locator('.control-row-compose [data-placeholder]').getAttribute('data-placeholder'), 'Message the agent...', 'one composer placeholder whatever the state');
  // While answers are offered they are the only primary actions; Cycle mode and Interrupt step aside.
  for (const name of ['Cycle mode', 'Interrupt']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0, name);
  // Composer extras wait behind one menu.
  const delay = page.getByRole('combobox', { name: 'Send delay' });
  assert.equal(await delay.isVisible(), false);
  await page.getByLabel('More composer tools').click();
  assert.equal(await delay.isVisible(), true);
  assert.equal(await page.getByRole('button', { name: 'Save as skill' }).isVisible(), true);
  // Custom delay keeps the menu open while its amount and unit are set; the amount box keeps input height.
  await delay.selectOption('custom');
  await page.getByRole('combobox', { name: 'Delay unit' }).selectOption({ index: 1 });
  const amount = page.getByRole('spinbutton', { name: 'Delay amount' });
  assert.equal(await amount.isVisible(), true);
  assert.ok((await amount.boundingBox()).height < 48, 'amount box is not stretched');
  await delay.selectOption({ index: 0 });
  assert.equal(await delay.isVisible(), false, 'a preset delay closes the menu');
  // A working session gets them back.
  await rows.first().locator('.agent-rail-row-main').click();
  for (const name of ['Cycle mode', 'Interrupt']) await page.getByRole('button', { name, exact: true }).waitFor();
  // Interrupt goes through POST /escape, which the server may promote to an interrupt.
  await Promise.all([
    page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/claude/sessions/a1/escape')),
    page.getByRole('button', { name: 'Interrupt', exact: true }).click(),
  ]);

  // With no sessions at all, the empty list offers the way to start one, and Create stays on screen.
  sessions = [];
  await page.reload();
  await page.getByRole('button', { name: 'New session' }).click();
  const create = page.getByRole('button', { name: 'Create Session' });
  const box = await create.boundingBox();
  assert.ok(box.y >= 0 && box.y + box.height <= 900, `Create Session at y=${box.y}`);
  assert.deepEqual(errors, []);
});
