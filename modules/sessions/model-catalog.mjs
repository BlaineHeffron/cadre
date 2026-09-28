import { resolve } from 'node:path';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { legacyRootStatePath, runtimeStatePath } from '../ops/runtime-state.mjs';

const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_CACHE_FILE = runtimeStatePath('model_catalog_cache.json');
const LEGACY_CACHE_FILE = legacyRootStatePath('model_catalog_cache.json');
const REQUEST_TIMEOUT_MS = 5000;

const memoryCache = new Map();
const inflightRequests = new Map();

export const OPENAI_FALLBACK_MODELS = Object.freeze([
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
]);

export const ANTHROPIC_FALLBACK_MODELS = Object.freeze([
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
]);

const PROVIDERS = Object.freeze({
  openai: {
    name: 'Codex',
    apiKeyEnv: 'OPENAI_API_KEY',
    fallbackModels: OPENAI_FALLBACK_MODELS,
    removedModelIds: Object.freeze([
      'gpt-5.3-codex',
      'gpt-5.3-codex-spark',
    ]),
    fetchModels: fetchOpenAiModels,
  },
  anthropic: {
    name: 'Claude',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    fallbackModels: ANTHROPIC_FALLBACK_MODELS,
    removedModelIds: Object.freeze([
      'claude-haiku-3-5-20241022',
      'claude-opus-4-20250514',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-sonnet-4-20250514',
      'claude-sonnet-4-7',
      'claude-sonnet-5',
      'fable',
    ]),
    fetchModels: fetchAnthropicModels,
  },
});

export async function listProviderModels(provider, options = {}) {
  const settings = resolveOptions(provider, options);
  const cacheKey = `${provider}:${settings.cacheFile}`;
  const now = settings.now();
  const memoryEntry = memoryCache.get(cacheKey);

  if (!settings.forceRefresh && memoryEntry && now - memoryEntry.fetchedAt < settings.ttlMs) {
    const normalized = ensureFallbackModels(provider, memoryEntry);
    memoryCache.set(cacheKey, normalized);
    return { ...normalized, models: [...normalized.models], provider };
  }

  if (!settings.forceRefresh) {
    const fileEntry = await readCacheEntry(provider, settings.cacheFile, settings.env);
    if (fileEntry && now - fileEntry.fetchedAt < settings.ttlMs) {
      const normalized = ensureFallbackModels(provider, fileEntry);
      memoryCache.set(cacheKey, normalized);
      return { ...normalized, models: [...normalized.models], provider };
    }
  }

  if (!inflightRequests.has(cacheKey)) {
    inflightRequests.set(cacheKey, refreshProviderModels(provider, settings, cacheKey));
  }

  try {
    const entry = await inflightRequests.get(cacheKey);
    const normalized = ensureFallbackModels(provider, entry);
    memoryCache.set(cacheKey, normalized);
    return { ...normalized, models: [...normalized.models], provider };
  } finally {
    inflightRequests.delete(cacheKey);
  }
}

export async function assertProviderModel(provider, model = '', options = {}) {
  const normalized = normalizeModelId(model);
  if (!normalized) {
    if (options.allowEmpty !== false) return '';
    throw invalidModelError(provider, model, await listProviderModels(provider, options));
  }

  const catalog = await listProviderModels(provider, options);
  if (!catalog.models.some((entry) => entry.id === normalized)) {
    throw invalidModelError(provider, normalized, catalog);
  }

  return normalized;
}

export async function isProviderModelSupported(provider, model = '', options = {}) {
  const normalized = normalizeModelId(model);
  if (!normalized) return false;
  const catalog = await listProviderModels(provider, options);
  return catalog.models.some((entry) => entry.id === normalized);
}

export function normalizeModelId(model = '') {
  return typeof model === 'string' ? model.trim() : '';
}

function resolveOptions(provider, options) {
  const config = PROVIDERS[provider];
  if (!config) throw new Error(`Unknown model provider "${provider}"`);

  return {
    ...config,
    forceRefresh: options.forceRefresh === true,
    env: options.env ?? process.env,
    apiKey: options.apiKey ?? (options.env ?? process.env)[config.apiKeyEnv] ?? '',
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    cacheFile: resolve(options.cacheFile ?? (options.env ?? process.env).MODEL_CATALOG_CACHE_FILE ?? DEFAULT_CACHE_FILE),
    ttlMs: Number(options.ttlMs ?? (options.env ?? process.env).MODEL_CATALOG_TTL_MS ?? DEFAULT_CACHE_TTL_MS),
    now: typeof options.now === 'function' ? options.now : () => Date.now(),
  };
}

