import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'node:test';
import {
  isProcessAlive,
  ProcessSupervisor,
  readProcessStartTime,
} from '../modules/agent/process-supervisor.mjs';

const roots = [];
const cleanupGroups = [];
afterEach(async () => {
  while (cleanupGroups.length) {
    try { process.kill(-cleanupGroups.pop(), 'SIGKILL'); } catch { /* already gone */ }
  }
  while (roots.length) await rm(roots.pop(), { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dueno-supervisor-'));
  roots.push(root);
  const work = join(root, 'work');
  await mkdir(work);
  return { root, work, ledgerPath: join(root, 'ledger.json') };
}

describe('ProcessSupervisor', () => {
  it('persists intent before spawn, binds pid/starttime, denies ambient env, and verifies termination', { timeout: 15000 }, async () => {
    const { work, ledgerPath } = await fixture();
    let persistedBeforeSpawn = false;
    const supervisor = new ProcessSupervisor({
      ledgerPath,
      spawnImpl(command, args, options) {
        const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
        persistedBeforeSpawn = ledger.entries[0].lifecycle === 'provisioning' && ledger.entries[0].pid === null;
        assert.equal(options.env.SHOULD_NOT_LEAK, undefined);
        assert.equal(options.env.PATH, '/usr/bin:/bin');
        assert.equal(options.env.DUENO_RUNTIME_INSTANCE_ID, 'runtime-1');
        return spawn(command, args, options);
      },
    });
    const runtime = await supervisor.spawn({
      instanceId: 'runtime-1', driver: 'test-structured', command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'], cwd: work,
      env: { PATH: '/usr/bin:/bin', SHOULD_NOT_LEAK: 'secret' }, allowedEnvKeys: ['PATH'],
    });
    cleanupGroups.push(runtime.containment.pgid);
    assert.equal(persistedBeforeSpawn, true);
    assert.ok(runtime.pid > 0);
    assert.ok(runtime.processStartTime);
    const verdict = await supervisor.terminate('runtime-1', { graceMs: 100 });
    assert.deepEqual(verdict, { ok: true, status: 'terminated', residual: [] });
    cleanupGroups.pop();
  });

  it('recovers the pre-bind crash window from the instance marker', { timeout: 15000 }, async () => {
    const { work, ledgerPath } = await fixture();
    const instanceId = 'prebind-crash';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: work, detached: true, stdio: 'ignore', env: { DUENO_RUNTIME_INSTANCE_ID: instanceId },
    });
    cleanupGroups.push(child.pid);
    child.unref();
    await writeFile(ledgerPath, JSON.stringify({ entries: [{
      instanceId, kind: 'structured', driver: 'test', lifecycle: 'provisioning', pid: null,
      containment: { type: 'process_group', pgid: null },
    }] }));
    const supervisor = new ProcessSupervisor({ ledgerPath });
    const report = await supervisor.init();
    assert.equal(report[0].status, 'terminated');
    assert.equal(report[0].residual.length, 0);
    assert.equal(isProcessAlive(child.pid), false);
    cleanupGroups.pop();
  });

  it('reaps only structured attempts and leaves tmux ledger entries and processes alone', { timeout: 15000 }, async () => {
    const { work, ledgerPath } = await fixture();
    const structured = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: work, detached: true, stdio: 'ignore' });
    const tmux = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: work, detached: true, stdio: 'ignore' });
    cleanupGroups.push(structured.pid, tmux.pid);
    structured.unref();
    tmux.unref();
    await writeFile(ledgerPath, JSON.stringify({ entries: [
      {
        instanceId: 'structured', driver: 'claude-stream-json', pid: structured.pid,
        processStartTime: readProcessStartTime(structured.pid), containment: { type: 'process_group', pgid: structured.pid },
      },
      {
        instanceId: 'tmux', kind: 'tmux', driver: 'tmux', pid: tmux.pid,
        processStartTime: readProcessStartTime(tmux.pid), containment: { type: 'process_group', pgid: tmux.pid },
      },
    ] }));
    const supervisor = new ProcessSupervisor({ ledgerPath });
    const report = await supervisor.init();
    assert.equal(report.some((item) => item.instanceId === 'structured' && item.status === 'terminated'), true);
    assert.equal(isProcessAlive(structured.pid), false);
    assert.equal(isProcessAlive(tmux.pid), true);
    cleanupGroups.splice(cleanupGroups.indexOf(structured.pid), 1);
  });

  it('reports unresolved, identity-mismatched, gone, and residual orphan outcomes', async () => {
    const observed = [];
    let clock = 0;
    const supervisor = new ProcessSupervisor({
      ledgerPath: null,
      now: () => { clock += 1000; return clock; },
      onOrphanReaped: (verdict, entry) => observed.push({ verdict, entry }),
    });
    await supervisor.init({ reap: false });
    supervisor.entries = [
      { instanceId: 'owned', kind: 'structured', pid: 101, containment: { type: 'process_group', pgid: 101 } },
      { instanceId: 'unresolved', kind: 'structured', lifecycle: 'provisioning', pid: null },
      {
        instanceId: 'mismatch', kind: 'structured', pid: process.pid,
        processStartTime: 'not-the-current-start-time', containment: { type: 'process_group', pgid: 202 },
      },
      { instanceId: 'gone', kind: 'structured', pid: 303, containment: { type: 'process_group', pgid: 303 } },
      { instanceId: 'residual', kind: 'structured', pid: 404, containment: { type: 'process_group', pgid: 404 } },
    ];
    supervisor.instances.set('owned', { instanceId: 'owned' });
    const originalKill = process.kill;
    process.kill = (target, signal) => {
      const numeric = Math.abs(Number(target));
      if (numeric === 303) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      if ([202, 404].includes(numeric)) return true;
      return originalKill(target, signal);
    };
    let report;
    try {
      report = await supervisor.reapOrphans();
    } finally {
      process.kill = originalKill;
    }

    assert.deepEqual(report.map(({ instanceId, status }) => [instanceId, status]), [
      ['unresolved', 'failed'],
      ['mismatch', 'failed'],
      ['gone', 'already_gone'],
      ['residual', 'failed'],
    ]);
    assert.deepEqual(report[0].residual, [{
      instanceId: 'unresolved', pid: null, pgid: null, reason: 'provisioning_unresolved',
    }]);
    assert.equal(report[1].residual[0].reason, 'process_identity_mismatch');
    assert.deepEqual(report[3].residual, [{
      instanceId: 'residual', pid: 404, pgid: 404, processStartTime: null,
    }]);
    assert.deepEqual(supervisor.entries.map((entry) => entry.instanceId), ['owned', 'unresolved', 'mismatch', 'residual']);
    assert.deepEqual(observed.map(({ verdict }) => verdict.instanceId), ['unresolved', 'mismatch', 'residual']);
  });

  it('retains provisioning processes that remain alive after TERM and KILL', { timeout: 15000 }, async () => {
    const { work, ledgerPath } = await fixture();
    const instanceId = 'prebind-residual';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: work, detached: true, stdio: 'ignore', env: { DUENO_RUNTIME_INSTANCE_ID: instanceId },
    });
    cleanupGroups.push(child.pid);
    child.unref();
    const originalKill = process.kill;
    try {
      await writeFile(ledgerPath, JSON.stringify({ entries: [{
        instanceId, kind: 'structured', driver: 'test', lifecycle: 'provisioning', pid: null,
        containment: { type: 'process_group', pgid: null },
      }] }));
      process.kill = (target, signal) => {
        if (Math.abs(Number(target)) === child.pid) return true;
        return originalKill(target, signal);
      };
      const report = await new ProcessSupervisor({ ledgerPath }).init();
      assert.equal(report[0].status, 'failed');
      assert.deepEqual(report[0].residual, [{
        instanceId, pid: child.pid, pgid: child.pid, processStartTime: readProcessStartTime(child.pid),
      }]);
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      assert.equal(ledger.entries[0].instanceId, instanceId);
    } finally {
      process.kill = originalKill;
    }
  });

  it('fails closed when spawn returns no pid', { timeout: 15000 }, async () => {
    const { work, ledgerPath } = await fixture();
    const supervisor = new ProcessSupervisor({
      ledgerPath,
      spawnTimeoutMs: 20,
      spawnImpl: () => ({ pid: null, once() {} }),
    });
    await assert.rejects(() => supervisor.spawn({
      instanceId: 'no-pid', driver: 'test-structured', command: process.execPath,
      args: ['-e', '0'], cwd: work, env: { PATH: '/usr/bin:/bin' }, allowedEnvKeys: ['PATH'],
    }), /no pid/);
  });
});
