import { h } from 'preact';
import { html } from 'htm/preact';

export function ThreatCard({ alert, onAck }) {
  const timeAgo = formatTimeAgo(alert.timestamp);

  return html`
    <div class="card" style="opacity:${alert.acknowledged ? 0.6 : 1}">
      <div class="card-header">
        <div style="display:flex; align-items:center; gap:8px">
          <span class="badge badge-${alert.severity}">${alert.severity}</span>
          <span class="badge badge-low">${alert.category}</span>
        </div>
        <span style="font-size:11px; color:var(--text-muted)">${timeAgo}</span>
      </div>
      <p style="margin:8px 0; font-size:13px">${alert.message}</p>
      ${alert.details ? html`
        <details style="margin-top:4px">
          <summary style="cursor:pointer; font-size:12px; color:var(--text-muted)">Details</summary>
          <pre style="font-size:11px; margin-top:4px; padding:8px; background:var(--bg-primary); border-radius:var(--radius); overflow-x:auto">${JSON.stringify(alert.details, null, 2)}</pre>
        </details>
      ` : null}
      ${!alert.acknowledged ? html`
        <button class="btn" style="margin-top:8px; font-size:12px" onclick=${() => onAck(alert.id)}>Acknowledge</button>
      ` : null}
    </div>
  `;
}

function formatTimeAgo(timestamp) {
  const diff = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
