import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { api } from '../app/api.mjs';
import { addToast } from '../app/state.mjs';
import { route } from 'preact-router';
import { copyText } from '../app/agent-bus-ui.mjs';
import { EmptyState, ErrorState, LoadingState } from '../components/page-state.mjs';

async function loadTree(panes, loading, loadError) {
  loading.value = true;
  loadError.value = '';
  try {
    const data = await api.get('/tmux/tree');
    panes.value = data.panes;
  } catch (e) {
    loadError.value = e.message || 'Unable to load tmux sessions.';
    addToast(`Failed to load tmux panes: ${e.message}`, 'error');
  } finally {
    loading.value = false;
  }
}

function openPane(target) {
  route(`/tmux/pane/${encodeURIComponent(target)}`);
}

function getAttachCommand(session) {
  return session?.attachCommand || '';
}

async function openSessionInTerminal(session, event) {
  event?.stopPropagation();
  const sessionName = session.name;
  const command = getAttachCommand(session);
  if (!command) return;
  try {
    await api.post(`/tmux/sessions/${encodeURIComponent(sessionName)}/open`);
    addToast(`Opened Terminator for ${sessionName}`, 'success');
  } catch (e) {
    try {
      await copyText(command);
      addToast(`Could not launch terminal. Copied: ${command}`, 'warning');
    } catch {
      addToast(`Failed to open terminal: ${e.message}`, 'error');
    }
  }
}

async function copyAttachCommand(session, event) {
  event?.stopPropagation();
  const command = getAttachCommand(session);
  if (!command) return;
  try {
    await copyText(command);
    addToast(`Copied: ${command}`, 'success');
  } catch (e) {
    addToast(`Failed to copy attach command: ${e.message}`, 'error');
  }
}

function makeCreateSession(newSessionName, showNewSession, panes, loading, loadError) {
  return async function createSession() {
    const name = newSessionName.value.trim();
    if (!name) {
      addToast('Enter a session name', 'warning');
      return;
    }
    try {
      await api.post('/tmux/sessions', { name });
      addToast(`Session "${name}" created`, 'success');
      showNewSession.value = false;
      newSessionName.value = '';
      loadTree(panes, loading, loadError);
    } catch (e) {
      addToast(`Failed to create session: ${e.message}`, 'error');
    }
  };
}

export function TmuxPage() {
  const loading = useMemo(() => signal(false), []);
  const loadError = useMemo(() => signal(''), []);
  const panes = useMemo(() => signal([]), []);
  const tmuxCapabilities = useMemo(() => signal({ canOpenTerminal: false, preferredTerminal: 'terminator' }), []);
  const showNewSession = useMemo(() => signal(false), []);
  const newSessionName = useMemo(() => signal(''), []);

  const createSession = useMemo(() => makeCreateSession(newSessionName, showNewSession, panes, loading, loadError), []);

  useEffect(() => {
    loadTree(panes, loading, loadError);
    api.get('/tmux/capabilities')
      .then((data) => { tmuxCapabilities.value = data; })
      .catch(() => { tmuxCapabilities.value = { canOpenTerminal: false, preferredTerminal: 'terminator' }; });
  }, []);

  if (loading.value) {
    return html`<div class="page"><${LoadingState} message="Loading tmux sessions..." /></div>`;
  }

  if (loadError.value) {
    return html`
      <div class="page">
        <${ErrorState}
          message=${`Tmux failed to load: ${loadError.value}`}
          actionLabel="Retry"
          onAction=${() => loadTree(panes, loading, loadError)}
        />
      </div>
    `;
  }

  // Group panes by session for visual grouping
  const sessions = {};
  for (const p of panes.value) {
    if (!sessions[p.session]) sessions[p.session] = [];
    sessions[p.session].push(p);
  }

  const sessionNames = Object.keys(sessions);

  return html`
    <div class="page">
      <div class="card-header">
        <h1 class="card-title" style="font-size:18px">Tmux Sessions</h1>
        <div style="display:flex; gap:8px">
          <button class="btn" onclick=${() => loadTree(panes, loading, loadError)}>Refresh</button>
          <button class="btn btn-primary" onclick=${() => { showNewSession.value = true; }}>New Session</button>
        </div>
      </div>

      ${showNewSession.value ? html`
        <div class="card" style="margin-bottom:12px">
          <div class="card-header">
            <span class="card-title">New Tmux Session</span>
            <button class="btn" onclick=${() => { showNewSession.value = false; }}>Cancel</button>
          </div>
          <div style="display:flex; gap:8px">
            <input
              type="text"
              placeholder="Session name"
              value=${newSessionName.value}
              onInput=${e => { newSessionName.value = e.target.value; }}
              onKeyDown=${e => { if (e.key === 'Enter') createSession(); }}
              style="flex:1; padding:8px; background:var(--bg-input); border:1px solid var(--border); border-radius:var(--radius); color:var(--text-primary); font-family:var(--font-mono)"
            />
            <button class="btn btn-primary" onclick=${createSession}>Create</button>
          </div>
        </div>
      ` : null}

      ${sessionNames.length === 0
        ? html`<${EmptyState} message="No tmux sessions found." />`
        : sessionNames.map(name => {
          const session = { name, attachCommand: sessions[name][0]?.attachCommand || '' };
          return html`
          <div class="card">
            <div class="card-header" style="margin-bottom:8px">
              <span class="card-title">${name}</span>
              <div style="display:flex; gap:6px; flex-wrap:wrap">
                ${session.attachCommand ? html`
                  <button
                    class="btn mobile-hidden"
                    onclick=${e => copyAttachCommand(session, e)}
                    title="Copy tmux attach command"
                    style="padding:2px 8px; line-height:1"
                  >Copy attach</button>
                ` : null}
                ${session.attachCommand && tmuxCapabilities.value.canOpenTerminal ? html`
                  <button
                    class="btn mobile-hidden"
                    onclick=${e => openSessionInTerminal(session, e)}
                    title="Open in Terminator"
                    style="padding:2px 8px; line-height:1"
                  >Open in Terminator</button>
                ` : null}
              </div>
            </div>
            ${sessions[name].map(p => html`
              <button
                class="tmux-pane-row"
                style="display:flex; align-items:center; gap:12px; padding:8px 12px; margin-bottom:4px; cursor:pointer; border-radius:var(--radius); background:var(--bg-secondary); border:1px solid var(--border); transition:border-color 0.15s; width:100%; text-align:left"
                onclick=${() => openPane(p.target)}
                onMouseOver=${e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                onMouseOut=${e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
              >
                <span style="font-family:var(--font-mono); font-size:13px; color:var(--text-primary); min-width:0; flex:1">
                  <span style="color:var(--text-muted)">w${p.windowIndex}</span>${' '}${p.windowName}${' '}
                  <span style="color:var(--text-muted)">p${p.paneIndex}</span>
                </span>
                <span style="font-size:12px; color:var(--text-muted); white-space:nowrap">${p.command}</span>
                <span class="badge badge-low" style="white-space:nowrap">${p.width}x${p.height}</span>
              </button>
            `)}
          </div>
        `;})
      }
    </div>
  `;
}
