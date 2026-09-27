import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config as appConfig } from '../config.mjs';
import { authPlugin } from '../modules/platform/auth.mjs';
import { groupRecordingFiles, recordingManifestFromFiles } from '../modules/audio/manifest.mjs';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { pruneStaleAudio, scanAudioInbox } from '../modules/audio/ingest.mjs';
import { buildAudioRecordingStore } from '../modules/audio/recordings.mjs';
import { audioPlugin } from '../modules/audio/index.mjs';
import { buildMonitorMcpServer } from '../modules/platform/monitor-mcp.mjs';

const TEST_TOKEN = 'audio-recordings-test-token';
const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

function memoryStateStore(initial = null) {
  let state = initial;
  return {
    saved: [],
    loadSync() {
      return state;
    },
    async load() {
      return state;
    },
    async save(next) {
      state = JSON.parse(JSON.stringify(next));
      this.saved.push(state);
    },
    async close() {},
  };
}

async function buildApp({ store = null, config = {}, sessionLauncher = null, wsManager = null, pruneStaleAudio = null } = {}) {
  process.env.AUTH_TOKEN = TEST_TOKEN;
  process.env.INTERNAL_BYPASS_TOKEN = TEST_TOKEN;
  appConfig.auth.token = TEST_TOKEN;
  appConfig.auth.internalBypassToken = TEST_TOKEN;
  const app = Fastify({ logger: false });
  await app.register(authPlugin);
  await app.register(audioPlugin, {
    store: store || buildAudioRecordingStore({ stateStore: memoryStateStore() }),
    config,
    ...(sessionLauncher ? { sessionLauncher } : {}),
    ...(wsManager ? { wsManager } : {}),
    ...(pruneStaleAudio ? { pruneStaleAudio } : {}),
  });
  await app.ready();
  return app;
}

function authHeaders() {
  return { authorization: `Bearer ${TEST_TOKEN}` };
}

describe('audio recording manifest', () => {
  it('groups folder-sync sibling files into a safe manifest', () => {
    const groups = groupRecordingFiles([
      { path: '/inbox/2026-06-20_standup.txt', size: 25, content: 'hello from the transcript' },
      { path: '/inbox/2026-06-20_standup.summary.md', size: 8, content: 'summary' },
      { path: '/inbox/2026-06-20_standup.json', size: 80, content: JSON.stringify({ app: 'plaud', durationSec: 42, language: 'en' }) },
      { path: '/inbox/2026-06-20_standup.m4a', size: 1024, content: '' },
    ]);

    assert.equal(groups.length, 1);
    const manifest = recordingManifestFromFiles(groups[0]);
    assert.equal(manifest.stem, '2026-06-20_standup');
    assert.equal(manifest.sourceTool, 'plaud');
    assert.equal(manifest.wordCount, 4);
    assert.equal(manifest.durationSec, 42);
    assert.equal(manifest.language, 'en');
    assert.deepEqual(manifest.tags, ['has_summary', 'has_audio_reference']);
    assert.equal(manifest.transcriptPath.path, '/inbox/2026-06-20_standup.txt');
    assert.equal(manifest.audioPath.path, '/inbox/2026-06-20_standup.m4a');
    assert.ok(manifest.contentHash);
  });
});

describe('audio recording store', () => {
  it('persists safe recordings plus verbatim capped evidence packets', async () => {
    const backing = memoryStateStore();
    const store = buildAudioRecordingStore({
      stateStore: backing,
      now: () => 1000,
      evidenceMaxBytes: 40,
    });
    const group = {
      stem: 'client_call',
      transcript: {
        path: '/inbox/client_call.txt',
        size: 120,
        content: `client@example.com token=secret-value wants the renewal timeline ${'extra '.repeat(300)}`,
      },
      summary: {
        path: '/inbox/client_call.summary.md',
        size: 20,
        content: 'password=hunter2 follow-up',
      },
      files: [],
    };
    group.files = [group.transcript, group.summary];

    const result = await store.ingestGroup(group);
    assert.equal(result.events[0].type, 'ingested');
    assert.equal(result.recording.evidenceRef, `audio_evidence:${result.recording.id}`);
    assert.equal(result.recording.hasSummary, true);
    assert.equal(JSON.stringify(result.recording).includes('secret-value'), false);
    assert.equal(result.evidence.transcript.includes('client@example.com'), true);
    assert.equal(result.evidence.transcript.includes('token=secret-value'), true);
    assert.equal(result.evidence.summary.includes('password=hunter2'), true);
    assert.equal(result.evidence.capped, true);
    assert.equal(backing.saved[0].version, 1);
    assert.ok(backing.saved[0].recordings[result.recording.id]);
    assert.ok(backing.saved[0].evidence[result.recording.evidenceRef]);

    const duplicate = await store.ingestGroup(group);
    assert.deepEqual(duplicate.events, []);

    const changed = await store.ingestGroup({
      ...group,
      transcript: { ...group.transcript, content: `${group.transcript.content} changed` },
      files: [{ ...group.transcript, content: `${group.transcript.content} changed` }, group.summary],
    });
    assert.equal(changed.events[0].type, 'revised');
    assert.notEqual(changed.recording.id, result.recording.id);
    assert.equal(changed.recording.revision, 2);
    await store.close();
  });

  it('persists per-recording action context and working directory', async () => {
    const store = buildAudioRecordingStore({ stateStore: memoryStateStore(), now: () => 1000 });
    const result = await store.ingestGroup({
      stem: 'project_note',
      transcript: { path: '/inbox/project_note.txt', content: 'build the requested feature' },
      files: [{ path: '/inbox/project_note.txt', content: 'build the requested feature' }],
    });

    const updated = await store.updateActionSettings(result.recording.id, {
      context: 'Focus on the billing API.',
      workDir: '/projects/billing',
      nowMs: 2000,
    });

    assert.equal(updated.actionContext, 'Focus on the billing API.');
    assert.equal(updated.actionWorkDir, '/projects/billing');
    assert.equal(updated.updatedAtMs, 2000);
    assert.equal((await store.getRecording(result.recording.id)).actionContext, 'Focus on the billing API.');
    await store.close();
  });
});

