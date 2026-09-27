import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { legacyRootStatePath, runtimeStatePath } from '../ops/runtime-state.mjs';

const DEFAULT_STORE_FILE = runtimeStatePath('quick_capture.json');
const LEGACY_STORE_FILE = legacyRootStatePath('quick_capture.json');
const MAX_TEXT_LENGTH = 20000;
const MAX_NOTES = 500;

function resolveStoreFile(storeFile) {
  return resolve(storeFile || process.env.QUICK_CAPTURE_FILE || DEFAULT_STORE_FILE);
}

function buildStore(storeFile) {
  return buildPostgresJsonStore({
    namespace: 'quick_capture',
    filePath: resolveStoreFile(storeFile),
    legacyFilePath: storeFile ? undefined : LEGACY_STORE_FILE,
    modeEnvKey: 'QUICK_CAPTURE_STORAGE',
    keepFileMirror: true,
  });
}

function normalizeNote(input) {
  if (!input || typeof input !== 'object') return null;
  const text = typeof input.text === 'string' ? input.text : '';
  if (!text.trim()) return null;
  return {
    id: typeof input.id === 'string' && input.id ? input.id : randomUUID(),
    text,
    createdAt: Number(input.createdAt) || Date.now(),
  };
}

function readNotes(value) {
  const notes = Array.isArray(value?.notes) ? value.notes : [];
  return notes.map(normalizeNote).filter(Boolean);
}

// Newest first; createdAt is monotonic (see create) so it is a total, deterministic order.
function byNewest(a, b) {
  return b.createdAt - a.createdAt;
}

// Serialize read-modify-write so concurrent requests cannot lose notes.
function createSerializer() {
  let tail = Promise.resolve();
  return function run(task) {
    const next = tail.then(task, task);
    // Keep the chain alive even if a task rejects.
    tail = next.then(() => {}, () => {});
    return next;
  };
}

export function buildQuickCaptureService({ storeFile } = {}) {
  const store = buildStore(storeFile);
  const serialize = createSerializer();
  let lastCreatedAt = 0;

  async function list({ limit } = {}) {
    const value = await store.load();
    const notes = readNotes(value).sort(byNewest);
    const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : notes.length;
    return notes.slice(0, max);
  }

  function create({ text } = {}) {
    return serialize(async () => {
      const raw = typeof text === 'string' ? text : '';
      const trimmed = raw.trim();
      if (!trimmed) {
        const err = new Error('Note text is required');
        err.statusCode = 400;
        throw err;
      }
      if (raw.length > MAX_TEXT_LENGTH) {
        // Reject rather than silently truncate so dictated content is never lost without notice.
        const err = new Error(`Note exceeds ${MAX_TEXT_LENGTH} character limit`);
        err.statusCode = 413;
        throw err;
      }
      const value = await store.load();
      const notes = readNotes(value);
      // Monotonic createdAt: guarantees a deterministic newest-first order even when
      // two notes are created within the same millisecond.
      const maxExisting = notes.reduce((m, n) => Math.max(m, n.createdAt), 0);
      const createdAt = Math.max(Date.now(), lastCreatedAt + 1, maxExisting + 1);
      lastCreatedAt = createdAt;
      const note = normalizeNote({ text: raw, createdAt });
      notes.push(note);
      const bounded = notes.sort(byNewest).slice(0, MAX_NOTES);
      await store.save({ notes: bounded });
      return note;
    });
  }

  function remove(id) {
    return serialize(async () => {
      const target = String(id || '');
      const value = await store.load();
      const notes = readNotes(value);
      const next = notes.filter((note) => note.id !== target);
      const removed = next.length !== notes.length;
      if (removed) await store.save({ notes: next });
      return removed;
    });
  }

  return { list, create, remove };
}

export async function quickCapturePlugin(app, opts = {}) {
  const service = buildQuickCaptureService(opts);

  app.get('/api/capture/notes', async (req) => {
    const limit = Number(req.query?.limit);
    const notes = await service.list({ limit: Number.isFinite(limit) ? limit : undefined });
    return { notes };
  });

  app.post('/api/capture/notes', async (req, reply) => {
    try {
      const note = await service.create({ text: req.body?.text });
      return reply.code(201).send({ note });
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: error.message });
    }
  });

  app.delete('/api/capture/notes/:id', async (req, reply) => {
    const removed = await service.remove(req.params?.id);
    if (!removed) return reply.code(404).send({ error: 'Note not found' });
    return { ok: true };
  });
}
