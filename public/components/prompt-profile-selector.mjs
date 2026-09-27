import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { api } from '../app/api.mjs';

function text(value) {
  return String(value || '').trim();
}

export function PromptProfileSelector({
  value = 'none',
  onChange,
  title = 'Style prompt',
} = {}) {
  const catalog = useMemo(() => signal(null), []);
  const loading = useMemo(() => signal(false), []);
  const error = useMemo(() => signal(''), []);
  const profileId = useMemo(() => signal(text(value) || 'none'), []);

  useEffect(() => {
    let active = true;
    loading.value = true;
    api.get('/agents/prompt-profiles').then((result) => {
      if (!active) return;
      catalog.value = result || {};
      const next = text(value) || result?.defaultProfileId || 'none';
      profileId.value = next;
    }).catch((cause) => {
      if (active) error.value = cause?.message || 'Unable to load prompt profiles.';
    }).finally(() => {
      if (active) loading.value = false;
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (text(value)) profileId.value = text(value);
  }, [value]);

  const current = (catalog.value?.profiles || []).find((entry) => entry.id === profileId.value)
    || (catalog.value?.profiles || [])[0]
    || { id: 'none', description: 'No Fleet style prompt.' };

  return html`
    <section class="collab-field" aria-label=${title}>
      <span>${title}</span>
      ${loading.value ? html`<p class="collab-helper">Loading styles...</p>` : null}
      ${error.value ? html`<p class="collab-helper" style="color:var(--danger)">${error.value}</p>` : null}
      <select class="input" value=${current.id} onInput=${(event) => {
        profileId.value = event.target.value;
        onChange?.(event.target.value);
      }}>
        ${(catalog.value?.profiles || []).map((profile) => html`
          <option value=${profile.id}>${profile.label || profile.id}</option>
        `)}
      </select>
      ${current.description ? html`<small style="color:var(--text-muted)">${current.description}</small>` : null}
    </section>
  `;
}
