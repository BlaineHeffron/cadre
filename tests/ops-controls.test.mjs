import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateBackup, pruneStateBackups, restoreStateBackup, verifyStateBackup } from '../modules/ops/backup.mjs';
import { buildParityEntry, buildParityReport } from '../modules/ops/migration-parity.mjs';
import { getOpsMetricsRegistry, opsObservabilityPlugin } from '../modules/ops/observability.mjs';
import { hashJson, sha256Hex } from '../modules/ops/state-utils.mjs';

const tempDirs = [];

afterEach(async () => {
  getOpsMetricsRegistry().reset();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('ops controls', { concurrency: false }, () => {
  it('verifies backup artifacts with checksums', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-backup-test-'));
    tempDirs.push(dir);
    await writeFile(join(dir, '.scheduled_agents.json'), JSON.stringify({ ok: true }, null, 2));
    await writeFile(join(dir, '.calendar_tasks.json'), JSON.stringify([{ id: 'ct_1' }], null, 2));

    const manifest = await createStateBackup({
      workspaceDir: dir,
      outputDir: join(dir, 'backups'),
      stateFiles: ['.scheduled_agents.json', '.calendar_tasks.json'],
      databaseUrl: '',
    });
    const result = await verifyStateBackup({ backupDir: manifest.backupDir });
    assert.deepEqual(result.failures, []);
    assert.equal(result.manifest.files.length, 2);
  });

  it('restores backup artifacts into a target workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-backup-restore-test-'));
    tempDirs.push(dir);
    await writeFile(join(dir, '.scheduled_agents.json'), JSON.stringify({ ok: true }, null, 2));
    await writeFile(join(dir, '.calendar_tasks.json'), JSON.stringify([{ id: 'ct_1' }], null, 2));

    const manifest = await createStateBackup({
      workspaceDir: dir,
      outputDir: join(dir, 'backups'),
      stateFiles: ['.scheduled_agents.json', '.calendar_tasks.json'],
      databaseUrl: '',
    });

    const restoreDir = join(dir, 'restore-target');
    const restored = await restoreStateBackup({
      backupDir: manifest.backupDir,
      workspaceDir: restoreDir,
    });

    assert.equal(restored.ok, true);
    assert.equal(restored.restoredFiles.length, 2);
    assert.equal(JSON.parse(await readFile(join(restoreDir, '.scheduled_agents.json'), 'utf8')).ok, true);
    assert.equal(JSON.parse(await readFile(join(restoreDir, '.calendar_tasks.json'), 'utf8'))[0].id, 'ct_1');
  });

  it('includes durable automation state in default backups', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-backup-defaults-test-'));
    tempDirs.push(dir);
    await mkdir(join(dir, '.dueno', 'state'), { recursive: true });
    await writeFile(join(dir, '.dueno', 'state', 'ops_control_events.json'), JSON.stringify({ events: [{ id: 'ocev_runtime' }] }, null, 2));
    await writeFile(join(dir, '.synthetic_monitor_state.json'), JSON.stringify({ lastStatus: 'fail' }, null, 2));

    const manifest = await createStateBackup({
      workspaceDir: dir,
      outputDir: join(dir, 'backups'),
      databaseUrl: '',
      env: {},
    });

    const backedUpFiles = manifest.files.map((file) => file.source).sort();
    assert.ok(backedUpFiles.includes('.dueno/state/ops_control_events.json'));
    assert.ok(backedUpFiles.includes('.synthetic_monitor_state.json'));

    const restoreDir = join(dir, 'restore-target');
    const restored = await restoreStateBackup({
      backupDir: manifest.backupDir,
      workspaceDir: restoreDir,
    });

    assert.equal(restored.ok, true);
    assert.deepEqual(
      JSON.parse(await readFile(join(restoreDir, '.dueno', 'state', 'ops_control_events.json'), 'utf8')),
      { events: [{ id: 'ocev_runtime' }] },
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(restoreDir, '.synthetic_monitor_state.json'), 'utf8')),
      { lastStatus: 'fail' },
    );
  });

  it('uses workspace-contained DM_STATE_DIR for default runtime state backups', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-backup-custom-state-test-'));
    tempDirs.push(dir);
    const stateDir = join(dir, 'runtime-state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'ops_control_events.json'), JSON.stringify({ events: [{ id: 'ocev_custom' }] }, null, 2));

    const manifest = await createStateBackup({
      workspaceDir: dir,
      outputDir: join(dir, 'backups'),
      databaseUrl: '',
      env: { DM_STATE_DIR: stateDir },
    });

    assert.deepEqual(manifest.warnings, []);
    assert.equal(manifest.runtimeState.included, true);
    assert.ok(manifest.files.some((file) => file.source === 'runtime-state/ops_control_events.json'));

    const restoreDir = join(dir, 'restore-target');
    const restored = await restoreStateBackup({
      backupDir: manifest.backupDir,
      workspaceDir: restoreDir,
    });

    assert.equal(restored.ok, true);
    assert.deepEqual(
      JSON.parse(await readFile(join(restoreDir, 'runtime-state', 'ops_control_events.json'), 'utf8')),
      { events: [{ id: 'ocev_custom' }] },
    );
  });

  it('reports external DM_STATE_DIR instead of backing up stale .dueno runtime state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-backup-external-state-test-'));
    const externalStateDir = await mkdtemp(join(tmpdir(), 'dueno-external-state-'));
    tempDirs.push(dir, externalStateDir);
    await mkdir(join(dir, '.dueno', 'state'), { recursive: true });
    await mkdir(externalStateDir, { recursive: true });
    await writeFile(join(dir, '.dueno', 'state', 'ops_control_events.json'), JSON.stringify({ events: [{ id: 'stale' }] }, null, 2));
    await writeFile(join(externalStateDir, 'ops_control_events.json'), JSON.stringify({ events: [{ id: 'external' }] }, null, 2));

    const manifest = await createStateBackup({
      workspaceDir: dir,
      outputDir: join(dir, 'backups'),
      databaseUrl: '',
      env: { DM_STATE_DIR: externalStateDir },
    });

    assert.equal(manifest.runtimeState.included, false);
    assert.equal(manifest.runtimeState.reason, 'runtime_state_dir_outside_workspace');
    assert.match(manifest.warnings[0].message, /outside workspace/i);
    assert.equal(manifest.files.some((file) => file.source === '.dueno/state/ops_control_events.json'), false);
  });

  it('fails closed when a database restore is requested without a database URL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-backup-db-restore-test-'));
    tempDirs.push(dir);
    const backupDir = join(dir, 'backup');
    const jsonDir = join(backupDir, 'json');
    const jsonState = JSON.stringify({ ok: true }, null, 2);
    const databaseRows = [{
      namespace: 'scheduled_agents',
      data: { ok: true },
      updated_at: '2026-04-22T12:00:00.000Z',
    }];
    const dumpPayload = `${JSON.stringify(databaseRows[0])}\n`;
    await mkdir(jsonDir, { recursive: true });
    await writeFile(join(dir, '.scheduled_agents.json'), jsonState);
    await writeFile(join(backupDir, 'postgres-app-json-state.ndjson'), dumpPayload);
    await writeFile(join(backupDir, 'manifest.json'), JSON.stringify({
      createdAt: '2026-04-22T12:00:00.000Z',
      workspaceDir: dir,
      backupDir,
      files: [
        {
          source: '.scheduled_agents.json',
          backup: 'json/.scheduled_agents.json',
          size: Buffer.byteLength(jsonState),
          sha256: sha256Hex(jsonState),
        },
      ],
      database: {
        enabled: true,
        namespaceCount: 1,
        dumpFile: 'postgres-app-json-state.ndjson',
        dumpHash: hashJson(databaseRows),
      },
    }, null, 2));
    await writeFile(join(jsonDir, '.scheduled_agents.json'), jsonState);

    const restored = await restoreStateBackup({
      backupDir,
      workspaceDir: join(dir, 'restore-target'),
      restoreDatabase: true,
      databaseUrl: '',
    });

    assert.equal(restored.ok, false);
    assert.equal(restored.database.reason, 'missing_database_url');
    assert.match(restored.failures[0], /database URL is missing/i);
    assert.equal(JSON.parse(await readFile(join(dir, 'restore-target', '.scheduled_agents.json'), 'utf8')).ok, true);
  });

  it('prunes expired backup directories based on manifest age', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-backup-prune-test-'));
    tempDirs.push(dir);
    await writeFile(join(dir, '.scheduled_agents.json'), JSON.stringify({ ok: true }, null, 2));

    const backupsDir = join(dir, 'backups');
    const oldManifest = await createStateBackup({
      workspaceDir: dir,
      outputDir: backupsDir,
      stateFiles: ['.scheduled_agents.json'],
      databaseUrl: '',
      now: new Date('2026-03-01T12:00:00.000Z'),
    });
    const freshManifest = await createStateBackup({
      workspaceDir: dir,
      outputDir: backupsDir,
      stateFiles: ['.scheduled_agents.json'],
      databaseUrl: '',
      now: new Date('2026-04-15T12:00:00.000Z'),
    });

    const result = await pruneStateBackups({
      outputDir: backupsDir,
      retentionDays: 14,
      now: new Date('2026-04-22T12:00:00.000Z'),
    });

    assert.deepEqual(result.pruned, [oldManifest.backupDir.split('/').pop()]);
    const verifyOld = await verifyStateBackup({ backupDir: oldManifest.backupDir }).catch(() => null);
    const verifyFresh = await verifyStateBackup({ backupDir: freshManifest.backupDir });
    assert.equal(verifyOld, null);
    assert.equal(verifyFresh.ok, true);
  });

  it('builds a parity report with rollback gating', () => {
    const entries = [
      buildParityEntry('alpha', { ok: true }, { ok: true }),
      buildParityEntry('beta', { count: 1 }, { count: 2 }),
    ];
    const report = buildParityReport(entries, 0.75);
    assert.equal(report.total, 2);
    assert.equal(report.passed, 1);
    assert.equal(report.ok, false);
    assert.equal(report.rollbackRecommended, true);
  });

  it('exposes JSON metrics snapshots', async () => {
    const registry = getOpsMetricsRegistry();
    registry.incrementCounter('scheduled_agents_run_total', 1, { result: 'sent' });
    registry.recordTiming('calendar_scheduler_tick_duration_ms', 12, { result: 'processed' });
    registry.registerGauge('calendar_scheduler_lag_ms', () => 5000);

    const app = Fastify();
    await app.register(opsObservabilityPlugin);
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/ops/metrics' });
    assert.equal(res.statusCode, 200);
    assert.ok(res.json().counters.some((item) => item.name === 'scheduled_agents_run_total'));
    assert.ok(res.json().gauges.some((item) => item.name === 'calendar_scheduler_lag_ms'));
    await app.close();
  });

  it('wires the dashboard page to the ops summary panel', async () => {
    const source = await readFile(new URL('../public/pages/dashboard.mjs', import.meta.url), 'utf8');
    assert.match(source, /Outages, Fleet Errors, Threats/);
    assert.match(source, /\/ops\/summary/);
    assert.match(source, /replayEligibleCount/);
    assert.match(source, /Open Collab/);
  });
});
