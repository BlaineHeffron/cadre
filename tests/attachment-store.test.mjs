import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { AttachmentStore } from '../modules/agent/attachment-store.mjs';
import { buildAgentImagePrompt, saveImageToWorkspace } from '../modules/sessions/image-handoff.mjs';

const roots = [];
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 1]);

function image(bytes = PNG, mimeType = 'image/png', name = 'upload.png') {
  return { type: 'image', data: bytes.toString('base64'), mimeType, name };
}

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dueno-attachments-'));
  roots.push(root);
  const store = new AttachmentStore({ rootDir: join(root, 'store'), ...options });
  await store.init();
  return { root, store, storeRoot: join(root, 'store') };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AttachmentStore', () => {
  it('deduplicates content while enforcing independent session ACLs and refcounted cleanup', async () => {
    const { store, storeRoot } = await fixture();
    const [first] = await store.ingestTurn('session-a', [image()]);
    const [duplicate] = await store.ingestTurn('session-a', [image(PNG, 'image/png', '../different.png')]);
    assert.equal(first.attachment.digest, duplicate.attachment.digest);
    assert.equal(first.attachment.name, 'upload.png');
    assert.equal(duplicate.attachment.name, 'different.png');
    const hydrated = await store.hydrateBlocks('session-a', [first, duplicate]);
    assert.deepEqual(hydrated.map((block) => block.name), ['upload.png', 'different.png']);
    assert.deepEqual(await readdir(join(storeRoot, 'blobs')), [first.attachment.digest]);
    await assert.rejects(
      store.read('session-b', first.attachment.digest),
      (error) => error.code === 'attachment_access_denied' && error.statusCode === 403,
    );

    await store.ingestTurn('session-b', [image()]);
    assert.equal((await store.read('session-b', first.attachment.digest)).data.equals(PNG), true);
    await store.releaseSession('session-a');
    assert.deepEqual(await readdir(join(storeRoot, 'blobs')), [first.attachment.digest]);
    await store.releaseSession('session-b');
    assert.deepEqual(await readdir(join(storeRoot, 'blobs')), []);
  });

  it('reaps tmp/orphan files on restart while preserving referenced attachments', async () => {
    const { store, storeRoot } = await fixture();
    const [block] = await store.ingestTurn('restart-session', [image()]);
    await writeFile(join(storeRoot, 'tmp', 'abandoned.tmp'), 'partial');
    const orphan = createHash('sha256').update('orphan').digest('hex');
    await writeFile(join(storeRoot, 'blobs', orphan), 'orphan');

    const restarted = new AttachmentStore({ rootDir: storeRoot });
    await restarted.init();
    assert.deepEqual(await readdir(join(storeRoot, 'tmp')), []);
    assert.deepEqual(await readdir(join(storeRoot, 'blobs')), [block.attachment.digest]);
    assert.equal((await restarted.read('restart-session', block.attachment.digest)).data.equals(PNG), true);
  });

  it('rejects MIME spoofing, traversal-like names, symlink roots, blobs, and downgrade directories', async () => {
    const { root, store, storeRoot } = await fixture();
    await assert.rejects(
      store.ingestTurn('spoof', [image(PNG, 'image/jpeg')]),
      (error) => error.code === 'attachment_mime_mismatch',
    );
    const [safe] = await store.ingestTurn('../session/../../victim', [image(PNG, 'image/png', '../../etc/passwd')]);
    assert.equal(safe.attachment.name, 'passwd');
    const blobPath = join(storeRoot, 'blobs', safe.attachment.digest);
    await rm(blobPath);
    await symlink('/etc/passwd', blobPath);
    await assert.rejects(store.read('../session/../../victim', safe.attachment.digest), /missing or unsafe/);

    const linkedRoot = join(root, 'linked-store');
    await symlink(storeRoot, linkedRoot);
    await assert.rejects(new AttachmentStore({ rootDir: linkedRoot }).init(), /Symlink is not allowed/);

    const [materialized] = await store.ingestTurn('materialize', [image(JPEG, 'image/jpeg')]);
    const workDir = join(root, 'work');
    await mkdir(workDir);
    await symlink('/tmp', join(workDir, '.dueno_attachments'));
    await assert.rejects(
      store.materializeForWorkdir({ sessionId: 'materialize', digest: materialized.attachment.digest, workDir }),
      /Symlink is not allowed/,
    );
  });

  it('pins attachment storage to a canonical path behind an ancestor symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-attachments-linked-state-'));
    roots.push(root);
    const liveRoot = join(root, 'live');
    const sharedState = join(root, 'shared-state');
    const alternateState = join(root, 'alternate-state');
    await Promise.all([mkdir(liveRoot), mkdir(sharedState), mkdir(alternateState)]);
    const stateLink = join(liveRoot, '.dueno');
    await symlink(sharedState, stateLink);
    const requestedRoot = join(stateLink, 'state', 'attachments');
    const store = new AttachmentStore({ rootDir: requestedRoot });
    await store.init();

    await rm(stateLink);
    await symlink(alternateState, stateLink);
    const [stored] = await store.ingestTurn('linked-state-session', [image()]);

    await access(join(sharedState, 'state', 'attachments', 'blobs', stored.attachment.digest));
    await assert.rejects(access(join(alternateState, 'state', 'attachments', 'blobs', stored.attachment.digest)));
  });

  it('enforces per-file, per-turn, and per-session quotas before publishing references', async () => {
    const perFile = await fixture({ maxFileBytes: PNG.length - 1 });
    await assert.rejects(
      perFile.store.ingestTurn('file', [image()]),
      (error) => error.code === 'attachment_file_quota_exceeded' && error.statusCode === 413,
    );

    const perTurn = await fixture({ maxTurnCount: 1 });
    await assert.rejects(
      perTurn.store.ingestTurn('turn', [image(), image(JPEG, 'image/jpeg')]),
      (error) => error.code === 'attachment_turn_quota_exceeded',
    );
    assert.deepEqual(await readdir(join(perTurn.storeRoot, 'blobs')), []);

    const perSession = await fixture({ maxSessionBytes: PNG.length });
    await perSession.store.ingestTurn('session', [image()]);
    await assert.rejects(
      perSession.store.ingestTurn('session', [image(JPEG, 'image/jpeg')]),
      (error) => error.code === 'attachment_session_quota_exceeded',
    );
    assert.equal((await readFile(join(perSession.storeRoot, 'index.json'), 'utf8')).includes(PNG.toString('base64')), false);
  });

  it('stores embedded resources as redacted references and hydrates only for delivery', async () => {
    const { store, storeRoot } = await fixture();
    const blocks = await store.ingestTurn('resource-session', [{
      type: 'embedded_resource',
      resource: { uri: 'urn:doc:1', mimeType: 'application/json', text: '{"ok":true}' },
    }]);
    assert.equal(blocks[0].resource.attachment.mimeType, 'application/json');
    assert.equal('text' in blocks[0].resource, false);
    const hydrated = await store.hydrateBlocks('resource-session', blocks);
    assert.equal(Buffer.from(hydrated[0].resource.blob, 'base64').toString('utf8'), '{"ok":true}');
    assert.equal((await readFile(join(storeRoot, 'index.json'), 'utf8')).includes('{"ok":true}'), false);
  });

  it('requires explicit downgrade permission and emits a user-visible workdir reference notice', async () => {
    const { root, store } = await fixture();
    const workDir = join(root, 'workdir');
    await mkdir(workDir);
    const imageDataUrl = `data:image/png;base64,${PNG.toString('base64')}`;
    await assert.rejects(
      saveImageToWorkspace({ workDir, sessionId: 'tmux', attachmentStore: store, imageDataUrl }),
      (error) => error.code === 'unsupported_capability',
    );
    const saved = await saveImageToWorkspace({
      workDir, sessionId: 'tmux', attachmentStore: store, imageDataUrl,
      filenameHint: '../../unsafe.png', allowCompatibilityDowngrade: true,
    });
    assert.equal(saved.imagePath.startsWith(join(workDir, '.dueno_attachments')), true);
    const prompt = buildAgentImagePrompt({ imagePath: saved.imagePath, caption: 'please inspect' });
    assert.match(prompt, /compatibility notice/i);
    assert.match(prompt, /please inspect/);
  });

  it('materializes repeated and multi-image downgrades without trusting pre-existing files', async () => {
    const { root, store } = await fixture();
    const workDir = join(root, 'workdir');
    await mkdir(workDir);
    const blocks = await store.ingestTurn('tmux-many', [
      image(PNG, 'image/png', 'first.png'),
      image(JPEG, 'image/jpeg', 'second.jpg'),
    ]);

    const first = await store.materializeForWorkdir({
      workDir, sessionId: 'tmux-many', digest: blocks[0].attachment.digest,
    });
    await writeFile(first, 'workspace poison');
    const repeated = await store.materializeForWorkdir({
      workDir, sessionId: 'tmux-many', digest: blocks[0].attachment.digest,
    });
    const second = await store.materializeForWorkdir({
      workDir, sessionId: 'tmux-many', digest: blocks[1].attachment.digest,
    });

    assert.equal(repeated, first);
    assert.deepEqual(await readFile(first), PNG);
    assert.deepEqual(await readFile(second), JPEG);
    await access(first);
    await access(second);
  });
});
