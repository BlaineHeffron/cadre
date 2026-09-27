import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { buildPostgresJsonStore } from '../modules/ops/postgres-json-store.mjs';
import { buildParityEntry, buildParityReport } from '../modules/ops/migration-parity.mjs';
import { legacyRootStatePath, runtimeStatePath } from '../modules/ops/runtime-state.mjs';

const baseEnv = {
  ...process.env,
  APP_STATE_STORAGE: 'postgres',
};

if (!baseEnv.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const mappings = [
  { namespace: 'claude_sessions', filePath: runtimeStatePath('claude_sessions.json'), legacyFilePath: legacyRootStatePath('claude_sessions.json') },
  { namespace: 'codex_sessions', filePath: runtimeStatePath('codex_sessions.json'), legacyFilePath: legacyRootStatePath('codex_sessions.json') },
  { namespace: 'pi_sessions', filePath: runtimeStatePath('pi_sessions.json'), legacyFilePath: legacyRootStatePath('pi_sessions.json') },
  { namespace: 'agent_provider_preferences', filePath: runtimeStatePath('agent_provider_preferences.json'), legacyFilePath: legacyRootStatePath('agent_provider_preferences.json') },
  { namespace: 'model_catalog_cache', filePath: runtimeStatePath('model_catalog_cache.json'), legacyFilePath: legacyRootStatePath('model_catalog_cache.json') },
  { namespace: 'pi_model_catalog_cache', filePath: runtimeStatePath('pi_model_catalog_cache.json'), legacyFilePath: legacyRootStatePath('pi_model_catalog_cache.json') },
  { namespace: 'agent_bus_state', filePath: runtimeStatePath('agent_bus/state.json'), legacyFilePath: resolve('.agent_bus/state.json') },
];

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    parityThreshold: Number(process.env.MIGRATION_PARITY_THRESHOLD || 1),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--parity-threshold') {
      options.parityThreshold = Number(argv[index + 1] || options.parityThreshold);
      index += 1;
    }
  }
  return options;
}

function existingStatePath(filePath, legacyFilePath) {
  if (existsSync(filePath)) return filePath;
  if (legacyFilePath && existsSync(legacyFilePath)) return legacyFilePath;
  return filePath;
}

async function migrateNamespace({ namespace, filePath, legacyFilePath }) {
  const store = buildPostgresJsonStore({
    namespace,
    filePath,
    legacyFilePath,
    env: baseEnv,
    modeEnvKey: 'APP_STATE_STORAGE',
    bootstrapFromFile: true,
    keepFileMirror: true,
  });
  try {
    const sourcePath = existingStatePath(filePath, legacyFilePath);
    const sourceValue = existsSync(sourcePath) ? JSON.parse(readFileSync(sourcePath, 'utf8')) : null;
    if (sourceValue && typeof sourceValue === 'object') {
      await store.save(sourceValue);
    }
    const targetValue = await store.load();
    const parityEntry = buildParityEntry(namespace, sourceValue, targetValue);
    const size = existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8').length : 0;
    return {
      migrated: Boolean(sourceValue && typeof sourceValue === 'object'),
      size,
      parityEntry,
    };
  } finally {
    await store.close();
  }
}

const options = parseArgs();
const entries = [];
let migrated = 0;

for (const mapping of mappings) {
  const result = await migrateNamespace(mapping);
  if (result.migrated) migrated += 1;
  entries.push(result.parityEntry);
  console.log(`${result.migrated ? 'migrated' : 'skipped'} ${mapping.namespace} (${result.size} bytes from ${mapping.filePath})`);
}

const report = buildParityReport(entries, options.parityThreshold);

console.log(JSON.stringify({
  migratedNamespaces: migrated,
  parityScore: report.parityScore,
  threshold: report.threshold,
  ok: report.ok,
  rollbackRecommended: report.rollbackRecommended,
  failedNamespaces: report.entries.filter((entry) => !entry.matches).map((entry) => entry.namespace),
}, null, 2));

if (!report.ok) {
  process.exit(2);
}
