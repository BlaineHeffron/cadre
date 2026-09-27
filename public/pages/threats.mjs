import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { api } from '../app/api.mjs';
import { subscribe } from '../app/ws-client.mjs';
import { alerts as globalAlerts, addToast } from '../app/state.mjs';
import { ThreatCard } from '../components/threat-card.mjs';

async function loadAlerts(loading, filterSeverity, filterCategory) {
  loading.value = true;
  try {
    let path = '/threats/alerts?limit=100';
    if (filterSeverity.value) path += `&severity=${filterSeverity.value}`;
    if (filterCategory.value) path += `&category=${filterCategory.value}`;
    const data = await api.get(path);
    globalAlerts.value = data.alerts;
  } catch (e) {
    addToast(`Failed to load alerts: ${e.message}`, 'error');
  } finally {
    loading.value = false;
  }
}

async function acknowledgeAlert(id) {
  try {
    await api.post(`/threats/alerts/${id}/ack`);
    globalAlerts.value = globalAlerts.value.map(a =>
      a.id === id ? { ...a, acknowledged: true } : a
    );
  } catch (e) {
    addToast(`Failed to acknowledge: ${e.message}`, 'error');
  }
}

export function ThreatsPage() {
  const loading = useMemo(() => signal(false), []);
  const filterSeverity = useMemo(() => signal(''), []);
  const filterCategory = useMemo(() => signal(''), []);

  useEffect(() => {
    loadAlerts(loading, filterSeverity, filterCategory);

    // Subscribe to live alerts
    const unsub = subscribe('threats', (type, data) => {
      if (type === 'alert') {
        globalAlerts.value = [data, ...globalAlerts.value].slice(0, 200);
      }
    });

    return unsub;
  }, []);

  return html`
    <div class="page">
      <div class="card-header">
        <h1 class="card-title" style="font-size:18px">Threat Alerts</h1>
        <div style="display:flex; gap:8px; align-items:center">
          <select
            value=${filterSeverity.value}
            onChange=${e => { filterSeverity.value = e.target.value; loadAlerts(loading, filterSeverity, filterCategory); }}
            style="padding:6px; background:var(--bg-input); border:1px solid var(--border); border-radius:var(--radius); color:var(--text-primary)"
          >
            <option value="">All Severities</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
          <select
            value=${filterCategory.value}
            onChange=${e => { filterCategory.value = e.target.value; loadAlerts(loading, filterSeverity, filterCategory); }}
            style="padding:6px; background:var(--bg-input); border:1px solid var(--border); border-radius:var(--radius); color:var(--text-primary)"
          >
            <option value="">All Categories</option>
            <option value="auth">Auth</option>
            <option value="network">Network</option>
            <option value="process">Process</option>
            <option value="integrity">Integrity</option>
          </select>
          <button class="btn" onclick=${() => loadAlerts(loading, filterSeverity, filterCategory)}>Refresh</button>
        </div>
      </div>

      ${loading.value
        ? html`<p>Loading alerts...</p>`
        : globalAlerts.value.length === 0
          ? html`<div class="card"><p style="color:var(--text-muted)">No alerts</p></div>`
          : globalAlerts.value.map(a => html`
            <${ThreatCard} alert=${a} onAck=${acknowledgeAlert} />
          `)
      }
    </div>
  `;
}
