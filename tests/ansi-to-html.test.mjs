import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ansiToHtml } from '../public/lib/ansi-to-html.mjs';

test('truecolor diff backgrounds render, blended toward the terminal, instead of being dropped', () => {
  assert.equal(
    ansiToHtml('\x1b[48;2;34;92;43m  13 + x\x1b[0m'),
    '<span class="ansi-line" style="background:color-mix(in srgb,rgb(34,92,43) 75%,transparent)">  13 + x</span>',
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
  assert.equal(ansiToHtml('\x1b[48;5;196mred'), '<span class="ansi-line" style="background:color-mix(in srgb,rgb(255,0,0) 75%,transparent)">red</span>');
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

test('a prose reply reflows as one block; tool calls and their output stay terminal text', () => {
  const reply = ['\x1b[37m●\x1b[0m Pagination is in place.', '  The three new tests pass.', '', '● Bash(npm test)', '  ⎿  Waiting…', '⏺ Done.'].join('\n');
  assert.equal(ansiToHtml(reply), [
    '<span class="ansi-prose"><span class="ansi-fg-white">●</span> Pagination is in place.',
    '  The three new tests pass.',
    '</span>',
    '● Bash(npm test)',
    '  ⎿  Waiting…',
    '<span class="ansi-prose">⏺ Done.</span>',
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
    '<span class="ansi-prose">⏺ First paragraph\n  wraps here.\n</span>\n<span class="ansi-prose ansi-prose-more">  Second paragraph.\n</span>\n⏺ Bash(ls)\n\n  not prose',
  );
});

test('private-use icons and stray control characters never open or close a prose block', () => {
  assert.equal(ansiToHtml(' ~/repo \n⏺ Done.'), ' ~/repo \n<span class="ansi-prose">⏺ Done.</span>');
  assert.equal(ansiToHtml('a\x02b\x03c\x04'), 'abc');
});

test('a line in one background colour spans the pane; badges inside a line do not', () => {
  assert.equal(
    ansiToHtml('ctx\n\x1b[48;2;34;92;43m  43 + x\x1b[0m\nnext'),
    'ctx\n<span class="ansi-line" style="background:color-mix(in srgb,rgb(34,92,43) 75%,transparent)">  43 + x</span>\nnext',
  );
  assert.equal(
    ansiToHtml('\x1b[48;2;0;170;0m PASS \x1b[0m tests.ts'),
    '<span style="background:color-mix(in srgb,rgb(0,170,0) 75%,transparent)"> PASS </span> tests.ts',
  );
  // Private-use icons around dashes stay text; only the parser's own marks draw a rule.
  assert.equal(ansiToHtml(`\uE000${'─'.repeat(30)}\uE001`), `\uE000${'─'.repeat(30)}\uE001`);
});
