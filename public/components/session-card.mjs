import { h } from 'preact';
import { html } from 'htm/preact';
import { route } from 'preact-router';
import { copyText, linkedThreadsForSession, sessionTitle, shortThreadId } from '../app/agent-bus-ui.mjs';
import { providerDescriptor } from '../app/providers.mjs';
import { isActiveThread } from '../pages/agent-collab/format.mjs';
import { addToast, agentThreads, seenSessionStoreForKind, hasSeenPromptNotification, sessionDisplayStatus } from '../app/state.mjs';
import { MachineChip } from './machines.mjs';
import { LocalPath } from './local-path.mjs';

// Every state pairs its colour with a glyph and a label, so it reads without colour.
const STATE_CONFIG = {
  starting: { label: 'Starting', icon: '○', cls: 'badge-info', pulse: false, idle: false },
  blocked: { label: 'Needs attention', icon: '!', cls: 'badge-critical', pulse: true, idle: true },
  done: { label: 'Done', icon: '✓', cls: 'badge-success', pulse: false, idle: false },
  ready: { label: 'Idle', icon: '●', cls: 'badge-medium', pulse: true, idle: true },
  thinking: { label: 'Thinking', icon: '◔', cls: 'badge-info', pulse: false, idle: false },
  working: { label: 'Working', icon: '▶', cls: 'badge-info', pulse: false, idle: false },
  awaiting_response: { label: 'Awaiting response', icon: '⋯', cls: 'badge-info', pulse: false, idle: false },
  ended: { label: 'Ended', icon: '■', cls: 'badge-low', pulse: false, idle: false },
  unknown: { label: 'Unknown', icon: '?', cls: 'badge-low', pulse: true, idle: true },
};

// Generic reasons that only repeat the status badge add a line without saying anything new.
const STATUS_ECHOES = new Set(['Provider reports working', 'Provider reports thinking', 'Waiting for input']);

// The line under a session's title: what it is asking or why it is in its state, unless that is
// just the badge again.
export function sessionDetail(session) {
  const detail = session.state?.interaction?.detail || session.state?.reason || '';
  return STATUS_ECHOES.has(detail) ? '' : detail;
}

export function StatusBadge({ status }) {
  const { label, icon, cls } = STATE_CONFIG[status] || STATE_CONFIG.unknown;
  return html`<span class="badge status-badge ${cls}"><span aria-hidden="true">${icon}</span><span>${label}</span></span>`;
}

/** Extract a short project label from a full path, e.g. "/home/user/projects/foo" → "projects/foo" */
export function projectLabel(workDir) {
  if (!workDir) return null;
  const parts = workDir.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length <= 2) return workDir;
  // Show last 2 segments (typically parent/project)
  return parts.slice(-2).join('/');
}

// Choosing an item closes its ⋯ menu, like any other menu.
export function closeMenuOnChoice(event) {
  if (event.target.closest('button, a')) event.currentTarget.closest('details').open = false;
}

