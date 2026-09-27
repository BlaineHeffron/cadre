import { h } from 'preact';
import { Marked } from 'marked';
import katex from 'katex';

export const MAX_RENDERED_MARKDOWN_CHARS = 200_000;

function escapedAt(source, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function findInlineDollarClose(source) {
  for (let index = 1; index < source.length; index += 1) {
    if (source[index] === '\n') return -1;
    if (source[index] !== '$' || escapedAt(source, index)) continue;
    if (/\s/.test(source[index - 1] || '')) return -1;
    if (/[\p{L}\p{N}]/u.test(source[index + 1] || '')) return -1;
    return index;
  }
  return -1;
}

const blockMathExtension = {
  name: 'mathBlock',
  level: 'block',
  start(source) {
    const dollar = source.indexOf('$$');
    const bracket = source.indexOf('\\[');
    if (dollar < 0) return bracket < 0 ? undefined : bracket;
    return bracket < 0 ? dollar : Math.min(dollar, bracket);
  },
  tokenizer(source) {
    const dollar = /^\$\$[ \t]*\n?([\s\S]+?)\n?[ \t]*\$\$(?:[ \t]*(?:\n|$))/.exec(source);
    if (dollar) {
      return { type: 'mathBlock', raw: dollar[0], text: dollar[1].trim(), displayMode: true };
    }
    const bracket = /^\\\[[ \t]*\n?([\s\S]+?)\n?[ \t]*\\\](?:[ \t]*(?:\n|$))/.exec(source);
    if (bracket) {
      return { type: 'mathBlock', raw: bracket[0], text: bracket[1].trim(), displayMode: true };
    }
    return undefined;
  },
};

const inlineMathExtension = {
  name: 'mathInline',
  level: 'inline',
  start(source) {
    const dollar = source.indexOf('$');
    const paren = source.indexOf('\\(');
    if (dollar < 0) return paren < 0 ? undefined : paren;
    return paren < 0 ? dollar : Math.min(dollar, paren);
  },
  tokenizer(source) {
    if (source.startsWith('\\(')) {
      for (let index = 2; index < source.length - 1; index += 1) {
        if (source.startsWith('\\)', index) && !escapedAt(source, index)) {
          return {
            type: 'mathInline',
            raw: source.slice(0, index + 2),
            text: source.slice(2, index).trim(),
            displayMode: false,
          };
        }
      }
      return undefined;
    }
    if (!source.startsWith('$') || source.startsWith('$$') || /\s/.test(source[1] || '')) return undefined;
    const close = findInlineDollarClose(source);
    if (close < 0) return undefined;
    const expression = source.slice(1, close);
    if (/^[\d\s.,+\-*/=:%]+$/.test(expression)) return undefined;
    return {
      type: 'mathInline',
      raw: source.slice(0, close + 1),
      text: expression.trim(),
      displayMode: false,
    };
  },
};

const markdownLexer = new Marked({
  breaks: true,
  gfm: true,
});
markdownLexer.use({
  extensions: [blockMathExtension, inlineMathExtension],
});

export function lexMarkdownMath(source = '') {
  const text = String(source ?? '');
  const bounded = text.length > MAX_RENDERED_MARKDOWN_CHARS
    ? `${text.slice(0, MAX_RENDERED_MARKDOWN_CHARS)}\n\n[Rendered view truncated]`
    : text;
  return markdownLexer.lexer(bounded);
}

export function safeMarkdownHref(href = '') {
  const source = String(href || '').trim();
  if (!source) return '';
  try {
    const parsed = new URL(source);
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

function renderMath(token, key) {
  let markup = '';
  try {
    markup = katex.renderToString(token.text, {
      displayMode: token.displayMode === true,
      output: 'htmlAndMathml',
      strict: 'ignore',
      throwOnError: false,
      trust: false,
      maxExpand: 1_000,
      maxSize: 10,
    });
  } catch {
    return h('code', { class: 'math-render-error', key }, token.raw);
  }
  const tag = token.displayMode ? 'div' : 'span';
  return h(tag, {
    class: token.displayMode ? 'math-display' : 'math-inline',
    key,
    'data-latex': token.text,
    dangerouslySetInnerHTML: { __html: markup },
  });
}

function renderTable(token, key) {
  const alignmentStyle = (align) =>
    ['left', 'center', 'right'].includes(align) ? `text-align:${align}` : undefined;
  return h('div', { class: 'markdown-table-wrap', key },
    h('table', null,
      h('thead', null,
        h('tr', null, ...token.header.map((cell, index) =>
          h('th', { key: `${key}-h-${index}`, style: alignmentStyle(cell.align) },
            ...renderTokens(cell.tokens, `${key}-h-${index}`)
          )
        ))
      ),
      h('tbody', null, ...token.rows.map((row, rowIndex) =>
        h('tr', { key: `${key}-r-${rowIndex}` }, ...row.map((cell, cellIndex) =>
          h('td', {
            key: `${key}-r-${rowIndex}-c-${cellIndex}`,
            style: alignmentStyle(cell.align),
          }, ...renderTokens(cell.tokens, `${key}-r-${rowIndex}-c-${cellIndex}`))
        ))
      ))
    )
  );
}

function renderToken(token, key) {
  switch (token.type) {
    case 'space':
      return null;
    case 'hr':
      return h('hr', { key });
    case 'heading': {
      const level = Math.min(Math.max(Number(token.depth) || 1, 1), 6);
      return h(`h${level}`, { key }, ...renderTokens(token.tokens, key));
    }
    case 'paragraph':
      return h('p', { key }, ...renderTokens(token.tokens, key));
    case 'text':
      return token.tokens
        ? h('span', { key }, ...renderTokens(token.tokens, key))
        : String(token.text ?? '');
    case 'blockquote':
      return h('blockquote', { key }, ...renderTokens(token.tokens, key));
    case 'list': {
      const tag = token.ordered ? 'ol' : 'ul';
      const props = token.ordered && Number(token.start) > 1 ? { start: Number(token.start), key } : { key };
      return h(tag, props, ...token.items.map((item, index) =>
        h('li', { key: `${key}-${index}` },
          item.task ? h('input', { type: 'checkbox', checked: item.checked === true, disabled: true }) : null,
          ...renderTokens(item.tokens, `${key}-${index}`)
        )
      ));
    }
    case 'code':
      return h('pre', { key }, h('code', { class: token.lang ? `language-${token.lang}` : undefined }, token.text));
    case 'codespan':
      return h('code', { key }, token.text);
    case 'strong':
      return h('strong', { key }, ...renderTokens(token.tokens, key));
    case 'em':
      return h('em', { key }, ...renderTokens(token.tokens, key));
    case 'del':
      return h('del', { key }, ...renderTokens(token.tokens, key));
    case 'br':
      return h('br', { key });
    case 'link': {
      const href = safeMarkdownHref(token.href);
      if (!href) return h('span', { key }, ...renderTokens(token.tokens, key));
      return h('a', {
        href,
        key,
        rel: 'noopener noreferrer',
        target: '_blank',
        title: token.title || undefined,
      }, ...renderTokens(token.tokens, key));
    }
    case 'image': {
      const href = safeMarkdownHref(token.href);
      const label = token.text ? `[image: ${token.text}]` : '[image]';
      return href
        ? h('a', { href, key, rel: 'noopener noreferrer', target: '_blank', title: token.title || undefined }, label)
        : label;
    }
    case 'table':
      return renderTable(token, key);
    case 'def':
      return null;
    case 'mathInline':
    case 'mathBlock':
      return renderMath(token, key);
    case 'html':
      return token.block
        ? h('pre', { class: 'markdown-raw-html', key }, token.text)
        : String(token.text ?? '');
    case 'escape':
      return String(token.text ?? '');
    default:
      return String(token.text ?? token.raw ?? '');
  }
}

export function renderMarkdownMathNodes(source = '') {
  return renderTokens(lexMarkdownMath(source), 'md');
}

export function renderMarkdownTokens(tokens = []) {
  return renderTokens(tokens, 'md-test');
}

function renderTokens(tokens = [], keyPrefix = 'md') {
  return (tokens || [])
    .map((token, index) => renderToken(token, `${keyPrefix}-${index}`))
    .filter((node) => node !== null && node !== undefined);
}

export function MarkdownMath({ content = '', className = '', ariaLabel = 'Rendered Markdown' }) {
  return h(
    'div',
    {
      class: `markdown-math ${className}`.trim(),
      'aria-label': ariaLabel,
    },
    ...renderMarkdownMathNodes(content),
  );
}
