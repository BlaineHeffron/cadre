import {
  ANTHROPIC_FALLBACK_MODELS,
  assertProviderModel,
  isProviderModelSupported,
  listProviderModels,
  normalizeModelId,
} from './model-catalog.mjs';
import {
  DEFAULT_CLAUDE_MODEL,
  FAST_CLAUDE_MODEL,
  getPreferredModelForProvider,
} from './provider-models.mjs';
export { DEFAULT_CLAUDE_MODEL, FAST_CLAUDE_MODEL };

const CLAUDE_MODEL_FAMILIES = new Set(['opus', 'sonnet', 'haiku']);

export function normalizeClaudeModel(model = '') {
  const normalized = normalizeModelId(model);
  if (!normalized) return '';

  const compact = normalized
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/\.+/g, '-')
    .replace(/-+/g, '-');
  const parts = compact.split('-').filter(Boolean);
  const familyIndex = parts[0] === 'claude' ? 1 : 0;
  const family = parts[familyIndex];

  if (!CLAUDE_MODEL_FAMILIES.has(family)) return normalized;

  const suffix = parts.slice(familyIndex + 1);
  if (suffix.length === 0 || !suffix.every((part) => /^\d+$/.test(part))) return normalized;

  return `claude-${family}-${suffix.join('-')}`;
}

export function isKnownClaudeModel(model = '') {
  const normalized = normalizeClaudeModel(model);
  return Boolean(normalized) && ANTHROPIC_FALLBACK_MODELS.some((entry) => entry.id === normalized);
}

export function normalizeClaudeProvider(provider = '') {
  const normalized = String(provider || '').trim().toLowerCase();
  if (!normalized || normalized === 'claude' || normalized === 'anthropic') return 'anthropic';
  return normalized;
}

export async function listClaudeModels(options = {}) {
  const catalog = await listProviderModels('anthropic', options);
  return [...catalog.models];
}

export async function getPreferredClaudeModel({ fast = false, ...options } = {}) {
  return getPreferredModelForProvider('claude', { fast, ...options });
}

export async function isValidClaudeModel(model = '', options = {}) {
  return isProviderModelSupported('anthropic', normalizeClaudeModel(model), options);
}

export async function assertValidClaudeModel(model = '', options = {}) {
  return assertProviderModel('anthropic', normalizeClaudeModel(model), options);
}

export function listFallbackClaudeModels() {
  return [...ANTHROPIC_FALLBACK_MODELS];
}