export function SessionCard({ session, provider = 'claude', onShiftTab, onEscape, onKill, onResume, onStartFresh, onStartLoop, extraActions = null, selected = false, onToggleSelected = null }) {
  const descriptor = providerDescriptor(provider);
  const timeAgo = session.created
    ? new Date(session.created * 1000).toLocaleTimeString()
    : '';

  const status = sessionDisplayStatus(descriptor.kind, session);
  const stateInfo = STATE_CONFIG[status] || STATE_CONFIG.unknown;
  const isRustManagedReadOnly = session.readOnly === true && session.externalOwner === 'rust-monitor';
  const isMutable = !isRustManagedReadOnly;
  const isEnded = session.state?.status === 'ended';
  const label = projectLabel(session.workDir);
  const isUnseen = !seenSessionStoreForKind(descriptor.kind).value.has(session.id);
  const hasPromptAttention = session.attention?.active
    && session.attention.kind === 'prompt_ready'
    && !hasSeenPromptNotification(descriptor.kind, session.attention.key);
  const detailText = sessionDetail(session);
  const shouldPulseState = stateInfo.pulse && (session.state?.status !== 'ready' || hasPromptAttention);
  const shouldIdleState = stateInfo.idle && (session.state?.status !== 'ready' || hasPromptAttention);
  const linkedThreads = linkedThreadsForSession(descriptor.kind, session.id, agentThreads.value.filter(isActiveThread));
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
      <div class="card-header" style="display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:8px; align-items:start">
        <span
          class="card-title"
          title=${primaryName}
          style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
          ${isUnseen ? html`<span class="unread-dot" role="img" aria-label="Unread" title="Unread"></span>` : null}${primaryName}
        </span>
        ${isMutable && onToggleSelected ? html`
          <label style="display:flex; align-items:center; gap:6px; font-size:var(--fs-sm); color:var(--text-secondary)" onclick=${e => e.stopPropagation()}>
            <input
              type="checkbox"
              checked=${selected}
              onInput=${() => onToggleSelected(session)} />
            Select
          </label>
        ` : html`<div></div>`}
      </div>
      ${linkedThreads.length > 0 ? html`
        <div style="font-size:var(--fs-xs); color:var(--text-muted); margin:-4px 0 6px 0; cursor:pointer" onclick=${e => e.stopPropagation()}>
          ${linkedThreads.map((thread) => html`
            <span
              style="cursor:pointer; text-decoration:underline dotted; text-underline-offset:2px"
              onclick=${(event) => copyThreadId(thread.id, event)}
              title=${`Click to copy thread ID: ${thread.id}`}
            >${thread.title || shortThreadId(thread.id)}</span>
          `)}
        </div>
      ` : null}
      <div style="display:flex; gap:8px; font-size:var(--fs-sm); color:var(--text-primary); align-items:center">
        <${StatusBadge} status=${status} />
        <${MachineChip} machine=${session.machine} />
        ${session.workDir ? html`<${LocalPath} path=${session.workDir} style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${label}<//>` : null}
      </div>
      <div class="session-card-foot">
        <div style="min-width:0">
          <div style="display:flex; flex-wrap:wrap; gap:0 8px; font-size:var(--fs-sm); color:var(--text-secondary); margin-top:2px; overflow-wrap:anywhere">
            ${isRustManagedReadOnly ? html`<span>rust-managed</span><span>read-only</span>` : null}
            ${session.source === 'tmux-external' && !isRustManagedReadOnly ? html`<span>external</span>` : null}
            ${label || session.displayName ? html`<span>${session.name}</span>` : null}
            ${session.pid ? html`<span>PID ${session.pid}</span>` : null}
            ${timeAgo ? html`<span>${timeAgo}</span>` : null}
          </div>
          ${detailText ? html`
            <div style="font-size:var(--fs-sm); color:var(--text-primary); margin-top:4px">${detailText}</div>
          ` : null}
        </div>
        <div class="session-card-actions" onclick=${e => e.stopPropagation()}>
          ${isEnded && onResume
            ? html`<button class="btn btn-primary" onclick=${() => onResume(session)} title="Resume prior CLI conversation">Resume</button>`
            : html`<button class="btn btn-primary" onclick=${handleClick}>Open</button>`}
          <details class="more-menu">
            <summary class="btn" aria-label=${`More actions for ${primaryName}`} title="More actions">⋯</summary>
            <div class="more-menu-list" onClickCapture=${closeMenuOnChoice}>
              <button class="btn" onclick=${copySessionId} title="Copy session ID">Copy ID</button>
              ${extraActions}
              ${!isEnded && onStartLoop ? html`<button class="btn" onclick=${() => onStartLoop(session)}>Start loop</button>` : null}
              ${isEnded && !session.canResume && onStartFresh ? html`
                <button class="btn" onclick=${() => onStartFresh(session)} title="Start a fresh session in this workdir">Start Fresh</button>
              ` : null}
              ${isMutable && !isEnded ? html`
                ${descriptor.hasShiftTab ? html`
                  <button class="btn" onclick=${() => onShiftTab(session.id)} title="Send Shift+Tab (interrupt/accept)">Shift+Tab</button>
                ` : null}
                <button class="btn" onclick=${() => onEscape(session.id)} title="Send Escape key">Esc</button>
                <button class="btn btn-danger" onclick=${() => onKill(session)} title="Kill this session">Kill</button>
              ` : null}
            </div>
          </details>
        </div>
      </div>
    </div>
  `;
}
