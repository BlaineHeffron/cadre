import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    assert.equal(runtimeStatePath('codex_sessions.json'), resolve('.dueno/state/codex_sessions.json'));
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
});
