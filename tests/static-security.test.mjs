import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { isProtectedRoutePath } from '../modules/platform/static-cache.mjs';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function buildStaticApp() {
  const fixture = await mkdtemp(join(tmpdir(), 'dueno-static-security-'));
  tempDirs.push(fixture);
  const publicRoot = join(fixture, 'public');
  const vendorRoot = join(fixture, 'node_modules');
  await mkdir(publicRoot);
  await mkdir(join(vendorRoot, 'fixture-package'), { recursive: true });
  await writeFile(join(fixture, 'outside-secret.txt'), 'OUTSIDE_STATIC_ROOT');
  await writeFile(join(publicRoot, 'index.html'), 'PUBLIC_INDEX');
  await writeFile(join(publicRoot, 'app.js'), 'PUBLIC_ASSET');
  await writeFile(join(vendorRoot, 'fixture-package', 'index.js'), 'VENDOR_ASSET');

  const app = Fastify();
  await app.register(fastifyStatic, {
    root: vendorRoot,
    prefix: '/vendor/npm/',
    decorateReply: false,
  });
  await app.register(fastifyStatic, {
    root: publicRoot,
    prefix: '/',
  });
  app.setNotFoundHandler((request, reply) => {
    const rawUrl = request.raw.url || '/';
    const method = request.raw.method || 'GET';
    const { pathname } = new URL(rawUrl, 'http://localhost');
    if (isProtectedRoutePath(rawUrl) || (method !== 'GET' && method !== 'HEAD')) {
      return reply.code(404).send({ error: 'Not Found' });
    }
    if (/\.(?:mjs|js|css|map|json|svg|png|jpg|jpeg|gif|webp|ico|txt|xml|woff|woff2|ttf|eot)$/i.test(pathname)) {
      return reply.code(404).send({ error: 'Not Found' });
    }
    return reply.type('text/html').sendFile('index.html');
  });
  await app.ready();
  return app;
}

describe('static route security', () => {
  it('serves expected files from both configured roots', async () => {
    const app = await buildStaticApp();
    try {
      const publicAsset = await app.inject('/app.js');
      assert.equal(publicAsset.statusCode, 200);
      assert.equal(publicAsset.body, 'PUBLIC_ASSET');

      const vendorAsset = await app.inject('/vendor/npm/fixture-package/index.js');
      assert.equal(vendorAsset.statusCode, 200);
      assert.equal(vendorAsset.body, 'VENDOR_ASSET');
    } finally {
      await app.close();
    }
  });

  it('blocks traversal and encoded separators at both static roots', async () => {
    const app = await buildStaticApp();
    const attacks = [
      '/../outside-secret.txt',
      '/%2e%2e/outside-secret.txt',
      '/%252e%252e/outside-secret.txt',
      '/..%2foutside-secret.txt',
      '/..%5coutside-secret.txt',
      '/vendor/npm/../../outside-secret.txt',
      '/vendor/npm/%2e%2e/%2e%2e/outside-secret.txt',
      '/vendor/npm/%252e%252e/%252e%252e/outside-secret.txt',
      '/vendor/npm/..%2f..%2foutside-secret.txt',
      '/vendor/npm/..%5c..%5coutside-secret.txt',
    ];

    try {
      for (const url of attacks) {
        const response = await app.inject({ method: 'GET', url });
        assert.notEqual(response.statusCode, 200, url);
        assert.doesNotMatch(response.body, /OUTSIDE_STATIC_ROOT/, url);
        assert.doesNotMatch(response.body, /PUBLIC_INDEX/, url);
      }
    } finally {
      await app.close();
    }
  });

  it('never sends the SPA fallback for canonical or encoded API paths', async () => {
    const app = await buildStaticApp();
    const paths = [
      '/api/missing',
      '/api%2fmissing',
      '/api%5cmissing',
      '/api%252fmissing',
      '/api%2525252fmissing',
      '/api%2fmissing%ZZ',
      '/ws%2fmissing',
    ];

    try {
      for (const url of paths) {
        const response = await app.inject({ method: 'GET', url });
        assert.ok(response.statusCode >= 400 && response.statusCode < 500, url);
        assert.doesNotMatch(response.body, /PUBLIC_INDEX/, url);
      }
    } finally {
      await app.close();
    }
  });
});
