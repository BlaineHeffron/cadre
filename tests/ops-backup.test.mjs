import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  createStateBackup,
  pruneStateBackups,
  restoreStateBackup,
  verifyStateBackup,
} from '../modules/ops/backup.mjs';
import { sha256Hex } from '../modules/ops/state-utils.mjs';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function makeTempWorkspace(prefix = 'dueno-ops-backup-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe('ops backup integrity', { concurrency: false }, () => {
  it('records manifest sha256 values over the exact backed-up bytes', async () => {
    const dir = await makeTempWorkspace();
    const statePayload = Buffer.from('{"message":"hello","bytes":[0,1,255]}\n', 'utf8');
    await writeFile(join(dir, '.scheduled_agents.json'), statePayload);

    const manifest = await createStateBackup({
      workspaceDir: dir,
      outputDir: join(dir, 'backups'),
      stateFiles: ['.scheduled_agents.json'],
      databaseUrl: '',
      now: new Date('2026-07-02T12:00:00.000Z'),
    });

    const file = manifest.files.find((entry) => entry.source === '.scheduled_agents.json');
    assert.ok(file);
    const backedUpBytes = await readFile(join(manifest.backupDir, file.backup));
    assert.equal(file.sha256, createHash('sha256').update(backedUpBytes).digest('hex'));
    assert.equal(file.sha256, sha256Hex(backedUpBytes));
  });

  it('refuses restore before writing files when a backup file was tampered', async () => {
    const dir = await makeTempWorkspace();
    await writeFile(join(dir, '.scheduled_agents.json'), '{"ok":true}\n');
    const manifest = await createStateBackup({
      workspaceDir: dir,
      outputDir: join(dir, 'backups'),
      stateFiles: ['.scheduled_agents.json'],
      databaseUrl: '',
    });
    await writeFile(join(manifest.backupDir, 'json', '.scheduled_agents.json'), '{"ok":false}\n');

    const restoreDir = join(dir, 'restore-target');
    const restored = await restoreStateBackup({
      backupDir: manifest.backupDir,
      workspaceDir: restoreDir,
    });

    assert.equal(restored.ok, false);
    assert.deepEqual(restored.restoredFiles, []);
    assert.match(restored.failures.join('\n'), /Checksum mismatch/);
    assert.equal(existsSync(join(restoreDir, '.scheduled_agents.json')), false);
  });

  it('rejects manifest paths that escape the backup or restore workspace', async () => {
    const dir = await makeTempWorkspace();
    const backupDir = join(dir, 'backup');
    await mkdir(backupDir, { recursive: true });
    await writeFile(join(dir, 'outside.json'), '{"outside":true}\n');
    await writeFile(join(backupDir, 'manifest.json'), JSON.stringify({
      createdAt: '2026-07-02T12:00:00.000Z',
      workspaceDir: dir,
      backupDir,
      files: [{
        source: '../escaped.json',
        backup: '../outside.json',
        size: 17,
        sha256: sha256Hex('{"outside":true}\n'),
      }],
      database: {
        enabled: true,
        namespaceCount: 0,
        dumpFile: '../outside.ndjson',
        dumpHash: sha256Hex('[]'),
      },
    }, null, 2));

    const verified = await verifyStateBackup({ backupDir });
    assert.equal(verified.ok, false);
    assert.match(verified.failures.join('\n'), /Invalid backup file path/);
    assert.match(verified.failures.join('\n'), /Invalid database dump path/);

    const restored = await restoreStateBackup({
      backupDir,
      workspaceDir: join(dir, 'restore-target'),
      restoreDatabase: true,
      databaseUrl: '',
    });
    assert.equal(restored.ok, false);
    assert.deepEqual(restored.restoredFiles, []);
  });

  it('prunes only backup directories older than the retention cutoff', async () => {
    const dir = await makeTempWorkspace();
    await writeFile(join(dir, '.scheduled_agents.json'), '{"ok":true}\n');
    const outputDir = join(dir, 'backups');

    const expired = await createStateBackup({
      workspaceDir: dir,
      outputDir,
      stateFiles: ['.scheduled_agents.json'],
      databaseUrl: '',
      now: new Date('2026-06-01T00:00:00.000Z'),
    });
    const retained = await createStateBackup({
      workspaceDir: dir,
      outputDir,
      stateFiles: ['.scheduled_agents.json'],
      databaseUrl: '',
      now: new Date('2026-06-25T00:00:00.000Z'),
    });

    const pruned = await pruneStateBackups({
      outputDir,
      retentionDays: 14,
      now: new Date('2026-07-02T00:00:00.000Z'),
    });

    assert.deepEqual(pruned.pruned, [basename(expired.backupDir)]);
    assert.equal(existsSync(expired.backupDir), false);
    assert.equal(existsSync(retained.backupDir), true);
  });
});
