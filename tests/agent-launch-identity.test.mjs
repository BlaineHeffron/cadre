import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildLaunchEnvPrefix, duenoOriginator } from '../modules/agent/launch-env.mjs';
import { buildAgentRuntimeLaunchArgs, buildAgentRuntimeResumeArgs } from '../modules/agent/runtime-args.mjs';
import { validatePiCliContract } from '../modules/sessions/index.mjs';

describe('codex launch identity', () => {
  it('disables update dialogs for launches and resumes', () => {
    for (const build of [buildAgentRuntimeLaunchArgs, buildAgentRuntimeResumeArgs]) {
      const args = build({ runtime: 'codex', workDir: '/tmp', cliSessionId: 'uuid-1' });
      const index = args.indexOf('check_for_update_on_startup=false');
      assert.ok(index > 0);
      assert.equal(args[index - 1], '-c');
    }
  });

  it('stamps the dueno session id into the codex originator', () => {
    const prefix = buildLaunchEnvPrefix('84325d24', 'codex');
    assert.match(prefix, /export DUENO_SESSION_ID='?84325d24'?/);
    assert.match(prefix, /export CODEX_INTERNAL_ORIGINATOR_OVERRIDE='?dueno-84325d24'?/);
  });

  it('treats the openai provider alias as codex', () => {
    assert.match(buildLaunchEnvPrefix('84325d24', 'openai'), /CODEX_INTERNAL_ORIGINATOR_OVERRIDE/);
  });

  it('does not stamp an originator for claude', () => {
    const prefix = buildLaunchEnvPrefix('77e575cd', 'claude');
    assert.match(prefix, /export DUENO_SESSION_ID='?77e575cd'?/);
    assert.doesNotMatch(prefix, /CODEX_INTERNAL_ORIGINATOR_OVERRIDE/);
  });

  it('omits the originator when there is no session id', () => {
    assert.equal(duenoOriginator(''), '');
    assert.doesNotMatch(buildLaunchEnvPrefix('', 'codex'), /CODEX_INTERNAL_ORIGINATOR_OVERRIDE/);
  });
});

describe('claude launch identity', () => {
  const workDir = '/home/dev/projects/fleet';

  it('pins the transcript filename with --session-id when one is assigned', () => {
    const args = buildAgentRuntimeLaunchArgs({ runtime: 'claude', workDir, cliSessionId: 'uuid-1' });
    const index = args.indexOf('--session-id');
    assert.ok(index >= 0, '--session-id must be passed');
    assert.equal(args[index + 1], 'uuid-1');
  });

  it('omits --session-id when no id is assigned', () => {
    const args = buildAgentRuntimeLaunchArgs({ runtime: 'claude', workDir });
    assert.ok(!args.includes('--session-id'));
  });

  // Claude exits with "Session ID ... is already in use" if an existing id is passed on launch,
  // so a resume must carry --resume alone.
  it('never combines --session-id with --resume', () => {
    const args = buildAgentRuntimeResumeArgs({ runtime: 'claude', workDir, cliSessionId: 'uuid-1' });
    assert.ok(args.includes('--resume'));
    assert.equal(args[args.indexOf('--resume') + 1], 'uuid-1');
    assert.ok(!args.includes('--session-id'), '--session-id on resume would collide with the existing transcript');
  });

  it('does not pass --session-id to codex, which has no such flag', () => {
    const args = buildAgentRuntimeLaunchArgs({ runtime: 'codex', workDir, cliSessionId: 'uuid-1' });
    assert.ok(!args.includes('--session-id'));
  });
});

describe('pi launch identity', () => {
  const workDir = '/home/dev/projects/fleet';

  it('keeps provider and model separate and pins the exact session identity', () => {
    const args = buildAgentRuntimeLaunchArgs({
      runtime: 'pi',
      workDir,
      provider: 'openrouter',
      model: 'openai/gpt-5.5',
      thinkingLevel: 'high',
      cliSessionId: 'dueno.pi-1',
      args: ['Initial prompt'],
    });

    assert.deepEqual(args, [
      '--approve',
      '--provider', 'openrouter',
      '--model', 'openai/gpt-5.5',
      '--session-id', 'dueno.pi-1',
      '--thinking', 'high',
      'Initial prompt',
    ]);
  });

  it('resumes through exact --session-id without the interactive resume picker', () => {
    const args = buildAgentRuntimeResumeArgs({
      runtime: 'pi',
      provider: 'openai',
      model: 'gpt-5.5',
      cliSessionId: 'dueno-pi-2',
    });

    assert.equal(args[args.indexOf('--session-id') + 1], 'dueno-pi-2');
    assert.ok(!args.includes('--resume'));
  });

  it('requires an exact session id to resume', () => {
    assert.throws(
      () => buildAgentRuntimeResumeArgs({ runtime: 'pi' }),
      /Pi resume requires a CLI session id/,
    );
  });

  it('rejects canonical Node-based Pi installs on unsupported Node runtimes', async () => {
    let piExecuted = false;
    await assert.rejects(
      () => validatePiCliContract('/tmp/pi', {
        readFileImpl: async () => '#!/usr/bin/env node\n',
        nodeVersion: 'v22.18.0',
        execImpl: async () => {
          piExecuted = true;
          return { code: 1, stdout: '', stderr: 'Pi requires Node.js 22.19.0 or newer' };
        },
      }),
      (error) => error.code === 'pi_node_version_incompatible' && error.statusCode === 503,
    );
    assert.equal(piExecuted, false, 'Node preflight must run before Pi');
  });

  it('accepts the pinned Pi and Node contract', async () => {
    await validatePiCliContract('/tmp/pi', {
      readFileImpl: async () => '#!/usr/bin/env node\n',
      nodeVersion: 'v22.19.0',
      execImpl: async () => ({ code: 0, stdout: 'pi 0.80.7', stderr: '' }),
    });
  });
});
