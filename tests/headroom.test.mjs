import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import Fastify from 'fastify';
import { agentProviderPreferencesPlugin, getAgentProviderPreferences } from '../modules/agent/provider-preferences.mjs';
import { headroomLaunchOverrides, prepareHeadroomLaunch } from '../modules/agent/headroom.mjs';
import { renderAgentSessionLaunch } from '../modules/sessions/index.mjs';
import { headroomPiModels } from '../modules/integrations/pi-headroom-extension.mjs';

test('Headroom defaults on, persists off/on through settings, and rejects invalid toggles', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-headroom-prefs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storeFile = join(dir, 'preferences.json');
  const app = Fastify();
  t.after(() => app.close());
  await app.register(agentProviderPreferencesPlugin, { storeFile });
  assert.equal((await app.inject('/api/agent-provider-preferences')).json().headroomEnabled, true);
  for (const headroomEnabled of [false, true]) {
    const response = await app.inject({ method: 'PUT', url: '/api/agent-provider-preferences', payload: { headroomEnabled } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().headroomEnabled, headroomEnabled);
    assert.equal((await getAgentProviderPreferences({ storeFile })).headroomEnabled, headroomEnabled);
    assert.equal(response.json().codexEnabled, true);
  }
  assert.equal((await app.inject({ method: 'PUT', url: '/api/agent-provider-preferences', payload: { headroomEnabled: 'false' } })).statusCode, 400);
});