async function refreshProviderModels(provider, settings, cacheKey) {
  const now = settings.now();

  try {
    const fetched = await settings.fetchModels(settings);
    const { models, source } = normalizeFetchedModels(fetched, settings.catalogSource || 'api');
    const supportedModels = filterRemovedModels(settings, models);
    if (supportedModels.length > 0) {
      const entry = { fetchedAt: now, source, models: supportedModels };
      memoryCache.set(cacheKey, entry);
      await writeCacheEntry(provider, settings.cacheFile, entry, settings.env);
      return entry;
    }
  } catch {
    // Fall back below.
  }

  const cached = await readCacheEntry(provider, settings.cacheFile, settings.env);
  if (cached?.models?.length) {
    memoryCache.set(cacheKey, cached);
    return cached;
  }

  const fallback = {
    fetchedAt: now,
    source: 'fallback',
    models: settings.fallbackModels.map((entry) => ({ ...entry })),
  };
  memoryCache.set(cacheKey, fallback);
  return fallback;
}

async function fetchOpenAiModels({ apiKey, fetchImpl }) {
  if (!apiKey) {
    return {
      source: 'subscription',
      models: sortModels(OPENAI_FALLBACK_MODELS.map((entry) => ({ ...entry }))),
    };
  }
  const fetchFn = assertFetch(fetchImpl);

  const response = await fetchFn('https://api.openai.com/v1/models', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OpenAI models request failed with ${response.status}`);

  const payload = await response.json();
  const models = Array.isArray(payload?.data) ? payload.data : [];
  return {
    source: 'api',
    models: sortModels(models
      .map((entry) => ({ id: normalizeModelId(entry?.id), label: prettifyModelId(entry?.id) }))
      .filter((entry) => entry.id && isOpenAiInteractiveModelId(entry.id))),
  };
}

async function fetchAnthropicModels({ apiKey, fetchImpl }) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');
  const fetchFn = assertFetch(fetchImpl);

  const models = [];
  let afterId = '';

  for (;;) {
    const url = new URL('https://api.anthropic.com/v1/models');
    url.searchParams.set('limit', '1000');
    if (afterId) url.searchParams.set('after_id', afterId);

    const response = await fetchFn(url, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Anthropic models request failed with ${response.status}`);

    const payload = await response.json();
    const page = Array.isArray(payload?.data) ? payload.data : [];
    for (const entry of page) {
      const id = normalizeModelId(entry?.id);
      if (!id) continue;
      models.push({
        id,
        label: normalizeModelId(entry?.display_name) || prettifyModelId(id, { prefix: 'Claude' }),
      });
    }

    if (!payload?.has_more || page.length === 0) break;
    afterId = normalizeModelId(page.at(-1)?.id);
    if (!afterId) break;
  }

  return sortModels(models);
}

async function readCacheEntry(provider, cacheFile, env = process.env) {
  try {
    const cacheStore = buildPostgresJsonStore({
      namespace: 'model_catalog_cache',
      filePath: cacheFile,
      legacyFilePath: cacheFile === DEFAULT_CACHE_FILE ? LEGACY_CACHE_FILE : undefined,
      env,
      modeEnvKey: 'MODEL_CATALOG_STORAGE',
    });
    const raw = await cacheStore.load();
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw?.[provider];
    if (!entry || !Array.isArray(entry.models) || !Number.isFinite(entry.fetchedAt)) return null;
    return {
      fetchedAt: entry.fetchedAt,
      source: entry.source || 'cache',
      models: sortModels(entry.models
        .map((model) => ({
          id: normalizeModelId(model?.id),
          label: normalizeModelId(model?.label) || prettifyModelId(model?.id),
        }))
        .filter((model) => model.id)),
    };
  } catch {
    return null;
  }
}

