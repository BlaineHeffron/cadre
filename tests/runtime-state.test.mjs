import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildPostgresJsonStore } from '../modules/ops/postgres-json-store.mjs';
import { legacyRootStatePath, runtimeStatePath } from '../modules/ops/runtime-state.mjs';

const tempDirs = [];
const originalCwd = process.cwd();

afterEach(async () => {
  process.chdir(originalCwd);
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-runtime-state-'));
  tempDirs.push(dir);
  return dir;
}

describe('runtime state paths', () => {
  it('defaults runtime state under .dueno/state and honors DM_STATE_DIR', () => {
    assert.equal(runtimeStatePath('codex_sessions.json', {}), resolve('.dueno/state/codex_sessions.json'));
    assert.equal(
      runtimeStatePath('codex_sessions.json', { DM_STATE_DIR: '/tmp/custom-dueno-state' }),
      '/tmp/custom-dueno-state/codex_sessions.json',
    );
  });

  it('loads legacy root JSON once and writes future saves to runtime state', async () => {
    const dir = await makeTempDir();
    process.chdir(dir);
    await writeFile(legacyRootStatePath('example_state.json'), JSON.stringify({ ok: true }, null, 2));

    const store = buildPostgresJsonStore({
      namespace: 'example_state',
      filePath: runtimeStatePath('example_state.json'),
      legacyFilePath: legacyRootStatePath('example_state.json'),
    });

    assert.deepEqual(await store.load(), { ok: true });
    assert.equal(existsSync(runtimeStatePath('example_state.json')), true);

    await store.save({ ok: false });
    assert.deepEqual(JSON.parse(await readFile(runtimeStatePath('example_state.json'), 'utf8')), { ok: false });
    assert.deepEqual(JSON.parse(await readFile(legacyRootStatePath('example_state.json'), 'utf8')), { ok: true });
  });

  it('gives each test file run by npm test a fresh state dir outside the checkout, removed even on failure', async () => {
    const checkout = await makeTempDir();
    const checkoutEvents = join(checkout, '.dueno/state/ops_control_events.json');
    const existing = JSON.stringify({ events: Array.from({ length: 10000 }, (_, i) => ({ id: `ocev_${i}`, detail: 'x'.repeat(200) })) });
    await mkdir(join(checkout, '.dueno/state'), { recursive: true });
    await writeFile(checkoutEvents, existing);
    const probe = (name, fail) => `
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync } from 'node:fs';
import { buildOpsControlEventStore } from ${JSON.stringify(resolve('modules/ops/control-events.mjs'))};
import { runtimeStateDir } from ${JSON.stringify(resolve('modules/ops/runtime-state.mjs'))};
test('${name}', async () => {
  appendFileSync('state-dirs.txt', runtimeStateDir() + '\\n');
  const store = buildOpsControlEventStore({ env: {} });
  assert.deepEqual(await store.listEvents(), []);
  await store.recordEvent({ type: 'probe', module: 'test', action: 'run' });
  assert.ok(existsSync(runtimeStateDir() + '/ops_control_events.json'));
  ${fail ? "assert.fail('deliberate failure');" : ''}
});
`;
    await writeFile(join(checkout, 'a.test.mjs'), probe('a'));
    await writeFile(join(checkout, 'b.test.mjs'), probe('b', true));
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const run = spawnSync(process.execPath, [resolve('scripts/run-tests.mjs'), 'a.test.mjs', 'b.test.mjs'], {
      cwd: checkout, env: { ...env, CADRE_STATE_DIR: join(checkout, '.dueno/state') }, encoding: 'utf8',
    });

    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /# pass 1\n# fail 1\n/);
    const dirs = (await readFile(join(checkout, 'state-dirs.txt'), 'utf8')).trim().split('\n');
    assert.equal(new Set(dirs).size, 2);
    for (const dir of dirs) {
      assert.ok(!dir.startsWith(checkout), dir);
      assert.equal(existsSync(dir), false);
    }
    assert.equal(await readFile(checkoutEvents, 'utf8'), existing);
  });
});