describe('audio inbox scan', () => {
  it('imports accepted leaves, notes audio path only, and isolates bad files', async () => {
    const inbox = await mkdtemp(join(tmpdir(), 'dueno-audio-inbox-'));
    tempDirs.push(inbox);
    await writeFile(join(inbox, 'call.txt'), 'transcript body');
    await writeFile(join(inbox, 'call.summary.md'), 'provider summary');
    await writeFile(join(inbox, 'call.json'), JSON.stringify({ app: 'drive', speakers: 2 }));
    await writeFile(join(inbox, 'call.mp3'), 'not read as text');
    await symlink('/tmp/outside-recording.txt', join(inbox, 'escape.txt')).catch(() => {});

    const store = buildAudioRecordingStore({ stateStore: memoryStateStore() });
    const result = await scanAudioInbox({ inboxDir: inbox, store });
    assert.equal(result.imported.length, 1);
    assert.equal(result.imported[0].stem, 'call');
    assert.ok(result.skipped.some((entry) => entry.path === 'escape.txt'));

    const recording = await store.getRecording(result.imported[0].id);
    assert.equal(recording.sourceTool, 'drive');
    assert.equal(recording.participantCount, 2);
    assert.match(recording.audioPath.path, /call\.mp3$/);
    await store.close();
  });

});

