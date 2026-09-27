import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { route } from 'preact-router';
import { api } from '../app/api.mjs';
import { subscribe } from '../app/ws-client.mjs';
import { addToast } from '../app/state.mjs';
import { ErrorState, LoadingState } from '../components/page-state.mjs';
import { FolderPicker } from '../components/folder-picker.mjs';

const PAGE_SIZE = 100;

function formatTime(ms) {
  const value = Number(ms || 0);
  if (!value) return 'unknown';
  const diff = Date.now() - value;
  if (diff < 0) return new Date(value).toLocaleString();
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(value).toLocaleString();
}

function formatDuration(seconds) {
  const value = Number(seconds || 0);
  if (!value) return 'unknown';
  const minutes = Math.floor(value / 60);
  const remaining = Math.round(value % 60);
  if (!minutes) return `${remaining}s`;
  return `${minutes}m ${String(remaining).padStart(2, '0')}s`;
}

function byteLabel(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function upsertRecording(recordings, recording) {
  if (!recording?.id) return recordings;
  const next = [...recordings];
  const idx = next.findIndex((item) => item.id === recording.id);
  if (idx === -1) next.unshift(recording);
  else next[idx] = recording;
  return next.sort((a, b) =>
    Number(b.capturedAtMs || b.importedAtMs || 0) - Number(a.capturedAtMs || a.importedAtMs || 0)
  );
}

function mergeRecordings(current, incoming) {
  return (Array.isArray(incoming) ? incoming : []).reduce(upsertRecording, current);
}

async function loadRecordings(state, { append = false } = {}) {
  const offset = append ? state.recordings.value.length : 0;
  if (append) state.moreBusy.value = true;
  else state.loading.value = true;
  state.error.value = '';
  try {
    const payload = await api.get(`/recordings?limit=${PAGE_SIZE}&offset=${offset}`);
    state.recordings.value = append
      ? mergeRecordings(state.recordings.value, payload.recordings)
      : (payload.recordings || []);
    state.total.value = Number(payload.total || state.recordings.value.length || 0);
    state.hasMore.value = payload.hasMore === true;
  } catch (error) {
    state.error.value = error.message || 'Unable to load recordings.';
    addToast(`Recordings load failed: ${error.message}`, 'error');
  } finally {
    if (append) state.moreBusy.value = false;
    else state.loading.value = false;
  }
}

async function scanRecordings(state) {
  state.scanBusy.value = true;
  try {
    const result = await api.post('/recordings/scan', {});
    await loadRecordings(state);
    const imported = Array.isArray(result.imported) ? result.imported.length : 0;
    addToast(`Recording scan complete: ${imported} imported`, 'success');
  } catch (error) {
    addToast(`Recording scan failed: ${error.message}`, 'error');
  } finally {
    state.scanBusy.value = false;
  }
}

async function refreshRecordings(state) {
  state.loading.value = true;
  state.error.value = '';
  try {
    await api.post('/recordings/scan', {});
    await loadRecordings(state);
  } catch (error) {
    state.error.value = error.message || 'Unable to refresh recordings.';
    addToast(`Recordings refresh failed: ${error.message}`, 'error');
  } finally {
    state.loading.value = false;
  }
}

async function openEvidence(state, recording) {
  if (!recording?.id) return;
  if (state.evidenceById.value[recording.id]) {
    state.openEvidenceId.value = state.openEvidenceId.value === recording.id ? '' : recording.id;
    return;
  }
  state.evidenceBusy.value = recording.id;
  state.evidenceError.value = '';
  try {
    const payload = await api.get(`/recordings/${encodeURIComponent(recording.id)}/evidence`);
    state.evidenceById.value = { ...state.evidenceById.value, [recording.id]: payload.evidence || null };
    state.openEvidenceId.value = recording.id;
  } catch (error) {
    state.evidenceError.value = error.message || 'Unable to load evidence.';
    addToast(`Evidence load failed: ${error.message}`, 'error');
  } finally {
    state.evidenceBusy.value = '';
  }
}

async function saveActionSettings(state, recording, context, workDir) {
  if (!recording?.id) return null;
  state.settingsBusy.value = recording.id;
  try {
    const result = await api.put(`/recordings/${encodeURIComponent(recording.id)}/action-settings`, {
      context: String(context || '').trim(),
      workDir: String(workDir || '').trim(),
    });
    if (result.recording) state.recordings.value = upsertRecording(state.recordings.value, result.recording);
    addToast('Recording action settings saved', 'success');
    return result.recording || null;
  } catch (error) {
    addToast(`Settings save failed: ${error.message}`, 'error');
    return null;
  } finally {
    state.settingsBusy.value = '';
  }
}

async function actOnRecording(state, recording, context, workDir) {
  if (!recording?.id) return;
  state.actBusy.value = recording.id;
  try {
    const result = await api.post(`/recordings/${encodeURIComponent(recording.id)}/act`, {
      context: String(context || '').trim(),
      workDir: String(workDir || '').trim(),
    });
    if (result.recording) {
      state.recordings.value = upsertRecording(state.recordings.value, result.recording);
    }
    addToast('Recording action session launched', 'success');
    if (result.backendType && result.sessionId) {
      route(`/${result.backendType}/${result.sessionId}`);
    }
  } catch (error) {
    addToast(`Recording action failed: ${error.message}`, 'error');
  } finally {
    state.actBusy.value = '';
  }
}

function RecordingCard({ recording, state }) {
  const context = useMemo(() => signal(recording.actionContext || ''), []);
  const workDir = useMemo(() => signal(recording.actionWorkDir || ''), []);
  const showSettings = useMemo(() => signal(Boolean(recording.actionContext || recording.actionWorkDir)), []);
  const showPicker = useMemo(() => signal(false), []);
  const isEvidenceOpen = state.openEvidenceId.value === recording.id;
  const evidence = state.evidenceById.value[recording.id];
  const tags = Array.isArray(recording.tags) ? recording.tags : [];
  const actions = Array.isArray(recording.actionSessionIds) ? recording.actionSessionIds.length : 0;

  return html`
    <article class="card recording-card" data-recording-id=${recording.id}>
      <div class="recording-card-main">
        <div class="recording-summary">
          <div class="recording-title-row">
            <h2 class="card-title recording-title">${recording.stem || recording.id}</h2>
            <span class="badge ${recording.hasSummary ? 'badge-info' : 'badge-low'}">
              ${recording.hasSummary ? 'summary' : 'transcript'}
            </span>
          </div>
          <div class="recording-meta">
            ${recording.sourceTool || 'unknown source'} - captured ${formatTime(recording.capturedAtMs || recording.importedAtMs)}
          </div>
          <div class="recording-chip-row">
            <span class="badge badge-low">${Number(recording.wordCount || 0)} words</span>
            <span class="badge badge-low">${formatDuration(recording.durationSec)}</span>
            ${recording.language ? html`<span class="badge badge-low">${recording.language}</span>` : null}
            ${Number(recording.participantCount || 0) ? html`
              <span class="badge badge-low">${recording.participantCount} participants</span>
            ` : null}
            ${actions ? html`<span class="badge badge-info">${actions} action sessions</span>` : null}
            ${tags.map((tag) => html`<span class="badge badge-low">${tag}</span>`)}
          </div>
        </div>
        <div class="recording-actions">
          <button
            class="btn"
            type="button"
            disabled=${state.evidenceBusy.value === recording.id}
            onclick=${() => openEvidence(state, recording)}
            aria-expanded=${isEvidenceOpen ? 'true' : 'false'}
          >
            ${state.evidenceBusy.value === recording.id ? 'Loading...' : isEvidenceOpen ? 'Hide Evidence' : 'Open Evidence'}
          </button>
          <button
            class="btn"
            type="button"
            onclick=${() => { showSettings.value = !showSettings.value; }}
            aria-expanded=${showSettings.value ? 'true' : 'false'}
          >
            ${showSettings.value ? 'Hide Setup' : 'Action Setup'}
          </button>
          <button
            class="btn btn-primary"
            type="button"
            disabled=${state.actBusy.value === recording.id}
            onclick=${() => actOnRecording(state, recording, context.value, workDir.value)}
          >
            ${state.actBusy.value === recording.id ? 'Launching...' : 'Act'}
          </button>
        </div>
      </div>

      ${showSettings.value ? html`
        <section class="recording-action-settings" aria-label="Recording action settings">
          <label>
            <span>Additional context</span>
            <textarea
              rows="3"
              maxlength="12000"
              placeholder="Goals, constraints, people, expected output..."
              value=${context.value}
              oninput=${(event) => { context.value = event.currentTarget.value; }}
            ></textarea>
          </label>
          <label>
            <span>Agent project directory (optional)</span>
            <div class="recording-workdir-row">
              <input
                type="text"
                maxlength="4096"
                placeholder="Default: isolated recording workspace"
                value=${workDir.value}
                oninput=${(event) => { workDir.value = event.currentTarget.value; }}
              />
              <button class="btn" type="button" onclick=${() => { showPicker.value = !showPicker.value; }}>Browse</button>
            </div>
          </label>
          ${showPicker.value ? html`
            <${FolderPicker}
              onSelect=${(path) => { workDir.value = path; showPicker.value = false; }}
              onCancel=${() => { showPicker.value = false; }}
            />
          ` : null}
          <div class="recording-settings-actions">
            <button
              class="btn"
              type="button"
              disabled=${state.settingsBusy.value === recording.id}
              onclick=${() => saveActionSettings(state, recording, context.value, workDir.value)}
            >${state.settingsBusy.value === recording.id ? 'Saving...' : 'Save setup'}</button>
            ${workDir.value ? html`
              <button class="btn" type="button" onclick=${() => { workDir.value = ''; }}>Use isolated workspace</button>
            ` : null}
          </div>
        </section>
      ` : null}

      ${isEvidenceOpen && evidence ? html`
        <section class="recording-evidence" aria-label="Recording evidence">
          <div class="recording-evidence-head">
            <div>
              <h3>Evidence</h3>
              <p>
                transcript ${byteLabel(evidence.transcriptBytes?.stored)}
                ${evidence.capped ? html`<span class="badge badge-warning">capped</span>` : null}
              </p>
            </div>
            <span class="recording-evidence-ref">${evidence.evidenceRef}</span>
          </div>
          ${evidence.summary ? html`
            <h4>Summary</h4>
            <pre class="recording-evidence-text">${evidence.summary}</pre>
          ` : null}
          <h4>Transcript</h4>
          <pre class="recording-evidence-text">${evidence.transcript || 'No transcript supplied.'}</pre>
        </section>
      ` : null}
    </article>
  `;
}

export function RecordingsPage() {
  const recordings = useMemo(() => signal([]), []);
  const total = useMemo(() => signal(0), []);
  const hasMore = useMemo(() => signal(false), []);
  const loading = useMemo(() => signal(false), []);
  const moreBusy = useMemo(() => signal(false), []);
  const scanBusy = useMemo(() => signal(false), []);
  const actBusy = useMemo(() => signal(''), []);
  const settingsBusy = useMemo(() => signal(''), []);
  const evidenceBusy = useMemo(() => signal(''), []);
  const openEvidenceId = useMemo(() => signal(''), []);
  const evidenceById = useMemo(() => signal({}), []);
  const evidenceError = useMemo(() => signal(''), []);
  const error = useMemo(() => signal(''), []);
  const state = {
    recordings,
    total,
    hasMore,
    loading,
    moreBusy,
    scanBusy,
    actBusy,
    settingsBusy,
    evidenceBusy,
    openEvidenceId,
    evidenceById,
    evidenceError,
    error,
  };

  useEffect(() => {
    loadRecordings(state);
    const unsub = subscribe('recordings:snapshot', (type, data) => {
      if (type === 'snapshot' && data?.recording) {
        recordings.value = upsertRecording(recordings.value, data.recording);
        total.value = Math.max(total.value, recordings.value.length);
      }
    });
    return unsub;
  }, []);

  return html`
    <div class="page recordings-page">
      <div class="card-header recordings-head">
        <div>
          <h1 class="card-title" style="font-size:18px">Recordings</h1>
          <div class="fleet-meta">${total.value || recordings.value.length} imported transcript recordings</div>
        </div>
        <div class="recordings-toolbar">
          <button class="btn" type="button" onclick=${() => refreshRecordings(state)} disabled=${loading.value}>
            ${loading.value ? 'Refreshing...' : 'Refresh'}
          </button>
          <button class="btn btn-primary" type="button" onclick=${() => scanRecordings(state)} disabled=${scanBusy.value}>
            ${scanBusy.value ? 'Scanning...' : 'Scan'}
          </button>
        </div>
      </div>

      ${loading.value && recordings.value.length === 0 ? html`<${LoadingState} message="Loading recordings..." />` : null}
      ${error.value ? html`<${ErrorState} message=${error.value} />` : null}
      ${evidenceError.value ? html`<div class="card recording-error">${evidenceError.value}</div>` : null}

      ${!loading.value && recordings.value.length === 0 && !error.value ? html`
        <div class="card">
          <p style="color:var(--text-muted)">No imported recordings.</p>
        </div>
      ` : null}

      <section class="recording-list" aria-label="Imported recordings">
        ${recordings.value.map((recording) => html`
          <${RecordingCard} recording=${recording} state=${state} />
        `)}
      </section>

      ${hasMore.value ? html`
        <div class="recordings-load-more">
          <button
            class="btn"
            type="button"
            onclick=${() => loadRecordings(state, { append: true })}
            disabled=${moreBusy.value}
          >
            ${moreBusy.value ? 'Loading...' : 'Load more'}
          </button>
        </div>
      ` : null}
    </div>
  `;
}
