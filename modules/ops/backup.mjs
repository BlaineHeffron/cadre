import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { Pool } from 'pg';
import { hashJson, sha256Hex } from './state-utils.mjs';
import { runtimeStateDir } from './runtime-state.mjs';
import { readEnv } from '../platform/cadre-env.mjs';

const DEFAULT_RUNTIME_STATE_FILES = [
  'calendar_tasks.json',
  'calendar_sync.json',
  'marketing_ops.json',
  'claude_sessions.json',
  'codex_sessions.json',
  'pi_sessions.json',
  'agent_provider_preferences.json',
  'google_oauth.json',
  'model_catalog_cache.json',
  'pi_model_catalog_cache.json',
  'agent_bus/state.json',
  'card_ops.json',
  'calendar_scheduler.json',
  'ops_idempotency.json',
  'ops_control_events.json',
  'ops_reconciliation.json',
  'production_controls.json',
  'synthetic_monitor_state.json',
  'github_agent_repos.json',
  'scheduled_agents.json',
  'quick_capture.json',
  'agent_session_idempotency.json',
  'fleet_incidents.json',
  'fleet_deployment_notifications.json',
  'audio_recordings.json',
  'web_push.json',
];

const DEFAULT_LEGACY_STATE_FILES = [
  '.calendar_tasks.json',
  '.calendar_sync.json',
  '.marketing_ops.json',
  '.claude_sessions.json',
  '.codex_sessions.json',
  '.pi_sessions.json',
  '.agent_provider_preferences.json',
  '.google_oauth.json',
  '.model_catalog_cache.json',
  '.pi_model_catalog_cache.json',
  '.agent_bus/state.json',
  '.card_ops.json',
  '.calendar_scheduler.json',
  '.ops_idempotency.json',
  '.ops_control_events.json',
  '.ops_reconciliation.json',
  '.production_controls.json',
  '.synthetic_monitor_state.json',
];