describe('audio recording routes', () => {
  it('requires existing API auth', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/recordings' });

    assert.equal(res.statusCode, 401);
    await app.close();
  });

  it('scans, lists safe manifests, reads gated evidence, broadcasts safe snapshots, and launches action sessions safely', async () => {
    const inbox = await mkdtemp(join(tmpdir(), 'dueno-audio-routes-'));
    const actionDir = await mkdtemp(join(tmpdir(), 'dueno-audio-actions-'));
    tempDirs.push(inbox, actionDir);
    await writeFile(join(inbox, 'ops.txt'), 'raw transcript token=secret-value owner action');
    await writeFile(join(inbox, 'ops.summary.txt'), 'provider summary password=hunter2');

    const broadcasts = [];
    const launches = [];
    const app = await buildApp({
      config: { inboxDir: inbox, actionWorkDir: actionDir, actionProvider: 'codex' },
      wsManager: { broadcast: (...args) => broadcasts.push(args) },
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: 'codex-recording-1', backendType: 'codex' };
      },
    });

    const scan = await app.inject({
      method: 'POST',
      url: '/api/recordings/scan',
      headers: authHeaders(),
    });
    assert.equal(scan.statusCode, 200);
    const recordingId = JSON.parse(scan.body).imported[0].id;

    const list = await app.inject({
      method: 'GET',
      url: '/api/recordings',
      headers: authHeaders(),
    });
    assert.equal(list.statusCode, 200);
    const listed = JSON.parse(list.body).recordings[0];
    assert.equal(listed.id, recordingId);
    assert.equal(JSON.stringify(listed).includes('secret-value'), false);
    assert.equal(JSON.stringify(broadcasts).includes('secret-value'), false);

    const evidence = await app.inject({
      method: 'GET',
      url: `/api/recordings/${recordingId}/evidence`,
      headers: authHeaders(),
    });
    assert.equal(evidence.statusCode, 200);
    const evidenceBody = JSON.parse(evidence.body).evidence;
    assert.equal(evidenceBody.transcript.includes('token=secret-value'), true);

    const settings = await app.inject({
      method: 'PUT',
      url: `/api/recordings/${recordingId}/action-settings`,
      headers: authHeaders(),
      payload: { context: 'Apply this to the audio module.', workDir: inbox },
    });
    assert.equal(settings.statusCode, 200);
    assert.equal(JSON.parse(settings.body).recording.actionContext, 'Apply this to the audio module.');

    const act = await app.inject({
      method: 'POST',
      url: `/api/recordings/${recordingId}/act`,
      headers: authHeaders(),
      payload: {
        mcpProfile: 'default',
        mcpServers: { add: [], remove: ['dueno'] },
      },
    });
    assert.equal(act.statusCode, 200);
    assert.equal(JSON.parse(act.body).sessionId, 'codex-recording-1');
    assert.equal(launches.length, 1);
    assert.equal(launches[0].prompt.includes('secret-value'), false);
    assert.match(launches[0].prompt, new RegExp(`/api/recordings/${recordingId}/evidence`));
    assert.equal(launches[0].source, 'audio-recording-action');
    assert.equal(launches[0].metadata.recording_id, recordingId);
    assert.equal(launches[0].mcpProfile, 'default');
    assert.deepEqual(launches[0].mcpServers, { add: [], remove: ['dueno'] });
    assert.equal(launches[0].workDir, inbox);
    assert.match(launches[0].prompt, /Apply this to the audio module\./);
    assert.match(launches[0].prompt, new RegExp(`${actionDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));

    assert.equal(existsSync(join(launches[0].workDir, 'evidence.md')), false, 'evidence is not staged into the project directory');
    const isolatedEvidence = await readFile(join(actionDir, recordingId, 'evidence.md'), 'utf8');
    assert.equal(isolatedEvidence.includes('token=secret-value'), true);
    await app.close();
  });

  it('rejects a missing action working directory', async () => {
    const inbox = await mkdtemp(join(tmpdir(), 'dueno-audio-bad-workdir-'));
    tempDirs.push(inbox);
    await writeFile(join(inbox, 'ops.txt'), 'transcript');
    const app = await buildApp({ config: { inboxDir: inbox } });
    const scan = await app.inject({ method: 'POST', url: '/api/recordings/scan', headers: authHeaders() });
    const recordingId = JSON.parse(scan.body).imported[0].id;
    const response = await app.inject({
      method: 'PUT',
      url: `/api/recordings/${recordingId}/action-settings`,
      headers: authHeaders(),
      payload: { context: '', workDir: join(inbox, 'missing') },
    });
    assert.equal(response.statusCode, 400);
    assert.match(JSON.parse(response.body).error, /does not exist/);
    await app.close();
  });

  it('does not start the ingest loop when disabled', async () => {
    const inbox = await mkdtemp(join(tmpdir(), 'dueno-audio-loop-off-'));
    tempDirs.push(inbox);
    await writeFile(join(inbox, 'idle.txt'), 'should not auto-import');
    const app = await buildApp({ config: { ingestEnabled: false, inboxDir: inbox } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const list = await app.inject({
      method: 'GET',
      url: '/api/recordings',
      headers: authHeaders(),
    });
    assert.equal(list.statusCode, 200);
    assert.equal(JSON.parse(list.body).recordings.length, 0);
    await app.close();
  });

});

describe('audio recording monitor MCP tools', () => {
  it('exposes safe recording tools and calls the recordings API', async () => {
    const calls = [];
    const mcp = buildMonitorMcpServer({
      requestImpl: async (path, opts = {}) => {
        calls.push({ path, opts });
        if (path === '/api/recordings/scan') return { imported: [] };
        if (path === '/api/recordings/audrec_1/evidence') return { evidence: { recordingId: 'audrec_1' } };
        return { recordings: [] };
      },
    });

    assert.ok(mcp.listTools().some((tool) => tool.name === 'monitor_scan_audio_recordings'));
    assert.ok(mcp.listTools().some((tool) => tool.name === 'monitor_read_audio_recording_evidence'));
    await mcp.handleToolCall('monitor_scan_audio_recordings', {});
    await mcp.handleToolCall('monitor_read_audio_recording_evidence', { id: 'audrec_1' });
    assert.equal(calls[0].path, '/api/recordings/scan');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[1].path, '/api/recordings/audrec_1/evidence');
  });
});

function fakeCleanupStore(recordings, evidenceByRef) {
  return {
    async listRecordings() {
      return recordings;
    },
    async getEvidence(idOrRef) {
      return evidenceByRef[idOrRef] || null;
    },
  };
}

describe('audio stale cleanup', () => {
  it('prunes stale audio only when stored transcript evidence exists', async () => {
    const inbox = await realpath(await mkdtemp(join(tmpdir(), 'audio-clean-')));
    tempDirs.push(inbox);
    const withEv = join(inbox, 'has-evidence.m4a');
    const noEv = join(inbox, 'no-evidence.m4a');
    const absent = join(inbox, 'absent.m4a');
    await writeFile(withEv, 'audio-bytes');
    await writeFile(noEv, 'audio-bytes');
    // `absent` recording references a file that is not on disk.
    const link = join(inbox, 'linked.m4a');
    await symlink(withEv, link);

    const store = fakeCleanupStore(
      [
        { id: 'r-evidence', evidenceRef: 'audio_evidence:r-evidence', audioPath: { path: withEv } },
        { id: 'r-noevidence', evidenceRef: 'audio_evidence:r-noevidence', audioPath: { path: noEv } },
        { id: 'r-absent', evidenceRef: 'audio_evidence:r-absent', audioPath: { path: absent } },
        { id: 'r-symlink', evidenceRef: 'audio_evidence:r-symlink', audioPath: { path: link } },
        { id: 'r-noaudio', evidenceRef: 'audio_evidence:r-noaudio', audioPath: null },
      ],
      {
        'audio_evidence:r-evidence': { transcriptBytes: { stored: 42 } },
        'audio_evidence:r-noevidence': { transcriptBytes: { stored: 0 } },
        'audio_evidence:r-absent': { transcriptBytes: { stored: 42 } },
        'audio_evidence:r-symlink': { transcriptBytes: { stored: 42 } },
      },
    );

    const result = await pruneStaleAudio({ store, inboxDir: inbox, minAgeSec: 0, now: () => Date.now() });

    assert.deepEqual(result.deleted.map((d) => d.id), ['r-evidence']);
    assert.equal(existsSync(withEv), false, 'evidenced audio deleted');
    assert.equal(existsSync(noEv), true, 'unevidenced audio retained');
    const reason = (id) => result.kept.find((k) => k.id === id)?.reason;
    assert.equal(reason('r-noevidence'), 'evidence_missing');
    assert.equal(reason('r-absent'), 'absent');
    assert.equal(reason('r-symlink'), 'Symlinks are not allowed');
    assert.equal(reason('r-noaudio'), 'no_audio_path');
    assert.equal(result.scanned, 5);
  });

  it('keeps audio younger than the min age', async () => {
    const inbox = await realpath(await mkdtemp(join(tmpdir(), 'audio-young-')));
    tempDirs.push(inbox);
    const fresh = join(inbox, 'fresh.m4a');
    await writeFile(fresh, 'audio-bytes');
    const store = fakeCleanupStore(
      [{ id: 'r-fresh', evidenceRef: 'audio_evidence:r-fresh', audioPath: { path: fresh } }],
      { 'audio_evidence:r-fresh': { transcriptBytes: { stored: 42 } } },
    );
    const result = await pruneStaleAudio({ store, inboxDir: inbox, minAgeSec: 3600, now: () => Date.now() });
    assert.deepEqual(result.deleted, []);
    assert.equal(result.kept.find((k) => k.id === 'r-fresh')?.reason, 'too_young');
    assert.equal(existsSync(fresh), true);
  });

  it('bounds stale audio pruning by maxPerPass', async () => {
    const inbox = await realpath(await mkdtemp(join(tmpdir(), 'audio-cap-')));
    tempDirs.push(inbox);
    const recordings = [];
    const evidence = {};
    for (let i = 0; i < 3; i += 1) {
      const path = join(inbox, `rec-${i}.m4a`);
      await writeFile(path, 'audio-bytes');
      recordings.push({ id: `r-${i}`, evidenceRef: `audio_evidence:r-${i}`, audioPath: { path } });
      evidence[`audio_evidence:r-${i}`] = { transcriptBytes: { stored: 42 } };
    }
    const store = fakeCleanupStore(recordings, evidence);
    const result = await pruneStaleAudio({ store, inboxDir: inbox, minAgeSec: 0, maxPerPass: 2, now: () => Date.now() });
    assert.equal(result.deleted.length, 2);
    assert.ok(result.kept.some((k) => k.reason === 'capped'));
  });
});

describe('audio cleanup route', () => {
  it('gates manual stale audio cleanup on audio cleanup config', async () => {
    const disabled = await buildApp();
    const disabledRes = await disabled.inject({
      method: 'POST',
      url: '/api/recordings/cleanup',
      headers: authHeaders(),
    });
    assert.equal(disabledRes.statusCode, 403);
    await disabled.close();

    const enabled = await buildApp({
      config: { audioCleanupEnabled: true },
      pruneStaleAudio: async () => ({ deleted: [], kept: [], scanned: 0 }),
    });
    const enabledRes = await enabled.inject({
      method: 'POST',
      url: '/api/recordings/cleanup',
      headers: authHeaders(),
    });
    assert.equal(enabledRes.statusCode, 200);
    assert.deepEqual(JSON.parse(enabledRes.body), { deleted: [], kept: [], scanned: 0 });
    await enabled.close();
  });
});
