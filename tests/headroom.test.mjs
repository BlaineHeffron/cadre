import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
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
