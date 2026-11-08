import test from 'node:test';
import assert from 'node:assert/strict';
import { foldJournalEvent } from '../modules/sessions/session-rollup.mjs';

const usage = (event) => ({ type: 'transport.event', data: { disposition: 'applied', event: { type: 'usage', ...event } } });

test('codex usage deltas sum as uncached input, skip unchanged resends, and have no cost; claude cost survives a process restart', () => {
  const resent = usage({ inputTokens: 7, cachedInputTokens: 3, outputTokens: 2 });
  const codex = [usage({ inputTokens: 5, cachedInputTokens: 2, cacheWriteInputTokens: 1, outputTokens: 1 }), resent, resent, usage({ inputTokens: 7, cachedInputTokens: 3, outputTokens: 2, reasoningOutputTokens: 1 })]
    .reduce(foldJournalEvent, null);
  assert.deepEqual([codex.inputTokens, codex.cacheReadTokens, codex.cacheWriteTokens, codex.outputTokens, codex.costUsd], [11, 8, 1, 5, null]);
  const claude = [0.5, 0.75, 0.25, 0.5].map((costUsd) => usage({ costUsd })).reduce(foldJournalEvent, null);
  assert.equal(claude.costUsd, 1.25);
});
