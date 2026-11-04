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

  const parts = [];
  let current = { bold: false, dim: false, italic: false, underline: false, strike: false, fg: null, bg: null };
  let i = 0;
  let buf = '';

  function flushBuf() {
    if (!buf) return;
    const classes = buildClasses(current);
    // 256-colour and truecolor values have no class; they render inline.
    const style = [['color', current.fg], ['background', current.bg]]
      .filter(([, value]) => value?.startsWith('rgb('))
      .map(([prop, value]) => `${prop}:${value}`)
      .join(';');
    const attrs = `${classes ? ` class="${classes}"` : ''}${style ? ` style="${style}"` : ''}`;
    parts.push(attrs ? `<span${attrs}>${esc(buf)}</span>` : esc(buf));
    buf = '';
  }

  while (i < text.length) {
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
 * While the control bar shows an approval's choices, fold the same question and
 * numbered menu out of the terminal so the prompt appears once. Lines after the
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
    if (choice.test(plain[i])) end = i;
    // A blank line after the menu, or unindented text, ends it; indented lines are wrapped choices.
    else if (plain[i].trim() ? !/^\s/.test(plain[i]) : end >= 0) break;
  }
  // Only the newest menu is live; if another follows (say its question wrapped and did not match), fold nothing.
  if (end < 0 || plain.slice(end + 1).some((line) => choice.test(line))) return text;
  return [...lines.slice(0, start), '\x1b[2m(choices shown below)\x1b[0m', ...lines.slice(end + 1)].join('\n');
}
