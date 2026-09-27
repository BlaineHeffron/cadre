import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ascendOwnedCliRoot,
  findProcessIdentitiesByEnvironment,
  readProcessEnvironmentValue,
  readProcIdentity,
  snapshotProcessTrees,
  terminateVerifiedProcesses,
} from '../modules/agent/process-termination.mjs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

function identity(pid, starttime = `start-${pid}`, overrides = {}) {
  return { pid: String(pid), ppid: '0', state: 'S', starttime, cmdline: '/usr/bin/codex', ...overrides };
}

function fakeProcessState(entries) {
  const state = new Map(entries.map((entry) => [entry.pid, entry]));
  return {
    state,
    read: async (pid) => state.get(String(pid)) || null,
  };
}

describe('verified process termination', () => {
  it('reads only the requested environment value', async () => {
    const value = await readProcessEnvironmentValue('42', 'DUENO_SESSION_ID', {
      readFileImpl: async () => Buffer.from('SECRET=hidden\0DUENO_SESSION_ID=abc12345\0'),
    });
    assert.equal(value, 'abc12345');
  });

  it('snapshots a complete process tree from one proc pass, deepest first', async () => {
    const values = new Map([
      ['10', identity(10, 'a', { ppid: '1' })],
      ['11', identity(11, 'b', { ppid: '10' })],
      ['12', identity(12, 'c', { ppid: '11' })],
      ['20', identity(20, 'd', { ppid: '1' })],
    ]);
    const result = await snapshotProcessTrees(['10'], {
      readdirImpl: async () => [...values.keys()],
      readIdentityFn: async (pid) => values.get(String(pid)) || null,
    });
    assert.deepEqual(result.map((entry) => entry.pid), ['12', '11', '10']);
  });

  it('reads PID starttime as the process identity token', async () => {
    const fields = ['S', '1', ...Array(17).fill('0'), '987654'];
    const stat = `42 (codex worker) ${fields.join(' ')}`;
    const result = await readProcIdentity('42', {
      readFileImpl: async (path) => path.endsWith('/cmdline') ? '/usr/bin/codex\0resume\0' : stat,
    });

    assert.deepEqual(result, {
      pid: '42',
      ppid: '1',
      state: 'S',
      starttime: '987654',
      cmdline: '/usr/bin/codex resume',
    });
  });

  it('uses bounded TERM then KILL and verifies exit', async () => {
    const processState = fakeProcessState([identity(100)]);
    const signals = [];
    const result = await terminateVerifiedProcesses([identity(100)], {
      readIdentityFn: processState.read,
      killFn(pid, signal) {
        signals.push([pid, signal]);
        if (signal === 'SIGKILL') processState.state.delete(String(pid));
      },
      sleepFn: async () => {},
      termGraceMs: 0,
      killGraceMs: 0,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(signals, [[100, 'SIGTERM'], [100, 'SIGKILL']]);
  });

  it('rescans after TERM and kills a late process', async () => {
    const processState = fakeProcessState([identity(100)]);
    const signals = [];
    const late = identity(101);
    const result = await terminateVerifiedProcesses([identity(100)], {
      readIdentityFn: processState.read,
      killFn(pid, signal) {
        signals.push([pid, signal]);
        processState.state.delete(String(pid));
      },
      rescanFn: async () => {
        processState.state.set(late.pid, late);
        return [late];
      },
      sleepFn: async () => {},
      termGraceMs: 0,
      killGraceMs: 0,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(signals, [[100, 'SIGTERM'], [101, 'SIGKILL']]);
  });

  it('never signals a PID whose starttime changed', async () => {
    const processState = fakeProcessState([identity(100, 'replacement')]);
    const signals = [];
    const result = await terminateVerifiedProcesses([identity(100, 'original')], {
      readIdentityFn: processState.read,
      killFn: (...args) => signals.push(args),
      termGraceMs: 0,
      killGraceMs: 0,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(signals, []);
  });

  it('reports EPERM survivors with their PID', async () => {
    const processState = fakeProcessState([identity(100)]);
    const result = await terminateVerifiedProcesses([identity(100)], {
      readIdentityFn: processState.read,
      killFn() {
        const error = new Error('not permitted');
        error.code = 'EPERM';
        throw error;
      },
      sleepFn: async () => {},
      termGraceMs: 0,
      killGraceMs: 0,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not_owner');
    assert.equal(result.residual[0].pid, 100);
  });

  it('treats zombies as gone and refuses a final rescan containing itself', async () => {
    const zombieState = fakeProcessState([identity(100, 'same', { state: 'Z' })]);
    const zombie = await terminateVerifiedProcesses([identity(100, 'same')], {
      readIdentityFn: zombieState.read,
      killFn: () => assert.fail('zombie was signaled'),
      termGraceMs: 0,
      killGraceMs: 0,
    });
    assert.equal(zombie.ok, true);

    const own = identity(process.pid);
    const processState = fakeProcessState([identity(100), own]);
    const guarded = await terminateVerifiedProcesses([identity(100)], {
      readIdentityFn: processState.read,
      killFn(pid) { processState.state.delete(String(pid)); },
      rescanFn: async () => [own],
      termGraceMs: 0,
      killGraceMs: 0,
    });
    assert.equal(guarded.ok, false);
    assert.equal(guarded.reason, 'self_reference');
  });

  it('stops root ascent at a same-CLI sibling supervisor', async () => {
    const seed = identity(300, 'seed', { ppid: '200', cmdline: '/usr/bin/codex native' });
    const parent = identity(200, 'parent', { ppid: '100', cmdline: 'node /opt/codex/bin/codex' });
    const sibling = identity(301, 'sibling', { ppid: '200', cmdline: '/usr/bin/codex native' });
    const processState = fakeProcessState([seed, parent, sibling]);

    const root = await ascendOwnedCliRoot(seed.pid, 'codex', {
      readIdentityFn: processState.read,
      childPidsFn: async (pid) => pid === parent.pid ? [seed.pid, sibling.pid] : [],
    });

    assert.equal(root.pid, seed.pid);
  });

  it('finds and terminates a real reparentable tree by Dueno session identity', async () => {
    const sessionId = `test-${randomBytes(6).toString('hex')}`;
    const child = spawn('bash', ['-lc', "trap '' TERM; sleep 30 & wait"], {
      env: { ...process.env, DUENO_SESSION_ID: sessionId },
      stdio: 'ignore',
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const initial = await findProcessIdentitiesByEnvironment('DUENO_SESSION_ID', sessionId);
      assert.ok(initial.some((entry) => entry.pid === String(child.pid)));
      const result = await terminateVerifiedProcesses(initial, {
        rescanFn: () => findProcessIdentitiesByEnvironment('DUENO_SESSION_ID', sessionId),
        termGraceMs: 50,
        killGraceMs: 1000,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(await findProcessIdentitiesByEnvironment('DUENO_SESSION_ID', sessionId), []);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});
