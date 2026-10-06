import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { config } from '../../config.mjs';
import { buildAudioRecordingStore, safeAudioRecording } from './recordings.mjs';
import { expandHomePath, pruneStaleAudio, scanAudioInbox } from './ingest.mjs';
import { defaultSessionLauncher } from '../fleet/index.mjs';

function normalizeText(value) {
  return String(value || '').trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeEvidence(evidence = null) {
  if (!evidence || typeof evidence !== 'object') return null;
  return {
    recordingId: normalizeText(evidence.recordingId),
    logicalId: normalizeText(evidence.logicalId),
    evidenceRef: normalizeText(evidence.evidenceRef),
    capturedAtMs: Number(evidence.capturedAtMs || 0) || null,
    importedAtMs: Number(evidence.importedAtMs || 0) || null,
    manifest: evidence.manifest && typeof evidence.manifest === 'object' ? clone(evidence.manifest) : {},
    transcript: normalizeText(evidence.transcript),
    summary: normalizeText(evidence.summary),
    capped: evidence.capped === true,
    transcriptBytes: evidence.transcriptBytes || null,
    summaryBytes: evidence.summaryBytes || null,
  };
}

function safeEvents(events = []) {
  return (Array.isArray(events) ? events : [])
    .map((event) => ({
      type: normalizeText(event?.type),
      recordingId: normalizeText(event?.recordingId),
      logicalId: normalizeText(event?.logicalId),
    }))
    .filter((event) => event.type);
}

function normalizeLimit(value, fallback = 50) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 200);
}