test('launch preflight verifies the local service; off and smoke modes bypass it', async (t) => {
  let ready = true;
  let requests = 0;
  let upstream = 'https://api.deepseek.com';
  const server = createServer((_req, res) => {
    requests++;
    res.end(JSON.stringify({ service: 'headroom-proxy', ready, version: '0.37.0',
      deployment: { profile: 'dueno-fleet' }, config: { openai_api_url: upstream } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const options = { env: { PORT: '4310' }, preferences: { headroomEnabled: true }, baseUrl };
  for (const provider of ['claude', 'codex', 'deepseek', 'xai', 'google', 'opencode-go', 'openrouter']) {
    assert.deepEqual(await prepareHeadroomLaunch(provider, options), headroomLaunchOverrides(provider, baseUrl));
  }
  ready = false;
  await assert.rejects(prepareHeadroomLaunch('claude', options), { code: 'headroom_unavailable', statusCode: 503 });
  ready = true;
  upstream = 'https://api.openai.com';
  await assert.rejects(prepareHeadroomLaunch('deepseek', options), { code: 'headroom_unavailable' });
  const count = requests;
  assert.deepEqual(await prepareHeadroomLaunch('claude', { ...options, preferences: { headroomEnabled: false } }), { env: {}, args: [] });
  assert.deepEqual(await prepareHeadroomLaunch('claude', { ...options, env: { DUENO_DISABLE_SIDE_EFFECTS: '1' } }), { env: {}, args: [] });
  assert.deepEqual(await prepareHeadroomLaunch('antigravity', options), { env: {}, args: [] });
  assert.equal(requests, count);
  assert.throws(() => headroomLaunchOverrides('claude', 'https://example.com'), /loopback/);
});

test('fresh and resumed launches deliver endpoint overrides to the actual child only when enabled', async () => {
  const run = promisify(execFile);
  const capture = `function fleet_agent() { node -e 'console.log(JSON.stringify({args:process.argv.slice(1),anthropic:process.env.ANTHROPIC_BASE_URL,suggest:process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION,openai:process.env.OPENAI_BASE_URL,pi:process.env.DUENO_HEADROOM_URL}))' -- "$@"; }; `;
  for (const [backendType, provider] of [['claude', 'claude'], ['codex', 'codex'], ['pi', 'xai']]) {
    for (const resume of [false, true]) {
      for (const enabled of [false, true]) {
        const { paneCommand } = renderAgentSessionLaunch({
          backendType, provider, resume, sessionBinary: 'fleet_agent', sessionId: 'test-headroom',
          headroom: enabled ? headroomLaunchOverrides(provider) : undefined,
          buildOptions: { provider, cliSessionId: 'test-resume', workDir: '/tmp' },
        });
        const { stdout } = await run('bash', ['--noprofile', '--norc', '-c', capture + paneCommand], { env: { PATH: process.env.PATH } });
        const child = JSON.parse(stdout);
        const endpoint = backendType === 'claude' ? child.anthropic : backendType === 'codex' ? child.openai : child.pi;
        assert.equal(Boolean(endpoint), enabled);
        if (backendType === 'codex') {
          assert.ok(child.args.includes(`model_provider="${enabled ? 'dueno-headroom' : 'openai'}"`));
          if (enabled) assert.ok(child.args.includes('model_providers.dueno-headroom.base_url="http://127.0.0.1:8787/v1"'));
        }
        if (enabled && backendType === 'pi') assert.ok(child.args.some((arg) => arg.endsWith('/pi-headroom-extension.mjs')));
        if (backendType === 'claude') assert.equal(child.suggest, enabled ? 'false' : undefined);
        if (resume) assert.ok(child.args.includes('test-resume'));
      }
    }
  }
});

test('installed Codex loads the Headroom launch config and rejects the reserved provider ID', async (t) => {
  // Codex 0.154+ refuses `model_providers.openai.*` at config load, which killed every Fleet
  // Codex spawn. `features list` exits non-zero on that error without any model call.
  const run = promisify(execFile);
  const dir = await mkdtemp(join(tmpdir(), 'dueno-headroom-codex-home-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, CODEX_HOME: dir };
  try {
    await run('codex', ['--version'], { env });
  } catch {
    t.skip('codex CLI not installed');
    return;
  }
  await run('codex', [...headroomLaunchOverrides('codex').args, 'features', 'list'], { env });
  await assert.rejects(run('codex', ['-c', 'model_providers.openai.base_url="http://127.0.0.1:8787/v1"', 'features', 'list'], { env }),
    /reserved built-in provider/);
});

test('Pi routing preserves mixed wire formats, metadata, and upstream path prefixes', () => {
  const models = [
    { id: 'a', api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/go/v1', reasoning: true },
    { id: 'b', api: 'anthropic-messages', baseUrl: 'https://opencode.ai/zen/go', contextWindow: 1000000 },
    { id: 'c', api: 'google-generative-ai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  ];
  const mapped = headroomPiModels(models, 'http://127.0.0.1:8787');
  assert.deepEqual(mapped.map((m) => m.baseUrl), ['http://127.0.0.1:8787/v1', 'http://127.0.0.1:8787', 'http://127.0.0.1:8787/v1beta']);
  assert.deepEqual(mapped.map((m) => m.headers['x-headroom-base-url']), ['https://opencode.ai/zen/go', 'https://opencode.ai/zen/go', 'https://generativelanguage.googleapis.com']);
  assert.equal(mapped[0].reasoning, true);
  assert.equal(mapped[1].contextWindow, 1000000);
  assert.equal(models[0].baseUrl, 'https://opencode.ai/zen/go/v1');
});

test('settings toggle enables the Headroom unit, stops it only when idle, and a failure only warns', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-headroom-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  let code = 0;
  let users = { code: 0, stdout: '0\n' };
  const app = Fastify();
  t.after(() => app.close());
  await app.register(agentProviderPreferencesPlugin, {
    storeFile: join(dir, 'preferences.json'),
    exec: async (cmd, args) => {
      if (cmd === 'bash') { assert.match(args[0], /scripts\/headroom-users\.sh$/); return users; }
      calls.push([cmd, ...args].join(' '));
      return { code, stdout: '', stderr: 'boom' };
    },
  });
  const put = (payload) => app.inject({ method: 'PUT', url: '/api/agent-provider-preferences', payload });
  assert.equal((await put({ headroomEnabled: false })).statusCode, 200);
  assert.equal((await put({ headroomEnabled: true })).statusCode, 200);
  users = { code: 0, stdout: '3\n' };
  await put({ headroomEnabled: false });
  users = { code: 1, stdout: '' };
  await put({ headroomEnabled: false });
  await put({ piEnabled: true });
  code = 1;
  users = { code: 0, stdout: '0\n' };
  const failed = await put({ headroomEnabled: false });
  assert.equal(failed.statusCode, 200);
  assert.equal(failed.json().headroomEnabled, false);
  assert.deepEqual(calls, [
    'systemctl --user disable --now dueno-headroom.service',
    'systemctl --user enable --now dueno-headroom.service',
    'systemctl --user disable dueno-headroom.service',
    'systemctl --user disable dueno-headroom.service',
    'systemctl --user disable --now dueno-headroom.service',
  ]);
});

test('install script stops the unit only when no process uses it, disables it when off, and starts it otherwise', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-headroom-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  const log = join(dir, 'calls.log');
  await mkdir(join(dir, '.local/bin'), { recursive: true });
  await mkdir(bin);
  const stub = (body) => `#!/usr/bin/env bash\n${body}\n`;
  await writeFile(join(dir, '.local/bin/headroom'), stub("echo 'headroom, version 0.37.0'"), { mode: 0o755 });
  await writeFile(join(bin, 'systemctl'), stub(`echo "systemctl $*" >> "${log}"`), { mode: 0o755 });
  await writeFile(join(bin, 'curl'), stub('exit 0'), { mode: 0o755 });
  const prefs = join(dir, 'preferences.json');
  const proc = join(dir, 'proc');
  const fakeProcess = async (pid, ...vars) => {
    await mkdir(join(proc, pid), { recursive: true });
    await writeFile(join(proc, pid, 'environ'), `${['HOME=/home/agent', ...vars].join('\0')}\0`);
  };
  const run = async (headroomEnabled) => {
    await writeFile(prefs, `${JSON.stringify({ codex: true, headroomEnabled })}\n`);
    await rm(log, { force: true });
    const { stdout } = await promisify(execFile)('bash', ['scripts/install-headroom-service.sh'], {
      env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: join(dir, 'config'), PATH: `${bin}:${process.env.PATH}`,
        AGENT_PROVIDER_PREFERENCES_FILE: prefs, HEADROOM_PROC_DIR: proc },
    });
    return [...(await readFile(log, 'utf8')).trim().split('\n'), stdout.trim()];
  };
  await mkdir(proc);
  assert.deepEqual(await run(false), ['systemctl --user disable dueno-headroom.service',
    'Headroom is disabled in Settings; dueno-headroom.service left running for an unknown number of process(es) still using it.']);
  await fakeProcess('100', 'ANTHROPIC_BASE_URL=http://127.0.0.1:8787');
  await fakeProcess('101', 'OPENAI_BASE_URL=http://127.0.0.1:8787/v1');
  await fakeProcess('102', 'ANTHROPIC_BASE_URL=https://api.anthropic.com');
  assert.deepEqual(await run(false), ['systemctl --user disable dueno-headroom.service',
    'Headroom is disabled in Settings; dueno-headroom.service left running for 2 process(es) still using it.']);
  await rm(join(proc, '100'), { recursive: true });
  await rm(join(proc, '101'), { recursive: true });
  assert.deepEqual(await run(false), ['systemctl --user disable --now dueno-headroom.service',
    'Headroom is disabled in Settings; dueno-headroom.service stopped.']);
  assert.deepEqual(await run(true), [
    'systemctl --user daemon-reload',
    'systemctl --user enable dueno-headroom.service',
    'systemctl --user restart dueno-headroom.service',
    '',
  ]);
});
