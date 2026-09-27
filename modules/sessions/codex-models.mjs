import {
  OPENAI_FALLBACK_MODELS,
  assertProviderModel,
  isProviderModelSupported,
  listProviderModels,
  normalizeModelId,
} from './model-catalog.mjs';
import { DEFAULT_CODEX_MODEL, getPreferredModelForProvider } from './provider-models.mjs';
export { DEFAULT_CODEX_MODEL };

const STABLE_CODEX_MODEL_IDS = new Set(OPENAI_FALLBACK_MODELS.map((entry) => entry.id));

export function normalizeCodexModel(model = '') {
  return normalizeModelId(model);
}

export function isKnownCodexModel(model = '') {
  const normalized = normalizeModelId(model);
  return Boolean(normalized) && STABLE_CODEX_MODEL_IDS.has(normalized);
}

export async function listCodexModels(options = {}) {
  const catalog = await listProviderModels('openai', options);
  return mergeCodexModels(catalog.models);
}

export async function getPreferredCodexModel(options = {}) {
  return getPreferredModelForProvider('codex', options);
}

export async function isValidCodexModel(model = '', options = {}) {
  const normalized = normalizeModelId(model);
  if (!normalized) return false;
  if (isKnownCodexModel(normalized)) return true;
  return isProviderModelSupported('openai', normalized, options);
}

export async function assertValidCodexModel(model = '', options = {}) {
  const normalized = normalizeModelId(model);
  if (!normalized) {
    if (options.allowEmpty !== false) return '';
    return assertProviderModel('openai', model, options);
  }
  if (isKnownCodexModel(normalized)) return normalized;
  return assertProviderModel('openai', normalized, options);
}

export function listFallbackCodexModels() {
  return [...OPENAI_FALLBACK_MODELS];
}

function mergeCodexModels(models = []) {
  const deduped = new Map();
  for (const entry of OPENAI_FALLBACK_MODELS) {
    deduped.set(entry.id, { ...entry });
  }
  for (const entry of models || []) {
    const id = normalizeModelId(entry?.id);
    if (!id) continue;
    deduped.set(id, {
      id,
      label: normalizeModelId(entry?.label) || deduped.get(id)?.label || id,
    });
  }
  return [...deduped.values()].sort((a, b) => a.id.localeCompare(b.id));
}
