import { h } from 'preact';
import { html } from 'htm/preact';

function ActionButton({ label = 'Retry', onAction, primary = false }) {
  if (!onAction) return null;
  return html`<button class="btn ${primary ? 'btn-primary' : 'btn-subtle'}" onclick=${onAction}>${label}</button>`;
}

export function LoadingState({ message = 'Loading...' }) {
  return html`
    <div class="card" role="status" aria-live="polite">
      <p style="color:var(--text-muted)">${message}</p>
    </div>
  `;
}

// A first-run empty state can name itself and list a few steps, so it guides instead of only saying "nothing".
export function EmptyState({ title = '', message = 'Nothing to show yet.', steps = null, actionLabel = '', onAction = null }) {
  return html`
    <div class="card ${onAction ? 'empty-state' : ''}">
      ${title ? html`<h2 class="empty-state-title">${title}</h2>` : null}
      <p style="color:var(--text-muted); margin-bottom:${onAction ? '12px' : '0'}">${message}</p>
      ${steps ? html`<ol class="empty-state-steps">${steps.map((step) => html`<li>${step}</li>`)}</ol>` : null}
      ${onAction ? html`<${ActionButton} label=${actionLabel || 'Take action'} onAction=${onAction} primary=${true} />` : null}
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