async function writeCacheEntry(provider, cacheFile, entry, env = process.env) {
  try {
    const cacheStore = buildPostgresJsonStore({
      namespace: 'model_catalog_cache',
      filePath: cacheFile,
      legacyFilePath: cacheFile === DEFAULT_CACHE_FILE ? LEGACY_CACHE_FILE : undefined,
      env,
      modeEnvKey: 'MODEL_CATALOG_STORAGE',
    });
    let existing = await cacheStore.load();
    if (!existing || typeof existing !== 'object') existing = {};
    existing[provider] = {
      fetchedAt: entry.fetchedAt,
      source: entry.source,
      models: entry.models,
    };
    await cacheStore.save(existing);
  } catch {
    // Best effort.
  }
}

function invalidModelError(provider, model, catalog) {
  const providerName = PROVIDERS[provider]?.name || provider;
  const allowedModels = catalog.models.map((entry) => entry.id).join(', ');
  const value = normalizeModelId(model) || String(model || '');
  const error = new Error(`Unsupported ${providerName} model "${value}". Allowed models: ${allowedModels}`);
  error.statusCode = 400;
  return error;
}

function prettifyModelId(id = '', { prefix = '' } = {}) {
  const raw = normalizeModelId(id);
  if (!raw) return '';
  const text = raw
    .replace(/-/g, ' ')
    .replace(/\b(gpt|claude|codex|opus|sonnet|haiku|mini|nano|pro)\b/gi, (match) => {
      if (/^gpt$/i.test(match)) return 'GPT';
      return match.charAt(0).toUpperCase() + match.slice(1);
    })
    .replace(/\s+/g, ' ')
    .trim();
  return prefix && !text.toLowerCase().startsWith(prefix.toLowerCase()) ? `${prefix} ${text}` : text;
}

function sortModels(models) {
  const deduped = new Map();
  for (const entry of models) {
    if (!entry?.id) continue;
    deduped.set(entry.id, { id: entry.id, label: entry.label || prettifyModelId(entry.id) });
  }
  return [...deduped.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function filterRemovedModels(providerOrSettings, models = []) {
  const removedModelIds = new Set((providerOrSettings?.removedModelIds || PROVIDERS[providerOrSettings]?.removedModelIds || [])
    .map((id) => normalizeModelId(id).toLowerCase())
    .filter(Boolean));
  if (removedModelIds.size === 0) return sortModels(models);
  return sortModels(models.filter((entry) => !removedModelIds.has(normalizeModelId(entry?.id).toLowerCase())));
}

function ensureFallbackModels(provider, entry) {
  const fallbackModels = PROVIDERS[provider]?.fallbackModels || [];
  const mergeModels = (models = []) => filterRemovedModels(provider, [
    ...models.map((model) => ({ ...model })),
    ...fallbackModels.map((model) => ({ ...model })),
  ]);
  if (fallbackModels.length === 0) {
    return entry;
  }
  if (!entry || !Array.isArray(entry.models)) {
    return {
      fetchedAt: Date.now(),
      source: 'fallback',
      models: filterRemovedModels(provider, fallbackModels.map((model) => ({ ...model }))),
    };
  }
  return {
    ...entry,
    models: mergeModels(entry.models),
  };
}

function assertFetch(fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  return fetchImpl;
}

function normalizeFetchedModels(value, fallbackSource = 'api') {
  if (Array.isArray(value)) {
    return { models: sortModels(value), source: fallbackSource };
  }

  const models = Array.isArray(value?.models) ? sortModels(value.models) : [];
  const source = normalizeModelId(value?.source) || fallbackSource;
  return { models, source };
}

// The Codex CLI only drives the gpt-5 and later families. The bare /v1/models list also
// carries embeddings, o-series and legacy chat models; admitting those let callers spawn a
// Codex session on a model the CLI cannot run, which left an empty tmux pane behind.
function isOpenAiInteractiveModelId(modelId = '') {
  const normalized = normalizeModelId(modelId).toLowerCase();
  if (!normalized) return false;
  if (normalized.includes('embed') || normalized.includes('moderation')) return false;
  if (normalized.includes('codex')) return true;
  const major = Number.parseInt(normalized.match(/^gpt-(\d+)/)?.[1] ?? '', 10);
  return Number.isInteger(major) && major >= 5;
}
