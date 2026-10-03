import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { CLAUDE_FLEET_PLUGIN_DIR } from '../modules/agent/hook-events.mjs';
import { readHookDerivedState } from '../modules/session-state/providers/hook.mjs';
import { buildAgentRuntimeLaunchArgs, buildAgentRuntimeResumeArgs } from '../modules/agent/runtime-args.mjs';

const tempDirs = [];

function runReporter({ cwd, env, payload }) {
  return new Promise((resolve, reject) => {
    // The plugin runs the reporter beside its own folder (hooks/register.ts).
    const child = spawn(process.execPath, [join(CLAUDE_FLEET_PLUGIN_DIR, '..', 'log-event.mjs'), '--provider', 'claude'], {
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

describe('Claude fleet plugin', () => {
  it('loads the fleet plugin for Claude launches and resumes only', () => {
    for (const build of [buildAgentRuntimeLaunchArgs, buildAgentRuntimeResumeArgs]) {
      const args = build({ runtime: 'claude', workDir: '/tmp', cliSessionId: 'abc' });
      assert.equal(args[args.indexOf('--plugin-dir') + 1], CLAUDE_FLEET_PLUGIN_DIR);
    }
    for (const runtime of ['codex', 'pi']) {
      assert.equal(buildAgentRuntimeLaunchArgs({ runtime, workDir: '/tmp' }).includes('--plugin-dir'), false);
    }
  });

  it('log-event reporter writes a real hook slot bound to CADRE_SESSION_ID', async () => {
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
        CADRE_SESSION_ID: 'fleet-session-1',
        CADRE_PROVIDER: 'claude',
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
