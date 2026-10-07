import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_RENDERED_MARKDOWN_CHARS } from '../public/components/markdown-math.mjs';
import { markdownChunks, parseRenderedTranscript, RenderedTranscript } from '../public/components/rendered-transcript.mjs';

// Expands function components so the test sees the text a browser would show.
function renderedText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  if (Array.isArray(node)) return node.map(renderedText).join('');
  if (typeof node.type === 'function') return renderedText(node.type(node.props));
  return renderedText(node.props?.children);
}

function findButton(node) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) return node.map(findButton).find(Boolean) || null;
  if (node.type === 'button') return node;
  return findButton(node.props?.children);
}

describe('rendered session transcript', () => {
  it('keeps multiline user prompts separate from AI responses', () => {
    const parsed = parseRenderedTranscript([
      'older terminal output',
      '',
      '› explain the equation',
      '  and render the markdown',
      '',
      '• The answer is $x^2$.',
      '',
      '› follow up',
      '',
      '• Done.',
    ].join('\n'));

    assert.equal(parsed.prelude, 'older terminal output');
    assert.deepEqual(parsed.turns, [
      {
        user: 'explain the equation\nand render the markdown',
        assistant: '• The answer is $x^2$.',
      },
      {
        user: 'follow up',
        assistant: '• Done.',
      },
    ]);
  });

  it('recognizes Claude prompt markers and ANSI text', () => {
    const parsed = parseRenderedTranscript('\u001b[32m❯ user text\u001b[0m\n\nassistant text');
    assert.equal(parsed.turns[0].user, 'user text');
    assert.equal(parsed.turns[0].assistant, 'assistant text');
  });

  it('renders every session-log message even when the transcript exceeds the Markdown cap', () => {
    const messages = Array.from({ length: 300 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      text: `message-${index} ${'y'.repeat(1000)}`,
    }));
    const joined = messages.map(({ role, text }) => `## ${role === 'user' ? 'User' : 'AI'}\n\n${text}`).join('\n\n---\n\n');
    assert.ok(joined.length > MAX_RENDERED_MARKDOWN_CHARS);

    // The old single-document path loses the tail to the cap.
    assert.doesNotMatch(renderedText(RenderedTranscript({ content: joined })), /message-299 /);

    const text = renderedText(RenderedTranscript({ messages, start: 0 }));
    assert.match(text, /^Usermessage-0 /);
    assert.match(text, /message-299 /);
    assert.doesNotMatch(text, /Rendered view truncated|Load earlier/);
  });

  it('offers earlier messages when the page does not start at the first message', () => {
    let loads = 0;
    const tree = RenderedTranscript({
      messages: [{ role: 'assistant', text: 'latest' }],
      start: 100,
      onLoadEarlier: () => { loads += 1; },
    });
    const button = findButton(tree);
    assert.equal(renderedText(button), 'Load earlier messages');
    button.props.onClick();
    assert.equal(loads, 1);
    assert.match(renderedText(tree), /AIlatest/);
  });

  it('splits a single message longer than the Markdown cap without dropping its end', () => {
    const paragraph = 'p'.repeat(1000);
    const text = `first ${Array.from({ length: 450 }, () => paragraph).join('\n\n')} last-words`;
    const chunks = markdownChunks(text);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= MAX_RENDERED_MARKDOWN_CHARS));
    assert.equal(chunks.join(''), text);

    const rendered = renderedText(RenderedTranscript({ messages: [{ role: 'assistant', text }], start: 0 }));
    assert.match(rendered, /^AIfirst /);
    assert.match(rendered, /last-words$/);
    assert.doesNotMatch(rendered, /Rendered view truncated/);
  });
});
