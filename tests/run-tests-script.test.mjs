import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, it } from 'node:test';

const tempDirs = [];
const runner = resolve('scripts/run-tests.mjs');

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

it('runs the requested target when a test name pattern disables sharding', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-run-tests-'));
  tempDirs.push(dir);
  await mkdir(join(dir, 'tests'));
  await writeFile(join(dir, 'tests', 'selected.test.mjs'), `
    import assert from 'node:assert/strict';
    import { it } from 'node:test';
    it('selected test', () => assert.fail('selected target executed'));
  `);

  const { NODE_TEST_CONTEXT: _nodeTestContext, ...env } = process.env;
  const result = spawnSync(process.execPath, [
    runner,
    'tests/selected.test.mjs',
    '--test-name-pattern=selected test',
  ], {
    cwd: dir,
    encoding: 'utf8',
    env,
  });

  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /selected target executed/);
});
