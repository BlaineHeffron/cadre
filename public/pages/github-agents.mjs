import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo, useState } from 'preact/hooks';
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

async function loadWatches(state) {
  state.watchesError.value = '';
  try {
    const payload = await api.get('/agents/github/watches');
    state.watches.value = payload.watches || [];
  } catch (error) {
    state.watchesError.value = error.message || 'Unable to load PR watches.';
  } finally {
    state.watchesLoading.value = false;
  }
}

async function removeWatch(state, watch) {
  if (!confirm(`Remove PR watch ${watch.repo}#${watch.number}?`)) return;
  state.watchBusy.value = `${watch.repo}#${watch.number}`;
  try {
    await api.delete('/agents/github/watches', { repo: watch.repo, number: watch.number });
    await loadWatches(state);
    addToast('PR watch removed', 'success');
  } catch (error) {
    addToast(`Remove failed: ${error.message}`, 'error');
  } finally {
    state.watchBusy.value = '';
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
    await loadWatches(state);
  }
}

async function deleteRepo(state, repo) {
  if (!confirm(`Delete watched repo ${repoLabel(repo)}?`)) return;
  state.deleteBusy.value = repo.id;
  try {
    await api.delete(`/agents/github/${encodeURIComponent(repo.id)}`);
    state.repos.value = state.repos.value.filter((item) => item.id !== repo.id);
    await loadWatches(state);
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
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const { owner, repo: name, authRef, enabled, prEnabled, issueEnabled, autoReviewEnabled } = draft;
      const result = await api.post('/agents/github', {
        owner, repo: name, authRef: safeAuthRef(authRef), enabled, prEnabled, issueEnabled, autoReviewEnabled,
      });
      upsertRepoState(state, result.repo);
      setDraft(null);
      addToast('GitHub repo saved', 'success');
    } catch (error) {
      addToast(`Save failed: ${error.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }
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
      ${draft ? html`
        <form onsubmit=${save}>
          <${RepoFields} form=${draft} setForm=${(patch) => setDraft({ ...draft, ...patch })} readOnly=${true} />
          <div class="fleet-incident-actions" style="margin-top:12px">
            <button class="btn" disabled=${busy}>${busy ? 'Saving...' : 'Save'}</button>
            <button type="button" class="btn btn-subtle" disabled=${busy} onclick=${() => setDraft(null)}>Cancel</button>
          </div>
        </form>
      ` : html`<div class="fleet-chip-row">
        <span class="badge ${repo.prEnabled ? 'badge-info' : 'badge-low'}">PRs ${repo.prEnabled ? 'on' : 'off'}</span>
        <span class="badge ${repo.issueEnabled ? 'badge-info' : 'badge-low'}">Issues ${repo.issueEnabled ? 'on' : 'off'}</span>
        <span class="badge ${repo.autoReviewEnabled ? 'badge-warning' : 'badge-low'}">Auto review ${repo.autoReviewEnabled ? 'on' : 'off'}</span>
      </div>`}
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
        ${!draft ? html`<button class="btn btn-subtle" onclick=${() => setDraft({ ...repo })}>Edit</button>` : null}
        <button class="btn btn-subtle" disabled=${busy || state.deleteBusy.value === repo.id} onclick=${() => deleteRepo(state, repo)}>
          ${state.deleteBusy.value === repo.id ? 'Deleting...' : 'Delete'}
        </button>
      </div>
    </article>
  `;
}

function RepoFields({ form, setForm, readOnly = false }) {
  return html`<div>
      <div class="grid grid-3" style="gap:12px">
        <label>
          <span class="fleet-meta">Owner</span>
          <input class="input" readOnly=${readOnly} value=${form.owner} oninput=${(event) => setForm({ owner: event.currentTarget.value })} required />
        </label>
        <label>
          <span class="fleet-meta">Repo</span>
          <input class="input" readOnly=${readOnly} value=${form.repo} oninput=${(event) => setForm({ repo: event.currentTarget.value })} required />
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
  </div>`;
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
      <${RepoFields} form=${form} setForm=${setForm} />
    </form>
  `;
}

export function GitHubAgentsPage() {
  const watches = useMemo(() => signal([]), []);
  const watchesError = useMemo(() => signal(''), []);
  const watchesLoading = useMemo(() => signal(true), []);
  const watchBusy = useMemo(() => signal(''), []);
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
  const state = { watches, watchesError, watchesLoading, watchBusy, repos, enabled, loading, error, formBusy, pollBusy, deleteBusy, form };

  useEffect(() => {
    loadRepos(state);
    loadWatches(state);
    const unsub = subscribe('github:agents', (type, data) => {
      if (type === 'snapshot') applySnapshot(state, data);
      loadWatches(state);
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
          <button class="btn" onclick=${() => { loadRepos(state); loadWatches(state); }}>Refresh</button>
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
            ${repos.value.map((repo) => html`<${GitHubRepoCard} key=${repo.id} repo=${repo} state=${state} />`)}
          </div>
        `}
      </section>
      <section class="fleet-section">
        <h2 class="fleet-section-title">PR watches</h2>
        <p class="fleet-meta">Only agents can create PR watches with watch_pr.</p>
        ${watchesLoading.value ? html`<${LoadingState} message="Loading PR watches..." />` :
          watchesError.value ? html`<${ErrorState} message=${watchesError.value} onAction=${() => loadWatches(state)} />` :
          watches.value.length === 0 ? html`<${EmptyState} message="No PR watches." />` :
          watches.value.map((watch) => html`
            <article class="card" key=${`${watch.repo}#${watch.number}`} data-pr-watch=${`${watch.repo}#${watch.number}`}>
              <div class="card-header">
                <a href=${`https://github.com/${watch.repo}/pull/${watch.number}`} target="_blank" rel="noopener noreferrer">${watch.repo}#${watch.number}</a>
                <button class="btn btn-subtle" disabled=${state.watchBusy.value === `${watch.repo}#${watch.number}`} onclick=${() => removeWatch(state, watch)}>Remove</button>
              </div>
              <div class="fleet-meta">
                ${watch.thread_id ? html`room <a href=${`/collab/${encodeURIComponent(watch.thread_id)}`}>${watch.thread_id}</a> · ` : null}
                creator ${watch.creator?.kind}:${watch.creator?.sessionId} · created ${formatTime(watch.createdAtMs)} · mergeable ${watch.mergeableState || 'unknown'}
              </div>
            </article>
          `)}
      </section>
    </div>
  `;
}
