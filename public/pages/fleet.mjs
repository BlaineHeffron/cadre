import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { route } from 'preact-router';
import { api } from '../app/api.mjs';
import { subscribe } from '../app/ws-client.mjs';
import { addToast } from '../app/state.mjs';
import { ErrorState, LoadingState } from '../components/page-state.mjs';

function badgeForStatus(status = '') {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'ok' || normalized === 'resolved') return 'badge-success';
  if (normalized === 'ack') return 'badge-warning';
  if (normalized === 'degraded' || normalized === 'open') return 'badge-critical';
  if (normalized === 'unreachable') return 'badge-critical';
  return 'badge-low';
}

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

function markerChips(markers = []) {
  const safeMarkers = Array.isArray(markers) ? markers.filter(Boolean) : [];
  if (safeMarkers.length === 0) {
    return html`<span class="badge badge-success">clear</span>`;
  }
  return safeMarkers.map((marker) => html`
    <span class="badge badge-low fleet-marker">${marker}</span>
  `);
}

function formatDebugGroupTime(group = {}) {
  const value = Number(group.lastOccurredAtMs || group.firstOccurredAtMs || group.bucketMs || 0);
  return value ? formatTime(value) : 'unknown';
}

function dismissedDebugKey(deploymentId = '') {
  return `dueno_fleet_dismissed_debug_groups:${deploymentId || 'unknown'}`;
}

function loadDismissedDebugGroups(deploymentId = '') {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(dismissedDebugKey(deploymentId)) || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveDismissedDebugGroups(deploymentId = '', ids = []) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(dismissedDebugKey(deploymentId), JSON.stringify([...new Set(ids)].slice(-500)));
}

function DebugGroups({ deploymentId, debugCounts, dismissedDebugGroups, onDismiss }) {
  const dismissed = new Set(dismissedDebugGroups.value[deploymentId] || []);
  const groups = (Array.isArray(debugCounts?.debugGroups) ? debugCounts.debugGroups : [])
    .filter((group) => {
      const dismissKey = group?.dismissKey || group?.id;
      return group?.id && dismissKey && !dismissed.has(dismissKey);
    });
  if (groups.length === 0) return null;
  return html`
    <details class="fleet-debug-groups">
      <summary>
        <span>debug groups</span>
        <span class="badge badge-low">${groups.length}</span>
      </summary>
      <div class="fleet-debug-actions">
        <button
          class="btn btn-subtle fleet-debug-dismiss"
          type="button"
          onclick=${() => groups.forEach((group) => onDismiss(deploymentId, group.dismissKey || group.id))}
        >Dismiss all</button>
      </div>
      <div class="fleet-debug-group-list">
        ${groups.slice(0, 6).map((group) => html`
          <div class="fleet-debug-group">
            <div class="fleet-debug-group-head">
              <span class="badge ${badgeForStatus(group.severity)}">${group.severity || 'unknown'}</span>
              <strong>${group.errorCode || group.category || 'unknown'}</strong>
              <span class="fleet-meta">${group.count || 0}x · ${formatDebugGroupTime(group)}</span>
              <button class="btn btn-subtle fleet-debug-dismiss" type="button" onclick=${() => onDismiss(deploymentId, group.dismissKey || group.id)}>Dismiss</button>
            </div>
            <div class="fleet-meta">
              ${group.source || 'unknown'} · ${group.category || 'unknown'} · msg ${group.messageHash || 'none'}
            </div>
          </div>
        `)}
      </div>
    </details>
  `;
}

async function loadFleet(state) {
  state.loading.value = true;
  state.error.value = '';
  try {
    const [deployments, incidents] = await Promise.all([
      api.get('/fleet/deployments'),
      api.get('/fleet/incidents?status=open'),
    ]);
    state.deployments.value = deployments.deployments || [];
    state.incidents.value = incidents.incidents || [];
  } catch (error) {
    state.error.value = error.message || 'Unable to load fleet.';
    addToast(`Fleet load failed: ${error.message}`, 'error');
  } finally {
    state.loading.value = false;
  }
}

