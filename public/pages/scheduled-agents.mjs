import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { api } from '../app/api.mjs';
import { addToast } from '../app/state.mjs';
import { EmptyState, ErrorState, LoadingState } from '../components/page-state.mjs';
import { McpCapabilitySelector } from '../components/mcp-capability-selector.mjs';

const DEFAULT_FORM = {
  id: '',
  workDir: '',
  provider: 'codex',
  model: '',
  intervalHours: '24',
  maxIterations: '0',
  startImmediately: false,
  prompt: '',
  mcpProfile: 'default',
  mcpServers: { add: [], remove: [] },
};

function formatTime(ms) {
  const value = Number(ms || 0);
  if (!value) return 'never';
  return new Date(value).toLocaleString();
}

function formatInterval(seconds) {
  const value = Number(seconds || 0);
  if (!value) return 'manual';
  if (value % 86400 === 0) return `${value / 86400}d`;
  if (value % 3600 === 0) return `${value / 3600}h`;
  if (value % 60 === 0) return `${value / 60}m`;
  return `${value}s`;
}

function statusBadge(status = '') {
  const text = String(status || '').toLowerCase();
  if (text === 'active') return 'badge-success';
  if (text === 'completed') return 'badge-info';
  if (text === 'canceled') return 'badge-low';
  return 'badge-warning';
}

function normalizeIntervalHours(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return 24;
  return Math.max(15 / 3600, Math.min(hours, 360));
}

async function loadTasks(state) {
  state.loading.value = true;
  state.error.value = '';
  try {
    const payload = await api.get('/agents/scheduled');
    state.tasks.value = Array.isArray(payload?.tasks) ? payload.tasks : [];
  } catch (error) {
    state.error.value = error.message || 'Unable to load scheduled agents.';
    addToast(`Scheduled agents load failed: ${error.message}`, 'error');
  } finally {
    state.loading.value = false;
  }
}

export function taskInputFromForm(form) {
  const intervalHours = normalizeIntervalHours(form.intervalHours);
  const input = {
    workDir: form.workDir.trim(),
    prompt: form.prompt.trim(),
    provider: form.provider.trim() || 'codex',
    intervalSeconds: Math.round(intervalHours * 3600),
    maxIterations: Math.max(0, Number.parseInt(form.maxIterations || '0', 10) || 0),
    startImmediately: form.startImmediately === true,
  };
  if (form.id.trim()) input.id = form.id.trim();
  if (form.model.trim()) input.model = form.model.trim();
  input.mcpProfile = form.mcpProfile || 'default';
  input.mcpServers = form.mcpServers || { add: [], remove: [] };
  return input;
}

async function saveTask(state, event) {
  event.preventDefault();
  state.formBusy.value = true;
  try {
    const input = taskInputFromForm(state.form.value);
    if (!input.workDir || !input.prompt) throw new Error('Workdir and prompt are required.');
    await api.post('/agents/scheduled', input);
    state.form.value = { ...DEFAULT_FORM, workDir: state.form.value.workDir };
    await loadTasks(state);
    addToast('Scheduled agent saved', 'success');
  } catch (error) {
    addToast(`Save failed: ${error.message}`, 'error');
  } finally {
    state.formBusy.value = false;
  }
}

async function cancelTask(state, task) {
  state.busyTask.value = task.id;
  try {
    await api.post(`/agents/scheduled/${encodeURIComponent(task.id)}/cancel`, {});
    await loadTasks(state);
    addToast('Scheduled agent canceled', 'success');
  } catch (error) {
    addToast(`Cancel failed: ${error.message}`, 'error');
  } finally {
    state.busyTask.value = '';
  }
}

async function runTaskNow(state, task) {
  state.busyTask.value = task.id;
  try {
    await api.post('/agents/scheduled', {
      ...task,
      status: 'active',
      nextRunAtEpochMs: Date.now(),
      startImmediately: true,
    });
    const result = await api.post('/agents/scheduled/step-now', {});
    await loadTasks(state);
    addToast(result.spawned ? 'Scheduled agent spawned' : 'Scheduled agent tick complete', 'success');
  } catch (error) {
    addToast(`Run failed: ${error.message}`, 'error');
  } finally {
    state.busyTask.value = '';
  }
}

async function stepNow(state) {
  state.stepBusy.value = true;
  try {
    const result = await api.post('/agents/scheduled/step-now', {});
    await loadTasks(state);
    addToast(`Tick complete: ${result.spawned || 0} spawned, ${result.skippedRunning || 0} skipped`, 'success');
  } catch (error) {
    addToast(`Tick failed: ${error.message}`, 'error');
  } finally {
    state.stepBusy.value = false;
  }
}

function TaskCard({ task, state }) {
  const active = task.status === 'active';
  const cancelable = task.status !== 'canceled';
  const busy = state.busyTask.value === task.id;
  return html`
    <article class="card fleet-card">
      <div class="card-header">
        <div>
          <h2 class="card-title" style="font-size:16px">${task.id}</h2>
          <div class="fleet-meta">${task.provider || 'codex'}${task.model ? ` / ${task.model}` : ''} · every ${formatInterval(task.intervalSeconds)}</div>
        </div>
        <span class="badge ${statusBadge(task.status)}">${task.status}</span>
      </div>
      <div class="fleet-meta">workdir ${task.workDir}</div>
      <div class="fleet-meta">next ${formatTime(task.nextRunAtEpochMs)} · iteration ${task.currentIteration || 0}${task.maxIterations ? `/${task.maxIterations}` : ''}</div>
      ${task.lastSessionId ? html`<div class="fleet-meta">last session <a href="/agents">${task.lastSessionId}</a></div>` : null}
      <pre class="terminal" style="max-height:180px; margin-top:12px">${task.prompt}</pre>
      <div class="fleet-incident-actions" style="margin-top:12px">
        <button class="btn" disabled=${busy} onclick=${() => runTaskNow(state, task)}>
          ${busy ? 'Running...' : 'Run now'}
        </button>
        <button class="btn btn-subtle" disabled=${busy || !cancelable} onclick=${() => cancelTask(state, task)}>
          ${busy ? 'Canceling...' : 'Cancel'}
        </button>
      </div>
    </article>
  `;
}

