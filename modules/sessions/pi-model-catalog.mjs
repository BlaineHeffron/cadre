import { resolve } from 'node:path';
import { exec } from '../../lib/exec.mjs';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';

const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_FILE = runtimeStatePath('pi_model_catalog_cache.json');

const memoryCache = new Map();
const inflightRequests = new Map();

export const PI_PROVIDER_DEFINITIONS = Object.freeze({
  xai: Object.freeze({ id: 'xai', label: 'xAI', defaultModel: 'grok-4.6' }),
  google: Object.freeze({ id: 'google', label: 'Google', defaultModel: 'gemini-3.5-flash' }),
  'opencode-go': Object.freeze({ id: 'opencode-go', label: 'OpenCode Go', defaultModel: 'glm-5.3' }),
  openrouter: Object.freeze({ id: 'openrouter', label: 'OpenRouter', defaultModel: 'z-ai/glm-5.3-flash' }),
});

export const PI_FALLBACK_MODELS = Object.freeze({
  xai: Object.freeze([
    { id: 'grok-4.7', label: 'Grok 4.7' },
    { id: 'grok-4.6', label: 'Grok 4.6' },
    { id: 'grok-4.5', label: 'Grok 4.5' },
    { id: 'grok-4.3', label: 'Grok 4.3' },
    { id: 'grok-build-0.1', label: 'Grok Build 0.1' },
  ]),
  google: Object.freeze([{ id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' }]),
  'opencode-go': Object.freeze([
    { id: 'glm-5.3', label: 'GLM-5.3' },
    { id: 'glm-5.2', label: 'GLM-5.2' },
    { id: 'glm-5.1', label: 'GLM-5.1' },
    { id: 'kimi-k3', label: 'Kimi K3' },
    { id: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
    { id: 'kimi-k2.6', label: 'Kimi K2.6' },
    { id: 'minimax-m3', label: 'MiniMax-M3' },
    { id: 'minimax-m2.7', label: 'MiniMax-M2.7' },
    { id: 'mimo-v2.5-pro', label: 'MiMo V2.5 Pro' },
    { id: 'mimo-v2.5', label: 'MiMo V2.5' },
    { id: 'qwen3.8-max', label: 'Qwen3.8 Max' },
    { id: 'qwen3.7-max', label: 'Qwen3.7 Max' },
    { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus' },
    { id: 'qwen3.6-plus', label: 'Qwen3.6 Plus' },
    { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    { id: 'grok-4.5', label: 'Grok 4.5' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'hy3', label: 'HY3' },
  ]),
  openrouter: Object.freeze([{ id: 'z-ai/glm-5.3-flash', label: 'Z.ai GLM 5.3 Flash' }]),
});

export async function listPiModels(options = {}) {
  const settings = resolveOptions(options);
  const cacheKey = settings.cacheFile;
  const now = settings.now();
  const memoryEntry = memoryCache.get(cacheKey);

  if (!settings.forceRefresh && isFresh(memoryEntry, now, settings.ttlMs)) {
    return cloneCatalog(memoryEntry);
  }

  if (!settings.forceRefresh) {
    const persisted = await readCache(settings);
    if (isFresh(persisted, now, settings.ttlMs)) {
      memoryCache.set(cacheKey, persisted);
      return cloneCatalog(persisted);
    }
  }

  if (!inflightRequests.has(cacheKey)) {
    inflightRequests.set(cacheKey, refreshCatalog(settings));
  }

  try {
    const catalog = await inflightRequests.get(cacheKey);
    memoryCache.set(cacheKey, catalog);
    return cloneCatalog(catalog);
  } finally {
    inflightRequests.delete(cacheKey);
  }
}

export async function assertPiProviderModel(provider, model = '', options = {}) {
  const normalizedProvider = normalizePiProvider(provider);
  if (!normalizedProvider) {
    throw piCatalogError(
      'pi_provider_unsupported',
      `Unsupported Pi provider "${normalizeText(provider)}". Allowed providers: xai, google, opencode-go, openrouter`,
      400,
    );
  }

  const catalog = await listPiModels({
    ...options,
    forceRefresh: options.forceRefresh === true,
  });
  if (catalog.errorCode === 'pi_binary_missing') {
    throw piCatalogError('pi_binary_missing', catalog.error || 'Pi CLI binary not found', 503);
  }
  if (catalog.errorCode === 'pi_credentials_missing') {
    throw piCatalogError(
      'pi_credentials_missing',
      catalog.error || `Pi credentials are missing for provider "${normalizedProvider}". Run pi and use /login.`,
      400,
    );
  }
  if (catalog.errorCode) {
    throw piCatalogError(
      catalog.errorCode,
      catalog.error || 'Pi model discovery is unavailable',
      503,
    );
  }

  const normalizedModel = normalizeText(model);
  const providerModels = catalog.models[normalizedProvider] || [];
  if (providerModels.length === 0) {
    const candidate = normalizedModel || PI_PROVIDER_DEFINITIONS[normalizedProvider]?.defaultModel;
    if (isKnownPiProviderModel(normalizedProvider, candidate) && catalog.errorCode !== 'pi_binary_missing') {
      console.warn(JSON.stringify({
        event: 'pi_model_catalog_fallback',
        provider: normalizedProvider,
        model: candidate,
      }));
      return candidate;
    }
    throw unsupportedModelError(normalizedProvider, candidate, PI_FALLBACK_MODELS[normalizedProvider] || []);
  }
  if (!normalizedModel) {
    if (options.allowEmpty === false) {
      throw unsupportedModelError(normalizedProvider, normalizedModel, providerModels);
    }
    return catalog.providers.find((entry) => entry.id === normalizedProvider)?.defaultModel
      || PI_PROVIDER_DEFINITIONS[normalizedProvider].defaultModel;
  }

  if (!providerModels.some((entry) => entry.id === normalizedModel)) {
    throw unsupportedModelError(normalizedProvider, normalizedModel, providerModels);
  }
  return normalizedModel;
}

export function parsePiModelList(output = '') {
  const models = emptyModelMap();
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  for (const line of lines) {
    if (/^provider\s{2,}model\s{2,}/i.test(line)) continue;
    if (/^no models available\b/i.test(line)) continue;
    const columns = line.split(/\s{2,}|\t+/);
    if (columns.length < 2) continue;
    const provider = normalizePiProvider(columns[0]);
    const model = normalizeText(columns[1]);
    if (!provider || !model) continue;
    models[provider].push({ id: model, label: prettifyModelId(model) });
  }

  for (const provider of Object.keys(models)) {
    models[provider] = sortModels(models[provider]);
  }
  return models;
}

export function normalizePiProvider(value = '') {
  const normalized = normalizeText(value).toLowerCase();
  if (normalized === 'gemini') return 'google';
  if (normalized === 'opencode') return 'opencode-go';
  return Object.hasOwn(PI_PROVIDER_DEFINITIONS, normalized) ? normalized : '';
}

export function isKnownPiProviderModel(provider, model = '') {
  const normalizedProvider = normalizePiProvider(provider);
  const normalizedModel = normalizeText(model);
  if (!normalizedProvider || !normalizedModel) return false;
  return (PI_FALLBACK_MODELS[normalizedProvider] || []).some((entry) => entry.id === normalizedModel);
}

function resolveOptions(options) {
  const env = options.env ?? process.env;
  return {
    forceRefresh: options.forceRefresh === true,
    execImpl: options.execImpl ?? exec,
    piBin: normalizeText(options.binary ?? options.piBin ?? env.PI_BIN) || 'pi',
    cacheFile: resolve(options.cacheFile ?? env.PI_MODEL_CATALOG_CACHE_FILE ?? DEFAULT_CACHE_FILE),
    ttlMs: positiveNumber(options.ttlMs ?? env.PI_MODEL_CATALOG_TTL_MS, DEFAULT_CACHE_TTL_MS),
    timeoutMs: positiveNumber(options.timeoutMs ?? env.PI_MODEL_CATALOG_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    now: typeof options.now === 'function' ? options.now : () => Date.now(),
    env,
  };
}

async function refreshCatalog(settings) {
  const fetchedAt = settings.now();
  try {
    const result = await settings.execImpl(settings.piBin, ['--list-models'], {
      timeout: settings.timeoutMs,
      env: settings.env,
    });
    if (result?.code !== 0) throw classifyExecutionFailure(result, settings.piBin);
    if (piCredentialsMissing(result?.stdout, result?.stderr)) {
      throw piCatalogError(
        'pi_credentials_missing',
        'Pi has no available models. Run pi and use /login to configure provider credentials.',
        400,
      );
    }
    const models = parsePiModelList(result?.stdout);
    if (countModels(models) === 0) {
      throw piCatalogError('pi_catalog_unavailable', 'Pi returned no supported models', 503);
    }
    const catalog = buildCatalog({ fetchedAt, source: 'pi', models });
    await writeCache(settings, catalog);
    return catalog;
  } catch (error) {
    const failure = normalizeDiscoveryFailure(error, settings.piBin);
    const persisted = await readCache(settings);
    if (persisted && countModels(persisted.models) > 0) {
      return { ...persisted, stale: true, ...failure };
    }
    return fallbackCatalog(fetchedAt, failure);
  }
}

function buildCatalog({ fetchedAt, source, models, stale = false, errorCode = '', error = '' }) {
  const normalizedModels = emptyModelMap();
  for (const provider of Object.keys(normalizedModels)) {
    normalizedModels[provider] = sortModels(Array.isArray(models?.[provider]) ? models[provider] : []);
  }

  const providers = Object.values(PI_PROVIDER_DEFINITIONS)
    .filter((definition) => normalizedModels[definition.id].length > 0)
    .map((definition) => ({
      id: definition.id,
      label: definition.label,
      defaultModel: normalizedModels[definition.id].some((entry) => entry.id === definition.defaultModel)
        ? definition.defaultModel
        : normalizedModels[definition.id][0].id,
    }));

  return { fetchedAt, source, stale, errorCode, error, providers, models: normalizedModels };
}

function fallbackCatalog(fetchedAt, failure = {}) {
  return buildCatalog({
    fetchedAt,
    source: 'fallback',
    ...failure,
    models: Object.fromEntries(Object.entries(PI_FALLBACK_MODELS)
      .map(([provider, models]) => [provider, models.map((entry) => ({ ...entry }))])),
  });
}

function emptyModelMap() {
  return Object.fromEntries(Object.keys(PI_PROVIDER_DEFINITIONS).map((provider) => [provider, []]));
}

function countModels(models = {}) {
  return Object.values(models).reduce((count, entries) => count + (Array.isArray(entries) ? entries.length : 0), 0);
}

function isFresh(entry, now, ttlMs) {
  return Boolean(entry && Number.isFinite(entry.fetchedAt) && now - entry.fetchedAt < ttlMs);
}

function createCacheStore(settings) {
  return buildPostgresJsonStore({
    namespace: 'pi_model_catalog_cache',
    filePath: settings.cacheFile,
    env: settings.env,
    modeEnvKey: 'PI_MODEL_CATALOG_STORAGE',
  });
}

async function readCache(settings) {
  try {
    const raw = await createCacheStore(settings).load();
    if (!raw || !Number.isFinite(raw.fetchedAt) || !raw.models || typeof raw.models !== 'object') return null;
    return buildCatalog({
      fetchedAt: raw.fetchedAt,
      source: normalizeText(raw.source) || 'cache',
      stale: raw.stale === true,
      errorCode: normalizeText(raw.errorCode),
      error: normalizeText(raw.error),
      models: raw.models,
    });
  } catch {
    return null;
  }
}

async function writeCache(settings, catalog) {
  try {
    await createCacheStore(settings).save(catalog);
  } catch {
    // Best effort.
  }
}

function cloneCatalog(catalog) {
  return {
    ...catalog,
    providers: catalog.providers.map((entry) => ({ ...entry })),
    models: Object.fromEntries(Object.entries(catalog.models)
      .map(([provider, models]) => [provider, models.map((entry) => ({ ...entry }))])),
  };
}

function sortModels(models = []) {
  const unique = new Map();
  for (const entry of models) {
    const id = normalizeText(entry?.id);
    if (!id) continue;
    unique.set(id, { id, label: normalizeText(entry?.label) || prettifyModelId(id) });
  }
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function prettifyModelId(value = '') {
  return normalizeText(value)
    .replace(/-/g, ' ')
    .replace(/\b(gpt|grok|gemini)\b/gi, (match) => match.toLowerCase() === 'gpt' ? 'GPT' : `${match[0].toUpperCase()}${match.slice(1).toLowerCase()}`)
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(value = '') {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function piCredentialsMissing(...values) {
  const text = values.map((value) => normalizeText(value)).filter(Boolean).join('\n');
  return /no models available|use\s+\/login|not authenticated|login required/i.test(text);
}

function classifyExecutionFailure(result = {}, piBin = 'pi') {
  const code = result?.code;
  const detail = normalizeText(result?.stderr) || normalizeText(result?.stdout);
  if (code === 'ENOENT' || /(?:command not found|no such file or directory)/i.test(detail)) {
    return piCatalogError('pi_binary_missing', `Pi CLI binary not found: ${piBin}`, 503);
  }
  if (piCredentialsMissing(detail)) {
    return piCatalogError(
      'pi_credentials_missing',
      'Pi has no available models. Run pi and use /login to configure provider credentials.',
      400,
    );
  }
  return piCatalogError(
    'pi_catalog_unavailable',
    detail || `Pi model discovery failed with code ${code}`,
    503,
  );
}

function normalizeDiscoveryFailure(error, piBin) {
  if (error?.code === 'ENOENT' || error?.code === 'pi_binary_missing') {
    return { errorCode: 'pi_binary_missing', error: `Pi CLI binary not found: ${piBin}` };
  }
  if (error?.code === 'pi_credentials_missing' || piCredentialsMissing(error?.message)) {
    return {
      errorCode: 'pi_credentials_missing',
      error: error?.message || 'Pi has no available models. Run pi and use /login to configure provider credentials.',
    };
  }
  return {
    errorCode: 'pi_catalog_unavailable',
    error: error?.message || 'Pi model discovery failed',
  };
}

function unsupportedModelError(provider, model, models) {
  const allowed = models.map((entry) => entry.id).join(', ');
  return piCatalogError(
    'pi_model_unsupported',
    `Unsupported ${PI_PROVIDER_DEFINITIONS[provider].label} model "${model}". Allowed models: ${allowed}`,
    400,
  );
}

function piCatalogError(code, message, statusCode) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}
