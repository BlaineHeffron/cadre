import { h } from 'preact';
import { html } from 'htm/preact';

// Short label: last two path segments (e.g. /home/user/projects/x → projects/x).
function shortLabel(path) {
  const parts = String(path || '').replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return parts.slice(-2).join('/');
}

// One-tap quick-select chips for a work directory: a default chip (empty value)
// followed by recent dirs from prior spawns. `value` is the current selection
// ('' === default). onSelect(path) is called with the chosen path.
export function DirQuickSelect({ value = '', recents = [], onSelect, defaultLabel = 'Fleet (default)' }) {
  const selected = String(value || '').trim();
  return html`
    <div class="dir-quick-select" role="group" aria-label="Quick work directory select">
      <button
        type="button"
        class="dir-chip ${selected === '' ? 'dir-chip-active' : ''}"
        aria-pressed=${selected === '' ? 'true' : 'false'}
        onclick=${() => onSelect && onSelect('')}
      >${defaultLabel}</button>
      ${recents.map((path) => html`
        <button
          type="button"
          key=${path}
          class="dir-chip ${selected === path ? 'dir-chip-active' : ''}"
          aria-pressed=${selected === path ? 'true' : 'false'}
          title=${path}
          onclick=${() => onSelect && onSelect(path)}
        >${shortLabel(path)}</button>
      `)}
    </div>
  `;
}
