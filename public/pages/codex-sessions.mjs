import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { route } from 'preact-router';
import { api } from '../app/api.mjs';
import { addToast, agentThreads, codexSessions, setCodexSessions, wsConnected } from '../app/state.mjs';
import { CodexSessionCard } from '../components/codex-session-card.mjs';
import { FolderPicker } from '../components/folder-picker.mjs';
import { sessionTitle } from '../app/agent-bus-ui.mjs';

const DEFAULT_WORKDIR_PLACEHOLDER = '/path/to/project';

async function loadSessions(loading) {
  loading.value = true;
  try {
    const data = await api.get('/codex/sessions');
    setCodexSessions(data.sessions);
  } catch (e) {
    addToast(`Failed to load sessions: ${e.message}`, 'error');
  } finally {
    loading.value = false;
  }
}

async function sendEscape(id) {
  try {
    await api.post(`/codex/sessions/${id}/escape`);
    addToast('Escape sent', 'success');
  } catch (e) {
    addToast(`Failed: ${e.message}`, 'error');
  }
}

async function loadThreads() {
  try {
    const data = await api.get('/agent-bus/threads');
    agentThreads.value = data.threads || [];
  } catch {
    // Best effort
  }
}

function makeKillSession(loading) {
  return async function killSession(session) {
    const id = session?.id;
    const label = session?.name || id;
    if (!id) return;
    if (!window.confirm(`Kill Codex session ${label}?`)) return;
    try {
      await api.delete(`/codex/sessions/${encodeURIComponent(id)}`);
      addToast('Session killed', 'success');
      loadSessions(loading);
    } catch (e) {
      addToast(`Failed: ${e.message}`, 'error');
    }
  };
}

export function CodexSessionsPage() {
  const loading = useMemo(() => signal(false), []);
  const showNewModal = useMemo(() => signal(false), []);
  const newDisplayName = useMemo(() => signal(''), []);
  const newWorkDir = useMemo(() => signal(''), []);
  const showFolderPicker = useMemo(() => signal(false), []);

  const killSession = useMemo(() => makeKillSession(loading), []);

  async function createSession() {
    try {
      const body = {};
      if (newDisplayName.value.trim()) {
        body.displayName = newDisplayName.value.trim();
      }
      if (newWorkDir.value.trim()) {
        body.workDir = newWorkDir.value.trim();
      }
      const data = await api.post('/codex/sessions', body);
      addToast(`Session created: ${data.sessionName}`, 'success');

      // Save bootstrap for "Repeat last"
      localStorage.setItem('dueno_last_codex_bootstrap', JSON.stringify({
        displayName: newDisplayName.value.trim(),
        workDir: newWorkDir.value.trim(),
      }));

      showNewModal.value = false;
      newDisplayName.value = '';
      newWorkDir.value = '';
      route(`/codex/${data.id}`);
    } catch (e) {
      addToast(`Failed to create session: ${e.message}`, 'error');
    }
  }

  function prefillLastBootstrap() {
    try {
      const last = JSON.parse(localStorage.getItem('dueno_last_codex_bootstrap'));
      if (last?.displayName) newDisplayName.value = last.displayName;
      if (last?.workDir) newWorkDir.value = last.workDir;
    } catch { /* ignore */ }
  }

  function getLastBootstrapLabel() {
    try {
      const last = JSON.parse(localStorage.getItem('dueno_last_codex_bootstrap'));
      if (!last) return null;
      const parts = [];
      if (last.displayName) parts.push(last.displayName);
      if (last.workDir) parts.push(last.workDir.replace(/^.*\//, ''));
      return parts.join(' + ') || null;
    } catch { return null; }
  }

  useEffect(() => {
    loadSessions(loading);
    loadThreads();
    const interval = setInterval(() => {
      if (document.hidden || wsConnected.value) return;
      loadSessions(loading);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  function getSessionLabel(session) {
    return sessionTitle(session, 'codex', agentThreads.value);
  }

  return html`
    <div class="page">
      <div class="card-header">
        <h1 class="card-title" style="font-size:18px">Codex Sessions</h1>
        <div style="display:flex; gap:8px">
          <button class="btn" onclick=${() => loadSessions(loading)}>Refresh</button>
          <button class="btn btn-primary" onclick=${() => { showNewModal.value = true; }}>New Session</button>
        </div>
      </div>

      ${showNewModal.value ? html`
        <div class="card" style="margin-bottom:12px">
          <div class="card-header">
            <span class="card-title">New Codex Session</span>
            <button class="btn" onclick=${() => { showNewModal.value = false; }}>Cancel</button>
          </div>
          <p style="font-size:12px; color:var(--text-muted); margin-bottom:8px">
            Creates a new tmux session running Codex CLI with approval and sandbox bypass enabled.
          </p>
          ${getLastBootstrapLabel() ? html`
            <button
              class="btn"
              style="margin-bottom:8px; font-size:11px; padding:4px 10px"
              onclick=${prefillLastBootstrap}
              title="Prefill with last session config"
            >Repeat last: ${getLastBootstrapLabel()}</button>
          ` : null}
          <div style="display:flex; gap:8px; margin-bottom:8px">
            <input
              type="text"
              placeholder="Session name (optional)"
              value=${newDisplayName.value}
              onInput=${e => { newDisplayName.value = e.target.value; }}
              style="flex:1; padding:8px; background:var(--bg-input); border:1px solid var(--border); border-radius:var(--radius); color:var(--text-primary)"
            />
          </div>
          <div style="display:flex; gap:8px; margin-bottom:${showFolderPicker.value ? '8px' : '0'}">
            <input
              type="text"
              placeholder=${DEFAULT_WORKDIR_PLACEHOLDER}
              value=${newWorkDir.value}
              onInput=${e => { newWorkDir.value = e.target.value; }}
              autocomplete="off"
              style="flex:1; padding:8px; background:var(--bg-input); border:1px solid var(--border); border-radius:var(--radius); color:var(--text-primary); font-family:var(--font-mono)"
            />
            <button class="btn" onclick=${() => { showFolderPicker.value = !showFolderPicker.value; }}>Browse</button>
            <button class="btn btn-primary" onclick=${createSession}>Create</button>
          </div>
          ${showFolderPicker.value ? html`
            <${FolderPicker}
              onSelect=${(path) => { newWorkDir.value = path; showFolderPicker.value = false; }}
              onCancel=${() => { showFolderPicker.value = false; }}
            />
          ` : null}
        </div>
      ` : null}

      ${loading.value
        ? html`<p>Loading sessions...</p>`
        : codexSessions.value.length === 0
          ? html`<div class="card"><p style="color:var(--text-muted)">No Codex sessions running. Click "New Session" to start one.</p></div>`
          : html`
            <div class="grid grid-2">
              ${codexSessions.value.map(s => html`
                <${CodexSessionCard}
                  session=${s}
                  onEscape=${sendEscape}
                  onKill=${killSession}
                />
              `)}
            </div>
          `
      }
    </div>
  `;
}
