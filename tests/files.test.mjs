import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Files module', () => {
  let root;
  let app;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'dueno-files-test-'));
    process.env.FILE_BROWSER_ROOT = root;
    app = Fastify({ logger: false });
    const { filesPlugin } = await import('../modules/platform/files.mjs');
    await app.register(filesPlugin);
  });

  afterEach(async () => {
    await app?.close();
    delete process.env.FILE_BROWSER_ROOT;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('should be importable without errors', async () => {
    const mod = await import('../modules/platform/files.mjs');
    assert.equal(typeof mod.filesPlugin, 'function');
  });

  it('uploads a file into the selected directory', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/files/upload',
      payload: {
        path: '',
        filename: 'upload.txt',
        contentBase64: Buffer.from('uploaded content', 'utf8').toString('base64'),
      },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(readFileSync(join(root, 'upload.txt'), 'utf8'), 'uploaded content');
    const payload = JSON.parse(response.body);
    assert.equal(payload.name, 'upload.txt');
    assert.equal(payload.isText, true);
  });

  it('creates a markdown document by default', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/files/document',
      payload: {
        path: '',
        name: 'notes',
        content: '# Notes\n',
      },
    });

    assert.equal(response.statusCode, 201);
    assert.equal(existsSync(join(root, 'notes.md')), true);
    assert.equal(readFileSync(join(root, 'notes.md'), 'utf8'), '# Notes\n');
    const payload = JSON.parse(response.body);
    assert.equal(payload.name, 'notes.md');
  });

  it('does not overwrite existing files by default', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/files/document',
      payload: {
        path: '',
        name: 'duplicate.md',
        content: 'first',
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/files/document',
      payload: {
        path: '',
        name: 'duplicate.md',
        content: 'second',
      },
    });

    assert.equal(response.statusCode, 409);
    assert.equal(readFileSync(join(root, 'duplicate.md'), 'utf8'), 'first');
  });

  it('rejects overwrite through a dangling symlink for upload and document', async () => {
    const outside = join(root, '..', `outside-${Date.now()}.txt`);
    const dangling = join(root, 'escape.txt');
    symlinkSync(outside, dangling);
    for (const [url, payload] of [
      ['/api/files/upload', {
        path: '',
        filename: 'escape.txt',
        contentBase64: Buffer.from('pwned', 'utf8').toString('base64'),
        overwrite: true,
      }],
      ['/api/files/document', {
        path: '',
        name: 'escape.txt',
        content: 'pwned',
        overwrite: true,
      }],
    ]) {
      const response = await app.inject({ method: 'POST', url, payload });
      assert.notEqual(response.statusCode, 201, url);
      assert.equal(existsSync(outside), false, url);
    }
  });
});
