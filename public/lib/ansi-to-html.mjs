/**
 * Lightweight ANSI SGR escape code → HTML converter.
 * Maps standard terminal colors to CSS classes for theming.
 */

const COLOR_NAMES = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
];

// Escape HTML entities
function esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Convert ANSI-escaped text to HTML with CSS classes.
 * Supports: bold, dim, italic, underline, strikethrough, 8/16/256-color and truecolor fg/bg, reset.
 * @param {string} text - raw text with ANSI escape codes
 * @returns {string} HTML string
 */
export function ansiToHtml(text) {
  if (!text) return '';
  // The marks below are non-printing control characters (never Nerd Font icons from the
  // private-use area); any already in the pane are dropped first.
  text = text.replace(/[\x02-\x07\x0e-\x12]/g, '');
  // A whole line of only box-drawing dashes (colour codes aside) is the CLI's divider at its own
  // column count. Its dashes are marked and drawn as a full-width rule in their colour, so it
  // never stops short of the pane edge; the dashes stay in the DOM for copying.
  text = text.replace(/^((?:\x1b\[[0-9;]*m)*)(─{20,})((?:\x1b\[[0-9;]*m)*)$/gm, '$1\x06$2\x07$3');
  // A whole line in one background colour (a diff row the CLI padded to its own width) spans the
  // pane too, so hunk bars never stop mid-panel.
  text = text.replace(/^(?=\x1b\[[0-9;]*48;[0-9;]*m[^\x1b\n]*(?:\x1b\[0?m)?$)/gm, '\x05');
  // The CLI's live spinner line (`✶ Drafting… (52s · esc to interrupt)`) is a working status, so it
  // takes the accent the Working badge uses rather than the CLI's own coral. It needs the timer or
  // the interrupt hint after the verb, so a list item like `* Note… text` keeps its own colours.
  text = text.replace(/^(?:\x1b\[[0-9;]*m)*[✻✶✳✢✽*·](?:\x1b\[[0-9;]*m)* (?:\x1b\[[0-9;]*m)*[A-Z][a-z-]*…(?:\x1b\[[0-9;]*m)* \((?:\d+[sm]\b|esc to interrupt).*$/gm,
    (line) => `\x1b[36m${line.replace(SGR, '')}\x1b[0m`);
  text = markTools(markProse(text));

  const parts = [];
  let current = { bold: false, dim: false, italic: false, underline: false, strike: false, fg: null, bg: null };
  let i = 0;
  let buf = '';
  let fullLine = false;
  let inProse = false;

  function flushBuf() {
    if (!buf) return;
    const line = fullLine && current.bg;
    const classes = [buildClasses(current), line ? 'ansi-line' : ''].filter(Boolean).join(' ');
    fullLine = false;
    // 256-colour and truecolor values have no class; they render inline.
    // Backgrounds are blended toward the terminal so they tint rather than glare. Whole diff rows
    // get a lighter tint and keep the full colour as a gutter bar. Mid-grey text (the CLI's dim
    // hints and rules) is lifted two thirds of the way to the body text so it stays readable.
    const style = [['color', current.fg], ['background', current.bg]]
      .filter(([, value]) => value?.startsWith('rgb('))
      .map(([prop, value]) => (prop === 'color' ? `color:${liftGrey(value)}`
        : line ? `background:color-mix(in srgb,${value} 34%,transparent);box-shadow:inset 3px 0 ${value}`
          : `background:color-mix(in srgb,${value} 75%,transparent)`))
      .join(';');
    const attrs = `${classes ? ` class="${classes}"` : ''}${style ? ` style="${style}"` : ''}`;
    let html = esc(buf).replace(/\x06(─+)\x07/g, '<span class="ansi-rule">$1</span>');
    // Inline `code` in a prose reply reads as code; the backticks stay in the DOM (unseen) for copying.
    // A span may wrap across the CLI's hard line breaks; fenced ``` runs are not inline code.
    if (inProse) html = html.replace(/(?<!`)`([^`]+)`(?!`)/g, '<code class="ansi-code"><span class="ansi-tick">`</span>$1<span class="ansi-tick">`</span></code>');
    parts.push(attrs ? `<span${attrs}>${html}</span>` : html);
    buf = '';
  }

  while (i < text.length) {
    if (text[i] === '\x05') {
      flushBuf();
      fullLine = true;
      i++;
      continue;
    }
    // Prose and tool-card blocks open and close at the top level, between the self-contained colour spans.
    if (BLOCK_MARKS[text[i]]) {
      flushBuf();
      if ('\x02\x04\x10\x11\x12'.includes(text[i])) inProse = true;
      else if (text[i] === '\x03') inProse = false;
      parts.push(BLOCK_MARKS[text[i]]);
      i++;
      continue;
    }
    // Match ESC[ ... m  (SGR sequence)
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      const end = text.indexOf('m', i + 2);
      if (end !== -1) {
        flushBuf();
        const codes = text.slice(i + 2, end).split(';').map(Number);
        applyGrCodes(current, codes);
        i = end + 1;
        continue;
      }
    }
    // Skip other escape sequences (cursor movement, etc.)
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      const match = text.slice(i).match(/^\x1b\[[0-9;]*[A-Za-z]/);
      if (match) {
        i += match[0].length;
        continue;
      }
    }
    buf += text[i];
    i++;
  }

  flushBuf();
  return parts.join('');
}

function buildClasses(state) {
  const cls = [];
  if (state.bold) cls.push('ansi-bold');
  if (state.dim) cls.push('ansi-dim');
  if (state.italic) cls.push('ansi-italic');
  if (state.underline) cls.push('ansi-underline');
  if (state.strike) cls.push('ansi-strike');
  if (state.fg !== null && !state.fg.startsWith('rgb(')) cls.push(`ansi-fg-${state.fg}`);
  if (state.bg !== null && !state.bg.startsWith('rgb(')) cls.push(`ansi-bg-${state.bg}`);
  return cls.join(' ');
}

const SGR = /\x1b\[[0-9;]*m/g;
const BLOCK_MARKS = {
  '\x02': '<span class="ansi-prose">',
  '\x03': '</span>',
  '\x04': '<span class="ansi-prose ansi-prose-more">',
  '\x10': '<span class="ansi-prose ansi-prompt">',
  '\x11': '<span class="ansi-prose ansi-item">',
  '\x12': '<span class="ansi-prose ansi-item ansi-nested">',
  '\x0e': '<span class="ansi-tool">',
  '\x0f': '</span>',
};

// The CLI's prose replies are a bullet line that is not a Tool(args) call, plus the lines it
// hard-wrapped with a two-space indent; later paragraphs of the same reply are two-space lines
// after a blank one. Each paragraph is marked (its trailing newline inside) so it can read as
// proportional, reflowing text. The user's own prompt (`❯ text` and its lines) reads in the same
// font but keeps its line breaks, which are the user's; a status line (`✶ Drafting… (52s)`,
// `✻ Worked for 18s`) is a block of its own. In a reply, each list item (with the lines it wrapped
// onto) is a prose block too, under the paragraph text, a nested one a step further in. Box tables, deeper-indented code, ⎿ results,
// numbered menu choices (`❯ 1. Yes`) and a draft in the input box (under a ─ rule) never count,
// so they keep their lines and monospace; the reply goes on past them until a line in column 0.
const STRUCTURED = /^(?:[-*•+] |\d+[.)] |[\u2500-\u257F⎿])/;
const isReplyStart = (plain) => /^[●⏺] \S/.test(plain) && !/^[●⏺] \S+\(/.test(plain) && !STRUCTURED.test(plain.slice(2));
const isPromptStart = (plain, above) => /^❯ \S/.test(plain) && !STRUCTURED.test(plain.slice(2)) && !/^─+$/.test((above ?? '').replace(/[\x06\x07]/g, ''));
const isStatusLine = (plain) => /^[✻✶✳✢✽·] [A-Z]/.test(plain);
const isProseLine = (plain) => /^ {2}\S/.test(plain) && !STRUCTURED.test(plain.slice(2));
const LIST_ITEM = /^( +)(?:[-*•+] |\d+[.)] )\S/;

function markProse(text) {
  const lines = text.split('\n');
  const plain = lines.map((line) => line.replace(SGR, ''));
  let inReply = false;
  for (let i = 0; i < lines.length; i++) {
    const more = inReply && isProseLine(plain[i]);
    if (!plain[i]) continue;
    const item = inReply && LIST_ITEM.exec(plain[i]);
    if (item) {
      let end = i;
      while (end + 1 < lines.length && /^ +\S/.test(plain[end + 1]) && plain[end + 1].search(/\S/) > item[1].length && !LIST_ITEM.test(plain[end + 1])) end++;
      lines[i] = lines[i].replace(/^\x03?/, `$&${item[1].length > 2 ? '\x12' : '\x11'}`);
      if (end + 1 < lines.length) lines[end + 1] = `\x03${lines[end + 1]}`;
      else lines[end] += '\x03';
      i = end;
      continue;
    }
    const prompt = isPromptStart(plain[i], plain[i - 1]);
    const status = isStatusLine(plain[i]);
    if (!isReplyStart(plain[i]) && !prompt && !status && !more) { inReply &&= plain[i].startsWith(' '); continue; }
    let end = i;
    // The CLI paints a prompt on one background until it resets it, blank lines included: the
    // prompt goes on past a blank line while that background is still on where the next line starts.
    const paint = prompt ? withSgr({ bg: null }, lines[i]) : null;
    const next = (k) => isProseLine(plain[k]) || (paint?.bg != null && !plain[k] && isProseLine(plain[k + 1] ?? '')
      && withSgr({ ...paint }, lines[k] + lines[k + 1].match(/^(?:[ \t]|\x1b\[[0-9;]*m)*/)[0]).bg != null);
    while (!status && end + 1 < lines.length && next(end + 1)) {
      end++;
      if (paint) withSgr(paint, lines[end]);
    }
    lines[i] = `${prompt ? '\x10' : more ? '\x04' : '\x02'}${lines[i]}`;
    if (end + 1 < lines.length) lines[end + 1] = `\x03${lines[end + 1]}`;
    else lines[end] += '\x03';
    inReply = !prompt && !status;
    i = end;
  }
  return lines.join('\n');
}

// A tool call is its `● Tool(args)` line (Codex: `• Ran cmd`, `• Explored`, `• Edited file`) plus
// the ⎿ / └ result and deeper-indented lines under it (wrapped arguments, output, diff rows). Each
// is marked as one card; the text inside is unchanged.
const isToolStart = (plain) => /^[●⏺] \S+\(|^• (?:Ran|Explored|Edited|Added|Deleted|Called|Waited)\b/.test(plain);
const isToolLine = (plain) => /^ {2}[⎿└│]|^ {3,}\S/.test(plain);

function markTools(text) {
  const lines = text.split('\n');
  const plain = lines.map((line) => line.replace(SGR, '').replace(/[\x02-\x07\x10-\x12]/g, ''));
  for (let i = 0; i < lines.length; i++) {
    if (!isToolStart(plain[i])) continue;
    let end = i;
    while (end + 1 < lines.length && isToolLine(plain[end + 1])) end++;
    // Codex replies start with `• ` too ("• Ran the suite; all green."); a call always has a result under it.
    if (end === i && plain[i].startsWith('• ')) continue;
    // Open after a prose block's closing mark; close before anything that opens on the next line.
    lines[i] = lines[i].replace(/^[\x03\x0f]*/, '$&\x0e');
    if (end + 1 < lines.length) lines[end + 1] = `\x0f${lines[end + 1]}`;
    else lines[end] += '\x0f';
    i = end;
  }
  return lines.join('\n');
}

function liftGrey(color) {
  return color.replace(/^rgb\((\d+),\1,\1\)$/, (match, v) => {
    if (v < 96 || v >= 224) return match;
    const g = Math.round(+v + ((224 - v) * 2) / 3);
    return `rgb(${g},${g},${g})`;
  });
}

// xterm 256-colour palette entries 16-255: a 6x6x6 cube, then a grey ramp.
function xterm256(n) {
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const level = (v) => (v ? 55 + v * 40 : 0);
  const i = n - 16;
  return `rgb(${level(Math.floor(i / 36))},${level(Math.floor(i / 6) % 6)},${level(i % 6)})`;
}

// The colour state after every SGR code in the text.
function withSgr(state, text) {
  for (const [, params] of text.matchAll(/\x1b\[([0-9;]*)m/g)) applyGrCodes(state, params.split(';').map(Number));
  return state;
}

function applyGrCodes(state, codes) {
  let j = 0;
  while (j < codes.length) {
    const c = codes[j];
    if (isNaN(c) || c === 0) {
      // Reset
      state.bold = false; state.dim = false; state.italic = false;
      state.underline = false; state.strike = false;
      state.fg = null; state.bg = null;
    } else if (c === 1) {
      state.bold = true;
    } else if (c === 2) {
      state.dim = true;
    } else if (c === 3) {
      state.italic = true;
    } else if (c === 4) {
      state.underline = true;
    } else if (c === 9) {
      state.strike = true;
    } else if (c === 22) {
      state.bold = false; state.dim = false;
    } else if (c === 23) {
      state.italic = false;
    } else if (c === 24) {
      state.underline = false;
    } else if (c === 29) {
      state.strike = false;
    } else if (c >= 30 && c <= 37) {
      state.fg = COLOR_NAMES[c - 30];
    } else if (c === 39) {
      state.fg = null;
    } else if (c >= 40 && c <= 47) {
      state.bg = COLOR_NAMES[c - 40];
    } else if (c === 49) {
      state.bg = null;
    } else if (c >= 90 && c <= 97) {
      state.fg = `bright-${COLOR_NAMES[c - 90]}`;
    } else if (c >= 100 && c <= 107) {
      state.bg = `bright-${COLOR_NAMES[c - 100]}`;
    } else if (c === 38 || c === 48) {
      const key = c === 38 ? 'fg' : 'bg';
      if (codes[j + 1] === 5) {
        // 256-color: 38;5;n
        const n = codes[j + 2] || 0;
        state[key] = n < 8 ? COLOR_NAMES[n] : n < 16 ? `bright-${COLOR_NAMES[n - 8]}` : xterm256(Math.min(n, 255));
        j += 2;
      } else if (codes[j + 1] === 2) {
        // Truecolor: 38;2;r;g;b
        const [r, g, b] = codes.slice(j + 2, j + 5).map((v) => Math.min(255, Math.max(0, v || 0)));
        state[key] = `rgb(${r},${g},${b})`;
        j += 4;
      }
    }
    j++;
  }
}

/**
 * While the control bar shows an approval's choices, drop the same question and
 * numbered menu from the terminal so the prompt appears once. Lines after the
 * menu are kept; without a matching question and menu the text is unchanged.
 */
export function foldAnsweredMenu(text, interaction) {
  const question = interaction?.detail?.trim();
  if (!question || !interaction.options?.length) return text;
  const lines = text.split('\n');
  const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, ''));
  const start = plain.findLastIndex((line) => line.trim() === question);
  const choice = /^\s*(?:[❯›>]\s*)?\d+\.\s/;
  let end = -1;
  for (let i = start + 1; start >= 0 && i < plain.length; i++) {
    // Indented lines after a choice are its wrapped text; a blank line after the menu, or unindented text, ends it.
    if (choice.test(plain[i]) || (end >= 0 && /^\s+\S/.test(plain[i]))) end = i;
    else if (plain[i].trim() ? !/^\s/.test(plain[i]) : end >= 0) break;
  }
  // Only the newest menu is live; if another follows (say its question wrapped and did not match), fold nothing.
  if (end < 0 || plain.slice(end + 1).some((line) => choice.test(line))) return text;
  return [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n');
}

/**
 * The CLI's own input box (a rule, an empty ❯ line, a rule) at the foot of the pane repeats the
 * composer below it, so it is dropped while empty. The mode line under it stays; anything typed
 * into the box keeps it in view.
 */
export function foldEmptyPrompt(text) {
  const lines = text.split('\n');
  const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim());
  const at = plain.findLastIndex((line) => line === '❯');
  const rule = (line) => /^─{20,}$/.test(line ?? '');
  if (at < 1 || !rule(plain[at - 1]) || !rule(plain[at + 1]) || plain.slice(at + 2).filter(Boolean).length > 2) return text;
  // The mode under the box moves to the composer's mode button (see permissionMode); the rest of
  // that footer line (`· ← for agents`, `· 1 shell`) stays, and a line left empty goes.
  const foot = lines.slice(at + 2).map(dropMode).filter((line, k) => line === lines[at + 2 + k] || stripSgr(line).trim());
  return [...lines.slice(0, at - 1), ...foot].join('\n');
}

// The CLI's permission mode: `⏵⏵ accept edits on (shift+tab to cycle) · `, `⏸ plan mode on …`.
const MODE = /(?:⏵⏵|⏸) (.+?) on\b(?: \(shift\+tab to cycle\))?(?: ·)? ?/;
const stripSgr = (line) => line.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

// Removes the mode's characters from a raw line, keeping every colour code so the rest keeps its style.
function dropMode(line) {
  const at = [];
  let plain = '';
  for (let i = 0; i < line.length;) {
    const code = /^\x1b\[[0-9;]*[a-zA-Z]/.exec(line.slice(i));
    if (code) { i += code[0].length; continue; }
    at.push(i);
    plain += line[i++];
  }
  const match = MODE.exec(plain);
  if (!match) return line;
  const drop = new Set(at.slice(match.index, match.index + match[0].length));
  return [...line.split('').keys()].filter((i) => !drop.has(i)).map((i) => line[i]).join('');
}

// The mode on the pane's last mode line ('accept edits', 'plan'), or '' in the default mode.
export function permissionMode(text) {
  const match = stripSgr(String(text || '')).split('\n').map((line) => MODE.exec(line)).findLast(Boolean);
  return match ? match[1].replace(/ mode$/, '') : '';
}
