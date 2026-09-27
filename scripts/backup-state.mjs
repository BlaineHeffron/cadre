import { resolve } from 'node:path';
import { createStateBackup, pruneStateBackups } from '../modules/ops/backup.mjs';
import { parseArgs } from './ops-cli-utils.mjs';

const args = parseArgs();
const outputDir = resolve(process.env.BACKUP_OUTPUT_DIR || '.dueno/backups');
const retentionDays = Number(args['retention-days'] || process.env.BACKUP_RETENTION_DAYS || 14);
const manifest = await createStateBackup({
  workspaceDir: process.cwd(),
  outputDir,
  databaseUrl: process.env.DATABASE_URL || '',
});
const retention = await pruneStateBackups({
  outputDir,
  retentionDays,
});

console.log(JSON.stringify({
  ok: true,
  backupDir: manifest.backupDir,
  files: manifest.files.length,
  databaseNamespaces: manifest.database.namespaceCount,
  retentionDays: retention.retentionDays,
  prunedBackups: retention.pruned,
}, null, 2));
