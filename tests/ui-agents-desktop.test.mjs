// The real Agents page at desktop width in headless Chromium against a stubbed API.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

const demo = [
  { id: 'a1', displayName: 'first task', workDir: '/home/me/repo', tmuxSession: 'claude-a1', state: { status: 'working', reason: 'Automated delivery is queued' } },
  { id: 'b2', displayName: 'second task', workDir: '/home/me/repo', tmuxSession: 'claude-b2', state: { status: 'ready', reason: 'Waiting for input' } },
];

test('desktop Agents page shows bulk actions only for a selection, folds session extras into one menu, and starts empty with a New action', { skip: !process.env.CHROMIUM_BIN, timeout: 30000 }, async (t) => {
  let sessions = demo;
  const root = fileURLToPath(new URL('../', import.meta.url));
  const app = Fastify();
  // One hook, browser first: while it is open, its keep-alive connections hold app.close().
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); });
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
  // A session's own route, mounted under the router as the app mounts it.
  const sessionRoute = (_req, reply) => reply.type('text/html').send(index.replace('<script type="module" src="/app/app.mjs"></script>', `<script type="module">
    import { h, render } from 'preact';
    import Router from 'preact-router';
    import { isAuthenticated } from '/app/state.mjs';
    import { SessionRoute } from '/pages/agents.mjs';
    isAuthenticated.value = true;
    render(h('main', { class: 'main' }, h(Router, {}, ['claude', 'codex'].map((kind) => h(SessionRoute, { path: \`/\${kind}/:id\`, provider: kind })))), document.getElementById('app'));
  </script>`));
  app.get('/claude/:id', sessionRoute);
  app.get('/codex/:id', sessionRoute);
  let codexSessions = [];
  app.get('/api/codex/sessions', () => ({ sessions: codexSessions }));
  app.get('/api/codex/sessions/:id', (req) => ({ id: req.params.id, content: 'codex pane\n\x1b[1m•\x1b[0m \x1b[1mRan\x1b[0m npm test\n\x1b[2m  └ \x1b[0mTests: 3 passed\n\n• Done.', state: { status: 'working' }, sessionName: `codex-${req.params.id}` }));
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
  // The CLI's divider rule and a diff row span the pane, whatever its column count, without
  // horizontal overflow.
  const ruleFits = (pg) => pg.locator('.terminal').evaluate((el) => {
    const width = (sel) => Math.round(el.querySelector(sel).getBoundingClientRect().width);
    const cs = getComputedStyle(el);
    const content = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return { rule: width('.ansi-rule'), row: width('.ansi-line'), content: Math.round(content), overflow: el.scrollWidth - el.clientWidth };
  });
  const menu = 'pane text\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don\'t ask again\n  3. No, and tell Claude what to do differently (esc)';
  app.get('/api/claude/sessions/:id', (req) => ({ id: req.params.id, content: req.params.id === 'b2' ? menu : `pane text \x1b[95mviolet\x1b[0m\n● ${'The reply reads as prose. '.repeat(12)}\n\x1b[48;2;34;92;43m  43 + const added = true;\x1b[0m\n● Update(src/a.ts)\n  ⎿  Updated src/a.ts\n\x1b[48;2;122;41;54m       44 - old();\x1b[0m\n\x1b[38;5;244m${'─'.repeat(110)}\x1b[0m\n${'─'.repeat(110)}\n❯ \n${'─'.repeat(110)}\n\x1b[95m⏵⏵ accept edits on\x1b[0m`, state: req.params.id === 'b2' ? blocked : { status: 'working' }, sessionName: `claude-${req.params.id}` }));
  app.post('/api/*', () => ({ ok: true }));
  app.get('/api/*', () => ({ sessions: [] }));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
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
  // Calm states are tinted text, not a solid fill; checkboxes are a 20px target.
  assert.equal(await rows.first().locator('.status-badge').evaluate((el) => getComputedStyle(el).color), 'rgb(79, 195, 247)');
  assert.equal(Math.round((await rows.first().getByRole('checkbox').boundingBox()).width), 20);
  // Native controls draw in the dark scheme, so an unchecked box is not a white square on the rail.
  assert.equal(await rows.first().getByRole('checkbox').evaluate((el) => getComputedStyle(el).colorScheme), 'dark');

  const toolbar = page.locator('.agents-desktop-toolbar');
  // Buttons, the search box and the provider select share one control height.
  const heights = await toolbar.locator('.btn, input.input, select.input').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
  assert.ok(heights.length >= 4 && new Set(heights).size === 1, `toolbar control heights ${heights}`);
  // Until something is selected the toolbar is search, provider, Filters and an icon Refresh.
  for (const name of ['Prompt', 'Esc', 'Kill']) assert.equal(await toolbar.getByRole('button', { name, exact: true }).count(), 0, name);
  assert.equal(await toolbar.getByRole('checkbox', { name: 'Select all' }).count(), 0);
  assert.equal(await toolbar.getByRole('button', { name: 'Refresh' }).innerText(), '↻');
  // Row meta (provider, path) is 13px secondary grey; the status line reads as body text.
  const textStyle = (sel) => rows.first().locator(sel).evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).color]);
  assert.deepEqual(await textStyle('.agent-rail-row-meta'), ['13px', 'rgb(208, 208, 222)']);
  assert.deepEqual(await textStyle('.agent-rail-row-detail'), ['13px', 'rgb(224, 224, 224)']);
  // A reason that only repeats the badge ('Waiting for input' under Idle) adds no line.
  assert.equal(await rows.nth(1).locator('.agent-rail-row-detail').count(), 0);
  // With one provider listed, the rail heading names it once and rows show only the short path.
  assert.equal(await page.locator('.agents-desktop-rail-head .card-title').innerText(), 'Claude sessions');
  assert.equal(await rows.first().locator('.agent-rail-row-meta').innerText(), 'me/repo');
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
  // A compact card, not a full-width slab, in the button system: Yes is the filled primary, No a
  // secondary that never outshouts Yes.
  assert.ok(boxes[0].width <= 560, `answers ${boxes[0].width}px wide`);
  const colour = (i, prop) => answers.nth(i).evaluate((el, p) => getComputedStyle(el)[p], prop);
  assert.deepEqual([await colour(0, 'color'), await colour(0, 'backgroundColor')], ['rgb(0, 0, 0)', 'rgb(79, 195, 247)']);
  // No reads at body contrast; only its edge is red-tinted.
  assert.deepEqual([await colour(2, 'color'), await colour(2, 'backgroundColor'), await colour(2, 'borderTopColor')], ['rgb(224, 224, 224)', 'rgb(22, 33, 62)', 'rgb(152, 63, 73)']);
  // The secondary answers carry a visible edge, much lighter than the panel's rgb(42, 42, 62) hairline.
  assert.equal(await colour(1, 'borderTopColor'), 'rgb(79, 86, 107)');
  assert.ok(boxes.every((b, i) => i === 0 || b.top > boxes[i - 1].top), 'answers stack in order');
  // At least the 44px tap target and never clipped. In the 560px card a long label may wrap
  // inside its row, depending on the font; the card cap matters more than one-line labels.
  assert.ok(boxes.every((b) => Math.round(b.height) >= 44 && !b.clipped), `answer heights ${boxes.map((b) => b.height)}`);
  assert.equal(await answers.nth(2).innerText(), 'No, and tell Claude what to do differently (esc)');
  // The slash menu toggle says what it opens.
  assert.equal(await page.getByRole('button', { name: '/ Commands', exact: true }).count(), 1);
  // Composer tools are soft buttons: a faint fill, no outline. The More toggle matches.
  const soft = (el) => [getComputedStyle(el).borderTopColor, getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)'];
  assert.deepEqual(await page.getByRole('button', { name: '/ Commands', exact: true }).evaluate(soft), ['rgba(0, 0, 0, 0)', true]);
  assert.deepEqual(await page.locator('.control-row-tools > .more-menu > summary').evaluate(soft), ['rgba(0, 0, 0, 0)', true]);
  // The session header's secondary buttons use the same soft style, so the panel has two button styles.
  assert.deepEqual(await page.getByRole('button', { name: 'Rendered Transcript' }).evaluate(soft), ['rgba(0, 0, 0, 0)', true]);
  assert.deepEqual(await page.getByLabel('More session actions').evaluate(soft), ['rgba(0, 0, 0, 0)', true]);
  // The terminal no longer repeats the menu the bar is showing.
  await page.locator('.terminal').getByText('pane text').waitFor();
  // The pending command runs straight into its question; raw terminal keys sit below the composer.
  assert.ok((await page.locator('.terminal-keys > summary').boundingBox()).height >= 36, 'Terminal keys toggle is a full control-height target');
  const [term, question, keys, compose] = await Promise.all(['.terminal', '.approval-prompt-title', '.terminal-keys', '.control-row-compose'].map((sel) => page.locator(sel).first().boundingBox()));
  assert.ok(question.y - (term.y + term.height) < 16 && keys.y > compose.y, `question ${question.y - (term.y + term.height)}px below the terminal; keys at ${keys.y}, composer at ${compose.y}`);
  assert.doesNotMatch(await page.locator('.terminal').innerText(), /Do you want to proceed|2\. Yes/);
  assert.equal(await page.locator('.control-row-compose [data-placeholder]').getAttribute('data-placeholder'), 'Message the agent...', 'one composer placeholder whatever the state');
  // While answers are offered they are the only primary actions; Cycle mode and Interrupt step aside.
  for (const name of [/^(Cycle mode|Mode: )/, /^Interrupt$/]) assert.equal(await page.getByRole('button', { name }).count(), 0, String(name));
  // Composer extras wait behind one menu.
  const delay = page.getByRole('combobox', { name: 'Send delay' });
  assert.equal(await delay.isVisible(), false);
  // One overflow word in the app: the nav says More; the composer's own overflow is the ⋯ the
  // session menus use.
  assert.equal((await page.getByLabel('More composer tools').innerText()).trim(), '⋯');
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
  // The mode button names the CLI's current permission mode.
  for (const name of ['Mode: accept edits', 'Interrupt']) await page.getByRole('button', { name, exact: true }).waitFor();
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
  // A first run is guided: a named heading and the three steps to a first session, above its button.
  const empty = page.locator('.empty-state');
  assert.equal(await empty.getByRole('heading', { name: 'No agent sessions yet' }).isVisible(), true);
  assert.deepEqual(await empty.getByRole('listitem').allInnerTexts(), ['Pick a provider and model.', 'Choose the project folder.', 'Describe the task, or prompt it after launch.']);
  const [steps, action] = await Promise.all([empty.getByRole('list').boundingBox(), empty.getByRole('button', { name: 'New session' }).boundingBox()]);
  assert.ok(steps.y + steps.height <= action.y, 'the steps sit above the New session button');
  // The empty desktop list fills the page like the split view, with no card nested in its frame.
  const emptyShell = await page.locator('.agents-desktop-empty').evaluate((el) => {
    const card = el.querySelector('.empty-state');
    return { bottom: el.getBoundingClientRect().bottom, cardBorder: getComputedStyle(card).borderTopWidth };
  });
  assert.ok(emptyShell.bottom >= 860 && emptyShell.cardBorder === '0px', `empty shell ${JSON.stringify(emptyShell)}`);
  await page.waitForFunction(() => ![...document.querySelectorAll('.agents-desktop-toolbar button')].some((b) => b.textContent.trim() === 'New session'));
  await page.locator('.empty-state').getByRole('button', { name: 'New session' }).click();
  const create = page.getByRole('button', { name: 'Create session' });
  const box = await create.boundingBox();
  assert.ok(box.y >= 0 && box.y + box.height <= 900, `Create session at y=${box.y}`);
  // Page titles share one style across pages.
  assert.equal(await page.locator('h1').first().evaluate((el) => getComputedStyle(el).fontSize), '18px');
  // On a phone the keys stay above the sticky, safe-area-padded control bar.
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  phone.setDefaultTimeout(5000);
  await phone.goto(`${origin}/session`);
  await phone.locator('.terminal-keys').waitFor();
  // Rounded: the mobile viewport sometimes lays the 36px toggle out at 35.99999px (about 1 run in 4 on main).
  const summaryHeight = (await phone.locator('.terminal-keys > summary').boundingBox()).height;
  assert.ok(Math.round(summaryHeight) >= 36, `phone Terminal keys toggle is a full control-height target (${summaryHeight}px)`);
  const phoneRule = await ruleFits(phone);
  assert.ok(phoneRule.rule === phoneRule.content && phoneRule.row === phoneRule.content && phoneRule.overflow === 0, `phone rule ${JSON.stringify(phoneRule)}`);
  const [phoneKeys, phoneBar] = await Promise.all(['.terminal-keys', '.claude-control-bar'].map((sel) => phone.locator(sel).boundingBox()));
  assert.ok(phoneKeys.y + phoneKeys.height <= phoneBar.y + 1, `phone keys end at ${phoneKeys.y + phoneKeys.height}, bar starts at ${phoneBar.y}`);
  await phone.close();
  // A single session reads at a comfortable width on a wide screen, centred.
  await page.goto(`${origin}/session`);
  const single = page.locator('.claude-session-page');
  await single.locator('.terminal').waitFor();
  // The CLI's colours come from the app's palette: bright magenta is the soft violet, not raw magenta.
  assert.equal(await single.locator('.ansi-fg-bright-magenta').evaluate((el) => getComputedStyle(el).color), 'rgb(197, 179, 230)');
  // A prose reply reads in the UI font at a comfortable measure; tool output stays monospace.
  const prose = await single.locator('.ansi-prose').evaluate((el) => {
    // Every word sits on one line (each word's range has a single box) across a multi-line wrap.
    const node = [...el.childNodes].find((child) => child.nodeType === 3 && child.textContent.length > 100);
    const splitWords = [];
    for (const match of node.textContent.matchAll(/\S+/g)) {
      const range = document.createRange();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      if (range.getClientRects().length !== 1) splitWords.push(match[0]);
    }
    const lines = Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
    return [getComputedStyle(el).fontFamily === getComputedStyle(document.body).fontFamily, el.getBoundingClientRect().width <= 760, lines > 1, splitWords];
  });
  assert.deepEqual(prose, [true, true, true, []], 'prose wraps between words, never mid-word');
  // The transcript reads one step above body text on a wide screen.
  assert.equal(await single.locator('.terminal').evaluate((el) => getComputedStyle(el).fontSize), '15px');
  // A tool call sits in one quiet card: monospace, framed, its diff rows spanning the card, its
  // text exactly the terminal's for copying.
  const card = await single.locator('.ansi-tool').evaluate((el) => {
    const cs = getComputedStyle(el);
    const inner = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return [cs.fontFamily === getComputedStyle(el.closest('.terminal')).fontFamily, cs.borderTopWidth, cs.borderTopLeftRadius, Math.round(el.querySelector('.ansi-line').getBoundingClientRect().width) === Math.round(inner), el.textContent];
  });
  assert.deepEqual(card, [true, '1px', '8px', true, '● Update(src/a.ts)\n  ⎿  Updated src/a.ts\n       44 - old();\n']);
  // Code in a card is a step above the 15px transcript (mono reads small beside the sans prose),
  // on the transcript's 21px row so the pinned view still snaps to whole lines.
  assert.deepEqual(await single.locator('.ansi-tool').first().evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight]), ['16px', '21px']);
  // The CLI's empty input box and its mode line are left to the composer below, which names the mode.
  const tail = await single.locator('.terminal-body').innerText();
  assert.ok(!tail.includes('❯') && !tail.includes('accept edits on'), `pane foot: ${tail.slice(-80)}`);
  assert.equal(await single.getByRole('button', { name: 'Mode: accept edits', exact: true }).count(), 1);
  const deskRule = await ruleFits(page);
  assert.ok(deskRule.rule === deskRule.content && deskRule.row === deskRule.content && deskRule.overflow === 0, `desktop rule ${JSON.stringify(deskRule)}`);
  // The focused transcript keeps a thin visible ring (at least 3:1 against its panel tone). It is a
  // border, which the scroll fade cannot paint over, and it does not shift the layout on focus.
  const ring = (el) => { const cs = getComputedStyle(el); return [cs.borderTopWidth, cs.borderTopColor, cs.outlineStyle, cs.backgroundColor, el.getBoundingClientRect().width]; };
  const [, , , , blurredWidth] = await single.locator('.terminal').evaluate(ring);
  await single.locator('.terminal').focus();
  assert.deepEqual(await single.locator('.terminal').evaluate(ring), ['1px', 'rgba(79, 195, 247, 0.6)', 'none', 'rgb(26, 26, 46)', blurredWidth]);
  // The ring is the transcript's only frame: the header and control bar drop their lines beside it.
  assert.deepEqual(await single.evaluate((el) => [getComputedStyle(el.querySelector('.claude-session-header')).borderBottomColor, getComputedStyle(el.querySelector('.claude-control-bar')).borderTopColor]), ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);
  const { x, width } = await single.boundingBox();
  assert.ok(width <= 1160 && Math.abs(x - (1440 - x - width)) <= 1, `session page at x=${x}, width=${width}`);
  // The full-height page is one panel tone, so a short transcript leaves no bare page below the controls.
  assert.equal(await single.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(26, 26, 46)');
  // On desktop a session's own route is the Agents split view with that session selected, and the
  // panel's prev/next step through the list beside it.
  sessions = demo;
  codexSessions = [{ id: 'c3', displayName: 'third task', workDir: '/home/me/repo', state: { status: 'working' } }];
  await page.goto(`${origin}/claude/b2`);
  const panelTitle = page.locator('.agent-session-page-embedded .session-title');
  const shows = (title) => page.waitForFunction((t) => document.querySelector('.agent-session-page-embedded .session-title')?.textContent === t, title);
  await shows('claude-b2');
  assert.equal(await page.locator('.agent-rail-row').count(), 3);
  // Mixed providers: each row names its own.
  assert.equal(await page.locator('.agents-desktop-rail-head .card-title').innerText(), 'Sessions');
  assert.match(await page.locator('.agent-rail-row', { hasText: 'third task' }).locator('.agent-rail-row-meta').innerText(), /^Codex\s+me\/repo$/);
  // The embedded session is the same one surface: below a short transcript it keeps the transcript's tone.
  assert.equal(await page.locator('.agent-session-page-embedded').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(26, 26, 46)');
  const historyLength = await page.evaluate(() => history.length);
  // Next wraps from the last Claude session to the Codex one, across providers.
  await page.locator('.agent-session-page-embedded').getByRole('button', { name: 'Next agent' }).click();
  await shows('codex-c3');
  // Codex's own tool calls (`• Ran …` and the └ output under it) sit in the same cards.
  assert.equal(await page.locator('.agent-session-page-embedded .ansi-tool').textContent(), '• Ran npm test\n  └ Tests: 3 passed\n');
  // The address follows the shown session, from the arrows or a list click, so a reload or
  // shared link opens it again.
  assert.equal(new URL(page.url()).pathname, '/codex/c3');
  // The router knows the new address too: routing back to the first session shows it again.
  await page.evaluate(() => import('preact-router').then(({ route }) => route('/claude/b2')));
  await page.waitForFunction(() => document.querySelector('.agent-session-page-embedded .session-title')?.textContent === 'claude-b2');
  await page.locator('.agent-rail-row').filter({ hasText: 'first task' }).locator('.agent-rail-row-main').click();
  await shows('claude-a1');
  assert.equal(new URL(page.url()).pathname, '/claude/a1');
  // Stepping replaces the address rather than stacking history entries: the only new entry is
  // the test's own route() push above.
  assert.equal(await page.evaluate(() => history.length), historyLength + 1);
  assert.equal(await panelTitle.count(), 1);
  // A phone keeps the full-screen session page.
  const phoneRoute = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await phoneRoute.goto(`${origin}/claude/b2`);
  await phoneRoute.getByRole('link', { name: 'Back to agents' }).waitFor();
  assert.equal(await phoneRoute.locator('.agent-rail-row').count(), 0);
  await phoneRoute.close();
  assert.deepEqual(errors, []);
});
