import { h } from 'preact';
import { html } from 'htm/preact';

function ActionButton({ label = 'Retry', onAction }) {
  if (!onAction) return null;
  return html`<button class="btn btn-subtle" onclick=${onAction}>${label}</button>`;
}

export function LoadingState({ message = 'Loading...' }) {
  return html`
    <div class="card" role="status" aria-live="polite">
      <p style="color:var(--text-muted)">${message}</p>
    </div>
  `;
}

export function EmptyState({ message = 'Nothing to show yet.', actionLabel = '', onAction = null }) {
  return html`
    <div class="card">
      <p style="color:var(--text-muted); margin-bottom:${onAction ? '10px' : '0'}">${message}</p>
      ${onAction ? html`<${ActionButton} label=${actionLabel || 'Take action'} onAction=${onAction} />` : null}
    </div>
  `;
}

export function ErrorState({ message = 'Something went wrong.', actionLabel = 'Retry', onAction = null }) {
  return html`
    <div class="card" role="alert">
      <p style="color:var(--danger); margin-bottom:${onAction ? '10px' : '0'}">${message}</p>
      ${onAction ? html`<${ActionButton} label=${actionLabel} onAction=${onAction} />` : null}
    </div>
  `;
}
