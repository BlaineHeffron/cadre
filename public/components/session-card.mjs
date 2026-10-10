import { h } from 'preact';
import { html } from 'htm/preact';
import { route } from 'preact-router';
import { copyText, linkedThreadsForSession, sessionTitle, shortThreadId } from '../app/agent-bus-ui.mjs';
import { providerDescriptor } from '../app/providers.mjs';
import { addToast, agentThreads, seenSessionStoreForKind, hasSeenPromptNotification, sessionDisplayStatus } from '../app/state.mjs';

const STATE_CONFIG = {
  starting: { label: 'Starting', cls: 'badge-info', pulse: false, idle: false },
  blocked: { label: 'Needs Attention', cls: 'badge-critical', pulse: true, idle: true },
  done: { label: 'Done', cls: 'badge-info', pulse: false, idle: false },
  ready: { label: 'Idle', cls: 'badge-medium', pulse: true, idle: true },
  thinking: { label: 'Thinking', cls: 'badge-info', pulse: false, idle: false },
  working: { label: 'Working', cls: 'badge-success', pulse: false, idle: false },
  awaiting_response: { label: 'Awaiting Response', cls: 'badge-info', pulse: false, idle: false },
  ended: { label: 'Ended', cls: 'badge-low', pulse: false, idle: false },
  unknown: { label: 'Unknown', cls: 'badge-critical', pulse: true, idle: true },
};

/** Extract a short project label from a full path, e.g. "/home/user/projects/foo" → "projects/foo" */
function projectLabel(workDir) {
  if (!workDir) return null;
  const parts = workDir.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length <= 2) return workDir;
  // Show last 2 segments (typically parent/project)
  return parts.slice(-2).join('/');
}

