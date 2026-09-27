import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat, mkdir, open, readFile, readdir, realpath, rename, rm,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { DEFAULT_ATTACHMENT_MIME_TYPES, normalizePromptCapabilities } from './prompt-blocks.mjs';

const INDEX_VERSION = 1;
function digestBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sessionKey(sessionId) {
  return createHash('sha256').update(String(sessionId || '')).digest('hex');
}

function safeName(value = '') {
  const name = basename(String(value || '')).replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120);
  return name || undefined;
}

function storeError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function decodeBase64(value, maxBytes) {
  const encoded = String(value || '');
  if (!encoded || encoded.length % 4 !== 0) throw storeError('attachment_invalid_base64', 'Attachment data must be non-empty canonical base64');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const decodedBytes = ((encoded.length / 4) * 3) - padding;
  if (decodedBytes > maxBytes) throw storeError('attachment_file_quota_exceeded', `Attachment exceeds the ${maxBytes}-byte file limit`, 413);
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.toString('base64') !== encoded) throw storeError('attachment_invalid_base64', 'Attachment data must be non-empty canonical base64');
  return bytes;
}

function isUtf8Text(bytes) {
  if (!bytes.length || bytes.includes(0)) return false;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text);
}

export function sniffMimeType(input) {
  const bytes = Buffer.from(input || []);
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav';
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString('ascii') === 'OggS') return 'audio/ogg';
  if (bytes.length >= 3 && (bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0))) return 'audio/mpeg';
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (isUtf8Text(bytes)) {
    try { JSON.parse(bytes.toString('utf8')); return 'application/json'; } catch { return 'text/plain'; }
  }
  return 'application/octet-stream';
}

function attachmentInput(block, maxBytes) {
  if (block.type === 'embedded_resource') {
    const resource = block.resource || {};
    if (typeof resource.text === 'string') {
      if (Buffer.byteLength(resource.text, 'utf8') > maxBytes) {
        throw storeError('attachment_file_quota_exceeded', `Attachment exceeds the ${maxBytes}-byte file limit`, 413);
      }
      return { bytes: Buffer.from(resource.text, 'utf8'), declared: resource.mimeType || 'text/plain', name: resource.name, uri: resource.uri };
    }
    return { bytes: decodeBase64(resource.blob ?? resource.data, maxBytes), declared: resource.mimeType, name: resource.name, uri: resource.uri };
  }
  return { bytes: decodeBase64(block.data, maxBytes), declared: block.mimeType, name: block.name };
}

function redactedBlock(block, reference) {
  if (block.type === 'embedded_resource') {
    return {
      type: 'embedded_resource',
      resource: {
        uri: String(block.resource?.uri || ''),
        attachment: reference,
      },
    };
  }
  return { type: block.type, attachment: reference };
}

function extensionForMime(mimeType) {
  return ({
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg',
    'application/pdf': 'pdf', 'application/json': 'json', 'text/plain': 'txt',
  })[mimeType] || 'bin';
}

export class AttachmentStore {
  constructor({
    rootDir,
    maxFileBytes = 8 * 1024 * 1024,
    maxTurnCount = 8,
    maxSessionBytes = 64 * 1024 * 1024,
    mimeAllowlist = DEFAULT_ATTACHMENT_MIME_TYPES,
  } = {}) {
    if (!rootDir || !isAbsolute(rootDir)) throw new TypeError('AttachmentStore rootDir must be absolute');
    this.#setRootDir(rootDir);
    this.policy = normalizePromptCapabilities({
      types: ['text', 'image', 'audio', 'embedded_resource', 'resource_link'],
      deliveryMode: 'inline', mimeAllowlist, maxBytes: maxFileBytes,
      maxCount: maxTurnCount, maxSessionBytes,
    });
    this.state = { version: INDEX_VERSION, sessions: {}, blobs: {} };
    this.initialized = false;
    this.lock = Promise.resolve();
  }

  capabilities() { return this.policy; }

