import { h } from 'preact';
import { html } from 'htm/preact';

const FILE_ICONS = {
  dir: '\u{1F4C1}',
  '.mjs': '\u{1F7E1}',
  '.js': '\u{1F7E1}',
  '.ts': '\u{1F535}',
  '.json': '\u{1F7E2}',
  '.md': '\u{1F4DD}',
  '.sh': '\u{2699}',
  '.css': '\u{1F3A8}',
  '.html': '\u{1F310}',
  default: '\u{1F4C4}',
};

function getIcon(item) {
  if (item.type === 'dir') return FILE_ICONS.dir;
  return FILE_ICONS[item.extension] || FILE_ICONS.default;
}

function formatDate(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function FileList({ items, onNavigate, onSelectFile }) {
  if (!items || items.length === 0) {
    return html`<p style="color:var(--text-muted); padding:16px">Empty directory</p>`;
  }

  return html`
    <div style="display:flex; flex-direction:column">
      ${items.map(item => html`
        <div
          key=${item.name}
          class="file-row"
          style="display:flex; align-items:center; padding:8px 12px; border-bottom:1px solid var(--border); cursor:pointer; transition:background 0.1s"
          onMouseOver=${e => { e.currentTarget.style.background = 'var(--bg-secondary)'; }}
          onMouseOut=${e => { e.currentTarget.style.background = 'transparent'; }}
          onclick=${() => item.type === 'dir' ? onNavigate(item.name) : onSelectFile(item)}
        >
          <span style="width:24px; text-align:center; margin-right:8px; font-size:16px">${getIcon(item)}</span>
          <span style="flex:1; font-family:var(--font-mono); font-size:13px; ${item.type === 'dir' ? 'font-weight:600' : ''}">${item.name}</span>
          <span style="width:80px; text-align:right; font-size:11px; color:var(--text-muted); font-family:var(--font-mono)">
            ${item.type === 'file' ? (item.sizeFormatted || '') : ''}
          </span>
          <span style="width:140px; text-align:right; font-size:11px; color:var(--text-muted)">
            ${formatDate(item.modified)}
          </span>
        </div>
      `)}
    </div>
  `;
}
