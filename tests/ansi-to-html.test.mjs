import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ansiToHtml, foldEmptyPrompt, permissionMode } from '../public/lib/ansi-to-html.mjs';

test('truecolor diff backgrounds render, blended toward the terminal, instead of being dropped', () => {
  assert.equal(
    ansiToHtml('\x1b[48;2;34;92;43m  13 + x\x1b[0m'),
    '<span class="ansi-line" style="background:color-mix(in srgb,rgb(34,92,43) 34%,transparent);box-shadow:inset 3px 0 rgb(34,92,43)">  13 + x</span>',
  );
  assert.equal(ansiToHtml('\x1b[38;2;300;-1;7mhi'), '<span style="color:rgb(255,0,7)">hi</span>');
});

test('256-colour codes map to the xterm cube, grey ramp and named colours', () => {
  assert.equal(ansiToHtml('\x1b[38;5;246mdim'), '<span style="color:rgb(199,199,199)">dim</span>');
  // Only mid-grey text is lifted: near-black, near-white and colours keep their values.
  assert.equal(ansiToHtml('\x1b[38;2;153;153;153mhint'), '<span style="color:rgb(200,200,200)">hint</span>');
  assert.equal(ansiToHtml('\x1b[38;2;40;40;40mx'), '<span style="color:rgb(40,40,40)">x</span>');
  assert.equal(ansiToHtml('\x1b[38;2;240;240;240mx'), '<span style="color:rgb(240,240,240)">x</span>');
  assert.equal(ansiToHtml('\x1b[38;2;148;148;150mx'), '<span style="color:rgb(148,148,150)">x</span>');
  assert.equal(ansiToHtml('\x1b[48;5;196mred'), '<span class="ansi-line" style="background:color-mix(in srgb,rgb(255,0,0) 34%,transparent);box-shadow:inset 3px 0 rgb(255,0,0)">red</span>');
  assert.equal(ansiToHtml('\x1b[38;5;9mx'), '<span class="ansi-fg-bright-red">x</span>');
});

test('named and inline colours combine, and reset clears both', () => {
  assert.equal(
    ansiToHtml('\x1b[1;30;48;2;0;170;0m PASS \x1b[0m ok'),
    '<span class="ansi-bold ansi-fg-black" style="background:color-mix(in srgb,rgb(0,170,0) 75%,transparent)"> PASS </span> ok',
  );
  assert.equal(ansiToHtml('\x1b[42;30m PASS \x1b[0m'), '<span class="ansi-fg-black ansi-bg-green"> PASS </span>');
});

test('a line of only box-drawing dashes becomes a full-width rule in its colour', () => {
  const dashes = '─'.repeat(110);
  assert.equal(ansiToHtml(`\x1b[38;5;244m${dashes}\x1b[0m\n❯ `), `<span style="color:rgb(192,192,192)"><span class="ansi-rule">${dashes}</span></span>\n❯ `);
  assert.equal(ansiToHtml(`above\n${dashes}\nbelow`), `above\n<span class="ansi-rule">${dashes}</span>\nbelow`);
  // Short runs and dashes after text on the same line stay text, coloured or not.
  assert.equal(ansiToHtml('──── title ────'), '──── title ────');
  assert.equal(ansiToHtml(`x ${dashes}`), `x ${dashes}`);
  assert.equal(ansiToHtml(`x \x1b[90m${'─'.repeat(30)}`), `x <span class="ansi-fg-bright-black">${'─'.repeat(30)}</span>`);
});

test('a prose reply reflows as one block; tool calls and their output stay out of it', () => {
  const reply = ['\x1b[37m●\x1b[0m Pagination is in place.', '  The three new tests pass.', '', '● Bash(npm test)', '  ⎿  Waiting…', '⏺ Done.'].join('\n');
  assert.equal(ansiToHtml(reply), [
    '<span class="ansi-prose"><span class="ansi-fg-white">●</span> Pagination is in place.',
    '  The three new tests pass.',
    '</span>',
    '<span class="ansi-tool">● Bash(npm test)',
    '  ⎿  Waiting…',
    '</span><span class="ansi-prose">⏺ Done.</span>',
  ].join('\n'));
  // A ⎿ result line never joins the reply above it.
  assert.equal(ansiToHtml('● Ran it.\n  ⎿  ok'), '<span class="ansi-prose">● Ran it.\n</span>  ⎿  ok');
});