function stampNow(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

function normalizeBackupDir(baseDir, stamp) {
  return resolve(baseDir, stamp);
}

function normalizeRetentionDays(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function normalizeBackupSource(sourcePath) {
  const normalized = normalize(String(sourcePath || '').trim());
  if (!normalized || normalized.startsWith('..') || normalized.includes('/../') || resolve(normalized) === normalized) {
    return '';
  }
  return normalized;
}

function workspaceRelativePath(workspaceDir, targetPath) {
  const normalizedWorkspaceDir = resolve(workspaceDir);
  const normalizedTargetPath = resolve(targetPath);
  const relativePath = normalize(relative(normalizedWorkspaceDir, normalizedTargetPath));
  if (!relativePath) return '.';
  if (relativePath.startsWith('..') || relativePath.includes('/../') || resolve(relativePath) === relativePath) return '';
  return relativePath;
}

function resolveContainedPath(baseDir, relativePath) {
  const normalizedBaseDir = resolve(baseDir);
  const normalizedRelativePath = normalize(String(relativePath || '').trim());
  if (
    !normalizedRelativePath
    || normalizedRelativePath.startsWith('..')
    || normalizedRelativePath.includes('/../')
    || resolve(normalizedRelativePath) === normalizedRelativePath
  ) {
    return '';
  }
  const targetPath = resolve(normalizedBaseDir, normalizedRelativePath);
  const targetRelativePath = normalize(relative(normalizedBaseDir, targetPath));
  if (!targetRelativePath || targetRelativePath.startsWith('..') || targetRelativePath.includes('/../')) {
    return '';
  }
  return targetPath;
}

function resolveBackupRuntimeStateDir(workspaceDir, env = process.env) {
  const configuredStateDir = String(readEnv('DM_STATE_DIR', env) || '').trim();
  if (configuredStateDir) return runtimeStateDir(env);
  return resolve(workspaceDir, '.dueno/state');
}

function buildDefaultStateFiles({ workspaceDir = process.cwd(), env = process.env } = {}) {
  const runtimeDir = resolveBackupRuntimeStateDir(workspaceDir, env);
  const runtimeDirRelative = workspaceRelativePath(workspaceDir, runtimeDir);
  const runtimeState = {
    dir: runtimeDir,
    included: Boolean(runtimeDirRelative),
    reason: runtimeDirRelative ? '' : 'runtime_state_dir_outside_workspace',
  };
  const runtimeFiles = runtimeDirRelative
    ? DEFAULT_RUNTIME_STATE_FILES.map((name) => normalize(join(runtimeDirRelative === '.' ? '' : runtimeDirRelative, name)))
    : [];
  return {
    stateFiles: [...runtimeFiles, ...DEFAULT_LEGACY_STATE_FILES],
    runtimeState,
  };
}

async function readBackupManifestCreatedAt(path) {
  try {
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
    const createdAt = Date.parse(manifest?.createdAt || '');
    return Number.isFinite(createdAt) ? createdAt : null;
  } catch {
    return null;
  }
}

export async function createStateBackup({
  workspaceDir = process.cwd(),
  outputDir = resolve(process.cwd(), '.dueno', 'backups'),
  stateFiles,
  databaseUrl = process.env.DATABASE_URL || '',
  env = process.env,
  now = new Date(),
} = {}) {
  const defaultStateConfig = stateFiles ? null : buildDefaultStateFiles({ workspaceDir, env });
  const effectiveStateFiles = stateFiles || defaultStateConfig.stateFiles;
  const stamp = stampNow(now);
  const backupDir = normalizeBackupDir(outputDir, stamp);
  const jsonDir = join(backupDir, 'json');
  await mkdir(jsonDir, { recursive: true });

  const manifest = {
    createdAt: now.toISOString(),
    workspaceDir: resolve(workspaceDir),
    backupDir,
    files: [],
    runtimeState: defaultStateConfig?.runtimeState || null,
    warnings: [],
    database: {
      enabled: Boolean(databaseUrl),
      namespaceCount: 0,
      dumpFile: '',
      dumpHash: '',
    },
  };
  if (defaultStateConfig?.runtimeState && !defaultStateConfig.runtimeState.included) {
    manifest.warnings.push({
      code: 'runtime_state_dir_outside_workspace',
      message: `DM_STATE_DIR is outside workspace; runtime JSON state was not included: ${defaultStateConfig.runtimeState.dir}`,
    });
  }

  for (const stateFile of effectiveStateFiles) {
    const relativePath = normalizeBackupSource(stateFile);
    if (!relativePath) continue;
    const sourcePath = resolve(workspaceDir, relativePath);
    if (!existsSync(sourcePath)) continue;
    const targetPath = join(jsonDir, relativePath);
    await mkdir(dirname(targetPath), { recursive: true });
    await copyFile(sourcePath, targetPath);
    const raw = await readFile(targetPath);
    manifest.files.push({
      source: relativePath,
      backup: `json/${relativePath}`,
      size: raw.length,
      sha256: sha256Hex(raw),
    });
  }

  if (databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const result = await pool.query('SELECT namespace, data, updated_at FROM app_json_state ORDER BY namespace ASC');
      const dumpPath = join(backupDir, 'postgres-app-json-state.ndjson');
      const payload = result.rows.map((row) => JSON.stringify(row)).join('\n');
      await writeFile(dumpPath, payload ? `${payload}\n` : '');
      manifest.database.namespaceCount = result.rows.length;
      manifest.database.dumpFile = 'postgres-app-json-state.ndjson';
      manifest.database.dumpHash = hashJson(result.rows);
    } finally {
      await pool.end();
    }
  }

  await writeFile(join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function verifyStateBackup({ backupDir } = {}) {
  const manifestPath = resolve(backupDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const failures = [];

  for (const file of manifest.files || []) {
    const filePath = resolveContainedPath(backupDir, file.backup);
    if (!filePath) {
      failures.push(`Invalid backup file path: ${file.backup}`);
      continue;
    }
    if (!existsSync(filePath)) {
      failures.push(`Missing backup file: ${file.backup}`);
      continue;
    }
    const raw = await readFile(filePath);
    const hash = sha256Hex(raw);
    if (hash !== file.sha256) {
      failures.push(`Checksum mismatch for ${file.backup}`);
    }
  }

  if (manifest.database?.dumpFile) {
    const dumpPath = resolveContainedPath(backupDir, manifest.database.dumpFile);
    if (!dumpPath) {
      failures.push(`Invalid database dump path: ${manifest.database.dumpFile}`);
    } else if (!existsSync(dumpPath)) {
      failures.push(`Missing database dump: ${manifest.database.dumpFile}`);
    } else {
      const raw = await readFile(dumpPath, 'utf8');
      const rows = raw.trim() ? raw.trim().split('\n').map((line) => JSON.parse(line)) : [];
      const dumpHash = hashJson(rows);
      if (dumpHash !== manifest.database.dumpHash) {
        failures.push('Database dump hash mismatch');
      }
      if (rows.length !== Number(manifest.database.namespaceCount || 0)) {
        failures.push('Database dump namespace count mismatch');
      }
    }
  }

  return {
    ok: failures.length === 0,
    checkedAt: new Date().toISOString(),
    manifest,
    failures,
  };
}

export async function pruneStateBackups({
  outputDir = resolve(process.cwd(), '.dueno', 'backups'),
  retentionDays = 14,
  now = new Date(),
} = {}) {
  const normalizedRetentionDays = normalizeRetentionDays(retentionDays, 14);
  if (normalizedRetentionDays <= 0 || !existsSync(outputDir)) {
    return {
      ok: true,
      outputDir: resolve(outputDir),
      retentionDays: normalizedRetentionDays,
      cutoffAt: null,
      pruned: [],
    };
  }

  const cutoffMs = now.getTime() - (normalizedRetentionDays * 24 * 60 * 60 * 1000);
  const entries = await readdir(outputDir, { withFileTypes: true });
  const pruned = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const backupDir = resolve(outputDir, entry.name);
    const createdAtMs = await readBackupManifestCreatedAt(backupDir);
    if (!Number.isFinite(createdAtMs) || createdAtMs >= cutoffMs) continue;
    await rm(backupDir, { recursive: true, force: true });
    pruned.push(entry.name);
  }

  return {
    ok: true,
    outputDir: resolve(outputDir),
    retentionDays: normalizedRetentionDays,
    cutoffAt: new Date(cutoffMs).toISOString(),
    pruned,
  };
}

async function ensureAppJsonStateTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_json_state (
      namespace TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function restoreStateBackup({
  backupDir,
  workspaceDir = process.cwd(),
  restoreJson = true,
  restoreDatabase = false,
  databaseUrl = process.env.DATABASE_URL || '',
} = {}) {
  const verification = await verifyStateBackup({ backupDir });
  if (!verification.ok) {
    return {
      ok: false,
      checkedAt: verification.checkedAt,
      manifest: verification.manifest,
      failures: verification.failures,
      restoredFiles: [],
      database: {
        restored: false,
        namespaceCount: 0,
        skipped: true,
        reason: 'verification_failed',
      },
    };
  }

  const manifest = verification.manifest;
  const restoredFiles = [];
  const failures = [];

  if (restoreJson) {
    for (const file of manifest.files || []) {
      const sourcePath = resolveContainedPath(backupDir, file.backup);
      if (!sourcePath) {
        failures.push(`Invalid backup file path: ${file.backup}`);
        continue;
      }
      const relativePath = normalizeBackupSource(file.source);
      if (!relativePath) {
        failures.push(`Invalid backup source path: ${file.source}`);
        continue;
      }
      const targetPath = resolve(workspaceDir, relativePath);
      await mkdir(dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
      restoredFiles.push({
        source: relativePath,
        targetPath,
        sha256: file.sha256,
        size: file.size,
      });
    }
  }

  const database = {
    restored: false,
    namespaceCount: 0,
    skipped: true,
    reason: '',
  };

  if (manifest.database?.dumpFile) {
    if (!restoreDatabase) {
      database.reason = 'restore_database_disabled';
    } else if (!databaseUrl) {
      database.reason = 'missing_database_url';
      failures.push('Database restore requested but database URL is missing');
    } else {
      const pool = new Pool({ connectionString: databaseUrl });
      try {
        await ensureAppJsonStateTable(pool);
        const dumpPath = resolve(backupDir, manifest.database.dumpFile);
        const raw = await readFile(dumpPath, 'utf8');
        const rows = raw.trim() ? raw.trim().split('\n').map((line) => JSON.parse(line)) : [];
        for (const row of rows) {
          await pool.query(
            `INSERT INTO app_json_state (namespace, data, updated_at)
             VALUES ($1, $2::jsonb, COALESCE($3::timestamptz, NOW()))
             ON CONFLICT (namespace)
             DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
            [row.namespace, JSON.stringify(row.data || {}), row.updated_at || null]
          );
        }
        database.restored = true;
        database.namespaceCount = rows.length;
        database.skipped = false;
      } finally {
        await pool.end();
      }
    }
  } else {
    database.reason = 'no_database_dump';
  }

  return {
    ok: failures.length === 0,
    checkedAt: verification.checkedAt,
    manifest,
    failures,
    restoredFiles,
    database,
  };
}
