import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { settleWithConcurrency } from '../public/app/async-pool.mjs';

describe('bounded async actions', () => {
  it('caps concurrent work, preserves result order, and reports progress', async () => {
    let active = 0;
    let maxActive = 0;
    const progress = [];

    const results = await settleWithConcurrency(
      [0, 1, 2, 3, 4, 5, 6],
      async (value) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, value % 2 === 0 ? 8 : 2));
        active -= 1;
        if (value === 3) throw new Error('expected failure');
        return value * 2;
      },
      {
        concurrency: 3,
        onProgress: ({ completed, total }) => progress.push([completed, total]),
      },
    );

    assert.equal(maxActive, 3);
    assert.deepEqual(results.map((result) => result.status), [
      'fulfilled', 'fulfilled', 'fulfilled', 'rejected', 'fulfilled', 'fulfilled', 'fulfilled',
    ]);
    assert.equal(results[3].reason.message, 'expected failure');
    assert.deepEqual(progress.map(([completed]) => completed), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(progress.every(([, total]) => total === 7), true);
  });
});
