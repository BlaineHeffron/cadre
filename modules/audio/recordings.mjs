import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { recordingManifestFromFiles } from './manifest.mjs';
import { legacyRootStatePath, runtimeStatePath } from '../ops/runtime-state.mjs';

const DEFAULT_STORE_FILE = runtimeStatePath('audio_recordings.json');
const LEGACY_STORE_FILE = legacyRootStatePath('audio_recordings.json');
const DEFAULT_EVIDENCE_MAX_BYTES = 262144;

function normalizeText(value) {
  return String(value || '').trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function recordingId(stem, contentHash) {
  const safeStem = normalizeText(stem)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'recording';
  return `audrec_${safeStem}_${normalizeText(contentHash).slice(0, 12)}`;
}

function capText(value = '', maxBytes = DEFAULT_EVIDENCE_MAX_BYTES) {
  const text = normalizeText(value);
  const limit = Math.max(1024, Number(maxBytes || DEFAULT_EVIDENCE_MAX_BYTES));
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= limit) return { text, capped: false, originalBytes: buffer.length, storedBytes: buffer.length };
  const capped = buffer.subarray(0, limit).toString('utf8').replace(/\uFFFD+$/g, '');
  return { text: capped, capped: true, originalBytes: buffer.length, storedBytes: Buffer.byteLength(capped, 'utf8') };
}

function normalizeState(raw = {}) {
  return {
    version: 1,
    recordings: raw?.recordings && typeof raw.recordings === 'object' ? clone(raw.recordings) : {},
    evidence: raw?.evidence && typeof raw.evidence === 'object' ? clone(raw.evidence) : {},
    logicalIndex: raw?.logicalIndex && typeof raw.logicalIndex === 'object' ? clone(raw.logicalIndex) : {},
  };
}

function safeRecording(recording = null) {
  if (!recording || typeof recording !== 'object') return null;
  return {
    id: normalizeText(recording.id),
    logicalId: normalizeText(recording.logicalId),
    revision: Number(recording.revision || 0) || 1,
    stem: normalizeText(recording.stem),
    sourceTool: normalizeText(recording.sourceTool),
    capturedAtMs: Number(recording.capturedAtMs || 0) || null,
    importedAtMs: Number(recording.importedAtMs || 0) || null,
    updatedAtMs: Number(recording.updatedAtMs || 0) || null,
    transcriptPath: recording.transcriptPath || null,
    summaryPath: recording.summaryPath || null,
    metaPath: recording.metaPath || null,
    audioPath: recording.audioPath || null,
    wordCount: Number(recording.wordCount || 0),
    durationSec: Number(recording.durationSec || 0) || null,
    language: normalizeText(recording.language || '') || null,
    participantCount: Number(recording.participantCount || 0) || null,
    contentHash: normalizeText(recording.contentHash),
    tags: Array.isArray(recording.tags) ? recording.tags.map(normalizeText).filter(Boolean) : [],
    hasSummary: recording.hasSummary === true,
    evidenceRef: normalizeText(recording.evidenceRef),
    lastActionSessionId: normalizeText(recording.lastActionSessionId || '') || null,
    actionSessionIds: Array.isArray(recording.actionSessionIds)
      ? recording.actionSessionIds.map(normalizeText).filter(Boolean)
      : [],
    actionContext: normalizeText(recording.actionContext || ''),
    actionWorkDir: normalizeText(recording.actionWorkDir || ''),
  };
}

export function buildEvidencePacket(recording, group = {}, {
  nowMs = Date.now(),
  evidenceMaxBytes = DEFAULT_EVIDENCE_MAX_BYTES,
} = {}) {
  const transcript = capText(group.transcript?.content || '', evidenceMaxBytes);
  const summary = capText(group.summary?.content || '', evidenceMaxBytes);
  return {
    recordingId: recording.id,
    logicalId: recording.logicalId,
    evidenceRef: recording.evidenceRef,
    capturedAtMs: recording.capturedAtMs,
    importedAtMs: nowMs,
    manifest: {
      stem: recording.stem,
      sourceTool: recording.sourceTool,
      wordCount: recording.wordCount,
      durationSec: recording.durationSec,
      language: recording.language,
      participantCount: recording.participantCount,
      contentHash: recording.contentHash,
      tags: recording.tags,
      hasSummary: recording.hasSummary,
      transcriptPath: recording.transcriptPath,
      summaryPath: recording.summaryPath,
      metaPath: recording.metaPath,
      audioPath: recording.audioPath,
    },
    transcript: transcript.text,
    summary: summary.text,
    capped: transcript.capped || summary.capped,
    transcriptBytes: { original: transcript.originalBytes, stored: transcript.storedBytes },
    summaryBytes: { original: summary.originalBytes, stored: summary.storedBytes },
  };
}