test('box tables and indented code stay terminal text; list items and later paragraphs stay prose', () => {
  // A reply that opens with a list keeps its lines; a table row or code under a bullet stays
  // terminal text, and the reply goes on past it: a list item after it is prose.
  assert.equal(ansiToHtml('⏺ - a\n  - b'), '⏺ - a\n  - b');
  assert.equal(ansiToHtml('⏺ Results:\n  │ x │ y │\n  1. first'), '<span class="ansi-prose">⏺ Results:\n</span>  │ x │ y │\n<span class="ansi-prose ansi-item">  1. first</span>');
  assert.equal(ansiToHtml('⏺ Changed it:\n    const a = 1;'), '<span class="ansi-prose">⏺ Changed it:\n</span>    const a = 1;');
  assert.equal(ansiToHtml('⏺ Changed it:\n    const a = 1;\n\n  Then this.'), '<span class="ansi-prose">⏺ Changed it:\n</span>    const a = 1;\n\n<span class="ansi-prose ansi-prose-more">  Then this.</span>');
  // Each list item is a block with the lines it wrapped onto; a nested item is a step in.
  assert.equal(
    ansiToHtml('⏺ Steps:\n  1. one\n     wraps\n    - nested\n  2. two'),
    '<span class="ansi-prose">⏺ Steps:\n</span><span class="ansi-prose ansi-item">  1. one\n     wraps\n</span><span class="ansi-prose ansi-item ansi-nested">    - nested\n</span><span class="ansi-prose ansi-item">  2. two</span>',
  );
  // A second paragraph of the same reply is prose too; a tool call after it ends the reply.
  assert.equal(
    ansiToHtml('⏺ First paragraph\n  wraps here.\n\n  Second paragraph.\n\n⏺ Bash(ls)\n\n  not prose'),
    '<span class="ansi-prose">⏺ First paragraph\n  wraps here.\n</span>\n<span class="ansi-prose ansi-prose-more">  Second paragraph.\n</span>\n<span class="ansi-tool">⏺ Bash(ls)\n</span>\n  not prose',
  );
});

