import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { chmod, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSessionStateTracker,
  PROCESS_LIFECYCLE_FRESH_MS,
  sessionStateTracker,
} from '../modules/session-state/tracker.mjs';
import { observeProcessLiveness } from '../modules/session-state/providers/process.mjs';

function identities(entries) {
  return new Map(Object.entries(entries));
}

function childrenFrom(tree) {
  return async (pid) => tree[String(pid)] || [];
}

function execTmux(handlers) {
  return async (command, args) => {
    assert.equal(command, 'tmux');
    const handle = handlers[args[0]];
    if (typeof handle === 'function') return handle(args);
    if (handle && typeof handle === 'object') return handle;
    return { code: 1, stdout: '', stderr: 'unused' };
  };
}

describe('tmux process liveness observations', () => {
  it('writes running only while a CLI pid is live in the pane tree', async () => {
    const live = identities({
      4242: { pid: '4242', state: 'S', starttime: '1', cmdline: 'codex --cd /tmp' },
    });
    const execFn = execTmux({
      'list-panes': { code: 0, stdout: '4242\n' },
    });
    const running = await observeProcessLiveness({
      sessionName: 'codex-live',
      now: 1_000,
      execFn,
      expectedCli: 'codex',
      readIdentityFn: async (pid) => live.get(String(pid)) || null,
      listChildrenFn: async () => [],
    });
    assert.equal(running[0].value.lifecycle, 'running');
    assert.equal(running[0].expiresAt, 1_000 + PROCESS_LIFECYCLE_FRESH_MS);

    live.delete('4242');
    const dead = await observeProcessLiveness({
      sessionName: 'codex-live',
      now: 1_100,
      execFn,
      expectedCli: 'codex',
      readIdentityFn: async (pid) => live.get(String(pid)) || null,
      listChildrenFn: async () => [],
    });
    assert.equal(dead[0].value.lifecycle, 'missing');
  });

  it('treats a live wrapper shell without a CLI child as missing', async () => {
    const missing = await observeProcessLiveness({
      sessionName: 'codex-dead-cli',
      now: 1_000,
      execFn: execTmux({ 'list-panes': { code: 0, stdout: '7\n' } }),
      expectedCli: 'codex',
      readIdentityFn: async (pid) => {
        if (String(pid) === '7') {
          return {
            pid: '7',
            state: 'S',
            cmdline: 'bash -lc export DUENO_FOO=1; unset CLAUDECODE; exec 2> >(tee -a log >&2)',
          };
        }
        if (String(pid) === '8') return { pid: '8', state: 'S', cmdline: 'tee -a log' };
        return null;
      },
      listChildrenFn: childrenFrom({ 7: ['8'], 8: [] }),
    });
    assert.equal(missing[0].value.lifecycle, 'missing');
    assert.equal(missing[0].expiresAt, 0);
  });

  it('drops send grants when process evidence expires without a new capture', async () => {
    let clock = 1_000;
    const tracker = createSessionStateTracker({ now: () => clock });
    const live = identities({
      4242: { pid: '4242', state: 'S', starttime: '1', cmdline: 'codex --cd /tmp' },
    });
    const execFn = execTmux({
      'list-panes': { code: 0, stdout: '4242\n' },
    });

    tracker.observe('pid-session', await observeProcessLiveness({
      sessionName: 'codex-live',
      now: clock,
      execFn,
      expectedCli: 'codex',
      readIdentityFn: async (pid) => live.get(String(pid)) || null,
      listChildrenFn: async () => [],
    }));
    assert.equal(tracker.get('pid-session').lifecycle, 'running');
    assert.equal(tracker.get('pid-session').capabilities.canQueueMessage, true);

    live.delete('4242');
    clock += PROCESS_LIFECYCLE_FRESH_MS;
    const expired = tracker.get('pid-session');
    assert.equal(expired.lifecycle, 'running');
    assert.equal(expired.capabilities.canQueueMessage, false);
    assert.equal(expired.capabilities.canSendNow, false);

    const recapture = await observeProcessLiveness({
      sessionName: 'codex-live',
      now: clock,
      execFn,
      expectedCli: 'codex',
      readIdentityFn: async (pid) => live.get(String(pid)) || null,
      listChildrenFn: async () => [],
    });
    const afterKill = tracker.observe('pid-session', recapture);
    assert.notEqual(afterKill.lifecycle, 'running');
    tracker.remove('pid-session');
  });

  it('does not treat a hook Stop event as process death', async () => {
    const tracker = createSessionStateTracker({ now: () => 5_000 });
    const processObs = await observeProcessLiveness({
      sessionName: 'claude-live',
      now: 5_000,
      execFn: execTmux({ 'list-panes': { code: 0, stdout: '9\n' } }),
      expectedCli: 'claude',
      readIdentityFn: async (pid) => {
        if (String(pid) === '9') return { pid: '9', state: 'S', cmdline: 'bash -lc claude' };
        if (String(pid) === '10') {
          return { pid: '10', state: 'S', cmdline: 'claude --dangerously-skip-permissions' };
        }
        return null;
      },
      listChildrenFn: childrenFrom({ 9: ['10'], 10: [] }),
    });
    tracker.observe('hook-stop', [
      ...processObs,
      {
        source: 'hook',
        kind: 'lifecycle',
        value: { lifecycle: 'running' },
        observedAt: 5_000,
        expiresAt: 5_000 + PROCESS_LIFECYCLE_FRESH_MS,
        fingerprint: 'hook-lifecycle:running:Stop',
      },
      {
        source: 'hook',
        kind: 'execution',
        value: { execution: 'idle', activity: 'done_idle' },
        observedAt: 5_000,
        expiresAt: 5_000 + 90_000,
        fingerprint: 'hook-execution:done_idle:Stop',
      },
    ]);
    const snapshot = tracker.get('hook-stop');
    assert.equal(processObs[0].source, 'process');
    assert.equal(snapshot.lifecycle, 'running');
    assert.equal(snapshot.capabilities.canQueueMessage, true);
    tracker.remove('hook-stop');
  });

  it('omits process evidence when the tmux probe throws', async () => {
    const observations = await observeProcessLiveness({
      sessionName: 'codex-flaky',
      now: 1_000,
      execFn: async () => {
        throw new Error('tmux lost server');
      },
    });
    assert.deepEqual(observations, []);
  });

  it('omits process evidence when the session name is empty', async () => {
    const observations = await observeProcessLiveness({
      sessionName: '',
      now: 1_000,
      execFn: async () => ({ code: 0, stdout: '1\n' }),
    });
    assert.deepEqual(observations, []);
  });
});

