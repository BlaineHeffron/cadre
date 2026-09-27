const COMMAND_SYMBOLS = {
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  varepsilon: 'ϵ',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  varpi: 'ϖ',
  rho: 'ρ',
  sigma: 'σ',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'φ',
  varphi: 'ϕ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',
  pm: '±',
  mp: '∓',
  times: '×',
  div: '÷',
  cdot: '·',
  ast: '∗',
  circ: '∘',
  bullet: '•',
  le: '≤',
  leq: '≤',
  ge: '≥',
  geq: '≥',
  ne: '≠',
  neq: '≠',
  approx: '≈',
  equiv: '≡',
  sim: '∼',
  propto: '∝',
  in: '∈',
  notin: '∉',
  ni: '∋',
  subset: '⊂',
  supset: '⊃',
  subseteq: '⊆',
  supseteq: '⊇',
  cong: '≅',
  simeq: '≃',
  oplus: '⊕',
  otimes: '⊗',
  wedge: '∧',
  setminus: '∖',
  cup: '∪',
  cap: '∩',
  emptyset: '∅',
  forall: '∀',
  exists: '∃',
  neg: '¬',
  land: '∧',
  lor: '∨',
  infty: '∞',
  partial: '∂',
  nabla: '∇',
  sum: '∑',
  prod: '∏',
  int: '∫',
  iint: '∬',
  iiint: '∭',
  lim: 'lim',
  log: 'log',
  ln: 'ln',
  sin: 'sin',
  cos: 'cos',
  tan: 'tan',
  min: 'min',
  max: 'max',
  to: '→',
  rightarrow: '→',
  leftarrow: '←',
  leftrightarrow: '↔',
  Rightarrow: '⇒',
  Leftarrow: '⇐',
  Leftrightarrow: '⇔',
  mapsto: '↦',
  ldots: '…',
  cdots: '⋯',
  vdots: '⋮',
  ddots: '⋱',
  angle: '∠',
  degree: '°',
  perp: '⊥',
  parallel: '∥',
};

const SUPER_CHARS = {
  0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ',
};

const SUB_CHARS = {
  0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ',
  n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};

export const MAX_LATEX_EXPRESSION_CHARS = 20_000;
export const MAX_LATEX_CONVERSION_DEPTH = 64;
export const MAX_LATEX_MESSAGE_CHARS = 200_000;

function escapedAt(source, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function readBalancedGroup(source, start) {
  if (source[start] !== '{') return null;
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '{' && !escapedAt(source, index)) depth += 1;
    if (source[index] === '}' && !escapedAt(source, index)) {
      depth -= 1;
      if (depth === 0) {
        return { body: source.slice(start + 1, index), end: index + 1 };
      }
    }
  }
  return null;
}

function replaceTwoGroupCommand(source, command, render) {
  const needle = `\\${command}`;
  let output = '';
  let cursor = 0;
  while (cursor < source.length) {
    const index = source.indexOf(needle, cursor);
    if (index < 0) return output + source.slice(cursor);
    const firstStart = index + needle.length;
    const first = readBalancedGroup(source, firstStart);
    const second = first ? readBalancedGroup(source, first.end) : null;
    if (!first || !second) {
      output += source.slice(cursor, firstStart);
      cursor = firstStart;
      continue;
    }
    output += source.slice(cursor, index);
    output += render(first.body, second.body);
    cursor = second.end;
  }
  return output;
}

function replaceOneGroupCommand(source, command, render) {
  const needle = `\\${command}`;
  let output = '';
  let cursor = 0;
  while (cursor < source.length) {
    const index = source.indexOf(needle, cursor);
    if (index < 0) return output + source.slice(cursor);
    const groupStart = index + needle.length;
    const group = readBalancedGroup(source, groupStart);
    if (!group) {
      output += source.slice(cursor, groupStart);
      cursor = groupStart;
      continue;
    }
    output += source.slice(cursor, index);
    output += render(group.body);
    cursor = group.end;
  }
  return output;
}

function scriptReplacement(marker, body) {
  const table = marker === '^' ? SUPER_CHARS : SUB_CHARS;
  const converted = Array.from(body).map((char) => table[char] || '').join('');
  if (converted.length === Array.from(body).length) return converted;
  return `${marker}(${body})`;
}

function replaceScripts(source) {
  let output = '';
  for (let index = 0; index < source.length; index += 1) {
    const marker = source[index];
    if (marker !== '^' && marker !== '_') {
      output += marker;
      continue;
    }
    if (source[index + 1] === '{') {
      const group = readBalancedGroup(source, index + 1);
      if (group) {
        output += scriptReplacement(marker, group.body);
        index = group.end - 1;
        continue;
      }
    }
    if (index + 1 < source.length) {
      output += scriptReplacement(marker, source[index + 1]);
      index += 1;
      continue;
    }
    output += marker;
  }
  return output;
}

