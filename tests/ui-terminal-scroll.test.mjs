import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('terminal scroll pinning', () => {
  it('keeps a bottom-pinned terminal at the bottom as delayed layout settles', async () => {
    const terminal = await readFile('public/components/terminal.mjs', 'utf8');

    assert.match(terminal, /new ResizeObserver\(keepBottomPinned\)/);
    assert.match(terminal, /observer\.observe\(body\)/);
    assert.match(terminal, /focus\(\{ preventScroll: true \}\)/);
    assert.doesNotMatch(terminal, /stickToBottom/);
  });
});
