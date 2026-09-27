// Opt-in wire test: HEADROOM_BIN=/absolute/path/headroom PI_SDK_PATH=/path/to/pi-coding-agent/dist/index.js
// node --test tests/integration/headroom.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import headroomPi from '../../modules/integrations/pi-headroom-extension.mjs';

test('real Headroom and Pi preserve routing, auth, streaming and first-turn model selection', {
  skip: !process.env.HEADROOM_BIN || !process.env.PI_SDK_PATH,
  timeout: 90000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-headroom-wire-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const requests = [];
  const upstream = createServer(async (req, res) => {
    let input = '';
    for await (const chunk of req) input += chunk;
    const body = JSON.parse(input || '{}');
    requests.push({ path: req.url, headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (value, event) => res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`);
    if (req.url.includes('generateContent') || req.url.includes('streamGenerateContent')) {
      emit({ candidates: [{ content: { role: 'model', parts: [{ text: 'fixture-ok' }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } });
    } else if (req.url.endsWith('/messages')) {
      emit({ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model: body.model, usage: { input_tokens: 10, output_tokens: 0 } } }, 'message_start');
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start');
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture-ok' } }, 'content_block_delta');
      emit({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }, 'message_delta');
      emit({ type: 'message_stop' }, 'message_stop');
    } else if (req.url.endsWith('/responses')) {
      emit({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 } } }, 'response.completed');
    } else {
      emit({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'fixture-ok' }, finish_reason: null }] });
      emit({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
      res.write('data: [DONE]\n\n');
    }
    res.end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const reserve = createServer();
  await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const proxy = spawn(process.env.HEADROOM_BIN, [
    'proxy', '--host', '127.0.0.1', '--port', String(port),
    '--openai-api-url', target, '--anthropic-api-url', target, '--gemini-api-url', target,
    '--mode', 'cache', '--lossless', '--disable-kompress', '--no-code-aware',
    '--no-rate-limit', '--no-cache', '--no-subscription-tracking', '--stateless',
  ], {
    cwd: dir,
    env: {
      PATH: process.env.PATH, HEADROOM_CONFIG_DIR: join(dir, 'config'),
      HEADROOM_OFFLINE: '1', HEADROOM_BEACON: 'off', DO_NOT_TRACK: '1',
      HEADROOM_SKIP_UPSTREAM_CHECK: '1', HEADROOM_SAVINGS_PROFILE: 'coding',
      HEADROOM_DEPLOYMENT_PROFILE: 'dueno-fleet',
      HEADROOM_NO_MEMORY_TOOLS: '1', HEADROOM_NO_MEMORY_CONTEXT: '1',
      HEADROOM_TELEMETRY: 'off', HEADROOM_ALLOWED_BASE_URLS: target,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  proxy.stdout.on('data', (chunk) => { logs += chunk; });
  proxy.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => { if (proxy.exitCode === null) { proxy.kill('SIGTERM'); await once(proxy, 'exit'); } });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    ready = await fetch(`${origin}/readyz`).then((r) => r.ok).catch(() => false);
    if (ready || proxy.exitCode !== null) break;
    await delay(200);
  }
  assert.ok(ready, logs);
  const health = await fetch(`${origin}/health`).then((response) => response.json());
  assert.equal(health.service, 'headroom-proxy');
  assert.equal(health.ready, true);
  assert.equal(health.version, '0.37.0');
  assert.equal(health.deployment.profile, 'dueno-fleet');
  assert.equal(health.config.openai_api_url, target);

  // Direct DSH and Codex wire formats; fake credentials never leave loopback.
  for (const [path, body] of [
    ['/v1/chat/completions', { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'Hello' }], thinking: { type: 'enabled' }, stream: true }],
    ['/v1/responses', { model: 'gpt-5.4', input: [{ role: 'user', content: 'Hello' }], stream: true }],
  ]) {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-only' }, body: JSON.stringify(body) });
    assert.equal(response.status, 200, await response.text());
    assert.equal(requests.at(-1).path, path);
    assert.equal(requests.at(-1).headers.authorization, 'Bearer fixture-only');
  }

  const records = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [
    `record_${index}`, { id: index, status: 'healthy', detail: `unique-detail-${index}` },
  ]));
  const original = JSON.stringify(records, null, 4);
  const compressed = await fetch(`${origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-only' },
    body: JSON.stringify({ model: 'deepseek-v4-pro', stream: true, messages: [
      { role: 'user', content: 'Inspect the database records.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'db1', type: 'function', function: { name: 'database_query', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'db1', content: original },
    ] }),
  });
  assert.equal(compressed.status, 200, await compressed.text());
  const forwarded = requests.at(-1).body.messages.find((message) => message.role === 'tool').content;
  assert.deepEqual(JSON.parse(forwarded), records, 'lossless compression must retain every record');
  const logLine = '2026-09-13T12:00:00Z INFO worker heartbeat healthy';
  const logText = Array(500).fill(logLine).join('\n');
  const logResponse = await fetch(`${origin}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-only' },
    body: JSON.stringify({ model: 'deepseek-v4-pro', stream: true, messages: [
      { role: 'user', content: 'Summarize the worker log.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'log1', type: 'function', function: { name: 'worker_log', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'log1', content: logText },
    ] }),
  });
  assert.equal(logResponse.status, 200, await logResponse.text());
  const folded = requests.at(-1).body.messages.find((message) => message.role === 'tool').content;
  assert.ok(folded.length < logText.length, 'repeated log lines must actually be compressed');
  assert.equal(folded.replace(/([^\n]+)\n\.\.\. \(repeated (\d+) times\)/g,
    (_match, line, count) => Array(Number(count)).fill(line).join('\n')), logText);

  const { AuthStorage, ModelRegistry, SettingsManager, SessionManager, DefaultResourceLoader, createAgentSession } = await import(pathToFileURL(process.env.PI_SDK_PATH));
  process.env.CADRE_HEADROOM_URL = origin;
  t.after(() => { delete process.env.CADRE_HEADROOM_URL; });
  for (const [provider, api, suffix, expectedPath] of [
    ['xai', 'openai-completions', '/v1', '/v1/chat/completions'],
    ['openrouter', 'openai-completions', '/api/v1', '/api/v1/chat/completions'],
    ['opencode-go', 'openai-completions', '/zen/go/v1', '/zen/go/v1/chat/completions'],
    ['opencode-go', 'anthropic-messages', '/zen/go', '/zen/go/v1/messages'],
    ['google', 'google-generative-ai', '/v1beta', '/v1beta/models/fixture-model:streamGenerateContent?alt=sse'],
  ]) {
    const authStorage = AuthStorage.inMemory();
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    modelRegistry.registerProvider(provider, {
      baseUrl: target + suffix, apiKey: 'fixture-only', api,
      headers: { 'x-fixture-custom': 'preserved' },
      models: [{ id: 'fixture-model', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 256 }],
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [headroomPi], systemPrompt: 'Reply briefly.',
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: dir, agentDir: dir, authStorage, modelRegistry, settingsManager,
      resourceLoader: loader, sessionManager: SessionManager.inMemory(),
      model: modelRegistry.find(provider, 'fixture-model'), tools: [],
    });
    try {
      await session.bindExtensions({ onError: (error) => { throw new Error(error.message); } });
      assert.ok(session.model.baseUrl.startsWith(origin), `${provider}: first model must be redirected`);
      await session.prompt('Hello');
      assert.equal(requests.at(-1).path, expectedPath, provider);
      assert.ok(session.messages.some((m) => m.role === 'assistant' && m.content?.some((c) => c.text === 'fixture-ok')), JSON.stringify(session.messages));
      assert.equal(requests.at(-1).headers['x-headroom-base-url'], undefined);
      assert.equal(requests.at(-1).headers['x-fixture-custom'], 'preserved');
      // Rebinding the runtime must not redirect the already rewritten URLs into itself.
      await session.bindExtensions({});
      await session.setModel(modelRegistry.find(provider, 'fixture-model'));
      await session.prompt('Hello again');
      assert.equal(requests.at(-1).path, expectedPath, `${provider} second session`);
    } finally { session.dispose(); }
  }
});
