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
 * Supports: bold, dim, italic, underline, strikethrough, 8-color fg/bg, bright colors, reset.
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
    if (classes) {
      parts.push(`<span class="${classes}">${esc(buf)}</span>`);
    } else {
      parts.push(esc(buf));
    }
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
  if (state.fg !== null) cls.push(`ansi-fg-${state.fg}`);
  if (state.bg !== null) cls.push(`ansi-bg-${state.bg}`);
  return cls.join(' ');
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
      // 256-color or truecolor — skip params
      const isFg = c === 38;
      if (codes[j + 1] === 5) {
        // 256-color: 38;5;n
        const n = codes[j + 2] || 0;
        if (n < 8) {
          if (isFg) state.fg = COLOR_NAMES[n]; else state.bg = COLOR_NAMES[n];
        } else if (n < 16) {
          const name = `bright-${COLOR_NAMES[n - 8]}`;
          if (isFg) state.fg = name; else state.bg = name;
        }
        // 16-255: skip (no CSS class mapping)
        j += 2;
      } else if (codes[j + 1] === 2) {
        // Truecolor: 38;2;r;g;b — skip
        j += 4;
      }
    }
    j++;
  }
}
