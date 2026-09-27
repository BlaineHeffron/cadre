import { resolve } from 'node:path';
import { verifyStateBackup } from '../modules/ops/backup.mjs';

const rawBackupDir = process.argv[2] || process.env.BACKUP_VERIFY_DIR || '';
if (!rawBackupDir.trim()) {
  console.error('Usage: node scripts/verify-backup-restore.mjs <backup-dir>');
  process.exit(1);
}
const backupDir = resolve(rawBackupDir);

const result = await verifyStateBackup({ backupDir });
console.log(JSON.stringify(result, null, 2));
if (!result.ok) {
  process.exit(1);
}