function convertLatexExpression(expression = '', depth = 0) {
  let output = String(expression ?? '').trim();
  if (output.length > MAX_LATEX_EXPRESSION_CHARS || depth > MAX_LATEX_CONVERSION_DEPTH) {
    throw new RangeError('LaTeX expression exceeds conversion limits');
  }
  if (/\\begin\s*\{/.test(output)) {
    throw new RangeError('LaTeX environments stay canonical');
  }
  for (let pass = 0; pass < 8; pass += 1) {
    const prior = output;
    output = replaceTwoGroupCommand(output, 'frac', (numerator, denominator) =>
      `(${convertLatexExpression(numerator, depth + 1)})/(${convertLatexExpression(denominator, depth + 1)})`
    );
    output = replaceTwoGroupCommand(output, 'binom', (top, bottom) =>
      `(${convertLatexExpression(top, depth + 1)} choose ${convertLatexExpression(bottom, depth + 1)})`
    );
    output = replaceOneGroupCommand(output, 'sqrt', (radicand) =>
      `√(${convertLatexExpression(radicand, depth + 1)})`
    );
    for (const command of ['text', 'textrm', 'textsf', 'texttt', 'mathrm', 'mathbb', 'mathcal', 'mathfrak', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'operatorname']) {
      output = replaceOneGroupCommand(output, command, (body) => convertLatexExpression(body, depth + 1));
    }
    for (const [command, label] of [
      ['vec', 'vec'],
      ['bar', 'bar'],
      ['hat', 'hat'],
      ['tilde', 'tilde'],
      ['overline', 'overline'],
    ]) {
      output = replaceOneGroupCommand(output, command, (body) =>
        `${label}(${convertLatexExpression(body, depth + 1)})`
      );
    }
    if (output === prior) break;
  }

  output = output
    // Font commands are also written without braces over a single token
    // (\mathbb R). Those never reach replaceOneGroupCommand, which requires "{".
    // Runs before the generic command pass so the surviving token cannot be
    // glued onto a preceding command (\oplus\mathbb R -> \oplusR).
    .replace(
      /\\(?:text|textrm|textsf|texttt|mathrm|mathbb|mathcal|mathfrak|mathbf|mathit|mathsf|mathtt|operatorname)\s+([A-Za-z0-9])/g,
      ' $1'
    )
    .replace(/\\(?:left|right|big|Big|bigg|Bigg)\b/g, '')
    .replace(/\\(?:quad|qquad)\b/g, ' ')
    .replace(/\\[,;:!]/g, ' ')
    .replace(/\\([{}%$#&_])/g, '$1')
    .replace(/\\([A-Za-z]+)/g, (_, command) => COMMAND_SYMBOLS[command] ?? `\\${command} `)
    .replace(/\\\\/g, '\n');
  output = replaceScripts(output);
  output = output
    .replace(/[{}]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/([([])\s+/g, '$1')
    .replace(/\s+([)\]])/g, '$1')
    .replace(/ *\n */g, '\n')
    .trim();
  return output;
}

export function latexExpressionToUnicode(expression = '') {
  const source = String(expression ?? '');
  try {
    return convertLatexExpression(source);
  } catch {
    return source;
  }
}

function numericOperatorOnly(expression) {
  return /^[\d\s.,+\-*/=:%]+$/.test(expression);
}

function findMathClose(source, start, close, { singleDollar = false } = {}) {
  for (let index = start; index <= source.length - close.length; index += 1) {
    if (!source.startsWith(close, index) || escapedAt(source, index)) continue;
    if (singleDollar && source[index - 1] && /\s/.test(source[index - 1])) return -1;
    if (singleDollar && /[\p{L}\p{N}]/u.test(source[index + close.length] || '')) return -1;
    return index;
  }
  return -1;
}

function readBacktickSpan(source, start) {
  let runLength = 1;
  while (source[start + runLength] === '`') runLength += 1;
  const delimiter = '`'.repeat(runLength);
  const close = source.indexOf(delimiter, start + runLength);
  return close < 0 ? source.length : close + runLength;
}

export function latexMathToUnicode(text = '') {
  const source = String(text ?? '');
  if (source.length > MAX_LATEX_MESSAGE_CHARS) return source;
  let output = '';
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] === '`') {
      const end = readBacktickSpan(source, cursor);
      output += source.slice(cursor, end);
      cursor = end;
      continue;
    }

    let open = '';
    let close = '';
    let singleDollar = false;
    if (source.startsWith('$$', cursor) && !escapedAt(source, cursor)) {
      open = '$$';
      close = '$$';
    } else if (source[cursor] === '$' && !escapedAt(source, cursor) && !/\s/.test(source[cursor + 1] || '')) {
      open = '$';
      close = '$';
      singleDollar = true;
    } else if (source.startsWith('\\(', cursor) && !escapedAt(source, cursor)) {
      open = '\\(';
      close = '\\)';
    } else if (source.startsWith('\\[', cursor) && !escapedAt(source, cursor)) {
      open = '\\[';
      close = '\\]';
    }

    if (!open) {
      output += source[cursor];
      cursor += 1;
      continue;
    }

    const closeIndex = findMathClose(source, cursor + open.length, close, { singleDollar });
    if (closeIndex < 0) {
      output += source[cursor];
      cursor += 1;
      continue;
    }
    const expression = source.slice(cursor + open.length, closeIndex);
    if (singleDollar && numericOperatorOnly(expression)) {
      output += source[cursor];
      cursor += 1;
      continue;
    }
    try {
      output += convertLatexExpression(expression);
    } catch {
      output += source.slice(cursor, closeIndex + close.length);
    }
    cursor = closeIndex + close.length;
  }
  return output;
}
