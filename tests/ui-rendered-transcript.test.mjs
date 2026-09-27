import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRenderedTranscript } from '../public/components/rendered-transcript.mjs';

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
});
