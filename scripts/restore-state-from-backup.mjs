import { resolve } from 'node:path';
import { restoreStateBackup } from '../modules/ops/backup.mjs';
import { normalizeBoolean, normalizeText, parseArgs } from './ops-cli-utils.mjs';

async function main() {
  const args = parseArgs();
  const rawBackupDir = normalizeText(args['backup-dir'] || process.argv[2] || process.env.BACKUP_RESTORE_DIR || '');
  if (!rawBackupDir) {
    throw new Error('Usage: node scripts/restore-state-from-backup.mjs --backup-dir <backup-dir> [--workspace-dir <dir>] [--restore-db true]');
  }

  const backupDir = resolve(rawBackupDir);
  const workspaceDir = resolve(normalizeText(args['workspace-dir'] || process.env.BACKUP_RESTORE_WORKSPACE_DIR || process.cwd()));
  const restoreDatabase = normalizeBoolean(args['restore-db'] ?? process.env.BACKUP_RESTORE_DB, false);
  const databaseUrl = normalizeText(args['database-url'] || process.env.BACKUP_RESTORE_DATABASE_URL || process.env.DATABASE_URL || '');
  const result = await restoreStateBackup({
    backupDir,
    workspaceDir,
    restoreDatabase,
    databaseUrl,
  });

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
