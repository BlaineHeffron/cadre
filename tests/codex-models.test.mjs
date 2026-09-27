import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { codexSessionsPlugin, createCodexSession } from '../modules/sessions/codex-sessions.mjs';
import { getPreferredCodexModel, isValidCodexModel, listCodexModels, normalizeCodexModel } from '../modules/sessions/codex-models.mjs';

describe('Codex model validation', () => {
  it('exposes the supported Codex model list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-codex-models-'));
    const cacheFile = join(dir, 'model-cache.json');
    try {
      const ids = (await listCodexModels({
        forceRefresh: true,
        cacheFile,
        env: {},
      })).map((entry) => entry.id);
      assert.deepEqual(ids, [
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
      assert.equal(await isValidCodexModel('gpt-5.4', { forceRefresh: true, cacheFile, env: {} }), true);
      assert.equal(await isValidCodexModel('gpt-5.4-mini', { forceRefresh: true, cacheFile, env: {} }), true);
      assert.equal(await isValidCodexModel('gpt-5.5', { forceRefresh: true, cacheFile, env: {} }), true);
      assert.equal(await isValidCodexModel('gpt-5.6-terra', { forceRefresh: true, cacheFile, env: {} }), true);
      assert.equal(await isValidCodexModel('gpt-5.6-sol', { forceRefresh: true, cacheFile, env: {} }), true);
      assert.equal(await isValidCodexModel('gpt-5.6-luna', { forceRefresh: true, cacheFile, env: {} }), true);
      assert.equal(await isValidCodexModel('gpt-6-astra', { forceRefresh: true, cacheFile, env: {} }), true);
      assert.equal(await isValidCodexModel('gpt-6-sol', { forceRefresh: true, cacheFile, env: {} }), true);
      assert.equal(await isValidCodexModel('gpt-6-luna', { forceRefresh: true, cacheFile, env: {} }), true);
      assert.equal(normalizeCodexModel('gpt-5.4'), 'gpt-5.4');
      assert.equal(await isValidCodexModel('gpt-5.3-codex', { forceRefresh: true, cacheFile, env: {} }), false);
      assert.equal(await isValidCodexModel('gpt-5.1-codex-mini', { forceRefresh: true, cacheFile, env: {} }), false);
      assert.equal(await isValidCodexModel('o4-mini', { forceRefresh: true, cacheFile, env: {} }), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid models before creating a Codex session', async () => {
    await assert.rejects(
      () => createCodexSession({ model: 'o4-mini' }),
      (err) => err?.statusCode === 400 && /Unsupported Codex model "o4-mini"/.test(err.message),
    );
  });

  it('returns a 400 from the session API for invalid models', async () => {
    const app = Fastify();
    await app.register(codexSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {} },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/codex/sessions',
      payload: { model: 'o4-mini' },
    });

    assert.equal(response.statusCode, 400);
    const payload = JSON.parse(response.body);
    assert.match(payload.error, /Unsupported Codex model "o4-mini"/);
    await app.close();
  });

  it('prefers a stable discovered Codex model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-codex-models-'));
    const cacheFile = join(dir, 'model-cache.json');
    try {
      const model = await getPreferredCodexModel({
        forceRefresh: true,
        cacheFile,
        apiKey: 'test-key',
        fetchImpl: async () => ({
          ok: true,
          async json() {
            return {
              data: [
                { id: 'gpt-5.6' },
                { id: 'gpt-5.4-mini' },
              ],
            };
          },
        }),
      });
      assert.equal(model, 'gpt-6-sol');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects removed Codex models returned by the API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-codex-models-'));
    const cacheFile = join(dir, 'model-cache.json');
    try {
      const options = {
        forceRefresh: true,
        cacheFile,
        apiKey: 'test-key',
        fetchImpl: async () => ({
          ok: true,
          async json() {
            return {
              data: [
                { id: 'gpt-5.3-codex' },
                { id: 'gpt-5.3-codex-spark' },
                { id: 'gpt-5.5' },
              ],
            };
          },
        }),
      };

      const ids = (await listCodexModels(options)).map((entry) => entry.id);
      assert.deepEqual(ids, [
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
      assert.equal(await isValidCodexModel('gpt-5.3-codex', options), false);
      assert.equal(await isValidCodexModel('gpt-5.3-codex-spark', options), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
