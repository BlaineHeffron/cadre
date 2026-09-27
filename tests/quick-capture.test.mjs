import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildQuickCaptureService, quickCapturePlugin } from '../modules/integrations/quick-capture.mjs';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function makeStoreFile() {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-quick-capture-test-'));
  tempDirs.push(dir);
  return join(dir, 'quick-capture.json');
}

describe('quick capture service', () => {
  it('creates, lists newest-first, and deletes notes', async () => {
    const storeFile = await makeStoreFile();
    const service = buildQuickCaptureService({ storeFile });

    const first = await service.create({ text: 'first note' });
    const second = await service.create({ text: 'second note' });
    assert.ok(first.id && second.id);
    assert.notEqual(first.id, second.id);

    const notes = await service.list();
    assert.equal(notes.length, 2);
    assert.equal(notes[0].id, second.id, 'newest first');
    assert.equal(notes[0].text, 'second note');

    const removed = await service.remove(first.id);
    assert.equal(removed, true);
    const afterDelete = await service.list();
    assert.equal(afterDelete.length, 1);
    assert.equal(afterDelete[0].id, second.id);

    assert.equal(await service.remove('nope'), false);
  });

  it('rejects blank/whitespace-only text', async () => {
    const storeFile = await makeStoreFile();
    const service = buildQuickCaptureService({ storeFile });
    await assert.rejects(() => service.create({ text: '   \n\t ' }), /required/i);
    await assert.rejects(() => service.create({}), /required/i);
    assert.deepEqual(await service.list(), []);
  });

  it('rejects oversized text rather than silently truncating', async () => {
    const storeFile = await makeStoreFile();
    const service = buildQuickCaptureService({ storeFile });
    const huge = 'x'.repeat(20001);
    await assert.rejects(() => service.create({ text: huge }), (err) => {
      assert.equal(err.statusCode, 413);
      return true;
    });
    assert.deepEqual(await service.list(), []);
  });

  it('persists across service instances (file mirror)', async () => {
    const storeFile = await makeStoreFile();
    await buildQuickCaptureService({ storeFile }).create({ text: 'durable' });
    const reopened = buildQuickCaptureService({ storeFile });
    const notes = await reopened.list();
    assert.equal(notes.length, 1);
    assert.equal(notes[0].text, 'durable');
  });
});

describe('quick capture routes', () => {
  async function buildApp(storeFile) {
    const app = Fastify();
    await app.register(quickCapturePlugin, { storeFile });
    return app;
  }

  it('POST creates (201), GET lists, DELETE removes, blank=400, oversize=413', async () => {
    const storeFile = await makeStoreFile();
    const app = await buildApp(storeFile);

    const created = await app.inject({ method: 'POST', url: '/api/capture/notes', payload: { text: 'hello phone' } });
    assert.equal(created.statusCode, 201);
    const note = created.json().note;
    assert.equal(note.text, 'hello phone');

    const blank = await app.inject({ method: 'POST', url: '/api/capture/notes', payload: { text: '  ' } });
    assert.equal(blank.statusCode, 400);

    const oversize = await app.inject({ method: 'POST', url: '/api/capture/notes', payload: { text: 'x'.repeat(20001) } });
    assert.equal(oversize.statusCode, 413);

    const listed = await app.inject({ method: 'GET', url: '/api/capture/notes' });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().notes.length, 1);

    const del = await app.inject({ method: 'DELETE', url: `/api/capture/notes/${note.id}` });
    assert.equal(del.statusCode, 200);

    const missing = await app.inject({ method: 'DELETE', url: '/api/capture/notes/nope' });
    assert.equal(missing.statusCode, 404);

    await app.close();
  });

  it('GET honors limit', async () => {
    const storeFile = await makeStoreFile();
    const app = await buildApp(storeFile);
    for (const t of ['a', 'b', 'c']) {
      await app.inject({ method: 'POST', url: '/api/capture/notes', payload: { text: t } });
    }
    const limited = await app.inject({ method: 'GET', url: '/api/capture/notes?limit=2' });
    assert.equal(limited.json().notes.length, 2);
    await app.close();
  });
});
