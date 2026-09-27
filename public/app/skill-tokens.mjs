export const SKILL_TOKEN_PATTERN = '\\{\\{skill:([A-Za-z0-9._-]+)\\}\\}';
// Skill ids keep the server's charset (modules/integrations/launch-skills.mjs
// SKILL_TOKEN_RE) so the two parsers cannot drift; quick-insert keys carry `::`
// separators (thread::id, session::kind::id) and need the wider set.
const PROMPT_TOKEN_PATTERN = '\\{\\{(?:skill:([A-Za-z0-9._-]+)|quick:([A-Za-z0-9._:-]+))\\}\\}';

export function skillToken(id = '') {
  return `{{skill:${String(id || '').trim()}}}`;
}

export function quickToken(key = '') {
  return `{{quick:${String(key || '').trim()}}}`;
}

export function quickTokenLabel(key = '') {
  const parts = String(key || '').split('::').filter(Boolean);
  if (parts[0] === 'session' && parts.length >= 3) return `${parts[1]}:${parts[2]}`;
  if (parts[0] === 'thread' && parts.length >= 2) return `thread:${parts[1]}`;
  return String(key || '');
}

export function parseSkillPrompt(text = '') {
  const source = String(text || '');
  const parts = [];
  const re = new RegExp(PROMPT_TOKEN_PATTERN, 'g');
  let last = 0;
  let match = re.exec(source);
  while (match) {
    if (match.index > last) parts.push({ type: 'text', value: source.slice(last, match.index) });
    if (match[1] !== undefined) parts.push({ type: 'skill', id: match[1] });
    else parts.push({ type: 'quick', key: match[2] });
    last = match.index + match[0].length;
    match = re.exec(source);
  }
  if (last < source.length) parts.push({ type: 'text', value: source.slice(last) });
  return parts;
}

export function normalizeSkillPromptText(value = '') {
  return String(value || '').replace(/\n+$/, '');
}

export function serializeSkillPrompt(parts = []) {
  return parts.map((part) => {
    if (part?.type === 'skill') return skillToken(part.id);
    if (part?.type === 'quick') return quickToken(part.key);
    return String(part?.value || '');
  }).join('');
}

export function insertPromptToken(text = '', token = '', cursor = null) {
  const source = String(text || '');
  const index = Number.isInteger(cursor) ? Math.max(0, Math.min(cursor, source.length)) : source.length;
  const before = source.slice(0, index);
  const after = source.slice(index);
  const padBefore = before && !/\s$/.test(before) ? ' ' : '';
  const padAfter = after && !/^\s/.test(after) ? ' ' : '';
  return {
    text: `${before}${padBefore}${token}${padAfter}${after}`,
    cursor: before.length + padBefore.length + token.length + padAfter.length,
  };
}

export function insertSkillToken(text = '', skillId = '', cursor = null) {
  return insertPromptToken(text, skillToken(skillId), cursor);
}

export function insertQuickToken(text = '', key = '', cursor = null) {
  return insertPromptToken(text, quickToken(key), cursor);
}

/**
 * Quick-insert prompts are built from live dashboard state, so unlike skills
 * they are resolved in the browser right before the text leaves for a session.
 * Reports unresolved keys instead of dropping them: a stale chip must not turn
 * a message into a bare Enter keypress.
 */
export function expandQuickTokens(text = '', resolve = () => '') {
  const source = String(text || '');
  if (!source.includes('{{quick:')) return { text: source, missing: [] };
  const missing = [];
  const expanded = parseSkillPrompt(source).map((part) => {
    if (part.type === 'skill') return skillToken(part.id);
    if (part.type !== 'quick') return String(part.value || '');
    const resolved = String(resolve(part.key) || '').trim();
    if (!resolved) missing.push(part.key);
    return resolved;
  }).join('');
  return { text: expanded, missing };
}

export function escapeSkillPromptHtml(value = '') {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function skillPromptHtml(text = '') {
  return parseSkillPrompt(text).map((part) => {
    if (part.type === 'skill') {
      return `<span class="skill-chip" data-skill-id="${escapeSkillPromptHtml(part.id)}" contenteditable="false">${escapeSkillPromptHtml(part.id)}</span>`;
    }
    if (part.type === 'quick') {
      return `<span class="skill-chip skill-chip-quick" data-quick-key="${escapeSkillPromptHtml(part.key)}" contenteditable="false">${escapeSkillPromptHtml(quickTokenLabel(part.key))}</span>`;
    }
    return escapeSkillPromptHtml(part.value).replaceAll('\n', '<br>');
  }).join('');
}

export function serializeSkillPromptNode(node) {
  if (!node) return '';
  if (node.nodeType === 3) return node.textContent || '';
  if (node.nodeType !== 1) return '';
  const skillId = node.getAttribute?.('data-skill-id');
  if (skillId) return skillToken(skillId);
  const quickKey = node.getAttribute?.('data-quick-key');
  if (quickKey) return quickToken(quickKey);
  if (node.nodeName === 'BR') return '\n';
  let out = '';
  for (const child of node.childNodes) out += serializeSkillPromptNode(child);
  if (node.nodeName === 'DIV' || node.nodeName === 'P') {
    if (out && !out.endsWith('\n')) out += '\n';
  }
  return out;
}
