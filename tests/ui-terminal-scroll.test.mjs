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

describe('terminal follow decision', async () => {
  const { readScrollSnapshot } = await import('../public/components/terminal.mjs');
  const at = (distanceFromBottom) => readScrollSnapshot({ scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 - distanceFromBottom });

  it('follows new output only when the view is at the bottom, allowing sub-pixel rounding', () => {
    assert.equal(at(0).atBottom, true);
    assert.equal(at(1.5).atBottom, true);
  });

  it('keeps the place of a reader who scrolled up even slightly', () => {
    for (const distance of [8, 20, 39]) assert.equal(at(distance).atBottom, false, `${distance}px above the bottom`);
  });
});
