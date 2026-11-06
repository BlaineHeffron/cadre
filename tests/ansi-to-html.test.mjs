import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ansiToHtml, splitCliFooter, permissionMode } from '../public/lib/ansi-to-html.mjs';

test('truecolor diff backgrounds render, blended toward the terminal, instead of being dropped', () => {
  assert.equal(
    ansiToHtml('\x1b[48;2;34;92;43m  13 + x\x1b[0m'),
    '<span class="ansi-line" style="background:color-mix(in srgb,rgb(34,92,43) var(--ansi-line-keep),transparent);box-shadow:inset 3px 0 rgb(34,92,43)">  13 + x</span>',
  );
  assert.equal(ansiToHtml('\x1b[38;2;300;-1;7mhi'), '<span style="color:color-mix(in srgb,rgb(255,0,7) var(--ansi-keep),var(--text-primary))">hi</span>');
});

test('256-colour codes map to the xterm cube, grey ramp and named colours', () => {
  assert.equal(ansiToHtml('\x1b[38;5;246mdim'), '<span style="color:color-mix(in srgb,rgb(199,199,199) var(--ansi-keep),var(--text-primary))">dim</span>');
  // Only mid-grey text is lifted: near-black, near-white and colours keep their values.
  assert.equal(ansiToHtml('\x1b[38;2;153;153;153mhint'), '<span style="color:color-mix(in srgb,rgb(200,200,200) var(--ansi-keep),var(--text-primary))">hint</span>');
  assert.equal(ansiToHtml('\x1b[38;2;40;40;40mx'), '<span style="color:color-mix(in srgb,rgb(40,40,40) var(--ansi-keep),var(--text-primary))">x</span>');
  assert.equal(ansiToHtml('\x1b[38;2;240;240;240mx'), '<span style="color:color-mix(in srgb,rgb(240,240,240) var(--ansi-keep),var(--text-primary))">x</span>');
  assert.equal(ansiToHtml('\x1b[38;2;148;148;150mx'), '<span style="color:color-mix(in srgb,rgb(148,148,150) var(--ansi-keep),var(--text-primary))">x</span>');
  assert.equal(ansiToHtml('\x1b[48;5;196mred'), '<span class="ansi-line" style="background:color-mix(in srgb,rgb(255,0,0) var(--ansi-line-keep),transparent);box-shadow:inset 3px 0 rgb(255,0,0)">red</span>');
  assert.equal(ansiToHtml('\x1b[38;5;9mx'), '<span class="ansi-fg-bright-red">x</span>');
});

test('named and inline colours combine, and reset clears both', () => {
  assert.equal(
    ansiToHtml('\x1b[1;30;48;2;0;170;0m PASS \x1b[0m ok'),
    '<span class="ansi-bold ansi-fg-black" style="background:color-mix(in srgb,rgb(0,170,0) var(--ansi-bg-keep),transparent)"> PASS </span> ok',
  );
  assert.equal(ansiToHtml('\x1b[42;30m PASS \x1b[0m'), '<span class="ansi-fg-black ansi-bg-green"> PASS </span>');
});

test('a line of only box-drawing dashes becomes a full-width rule in its colour', () => {
  const dashes = '─'.repeat(110);
  assert.equal(ansiToHtml(`\x1b[38;5;244m${dashes}\x1b[0m\n❯ `), `<span style="color:color-mix(in srgb,rgb(192,192,192) var(--ansi-keep),var(--text-primary))"><span class="ansi-rule">${dashes}</span></span>\n❯ `);
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
    '<span class="ansi-line" style="background:color-mix(in srgb,rgb(34,92,43) var(--ansi-line-keep),transparent);box-shadow:inset 3px 0 rgb(34,92,43)">       43 + ok();</span>',
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
    'ctx\n<span class="ansi-line" style="background:color-mix(in srgb,rgb(34,92,43) var(--ansi-line-keep),transparent);box-shadow:inset 3px 0 rgb(34,92,43)">  43 + x</span>\nnext',
  );
  assert.equal(
    ansiToHtml('\x1b[48;2;0;170;0m PASS \x1b[0m tests.ts'),
    '<span style="background:color-mix(in srgb,rgb(0,170,0) var(--ansi-bg-keep),transparent)"> PASS </span> tests.ts',
  );
  // Private-use icons around dashes stay text; only the parser's own marks draw a rule.
  assert.equal(ansiToHtml(`\uE000${'─'.repeat(30)}\uE001`), `\uE000${'─'.repeat(30)}\uE001`);
});

