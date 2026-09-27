import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertProviderModel, listProviderModels } from '../modules/sessions/model-catalog.mjs';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Model catalog', () => {
  it('returns the curated OpenAI subscription-safe models', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-models-'));
    tempDirs.push(dir);

    const result = await listProviderModels('openai', {
      forceRefresh: true,
      cacheFile: join(dir, 'catalog.json'),
      env: {},
    });

    assert.equal(result.source, 'subscription');
    assert.deepEqual(result.models.map((entry) => entry.id), [
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.5',
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-6-astra',
      'gpt-6-luna',
      'gpt-6-sol',
    ]);
  });

  it('loads OpenAI models from the models API when a key is configured', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-models-'));
    tempDirs.push(dir);

    const result = await listProviderModels('openai', {
      forceRefresh: true,
      cacheFile: join(dir, 'catalog.json'),
      apiKey: 'test-key',
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            data: [
              { id: 'gpt-5.3-codex' },
              { id: 'gpt-5.6' },
              { id: 'text-embedding-3-large' },
            ],
          };
        },
      }),
    });

    const ids = result.models.map((entry) => entry.id);
    assert.equal(result.source, 'api');
    assert.equal(ids.includes('gpt-5.6'), true);
    assert.equal(ids.includes('gpt-5.3-codex'), false);
    assert.equal(ids.includes('gpt-5.4'), true);
    assert.equal(ids.includes('text-embedding-3-large'), false);
  });

  it('loads Anthropic models from the models API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-models-'));
    tempDirs.push(dir);

    const result = await listProviderModels('anthropic', {
      forceRefresh: true,
      cacheFile: join(dir, 'catalog.json'),
      apiKey: 'test-key',
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            data: [
              { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' },
              { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8' },
              { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
              { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' },
            ],
            has_more: false,
          };
        },
      }),
    });

    assert.equal(result.source, 'api');
    assert.deepEqual(result.models.map((entry) => entry.id), [
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
    ]);
  });

  it('falls back to the cached catalog when refresh fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-models-'));
    tempDirs.push(dir);
    const cacheFile = join(dir, 'catalog.json');

    await listProviderModels('openai', {
      forceRefresh: true,
      cacheFile,
      env: {},
    });

    const result = await listProviderModels('openai', {
      forceRefresh: true,
      cacheFile,
      env: {},
    });

    assert.equal(result.source, 'subscription');
    assert.deepEqual(result.models.map((entry) => entry.id), [
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.5',
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-6-astra',
      'gpt-6-luna',
      'gpt-6-sol',
    ]);
  });

  it('filters removed models from cached catalogs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-models-'));
    tempDirs.push(dir);
    const cacheFile = join(dir, 'catalog.json');
    const fetchedAt = Date.now();

    await writeFile(cacheFile, JSON.stringify({
      openai: {
        fetchedAt,
        source: 'api',
        models: [
          { id: 'gpt-5.3-codex' },
          { id: 'gpt-5.5' },
        ],
      },
      anthropic: {
        fetchedAt,
        source: 'api',
        models: [
          { id: 'claude-opus-4-6' },
          { id: 'claude-opus-4-8' },
        ],
      },
    }));

    const openai = await listProviderModels('openai', { cacheFile });
    const anthropic = await listProviderModels('anthropic', { cacheFile });

    assert.deepEqual(openai.models.map((entry) => entry.id), [
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.5',
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-6-astra',
      'gpt-6-luna',
      'gpt-6-sol',
    ]);
    assert.deepEqual(anthropic.models.map((entry) => entry.id), [
      'claude-fable-5-1',
      'claude-haiku-4-5',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
    ]);
  });

  it('rejects unsupported Anthropic models against the discovered catalog', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-models-'));
    tempDirs.push(dir);

    await assert.rejects(
      () => assertProviderModel('anthropic', 'claude-2', {
        forceRefresh: true,
        cacheFile: join(dir, 'catalog.json'),
        apiKey: 'test-key',
        fetchImpl: async () => ({
          ok: true,
          async json() {
            return { data: [{ id: 'claude-opus-4-6' }], has_more: false };
          },
        }),
      }),
      (err) => err?.statusCode === 400 && /Unsupported Claude model "claude-2"/.test(err.message),
    );
  });
});
