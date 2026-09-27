import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  applyRevalidatedCacheHeader,
  createBuildId,
  isProtectedRoutePath,
  isRevalidatedStaticAsset,
} from '../modules/platform/static-cache.mjs';

describe('static cache controls', () => {
  it('uses a changing build id unless explicitly pinned', () => {
    assert.notEqual(createBuildId({}, () => 1000), createBuildId({}, () => 2000));
    assert.equal(createBuildId({ DUENO_FLEET_BUILD_ID: 'build-123' }, () => 1000), 'build-123');
    assert.equal(createBuildId({ GIT_COMMIT: 'abc123' }, () => 1000), 'abc123');
  });

  it('marks browser script assets as revalidated', () => {
    assert.equal(isRevalidatedStaticAsset('/pages/app.mjs'), true);
    assert.equal(isRevalidatedStaticAsset('/app.js'), true);
    assert.equal(isRevalidatedStaticAsset('/index.html'), true);
    assert.equal(isRevalidatedStaticAsset('/styles.css'), false);
  });

  it('keeps a service worker tombstone without page registration code', async () => {
    const script = await readFile('public/sw.js', 'utf8');
    assert.match(script, /skipWaiting\(\)/);
    assert.match(script, /registration\.unregister\(\)/);
    assert.match(script, /clients\.matchAll\(\{ type: 'window' \}\)/);

    const index = await readFile('public/index.html', 'utf8');
    assert.doesNotMatch(index, /serviceWorker/);
    assert.doesNotMatch(index, /getRegistrations\(\)/);
    assert.doesNotMatch(index, /unregister\(\)/);
  });

  it('sets no-cache must-revalidate for served modules and scripts', () => {
    const headers = new Map();
    const res = {
      setHeader(name, value) {
        headers.set(name, value);
      },
    };

    applyRevalidatedCacheHeader(res, '/pages/fleet.mjs');
    assert.equal(headers.get('Cache-Control'), 'no-cache, must-revalidate');

    headers.clear();
    applyRevalidatedCacheHeader(res, '/styles.css');
    assert.equal(headers.has('Cache-Control'), false);
  });

  it('sets the header on a Fastify Reply, as @fastify/static v10 passes', () => {
    // v10 calls setHeaders(reply, path, stat); Reply exposes header(), not
    // setHeader(). Serving any .mjs/.js/.html crashed the server before this.
    const headers = new Map();
    const reply = {
      header(name, value) {
        headers.set(name, value);
        return reply;
      },
    };

    applyRevalidatedCacheHeader(reply, '/app/app.mjs');
    assert.equal(headers.get('Cache-Control'), 'no-cache, must-revalidate');

    headers.clear();
    applyRevalidatedCacheHeader(reply, '/styles/main.css');
    assert.equal(headers.has('Cache-Control'), false);
  });

  it('does not throw when the responder exposes neither header API', () => {
    assert.doesNotThrow(() => applyRevalidatedCacheHeader({}, '/app/app.mjs'));
    assert.doesNotThrow(() => applyRevalidatedCacheHeader(null, '/app/app.mjs'));
  });

  it('recognizes encoded and non-canonical protected namespaces', () => {
    for (const path of [
      '/api/missing',
      '/api/../dashboard',
      '/api%2fmissing',
      '/api%5cmissing',
      '/api%252fmissing',
      '/api%2525252fmissing',
      '/api%2fmissing%ZZ',
      '/ws%2Fmissing',
      '/%61pi/secret',
      '/api/%2e%2e/secret',
      '/api/%2e%2e/%61pi/secret',
    ]) {
      assert.equal(isProtectedRoutePath(path), true, path);
    }

    assert.equal(isProtectedRoutePath('/apis/missing'), false);
    assert.equal(isProtectedRoutePath('/dashboard/api'), false);
  });
});
