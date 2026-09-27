import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { api } from '../app/api.mjs';
import { addToast } from '../app/state.mjs';
import { navigate } from '../app/navigation.mjs';
import { takeSkillDraft } from '../app/skill-drafts.mjs';
import { ErrorState, LoadingState } from '../components/page-state.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function slugifySkillName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    // The server rejects '..' anywhere in a name.
    .replace(/\.{2,}/g, '.')
    // The server requires an alphanumeric first character and no trailing punctuation.
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 64);
}

/** First non-empty line of a draft, trimmed to a usable skill name. */
function suggestNameFromBody(body) {
  const line = String(body || '')
    .split('\n')
    .map((entry) => entry.trim())
    .find(Boolean) || '';
  return slugifySkillName(line.replace(/^#+\s*/, '').split(/\s+/).slice(0, 6).join('-'));
}

async function loadSkills(state) {
  state.loading.value = true;
  state.error.value = '';
  try {
    const payload = await api.get('/skills');
    state.skills.value = Array.isArray(payload?.skills) ? payload.skills : [];
  } catch (error) {
    state.error.value = error.message || 'Unable to load skills.';
  } finally {
    state.loading.value = false;
  }
}

function resetEditor(state, { body = '', name = '', description = '' } = {}) {
  state.editingName.value = '';
  state.name.value = name;
  state.description.value = description;
  state.body.value = body;
  state.saveError.value = '';
}

async function openSkill(state, id) {
  state.saveError.value = '';
  try {
    const skill = await api.get(`/skills/${encodeURIComponent(id)}`);
    state.editingName.value = skill.name || id;
    state.name.value = skill.name || id;
    state.description.value = skill.description || '';
    state.body.value = skill.body || '';
  } catch (error) {
    state.saveError.value = error.message || `Unable to open ${id}.`;
  }
}

async function saveSkill(state) {
  const name = slugifySkillName(state.name.value);
  const body = state.body.value.trim();
  if (!NAME_RE.test(name)) {
    state.saveError.value = 'Name must be lowercase letters, digits, dot, dash, or underscore.';
    return;
  }
  if (!body) {
    state.saveError.value = 'Skill text cannot be empty.';
    return;
  }
  state.saving.value = true;
  state.saveError.value = '';
  const editing = state.editingName.value;
  const payload = { description: state.description.value.trim(), body };
  try {
    if (editing && editing === name) {
      await api.put(`/skills/${encodeURIComponent(name)}`, payload);
    } else {
      await api.post('/skills', { ...payload, name, overwrite: state.overwrite.value });
    }
    state.editingName.value = name;
    state.name.value = name;
    state.overwrite.value = false;
    addToast(`Saved skill ${name}`, 'success');
    // A rename writes the new file first; only then is the old one removed, so
    // a failed delete leaves both copies rather than losing the skill.
    if (editing && editing !== name) {
      try {
        await api.delete(`/skills/${encodeURIComponent(editing)}`);
      } catch (error) {
        if (error.code === 'launch_skill_readonly') {
          addToast(`Saved as ${name}; ${editing} is a read-only skill and stays`, 'info');
        } else {
          state.saveError.value = `Saved ${name}, but the old ${editing} could not be removed: ${error.message}`;
        }
      }
    }
    await loadSkills(state);
  } catch (error) {
    if (error.code === 'launch_skill_exists') {
      state.saveError.value = `A skill named ${name} already exists. Enable "Replace existing" to overwrite it.`;
    } else {
      state.saveError.value = error.message || 'Unable to save skill.';
    }
  } finally {
    state.saving.value = false;
  }
}

async function removeSkill(state, skill) {
  const id = skill.id;
  const reverts = skill.source === 'local' && skill.hasStock;
  const question = reverts
    ? `Revert ${id} to the read-only version? Your local edits will be removed.`
    : `Delete skill ${id}?`;
  if (typeof window !== 'undefined' && !window.confirm(question)) return;
  try {
    await api.delete(`/skills/${encodeURIComponent(id)}`);
    if (state.editingName.value === id) resetEditor(state);
    addToast(reverts ? `Reverted ${id} to the read-only version` : `Deleted skill ${id}`, 'info');
    await loadSkills(state);
  } catch (error) {
    state.saveError.value = error.message || `Unable to delete ${id}.`;
  }
}

export function SkillsPage() {
  const state = useMemo(() => ({
    skills: signal([]),
    loading: signal(true),
    error: signal(''),
    editingName: signal(''),
    name: signal(''),
    description: signal(''),
    body: signal(''),
    overwrite: signal(false),
    saving: signal(false),
    saveError: signal(''),
  }), []);

  const { skills, loading, error, editingName, name, description, body, overwrite, saving, saveError } = state;

  useEffect(() => {
    loadSkills(state);
    const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);
    if (params.get('draft')) {
      const draft = takeSkillDraft();
      if (draft) {
        resetEditor(state, { body: draft, name: suggestNameFromBody(draft) });
        addToast('Prompt copied into a new skill draft', 'info');
      }
    }
    const target = params.get('name');
    if (target) openSkill(state, target);
  }, []);

  const isEditing = Boolean(editingName.value);

  return html`
    <div class="page skills-page">
      <div class="card-header skills-head">
        <div>
          <h1 class="card-title" style="font-size:18px">Skill Writer</h1>
          <div class="fleet-meta">
            ${skills.value.length} fleet skills - reusable prompt text inserted at launch or mid-session
          </div>
        </div>
        <div class="skills-toolbar">
          <button class="btn" type="button" onclick=${() => loadSkills(state)} disabled=${loading.value}>
            ${loading.value ? 'Refreshing...' : 'Refresh'}
          </button>
          <button class="btn btn-primary" type="button" onclick=${() => resetEditor(state)}>New skill</button>
        </div>
      </div>

      ${error.value ? html`<${ErrorState} message=${error.value} />` : null}

      <form
        class="card skill-editor"
        onSubmit=${(event) => { event.preventDefault(); saveSkill(state); }}>
        <div class="card-header">
          <span class="card-title">${isEditing ? `Editing /${editingName.value}` : 'New skill'}</span>
          ${isEditing ? html`
            <button class="btn" type="button" onclick=${() => resetEditor(state)}>Cancel edit</button>
          ` : null}
        </div>

        <div class="skill-editor-grid">
          <label class="skill-editor-field">
            <span>Name</span>
            <input
              class="input"
              placeholder="deploy-checklist"
              value=${name.value}
              onInput=${(event) => { name.value = event.target.value; }}
              onBlur=${(event) => { name.value = slugifySkillName(event.target.value); }} />
          </label>
          <label class="skill-editor-field">
            <span>Description</span>
            <input
              class="input"
              placeholder="One line shown in the skill picker"
              value=${description.value}
              onInput=${(event) => { description.value = event.target.value; }} />
          </label>
        </div>

        <label class="skill-editor-field">
          <span>Skill text</span>
          <textarea
            class="input skill-editor-body"
            rows="14"
            placeholder="The prompt text this skill expands to."
            value=${body.value}
            onInput=${(event) => { body.value = event.target.value; }}></textarea>
        </label>

        ${saveError.value ? html`<p class="skill-editor-error">${saveError.value}</p>` : null}

        <div class="skill-editor-actions">
          <button class="btn btn-primary" type="submit" disabled=${saving.value}>
            ${saving.value ? 'Saving...' : (isEditing ? 'Save changes' : 'Create skill')}
          </button>
          ${!isEditing || slugifySkillName(name.value) !== editingName.value ? html`
            <label class="skill-editor-toggle">
              <input
                type="checkbox"
                checked=${overwrite.value}
                onInput=${(event) => { overwrite.value = event.target.checked; }} />
              <span>Replace existing</span>
            </label>
          ` : null}
          <span class="new-agent-hint">Insert it later with the skill picker, or {{skill:${slugifySkillName(name.value) || 'name'}}}.</span>
        </div>
      </form>

      ${loading.value && skills.value.length === 0 ? html`<${LoadingState} message="Loading skills..." />` : null}

      <section class="skill-list" aria-label="Fleet skills">
        ${skills.value.map((skill) => html`
          <article class="card skill-row" key=${skill.id}>
            <div class="skill-row-main">
              <span class="card-title" style="font-family:var(--font-mono)">/${skill.name || skill.id}</span>
              ${skill.source === 'stock' ? html`<span class="skill-row-badge" title="Tracked in git; editing creates a local override">stock</span>` : null}
              ${skill.source === 'custom' ? html`<span class="skill-row-badge" title="External read-only skill; editing creates a local override">custom</span>` : null}
              ${skill.source === 'local' && skill.hasStock ? html`<span class="skill-row-badge" title="Local override of a read-only skill">override</span>` : null}
              <p class="skill-row-desc">${skill.description || 'No description'}</p>
              <p class="skill-row-preview">${(skill.preview || '').slice(0, 160)}</p>
            </div>
            <div class="skill-row-actions">
              <button class="btn" type="button" onclick=${() => openSkill(state, skill.id)}>Edit</button>
              ${skill.source === 'stock' || skill.source === 'custom' ? null : html`
                <button class="btn btn-danger" type="button" onclick=${() => removeSkill(state, skill)}>
                  ${skill.hasStock ? 'Revert' : 'Delete'}
                </button>
              `}
            </div>
          </article>
        `)}
      </section>

      <div class="skills-footer">
        <button class="btn" type="button" onclick=${() => navigate('/agents')}>Back to agents</button>
      </div>
    </div>
  `;
}