function normalizeOffset(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function buildAudioActionPrompt(recording = {}, evidenceDir = '') {
  const capturedAt = Number(recording.capturedAtMs || 0)
    ? new Date(Number(recording.capturedAtMs)).toISOString()
    : 'unknown';
  return [
    'Audio recording action request.',
    '',
    'Scope:',
    `- recordingId: ${normalizeText(recording.id)}`,
    `- stem: ${normalizeText(recording.stem)}`,
    `- sourceTool: ${normalizeText(recording.sourceTool) || 'unknown'}`,
    `- capturedAt: ${capturedAt}`,
    `- wordCount: ${Number(recording.wordCount || 0)}`,
    `- durationSec: ${Number(recording.durationSec || 0) || 'unknown'}`,
    `- language: ${normalizeText(recording.language || '') || 'unknown'}`,
    `- participantCount: ${Number(recording.participantCount || 0) || 'unknown'}`,
    `- tags: ${Array.isArray(recording.tags) && recording.tags.length ? recording.tags.map(normalizeText).join(', ') : 'none'}`,
    '',
    'Evidence access:',
    '- Raw transcript text is not included in this prompt.',
    `- Verbatim, byte-capped evidence: ${resolve(evidenceDir, 'evidence.md')}`,
    `- Recording manifest: ${resolve(evidenceDir, 'manifest.json')}`,
    `- Gated evidence endpoint: /api/recordings/${normalizeText(recording.id)}/evidence`,
    '',
    'Instructions:',
    '- Read the evidence first.',
    '- Derive notes, action candidates, and follow-up questions from the recording.',
    '- Do not send email, edit calendars, commit code, deploy, or mutate outside systems.',
    '- Any external action requires explicit human approval.',
    '- Stay scoped to this recording.',
    ...(normalizeText(recording.actionContext) ? [
      '',
      'Additional user context:',
      normalizeText(recording.actionContext),
    ] : []),
  ].join('\n');
}

async function stageEvidence(workDir, recording, evidence) {
  await mkdir(workDir, { recursive: true });
  await writeFile(resolve(workDir, 'manifest.json'), `${JSON.stringify(safeAudioRecording(recording), null, 2)}\n`);
  await writeFile(resolve(workDir, 'evidence.md'), [
    `# Recording Evidence: ${normalizeText(recording.stem)}`,
    '',
    `- recordingId: ${normalizeText(recording.id)}`,
    `- evidenceRef: ${normalizeText(recording.evidenceRef)}`,
    `- capped: ${evidence.capped === true}`,
    '',
    '## Provider Summary',
    '',
    evidence.summary || '_No provider summary supplied._',
    '',
    '## Transcript',
    '',
    evidence.transcript || '_No transcript supplied._',
    '',
  ].join('\n'));
}

async function resolveActionWorkDir(baseDir, recordingId) {
  const base = resolve(expandHomePath(baseDir || '~/.dueno-fleet/recordings'));
  const dir = resolve(base, normalizeText(recordingId) || 'recording');
  await mkdir(dir, { recursive: true });
  return dir;
}


const ACTION_CONTEXT_MAX_LENGTH = 12000;
const ACTION_WORKDIR_MAX_LENGTH = 4096;

function normalizeActionSettings(body = {}) {
  const context = normalizeText(body?.context);
  const workDir = normalizeText(body?.workDir);
  if (context.length > ACTION_CONTEXT_MAX_LENGTH) {
    const error = new Error(`Context exceeds ${ACTION_CONTEXT_MAX_LENGTH} characters`);
    error.statusCode = 400;
    throw error;
  }
  if (workDir.length > ACTION_WORKDIR_MAX_LENGTH) {
    const error = new Error('Working directory path is too long');
    error.statusCode = 400;
    throw error;
  }
  return { context, workDir };
}

async function validateActionLaunchDir(path) {
  const resolved = resolve(expandHomePath(path));
  const info = await stat(resolved).catch(() => null);
  if (!info?.isDirectory()) {
    const error = new Error('Agent working directory does not exist or is not a directory');
    error.statusCode = 400;
    throw error;
  }
  return resolved;
}

const TRANSCRIBE_SCRIPT = fileURLToPath(new URL('../../scripts/fleet-transcribe.sh', import.meta.url));

// whisper-cpp writes plain text; faster-whisper adds a header and `[start - end]` line prefixes.
function transcriptText(raw) {
  return raw.split('\n')
    .filter((line) => !/^(# Transcript:|Language:)/.test(line))
    .map((line) => line.replace(/^\[[\d.]+ - [\d.]+\]/, '').trim())
    .filter(Boolean)
    .join(' ');
}

// Push-to-talk dictation: run one clip through the same engine config (FLEET_TRANSCRIBE_ENGINE,
// FLEET_WHISPER_*) the inbox transcriber uses. The engine runs in its own process group; at the
// deadline, on abort, or if anything in the group outlives the wrapper, the group gets TERM, then
// KILL after five seconds, and cleanup waits until the group is gone.
async function transcribeClip(audio, ext, signal) {
  const dir = await mkdtemp(resolve(tmpdir(), 'cadre-ptt-'));
  let child;
  let stopping;
  let deadline;
  const group = (sig) => { try { process.kill(-child.pid, sig); return true; } catch { return false; } };
  const stop = () => {
    stopping ??= (async () => {
      group('SIGTERM');
      for (let i = 0; i < 50 && group(0); i++) await sleep(100);
      group('SIGKILL');
      for (let i = 0; i < 50 && group(0); i++) await sleep(100);
    })();
  };
  try {
    await writeFile(resolve(dir, `clip.${ext}`), audio);
    child = spawn(TRANSCRIBE_SCRIPT, [], {
      env: { ...process.env, FLEET_AUDIO_INBOX: dir, FLEET_TRANSCRIBE_GLOB: `clip.${ext}`, FLEET_TRANSCRIBE_MIN_AGE_SEC: '0' },
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    });
    deadline = setTimeout(stop, 120000);
    if (signal?.aborted) stop();
    signal?.addEventListener('abort', stop);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => {}); // spawn failures still emit `close` with a non-zero code
    const code = await new Promise((done) => child.on('close', done));
    if (code !== 0) throw Object.assign(new Error(`fleet-transcribe exited ${code}: ${stderr}`), { statusCode: code === 3 ? 503 : 502 });
    return transcriptText(await readFile(resolve(dir, 'clip.txt'), 'utf8'));
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', stop);
    // `close` only means the wrapper exited; an engine that dropped stderr can still be running.
    if (group(0)) stop();
    await stopping;
    await rm(dir, { recursive: true, force: true });
  }
}

// One engine run at a time across the process: each run loads a whole model onto the GPU/CPU.
let transcribing = false;

function startAudioIngestLoop({ sourceConfig, scan, log }) {
  if (sourceConfig.ingestEnabled !== true) return null;
  const handles = [];
  let timer = null;
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await scan();
    } catch (error) {
      log?.warn?.({ reason: error.message || 'scan_failed' }, 'Audio ingest scan failed');
    } finally {
      running = false;
    }
  };

  const schedule = (delayMs = 250) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, delayMs);
  };

  schedule(0);

  if (Number(sourceConfig.scanIntervalSec || 0) > 0) {
    const interval = setInterval(run, Number(sourceConfig.scanIntervalSec) * 1000);
    handles.push({ close: () => clearInterval(interval) });
  }

  if (sourceConfig.watchEnabled === true) {
    const inboxRoot = resolve(expandHomePath(sourceConfig.inboxDir || '~/.dueno-fleet/audio-inbox'));
    mkdir(inboxRoot, { recursive: true })
      .then(() => {
        const watcher = watch(inboxRoot, { persistent: false }, () => schedule(500));
        handles.push(watcher);
      })
      .catch((error) => {
        log?.warn?.({ reason: error.message || 'watch_failed' }, 'Audio ingest watcher failed');
      });
  }

  return {
    close() {
      if (timer) clearTimeout(timer);
      for (const handle of handles) handle.close?.();
    },
  };
}

