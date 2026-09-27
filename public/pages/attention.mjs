import { h } from 'preact';
import { html } from 'htm/preact';
import { route } from 'preact-router';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { api } from '../app/api.mjs';
import { loadUnifiedAgentSessions } from '../app/agent-session-nav.mjs';
import { addToast, agentThreads, wsConnected } from '../app/state.mjs';
import {
  clearDismissedAttentionItems,
  dismissAttentionItem,
  setSessionMuted,
  visibleAttentionItems,
} from '../app/attention.mjs';

function fmtAge(ts) {
  const value = Number(ts || 0);
  if (!value) return '-';
  const sec = Math.max(0, Math.floor((Date.now() - value) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

function shortPath(path = '') {
  const text = String(path || '').trim();
  if (!text) return '-';
  return text.replace(/^\/home\/[^/]+\/projects\//, '~/projects/');
}

function itemBadgeClass(item) {
  if (item.rank === 0) return 'badge-critical';
  if (item.type === 'delivery') return 'badge-warning';
  return 'badge-medium';
}

async function refreshAttention(loading, error) {
  loading.value = true;
  error.value = '';
  try {
    const [, threads] = await Promise.all([
      loadUnifiedAgentSessions(),
      api.get('/agent-bus/threads').catch(() => ({ threads: [] })),
    ]);
    agentThreads.value = threads?.threads || [];
  } catch (err) {
    error.value = err.message || 'Refresh failed';
    addToast(`Attention refresh failed: ${error.value}`, 'error');
  } finally {
    loading.value = false;
  }
}

async function sendChoice(item, option) {
  if (item.type !== 'session' || !option?.key) return;
  try {
    const path = `/${item.kind}/sessions/${encodeURIComponent(item.sessionId)}`;
    const guards = {
      expectedRevision: item.revision,
      expectedFingerprint: item.interactionFingerprint,
      expectedInteractionKind: item.interactionKind,
    };
    if (/^[a-z0-9]$/i.test(option.key)) {
      await api.post(`${path}/keys`, { keys: option.key, ...guards });
    } else {
      await api.post(`${path}/input`, {
        text: option.key,
        enter: true,
        source: 'ui_dialog_answer',
        ...guards,
      });
    }
    addToast(`${option.label} sent`, 'success');
  } catch (err) {
    addToast(`Choice failed: ${err.message}`, 'error');
  }
}

function openItem(item) {
  route(item.route);
}

export function AttentionPage() {
  const loading = useMemo(() => signal(false), []);
  const error = useMemo(() => signal(''), []);
  const visibleRows = visibleAttentionItems.value;
  const approvalCount = visibleRows.filter((item) => item.rank === 0).length;
  const promptCount = visibleRows.length - approvalCount;

  useEffect(() => {
    refreshAttention(loading, error);
    const interval = setInterval(() => {
      if (document.hidden || wsConnected.value) return;
      refreshAttention(loading, error);
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  return html`
    <div class="page attention-page">
      <div class="attention-header">
        <div>
          <h1 class="card-title" style="font-size:18px; margin-bottom:4px">Attention</h1>
          <div class="goals-inline-note">Human-waiting sessions and failed bus deliveries.</div>
        </div>
        <div class="attention-header-actions">
          <span class="badge ${approvalCount ? 'badge-critical' : 'badge-low'}">${approvalCount} approval</span>
          <span class="badge ${promptCount ? 'badge-warning' : 'badge-low'}">${promptCount} prompt</span>
          <button class="btn btn-subtle" type="button" onclick=${clearDismissedAttentionItems}>Show Dismissed</button>
          <button class="btn" type="button" onclick=${() => refreshAttention(loading, error)} disabled=${loading.value}>
            ${loading.value ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
      </div>

      ${error.value ? html`<div class="card" style="border-color:var(--danger); color:var(--danger)">${error.value}</div>` : null}

      <div class="attention-list">
        ${visibleRows.length === 0 ? html`
          <div class="card">
            <div class="card-title" style="margin-bottom:4px">No waiting sessions</div>
            <div style="font-size:12px; color:var(--text-muted)">No approvals, prompt-ready sessions, or failed bus deliveries.</div>
          </div>
        ` : visibleRows.map((item) => html`
          <div class="attention-row" key=${item.id}>
            <div class="attention-row-main">
              <div class="attention-row-title">
                <span class="badge ${itemBadgeClass(item)}">${item.statusLabel}</span>
                <span>${item.name}</span>
                <span class="badge badge-low">${item.providerLabel}</span>
                ${item.notifySuppressed ? html`<span class="badge badge-low">notify off</span>` : null}
              </div>
              <div class="attention-row-meta">
                <span>${shortPath(item.project)}</span>
                <span>${fmtAge(item.ageAt)}</span>
                <span>${item.target}</span>
              </div>
              <div class="attention-row-snippet">${item.snippet || 'No terminal snippet captured.'}</div>
            </div>
            <div class="attention-row-actions">
              ${item.type === 'session' ? html`
                ${(item.answerOptions || []).map((option) => html`
                  <button class="btn btn-primary" type="button" onclick=${() => sendChoice(item, option)}>
                    ${option.label}
                  </button>
                `)}
                <button class="btn btn-subtle" type="button" onclick=${() => {
                  setSessionMuted(item.kind, item.sessionId, !item.muted);
                  addToast(item.muted ? 'Session unmuted' : 'Session muted', 'info');
                }}>${item.muted ? 'Unmute' : 'Mute'}</button>
              ` : null}
              <button class="btn" type="button" onclick=${() => openItem(item)}>Open</button>
              <button class="btn btn-subtle" type="button" onclick=${() => dismissAttentionItem(item.id)}>Dismiss</button>
            </div>
          </div>
        `)}
      </div>
    </div>
  `;
}