export function buildAudioRecordingStore({
  storeFile = DEFAULT_STORE_FILE,
  namespace = 'audio_recordings',
  stateStore,
  env = process.env,
  modeEnvKey = 'APP_STATE_STORAGE',
  now = () => Date.now(),
  evidenceMaxBytes = DEFAULT_EVIDENCE_MAX_BYTES,
} = {}) {
  const backingStore = stateStore || buildPostgresJsonStore({
    namespace,
    filePath: storeFile,
    legacyFilePath: storeFile === DEFAULT_STORE_FILE ? LEGACY_STORE_FILE : undefined,
    env,
    modeEnvKey,
  });
  let loaded = false;
  let loadingPromise = null;
  let saveQueue = Promise.resolve();
  let state = normalizeState(backingStore.loadSync?.() || {});

  async function load() {
    if (loaded) return;
    if (!loadingPromise) {
      loadingPromise = (async () => {
        const raw = await backingStore.load().catch(() => null);
        if (raw && typeof raw === 'object') state = normalizeState(raw);
        loaded = true;
      })().finally(() => {
        loadingPromise = null;
      });
    }
    await loadingPromise;
  }

  async function save() {
    const snapshot = clone(state);
    const write = saveQueue.catch(() => {}).then(() => backingStore.save(snapshot));
    saveQueue = write.catch(() => {});
    await write;
  }

  async function ingestGroup(group = {}) {
    await load();
    const manifest = recordingManifestFromFiles(group);
    const nowMs = now();
    const id = recordingId(manifest.stem, manifest.contentHash);
    const existing = state.recordings[id];
    if (existing) {
      return { recording: safeRecording(existing), evidence: clone(state.evidence[existing.evidenceRef]), events: [] };
    }

    const logicalId = `audio:${manifest.stem}`;
    const priorIds = Array.isArray(state.logicalIndex[logicalId]) ? state.logicalIndex[logicalId] : [];
    const recording = {
      id,
      logicalId,
      revision: priorIds.length + 1,
      stem: manifest.stem,
      sourceTool: manifest.sourceTool,
      capturedAtMs: manifest.capturedAtMs,
      importedAtMs: nowMs,
      updatedAtMs: nowMs,
      transcriptPath: manifest.transcriptPath,
      summaryPath: manifest.summaryPath,
      metaPath: manifest.metaPath,
      audioPath: manifest.audioPath,
      wordCount: manifest.wordCount,
      durationSec: manifest.durationSec,
      language: manifest.language,
      participantCount: manifest.participantCount,
      contentHash: manifest.contentHash,
      tags: manifest.tags,
      hasSummary: manifest.hasSummary,
      evidenceRef: `audio_evidence:${id}`,
      lastActionSessionId: null,
      actionSessionIds: [],
      actionContext: '',
      actionWorkDir: '',
    };
    const evidence = buildEvidencePacket(recording, group, { nowMs, evidenceMaxBytes });
    state.recordings[id] = recording;
    state.evidence[recording.evidenceRef] = evidence;
    state.logicalIndex[logicalId] = [...priorIds, id];
    await save();
    return {
      recording: safeRecording(recording),
      evidence: clone(evidence),
      events: [{ type: priorIds.length ? 'revised' : 'ingested', recordingId: id, logicalId }],
    };
  }

  async function listRecordings({ sourceTool = '', tag = '' } = {}) {
    await load();
    const normalizedSourceTool = normalizeText(sourceTool).toLowerCase();
    const normalizedTag = normalizeText(tag).toLowerCase();
    return Object.values(state.recordings)
      .filter((recording) => !normalizedSourceTool || recording.sourceTool === normalizedSourceTool)
      .filter((recording) => !normalizedTag || (recording.tags || []).includes(normalizedTag))
      .sort((a, b) => Number(b.capturedAtMs || b.importedAtMs || 0) - Number(a.capturedAtMs || a.importedAtMs || 0))
      .map(safeRecording);
  }

  async function getRecording(id) {
    await load();
    return safeRecording(state.recordings[normalizeText(id)]);
  }

  async function getEvidence(idOrRef) {
    await load();
    const key = normalizeText(idOrRef);
    const recording = state.recordings[key];
    const evidenceKey = recording?.evidenceRef || key;
    const evidence = state.evidence[evidenceKey];
    return evidence ? clone(evidence) : null;
  }

  async function annotateAction(id, { sessionId = '', nowMs = now() } = {}) {
    await load();
    const recording = state.recordings[normalizeText(id)];
    const normalizedSessionId = normalizeText(sessionId);
    if (!recording || !normalizedSessionId) return null;
    const actionSessionIds = Array.isArray(recording.actionSessionIds)
      ? recording.actionSessionIds.map(normalizeText).filter(Boolean)
      : [];
    const nextIds = actionSessionIds.includes(normalizedSessionId)
      ? actionSessionIds
      : [...actionSessionIds, normalizedSessionId];
    const next = {
      ...recording,
      lastActionSessionId: normalizedSessionId,
      actionSessionIds: nextIds,
      updatedAtMs: nowMs,
    };
    state.recordings[next.id] = next;
    await save();
    return safeRecording(next);
  }

  async function updateActionSettings(id, { context = '', workDir = '', nowMs = now() } = {}) {
    await load();
    const recording = state.recordings[normalizeText(id)];
    if (!recording) return null;
    const next = {
      ...recording,
      actionContext: normalizeText(context),
      actionWorkDir: normalizeText(workDir),
      updatedAtMs: nowMs,
    };
    state.recordings[next.id] = next;
    await save();
    return safeRecording(next);
  }

  async function close() {
    await saveQueue.catch(() => {});
    if (typeof backingStore.close === 'function') await backingStore.close();
  }

  return {
    ingestGroup,
    listRecordings,
    getRecording,
    getEvidence,
    annotateAction,
    updateActionSettings,
    close,
  };
}

export function safeAudioRecording(recording) {
  return safeRecording(recording);
}

export const AUDIO_RECORDING_DEFAULTS = Object.freeze({
  namespace: 'audio_recordings',
  evidenceMaxBytes: DEFAULT_EVIDENCE_MAX_BYTES,
});
