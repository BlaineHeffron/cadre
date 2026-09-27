import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  buildClaudeHookSettings,
  CLAUDE_FLEET_HOOK_EVENTS,
  cleanupClaudeHookSettings,
  fleetHookReporterPath,
  prepareClaudeHookSettings,
} from '../modules/agent/claude-hook-settings.mjs';
import { readHookDerivedState } from '../modules/session-state/providers/hook.mjs';
import { buildAgentRuntimeLaunchArgs } from '../modules/agent/runtime-args.mjs';

const tempDirs = [];

function runReporter({ cwd, env, payload }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fleetHookReporterPath(), '--provider', 'claude'], {
      cwd,
      env,
    });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString() || `reporter exited ${code}`));
    });
    child.stdin.end(`${JSON.stringify(payload)}
`);
  });
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

describe('Claude fleet hook settings', () => {
  it('builds per-event command hooks pointing at the fleet reporter', () => {
    const settings = buildClaudeHookSettings({
      nodeBin: '/usr/bin/node',
      reporterPath: '/opt/dueno/scripts/agent-hooks/log-event.mjs',
    });
    for (const eventName of CLAUDE_FLEET_HOOK_EVENTS) {
      const command = settings.hooks[eventName][0].hooks[0].command;
      assert.match(command, /"\/usr\/bin\/node"/);
      assert.match(command, /log-event\.mjs"/);
      assert.match(command, /"--provider" "claude"/);
    }
    assert.equal(CLAUDE_FLEET_HOOK_EVENTS.includes('Stop'), true);
    assert.equal(CLAUDE_FLEET_HOOK_EVENTS.includes('SessionEnd'), true);
  });

  it('writes a settings file and Claude launch args include --settings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-hook-settings-'));
    tempDirs.push(dir);
    const previous = process.env.CADRE_STATE_DIR;
    process.env.CADRE_STATE_DIR = dir;
    try {
      const prepared = await prepareClaudeHookSettings({ sessionId: 'abc123' });
      const written = JSON.parse(await readFile(prepared.settingsPath, 'utf8'));
      assert.deepEqual(Object.keys(written.hooks).sort(), [...CLAUDE_FLEET_HOOK_EVENTS].sort());
      const args = buildAgentRuntimeLaunchArgs({
        runtime: 'claude',
        workDir: dir,
        settingsPath: prepared.settingsPath,
      });
      const settingsIndex = args.indexOf('--settings');
      assert.ok(settingsIndex >= 0);
      assert.equal(args[settingsIndex + 1], prepared.settingsPath);
      await cleanupClaudeHookSettings({ sessionId: 'abc123' });
    } finally {
      if (previous === undefined) delete process.env.CADRE_STATE_DIR;
      else process.env.CADRE_STATE_DIR = previous;
    }
  });

  it('does not add --settings for Codex or Pi launch args', () => {
    const codex = buildAgentRuntimeLaunchArgs({ runtime: 'codex', workDir: '/tmp' });
    const pi = buildAgentRuntimeLaunchArgs({ runtime: 'pi', workDir: '/tmp' });
    assert.equal(codex.includes('--settings'), false);
    assert.equal(pi.includes('--settings'), false);
  });

  it('log-event reporter writes a real hook slot bound to DUENO_SESSION_ID', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-hook-report-'));
    tempDirs.push(dir);
    await writeFile(join(dir, '.git'), 'gitdir: test\n');
    const payload = {
      hook_event_name: 'Stop',
      session_id: 'claude-cli-uuid',
      cwd: dir,
      transcript_path: join(dir, 'transcript.jsonl'),
      last_assistant_message: 'Turn complete.',
    };
    await runReporter({
      cwd: dir,
      env: {
        ...process.env,
        DUENO_SESSION_ID: 'fleet-session-1',
        DUENO_PROVIDER: 'claude',
      },
      payload,
    });
    const derived = await readHookDerivedState({
      workDir: dir,
      provider: 'claude',
      sessionId: 'fleet-session-1',
      now: Date.now(),
    });
    assert.equal(derived.source, 'hook');
    assert.equal(derived.activity, 'prompt_ready');
    assert.equal(derived.last_event_name, 'Stop');
    assert.ok(derived.ageMs < 5_000);
    assert.match(derived.statePath, /claude-fleet-session-1\.json$/);
  });
});
