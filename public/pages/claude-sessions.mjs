import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { route } from 'preact-router';
import { api } from '../app/api.mjs';
import { addToast, agentThreads, claudeSessions, setClaudeSessions, wsConnected } from '../app/state.mjs';
import { SessionCard } from '../components/session-card.mjs';
import { FolderPicker } from '../components/folder-picker.mjs';
import { sessionTitle } from '../app/agent-bus-ui.mjs';

const DEFAULT_WORKDIR_PLACEHOLDER = '/path/to/project';

async function loadSessions(loading) {
  loading.value = true;
  try {
    const data = await api.get('/claude/sessions');
    setClaudeSessions(data.sessions);
  } catch (e) {
    addToast(`Failed to load sessions: ${e.message}`, 'error');
  } finally {
    loading.value = false;
  }
}

async function loadSkills(skills) {
  try {
    const data = await api.get('/skills');
    skills.value = data.skills;
  } catch {
    skills.value = [];
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

async function sendShiftTab(id) {
  try {
    await api.post(`/claude/sessions/${id}/shift-tab`);
    addToast('Shift+Tab sent', 'success');
  } catch (e) {
    addToast(`Failed: ${e.message}`, 'error');
  }
}

async function sendEscape(id) {
  try {
    await api.post(`/claude/sessions/${id}/escape`);
    addToast('Escape sent', 'success');
  } catch (e) {
    addToast(`Failed: ${e.message}`, 'error');
  }
}

function makeKillSession(loading) {
  return async function killSession(session) {
    const id = session?.id;
    const label = session?.name || id;
    if (!id) return;
    if (!window.confirm(`Kill Claude session ${label}?`)) return;
    try {
      await api.delete(`/claude/sessions/${encodeURIComponent(id)}`);
      addToast('Session killed', 'success');
      loadSessions(loading);
    } catch (e) {
      addToast(`Failed: ${e.message}`, 'error');
    }
  };
}

function SkillPicker({ skills, selectedSkill }) {
  if (skills.value.length === 0) return null;

  return html`
    <div style="margin-top:8px">
      <div style="font-size:12px; color:var(--text-muted); margin-bottom:4px">Prepopulate with skill (optional):</div>
      <div style="display:flex; flex-wrap:wrap; gap:4px">
        ${selectedSkill.value ? html`
          <button
            class="btn"
            style="padding:3px 8px; font-size:11px; background:var(--bg-card); color:var(--text-muted)"
            onclick=${() => { selectedSkill.value = null; }}
          >Clear</button>
        ` : null}
        ${skills.value.map(s => html`
          <button
            class="btn"
            style="padding:3px 8px; font-size:11px; font-family:var(--font-mono); ${
              selectedSkill.value?.name === s.name
                ? 'background:var(--accent); color:var(--bg-primary); border-color:var(--accent)'
                : ''
            }"
            onclick=${() => { selectedSkill.value = s; }}
            title=${s.description || s.name}
          >/${s.name}</button>
        `)}
      </div>
      ${selectedSkill.value ? html`
        <div style="font-size:11px; color:var(--text-muted); margin-top:4px; font-style:italic">
          ${selectedSkill.value.description || `Will send /${selectedSkill.value.name} after session starts`}
        </div>
      ` : null}
    </div>
  `;
}

export function ClaudeSessionsPage() {
  const loading = useMemo(() => signal(false), []);
  const showNewModal = useMemo(() => signal(false), []);
  const newDisplayName = useMemo(() => signal(''), []);
  const newWorkDir = useMemo(() => signal(''), []);
  const showFolderPicker = useMemo(() => signal(false), []);
  const skills = useMemo(() => signal([]), []);
  const selectedSkill = useMemo(() => signal(null), []);

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
      if (selectedSkill.value) {
        body.initialPrompt = `/${selectedSkill.value.name}`;
      }
      const data = await api.post('/claude/sessions', body);
      addToast(`Session created: ${data.sessionName}`, 'success');

      // Save bootstrap for "Repeat last"
      const bootstrap = {
        displayName: newDisplayName.value.trim(),
        workDir: newWorkDir.value.trim(),
      };
      if (selectedSkill.value) bootstrap.skill = selectedSkill.value.name;
      localStorage.setItem('dueno_last_claude_bootstrap', JSON.stringify(bootstrap));

      showNewModal.value = false;
      newDisplayName.value = '';
      newWorkDir.value = '';
      selectedSkill.value = null;
      route(`/claude/${data.id}`);
    } catch (e) {
      addToast(`Failed to create session: ${e.message}`, 'error');
    }
  }

  async function quickCreate() {
    try {
      const data = await api.post('/claude/sessions', {});
      addToast(`Session created: ${data.sessionName}`, 'success');
      route(`/claude/${data.id}`);
    } catch (e) {
      addToast(`Failed: ${e.message}`, 'error');
    }
  }

  function prefillLastBootstrap() {
    try {
      const last = JSON.parse(localStorage.getItem('dueno_last_claude_bootstrap'));
      if (!last) return;
      if (last.displayName) newDisplayName.value = last.displayName;
      if (last.workDir) newWorkDir.value = last.workDir;
      if (last.skill && skills.value.length > 0) {
        const match = skills.value.find(s => s.name === last.skill);
        if (match) selectedSkill.value = match;
      }
    } catch { /* ignore */ }
  }

  function getLastBootstrapLabel() {
    try {
      const last = JSON.parse(localStorage.getItem('dueno_last_claude_bootstrap'));
      if (!last) return null;
      const parts = [];
      if (last.displayName) parts.push(last.displayName);
      if (last.workDir) parts.push(last.workDir.replace(/^.*\//, ''));
      if (last.skill) parts.push(`/${last.skill}`);
      return parts.join(' + ') || null;
    } catch { return null; }
  }

  function openNewModal() {
    showNewModal.value = true;
    loadSkills(skills);
  }

  useEffect(() => {
    // Initial load
    loadSessions(loading);
    loadThreads();
    // WS updates handled by app.mjs claude:sessions subscription
    // Fallback polling every 30s in case WS is down
    const interval = setInterval(() => {
      if (document.hidden || wsConnected.value) return;
      loadSessions(loading);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  function getSessionLabel(session) {
    return sessionTitle(session, 'claude', agentThreads.value);
  }

  return html`
    <div class="page">
      <div class="card-header">
        <h1 class="card-title" style="font-size:18px">Claude Sessions</h1>
        <div style="display:flex; gap:8px">
          <button class="btn" onclick=${() => loadSessions(loading)}>Refresh</button>
          <button class="btn btn-primary" onclick=${openNewModal}>New Session</button>
        </div>
      </div>

      ${showNewModal.value ? html`
        <div class="card" style="margin-bottom:12px">
          <div class="card-header">
            <span class="card-title">New Claude Session</span>
            <button class="btn" onclick=${() => { showNewModal.value = false; }}>Cancel</button>
          </div>
          <p style="font-size:12px; color:var(--text-muted); margin-bottom:8px">
            Creates a new tmux session running Claude Code CLI.
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
          <${SkillPicker} skills=${skills} selectedSkill=${selectedSkill} />
        </div>
      ` : null}

      ${loading.value
        ? html`<p>Loading sessions...</p>`
        : claudeSessions.value.length === 0
          ? html`<div class="card"><p style="color:var(--text-muted)">No Claude sessions running. Click "New Session" to start one.</p></div>`
          : html`
            <div class="grid grid-2">
              ${claudeSessions.value.map(s => html`
                <${SessionCard}
                  session=${s}
                  onShiftTab=${sendShiftTab}
                  onEscape=${sendEscape}
                  onKill=${killSession}
                />
              `)}
            </div>
          `
      }

      <button class="fab" onclick=${quickCreate} title="Quick create session">+</button>
    </div>
  `;
}
