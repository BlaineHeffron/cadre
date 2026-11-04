import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ansiToHtml } from '../public/lib/ansi-to-html.mjs';

test('truecolor diff backgrounds render, blended toward the terminal, instead of being dropped', () => {
  assert.equal(
    ansiToHtml('\x1b[48;2;34;92;43m  13 + x\x1b[0m'),
    '<span style="background:color-mix(in srgb,rgb(34,92,43) 60%,transparent)">  13 + x</span>',
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
  assert.equal(ansiToHtml('\x1b[48;5;196mred'), '<span style="background:color-mix(in srgb,rgb(255,0,0) 60%,transparent)">red</span>');
  assert.equal(ansiToHtml('\x1b[38;5;9mx'), '<span class="ansi-fg-bright-red">x</span>');
});

test('named and inline colours combine, and reset clears both', () => {
  assert.equal(
    ansiToHtml('\x1b[1;30;48;2;0;170;0m PASS \x1b[0m ok'),
    '<span class="ansi-bold ansi-fg-black" style="background:color-mix(in srgb,rgb(0,170,0) 60%,transparent)"> PASS </span> ok',
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
