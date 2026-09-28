import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef } from 'preact/hooks';
import { api } from '../app/api.mjs';
import { addToast, claudeSessions, codexSessions, piSessions } from '../app/state.mjs';
import { appendTranscript, VoiceInput } from '../components/voice-input.mjs';
import { FolderPicker } from '../components/folder-picker.mjs';
import { DirQuickSelect } from '../components/dir-quick-select.mjs';
import { recentWorkDirs } from '../app/recent-dirs.mjs';

const MAX_TEXT_LENGTH = 20000;

function formatTime(ms) {
  const d = new Date(Number(ms) || Date.now());
  try {
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return d.toISOString();
  }
}

async function loadNotes(notes, loading) {
  loading.value = true;
  try {
    const data = await api.get('/capture/notes?limit=100');
    notes.value = Array.isArray(data?.notes) ? data.notes : [];
  } catch (e) {
    addToast(`Failed to load notes: ${e.message}`, 'error');
  } finally {
    loading.value = false;
  }
}

function makeSave(draft, saving) {
  return async function save() {
    const text = draft.value.trim();
    if (!text || saving.value) return;
    saving.value = true;
    try {
      await api.post('/capture/notes', { text });
      draft.value = '';
      addToast('Note captured', 'success');
    } catch (e) {
      addToast(`Failed to save note: ${e.message}`, 'error');
    } finally {
      saving.value = false;
    }
  };
}

function makeDelete(notes) {
  return async function deleteNote(id) {
    try {
      await api.delete(`/capture/notes/${encodeURIComponent(id)}`);
      notes.value = notes.value.filter((n) => n.id !== id);
    } catch (e) {
      addToast(`Failed to delete note: ${e.message}`, 'error');
    }
  };
}

async function copyNote(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      addToast('Copied', 'success');
    }
  } catch {
    addToast('Copy failed', 'error');
  }
}

// Derive a short, identifiable session name from the note's first line.
function deriveDisplayName(text) {
  const firstLine = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || 'Captured note';
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine;
}

// Spawn an agent session seeded with `text` as its initial prompt, then open it.
// `workDir` is optional — empty means the fleet default directory.
async function spawnAgent(text, spawning, workDir = '') {
  const prompt = String(text || '').trim();
  if (!prompt || spawning.value) return false;
  spawning.value = true;
  try {
    const dir = String(workDir || '').trim();
    const data = await api.post('/agents/sessions', {
      initialPrompt: prompt,
      displayName: deriveDisplayName(prompt),
      ...(dir ? { workDir: dir } : {}),
    });
    const kind = String(data?.backendType || '').trim();
    if (!kind) throw new Error('Session backend missing from server response');
    addToast(`Agent spawned${data?.provider ? ` (${data.provider})` : ''}`, 'success');
    // Full navigation so the session detail page loads fresh (mirrors Agents page).
    window.location.href = `/${kind}/${data.id}`;
    return true;
  } catch (e) {
    addToast(`Failed to spawn agent: ${e.message}`, 'error');
    return false;
  } finally {
    spawning.value = false;
  }
}

export function CapturePage() {
  const draft = useMemo(() => signal(''), []);
  const saving = useMemo(() => signal(false), []);
  const spawning = useMemo(() => signal(false), []);
  const workDir = useMemo(() => signal(''), []);
  const showPicker = useMemo(() => signal(false), []);
  const textareaRef = useRef(null);

  const save = useMemo(() => makeSave(draft, saving), []);

  // Persist the current draft (best effort) then spawn an agent seeded with it.
  async function spawnFromDraft() {
    const text = draft.value.trim();
    if (!text || spawning.value) return;
    try {
      await api.post('/capture/notes', { text });
      draft.value = '';
    } catch {
      // Saving is best effort; still spawn so a dictated thought is never lost.
    }
    await spawnAgent(text, spawning, workDir.value);
  }

  useEffect(() => {
    const coarsePointer = window.matchMedia?.('(pointer: coarse)')?.matches;
    if (!coarsePointer && textareaRef.current) {
      try { textareaRef.current.focus(); } catch {}
    }
  }, []);

  function onVoiceResult(text) {
    draft.value = appendTranscript(draft.value, text, MAX_TEXT_LENGTH);
    if (textareaRef.current) {
      try { textareaRef.current.focus(); } catch {}
    }
  }

  const trimmedLen = draft.value.trim().length;
  const canSave = trimmedLen > 0 && !saving.value && !spawning.value;
  const canSpawn = trimmedLen > 0 && !saving.value && !spawning.value;
  const recents = recentWorkDirs([claudeSessions.value, codexSessions.value, piSessions.value]);
  const selectedDir = workDir.value.trim();

  return html`
    <div class="page capture-page">
      <div class="card-header">
        <h1 class="card-title" style="font-size:18px">Quick Capture</h1>
        <a class="btn btn-subtle capture-touch" href="/capture/notes">Saved notes</a>
      </div>

      <div class="card capture-compose">
        <textarea
          ref=${textareaRef}
          class="capture-textarea"
          placeholder="Dictate or type a note. Use your keyboard's mic, then Save."
          value=${draft.value}
          maxlength=${MAX_TEXT_LENGTH}
          autocapitalize="sentences"
          autocorrect="on"
          spellcheck="true"
          onInput=${(e) => { draft.value = e.target.value; }}
        ></textarea>
        <div class="capture-compose-meta">
          <span style="color:var(--text-muted); font-size:12px">${trimmedLen}/${MAX_TEXT_LENGTH}</span>
          <div style="display:flex; gap:8px; align-items:center">
            <${VoiceInput} onResult=${onVoiceResult} />
            ${draft.value ? html`<button class="btn btn-subtle capture-touch" onclick=${() => { draft.value = ''; }}>Clear</button>` : null}
          </div>
        </div>
      </div>

      <div class="card capture-dir">
        <div class="capture-dir-head">
          <span class="card-title">Spawn in</span>
          <button class="btn btn-subtle capture-touch" onclick=${() => { showPicker.value = !showPicker.value; }}>
            ${showPicker.value ? 'Close' : 'Browse'}
          </button>
        </div>
        <${DirQuickSelect}
          value=${workDir.value}
          recents=${recents}
          onSelect=${(path) => { workDir.value = path; }}
        />
        <div class="capture-dir-current" title=${selectedDir || 'fleet default directory'}>
          ${selectedDir ? selectedDir : 'Fleet default directory'}
        </div>
        ${showPicker.value ? html`
          <div style="margin-top:8px">
            <${FolderPicker}
              onSelect=${(path) => { workDir.value = path; showPicker.value = false; }}
              onCancel=${() => { showPicker.value = false; }}
            />
          </div>
        ` : null}
      </div>

      <div class="capture-savebar">
        <div class="capture-savebar-row">
          <button class="btn capture-save-btn capture-save-secondary" disabled=${!canSave} onclick=${save}>
            ${saving.value ? 'Saving…' : 'Save'}
          </button>
          <button class="btn btn-primary capture-save-btn" disabled=${!canSpawn} onclick=${spawnFromDraft}>
            ${spawning.value ? 'Spawning…' : 'Send to agent'}
          </button>
        </div>
      </div>
    </div>
  `;
}