async function loadIncidents(state) {
  try {
    const payload = await api.get('/fleet/incidents?status=open');
    state.incidents.value = payload.incidents || [];
  } catch (error) {
    addToast(`Incident refresh failed: ${error.message}`, 'error');
  }
}

function applySnapshot(state, payload = {}) {
  const snapshot = payload.snapshot;
  if (!snapshot?.deploymentId) return;
  state.deployments.value = state.deployments.value.map((deployment) =>
    deployment.deploymentId === snapshot.deploymentId
      ? { ...deployment, latestSnapshot: snapshot }
      : deployment
  );
  if (payload.events?.length || payload.incident) {
    loadIncidents(state);
  }
}

async function ackIncident(state, incident) {
  state.ackBusy.value = incident.id;
  try {
    await api.post(`/fleet/incidents/${incident.id}/ack`, {});
    await loadIncidents(state);
    addToast('Incident acknowledged', 'success');
  } catch (error) {
    addToast(`Ack failed: ${error.message}`, 'error');
  } finally {
    state.ackBusy.value = '';
  }
}

async function investigateIncident(state, incident) {
  state.investigateBusy.value = incident.id;
  try {
    const result = await api.post(`/fleet/incidents/${incident.id}/investigate`, {});
    if (result.incident) {
      state.incidents.value = state.incidents.value.map((item) =>
        item.id === result.incident.id ? result.incident : item
      );
    } else {
      await loadIncidents(state);
    }
    addToast('Investigation session launched', 'success');
    if (result.backendType && result.sessionId) {
      route(`/${result.backendType}/${result.sessionId}`);
    }
  } catch (error) {
    addToast(`Investigation launch failed: ${error.message}`, 'error');
  } finally {
    state.investigateBusy.value = '';
  }
}

function FleetDeploymentCard({ deployment, dismissedDebugGroups, onDismissDebugGroup }) {
  const snapshot = deployment.latestSnapshot || {};
  const status = snapshot.status || 'unknown';
  const reachable = snapshot.reachable !== false;
  return html`
    <article class="card fleet-card" data-fleet-deployment=${deployment.deploymentId}>
      <div class="card-header">
        <div>
          <h2 class="card-title" style="font-size:16px">${deployment.displayName || deployment.deploymentId}</h2>
          <div class="fleet-meta">${deployment.deploymentId} · ${deployment.environment || 'unknown'}</div>
        </div>
        <span class="badge ${badgeForStatus(status)}">${status}</span>
      </div>
      <div class="fleet-status-row">
        <span class="badge ${reachable ? 'badge-success' : 'badge-critical'}">${reachable ? 'reachable' : 'unreachable'}</span>
        <span class="fleet-meta">last poll ${formatTime(snapshot.lastPollMs)}</span>
      </div>
      <div class="fleet-chip-row">
        ${markerChips(snapshot.markers)}
      </div>
      ${snapshot.debugCounts?.unavailable ? html`
        <div class="fleet-meta">debug ${snapshot.debugCounts.unavailable}</div>
      ` : null}
      <${DebugGroups}
        deploymentId=${deployment.deploymentId}
        debugCounts=${snapshot.debugCounts}
        dismissedDebugGroups=${dismissedDebugGroups}
        onDismiss=${onDismissDebugGroup}
      />
    </article>
  `;
}

