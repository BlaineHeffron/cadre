import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  latexExpressionToUnicode,
  latexMathToUnicode,
} from '../modules/telegram/math.mjs';
import {
  lexMarkdownMath,
  MAX_RENDERED_MARKDOWN_CHARS,
  renderMarkdownMathNodes,
  renderMarkdownTokens,
  safeMarkdownHref,
} from '../public/components/markdown-math.mjs';

function collectVnodes(nodes, output = []) {
  for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
    if (!node || typeof node !== 'object') continue;
    output.push(node);
    collectVnodes(node.props?.children || [], output);
  }
  return output;
}

function collectText(nodes, output = []) {
  for (const node of Array.isArray(nodes) ? nodes : [nodes]) {
    if (typeof node === 'string') output.push(node);
    else if (node && typeof node === 'object') collectText(node.props?.children || [], output);
  }
  return output.join('');
}

describe('Markdown and KaTeX rendering', () => {
  it('lexes common inline and display LaTeX while leaving code canonical', () => {
    const tokens = lexMarkdownMath(`Inline $x^2$ and \\(y_1\\).

$$\\frac{a}{b}$$

\`$raw$\``);
    const tokenTypes = [
      ...tokens,
      ...tokens.flatMap((token) => token.tokens || []),
    ].map((token) => token.type);

    assert.equal(tokenTypes.filter((type) => type === 'mathInline').length, 2);
    assert.equal(tokenTypes.filter((type) => type === 'mathBlock').length, 1);
    assert.equal(tokenTypes.filter((type) => type === 'codespan').length, 1);
  });

  it('does not parse math delimiters inside code fences or currency prose', () => {
    const tokens = lexMarkdownMath(`Price moved from $5 to $7, range $100-$200, or pay $5/$10.

\`\`\`text
$x^2$ and $$y$$
\`\`\``);
    const tokenTypes = [
      ...tokens,
      ...tokens.flatMap((token) => token.tokens || []),
    ].map((token) => token.type);

    assert.equal(tokenTypes.includes('mathInline'), false);
    assert.equal(tokenTypes.includes('mathBlock'), false);
    assert.equal(tokenTypes.includes('code'), true);
  });

  it('renders KaTeX with canonical LaTeX metadata', () => {
    const nodes = collectVnodes(renderMarkdownMathNodes('Result: $\\frac{x_1}{2}$'));
    const math = nodes.find((node) => node.props?.class === 'math-inline');

    assert.ok(math);
    assert.equal(math.props['data-latex'], '\\frac{x_1}{2}');
    assert.match(math.props.dangerouslySetInnerHTML.__html, /class="katex"/);
  });

  it('treats raw HTML as text and rejects active link schemes', () => {
    const nodes = collectVnodes(renderMarkdownMathNodes(`<script>alert(1)</script>

[bad](javascript:alert(1))

[reference][unsafe]

[unsafe]: javascript:alert(2)

<javascript:alert(3)>`));

    assert.equal(nodes.some((node) => node.type === 'script'), false);
    assert.ok(nodes.some((node) => node.type === 'pre' && node.props?.class === 'markdown-raw-html'));
    assert.equal(nodes.some((node) => node.type === 'a'), false);
    assert.equal(safeMarkdownHref('javascript:alert(1)'), '');
    assert.equal(safeMarkdownHref('java&#115;cript:alert(1)'), '');
    assert.equal(safeMarkdownHref('%6Aavascript:alert(1)'), '');
    assert.equal(safeMarkdownHref('data:text/html,boom'), '');
    assert.equal(safeMarkdownHref('https://example.com/x'), 'https://example.com/x');
  });

  it('keeps KaTeX trust disabled and escapes unsafe formula contents', () => {
    for (const formula of [
      '\\href{javascript:alert(1)}{bad}',
      '\\url{javascript:alert(1)}',
      '\\includegraphics{javascript:alert(1)}',
      '\\htmlClass{bad}{x}',
      '\\htmlData{bad=thing}{x}',
      '\\htmlId{bad}{x}',
      '\\text{<img src=x onerror=alert(1)>}',
      '\\badcmd',
    ]) {
      const nodes = collectVnodes(renderMarkdownMathNodes(`$${formula}$`));
      const math = nodes.find((node) => node.props?.class === 'math-inline');
      assert.ok(math, formula);
      assert.doesNotMatch(math.props.dangerouslySetInnerHTML.__html, /<(?:a|img)\b[^>]*(?:href|src|onerror)=/i, formula);
    }
  });

  it('caps KaTeX layout dimensions', () => {
    const nodes = collectVnodes(renderMarkdownMathNodes('$\\rule{9999em}{9999em}$'));
    const math = nodes.find((node) => node.props?.class === 'math-inline');

    assert.ok(math);
    const visualMarkup = math.props.dangerouslySetInnerHTML.__html
      .replace(/<annotation\b[\s\S]*?<\/annotation>/g, '');
    assert.doesNotMatch(visualMarkup, /9999em/);
    assert.match(visualMarkup, /(?:width|height):?["=]?10em|width="10em"/);
  });

  it('suppresses definitions, blocks remote images, and defaults unknown tokens to text', () => {
    const nodes = renderMarkdownMathNodes(`[a]: https://example.com

text [a] ![safe](https://example.com/image.png) ![bad](javascript:alert(1))`);
    const vnodes = collectVnodes(nodes);

    assert.doesNotMatch(collectText(nodes), /\[a\]:/);
    assert.equal(vnodes.some((node) => node.type === 'img'), false);
    assert.equal(vnodes.filter((node) => node.type === 'a').length, 2);
    assert.deepEqual(
      renderMarkdownTokens([{ type: 'futureToken', raw: '<img src=x onerror=alert(1)>' }]),
      ['<img src=x onerror=alert(1)>']
    );
  });

  it('bounds model-controlled rendered input', () => {
    const tokens = lexMarkdownMath(`start ${'x'.repeat(MAX_RENDERED_MARKDOWN_CHARS + 100)}`);
    assert.ok(tokens[0].raw.length <= MAX_RENDERED_MARKDOWN_CHARS + 40);
    assert.match(tokens.at(-1).raw, /Rendered view truncated/);
  });
});

describe('LaTeX as emitted by real agent transcripts', () => {
  // Regression cover for the Multitime session: a tmux pane capture is the CLI's
  // already-rendered TUI output, which drops \( \) and \[ \] entirely. Math must
  // come from the provider session log, where these delimiters survive.
  it('converts the delimiters that survive in session logs but not in pane captures', () => {
    assert.equal(
      latexMathToUnicode('\\(\\mathrm{Spin}(3,3)\\cong SL(4,\\mathbb R)\\)'),
      'Spin(3,3)≅ SL(4, R)'
    );
    assert.equal(
      latexMathToUnicode('\\[S^+\\cong \\mathbb R\\oplus\\mathbb R^{3,3}\\oplus\\mathbb R\\]'),
      'S⁺≅ R⊕ R^(3,3)⊕ R'
    );
  });

  it('leaves pane-mangled math untouched rather than guessing delimiters', () => {
    // Bare parens/brackets are ordinary prose punctuation far more often than
    // they are math, so these must pass through unchanged.
    const mangled = '(Spin(3,3)\\cong SL(4,\\mathbb R))';
    assert.equal(latexMathToUnicode(mangled), mangled);
    assert.equal(latexMathToUnicode('[\nW=T\\oplus T^*.\n]'), '[\nW=T\\oplus T^*.\n]');
  });

  it('maps the algebra symbols these transcripts actually use', () => {
    assert.equal(latexMathToUnicode('\\(A\\otimes B\\)'), 'A⊗ B');
    assert.equal(latexMathToUnicode('\\(T\\oplus T\\)'), 'T⊕ T');
    assert.equal(latexMathToUnicode('\\(a\\simeq b\\)'), 'a≃ b');
  });

  it('handles font commands written without braces', () => {
    assert.equal(latexMathToUnicode('\\(\\mathbb R\\)'), 'R');
    assert.equal(latexMathToUnicode('\\(f(\\mathbb R)\\)'), 'f(R)');
  });
});

describe('Telegram LaTeX conversion', () => {
  it('converts delimited LaTeX into readable Unicode', () => {
    assert.equal(
      latexMathToUnicode('Solve $\\alpha^2 + \\beta_1 \\leq \\frac{3}{4}$ now.'),
      'Solve α² + β₁ ≤ (3)/(4) now.'
    );
    assert.equal(latexExpressionToUnicode('\\sqrt{x_2} \\to \\infty'), '√(x₂) → ∞');
  });

  it('supports all common math delimiters without changing code spans or unmatched text', () => {
    assert.equal(
      latexMathToUnicode('A \\(x \\times y\\), then \\[z \\neq 0\\], and $$\\sum_{i=1}^n i$$.'),
      'A x × y, then z ≠ 0, and ∑ᵢ₌₁ⁿ i.'
    );
    assert.equal(latexMathToUnicode('Keep `$x^2$`, \\$5, and unmatched $x.'), 'Keep `$x^2$`, \\$5, and unmatched $x.');
  });

  it('preserves currency, environments, and unknown commands without semantic corruption', () => {
    assert.equal(latexMathToUnicode('range $100-$200; pay $5/$10'), 'range $100-$200; pay $5/$10');
    assert.equal(
      latexMathToUnicode('$\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}$'),
      '$\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}$'
    );
    assert.equal(latexMathToUnicode('$\\foobar{x}$'), '\\foobar x');
  });

  it('renders accents as explicit readable functions without combining marks', () => {
    assert.equal(
      latexMathToUnicode('$\\vec{x} + \\bar{y} + \\hat{z}$'),
      'vec(x) + bar(y) + hat(z)'
    );
  });
});
