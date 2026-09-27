import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { api } from '../app/api.mjs';
import { subscribe } from '../app/ws-client.mjs';
import { addToast } from '../app/state.mjs';
import { EmptyState, ErrorState, LoadingState } from '../components/page-state.mjs';

function formatTime(ms) {
  const value = Number(ms || 0);
  if (!value) return 'never';
  const diff = Date.now() - value;
  if (diff < 0) return new Date(value).toLocaleString();
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return new Date(value).toLocaleString();
}

function badgeClass(value = '') {
  const text = String(value || '').toLowerCase();
  if (!text || text === 'no_new_items' || text === 'baseline') return 'badge-low';
  if (text.includes('error') || text.includes('unauthorized') || text.includes('not_found')) return 'badge-critical';
  if (text.includes('spawned') || text.includes('new_items')) return 'badge-success';
  return 'badge-info';
}

function repoLabel(repo) {
  return `${repo.owner}/${repo.repo}`;
}

function safeAuthRef(value = '') {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '');
}

async function loadRepos(state) {
  state.loading.value = true;
  state.error.value = '';
  try {
    const payload = await api.get('/agents/github');
    state.enabled.value = payload.enabled === true;
    state.repos.value = payload.repos || [];
  } catch (error) {
    state.error.value = error.message || 'Unable to load GitHub agents.';
    addToast(`GitHub agents load failed: ${error.message}`, 'error');
  } finally {
    state.loading.value = false;
  }
}

function upsertRepoState(state, repo) {
  if (!repo?.id) return;
  const next = state.repos.value.slice();
  const idx = next.findIndex((item) => item.id === repo.id);
  if (idx === -1) next.push(repo);
  else next[idx] = { ...next[idx], ...repo };
  state.repos.value = next.sort((a, b) => a.id.localeCompare(b.id));
}

function applySnapshot(state, snapshot = {}) {
  const repo = snapshot.repo;
  if (repo?.id) upsertRepoState(state, repo);
}

async function addRepo(state, event) {
  event.preventDefault();
  state.formBusy.value = true;
  try {
    const form = state.form.value;
    const payload = {
      owner: form.owner.trim(),
      repo: form.repo.trim(),
      authRef: safeAuthRef(form.authRef),
      enabled: form.enabled,
      prEnabled: form.prEnabled,
      issueEnabled: form.issueEnabled,
      autoReviewEnabled: form.autoReviewEnabled,
    };
    const result = await api.post('/agents/github', payload);
    upsertRepoState(state, result.repo);
    state.form.value = { ...form, owner: '', repo: '', authRef: '' };
    addToast('GitHub repo saved', 'success');
  } catch (error) {
    addToast(`Save failed: ${error.message}`, 'error');
  } finally {
    state.formBusy.value = false;
  }
}

async function pollNow(state, id = '') {
  state.pollBusy.value = id || '__all__';
  try {
    const result = await api.post('/agents/github/poll-now', id ? { id } : {});
    if (result.enabled === false) {
      addToast('GitHub poller disabled', 'info');
      return;
    }
    for (const item of result.results || []) {
      if (item.repo) upsertRepoState(state, item.repo);
    }
    addToast(id ? 'Repo polled' : 'GitHub repos polled', 'success');
  } catch (error) {
    addToast(`Poll failed: ${error.message}`, 'error');
  } finally {
    state.pollBusy.value = '';
  }
}

async function deleteRepo(state, repo) {
  state.deleteBusy.value = repo.id;
  try {
    await api.delete(`/agents/github/${encodeURIComponent(repo.id)}`);
    state.repos.value = state.repos.value.filter((item) => item.id !== repo.id);
    addToast('GitHub repo removed', 'success');
  } catch (error) {
    addToast(`Delete failed: ${error.message}`, 'error');
  } finally {
    state.deleteBusy.value = '';
  }
}

function Toggle({ checked, label, onChange }) {
  return html`
    <label class="fleet-meta" style="display:flex; gap:6px; align-items:center">
      <input type="checkbox" checked=${checked} onchange=${(event) => onChange(event.currentTarget.checked)} />
      ${label}
    </label>
  `;
}

function GitHubRepoCard({ repo, state }) {
  const sessionHref = repo.lastSpawnSessionId ? `/agents` : '';
  return html`
    <article class="card fleet-card" data-github-repo=${repo.id}>
      <div class="card-header">
        <div>
          <h2 class="card-title" style="font-size:16px">${repoLabel(repo)}</h2>
          <div class="fleet-meta">auth ref ${repo.authRef || 'none'} · last poll ${formatTime(repo.lastPollMs)}</div>
        </div>
        <span class="badge ${repo.enabled ? 'badge-success' : 'badge-low'}">${repo.enabled ? 'enabled' : 'disabled'}</span>
      </div>
      <div class="fleet-chip-row">
        <span class="badge ${repo.prEnabled ? 'badge-info' : 'badge-low'}">PRs ${repo.prEnabled ? 'on' : 'off'}</span>
        <span class="badge ${repo.issueEnabled ? 'badge-info' : 'badge-low'}">Issues ${repo.issueEnabled ? 'on' : 'off'}</span>
        <span class="badge ${repo.autoReviewEnabled ? 'badge-warning' : 'badge-low'}">Auto review ${repo.autoReviewEnabled ? 'on' : 'off'}</span>
      </div>
      <div class="fleet-status-row">
        <span class="badge ${badgeClass(repo.lastEvent)}">${repo.lastEvent || 'idle'}</span>
        ${repo.lastError ? html`<span class="badge badge-critical">${repo.lastError}</span>` : null}
      </div>
      <div class="fleet-meta">
        last PR #${repo.lastSeenPrNumber || 0} · last issue #${repo.lastSeenIssueNumber || 0}
        ${repo.lastSpawnSessionId ? html`
          · session <a href=${sessionHref}>${repo.lastSpawnSessionId}</a>
        ` : null}
      </div>
      <div class="fleet-incident-actions" style="margin-top:12px">
        <button class="btn" disabled=${state.pollBusy.value === repo.id || !state.enabled.value} onclick=${() => pollNow(state, repo.id)}>
          ${state.pollBusy.value === repo.id ? 'Polling...' : 'Poll now'}
        </button>
        <button class="btn btn-subtle" disabled=${state.deleteBusy.value === repo.id} onclick=${() => deleteRepo(state, repo)}>
          ${state.deleteBusy.value === repo.id ? 'Deleting...' : 'Delete'}
        </button>
      </div>
    </article>
  `;
}