function AddTaskForm({ state }) {
  const form = state.form.value;
  const setForm = (patch) => { state.form.value = { ...state.form.value, ...patch }; };
  return html`
    <form class="card" onsubmit=${(event) => saveTask(state, event)}>
      <div class="card-header">
        <div>
          <h2 class="card-title" style="font-size:16px">Add scheduled agent</h2>
          <div class="fleet-meta">Fresh session each run. No external sends unless the prompt explicitly asks and you approve inside the session.</div>
        </div>
        <button class="btn" disabled=${state.formBusy.value}>
          ${state.formBusy.value ? 'Saving...' : 'Save'}
        </button>
      </div>
      <div class="grid grid-3" style="gap:12px">
        <label>
          <span class="fleet-meta">ID</span>
          <input class="input" value=${form.id} placeholder="optional" oninput=${(event) => setForm({ id: event.currentTarget.value })} />
        </label>
        <label>
          <span class="fleet-meta">Provider</span>
          <select class="input" value=${form.provider} onchange=${(event) => setForm({ provider: event.currentTarget.value })}>
            <option value="codex">codex</option>
            <option value="claude">claude</option>
          </select>
        </label>
        <label>
          <span class="fleet-meta">Model</span>
          <input class="input" value=${form.model} placeholder="default" oninput=${(event) => setForm({ model: event.currentTarget.value })} />
        </label>
        <label>
          <span class="fleet-meta">Interval hours</span>
          <input class="input" type="number" min="0.0042" max="360" step="0.25" value=${form.intervalHours} oninput=${(event) => setForm({ intervalHours: event.currentTarget.value })} required />
        </label>
        <label>
          <span class="fleet-meta">Max runs</span>
          <input class="input" type="number" min="0" step="1" value=${form.maxIterations} oninput=${(event) => setForm({ maxIterations: event.currentTarget.value })} />
        </label>
        <label class="fleet-meta" style="display:flex; gap:8px; align-items:end; padding-bottom:8px">
          <input type="checkbox" checked=${form.startImmediately} onchange=${(event) => setForm({ startImmediately: event.currentTarget.checked })} />
          start immediately
        </label>
      </div>
      <label style="display:block; margin-top:12px">
        <span class="fleet-meta">Workdir</span>
        <input class="input" value=${form.workDir} placeholder="/path/to/project" oninput=${(event) => setForm({ workDir: event.currentTarget.value })} required />
      </label>
      <label style="display:block; margin-top:12px">
        <span class="fleet-meta">Prompt</span>
        <textarea class="input" rows="8" value=${form.prompt} oninput=${(event) => setForm({ prompt: event.currentTarget.value })} required></textarea>
      </label>
      <${McpCapabilitySelector}
        provider=${form.provider}
        value=${form}
        title="MCP capabilities for scheduled agent"
        onChange=${(selection) => setForm(selection)} />
    </form>
  `;
}

export function ScheduledAgentsPage() {
  const tasks = useMemo(() => signal([]), []);
  const loading = useMemo(() => signal(false), []);
  const error = useMemo(() => signal(''), []);
  const formBusy = useMemo(() => signal(false), []);
  const stepBusy = useMemo(() => signal(false), []);
  const busyTask = useMemo(() => signal(''), []);
  const form = useMemo(() => signal({ ...DEFAULT_FORM }), []);
  const state = { tasks, loading, error, formBusy, stepBusy, busyTask, form };

  useEffect(() => { loadTasks(state); }, []);

  return html`
    <div class="page fleet-page">
      <div class="card-header">
        <div>
          <h1 class="card-title" style="font-size:18px">Scheduled Agents</h1>
          <div class="fleet-meta">${tasks.value.length} registered tasks</div>
        </div>
        <div class="fleet-incident-actions">
          <button class="btn" disabled=${stepBusy.value} onclick=${() => stepNow(state)}>
            ${stepBusy.value ? 'Ticking...' : 'Step due now'}
          </button>
          <button class="btn" onclick=${() => loadTasks(state)}>Refresh</button>
        </div>
      </div>

      ${loading.value ? html`<${LoadingState} message="Loading scheduled agents..." />` : null}
      ${error.value ? html`<${ErrorState} message=${error.value} onAction=${() => loadTasks(state)} />` : null}

      <${AddTaskForm} state=${state} />

      <section class="fleet-section">
        <h2 class="fleet-section-title">Registered tasks</h2>
        ${tasks.value.length === 0 && !loading.value ? html`
          <${EmptyState} message="No scheduled agents registered yet." />
        ` : html`
          <div class="grid grid-2">
            ${tasks.value.map((task) => html`<${TaskCard} task=${task} state=${state} />`)}
          </div>
        `}
      </section>
    </div>
  `;
}
