import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createKeyedSingleFlight } from '../modules/sessions/keyed-single-flight.mjs';

describe('session keyed single flight', () => {
  it('makes concurrent callers await the same cleanup', async () => {
    let finishCleanup;
    let calls = 0;
    const cleanup = createKeyedSingleFlight(async () => {
      calls += 1;
      await new Promise((resolve) => { finishCleanup = resolve; });
      return 'removed';
    });

    const first = cleanup('session-1');
    const second = cleanup('session-1');
    let secondFinished = false;
    second.finally(() => { secondFinished = true; });

    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(secondFinished, false);

    finishCleanup();
    assert.equal(await first, 'removed');
    assert.equal(await second, 'removed');
    assert.equal(secondFinished, true);
  });

  it('allows a new cleanup after the prior cleanup settles', async () => {
    let calls = 0;
    const cleanup = createKeyedSingleFlight(async () => ++calls);

    assert.equal(await cleanup('session-1'), 1);
    await Promise.resolve();
    assert.equal(await cleanup('session-1'), 2);
  });

  it('shares failures and permits a retry', async () => {
    let calls = 0;
    const cleanup = createKeyedSingleFlight(async () => {
      calls += 1;
      if (calls === 1) throw new Error('cleanup failed');
      return 'removed';
    });

    const first = cleanup('session-1');
    const second = cleanup('session-1');
    await assert.rejects(first, /cleanup failed/);
    await assert.rejects(second, /cleanup failed/);
    await Promise.resolve();
    assert.equal(await cleanup('session-1'), 'removed');
  });
});
