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
  app.get('/session', (_req, reply) => reply.type('text/html').send(index.replace('<script type="module" src="/app/app.mjs"></script>', `<script type="module">
    import { h, render } from 'preact';
    import { isAuthenticated } from '/app/state.mjs';
    import { AgentSessionDetailPage } from '/pages/agent-session-detail.mjs';
    isAuthenticated.value = true;
    render(h('main', { class: 'main' }, h(AgentSessionDetailPage, { id: 'a1', provider: 'claude' })), document.getElementById('app'));
  </script>`)));
  app.get('/api/claude/sessions', (_req, reply) => (sessions ? { sessions } : reply.code(500).send({ error: 'down' })));
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
  // Row meta reads in secondary grey, not muted.
  assert.equal(await rows.first().locator('.agent-rail-row-meta').first().evaluate((el) => getComputedStyle(el).color), 'rgb(180, 180, 198)');
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


  // An approval lists every answer in one compact card; composer tools are labelled.
  await rows.nth(1).locator('.agent-rail-row-main').click();
  const answers = page.locator('.control-row-primary .ctrl-btn');
  await answers.first().waitFor();
  // Answers read as one menu: equal-width rows stacked in order; a long label may wrap inside its row.
  const boxes = await answers.evaluateAll((els) => els.map((el) => {
    const { top, width, height } = el.getBoundingClientRect();
    return { top, width: Math.round(width), height, clipped: el.scrollWidth > el.clientWidth };
  }));
  assert.equal(new Set(boxes.map((b) => b.width)).size, 1, `answer widths ${boxes.map((b) => b.width)}`);
  // A compact card, not a full-width slab: Yes is tinted green text, No a red outline with light-red text.
  assert.ok(boxes[0].width <= 560, `answers ${boxes[0].width}px wide`);
  const colour = (i, prop) => answers.nth(i).evaluate((el, p) => getComputedStyle(el)[p], prop);
  assert.equal(await colour(0, 'color'), 'rgb(185, 228, 187)', 'Yes reads as light text on its green tint');
  assert.deepEqual([await colour(2, 'color'), await colour(2, 'backgroundColor')], ['rgb(255, 138, 128)', 'rgb(22, 33, 62)']);
  assert.ok(boxes.every((b, i) => i === 0 || b.top > boxes[i - 1].top), 'answers stack in order');
  // At least the 44px tap target and never clipped. In the 560px card a long label may wrap
  // inside its row, depending on the font; the card cap matters more than one-line labels.
  assert.ok(boxes.every((b) => Math.round(b.height) >= 44 && !b.clipped), `answer heights ${boxes.map((b) => b.height)}`);
  assert.equal(await answers.nth(2).innerText(), 'No, and tell Claude what to do differently (esc)');
  // The terminal no longer repeats the menu the bar is showing.
  await page.locator('.terminal').getByText('pane text').waitFor();
  // The pending command runs straight into its question; raw terminal keys sit below the composer.
  assert.ok((await page.locator('.terminal-keys > summary').boundingBox()).height >= 36, 'Terminal keys toggle is a full control-height target');
  const [term, question, keys, compose] = await Promise.all(['.terminal', '.approval-prompt-title', '.terminal-keys', '.control-row-compose'].map((sel) => page.locator(sel).first().boundingBox()));
  assert.ok(question.y - (term.y + term.height) < 16 && keys.y > compose.y, `question ${question.y - (term.y + term.height)}px below the terminal; keys at ${keys.y}, composer at ${compose.y}`);
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
  // A failed load shows the error, and the header's New session stays the primary action.
  sessions = null;
  await page.reload();
  await page.getByRole('button', { name: 'Retry' }).waitFor();
  assert.equal(await page.locator('.agents-desktop-toolbar').getByRole('button', { name: 'New session' }).evaluate((el) => el.classList.contains('btn-primary')), true);

  sessions = [];
  // The empty state carries the one New session; the toolbar does not repeat it. Wait for the
  // settled state: the first render (before the load starts) already shows the empty state, then
  // loading briefly brings the toolbar button back, so a single read can race.
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/api/claude/sessions')),
    page.reload(),
  ]);
  await page.locator('.empty-state').getByRole('button', { name: 'New session' }).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('.agents-desktop-toolbar button')].some((b) => b.textContent.trim() === 'New session'));
  await page.locator('.empty-state').getByRole('button', { name: 'New session' }).click();
  const create = page.getByRole('button', { name: 'Create Session' });
  const box = await create.boundingBox();
  assert.ok(box.y >= 0 && box.y + box.height <= 900, `Create Session at y=${box.y}`);
  // Page titles share one style across pages.
  assert.equal(await page.locator('h1').first().evaluate((el) => getComputedStyle(el).fontSize), '18px');
  // On a phone the keys stay above the sticky, safe-area-padded control bar.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await phone.goto(`${origin}/session`);
  await phone.locator('.terminal-keys').waitFor();
  const [phoneKeys, phoneBar] = await Promise.all(['.terminal-keys', '.claude-control-bar'].map((sel) => phone.locator(sel).boundingBox()));
  assert.ok((await phone.locator('.terminal-keys > summary').boundingBox()).height >= 36, 'phone Terminal keys toggle is a full control-height target');
  assert.ok(phoneKeys.y + phoneKeys.height <= phoneBar.y + 1, `phone keys end at ${phoneKeys.y + phoneKeys.height}, bar starts at ${phoneBar.y}`);
  await phone.close();
  // A single session reads at a comfortable width on a wide screen, centred.
  await page.goto(`${origin}/session`);
  const single = page.locator('.claude-session-page');
  await single.locator('.terminal').waitFor();
  // The focused transcript keeps a thin but visible outline (at least 3:1 against its panel tone).
  await single.locator('.terminal').focus();
  assert.deepEqual(await single.locator('.terminal').evaluate((el) => [getComputedStyle(el).outlineWidth, getComputedStyle(el).outlineColor, getComputedStyle(el).backgroundColor]), ['1px', 'rgba(79, 195, 247, 0.6)', 'rgb(26, 26, 46)']);
  const { x, width } = await single.boundingBox();
  assert.ok(width <= 1160 && Math.abs(x - (1440 - x - width)) <= 1, `session page at x=${x}, width=${width}`);
  // The full-height page is one panel tone, so a short transcript leaves no bare page below the controls.
  assert.equal(await single.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(26, 26, 46)');
  assert.deepEqual(errors, []);
});
