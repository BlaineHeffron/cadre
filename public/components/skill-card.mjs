import { h } from 'preact';
import { html } from 'htm/preact';

function locationBadge(location) {
  switch (location) {
    case 'user': return html`<span class="badge badge-low">User</span>`;
    case 'project': return html`<span class="badge badge-medium">Project</span>`;
    default: return html`<span class="badge badge-low">${location}</span>`;
  }
}

export function SkillCard({ skill, onSelect }) {
  return html`
    <div class="card" style="cursor:pointer" onclick=${() => onSelect(skill)}>
      <div class="card-header">
        <span class="card-title" style="font-family:var(--font-mono)">/${skill.name}</span>
        ${locationBadge(skill.location)}
      </div>
      <p style="font-size:12px; color:var(--text-secondary); margin-bottom:8px; line-height:1.4">
        ${skill.description || 'No description'}
      </p>
      <div style="display:flex; gap:8px; font-size:11px; color:var(--text-muted)">
        ${skill.project ? html`<span>Project: ${skill.project}</span>` : null}
        ${skill.size ? html`<span>${skill.size} bytes</span>` : null}
      </div>
    </div>
  `;
}
