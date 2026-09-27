import { h } from 'preact';
import { html } from 'htm/preact';
import { toasts } from '../app/state.mjs';

export function ToastContainer() {
  if (toasts.value.length === 0) return null;

  return html`
    <div class="toast-container" role="status" aria-live="polite" aria-atomic="false">
      ${toasts.value.map(t => html`
        <div key=${t.id} class="toast toast-${t.type}">
          ${t.message}
        </div>
      `)}
    </div>
  `;
}
