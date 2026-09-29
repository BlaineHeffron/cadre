import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const text = normalizeText(value).toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes') return true;
  if (text === 'false' || text === '0' || text === 'no') return false;
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createPool(env = process.env) {
  const connectionString = normalizeText(env.DATABASE_URL || '');
  if (!connectionString) return null;
  const module = await import('pg');
  const Pool = module?.Pool;
  if (!Pool) throw new Error('pg.Pool is unavailable');
  const sslEnabled = normalizeBoolean(env.DATABASE_SSL, false);
  return new Pool({
    connectionString,
    ...(sslEnabled ? { ssl: { rejectUnauthorized: false } } : {}),
  });
}

export function buildPostgresJsonStore({
  namespace,
  filePath,
  legacyFilePath,
  env = process.env,
  modeEnvKey = 'APP_STATE_STORAGE',
  bootstrapFromFile,
  keepFileMirror,
  createPoolImpl = createPool,
  onWriteError,
} = {}) {
  const normalizedNamespace = normalizeText(namespace || '').toLowerCase();
  if (!normalizedNamespace) throw new Error('namespace is required');
  const mode = normalizeText(env[modeEnvKey] || env.APP_STATE_STORAGE || '').toLowerCase() || 'file';
  const effectiveBootstrapFromFile = normalizeBoolean(
    bootstrapFromFile ?? env.APP_STATE_PG_BOOTSTRAP_FROM_FILE ?? env.PG_BOOTSTRAP_FROM_FILE,
    true,
  );
  const effectiveKeepFileMirror = normalizeBoolean(
    keepFileMirror ?? env.APP_STATE_PG_KEEP_FILE_MIRROR ?? env.PG_KEEP_FILE_MIRROR,
    true,
  );
  let poolPromise = null;
  let fileWriteChain = Promise.resolve();
  let fileWriteCounter = 0;

  async function getPool() {
    if (!poolPromise) poolPromise = createPoolImpl(env);
    return poolPromise;
  }

  async function ensureSchema(pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_json_state (
        namespace TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  function parseStateJson(raw) {
    const data = JSON.parse(raw);
    // Session and scheduled-send stores persist arrays; only scalars and null
    // are corrupt state.
    if (!data || typeof data !== 'object') {
      const error = new Error('corrupt json state');
      error.code = 'STATE_CORRUPT';
      throw error;
    }
    return data;
  }

  async function readPathJson(path) {
    if (!path) return null;
    try {
      return parseStateJson(await readFile(path, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  function readPathJsonSync(path) {
    if (!path) return null;
    try {
      return parseStateJson(readFileSync(path, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function readFileJson() {
    const current = await readPathJson(filePath);
    if (current) return current;
    const legacy = await readPathJson(legacyFilePath);
    if (legacy && filePath) await queueFileWrite(legacy);
    return legacy;
  }

  function readFileJsonSync() {
    return readPathJsonSync(filePath) || readPathJsonSync(legacyFilePath);
  }

  async function writeFileJson(data) {
    if (!filePath) return;
    const targetDir = dirname(filePath);
    const tempFile = join(
      targetDir,
      `.${basename(filePath)}.${process.pid}.${Date.now()}.${fileWriteCounter += 1}.tmp`,
    );
    const serialized = Buffer.from(`${JSON.stringify(data)}\n`);
    await mkdir(targetDir, { recursive: true });
    await writeFile(tempFile, serialized);
    await rename(tempFile, filePath);
    return serialized.length;
  }

  async function queueFileWrite(data) {
    const nextWrite = fileWriteChain.then(() => writeFileJson(data));
    fileWriteChain = nextWrite.catch((err) => {
      if (typeof onWriteError === 'function') onWriteError(err);
    });
    return nextWrite;
  }

  async function withDirectoryLock(lockPath, fn) {
    const startedAt = Date.now();
    const timeoutMs = 10000;
    while (true) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const info = await stat(lockPath).catch(() => null);
        if (info && Date.now() - info.mtimeMs > timeoutMs) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => {});
          continue;
        }
        if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for lock: ${lockPath}`);
        await sleep(25);
      }
    }
    try {
      return await fn();
    } finally {
      await rm(lockPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function readPostgresJson() {
    const pool = await getPool();
    if (!pool) throw new Error('DATABASE_URL is required when APP_STATE_STORAGE=postgres');
    await ensureSchema(pool);
    const result = await pool.query(
      'SELECT data FROM app_json_state WHERE namespace = $1 LIMIT 1',
      [normalizedNamespace]
    );
    return result?.rows?.[0]?.data || null;
  }

  async function writePostgresJson(data) {
    const pool = await getPool();
    if (!pool) throw new Error('DATABASE_URL is required when APP_STATE_STORAGE=postgres');
    await ensureSchema(pool);
    await pool.query(
      `INSERT INTO app_json_state (namespace, data, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (namespace)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [normalizedNamespace, JSON.stringify(data || {})]
    );
  }

  async function mutateFileJson(mutator) {
    await fileWriteChain.catch(() => {});
    if (!filePath) {
      const result = await mutator(null);
      return result?.result;
    }
    await mkdir(dirname(filePath), { recursive: true });
    return withDirectoryLock(`${filePath}.lock`, async () => {
      const current = await readFileJson();
      const mutation = await mutator(current);
      if (mutation?.data !== undefined) await writeFileJson(mutation.data);
      return mutation?.result;
    });
  }

  async function mutatePostgresJson(mutator) {
    const pool = await getPool();
    if (!pool) throw new Error('DATABASE_URL is required when APP_STATE_STORAGE=postgres');
    const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
    try {
      await client.query('BEGIN');
      await ensureSchema(client);
      await client.query(
        `INSERT INTO app_json_state (namespace, data, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (namespace) DO NOTHING`,
        [normalizedNamespace, '{}']
      );
      const result = await client.query(
        'SELECT data FROM app_json_state WHERE namespace = $1 FOR UPDATE',
        [normalizedNamespace]
      );
      const current = result?.rows?.[0]?.data || null;
      const mutation = await mutator(current);
      if (mutation?.data !== undefined) {
        await client.query(
          'UPDATE app_json_state SET data = $2::jsonb, updated_at = NOW() WHERE namespace = $1',
          [normalizedNamespace, JSON.stringify(mutation.data || {})]
        );
        if (effectiveKeepFileMirror) await queueFileWrite(mutation.data);
      }
      await client.query('COMMIT');
      return mutation?.result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      if (typeof client.release === 'function') client.release();
    }
  }

  return {
    mode,
    namespace: normalizedNamespace,
    loadSync() {
      return readFileJsonSync();
    },
    async load() {
      if (mode !== 'postgres') return readFileJson();
      const fromDb = await readPostgresJson();
      if (fromDb && typeof fromDb === 'object') {
        if (effectiveKeepFileMirror) await writeFileJson(fromDb);
        return fromDb;
      }
      if (effectiveBootstrapFromFile) {
        const fromFile = await readFileJson();
        if (fromFile && typeof fromFile === 'object') {
          await writePostgresJson(fromFile);
          return fromFile;
        }
      }
      return null;
    },
    async save(data) {
      if (mode === 'postgres') {
        await writePostgresJson(data);
        return effectiveKeepFileMirror ? queueFileWrite(data) : undefined;
      }
      return queueFileWrite(data);
    },
    async mutate(mutator) {
      if (typeof mutator !== 'function') throw new Error('mutator is required');
      if (mode === 'postgres') return mutatePostgresJson(mutator);
      return mutateFileJson(mutator);
    },
    async close() {
      const pool = await getPool();
      if (pool && typeof pool.end === 'function') {
        await pool.end();
      }
    },
  };
}