export function SessionCard({ session, provider = 'claude', onShiftTab, onEscape, onKill, onResume, onStartFresh, onStartLoop, extraActions = null, selected = false, onToggleSelected = null }) {
  const descriptor = providerDescriptor(provider);
  const timeAgo = session.created
    ? new Date(session.created * 1000).toLocaleTimeString()
    : '';

  const stateInfo = STATE_CONFIG[sessionDisplayStatus(descriptor.kind, session)] || STATE_CONFIG.unknown;
  const isRustManagedReadOnly = session.readOnly === true && session.externalOwner === 'rust-monitor';
  const isMutable = !isRustManagedReadOnly;
  const isEnded = session.state?.status === 'ended';
  const label = projectLabel(session.workDir);
  const isUnseen = !seenSessionStoreForKind(descriptor.kind).value.has(session.id);
  const hasPromptAttention = session.attention?.active
    && session.attention.kind === 'prompt_ready'
    && !hasSeenPromptNotification(descriptor.kind, session.attention.key);
  const detailText = session.state?.interaction?.detail || session.state?.reason || '';
  const shouldPulseState = stateInfo.pulse && (session.state?.status !== 'ready' || hasPromptAttention);
  const shouldIdleState = stateInfo.idle && (session.state?.status !== 'ready' || hasPromptAttention);
  const linkedThreads = linkedThreadsForSession(descriptor.kind, session.id, agentThreads.value);
  const primaryName = sessionTitle(session, descriptor.kind, agentThreads.value, label);

  function handleClick() {
    route(`${descriptor.routeBase}/${session.id}`);
  }

  function handleCardKeyDown(event) {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    route(`${descriptor.routeBase}/${session.id}`);
  }

  async function copyThreadId(threadId, event) {
    event.stopPropagation();
    try {
      await copyText(threadId);
      addToast(`Copied thread ID ${threadId}`, 'success');
    } catch (e) {
      addToast(`Failed to copy thread ID: ${e.message}`, 'error');
    }
  }

  async function copySessionId(event) {
    event.stopPropagation();
    try {
      await copyText(session.id);
      addToast(`Copied session ID ${session.id}`, 'success');
    } catch (e) {
      addToast(`Failed to copy session ID: ${e.message}`, 'error');
    }
  }

  return html`
    <div
      class="card session-card ${shouldPulseState ? 'session-card-pulse' : ''} ${shouldIdleState ? 'session-card-idle' : ''}"
      onclick=${handleClick}
      onKeyDown=${handleCardKeyDown}
      role="button"
      tabIndex=${0}
      aria-label=${`Open ${descriptor.label} session ${primaryName}`}
    >
      ${isUnseen ? html`<div class="session-new-banner">NEW</div>` : null}
      <div class="card-header" style="display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:8px; align-items:start">
        <span
          class="card-title"
          title=${primaryName}
          style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
          ${primaryName}
        </span>
        ${isMutable && onToggleSelected ? html`
          <label style="display:flex; align-items:center; gap:6px; font-size:11px; color:var(--text-muted)" onclick=${e => e.stopPropagation()}>
            <input
              type="checkbox"
              checked=${selected}
              onInput=${() => onToggleSelected(session)} />
            Select
          </label>
        ` : html`<div></div>`}
      </div>
      ${linkedThreads.length > 0 ? html`
        <div style="font-size:11px; color:var(--text-muted); margin:-4px 0 6px 0; cursor:pointer" onclick=${e => e.stopPropagation()}>
          ${linkedThreads.map((thread) => html`
            <span
              style="cursor:pointer; text-decoration:underline dotted; text-underline-offset:2px"
              onclick=${(event) => copyThreadId(thread.id, event)}
              title=${`Click to copy thread ID: ${thread.id}`}
            >${thread.title || shortThreadId(thread.id)}</span>
          `)}
        </div>
      ` : null}
      <div style="display:flex; gap:8px; font-size:12px; color:var(--text-muted); align-items:center">
        ${stateInfo.label === 'Done' ? html`<span class="badge badge-info">Done</span>` : null}
        ${session.workDir ? html`<span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--font-mono); font-size:11px" title=${session.workDir}>${session.workDir}</span>` : null}
      </div>
      <div style="display:flex; gap:8px; font-size:11px; color:var(--text-muted); margin-top:2px">
        ${isRustManagedReadOnly ? html`<span>rust-managed</span><span>read-only</span>` : null}
        ${session.source === 'tmux-external' && !isRustManagedReadOnly ? html`<span>external</span>` : null}
        ${label || session.displayName ? html`<span style="opacity:0.7">${session.name}</span>` : null}
        ${session.pid ? html`<span>PID ${session.pid}</span>` : null}
        ${timeAgo ? html`<span>${timeAgo}</span>` : null}
      </div>
      ${!isEnded && onStartLoop ? html`
        <div style="margin-top:4px" onclick=${e => e.stopPropagation()}>
          <button class="btn" style="font-size:11px; padding:3px 8px" onclick=${() => onStartLoop(session)}>Start loop</button>
        </div>
      ` : null}
      ${detailText ? html`
        <div style="font-size:11px; color:var(--text-secondary); margin-top:4px">${detailText}</div>
      ` : null}
      <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap" onclick=${e => e.stopPropagation()}>
          <button class="btn" onclick=${copySessionId} title="Copy session ID">Copy ID</button>
          ${extraActions}
          ${isEnded && onResume ? html`
            <button class="btn" onclick=${() => onResume(session)} title="Resume prior CLI conversation">Resume</button>
          ` : null}
          ${isEnded && !session.canResume && onStartFresh ? html`
            <button class="btn" onclick=${() => onStartFresh(session)} title="Start a fresh session in this workdir">Start Fresh</button>
          ` : null}
          ${descriptor.kind === 'codex' ? html`
            <button class="btn" onclick=${() => route(`${descriptor.routeBase}/${session.id}`)} title="Open session">Open</button>
          ` : null}
          ${isMutable && !isEnded ? html`
            ${descriptor.hasShiftTab ? html`
              <button
                class="btn btn-primary"
                onclick=${() => onShiftTab(session.id)}
                title="Send Shift+Tab (interrupt/accept)"
                style="font-weight:700"
              >
                Shift+Tab
              </button>
            ` : null}
            <button class="btn" onclick=${() => onEscape(session.id)} title="Send Escape key">Esc</button>
            <button class="btn btn-danger" onclick=${() => onKill(session)} title="Kill this session">Kill</button>
          ` : null}
      </div>
    </div>
  `;
}