describe('session evidence process and Pi transcripts', () => {
  const tempDirs = [];
  const previousHome = process.env.HOME;
  let homeDir;
  let createAgentSessionsProvider;
  let canonicalSessionStateId;
  let piTranscriptDir;

  after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  async function loadSessions() {
    if (createAgentSessionsProvider) return;
    homeDir = await mkdtemp(join(tmpdir(), 'dueno-issue-166-home-'));
    tempDirs.push(homeDir);
    process.env.HOME = homeDir;
    process.env.APP_STATE_STORAGE = 'file';
    process.env.DATABASE_URL = '';
    process.env.PI_SESSIONS_STORAGE = 'file';
    ({
      createAgentSessionsProvider,
      canonicalSessionStateId,
    } = await import('../modules/sessions/index.mjs'));
    ({ piTranscriptDir } = await import('../modules/telegram/binding.mjs'));
  }

  async function withFakeTmux(script, fn) {
    const binDir = await mkdtemp(join(tmpdir(), 'dueno-fake-tmux-'));
    tempDirs.push(binDir);
    await writeFile(join(binDir, 'tmux'), `#!/bin/sh\n${script}\n`);
    await chmod(join(binDir, 'tmux'), 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath || '/usr/bin'}`;
    try {
      return await fn();
    } finally {
      process.env.PATH = previousPath;
    }
  }

  it('marks a captured pane missing when its pid is dead', async () => {
    await loadSessions();
    const provider = createAgentSessionsProvider('codex');
    const trackerId = canonicalSessionStateId('codex', 'dead-pid');
    sessionStateTracker.remove(trackerId);
    const { canonicalState } = await withFakeTmux([
      'cmd="$1"',
      'case "$cmd" in',
      '  capture-pane) printf "ready\\n"; exit 0 ;;',
      '  list-panes) echo 42424242; exit 0 ;;',
      'esac',
      'exit 1',
    ].join('\n'), async () => provider.getSessionState({
      id: 'dead-pid',
      tmuxSession: 'codex-dead-pid',
      name: 'codex-dead-pid',
      workDir: homeDir,
    }));
    assert.notEqual(canonicalState.lifecycle, 'running');
    assert.equal(canonicalState.capabilities.canQueueMessage, false);
    sessionStateTracker.remove(trackerId);
  });

  it('does not synthesize missing when the liveness probe cannot run', async () => {
    await loadSessions();
    const provider = createAgentSessionsProvider('codex');
    const trackerId = canonicalSessionStateId('codex', 'flaky-probe');
    sessionStateTracker.remove(trackerId);
    const { canonicalState } = await withFakeTmux([
      'cmd="$1"',
      'case "$cmd" in',
      '  capture-pane) printf "ready\\n"; exit 0 ;;',
      '  list-panes) echo "lost server" >&2; exit 2 ;;',
      'esac',
      'exit 1',
    ].join('\n'), async () => provider.getSessionState({
      id: 'flaky-probe',
      tmuxSession: 'codex-flaky',
      name: 'codex-flaky',
      workDir: homeDir,
    }));
    assert.notEqual(canonicalState.lifecycle, 'missing');
    assert.notEqual(canonicalState.status, 'ended');
    sessionStateTracker.remove(trackerId);
  });

  it('observes a known Pi transcript path even with readNativeHookState false', async () => {
    await loadSessions();
    const tempDir = await mkdtemp(join(tmpdir(), 'dueno-pi-transcript-'));
    tempDirs.push(tempDir);
    const transcriptPath = join(tempDir, 'pi.jsonl');
    await writeFile(transcriptPath, `${JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    })}\n`);

    const trackerId = canonicalSessionStateId('pi', 'pi-transcript');
    sessionStateTracker.remove(trackerId);
    const provider = createAgentSessionsProvider('pi');
    const { canonicalState } = await provider.getSessionState({
      id: 'pi-transcript',
      source: 'bare-process',
      transcriptPath,
      workDir: tempDir,
    });

    const explained = sessionStateTracker.explain(trackerId);
    assert.equal(explained.observations.some((item) => item.source === 'transcript'), true);
    assert.equal(explained.observations.some((item) => item.source === 'hook'), false);
    assert.equal(canonicalState.executionSource, 'transcript');
    sessionStateTracker.remove(trackerId);
  });

  it('resolves a Pi transcript from cliSessionId when no path is stored', async () => {
    await loadSessions();
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-pi-cwd-'));
    tempDirs.push(workDir);
    const cliSessionId = 'piCliSess01';
    const sessionsDir = piTranscriptDir(join(homeDir, '.pi', 'agent'), workDir);
    await mkdir(sessionsDir, { recursive: true });
    const transcriptPath = join(sessionsDir, `2026-01-01T00-00-00_${cliSessionId}.jsonl`);
    await writeFile(transcriptPath, [
      JSON.stringify({ type: 'session', id: cliSessionId, cwd: workDir }),
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'from cli id' }] },
      }),
      '',
    ].join('\n'));

    const trackerId = canonicalSessionStateId('pi', 'pi-cli-path');
    sessionStateTracker.remove(trackerId);
    const provider = createAgentSessionsProvider('pi');
    const { canonicalState } = await provider.getSessionState({
      id: 'pi-cli-path',
      source: 'bare-process',
      cliSessionId,
      workDir,
      runtime: 'pi',
    });

    const explained = sessionStateTracker.explain(trackerId);
    assert.equal(explained.observations.some((item) => item.source === 'transcript'), true);
    assert.equal(explained.observations.some((item) => item.source === 'hook'), false);
    assert.equal(canonicalState.executionSource, 'transcript');
    sessionStateTracker.remove(trackerId);
  });
});
