import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnswerOptions } from '../modules/telegram/answer-options.mjs';

describe('telegram answer options parser', () => {
  it('parses a Claude approval numbered menu', () => {
    assert.deepEqual(parseAnswerOptions(`
Use tool?
  1. Yes, allow this command
  2. No, deny
`, 'claude', 'needs_approval'), [
      { key: '1', label: 'Yes, allow this command' },
      { key: '2', label: 'No, deny' },
    ]);
  });

  it('parses a Codex approval menu with a selected marker', () => {
    assert.deepEqual(parseAnswerOptions(`
❯ 1. Yes
  2. No (esc)
`, 'codex', 'needs_approval'), [
      { key: '1', label: 'Yes' },
      { key: '2', label: 'No' },
    ]);
  });

  it('parses Claude menus with description lines between choices', () => {
    assert.deepEqual(parseAnswerOptions(`
Telegram Q&A beta final: choose an option

❯ 1. Alpha
     Select Alpha
  2. Beta
     Select Beta
  3. Cancel
     Cancel the operation
  4. Type something.
────────────────────────────────────────────────────────────────────────────────
  5. Chat about this
`, 'claude', 'needs_approval'), [
      { key: '1', label: 'Alpha' },
      { key: '2', label: 'Beta' },
      { key: '3', label: 'Cancel' },
      { key: '4', label: 'Type something.' },
    ]);
  });

  it('parses y/n confirmations when no numbered menu exists', () => {
    assert.deepEqual(parseAnswerOptions('Proceed with this action? (y/n)', 'claude', 'needs_confirmation'), [
      { key: 'y', label: 'Yes' },
      { key: 'n', label: 'No' },
    ]);
  });

  it('uses the bottom-most numbered menu when earlier output contains a distractor list', () => {
    assert.deepEqual(parseAnswerOptions(`
Earlier plan:
1. Gather context
2. Edit files
3. Run tests

Approve command?
❯ 1. Allow command
  2. Deny
`, 'codex', 'needs_approval'), [
      { key: '1', label: 'Allow command' },
      { key: '2', label: 'Deny' },
    ]);
  });

  it('ignores an earlier distractor list when the bottom prompt has no valid menu', () => {
    assert.deepEqual(parseAnswerOptions(`
Earlier plan:
1. Gather context
2. Edit files

Approve command?
1. Only one visible choice
`, 'codex', 'needs_approval'), []);
  });

  it('returns no options when there is no actionable answer set', () => {
    assert.deepEqual(parseAnswerOptions('plain waiting prompt', 'codex', 'waiting_for_input'), []);
    assert.deepEqual(parseAnswerOptions('1. only one option', 'codex', 'needs_approval'), []);
  });
});
