import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isFinishedWorkEdge,
  nextRememberedStatus,
} from '../modules/session-state/attention-edge.mjs';

describe('finished-work attention edge', () => {
  it('fires once when leaving a busy status for ready', () => {
    assert.equal(isFinishedWorkEdge('working', 'ready'), true);
    assert.equal(isFinishedWorkEdge('thinking', 'ready'), true);
    assert.equal(isFinishedWorkEdge('awaiting_response', 'ready'), true);
    assert.equal(isFinishedWorkEdge('blocked', 'ready'), true);
  });

  it('does not fire on first sight of ready or while remaining ready', () => {
    assert.equal(isFinishedWorkEdge(undefined, 'ready'), false);
    assert.equal(isFinishedWorkEdge('ready', 'ready'), false);
  });

  it('matches the measured tracker sequences', () => {
    function count(sequence) {
      let previous;
      let edges = 0;
      for (const status of sequence) {
        if (isFinishedWorkEdge(previous, status)) edges += 1;
        previous = nextRememberedStatus(previous, status);
      }
      return edges;
    }
    assert.equal(count(['thinking', 'thinking', 'unknown', 'ready']), 1, 'A work finishes');
    assert.equal(count(['unknown', 'ready', 'ready', 'ready']), 0, 'B fresh idle tracker');
    assert.equal(count(['unknown', 'ready', 'unknown', 'ready']), 0, 'C late tick only');
    assert.equal(count(['thinking', 'unknown', 'ready', 'thinking', 'unknown', 'ready']), 2, 'D two genuine tasks');
    assert.equal(count(Array.from({ length: 18 }, () => ['unknown', 'ready']).flat()), 0, 'restart 18 idle');
  });

  it('does not treat ready -> unknown -> ready as a new edge', () => {
    let remembered = 'working';
    remembered = nextRememberedStatus(remembered, 'ready');
    assert.equal(remembered, 'ready');
    assert.equal(isFinishedWorkEdge(remembered, 'ready'), false);
    remembered = nextRememberedStatus(remembered, 'unknown');
    assert.equal(remembered, 'ready');
    assert.equal(isFinishedWorkEdge(remembered, 'ready'), false);
    remembered = nextRememberedStatus(remembered, 'ready');
    assert.equal(isFinishedWorkEdge(remembered, 'ready'), false);
  });
});