test('a tool call and the result, output and diff rows under it form one card with the text unchanged', () => {
  const diff = '\x1b[48;2;34;92;43m       43 + ok();\x1b[0m';
  const text = ['● Update(src/a.ts)', '  ⎿  Updated src/a.ts', '       42   keep();', diff, '● Bash(npm test', '      -- a)', '  ⎿  ok', '', '● All done.'].join('\n');
  const html = ansiToHtml(text);
  assert.equal(html, [
    '<span class="ansi-tool">● Update(src/a.ts)',
    '  ⎿  Updated src/a.ts',
    '       42   keep();',
    '<span class="ansi-line" style="background:color-mix(in srgb,rgb(34,92,43) 34%,transparent);box-shadow:inset 3px 0 rgb(34,92,43)">       43 + ok();</span>',
    '</span><span class="ansi-tool">● Bash(npm test',
    '      -- a)',
    '  ⎿  ok',
    '</span>',
    '<span class="ansi-prose">● All done.</span>',
  ].join('\n'));
  // Copying the transcript gives back exactly the terminal text.
  assert.equal(html.replace(/<[^>]+>/g, ''), text.replace(/\x1b\[[0-9;]*m/g, ''));
  // A call still streaming closes at the end of the text, so every render is complete.
  assert.equal(ansiToHtml('● Bash(ls)\n  ⎿  Running…'), '<span class="ansi-tool">● Bash(ls)\n  ⎿  Running…</span>');
  // Stray card marks in the pane are dropped like the other marks.
  assert.equal(ansiToHtml('a\x0eb\x0fc'), 'abc');
});

test('private-use icons and stray control characters never open or close a prose block', () => {
  assert.equal(ansiToHtml(' ~/repo \n⏺ Done.'), ' ~/repo \n<span class="ansi-prose">⏺ Done.</span>');
  assert.equal(ansiToHtml('a\x02b\x03c\x04'), 'abc');
});

test('a line in one background colour spans the pane; badges inside a line do not', () => {
  assert.equal(
    ansiToHtml('ctx\n\x1b[48;2;34;92;43m  43 + x\x1b[0m\nnext'),
    'ctx\n<span class="ansi-line" style="background:color-mix(in srgb,rgb(34,92,43) 34%,transparent);box-shadow:inset 3px 0 rgb(34,92,43)">  43 + x</span>\nnext',
  );
  assert.equal(
    ansiToHtml('\x1b[48;2;0;170;0m PASS \x1b[0m tests.ts'),
    '<span style="background:color-mix(in srgb,rgb(0,170,0) 75%,transparent)"> PASS </span> tests.ts',
  );
  // Private-use icons around dashes stay text; only the parser's own marks draw a rule.
  assert.equal(ansiToHtml(`\uE000${'─'.repeat(30)}\uE001`), `\uE000${'─'.repeat(30)}\uE001`);
});

test('the CLI\'s empty input box and its mode line at the foot of the pane are dropped; typed text stays', () => {
  const rule = `\x1b[38;5;244m${'─'.repeat(40)}\x1b[0m`;
  const mode = '  \x1b[95m⏵⏵ accept edits on\x1b[0m\x1b[38;5;246m (shift+tab to cycle)\x1b[0m';
  assert.equal(foldEmptyPrompt(['● Done.', '', rule, '❯ ', rule, mode].join('\n')), ['● Done.', ''].join('\n'));
  // Other footer lines stay.
  assert.equal(foldEmptyPrompt(['● Done.', rule, '❯ ', rule, '  ? for shortcuts'].join('\n')), ['● Done.', '  ? for shortcuts'].join('\n'));
  // The mode the composer's button names.
  assert.equal(permissionMode(['● Done.', rule, '❯ ', rule, mode].join('\n')), 'accept edits');
  assert.equal(permissionMode('  ⏸ plan mode on (shift+tab to cycle)'), 'plan');
  assert.equal(permissionMode('● Done.\n  ? for shortcuts'), '');
  // Text typed into the box keeps it; so does a box with more than the mode hints under it.
  const typed = ['● Done.', rule, '❯ npm te', rule, mode].join('\n');
  assert.equal(foldEmptyPrompt(typed), typed);
  const earlier = [rule, '❯ ', rule, 'a', 'b', 'c'].join('\n');
  assert.equal(foldEmptyPrompt(earlier), earlier);
  assert.equal(foldEmptyPrompt('❯ '), '❯ ');
});

test('Codex tool calls (• Ran, • Explored and their └ output) form cards too; its prose does not', async () => {
  const { readFile } = await import('node:fs/promises');
  const pane = await readFile(new URL('./fixtures/session-state/panes/codex-e5ea5b75-background-terminal.pane', import.meta.url), 'utf8');
  // The first line of each card.
  const cards = ansiToHtml(pane).split('<span class="ansi-tool">').slice(1).map((html) => html.replace(/<[^>]+>/g, '').split('\n')[0]);
  assert.deepEqual(cards.map((line) => line.slice(0, 8)), ['• Explor', '• Ran gi']);
  assert.equal(ansiToHtml('• I checked it.\n  All good.'), '• I checked it.\n  All good.');
  // A reply that happens to open with a call verb has no result under it, so it stays text.
  assert.equal(ansiToHtml('• Ran the suite; all green.\n  Nothing else changed.'), '• Ran the suite; all green.\n  Nothing else changed.');
  // A long command wrapped onto │ lines keeps its └ output in the same card.
  assert.equal(ansiToHtml('• Ran npm test --\n  │ --watch=false\n  └ ok'), '<span class="ansi-tool">• Ran npm test --\n  │ --watch=false\n  └ ok</span>');
});

test('the live spinner line takes the accent colour; a finished "Worked for" line keeps its own', () => {
  const coral = (text) => `\x1b[38;5;174m${text}\x1b[0m`;
  assert.equal(ansiToHtml(`${coral('✶')} ${coral('Drafting… (52s · ↓ 2.4k tokens · esc to interrupt)')}`),
    '<span class="ansi-prose"><span class="ansi-fg-cyan">✶ Drafting… (52s · ↓ 2.4k tokens · esc to interrupt)</span></span>');
  assert.equal(ansiToHtml('\x1b[37m✻\x1b[0m \x1b[37mWorked for 18s\x1b[0m'), '<span class="ansi-prose"><span class="ansi-fg-white">✻</span> <span class="ansi-fg-white">Worked for 18s</span></span>');
  assert.equal(ansiToHtml('✶ Thinking… (esc to interrupt)'), '<span class="ansi-prose"><span class="ansi-fg-cyan">✶ Thinking… (esc to interrupt)</span></span>');
  // Prose or a list item that merely ends a word with an ellipsis is not a spinner.
  assert.equal(ansiToHtml('Loading… the data'), 'Loading… the data');
  assert.equal(ansiToHtml('\x1b[33m* Note… this is a list item\x1b[0m'), '<span class="ansi-fg-yellow">* Note… this is a list item</span>');
});

test('real CLI footers keep everything but the mode, colours and all', async () => {
  const { readFile } = await import('node:fs/promises');
  const pane = (name) => readFile(new URL(`./fixtures/session-state/panes/${name}.pane`, import.meta.url), 'utf8');
  const plain = (text) => text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x1b]*\x1b\\/g, '');
  const foot = (text) => plain(foldEmptyPrompt(text)).split('\n').filter((line) => line.trim()).slice(-1)[0].trim();
  const idle = await pane('claude-idle-empty-composer');
  assert.equal(permissionMode(idle), 'bypass permissions');
  assert.equal(foot(idle), '← for agents');
  // The rest of the line keeps its own colour codes.
  assert.match(foldEmptyPrompt(idle), /\x1b\[37m← for agents\x1b\[39m$/m);
  // That pane's box holds queued pastes, so nothing folds; its real footer under an empty box keeps
  // the shell count and the update warning.
  const shells = await pane('claude-795ad3c7-osc-rc-footer');
  assert.equal(foldEmptyPrompt(shells), shells);
  const footer = shells.split('\n').find((line) => line.includes('⏵⏵'));
  const rule = '─'.repeat(40);
  assert.equal(permissionMode(footer), 'bypass permissions');
  assert.equal(plain(foldEmptyPrompt(['● Done.', rule, '❯ ', rule, footer].join('\n'))), '● Done.\n  1 shell  ✘ Auto-update failed · Run claude doctor');
});

test('inline code in a prose reply renders as code and keeps its backticks for copying; elsewhere it stays text', () => {
  const html = ansiToHtml('● `GET /notes` now accepts `limit`.');
  assert.equal(html, '<span class="ansi-prose">● <code class="ansi-code"><span class="ansi-tick">`</span>GET /notes<span class="ansi-tick">`</span></code> now accepts <code class="ansi-code"><span class="ansi-tick">`</span>limit<span class="ansi-tick">`</span></code>.</span>');
  assert.equal(html.replace(/<[^>]+>/g, ''), '● `GET /notes` now accepts `limit`.');
  // A span the CLI hard-wrapped onto the next line still pairs, and so does everything after it.
  const wrapped = ansiToHtml('● Set `a` and the `long\n  value` then run the next `step` now.');
  assert.deepEqual([...wrapped.matchAll(/<code class="ansi-code">(.*?)<\/code>/gs)].map((m) => m[1].replace(/<[^>]+>/g, '')), ['`a`', '`long\n  value`', '`step`']);
  // Triple backticks are not inline code.
  assert.equal(ansiToHtml('● Use ```js``` here.'), '<span class="ansi-prose">● Use ```js``` here.</span>');
  // Tool output and terminal text keep their backticks as typed.
  assert.equal(ansiToHtml('  echo `date`'), '  echo `date`');
});

test('the user prompt and status lines read as prose; menu choices, drafts and tool calls stay terminal text', () => {
  // A prompt keeps the user's own line breaks (the class sets pre-wrap) and its text is unchanged.
  const prompt = ansiToHtml('❯ run these in order\n  npm ci\n  npm test\n  npm run check');
  assert.equal(prompt, '<span class="ansi-prose ansi-prompt">❯ run these in order\n  npm ci\n  npm test\n  npm run check</span>');
  assert.equal(ansiToHtml('❯ 1. Yes'), '❯ 1. Yes');
  assert.equal(ansiToHtml('❯ '), '❯ ');
  // A draft typed into the input box (under its ─ rule) stays terminal text.
  const rule = '─'.repeat(30);
  assert.equal(ansiToHtml(`${rule}\n❯ npm te\n${rule}`).replace(/<[^>]+>/g, ''), `${rule}\n❯ npm te\n${rule}`);
  assert.doesNotMatch(ansiToHtml(`${rule}\n❯ npm te\n${rule}`), /ansi-prose/);
  assert.equal(ansiToHtml('· 2 shells'), '· 2 shells');
  // A status line is a block of its own; the indented line after it is not folded in.
  assert.equal(ansiToHtml('✻ Worked for 18s\n\n  ⏵⏵ note'), '<span class="ansi-prose">✻ Worked for 18s\n</span>\n  ⏵⏵ note');
});
