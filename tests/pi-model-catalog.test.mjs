import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertPiProviderModel,
  listPiModels,
  parsePiModelList,
} from '../modules/sessions/pi-model-catalog.mjs';

const tempDirs = [];
const PI_OUTPUT = [
  'provider  model  context  max-out  thinking  images',
  'openai-codex  gpt-5.5  400000  128000  yes  yes',
  'xai  grok-4.7  500000  500000  yes  yes',
  'xai  grok-4.6  500000  500000  yes  yes',
  'xai  grok-4.3  131072  32768  yes  yes',
  'google  gemini-3.5-flash  1048576  65536  yes  yes',
  'opencode-go  glm-5.2  1000000  131072  yes  no',
  'opencode-go  kimi-k3  1048576  131072  yes  yes',
  'openrouter  z-ai/glm-5.3-flash  1048576  131072  yes  yes',
  'anthropic  claude-opus-4-8  200000  64000  yes  yes',
].join('\n');

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function cacheFile() {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-pi-models-'));
  tempDirs.push(dir);
  return join(dir, 'catalog.json');
}

describe('Pi model catalog', () => {
  it('parses provider/model tuples and excludes Anthropic and OpenAI harness providers', () => {
    const models = parsePiModelList(PI_OUTPUT);
    assert.deepEqual(models.xai.map((entry) => entry.id), ['grok-4.3', 'grok-4.6', 'grok-4.7']);
    assert.deepEqual(models.google.map((entry) => entry.id), ['gemini-3.5-flash']);
    assert.deepEqual(models['opencode-go'].map((entry) => entry.id), ['glm-5.2', 'kimi-k3']);
    assert.deepEqual(models.openrouter.map((entry) => entry.id), ['z-ai/glm-5.3-flash']);
    assert.equal(Object.hasOwn(models, 'anthropic'), false);
    assert.equal(Object.hasOwn(models, 'openai'), false);
    assert.equal(Object.hasOwn(models, 'openai-codex'), false);
  });

  it('runs pi --list-models with the configured timeout and caches successful discovery', async () => {
    const file = await cacheFile();
    const calls = [];
    const first = await listPiModels({
      forceRefresh: true,
      cacheFile: file,
      timeoutMs: 37,
      env: {},
      execImpl: async (...args) => {
        calls.push(args);
        return { code: 0, stdout: PI_OUTPUT, stderr: '' };
      },
      now: () => 100,
    });
    const second = await listPiModels({
      cacheFile: file,
      env: {},
      execImpl: async () => {
        throw new Error('fresh cache should avoid execution');
      },
      now: () => 101,
    });

    assert.equal(first.source, 'pi');
    assert.deepEqual(first.providers.map((entry) => entry.id), ['xai', 'google', 'opencode-go', 'openrouter']);
    assert.deepEqual(first.providers.map((entry) => entry.defaultModel), ['grok-4.6', 'gemini-3.5-flash', 'glm-5.2', 'z-ai/glm-5.3-flash']);
    assert.equal(second.source, 'pi');
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'pi');
    assert.deepEqual(calls[0][1], ['--list-models']);
    assert.equal(calls[0][2].timeout, 37);
  });

  it('coalesces concurrent refreshes', async () => {
    const file = await cacheFile();
    let calls = 0;
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    const options = {
      forceRefresh: true,
      cacheFile: file,
      env: {},
      execImpl: async () => {
        calls += 1;
        await pending;
        return { code: 0, stdout: PI_OUTPUT, stderr: '' };
      },
    };
    const first = listPiModels(options);
    const second = listPiModels(options);
    release();
    const results = await Promise.all([first, second]);

    assert.equal(calls, 1);
    assert.equal(results[0].source, 'pi');
    assert.deepEqual(results[1], results[0]);
  });

  it('reuses stale persisted discovery after a CLI failure', async () => {
    const file = await cacheFile();
    await listPiModels({
      forceRefresh: true,
      cacheFile: file,
      env: {},
      execImpl: async () => ({ code: 0, stdout: PI_OUTPUT, stderr: '' }),
      now: () => 100,
    });
    const stale = await listPiModels({
      forceRefresh: true,
      cacheFile: file,
      env: {},
      execImpl: async () => ({ code: 1, stdout: '', stderr: 'temporary failure' }),
      now: () => 10_000,
    });

    assert.equal(stale.source, 'pi');
    assert.equal(stale.stale, true);
    assert.equal(stale.errorCode, 'pi_catalog_unavailable');
    assert.deepEqual(stale.models.xai.map((entry) => entry.id), ['grok-4.3', 'grok-4.6', 'grok-4.7']);
  });

  it('uses the small fallback while retaining explicit discovery failures', async () => {
    const credentialsFile = await cacheFile();
    const credentials = await listPiModels({
      forceRefresh: true,
      cacheFile: credentialsFile,
      env: {},
      execImpl: async () => ({
        code: 0,
        stdout: 'No models available. Use /login to configure API keys or set environment variables.',
        stderr: '',
      }),
    });

    assert.equal(credentials.source, 'fallback');
    assert.equal(credentials.errorCode, 'pi_credentials_missing');
    assert.deepEqual(Object.fromEntries(Object.entries(credentials.models)
      .map(([provider, models]) => [provider, models.map((entry) => entry.id)])), {
      xai: ['grok-4.3', 'grok-4.5', 'grok-4.6', 'grok-4.7', 'grok-build-0.1'],
      google: ['gemini-3.5-flash'],
      'opencode-go': [
        'deepseek-v4-flash',
        'deepseek-v4-pro',
        'glm-5.1',
        'glm-5.2',
        'glm-5.3',
        'gpt-5.6-luna',
        'grok-4.5',
        'hy3',
        'kimi-k2.6',
        'kimi-k2.7-code',
        'kimi-k3',
        'mimo-v2.5',
        'mimo-v2.5-pro',
        'minimax-m2.7',
        'minimax-m3',
        'qwen3.6-plus',
        'qwen3.7-max',
        'qwen3.7-plus',
        'qwen3.8-max',
      ],
      openrouter: ['z-ai/glm-5.3-flash'],
    });
    await assert.rejects(
      () => assertPiProviderModel('xai', 'grok-4.6', {
        cacheFile: credentialsFile,
        env: {},
        execImpl: async () => ({
          code: 0,
          stdout: 'No models available. Use /login to configure API keys or set environment variables.',
          stderr: '',
        }),
      }),
      (error) => error?.code === 'pi_credentials_missing' && error?.statusCode === 400,
    );
  });

  it('reports missing binaries and rejects unsupported models from authoritative discovery', async () => {
    const missingFile = await cacheFile();
    await assert.rejects(
      () => assertPiProviderModel('xai', 'grok-4.6', {
        binary: '/missing/pi',
        cacheFile: missingFile,
        env: {},
        execImpl: async () => ({ code: 'ENOENT', stdout: '', stderr: '' }),
      }),
      (error) => error?.code === 'pi_binary_missing' && error?.statusCode === 503 && /\/missing\/pi/.test(error.message),
    );

    const unsupportedFile = await cacheFile();
    await assert.rejects(
      () => assertPiProviderModel('xai', 'grok-typo', {
        cacheFile: unsupportedFile,
        env: {},
        execImpl: async () => ({ code: 0, stdout: PI_OUTPUT, stderr: '' }),
      }),
      (error) => error?.code === 'pi_model_unsupported' && error?.statusCode === 400,
    );
    await assert.rejects(
      () => assertPiProviderModel('gooogle', 'gemini-3.5-flash', { cacheFile: unsupportedFile }),
      (error) => error?.code === 'pi_provider_unsupported' && error?.statusCode === 400,
    );

    const providerMissingFile = await cacheFile();
    const partialDiscovery = {
      cacheFile: providerMissingFile,
      env: {},
      execImpl: async () => ({
        code: 0,
        stdout: [
          'provider  model  context  max-out  thinking  images',
          'google  gemini-3.5-flash  1048576  65536  yes  yes',
        ].join('\n'),
        stderr: '',
      }),
    };
    assert.equal(await assertPiProviderModel('xai', 'grok-4.6', partialDiscovery), 'grok-4.6');
    assert.equal(await assertPiProviderModel('xai', 'grok-4.3', partialDiscovery), 'grok-4.3');
    await assert.rejects(
      () => assertPiProviderModel('xai', 'grok-typo', partialDiscovery),
      (error) => error?.code === 'pi_model_unsupported' && !/login/i.test(error.message),
    );
  });
});