function AddRepoForm({ state }) {
  const form = state.form.value;
  const setForm = (patch) => {
    state.form.value = { ...state.form.value, ...patch };
  };
  return html`
    <form class="card" onsubmit=${(event) => addRepo(state, event)}>
      <div class="card-header">
        <div>
          <h2 class="card-title" style="font-size:16px">Add watched repo</h2>
          <div class="fleet-meta">authRef is an env var name. No tokens here.</div>
        </div>
        <button class="btn" disabled=${state.formBusy.value}>
          ${state.formBusy.value ? 'Saving...' : 'Save'}
        </button>
      </div>
      <div class="grid grid-3" style="gap:12px">
        <label>
          <span class="fleet-meta">Owner</span>
          <input class="input" value=${form.owner} oninput=${(event) => setForm({ owner: event.currentTarget.value })} required />
        </label>
        <label>
          <span class="fleet-meta">Repo</span>
          <input class="input" value=${form.repo} oninput=${(event) => setForm({ repo: event.currentTarget.value })} required />
        </label>
        <label>
          <span class="fleet-meta">Auth ref</span>
          <input class="input" value=${form.authRef} oninput=${(event) => setForm({ authRef: safeAuthRef(event.currentTarget.value) })} placeholder="GITHUB_AGENT_TOKEN_REF" required />
        </label>
      </div>
      <div class="fleet-chip-row" style="margin-top:12px">
        <${Toggle} checked=${form.enabled} label="Enabled" onChange=${(value) => setForm({ enabled: value })} />
        <${Toggle} checked=${form.prEnabled} label="PRs" onChange=${(value) => setForm({ prEnabled: value })} />
        <${Toggle} checked=${form.issueEnabled} label="Issues" onChange=${(value) => setForm({ issueEnabled: value })} />
        <${Toggle} checked=${form.autoReviewEnabled} label="Auto review" onChange=${(value) => setForm({ autoReviewEnabled: value })} />
      </div>
    </form>
  `;
}

export function GitHubAgentsPage() {
  const repos = useMemo(() => signal([]), []);
  const enabled = useMemo(() => signal(false), []);
  const loading = useMemo(() => signal(false), []);
  const error = useMemo(() => signal(''), []);
  const formBusy = useMemo(() => signal(false), []);
  const pollBusy = useMemo(() => signal(''), []);
  const deleteBusy = useMemo(() => signal(''), []);
  const form = useMemo(() => signal({
    owner: '',
    repo: '',
    authRef: '',
    enabled: true,
    prEnabled: true,
    issueEnabled: true,
    autoReviewEnabled: true,
  }), []);
  const state = { repos, enabled, loading, error, formBusy, pollBusy, deleteBusy, form };

  useEffect(() => {
    loadRepos(state);
    const unsub = subscribe('github:agents', (type, data) => {
      if (type === 'snapshot') applySnapshot(state, data);
    });
    return unsub;
  }, []);

  return html`
    <div class="page fleet-page">
      <div class="card-header">
        <div>
          <h1 class="card-title" style="font-size:18px">GitHub</h1>
          <div class="fleet-meta">${repos.value.length} watched repos</div>
        </div>
        <div class="fleet-incident-actions">
          <button class="btn" disabled=${pollBusy.value === '__all__' || !enabled.value} onclick=${() => pollNow(state)}>
            ${pollBusy.value === '__all__' ? 'Polling...' : 'Poll all'}
          </button>
          <button class="btn" onclick=${() => loadRepos(state)}>Refresh</button>
        </div>
      </div>

      ${!enabled.value ? html`
        <div class="card" role="status">
          <span class="badge badge-warning">poller disabled</span>
          <span class="fleet-meta" style="margin-left:8px">GitHub polling and poll-now are off in config.</span>
        </div>
      ` : null}
      ${loading.value ? html`<${LoadingState} message="Loading GitHub agents..." />` : null}
      ${error.value ? html`<${ErrorState} message=${error.value} onAction=${() => loadRepos(state)} />` : null}

      <${AddRepoForm} state=${state} />

      <section class="fleet-section">
        <h2 class="fleet-section-title">Watched repos</h2>
        ${repos.value.length === 0 && !loading.value ? html`
          <${EmptyState} message="No GitHub repos watched yet." />
        ` : html`
          <div class="grid grid-2">
            ${repos.value.map((repo) => html`<${GitHubRepoCard} repo=${repo} state=${state} />`)}
          </div>
        `}
      </section>
    </div>
  `;
}