  async init() {
    if (this.initialized) return this;
    await this.#canonicalizeRoot();
    await this.#assertNoSymlinkAncestors(this.rootDir, { allowMissing: true });
    await mkdir(this.blobDir, { recursive: true, mode: 0o700 });
    await mkdir(this.tmpDir, { recursive: true, mode: 0o700 });
    await this.#assertDirectory(this.rootDir);
    await this.#assertDirectory(this.blobDir);
    await this.#assertDirectory(this.tmpDir);
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, 'utf8'));
      if (parsed?.version === INDEX_VERSION && parsed.sessions && parsed.blobs) this.state = parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    for (const name of await readdir(this.tmpDir)) await rm(join(this.tmpDir, name), { force: true });
    const referenced = new Set(Object.keys(this.state.blobs));
    for (const name of await readdir(this.blobDir)) {
      if (!/^[a-f0-9]{64}$/.test(name) || !referenced.has(name)) await rm(join(this.blobDir, name), { force: true });
    }
    this.initialized = true;
    return this;
  }

  async ingestTurn(sessionId, blocks, capabilities = this.policy) {
    await this.init();
    const id = String(sessionId || '');
    if (!id) throw new TypeError('sessionId is required');
    const caps = normalizePromptCapabilities(capabilities);
    const inputs = [];
    for (const [index, block] of (blocks || []).entries()) {
      if (['text', 'resource_link'].includes(block?.type)) continue;
      const input = attachmentInput(block || {}, caps.maxBytes);
      const sniffed = sniffMimeType(input.bytes);
      const declared = String(input.declared || '').toLowerCase();
      if (!declared || sniffed !== declared) {
        throw storeError('attachment_mime_mismatch', `Attachment ${index + 1} declared ${declared || 'no MIME type'} but contains ${sniffed}`);
      }
      if (block.type === 'image' && !sniffed.startsWith('image/')) throw storeError('attachment_type_mismatch', 'Image block does not contain an image');
      if (block.type === 'audio' && !sniffed.startsWith('audio/')) throw storeError('attachment_type_mismatch', 'Audio block does not contain audio');
      if (!caps.mimeAllowlist.includes(sniffed)) throw storeError('attachment_mime_unsupported', `MIME type is not negotiated: ${sniffed}`, 415);
      if (input.bytes.length > caps.maxBytes) throw storeError('attachment_file_quota_exceeded', `Attachment exceeds the ${caps.maxBytes}-byte file limit`, 413);
      inputs.push({ index, block, ...input, mimeType: sniffed, digest: digestBytes(input.bytes) });
    }
    if (inputs.length > caps.maxCount) throw storeError('attachment_turn_quota_exceeded', `Turn exceeds the ${caps.maxCount}-attachment limit`, 413);

    return this.#serialized(async () => {
      const key = sessionKey(id);
      const before = structuredClone(this.state);
      const session = this.state.sessions[key] || { sessionId: id, bytes: 0, refs: {} };
      const newDigests = new Set(inputs.filter((item) => !session.refs[item.digest]).map((item) => item.digest));
      const addedBytes = [...newDigests].reduce((sum, digest) => sum + inputs.find((item) => item.digest === digest).bytes.length, 0);
      if (session.bytes + addedBytes > caps.maxSessionBytes) {
        throw storeError('attachment_session_quota_exceeded', `Session exceeds the ${caps.maxSessionBytes}-byte attachment quota`, 413);
      }
      const created = [];
      try {
        for (const item of inputs) {
          if (!this.state.blobs[item.digest]) {
            await this.#writeBlob(item.digest, item.bytes);
            created.push(item.digest);
            this.state.blobs[item.digest] = { mimeType: item.mimeType, bytes: item.bytes.length, refs: 0 };
          } else if (this.state.blobs[item.digest].mimeType !== item.mimeType || this.state.blobs[item.digest].bytes !== item.bytes.length) {
            throw storeError('attachment_integrity_error', 'Stored digest metadata does not match attachment bytes', 500);
          }
          const ref = session.refs[item.digest];
          if (ref) ref.count += 1;
          else {
            session.refs[item.digest] = { count: 1, mimeType: item.mimeType, bytes: item.bytes.length, name: safeName(item.name) };
            session.bytes += item.bytes.length;
            this.state.blobs[item.digest].refs += 1;
          }
        }
        this.state.sessions[key] = session;
        await this.#persist();
      } catch (error) {
        this.state = before;
        for (const digest of created) await rm(join(this.blobDir, digest), { force: true }).catch(() => {});
        throw error;
      }
      const output = structuredClone(blocks || []);
      for (const item of inputs) {
        output[item.index] = redactedBlock(item.block, Object.freeze({
          digest: item.digest, mimeType: item.mimeType, bytes: item.bytes.length,
          ...(safeName(item.name) ? { name: safeName(item.name) } : {}),
        }));
      }
      return output;
    });
  }

  async read(sessionId, digest) {
    await this.init();
    const id = String(sessionId || '');
    const key = String(digest || '');
    const ref = this.state.sessions[sessionKey(id)]?.refs?.[key];
    if (!ref) throw storeError('attachment_access_denied', 'Attachment is not authorized for this session', 403);
    const path = join(this.blobDir, key);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) throw storeError('attachment_integrity_error', 'Attachment blob is missing or unsafe', 500);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    let bytes;
    try { bytes = await handle.readFile(); } finally { await handle.close(); }
    if (bytes.length !== ref.bytes || digestBytes(bytes) !== key || sniffMimeType(bytes) !== ref.mimeType) {
      throw storeError('attachment_integrity_error', 'Attachment blob failed integrity verification', 500);
    }
    return { data: bytes, ref: { digest: key, ...structuredClone(ref), count: undefined } };
  }

  async hydrateBlocks(sessionId, blocks) {
    const output = [];
    for (const block of blocks || []) {
      const attachment = block.type === 'embedded_resource' ? block.resource?.attachment : block.attachment;
      if (!attachment) { output.push(structuredClone(block)); continue; }
      const stored = await this.read(sessionId, attachment.digest);
      if (block.type === 'embedded_resource') {
        output.push({
          type: 'embedded_resource',
          resource: {
            uri: String(block.resource?.uri || ''), mimeType: stored.ref.mimeType,
            blob: stored.data.toString('base64'),
          },
        });
      } else {
        output.push({
          type: block.type,
          mimeType: stored.ref.mimeType,
          data: stored.data.toString('base64'),
          ...(attachment.name ? { name: attachment.name } : {}),
        });
      }
    }
    return output;
  }

  async releaseSession(sessionId) {
    await this.init();
    return this.#serialized(async () => {
      const id = String(sessionId || '');
      const key = sessionKey(id);
      const session = this.state.sessions[key];
      if (!session) return false;
      delete this.state.sessions[key];
      for (const digest of Object.keys(session.refs)) {
        const blob = this.state.blobs[digest];
        if (!blob) continue;
        blob.refs -= 1;
        if (blob.refs <= 0) {
          delete this.state.blobs[digest];
          await rm(join(this.blobDir, digest), { force: true });
        }
      }
      await this.#persist();
      return true;
    });
  }

  async materializeForWorkdir({ sessionId, digest, workDir }) {
    const root = resolve(String(workDir || ''));
    if (!isAbsolute(root)) throw storeError('attachment_path_invalid', 'Work directory must be absolute');
    const canonical = await realpath(root);
    if (canonical !== root) throw storeError('attachment_path_invalid', 'Work directory must be canonical');
    const directory = join(root, '.dueno_attachments');
    await this.#assertNoSymlinkAncestors(directory, { stopAt: root, allowMissing: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.#assertDirectory(directory);
    const stored = await this.read(sessionId, digest);
    const target = join(directory, `${digest}.${extensionForMime(stored.ref.mimeType)}`);
    const info = await lstat(target).catch(() => null);
    if (info?.isSymbolicLink() || (info && !info.isFile())) throw storeError('attachment_path_invalid', 'Downgrade target is unsafe');
    // Rewrite even an existing regular file so an untrusted workspace cannot
    // pre-seed the digest-named handoff with different bytes.
    await this.#atomicWrite(target, stored.data, { tmpDir: directory });
    return target;
  }

  async #serialized(operation) {
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolveLock) => { release = resolveLock; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  async #writeBlob(digest, bytes) {
    const target = join(this.blobDir, digest);
    const existing = await lstat(target).catch(() => null);
    if (existing) {
      if (existing.isSymbolicLink() || !existing.isFile()) throw storeError('attachment_path_invalid', 'Attachment blob target is unsafe');
      return;
    }
    await this.#atomicWrite(target, bytes);
  }

  async #atomicWrite(target, bytes, { tmpDir = this.tmpDir } = {}) {
    const tmp = join(tmpDir, `${randomBytes(16).toString('hex')}.tmp`);
    const handle = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await rename(tmp, target); } catch (error) { await rm(tmp, { force: true }); throw error; }
    const directory = await open(dirname(target), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async #persist() {
    const tmp = join(this.tmpDir, `${randomBytes(16).toString('hex')}.json`);
    const handle = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
    try { await handle.writeFile(`${JSON.stringify(this.state)}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(tmp, this.indexPath);
    const directory = await open(this.rootDir, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async #assertDirectory(path) {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw storeError('attachment_path_invalid', `Attachment path is not a safe directory: ${path}`);
  }

  #setRootDir(rootDir) {
    this.rootDir = resolve(rootDir);
    this.blobDir = join(this.rootDir, 'blobs');
    this.tmpDir = join(this.rootDir, 'tmp');
    this.indexPath = join(this.rootDir, 'index.json');
  }

  async #canonicalizeRoot() {
    const requestedRoot = this.rootDir;
    const missingSegments = [];
    let current = requestedRoot;
    while (true) {
      const info = await lstat(current).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (info) {
        if (current === requestedRoot && info.isSymbolicLink()) {
          throw storeError('attachment_path_invalid', `Symlink is not allowed as attachment root: ${requestedRoot}`);
        }
        const canonicalBase = await realpath(current);
        this.#setRootDir(join(canonicalBase, ...missingSegments));
        return;
      }
      const parent = dirname(current);
      if (parent === current) throw storeError('attachment_path_invalid', `Attachment root has no existing ancestor: ${requestedRoot}`);
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }

  async #assertNoSymlinkAncestors(path, { stopAt = sep, allowMissing = false } = {}) {
    let current = resolve(path);
    const stop = resolve(stopAt);
    while (current.startsWith(stop)) {
      const info = await lstat(current).catch((error) => {
        if (allowMissing && error?.code === 'ENOENT') return null;
        throw error;
      });
      if (info?.isSymbolicLink()) throw storeError('attachment_path_invalid', `Symlink is not allowed in attachment path: ${current}`);
      if (current === stop) break;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
}