test('the CLI\'s empty input box and its mode line at the foot of the pane are dropped; typed text stays', () => {
  const rule = `\x1b[38;5;244m${'─'.repeat(40)}\x1b[0m`;
  const mode = '  \x1b[95m⏵⏵ accept edits on\x1b[0m\x1b[38;5;246m (shift+tab to cycle)\x1b[0m';
  const foldEmptyPrompt = (text) => splitCliFooter(text).text;
  assert.deepEqual(splitCliFooter(['● Done.', '', rule, '❯ ', rule, mode].join('\n')), { text: ['● Done.', ''].join('\n'), status: [] });
  // Other footer lines move to the status strip, without their padding.
  assert.deepEqual(splitCliFooter(['● Done.', rule, '❯ ', rule, '  ? for shortcuts'].join('\n')), { text: '● Done.', status: ['? for shortcuts'] });
  // The mode the composer's button names.
  assert.equal(permissionMode(['● Done.', rule, '❯ ', rule, mode].join('\n')), 'accept edits');
  assert.equal(permissionMode('  ⏸ plan mode on (shift+tab to cycle)'), 'plan');
  assert.equal(permissionMode('● Done.\n  ? for shortcuts'), '');
  // Text typed into the box keeps it; so does a box with more than the mode hints under it.
  const typed = ['● Done.', rule, '❯ npm te', rule, mode].join('\n');
  assert.equal(foldEmptyPrompt(typed), typed);
  const earlier = [rule, '❯ ', rule, 'a', 'b', 'c'].join('\n');
  assert.deepEqual(splitCliFooter(earlier), { text: earlier, status: [] });
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
  const idle = await pane('claude-idle-empty-composer');
  assert.equal(permissionMode(idle), 'bypass permissions');
  // The rest of the line keeps its own colour codes.
  assert.deepEqual(splitCliFooter(idle).status, ['\x1b[39m\x1b[95m\x1b[37m← for agents\x1b[39m']);
  // That pane's box holds queued pastes, so nothing folds; its real footer under an empty box keeps
  // the shell count and the update warning.
  const shells = await pane('claude-795ad3c7-osc-rc-footer');
  assert.equal(splitCliFooter(shells).text, shells);
  const footer = shells.split('\n').find((line) => line.includes('⏵⏵'));
  const rule = '─'.repeat(40);
  assert.equal(permissionMode(footer), 'bypass permissions');
  const split = splitCliFooter(['● Done.', rule, '❯ ', rule, footer].join('\n'));
  assert.equal(split.text, '● Done.');
  assert.deepEqual(split.status.map(plain), ['1 shell  ✘ Auto-update failed · Run claude doctor']);
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
  // A painted prompt goes on past a blank line until its background is reset, on the blank line or
  // at the start of the next; an unpainted one (even with a truecolor 48 in its foreground) stops.
  const bg = '\x1b[38;5;246m\x1b[48;5;237m';
  const card = (text) => ansiToHtml(text).match(/<span class="ansi-prose ansi-prompt">[\s\S]*?\n<\/span>/)?.[0].replace(/<[^>]+>/g, '');
  assert.equal(card(`${bg}❯ \x1b[39mhi\n  wraps\n\x1b[49m\n  Called dueno`), '❯ hi\n  wraps\n');
  assert.equal(card(`${bg}❯ \x1b[39mhi\n\n  more\n\n\x1b[49m  Read 1 file`), '❯ hi\n\n  more\n');
  assert.equal(card('\x1b[38;2;48;5;5m❯ \x1b[39mhi\n\n  Read 1 file'), '❯ hi\n');
  // A reply right under a prompt (no blank line between) is a block of its own, not inside the card.
  assert.equal(ansiToHtml('❯ hi\n  more\n● Reply'), '<span class="ansi-prose ansi-prompt">❯ hi\n  more\n</span><span class="ansi-prose">● Reply</span>');
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

test('a real Claude Code footer: the empty box folds; mode extras, the update notice and the remote-control link become status lines', async () => {
  const { readFile } = await import('node:fs/promises');
  const pane = await readFile(new URL('./fixtures/terminal/claude-update-rc-footer.pane', import.meta.url), 'utf8');
  const { text, status } = splitCliFooter(pane.replace(/\n+$/, ''));
  // Nothing of the box is left: no rule, no empty prompt, no escape remnants.
  assert.ok(text.endsWith('Reconnected to dueno.\n'), JSON.stringify(text.slice(-60)));
  assert.doesNotMatch(ansiToHtml(text), /─{20}|❯\s*$|\]8;/);
  // Colour spans aside (their format is the theme's), each line is its text, and the link a link.
  assert.deepEqual(status.map((line) => ansiToHtml(line).replace(/<\/?span[^>]*>/g, '')), [
    '← 1 agent',
    '✔ Update installed · Restart to update',
    '<a href="https://claude.ai/code/session_00000000?from=cli" target="_blank" rel="noopener noreferrer">/rc</a>',
  ]);
});

test('OSC 8 hyperlinks become links: only http(s), one link across a wrap, other OSC sequences dropped', () => {
  const link = (url, label, params = 'id=a') => `\x1b]8;${params};${url}\x1b\\${label}\x1b]8;;\x1b\\`;
  assert.equal(ansiToHtml(`see ${link('https://x.test/a?b=1&c=2', 'docs')} now`),
    'see <a href="https://x.test/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a> now');
  // Not http(s): the label stays as text and nothing of the sequence shows.
  assert.equal(ansiToHtml(link('javascript:alert(1)', 'bad')), 'bad');
  assert.equal(ansiToHtml(link('file:///etc/passwd', 'f', '')), 'f');
  // BEL-terminated and other OSC sequences (a window title) leave no trace.
  assert.equal(ansiToHtml('\x1b]0;title\x07a\x1b]8;;https://x.test/\x07b\x1b]8;;\x07c'), 'a<a href="https://x.test/" target="_blank" rel="noopener noreferrer">b</a>c');
  // tmux ends a wrapped link at the line end and reopens it on the next: still one link.
  assert.equal(ansiToHtml(`${link('https://x.test/long', 'first half')}\n${link('https://x.test/long', 'second half')}`),
    '<a href="https://x.test/long" target="_blank" rel="noopener noreferrer">first half\nsecond half</a>');
  // A link reopened without a close continues too; different URLs stay separate links.
  assert.equal(ansiToHtml('\x1b]8;;https://x.test/a\x1b\\one\n\x1b]8;;https://x.test/a\x1b\\two\x1b]8;;https://x.test/b\x1b\\three'),
    '<a href="https://x.test/a" target="_blank" rel="noopener noreferrer">one\ntwo</a><a href="https://x.test/b" target="_blank" rel="noopener noreferrer">three</a>');
  // A link whose close is cut off by the end of the capture is closed.
  assert.equal(ansiToHtml('\x1b]8;;https://x.test/a\x1b\\cut'), '<a href="https://x.test/a" target="_blank" rel="noopener noreferrer">cut</a>');
});

test('an OSC with no terminator before the next escape loses only its ESC ] and never hangs', async () => {
  const { Worker } = await import('node:worker_threads');
  // A hang is a synchronous loop, so it runs in a worker the test can stop.
  const inputs = [
    'before \x1b]0;title \x1b[31mred\x1b[0m',
    '\x1b]8;;https://a.com \x1b[31mx\x1b[0m',
    'a \x1b]0;title\nline2 \x1b[1mbold\x1b[0m line3 \x1b]8;;https://b.test/\x1b\\B\x1b]8;;\x1b\\ tail',
    'cut \x1b]8;;https://x.test/',
  ];
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.url).then(({ ansiToHtml }) => parentPort.postMessage(workerData.inputs.map(ansiToHtml)));
  `, { eval: true, workerData: { url: new URL('../public/lib/ansi-to-html.mjs', import.meta.url).href, inputs } });
  let timer;
  const html = await Promise.race([
    new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('ansiToHtml did not return within 5s')), 5000); }),
  ]).finally(() => { clearTimeout(timer); return worker.terminate(); });
  assert.deepEqual(html, [
    'before 0;title <span class="ansi-fg-red">red</span>',
    '8;;https://a.com <span class="ansi-fg-red">x</span>',
    'a 0;title\nline2 <span class="ansi-bold">bold</span> line3 <a href="https://b.test/" target="_blank" rel="noopener noreferrer">B</a> tail',
    'cut 8;;https://x.test/',
  ]);
});
