import assert from 'node:assert/strict';
import { test } from 'node:test';

test('host env does not reach test processes', () => {
  assert.equal(process.env.RESEARCH_WORKBENCH_PAPER_SEARCH_PATH, undefined);
  assert.equal(process.env.CADRE_SESSION_ID, undefined);
  assert.match(process.env.HOME, /cadre-test-home-/);
});
