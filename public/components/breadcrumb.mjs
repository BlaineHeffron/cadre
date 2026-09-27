import { h } from 'preact';
import { html } from 'htm/preact';

export function Breadcrumb({ path, onNavigate }) {
  const parts = path ? path.split('/').filter(Boolean) : [];

  function navigateTo(index) {
    if (index < 0) {
      onNavigate('');
    } else {
      onNavigate(parts.slice(0, index + 1).join('/'));
    }
  }

  return html`
    <div style="display:flex; align-items:center; gap:4px; font-size:13px; font-family:var(--font-mono); flex-wrap:wrap">
      <span
        style="cursor:pointer; color:var(--accent); padding:2px 4px; border-radius:4px"
        onclick=${() => navigateTo(-1)}
        onMouseOver=${e => { e.target.style.background = 'var(--bg-secondary)'; }}
        onMouseOut=${e => { e.target.style.background = 'transparent'; }}
      >root</span>
      ${parts.map((part, i) => html`
        <span style="color:var(--text-muted)">/</span>
        <span
          style="cursor:pointer; color:${i === parts.length - 1 ? 'var(--text-primary)' : 'var(--accent)'}; padding:2px 4px; border-radius:4px; ${i === parts.length - 1 ? 'font-weight:600' : ''}"
          onclick=${() => navigateTo(i)}
          onMouseOver=${e => { e.target.style.background = 'var(--bg-secondary)'; }}
          onMouseOut=${e => { e.target.style.background = 'transparent'; }}
        >${part}</span>
      `)}
    </div>
  `;
}
