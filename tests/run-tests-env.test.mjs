import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

const fixture = 'tests/fixtures/run-tests-env/env.test.mjs';
const { NODE_TEST_CONTEXT, ...env } = process.env;
const hostEnv = { ...env, RESEARCH_WORKBENCH_PAPER_SEARCH_PATH: '/nonexistent', CADRE_SESSION_ID: 'host-session' };
const run = (args) => spawnSync(process.execPath, args, { env: hostEnv, encoding: 'utf8' });

describe('scripts/run-tests.mjs environment', () => {
  it('fails the fixture when host vars reach it directly', () => {
    assert.notEqual(run(['--test', fixture]).status, 0);
  });

  it('keeps host vars and HOME out of test processes', () => {
    const result = run(['scripts/run-tests.mjs', fixture]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
});
