import { h } from 'preact';
import { html } from 'htm/preact';

function stateClass(state) {
  switch (state?.toLowerCase()) {
    case 'running': return 'badge-success';
    case 'stopped':
    case 'completed': return 'badge-low';
    case 'zombie':
    case 'stale': return 'badge-medium';
    case 'error':
    case 'failed': return 'badge-critical';
    default: return 'badge-medium';
  }
}

export function ClusterCard({ cluster, onStop, onResume, onKill }) {
  return html`
    <div class="card">
      <div class="card-header">
        <span class="card-title" style="font-size:13px">${cluster.id}</span>
        <span class="badge ${stateClass(cluster.state)}">${cluster.state}</span>
      </div>
      ${cluster.summary ? html`
        <div style="font-size:12px; color:var(--text-primary); margin-top:4px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
          ${cluster.summary}
        </div>
      ` : null}
      <div style="display:flex; flex-wrap:wrap; gap:12px; font-size:12px; color:var(--text-muted); margin-top:4px">
        <span>Agents: ${cluster.agents}</span>
        <span>Tokens: ${cluster.tokens}</span>
        <span>Cost: ${cluster.cost}</span>
      </div>
      <div style="font-size:11px; color:var(--text-muted); margin-top:4px">
        ${cluster.created}
      </div>
      <div style="display:flex; gap:8px; margin-top:8px" onclick=${e => e.stopPropagation()}>
        ${cluster.state === 'running' ? html`
          <button class="btn btn-danger" onclick=${() => onStop(cluster.id)}>Stop</button>
        ` : cluster.state === 'failed' || cluster.state === 'error' ? html`
          <button class="btn" onclick=${() => onResume(cluster.id)}>Resume</button>
        ` : null}
        ${cluster.state === 'zombie' || cluster.state === 'stale' ? html`
          <button class="btn btn-danger" onclick=${() => onKill(cluster.id)}>Kill</button>
        ` : null}
      </div>
    </div>
  `;
}
