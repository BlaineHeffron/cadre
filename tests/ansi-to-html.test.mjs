import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ansiToHtml, foldEmptyPrompt } from '../public/lib/ansi-to-html.mjs';

test('truecolor diff backgrounds render, blended toward the terminal, instead of being dropped', () => {
  assert.equal(
    ansiToHtml('\x1b[48;2;34;92;43m  13 + x\x1b[0m'),
    '<span class="ansi-line" style="background:color-mix(in srgb,rgb(34,92,43) 40%,transparent);box-shadow:inset 3px 0 rgb(34,92,43)">  13 + x</span>',
  );
  assert.equal(ansiToHtml('\x1b[38;2;300;-1;7mhi'), '<span style="color:rgb(255,0,7)">hi</span>');
});

test('256-colour codes map to the xterm cube, grey ramp and named colours', () => {
  assert.equal(ansiToHtml('\x1b[38;5;246mdim'), '<span style="color:rgb(167,167,167)">dim</span>');
  // Only mid-grey text is lifted: near-black, near-white and colours keep their values.
  assert.equal(ansiToHtml('\x1b[38;2;153;153;153mhint'), '<span style="color:rgb(171,171,171)">hint</span>');
  assert.equal(ansiToHtml('\x1b[38;2;40;40;40mx'), '<span style="color:rgb(40,40,40)">x</span>');
  assert.equal(ansiToHtml('\x1b[38;2;240;240;240mx'), '<span style="color:rgb(240,240,240)">x</span>');
  assert.equal(ansiToHtml('\x1b[38;2;148;148;150mx'), '<span style="color:rgb(148,148,150)">x</span>');
  assert.equal(ansiToHtml('\x1b[48;5;196mred'), '<span class="ansi-line" style="background:color-mix(in srgb,rgb(255,0,0) 40%,transparent);box-shadow:inset 3px 0 rgb(255,0,0)">red</span>');
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
  assert.equal(ansiToHtml(`\x1b[38;5;244m${dashes}\x1b[0m\n❯ `), `<span style="color:rgb(152,152,152)"><span class="ansi-rule">${dashes}</span></span>\n❯ `);
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

test('lists, box tables and indented code stay terminal text; later paragraphs stay prose', () => {
  // A reply that opens with a list, a table row or code under a bullet keeps its lines.
  assert.equal(ansiToHtml('⏺ - a\n  - b'), '⏺ - a\n  - b');
  assert.equal(ansiToHtml('⏺ Results:\n  │ x │ y │\n  1. first'), '<span class="ansi-prose">⏺ Results:\n</span>  │ x │ y │\n  1. first');
  assert.equal(ansiToHtml('⏺ Changed it:\n    const a = 1;'), '<span class="ansi-prose">⏺ Changed it:\n</span>    const a = 1;');
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
    '<span class="ansi-line" style="background:color-mix(in srgb,rgb(34,92,43) 40%,transparent);box-shadow:inset 3px 0 rgb(34,92,43)">       43 + ok();</span>',
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
    'ctx\n<span class="ansi-line" style="background:color-mix(in srgb,rgb(34,92,43) 40%,transparent);box-shadow:inset 3px 0 rgb(34,92,43)">  43 + x</span>\nnext',
  );
  assert.equal(
    ansiToHtml('\x1b[48;2;0;170;0m PASS \x1b[0m tests.ts'),
    '<span style="background:color-mix(in srgb,rgb(0,170,0) 75%,transparent)"> PASS </span> tests.ts',
  );
  // Private-use icons around dashes stay text; only the parser's own marks draw a rule.
  assert.equal(ansiToHtml(`\uE000${'─'.repeat(30)}\uE001`), `\uE000${'─'.repeat(30)}\uE001`);
});

test('the CLI\'s empty input box at the foot of the pane is dropped; the mode line and typed text stay', () => {
  const rule = `\x1b[38;5;244m${'─'.repeat(40)}\x1b[0m`;
  const mode = '  \x1b[95m⏵⏵ accept edits on\x1b[0m';
  assert.equal(foldEmptyPrompt(['● Done.', '', rule, '❯ ', rule, mode].join('\n')), ['● Done.', '', mode].join('\n'));
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
