import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foldAnsweredMenu } from '../public/lib/ansi-to-html.mjs';

const approval = { detail: 'Do you want to proceed?', options: [{ key: '1', label: 'Yes' }, { key: '2', label: 'No' }] };
const pane = [
  '● Bash(npm run migrate)',
  ' Do you want to proceed?',
  ' \x1b[36m❯ 1. Yes\x1b[0m',
  '   2. Yes, and don\'t ask again for npm run migrate commands in',
  '      this project',
  '   3. No, and tell Claude what to do',
  '      differently (esc)',
  '',
  ' Esc to cancel',
].join('\n');

test('an approval shown in the control bar folds out of the terminal once', () => {
  assert.deepEqual(foldAnsweredMenu(pane, approval).split('\n'), [
    '● Bash(npm run migrate)',
    '\x1b[2m(choices shown below)\x1b[0m',
    '',
    ' Esc to cancel',
  ]);
});

test('text without that question and a numbered menu is left alone', () => {
  assert.equal(foldAnsweredMenu(pane, null), pane);
  assert.equal(foldAnsweredMenu(pane, { ...approval, detail: 'Overwrite the file?' }), pane);
  assert.equal(foldAnsweredMenu('Do you want to proceed?\nthinking…', approval), 'Do you want to proceed?\nthinking…');
  assert.equal(foldAnsweredMenu(pane, { ...approval, options: [] }), pane);
  // An older menu with the same question stays when a newer menu follows it.
  const older = `${pane}\n Do you want to proceed with the very long\n wrapped question?\n ❯ 1. Yes\n   2. No`;
  assert.equal(foldAnsweredMenu(older, approval), older);
});
