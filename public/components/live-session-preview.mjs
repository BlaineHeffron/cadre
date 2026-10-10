import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { route } from 'preact-router';
import { api } from '../app/api.mjs';
import { subscribe } from '../app/ws-client.mjs';
import { addToast, markSessionTurnSeen, sessionDisplayStatus } from '../app/state.mjs';
import { Terminal } from './terminal.mjs';

const STATE_LABELS = {
  starting: 'Starting',
  blocked: 'Needs Attention',
  done: 'Done',
  ready: 'Idle',
  thinking: 'Thinking',
  working: 'Working',
  awaiting_response: 'Awaiting Response',
  ended: 'Ended',
  unknown: 'Unknown',
};

function detailRoute(kind, id) {
  return `/${kind}/${id}`;
}

export function LiveSessionPreview({ session, title = '', onRemove = null }) {
  const content = useMemo(() => signal(''), []);
  const sessionState = useMemo(() => signal(session?.state || { status: 'unknown', reason: '' }), []);

  useEffect(() => {
    if (!session?.id || !session?._kind || session?.source === 'bare-process') return undefined;

    let cancelled = false;
    sessionState.value = session.state || { status: 'unknown', reason: '' };
    content.value = '';
    const path = `/${session._kind}/sessions/${session.id}?lines=120`;
    api.get(path)
      .then((data) => {
        if (cancelled) return;
        content.value = String(data?.content || '');
        if (data?.state) {
          sessionState.value = data.state;
          if (document.visibilityState === 'visible') markSessionTurnSeen(session._kind, { id: session.id, state: data.state });
        }
      })
      .catch((error) => {
        if (!cancelled) addToast(`Failed to load preview: ${error.message}`, 'error');
      });

    const unsub = subscribe(`${session._kind}:session:${session.id}`, (type, data) => {
      if (cancelled || type !== 'content') return;
      content.value = String(data?.content || '');
      if (data?.state) {
        sessionState.value = data.state;
        if (document.visibilityState === 'visible') markSessionTurnSeen(session._kind, { id: session.id, state: data.state });
      }
    }, { lines: 120 });

    const markViewed = () => {
      if (document.visibilityState === 'visible') markSessionTurnSeen(session._kind, { id: session.id, state: sessionState.value });
    };
    document.addEventListener('visibilitychange', markViewed);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', markViewed);
      unsub?.();
    };
  }, [session?.id, session?._kind, session?.source]);

  const openSession = () => route(detailRoute(session._kind, session.id));
  const stateLabel = STATE_LABELS[sessionDisplayStatus(session._kind, { id: session.id, state: sessionState.value })] || STATE_LABELS.unknown;
  const detail = String(sessionState.value?.interaction?.detail || sessionState.value?.reason || '').trim();

  return html`
    <div class="card" style="display:flex; flex-direction:column; min-height:340px">
      <div class="card-header" style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px">
        <div style="min-width:0">
          <div class="card-title" style="font-size:14px; line-height:1.3; white-space:nowrap; overflow:hidden; text-overflow:ellipsis" title=${title || session?.displayName || session?.id}>
            ${title || session?.displayName || session?.id}
          </div>
          <div style="font-size:11px; color:var(--text-muted); margin-top:4px">
            ${(session?._provider || session?._kind || 'agent').toUpperCase()} · ${stateLabel} · revision ${sessionState.value?.revision ?? 0}
          </div>
          ${detail ? html`<div style="font-size:11px; color:var(--text-secondary); margin-top:4px">${detail}</div>` : null}
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end">
          <button class="btn" type="button" onclick=${openSession}>Open</button>
          ${onRemove ? html`<button class="btn" type="button" onclick=${() => onRemove(session)}>Remove</button>` : null}
        </div>
      </div>
      <div style="flex:1; min-height:0; cursor:pointer" onclick=${openSession}>
        <${Terminal}
          content=${content.value}
          ansiColors=${true}
          maxHeight="260px"
        />
      </div>
    </div>
  `;
}
