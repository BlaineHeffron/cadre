import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { api } from '../app/api.mjs';
import { addToast } from '../app/state.mjs';
import { EmptyState, ErrorState, LoadingState } from '../components/page-state.mjs';

function initialForm() {
  const params = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  return {
    kind: params.get('kind') || 'codex',
    sessionId: params.get('session_id') || '',
    title: '',
    prompt: '',
    intervalSeconds: '60',
    maxIterations: '10',
  };
}

function formatTime(value) {
  return value ? new Date(Number(value)).toLocaleString() : '—';
}

function formatInterval(value) {
  const seconds = Number(value || 0);
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

async function loadLoops(state) {
  state.loading.value = true;
  state.error.value = '';
  try {
    const payload = await api.get('/agents/scheduled');
    state.loops.value = (payload.tasks || []).filter((task) => task.type === 'inject');
  } catch (error) {
    state.error.value = error.message || 'Unable to load loop sessions.';
  } finally {
    state.loading.value = false;
  }
}

async function createLoop(state, event) {
  event.preventDefault();
  const form = state.form.value;
  state.formBusy.value = true;
  try {
    await api.post('/agents/scheduled', loopInputFromForm(form));
    state.form.value = { ...initialForm(), kind: form.kind, sessionId: form.sessionId };
    await loadLoops(state);
    addToast('Loop session created', 'success');
  } catch (error) {
    addToast(`Create failed: ${error.message}`, 'error');
  } finally {
    state.formBusy.value = false;
  }
}

export function loopInputFromForm(form = {}) {
  return {
    type: 'inject',
    targetSession: { kind: form.kind.trim(), sessionId: form.sessionId.trim() },
    prompt: form.prompt.trim(),
    intervalSeconds: Number(form.intervalSeconds),
    maxIterations: Number(form.maxIterations),
    metadata: form.title.trim() ? { title: form.title.trim() } : {},
  };
}

async function stopLoop(state, loop) {
  state.busyId.value = loop.id;
  try {
    await api.post(`/agents/scheduled/${encodeURIComponent(loop.id)}/cancel`, {});
    await loadLoops(state);
    addToast('Loop session stopped', 'success');
  } catch (error) {
    addToast(`Stop failed: ${error.message}`, 'error');
  } finally {
    state.busyId.value = '';
  }
}

function CreateForm({ state }) {
  const form = state.form.value;
  const set = (patch) => { state.form.value = { ...state.form.value, ...patch }; };
  return html`
    <form class="card" onsubmit=${(event) => createLoop(state, event)}>
      <div class="card-header">
        <div><h2 class="card-title" style="font-size:16px">Start a loop</h2><div class="fleet-meta">Inject the same prompt into one existing session on a bounded cadence.</div></div>
        <button class="btn btn-primary" disabled=${state.formBusy.value}>${state.formBusy.value ? 'Starting…' : 'Start loop'}</button>
      </div>
      <div class="grid grid-3" style="gap:12px">
        <label><span class="fleet-meta">Target kind</span><select class="input" value=${form.kind} onchange=${(event) => set({ kind: event.currentTarget.value })}><option value="codex">codex</option><option value="claude">claude</option><option value="pi">pi</option></select></label>
        <label><span class="fleet-meta">Session ID</span><input class="input" value=${form.sessionId} oninput=${(event) => set({ sessionId: event.currentTarget.value })} required /></label>
        <label><span class="fleet-meta">Title</span><input class="input" value=${form.title} oninput=${(event) => set({ title: event.currentTarget.value })} /></label>
        <label><span class="fleet-meta">Interval seconds</span><input class="input" type="number" min="15" max="1296000" step="1" value=${form.intervalSeconds} oninput=${(event) => set({ intervalSeconds: event.currentTarget.value })} required /></label>
        <label><span class="fleet-meta">Max iterations</span><input class="input" type="number" min="1" max="100" step="1" value=${form.maxIterations} oninput=${(event) => set({ maxIterations: event.currentTarget.value })} required /></label>
      </div>
      <label style="display:block; margin-top:12px"><span class="fleet-meta">Prompt</span><textarea class="input" rows="5" value=${form.prompt} oninput=${(event) => set({ prompt: event.currentTarget.value })} required></textarea></label>
    </form>
  `;
}

function LoopRow({ loop, state }) {
  const target = loop.targetSession || {};
  const stopped = loop.status !== 'active';
  return html`
    <tr>
      <td><a href=${`/${target.kind}/${target.sessionId}`}>${target.kind}:${target.sessionId}</a></td>
      <td title=${loop.prompt}>
        ${String(loop.prompt || '').slice(0, 80)}${String(loop.prompt || '').length > 80 ? '…' : ''}
        <details>
          <summary>Tick log (${loop.tickLog?.length || 0})</summary>
          ${(loop.tickLog || []).length ? html`<div style="overflow:auto"><table class="loop-table"><thead><tr><th>Tick</th><th>Action</th><th>Error</th></tr></thead><tbody>${loop.tickLog.map((tick) => html`<tr><td>${formatTime(tick.tickAt)}</td><td>${tick.action}</td><td>${tick.error || '—'}</td></tr>`)}</tbody></table></div>` : html`<div class="fleet-meta" style="margin-top:8px">No ticks yet.</div>`}
        </details>
      </td>
      <td>${formatInterval(loop.intervalSeconds)}</td>
      <td>${loop.currentIteration || 0}/${loop.maxIterations}</td>
      <td><span class="badge ${loop.status === 'active' ? 'badge-success' : loop.status === 'completed' ? 'badge-info' : 'badge-low'}">${loop.status}</span>${loop.stopReason ? html`<div class="fleet-meta">${loop.stopReason}</div>` : null}</td>
      <td>${formatTime(loop.nextRunAtEpochMs)}</td>
      <td><button class="btn btn-subtle" disabled=${stopped || state.busyId.value === loop.id} onclick=${() => stopLoop(state, loop)}>${state.busyId.value === loop.id ? 'Stopping…' : 'Stop'}</button></td>
    </tr>
  `;
}

export function LoopSessionsPage() {
  const loops = useMemo(() => signal([]), []);
  const loading = useMemo(() => signal(false), []);
  const error = useMemo(() => signal(''), []);
  const formBusy = useMemo(() => signal(false), []);
  const busyId = useMemo(() => signal(''), []);
  const form = useMemo(() => signal(initialForm()), []);
  const state = { loops, loading, error, formBusy, busyId, form };
  useEffect(() => { loadLoops(state); }, []);

  return html`
    <div class="page fleet-page">
      <div class="card-header"><div><h1 class="card-title" style="font-size:18px">Loop Sessions</h1><div class="fleet-meta">${loops.value.length} loops</div></div><button class="btn" onclick=${() => loadLoops(state)}>Refresh</button></div>
      <${CreateForm} state=${state} />
      ${loading.value ? html`<${LoadingState} message="Loading loop sessions…" />` : null}
      ${error.value ? html`<${ErrorState} message=${error.value} onAction=${() => loadLoops(state)} />` : null}
      ${!loading.value && loops.value.length === 0 ? html`<${EmptyState} message="No loop sessions registered." />` : html`
        <div class="card" style="overflow:auto"><table class="loop-table"><thead><tr><th>Target session</th><th>Prompt</th><th>Interval</th><th>Ticks</th><th>Status</th><th>Next run</th><th></th></tr></thead><tbody>${loops.value.map((loop) => html`<${LoopRow} key=${loop.id} loop=${loop} state=${state} />`)}</tbody></table></div>
      `}
    </div>
  `;
}