export async function audioPlugin(app, opts = {}) {
  const sourceConfig = opts.config || config.audio || {};
  const wsManager = opts.wsManager || null;
  const store = opts.store || buildAudioRecordingStore({
    env: opts.env || process.env,
    evidenceMaxBytes: sourceConfig.evidenceMaxBytes,
  });
  const sessionLauncher = opts.sessionLauncher || defaultSessionLauncher;
  const log = opts.log || app.log;
  const transcribe = opts.transcribe || transcribeClip;

  async function handleIngestResult(result) {
    const payload = {
      recording: safeAudioRecording(result.recording),
      events: safeEvents(result.events),
    };
    if (wsManager && typeof wsManager.broadcast === 'function') {
      wsManager.broadcast('recordings:snapshot', 'snapshot', payload);
    }
    return payload;
  }

  const pruneStaleAudioImpl = opts.pruneStaleAudio || pruneStaleAudio;
  const cleanup = () => pruneStaleAudioImpl({
    store,
    inboxDir: sourceConfig.inboxDir,
    minAgeSec: sourceConfig.audioCleanupMinAgeSec,
    maxPerPass: sourceConfig.audioCleanupMaxPerPass,
    log,
  });

  const scan = async () => {
    const result = await scanAudioInbox({
      inboxDir: sourceConfig.inboxDir,
      store,
      onSnapshot: handleIngestResult,
      log,
    });
    // Stale-audio cleanup runs opportunistically after a scan, gated + default-off. Inbox may be
    // Drive/Plaud-synced, so deletes can propagate to cloud — never run unless explicitly enabled.
    if (sourceConfig.audioCleanupEnabled === true) {
      result.cleanup = await cleanup();
    }
    return result;
  };
  const ingestLoop = startAudioIngestLoop({ sourceConfig, scan, log });

  app.decorate('audioRecordings', { store, scan, cleanup });

  app.addHook('onClose', async () => {
    ingestLoop?.close?.();
    if (typeof store.close === 'function') await store.close();
  });

  app.get('/api/recordings', async (req) => {
    const recordings = await store.listRecordings({
      sourceTool: req.query?.sourceTool,
      tag: req.query?.tag,
    });
    const limit = normalizeLimit(req.query?.limit);
    const offset = normalizeOffset(req.query?.offset);
    const page = recordings.slice(offset, offset + limit);
    return {
      total: recordings.length,
      limit,
      offset,
      hasMore: offset + page.length < recordings.length,
      recordings: page.map(safeAudioRecording),
    };
  });

  app.get('/api/recordings/:id', async (req, reply) => {
    const recording = await store.getRecording(req.params.id);
    if (!recording) return reply.code(404).send({ error: 'Recording not found' });
    return { recording: safeAudioRecording(recording) };
  });

  app.get('/api/recordings/:id/evidence', async (req, reply) => {
    const recording = await store.getRecording(req.params.id);
    if (!recording) return reply.code(404).send({ error: 'Recording not found' });
    const evidence = await store.getEvidence(recording.id);
    if (!evidence) return reply.code(404).send({ error: 'Evidence not found' });
    return { evidence: safeEvidence(evidence) };
  });

  app.post('/api/recordings/scan', async () => scan());

  // Body size is bounded by the server bodyLimit; the client caps clips at two minutes.
  // Any media type: Firefox drops recorder.mimeType on stop (application/octet-stream) and Chromium
  // can say video/webm. The type only picks the temp file extension (unknown -> .bin); faster-whisper
  // probes the bytes, while whisper-cpp decodes only the formats its build supports.
  app.post('/api/audio/transcribe', async (req, reply) => {
    const match = String(req.body?.audio || '').match(/^data:(?:[\w.+-]+\/([\w.+-]+))?[^,]*;base64,([A-Za-z0-9+/]+={0,2})$/);
    const audio = match && Buffer.from(match[2], 'base64');
    if (!audio?.length) return reply.code(400).send({ error: 'Expected a base64 audio data URL', code: 'invalid_audio' });
    const ext = ['webm', 'ogg', 'mp4', 'wav'].includes(match[1]) ? match[1] : 'bin';
    if (transcribing) {
      return reply.code(429).header('retry-after', '5').send({ error: 'Another transcription is running', code: 'transcription_busy' });
    }
    transcribing = true;
    // Client went away before the reply: stop the engine instead of finishing unwanted work.
    const abort = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableEnded) abort.abort(); });
    try {
      return { text: await transcribe(audio, ext, abort.signal) };
    } catch (error) {
      if (error.statusCode === 503) {
        return reply.code(503).send({ error: 'No speech-to-text engine on the server', code: 'transcriber_unavailable' });
      }
      log.warn({ reason: error.message }, 'Audio transcription failed');
      return reply.code(502).send({ error: 'Transcription failed', code: 'transcription_failed' });
    } finally {
      transcribing = false;
    }
  });

  app.post('/api/recordings/cleanup', async (_req, reply) => {
    if (sourceConfig.audioCleanupEnabled !== true) {
      return reply.code(403).send({ error: 'Audio cleanup disabled' });
    }
    return cleanup();
  });

  app.put('/api/recordings/:id/action-settings', async (req, reply) => {
    const recording = await store.getRecording(req.params.id);
    if (!recording) return reply.code(404).send({ error: 'Recording not found' });
    let settings;
    try {
      settings = normalizeActionSettings(req.body);
      if (settings.workDir) await validateActionLaunchDir(settings.workDir);
    } catch (error) {
      return reply.code(error.statusCode || 400).send({ error: error.message });
    }
    const updated = await store.updateActionSettings(recording.id, settings);
    return { recording: safeAudioRecording(updated) };
  });

  app.post('/api/recordings/:id/act', async (req, reply) => {
    let recording = await store.getRecording(req.params.id);
    if (!recording) return reply.code(404).send({ error: 'Recording not found' });
    const evidence = await store.getEvidence(recording.id);
    if (!evidence) return reply.code(404).send({ error: 'Evidence not found' });
    try {
      if (req.body && (Object.hasOwn(req.body, 'context') || Object.hasOwn(req.body, 'workDir'))) {
        const settings = normalizeActionSettings(req.body);
        if (settings.workDir) await validateActionLaunchDir(settings.workDir);
        recording = await store.updateActionSettings(recording.id, settings);
      }
      const evidenceDir = await resolveActionWorkDir(sourceConfig.actionWorkDir, recording.id);
      const workDir = recording.actionWorkDir
        ? await validateActionLaunchDir(recording.actionWorkDir)
        : evidenceDir;
      await stageEvidence(evidenceDir, recording, evidence);
      const prompt = buildAudioActionPrompt(recording, evidenceDir);
      const metadata = {
        recording_id: recording.id,
        source_tool: recording.sourceTool,
        recording_tags: Array.isArray(recording.tags) ? recording.tags.map(normalizeText).filter(Boolean) : [],
      };
      const session = await sessionLauncher({
        prompt,
        workDir,
        displayName: `Recording ${recording.stem}`,
        provider: sourceConfig.actionProvider,
        model: sourceConfig.actionModel,
        thinkingLevel: sourceConfig.actionThinkingLevel,
        metadata,
        source: 'audio-recording-action',
        ...(req.body?.mcpProfile !== undefined ? { mcpProfile: req.body.mcpProfile } : {}),
        ...(req.body?.mcpServers !== undefined ? { mcpServers: req.body.mcpServers } : {}),
      });
      const sessionId = normalizeText(session.id || session.sessionId || '');
      const annotated = await store.annotateAction(recording.id, { sessionId });
      return {
        sessionId,
        backendType: normalizeText(session.backendType || ''),
        recording: safeAudioRecording(annotated || recording),
      };
    } catch (error) {
      return reply.code(error.statusCode || 500).send({ error: error.message || 'Recording action launch failed' });
    }
  });
}

export const AUDIO_ROUTE_DEFAULTS = Object.freeze({
  evidenceEndpointPrefix: '/api/recordings',
});