function FleetIncidentRow({ incident, state }) {
  const isOpen = incident.status === 'open';
  return html`
    <article class="card fleet-incident" data-fleet-incident=${incident.id}>
      <div class="fleet-incident-main">
        <div>
          <div class="fleet-incident-title">
            <span class="badge ${badgeForStatus(incident.status)}">${incident.status}</span>
            <strong>${incident.deploymentId}</strong>
          </div>
          <div class="fleet-meta">
            opened ${formatTime(incident.openedAtMs)} · occurrence ${incident.occurrenceCount || 0}
          </div>
          <div class="fleet-chip-row">${markerChips(incident.markers)}</div>
        </div>
        <div class="fleet-incident-actions">
          <button
            class="btn"
            disabled=${state.ackBusy.value === incident.id || !isOpen}
            onclick=${() => ackIncident(state, incident)}
          >
            ${state.ackBusy.value === incident.id ? 'Ack...' : 'Ack'}
          </button>
          <button
            class="btn"
            disabled=${state.investigateBusy.value === incident.id || !isOpen}
            onclick=${() => investigateIncident(state, incident)}
          >
            ${state.investigateBusy.value === incident.id ? 'Launching...' : 'Investigate'}
          </button>
        </div>
      </div>
    </article>
  `;
}

export function FleetPage() {
  const deployments = useMemo(() => signal([]), []);
  const incidents = useMemo(() => signal([]), []);
  const loading = useMemo(() => signal(false), []);
  const error = useMemo(() => signal(''), []);
  const ackBusy = useMemo(() => signal(''), []);
  const investigateBusy = useMemo(() => signal(''), []);
  const dismissedDebugGroups = useMemo(() => signal({}), []);
  const state = { deployments, incidents, loading, error, ackBusy, investigateBusy };

  useEffect(() => {
    loadFleet(state);
    const unsub = subscribe('fleet:snapshot', (type, data) => {
      if (type === 'snapshot') applySnapshot(state, data);
    });
    return unsub;
  }, []);

  useEffect(() => {
    const next = {};
    for (const deployment of deployments.value) {
      const id = deployment.deploymentId;
      if (id) next[id] = loadDismissedDebugGroups(id);
    }
    dismissedDebugGroups.value = next;
  }, [deployments.value]);

  function dismissDebugGroup(deploymentId, groupId) {
    if (!deploymentId || !groupId) return;
    const existing = dismissedDebugGroups.value[deploymentId] || loadDismissedDebugGroups(deploymentId);
    const nextIds = [...new Set([...existing, groupId])];
    saveDismissedDebugGroups(deploymentId, nextIds);
    dismissedDebugGroups.value = {
      ...dismissedDebugGroups.value,
      [deploymentId]: nextIds,
    };
  }

  const openCount = incidents.value.filter((incident) => incident.status === 'open').length;

  return html`
    <div class="page fleet-page">
      <div class="card-header">
        <div>
          <h1 class="card-title" style="font-size:18px">Fleet</h1>
          <div class="fleet-meta">${deployments.value.length} deployments · ${openCount} open incidents</div>
        </div>
        <div class="fleet-incident-actions">
          <button class="btn" type="button" onclick=${() => route('/recordings')}>Recordings</button>
          <button class="btn" onclick=${() => loadFleet(state)}>Refresh</button>
        </div>
      </div>

      ${loading.value ? html`<${LoadingState} message="Loading fleet..." />` : null}
      ${error.value ? html`<${ErrorState} title="Fleet unavailable" message=${error.value} />` : null}

      <section class="fleet-section">
        <h2 class="fleet-section-title">Deployments</h2>
        ${deployments.value.length === 0 && !loading.value ? html`
          <div class="card"><p style="color:var(--text-muted)">No deployments registered.</p></div>
        ` : html`
          <div class="grid grid-2">
            ${deployments.value.map((deployment) => html`
              <${FleetDeploymentCard}
                deployment=${deployment}
                dismissedDebugGroups=${dismissedDebugGroups}
                onDismissDebugGroup=${dismissDebugGroup}
              />
            `)}
          </div>
        `}
      </section>

      <section class="fleet-section">
        <h2 class="fleet-section-title">Incidents</h2>
        ${incidents.value.length === 0 ? html`
          <div class="card"><p style="color:var(--text-muted)">No open incidents.</p></div>
        ` : html`
          <div class="fleet-incident-list">
            ${incidents.value.map((incident) => html`
              <${FleetIncidentRow} incident=${incident} state=${state} />
            `)}
          </div>
        `}
      </section>
    </div>
  `;
}