export function CaptureNotesPage() {
  const notes = useMemo(() => signal([]), []);
  const loading = useMemo(() => signal(false), []);
  const spawning = useMemo(() => signal(false), []);
  const workDir = useMemo(() => signal(''), []);
  const showPicker = useMemo(() => signal(false), []);

  const deleteNote = useMemo(() => makeDelete(notes), []);

  useEffect(() => { loadNotes(notes, loading); }, []);

  const recents = recentWorkDirs([claudeSessions.value, codexSessions.value, piSessions.value]);
  const selectedDir = workDir.value.trim();

  return html`
    <div class="page capture-notes-page">
      <div class="card-header">
        <h1 class="card-title" style="font-size:18px">Saved Notes</h1>
        <div style="display:flex; gap:8px">
          <a class="btn btn-subtle capture-touch" href="/capture">Capture</a>
          <button class="btn btn-subtle capture-touch" onclick=${() => loadNotes(notes, loading)}>Refresh</button>
        </div>
      </div>

      <div class="card capture-dir">
        <div class="capture-dir-head">
          <span class="card-title">Send in</span>
          <button class="btn btn-subtle capture-touch" onclick=${() => { showPicker.value = !showPicker.value; }}>
            ${showPicker.value ? 'Close' : 'Browse'}
          </button>
        </div>
        <${DirQuickSelect}
          value=${workDir.value}
          recents=${recents}
          onSelect=${(path) => { workDir.value = path; }}
        />
        <div class="capture-dir-current" title=${selectedDir || 'fleet default directory'}>
          ${selectedDir ? selectedDir : 'Fleet default directory'}
        </div>
        ${showPicker.value ? html`
          <div style="margin-top:8px">
            <${FolderPicker}
              onSelect=${(path) => { workDir.value = path; showPicker.value = false; }}
              onCancel=${() => { showPicker.value = false; }}
            />
          </div>
        ` : null}
      </div>

      <div class="card capture-list">
        <div class="card-header">
          <span class="card-title">Recent notes</span>
          ${loading.value ? html`<span style="color:var(--text-muted); font-size:12px">Loading…</span>` : null}
        </div>
        ${notes.value.length === 0 && !loading.value ? html`
          <p style="color:var(--text-muted); margin:0">No notes yet.</p>
        ` : null}
        ${notes.value.map((note) => html`
          <div class="capture-note" key=${note.id}>
            <div class="capture-note-text">${note.text}</div>
            <div class="capture-note-foot">
              <span class="capture-note-time">${formatTime(note.createdAt)}</span>
              <div style="display:flex; gap:8px; flex-wrap:wrap">
                <button class="btn btn-subtle capture-touch" onclick=${() => copyNote(note.text)}>Copy</button>
                <button class="btn btn-subtle capture-touch" disabled=${spawning.value} onclick=${() => spawnAgent(note.text, spawning, workDir.value)}>Send to agent</button>
                <button class="btn btn-subtle capture-touch" onclick=${() => deleteNote(note.id)}>Delete</button>
              </div>
            </div>
          </div>
        `)}
      </div>
    </div>
  `;
}
