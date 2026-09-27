import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { api } from '../app/api.mjs';

export function FolderPicker({ onSelect, onCancel }) {
  const currentPath = useMemo(() => signal(''), []);
  const items = useMemo(() => signal([]), []);
  const root = useMemo(() => signal(''), []);
  const loading = useMemo(() => signal(false), []);
  const error = useMemo(() => signal(''), []);

  async function browse(relPath) {
    loading.value = true;
    error.value = '';
    try {
      const query = relPath ? `?path=${encodeURIComponent(relPath)}` : '';
      const data = await api.get(`/files/browse${query}`);
      currentPath.value = data.path || '';
      root.value = data.root;
      items.value = data.items.filter(i => i.type === 'dir');
    } catch (e) {
      error.value = e.message;
    } finally {
      loading.value = false;
    }
  }

  useEffect(() => { browse(''); }, []);

  function openDir(name) {
    const next = currentPath.value ? `${currentPath.value}/${name}` : name;
    browse(next);
  }

  function goUp() {
    const parts = currentPath.value.split('/').filter(Boolean);
    parts.pop();
    browse(parts.join('/'));
  }

  function selectPath(relPath) {
    const abs = relPath
      ? `${root.value}/${relPath}`
      : root.value;
    onSelect(abs);
  }

  const pathParts = currentPath.value ? currentPath.value.split('/') : [];

  return html`
    <div style="border:1px solid var(--border); border-radius:var(--radius); background:var(--bg-card); overflow:hidden">
      <!-- Header -->
      <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border-bottom:1px solid var(--border); background:var(--bg-surface)">
        <span style="font-size:12px; font-weight:600; color:var(--text-primary)">Select Folder</span>
        <button class="btn" type="button" style="padding:2px 8px; font-size:11px" onclick=${onCancel}>Cancel</button>
      </div>

      <!-- Breadcrumb -->
      <div style="display:flex; align-items:center; gap:4px; padding:6px 12px; border-bottom:1px solid var(--border); font-size:12px; flex-wrap:wrap; min-height:32px">
        <button
          type="button"
          onclick=${() => browse('')}
          style="cursor:pointer; color:var(--accent); font-family:var(--font-mono); background:transparent; border:0; padding:0"
        >${root.value || '...'}</button>
        ${pathParts.map((part, i) => {
          const subPath = pathParts.slice(0, i + 1).join('/');
          return html`
            <span style="color:var(--text-muted)">/</span>
            <button
              type="button"
              onclick=${() => browse(subPath)}
              style="cursor:pointer; color:var(--accent); font-family:var(--font-mono); background:transparent; border:0; padding:0"
            >${part}</button>
          `;
        })}
      </div>

      <!-- Directory list -->
      <div style="max-height:240px; overflow-y:auto">
        ${currentPath.value ? html`
          <button
            type="button"
            onclick=${goUp}
            style="display:flex; align-items:center; gap:8px; padding:6px 12px; cursor:pointer; border-bottom:1px solid var(--border); font-size:13px; color:var(--text-muted); width:100%; background:transparent; text-align:left"
            onMouseOver=${e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
            onMouseOut=${e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <span style="font-size:14px">↑</span>
            <span>..</span>
          </button>
        ` : null}

        ${loading.value ? html`
          <div style="padding:16px 12px; text-align:center; color:var(--text-muted); font-size:12px">Loading...</div>
        ` : error.value ? html`
          <div style="padding:16px 12px; text-align:center; color:var(--danger); font-size:12px">${error.value}</div>
        ` : items.value.length === 0 ? html`
          <div style="padding:16px 12px; text-align:center; color:var(--text-muted); font-size:12px">No subdirectories</div>
        ` : items.value.map(item => html`
          <div
            style="display:flex; align-items:center; gap:8px; padding:6px 12px; border-bottom:1px solid var(--border); font-size:13px"
            onMouseOver=${e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
            onMouseOut=${e => { e.currentTarget.style.background = 'transparent'; }}
          >
            <span style="font-size:14px; color:var(--accent)">📁</span>
            <button
              class="btn"
              type="button"
              style="padding:0; border:none; background:transparent; color:var(--text-primary); font-family:var(--font-mono); font-size:13px; cursor:pointer"
              onclick=${() => {
                const next = currentPath.value ? `${currentPath.value}/${item.name}` : item.name;
                selectPath(next);
              }}
            >${item.name}</button>
            <button
              class="btn"
              type="button"
              style="margin-left:auto; padding:2px 8px; font-size:11px"
              onclick=${() => openDir(item.name)}
            >Open</button>
          </div>
        `)}
      </div>

      <div style="display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border-top:1px solid var(--border); background:var(--bg-surface)">
        <span style="font-size:11px; color:var(--text-muted); font-family:var(--font-mono); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:70%">
          Click a folder name to select it. Use Open to browse deeper.
        </span>
        <button class="btn" type="button" style="padding:4px 10px; font-size:11px" onclick=${() => selectPath(currentPath.value)}>
          Use Current
        </button>
      </div>
    </div>
  `;
}
