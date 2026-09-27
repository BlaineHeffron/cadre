import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPostgresJsonStore } from '../modules/ops/postgres-json-store.mjs';

const tempDirs = [];

async function makeTempDir(prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createFakePool({ rows = [] } = {}) {
  const state = {
    rows,
    writes: [],
  };
  return {
    state,
    async query(sql, params = []) {
      const normalizedSql = String(sql || '').trim();
      if (normalizedSql.startsWith('CREATE TABLE')) return { rows: [] };
      if (normalizedSql.startsWith('SELECT data FROM app_json_state')) {
        return { rows: state.rows };
      }
      if (normalizedSql.startsWith('INSERT INTO app_json_state')) {
        const payload = JSON.parse(String(params[params.length - 1] || '{}'));
        state.writes.push(payload);
        state.rows = [{ data: payload }];
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in test double: ${normalizedSql}`);
    },
    async end() {},
  };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('postgres sandbox storage controls', () => {
  it('does not mirror postgres-backed json store data into the file when disabled', async () => {
    const dir = await makeTempDir('dueno-pg-store-');
    const filePath = join(dir, 'state.json');
    await writeFile(filePath, `${JSON.stringify({ stale: true })}\n`);
    const pool = createFakePool({ rows: [{ data: { fromDb: true } }] });

    const store = buildPostgresJsonStore({
      namespace: 'test',
      filePath,
      env: {
        DATABASE_URL: 'postgres://sandbox/test',
        APP_STATE_STORAGE: 'postgres',
        APP_STATE_PG_BOOTSTRAP_FROM_FILE: '0',
        APP_STATE_PG_KEEP_FILE_MIRROR: '0',
      },
      createPoolImpl: async () => pool,
    });

    const loaded = await store.load();
    assert.deepEqual(loaded, { fromDb: true });
    assert.equal(await readFile(filePath, 'utf8'), `${JSON.stringify({ stale: true })}\n`);

    await store.save({ fromDb: 'updated' });
    assert.deepEqual(pool.state.writes.at(-1), { fromDb: 'updated' });
    assert.equal(await readFile(filePath, 'utf8'), `${JSON.stringify({ stale: true })}\n`);
  });

  it('keeps file-backed JSON valid while concurrent saves are in flight', async () => {
    const dir = await makeTempDir('dueno-file-store-');
    const filePath = join(dir, 'state.json');
    const store = buildPostgresJsonStore({
      namespace: 'concurrent-test',
      filePath,
      env: {
        APP_STATE_STORAGE: 'file',
      },
    });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.save({
        sequence: index,
        payload: `value-${index}`.repeat(200),
      }))
    );

    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    assert.equal(typeof parsed.sequence, 'number');
    assert.match(parsed.payload, /^value-/);
  });

  it('treats missing files as empty and refuses corrupt or unreadable state', async () => {
    const dir = await makeTempDir('dueno-pg-store-');
    const missing = buildPostgresJsonStore({
      namespace: 'test',
      filePath: join(dir, 'missing.json'),
      env: { APP_STATE_STORAGE: 'file' },
    });
    assert.equal(await missing.load(), null);

    const brokenPath = join(dir, 'broken.json');
    await writeFile(brokenPath, '{broken');
    const broken = buildPostgresJsonStore({
      namespace: 'test',
      filePath: brokenPath,
      env: { APP_STATE_STORAGE: 'file' },
    });
    await assert.rejects(() => broken.load());

    const arrayPath = join(dir, 'array.json');
    await writeFile(arrayPath, '[{"id":"one"}]');
    const shaped = buildPostgresJsonStore({
      namespace: 'test',
      filePath: arrayPath,
      env: { APP_STATE_STORAGE: 'file' },
    });
    assert.deepEqual(await shaped.load(), [{ id: 'one' }]);

    const scalarPath = join(dir, 'scalar.json');
    await writeFile(scalarPath, '42');
    const scalar = buildPostgresJsonStore({
      namespace: 'test',
      filePath: scalarPath,
      env: { APP_STATE_STORAGE: 'file' },
    });
    await assert.rejects(() => scalar.load(), { code: 'STATE_CORRUPT' });

    const parent = join(dir, 'as-file');
    await writeFile(parent, 'not-a-dir');
    const enotdir = buildPostgresJsonStore({
      namespace: 'test',
      filePath: join(parent, 'child.json'),
      env: { APP_STATE_STORAGE: 'file' },
    });
    await assert.rejects(() => enotdir.load());
  });
});
