import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

const TRANSCRIPT_EXTENSIONS = new Set(['.txt', '.md', '.vtt', '.srt']);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.wav']);

function normalizeText(value) {
  return String(value || '').trim();
}

function safeToken(value, fallback = 'recording') {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || fallback;
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function parseMs(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function isSummaryPath(path = '') {
  const name = basename(path).toLowerCase();
  return name.endsWith('.summary.md') || name.endsWith('.summary.txt');
}

function stemForPath(path = '') {
  const name = basename(path);
  const lower = name.toLowerCase();
  if (lower.endsWith('.summary.md')) return name.slice(0, -'.summary.md'.length);
  if (lower.endsWith('.summary.txt')) return name.slice(0, -'.summary.txt'.length);
  return name.slice(0, name.length - extname(name).length);
}

function parseJsonSidecar(text = '') {
  if (!normalizeText(text)) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function wordCount(text = '') {
  const matches = normalizeText(text).match(/\S+/g);
  return matches ? matches.length : 0;
}

function safePathInfo(file = null) {
  if (!file) return null;
  return {
    path: normalizeText(file.path),
    size: Number(file.size || 0) || null,
  };
}

function sourceToolFrom(group = {}, meta = {}) {
  return safeToken(
    group.sourceTool
      || meta.sourceTool
      || meta.source_tool
      || meta.app
      || meta.provider
      || 'folder_sync',
    'folder_sync'
  );
}

export function groupRecordingFiles(files = []) {
  const groups = new Map();
  for (const file of Array.isArray(files) ? files : []) {
    const path = normalizeText(file?.path);
    if (!path) continue;
    const stem = safeToken(file.stem || stemForPath(path));
    const ext = extname(path).toLowerCase();
    const group = groups.get(stem) || { stem, files: [] };
    group.files.push(file);
    groups.set(stem, group);
    if (isSummaryPath(path)) group.summary = file;
    else if (ext === '.json') group.meta = file;
    else if (AUDIO_EXTENSIONS.has(ext)) group.audio = file;
    else if (TRANSCRIPT_EXTENSIONS.has(ext) && !group.transcript) group.transcript = file;
  }
  return [...groups.values()].sort((a, b) => a.stem.localeCompare(b.stem));
}

export function recordingManifestFromFiles(group = {}) {
  const files = Array.isArray(group.files) ? group.files : [];
  const transcript = group.transcript || files.find((file) =>
    TRANSCRIPT_EXTENSIONS.has(extname(normalizeText(file?.path)).toLowerCase()) && !isSummaryPath(file.path)
  );
  const summary = group.summary || files.find((file) => isSummaryPath(file?.path));
  const metaFile = group.meta || files.find((file) => extname(normalizeText(file?.path)).toLowerCase() === '.json');
  const audio = group.audio || files.find((file) => AUDIO_EXTENSIONS.has(extname(normalizeText(file?.path)).toLowerCase()));
  const stem = safeToken(group.stem || stemForPath(transcript?.path || summary?.path || metaFile?.path || audio?.path || 'recording'));
  const meta = parseJsonSidecar(metaFile?.content);
  const transcriptText = normalizeText(transcript?.content);
  const summaryText = normalizeText(summary?.content);
  const contentHash = sha256Hex(JSON.stringify({ stem, transcript: transcriptText, summary: summaryText }));
  const capturedAtMs = parseMs(
    group.capturedAtMs
      || meta.capturedAtMs
      || meta.captured_at
      || meta.createdAt
      || meta.created_at
      || meta.date
  );
  const durationSec = Number(meta.durationSec || meta.duration_sec || meta.duration || 0) || null;
  const participantCount = Number(meta.participantCount || meta.participant_count || meta.speakers || 0) || null;
  const language = normalizeText(meta.language || meta.lang || '') || null;

  return {
    stem,
    sourceTool: sourceToolFrom(group, meta),
    capturedAtMs,
    transcriptPath: safePathInfo(transcript),
    summaryPath: safePathInfo(summary),
    metaPath: safePathInfo(metaFile),
    audioPath: safePathInfo(audio),
    wordCount: wordCount(transcriptText),
    transcriptBytes: Buffer.byteLength(transcriptText, 'utf8'),
    summaryBytes: Buffer.byteLength(summaryText, 'utf8'),
    durationSec,
    language,
    participantCount,
    contentHash,
    hasSummary: Boolean(summaryText),
    tags: safeRecordingMarkers({
      wordCount: wordCount(transcriptText),
      durationSec,
      hasSummary: Boolean(summaryText),
      audioPath: safePathInfo(audio),
    }),
  };
}

export function safeRecordingMarkers(manifest = {}) {
  const markers = [];
  if (manifest.hasSummary) markers.push('has_summary');
  if (Number(manifest.wordCount || 0) >= 3000) markers.push('long_recording');
  if (Number(manifest.durationSec || 0) >= 3600) markers.push('long_audio');
  if (manifest.audioPath) markers.push('has_audio_reference');
  return markers;
}

export const AUDIO_MANIFEST_FILE_TYPES = Object.freeze({
  transcripts: [...TRANSCRIPT_EXTENSIONS],
  audio: [...AUDIO_EXTENSIONS],
});
