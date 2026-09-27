import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { api } from '../app/api.mjs';

export function LaunchSkillSelector({
  onInsert,
  title = 'Skills',
  compact = false,
} = {}) {
  const skills = useMemo(() => signal([]), []);
  const loading = useMemo(() => signal(false), []);

  useEffect(() => {
    let active = true;
    loading.value = true;
    api.get('/agents/skills').then((result) => {
      if (!active) return;
      skills.value = Array.isArray(result?.skills) ? result.skills : [];
    }).catch(() => {
      if (active) skills.value = [];
    }).finally(() => {
      if (active) loading.value = false;
    });
    return () => { active = false; };
  }, []);

  if (!loading.value && skills.value.length === 0) return null;

  if (compact) {
    return html`
      <select
        class="ctrl-inline-select ctrl-inline-select-compact"
        aria-label=${title}
        onInput=${(event) => {
          const id = event.target.value;
          event.target.value = '';
          if (id) onInsert?.(id);
        }}>
        <option value="">Insert skill</option>
        ${skills.value.map((skill) => html`
          <option value=${skill.id || skill.name} title=${skill.description || skill.name || skill.id}>
            ${skill.name || skill.id}
          </option>
        `)}
      </select>
    `;
  }

  return html`
    <section class="collab-field" aria-label=${title} style="grid-column: 1 / -1">
      <span>${title}</span>
      <p class="collab-helper" style="margin:4px 0 8px">
        Insert a highlighted skill name. The full text is resolved only when Cadre sends it to the harness.
      </p>
      ${loading.value ? html`<p class="collab-helper">Loading skills...</p>` : null}
      <div style="display:flex; flex-wrap:wrap; gap:6px">
        ${skills.value.map((skill) => html`
          <button
            type="button"
            class="btn"
            title=${skill.description || skill.name || skill.id}
            onclick=${() => onInsert?.(skill.id || skill.name)}>
            ${skill.name || skill.id}
          </button>
        `)}
      </div>
    </section>
  `;
}
