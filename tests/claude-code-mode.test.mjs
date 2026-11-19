import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { config } from '../config.mjs';
import { renderAgentSessionLaunch } from '../modules/sessions/index.mjs';
import { agentProviderPreferencesPlugin, getAgentProviderPreferences } from '../modules/agent/provider-preferences.mjs';

const run = promisify(execFile);

test('a Claude terminal launch in Code Mode gets the env var in the child and drops --remote-control', async (t) => {
  const previous = config.agentInterface.claudeRemoteControlEnabled;
  config.agentInterface.claudeRemoteControlEnabled = true;
  t.after(() => { config.agentInterface.claudeRemoteControlEnabled = previous; });
  // The pane command runs for real in bash; the agent binary is a shell function that reports what it received.
  const capture = `function fleet_agent() { node -e 'console.log(JSON.stringify({args:process.argv.slice(1),codeMode:process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE}))' -- "$@"; }; `;
  const launch = async (backendType, provider, buildOptions, resume = false) => {
    const { paneCommand } = renderAgentSessionLaunch({
      backendType, provider, resume, sessionBinary: 'fleet_agent', sessionId: 'code-mode-test',
      buildOptions: { provider, cliSessionId: 'cli-1', workDir: '/tmp', ...buildOptions },
    });
    const { stdout } = await run('bash', ['--noprofile', '--norc', '-c', capture + paneCommand], { env: { PATH: process.env.PATH } });
    return JSON.parse(stdout);
  };
  for (const resume of [false, true]) {
    const plain = await launch('claude', 'claude', {}, resume);
    assert.equal(plain.codeMode, undefined);
    assert.ok(plain.args.includes('--remote-control'), `remote control stays on without Code Mode (resume=${resume})`);
    const coded = await launch('claude', 'claude', { codeMode: true }, resume);
    assert.equal(coded.codeMode, '1');
    assert.ok(!coded.args.includes('--remote-control'), `Code Mode drops remote control (resume=${resume})`);
  }
  // Other harnesses never receive it.
  assert.equal((await launch('codex', 'codex', { codeMode: true })).codeMode, undefined);
});

test('the Code Mode default saves, loads, and rejects non-booleans', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-code-mode-prefs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storeFile = join(dir, 'preferences.json');
  const app = Fastify();
  t.after(() => app.close());
  await app.register(agentProviderPreferencesPlugin, { storeFile });
  const put = (payload) => app.inject({ method: 'PUT', url: '/api/agent-provider-preferences', payload });
  assert.equal((await app.inject('/api/agent-provider-preferences')).json().claudeCodeMode, false, 'off by default');
  assert.equal((await put({ claudeCodeMode: 'yes' })).statusCode, 400);
  const saved = await put({ claudeCodeMode: true });
  assert.equal(saved.json().claudeCodeMode, true);
  assert.equal(saved.json().claudeEnabled, true, 'other preferences are kept');
  assert.equal((await getAgentProviderPreferences({ storeFile })).claudeCodeMode, true);
  await put({ graderSampleRate: 0.5 });
  assert.equal((await getAgentProviderPreferences({ storeFile })).claudeCodeMode, true, 'an unrelated save keeps it');
  await put({ claudeCodeMode: false });
  assert.equal((await getAgentProviderPreferences({ storeFile })).claudeCodeMode, false);
});
