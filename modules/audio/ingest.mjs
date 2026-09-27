import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { readdir, rm, stat as statAsync } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { groupRecordingFiles } from './manifest.mjs';

const READ_EXTENSIONS = new Set(['.txt', '.md', '.vtt', '.srt', '.json']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav']);
const ACCEPTED_EXTENSIONS = new Set([...READ_EXTENSIONS, ...AUDIO_EXTENSIONS]);
const MAX_READ_BYTES = 2 * 1024 * 1024;

function normalizeText(value) {
  return String(value || '').trim();
}

export function expandHomePath(value = '') {
  const text = normalizeText(value);
  if (!text) return '';
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return resolve(homedir(), text.slice(2));
  return text;
}

function resolveInboxDir(inboxDir) {
  const resolved = resolve(expandHomePath(inboxDir || '~/.dueno-fleet/audio-inbox'));
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

function assertInside(root, path) {
  if (!path.startsWith(root + '/') && path !== root) {
    throw new Error('Recording inbox path escaped configured root');
  }
}

function safeFile(inboxRoot, name) {
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0') || name.includes('..')) {
    throw new Error('Invalid recording file name');
  }
  const path = resolve(inboxRoot, name);
  assertInside(inboxRoot, path);
  const realPath = realpathSync(path);
  assertInside(inboxRoot, realPath);
  const lstat = lstatSync(realPath);
  if (lstat.isSymbolicLink()) throw new Error('Symlinks are not allowed');
  return realPath;
}

function readLeaf(inboxRoot, entry) {
  const path = safeFile(inboxRoot, entry.name);
  const stat = statSync(path);
  if (!stat.isFile()) return null;
  const ext = extname(entry.name).toLowerCase();
  if (!ACCEPTED_EXTENSIONS.has(ext)) return null;
  if (AUDIO_EXTENSIONS.has(ext)) {
    return { path, size: stat.size, content: '' };
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error('Recording transcript file too large');
  }
  return { path, size: stat.size, content: readFileSync(path, 'utf8') };
}

export async function scanAudioInbox({
  inboxDir,
  store,
  onSnapshot,
  log,
} = {}) {
  if (!store || typeof store.ingestGroup !== 'function') throw new Error('audio_store_required');
  const inboxRoot = resolveInboxDir(inboxDir);
  if (!existsSync(inboxRoot)) return { scanned: 0, imported: [], skipped: [{ path: inboxRoot, reason: 'inbox_missing' }] };
  const entries = await readdir(inboxRoot, { withFileTypes: true });
  const files = [];
  const skipped = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) {
      skipped.push({ path: entry.name, reason: 'symlink_not_allowed' });
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const leaf = readLeaf(inboxRoot, entry);
      if (leaf) files.push(leaf);
    } catch (error) {
      skipped.push({ path: entry.name, reason: error.message || 'read_failed' });
      log?.warn?.({ file: entry.name, reason: error.message || 'read_failed' }, 'Audio recording file skipped');
    }
  }

  const groups = groupRecordingFiles(files).filter((group) => group.transcript || group.summary);
  const imported = [];
  for (const group of groups) {
    try {
      const result = await store.ingestGroup(group);
      imported.push({ id: result.recording.id, stem: result.recording.stem, events: result.events });
      if (result.events.length && typeof onSnapshot === 'function') {
        await onSnapshot(result);
      }
    } catch (error) {
      skipped.push({ path: group.stem, reason: error.message || 'ingest_failed' });
      log?.warn?.({ stem: group.stem, reason: error.message || 'ingest_failed' }, 'Audio recording group skipped');
    }
  }

  return { scanned: files.length, imported, skipped };
}

// Resolve + re-validate an audio blob path at delete time. Targets the manifest audioPath, which
// was produced under scan-time guards, but the file may have changed since — so re-check.
function safeAudioDeletePath(inboxRoot, audioPath) {
  const path = resolve(normalizeText(audioPath));
  assertInside(inboxRoot, path);
  let linkStat = null;
  try {
    linkStat = lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return { path, exists: false };
    throw error;
  }
  if (linkStat.isSymbolicLink()) throw new Error('Symlinks are not allowed');
  const realPath = realpathSync(path);
  assertInside(inboxRoot, realPath);
  if (!AUDIO_EXTENSIONS.has(extname(realPath).toLowerCase())) {
    throw new Error('Audio cleanup target is not an audio file');
  }
  return { path: realPath, exists: true };
}

// Policy-driven stale-audio cleanup. Deletes a recording's audio blob ONLY when the store holds a
// transcript evidence packet for it (transcriptBytes.stored > 0). Disk presence of a sibling .txt
// is NOT sufficient. Never touches transcript/summary/meta siblings. Bounded per pass. Idempotent.
export async function pruneStaleAudio({
  store,
  inboxDir,
  minAgeSec = 86400,
  maxPerPass = 20,
  now = () => Date.now(),
  log,
} = {}) {
  if (!store || typeof store.listRecordings !== 'function' || typeof store.getEvidence !== 'function') {
    throw new Error('audio_store_required');
  }
  const inboxRoot = resolveInboxDir(inboxDir);
  const recordings = await store.listRecordings();
  const deleted = [];
  const kept = [];
  const limit = Math.max(1, Number(maxPerPass || 20));
  const minAgeMs = Math.max(0, Number(minAgeSec || 0)) * 1000;
  let capped = 0;

  for (const recording of recordings) {
    if (!recording?.audioPath?.path) {
      kept.push({ id: normalizeText(recording?.id), reason: 'no_audio_path' });
      continue;
    }
    const evidence = await store.getEvidence(recording.evidenceRef || recording.id).catch(() => null);
    if (!evidence || Number(evidence.transcriptBytes?.stored || 0) <= 0) {
      kept.push({ id: recording.id, reason: 'evidence_missing' });
      continue;
    }
    try {
      const safe = safeAudioDeletePath(inboxRoot, recording.audioPath.path);
      if (!safe.exists) {
        kept.push({ id: recording.id, reason: 'absent' });
        continue;
      }
      const info = await statAsync(safe.path);
      if (!info.isFile()) {
        kept.push({ id: recording.id, reason: 'not_file' });
        continue;
      }
      // Floor at 0 so filesystem/clock skew (mtime a few ms ahead of now) cannot mask a stale file.
      const ageMs = Math.max(0, Number(now()) - Number(info.mtimeMs || 0));
      if (ageMs < minAgeMs) {
        kept.push({ id: recording.id, reason: 'too_young' });
        continue;
      }
      if (deleted.length >= limit) {
        capped += 1;
        kept.push({ id: recording.id, reason: 'capped' });
        continue;
      }
      await rm(safe.path, { force: true });
      deleted.push({ id: recording.id, audioPath: safe.path });
    } catch (error) {
      kept.push({ id: recording.id, reason: error.message || 'cleanup_failed' });
      log?.warn?.({ id: recording.id, reason: error.message || 'cleanup_failed' }, 'Stale audio cleanup skipped');
    }
  }

  if (capped > 0) {
    log?.warn?.({ deleted: deleted.length, capped, maxPerPass: limit }, 'Stale audio cleanup capped');
  }
  return { deleted, kept, scanned: recordings.length };
}

export const AUDIO_INGEST_DEFAULTS = Object.freeze({
  maxReadBytes: MAX_READ_BYTES,
  acceptedExtensions: [...ACCEPTED_EXTENSIONS],
});
