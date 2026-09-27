/**
 * Hand off prompt text to the skill writer page.
 *
 * The writer usually opens in a new tab, so the draft travels through
 * localStorage instead of the URL: prompts are long, and query strings end up
 * in history and server logs.
 */

const DRAFT_KEY = 'dueno.skillDraft';

function storage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function stashSkillDraft(text) {
  const body = String(text || '').trim();
  if (!body) return false;
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(DRAFT_KEY, JSON.stringify({ body, stashedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
}

/** Reads and clears the pending draft. Returns '' when nothing is waiting. */
export function takeSkillDraft() {
  const store = storage();
  if (!store) return '';
  let raw = null;
  try {
    raw = store.getItem(DRAFT_KEY);
    store.removeItem(DRAFT_KEY);
  } catch {
    return '';
  }
  if (!raw) return '';
  try {
    return String(JSON.parse(raw)?.body || '');
  } catch {
    return '';
  }
}

export const SKILL_WRITER_PATH = '/skills';

/** Stash `text` and open the writer, preferring a new tab. */
export function openSkillWriterWithDraft(text, { newTab = true } = {}) {
  const stashed = stashSkillDraft(text);
  const path = stashed ? `${SKILL_WRITER_PATH}?draft=1` : SKILL_WRITER_PATH;
  if (newTab && typeof window !== 'undefined' && typeof window.open === 'function') {
    // No 'noopener' feature: it forces a null return, which would make the
    // fallback below ALSO navigate this tab. Same-origin page; sever manually.
    const opened = window.open(path, '_blank');
    if (opened) {
      opened.opener = null;
      return true;
    }
  }
  if (typeof window !== 'undefined') window.location.href = path;
  return stashed;
}
