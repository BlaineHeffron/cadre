import { html } from 'htm/preact';

const btnStyle = `
  padding:8px 12px; min-width:40px; text-align:center;
  font-size:13px; font-weight:600; font-family:var(--font-mono);
  background:var(--bg-card); color:var(--text-primary);
  border:1px solid var(--border); border-radius:var(--radius);
  cursor:pointer; user-select:none; -webkit-user-select:none;
  touch-action:manipulation;
`.replace(/\n/g, '');

/**
 * Terminal control keys toolbar.
 * @param {function} onKey - called with the tmux key name, e.g. 'Up', 'Tab', 'Enter'
 */
export function TerminalKeys({ onKey }) {
  const k = (name) => () => onKey(name);

  return html`
    <div style="display:flex; flex-wrap:wrap; gap:4px; padding:4px 0">
      <button style=${btnStyle} onclick=${k('Up')} title="Up arrow">\u25B2</button>
      <button style=${btnStyle} onclick=${k('Down')} title="Down arrow">\u25BC</button>
      <button style=${btnStyle} onclick=${k('Left')} title="Left arrow">\u25C0</button>
      <button style=${btnStyle} onclick=${k('Right')} title="Right arrow">\u25B6</button>
      <button style=${btnStyle} onclick=${k('Tab')} title="Tab">Tab</button>
      <button style=${btnStyle} onclick=${k('BTab')} title="Shift+Tab">S-Tab</button>
      <button style=${btnStyle} onclick=${k('Enter')} title="Enter">\u23CE</button>
      <button style=${btnStyle} onclick=${k('Escape')} title="Escape">Esc</button>
      <button style=${btnStyle} onclick=${k('C-c')} title="Ctrl+C">^C</button>
      <button style=${btnStyle} onclick=${k('C-d')} title="Ctrl+D">^D</button>
      <button style=${btnStyle} onclick=${k('C-z')} title="Ctrl+Z">^Z</button>
    </div>
  `;
}
