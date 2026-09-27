import {
  ANTHROPIC_FALLBACK_MODELS,
  OPENAI_FALLBACK_MODELS,
  listProviderModels,
  normalizeModelId,
} from './model-catalog.mjs';

const MODEL_PROVIDER_DEFAULTS = Object.freeze({
  codex: Object.freeze({
    provider: 'openai',
    defaultModel: 'gpt-6-sol',
    fastModel: 'gpt-6-sol',
  }),
  claude: Object.freeze({
    provider: 'anthropic',
    defaultModel: 'claude-opus-5-5',
    fastModel: 'claude-sonnet-4-6',
  }),
});

const OPENAI_DEFAULT_ORDER = Object.freeze([
  'gpt-6-sol',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
]);

export const DEFAULT_CODEX_MODEL = MODEL_PROVIDER_DEFAULTS.codex.defaultModel;
export const DEFAULT_CLAUDE_MODEL = MODEL_PROVIDER_DEFAULTS.claude.defaultModel;
export const FAST_CLAUDE_MODEL = MODEL_PROVIDER_DEFAULTS.claude.fastModel;

export function defaultModelForProvider(provider = '', { fast = false } = {}) {
  const normalizedProvider = normalizeModelProvider(provider);
  const defaults = MODEL_PROVIDER_DEFAULTS[normalizedProvider];
  if (!defaults) return '';
  return normalizeModelId(fast ? defaults.fastModel : defaults.defaultModel) || '';
}

export function defaultModelForSpawnType(spawnType = '', { fast = false } = {}) {
  const normalized = String(spawnType || '').trim().toLowerCase();
  if (normalized === 'claude') return defaultModelForProvider('claude', { fast });
  if (normalized === 'codex') return defaultModelForProvider('codex');
  return '';
}

export async function getPreferredModelForProvider(provider = '', { fast = false, ...options } = {}) {
  const normalizedProvider = normalizeModelProvider(provider);
  const catalogProvider = MODEL_PROVIDER_DEFAULTS[normalizedProvider]?.provider;
  if (!catalogProvider) return '';

  const catalog = await listProviderModels(catalogProvider, options);
  const ids = (catalog.models || []).map((entry) => normalizeModelId(entry?.id)).filter(Boolean);
  return pickPreferredModelId(normalizedProvider, ids, { fast });
}

export async function getPreferredModelForSpawnType(spawnType = '', { fast = false, ...options } = {}) {
  const normalized = String(spawnType || '').trim().toLowerCase();
  if (normalized === 'claude') return getPreferredModelForProvider('claude', { fast, ...options });
  if (normalized === 'codex') return getPreferredModelForProvider('codex', options);
  return '';
}

function normalizeModelProvider(provider = '') {
  const normalized = String(provider || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'anthropic') return 'claude';
  return normalized;
}

function pickPreferredModelId(provider = '', ids = [], { fast = false } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return defaultModelForProvider(provider, { fast });
  }

  if (provider === 'claude') {
    const order = fast
      ? [FAST_CLAUDE_MODEL, 'sonnet', 'haiku', DEFAULT_CLAUDE_MODEL]
      : [DEFAULT_CLAUDE_MODEL, 'opus', FAST_CLAUDE_MODEL, 'sonnet', 'haiku'];
    return matchByOrder(ids, order, defaultModelForProvider('claude', { fast }));
  }

  if (provider === 'codex' || provider === 'openai') {
    if (provider !== 'codex') return '';
    return matchByOrder(ids, OPENAI_DEFAULT_ORDER, defaultModelForProvider('codex'));
  }

  return ids[0];
}

function matchByOrder(ids = [], order = [], fallback = '') {
  const normalizedIds = ids.map((id) => normalizeModelId(id)).filter(Boolean);
  for (const token of order) {
    const normalizedToken = normalizeModelId(token).toLowerCase();
    if (!normalizedToken) continue;
    const exact = normalizedIds.find((id) => id.toLowerCase() === normalizedToken);
    if (exact) return exact;
    const contains = normalizedIds.find((id) => id.toLowerCase().includes(normalizedToken));
    if (contains) return contains;
  }
  return normalizedIds[0] || fallback || '';
}

export function listDefaultProviderModels() {
  return {
    openai: [...OPENAI_FALLBACK_MODELS],
    anthropic: [...ANTHROPIC_FALLBACK_MODELS],
  };
}
