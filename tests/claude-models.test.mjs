import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertValidClaudeModel, getPreferredClaudeModel, isValidClaudeModel, listClaudeModels, normalizeClaudeModel } from '../modules/sessions/claude-models.mjs';

describe('Claude model validation', () => {
  it('exposes the supported Claude fallback list when the API is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-claude-models-'));
    const cacheFile = join(dir, 'model-cache.json');
    try {
      const ids = (await listClaudeModels({
        apiKey: '',
        cacheFile,
        forceRefresh: true,
        env: {},
      })).map((entry) => entry.id);
      assert.deepEqual(ids, [
        'claude-fable-5-1',
        'claude-haiku-4-5',
        'claude-opus-4-8',
        'claude-opus-5',
        'claude-opus-5-5',
        'claude-sonnet-4-6',
        'claude-sonnet-5',
      ]);
      assert.equal(normalizeClaudeModel(' claude-opus-5 '), 'claude-opus-5');
      assert.equal(await isValidClaudeModel('claude-opus-5', { apiKey: '', cacheFile, forceRefresh: true, env: {} }), true);
      assert.equal(await isValidClaudeModel('claude-opus-5-5', { apiKey: '', cacheFile, forceRefresh: true, env: {} }), true);
      assert.equal(await isValidClaudeModel('claude-opus-4-8', { apiKey: '', cacheFile, forceRefresh: true, env: {} }), true);
      assert.equal(await isValidClaudeModel('claude-fable-5-1', { apiKey: '', cacheFile, forceRefresh: true, env: {} }), true);
      assert.equal(await isValidClaudeModel('fable', { apiKey: '', cacheFile, forceRefresh: true, env: {} }), false);
      assert.equal(await isValidClaudeModel('claude-opus-4-6', { apiKey: '', cacheFile, forceRefresh: true, env: {} }), false);
      assert.equal(await isValidClaudeModel('claude-2', { apiKey: '', cacheFile, forceRefresh: true, env: {} }), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('normalizes common Claude dotted model aliases', async () => {
    const cases = [
      ['opus 5', 'claude-opus-5'],
      ['opus 5.5', 'claude-opus-5-5'],
      ['claude-opus-4.8', 'claude-opus-4-8'],
      ['opus 4.8', 'claude-opus-4-8'],
      ['opus-4.8', 'claude-opus-4-8'],
      ['sonnet 4.6', 'claude-sonnet-4-6'],
      ['sonnet 5', 'claude-sonnet-5'],
      ['haiku 4.5', 'claude-haiku-4-5'],
    ];

    for (const [input, expected] of cases) {
      assert.equal(normalizeClaudeModel(input), expected);
    }

    const dir = await mkdtemp(join(tmpdir(), 'dueno-claude-alias-models-'));
    const cacheFile = join(dir, 'model-cache.json');
    try {
      assert.equal(
        await assertValidClaudeModel('opus 4.8', { apiKey: '', cacheFile, forceRefresh: true, env: {} }),
        'claude-opus-4-8',
      );
      assert.equal(
        await assertValidClaudeModel('sonnet 5', { apiKey: '', cacheFile, forceRefresh: true, env: {} }),
        'claude-sonnet-5',
      );
      assert.equal(
        await assertValidClaudeModel('opus 5.5', { apiKey: '', cacheFile, forceRefresh: true, env: {} }),
        'claude-opus-5-5',
      );
      await assert.rejects(
        () => assertValidClaudeModel('opus 9.9', { apiKey: '', cacheFile, forceRefresh: true, env: {} }),
        /Unsupported Claude model "claude-opus-9-9"/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prefers opus for default and sonnet for fast discovered model selection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-claude-models-'));
    const cacheFile = join(dir, 'model-cache.json');
    try {
      const opts = {
        forceRefresh: true,
        cacheFile,
        apiKey: 'test-key',
        fetchImpl: async () => ({
          ok: true,
          async json() {
            return {
              data: [
                { id: 'claude-sonnet-4-6' },
                { id: 'claude-haiku-4-5' },
                { id: 'claude-opus-4-8' },
                { id: 'claude-opus-5' },
              ],
              has_more: false,
            };
          },
        }),
      };
      assert.equal(await getPreferredClaudeModel(opts), 'claude-opus-5-5');
      assert.equal(await getPreferredClaudeModel({ ...opts, fast: true }), 'claude-sonnet-4-6');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects removed Claude models returned by the API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-claude-models-'));
    const cacheFile = join(dir, 'model-cache.json');
    try {
      const options = {
        apiKey: 'test-key',
        cacheFile,
        forceRefresh: true,
        fetchImpl: async () => ({
          ok: true,
          async json() {
            return {
              data: [
                { id: 'claude-opus-4-6' },
                { id: 'claude-sonnet-4-7' },
                { id: 'claude-opus-4-8' },
              ],
              has_more: false,
            };
          },
        }),
      };

      const ids = (await listClaudeModels(options)).map((entry) => entry.id);
      assert.deepEqual(ids, [
        'claude-fable-5-1',
        'claude-haiku-4-5',
        'claude-opus-4-8',
        'claude-opus-5',
        'claude-opus-5-5',
        'claude-sonnet-4-6',
        'claude-sonnet-5',
      ]);
      assert.equal(await isValidClaudeModel('claude-opus-4-6', options), false);
      assert.equal(await isValidClaudeModel('claude-sonnet-4-7', options), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
