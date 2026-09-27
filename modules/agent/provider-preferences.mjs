import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildAgentProviderCatalog } from './provider-interface.mjs';
import {
  DEFAULT_CODEX_MODEL,
  FAST_CLAUDE_MODEL,
  defaultModelForSpawnType as unifiedDefaultModelForSpawnType,
} from '../sessions/provider-models.mjs';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { legacyRootStatePath, runtimeStatePath } from '../ops/runtime-state.mjs';

const DEFAULT_STORE_FILE = runtimeStatePath('agent_provider_preferences.json');
const LEGACY_STORE_FILE = legacyRootStatePath('agent_provider_preferences.json');

const DEFAULT_PREFERENCES = Object.freeze({
  claude: true,
  codex: true,
  deepseek: false,
  pi: true,
  headroomEnabled: true,
});

function normalizePreferences(input = {}) {
  const normalized = {
    claude: input?.claudeEnabled === false ? false : input?.claude !== false,
    codex: input?.codexEnabled === false ? false : input?.codex !== false,
    deepseek: input?.deepseekEnabled === true || input?.deepseek === true,
    pi: input?.piEnabled === false ? false : input?.pi !== false,
    headroomEnabled: input?.headroomEnabled !== false,
  };
  if (!normalized.claude && !normalized.codex && !normalized.deepseek && !normalized.pi) {
    throw new Error('At least one agent provider must remain enabled');
  }
  return normalized;
}

function defaultMetadata(preferences) {
  const normalized = normalizePreferences(preferences);
  return {
    ...normalized,
    claudeEnabled: normalized.claude,
    codexEnabled: normalized.codex,
    deepseekEnabled: normalized.deepseek,
    piEnabled: normalized.pi,
    collabEnabled: availableInteractiveProviders(normalized).length >= 2,
    availableSpawnTypes: availableSpawnTypes(normalized),
    availableProviders: availableProviders(normalized),
    preferredSingleAgent: preferredSingleAgent(normalized),
    preferredSingleProvider: preferredSingleProvider(normalized),
    providerCatalog: buildAgentProviderCatalog(normalized),
  };
}

function resolveStoreFile(storeFile) {
  return resolve(storeFile || process.env.AGENT_PROVIDER_PREFERENCES_FILE || DEFAULT_STORE_FILE);
}

function readStoreSync(storeFile) {
  const resolvedStoreFile = resolveStoreFile(storeFile);
  if (!existsSync(resolvedStoreFile)) return { ...DEFAULT_PREFERENCES };
  try {
    return normalizePreferences(JSON.parse(readFileSync(resolvedStoreFile, 'utf8')));
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

async function readStore(storeFile) {
  const resolvedStoreFile = resolveStoreFile(storeFile);
  const stateStore = buildPostgresJsonStore({
    namespace: 'agent_provider_preferences',
    filePath: resolvedStoreFile,
    legacyFilePath: storeFile ? undefined : LEGACY_STORE_FILE,
    modeEnvKey: 'AGENT_PROVIDER_PREFERENCES_STORAGE',
    keepFileMirror: true,
  });
  try {
    const value = await stateStore.load();
    return normalizePreferences(value || DEFAULT_PREFERENCES);
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

async function writeStore(preferences, storeFile) {
  const resolvedStoreFile = resolveStoreFile(storeFile);
  const stateStore = buildPostgresJsonStore({
    namespace: 'agent_provider_preferences',
    filePath: resolvedStoreFile,
    legacyFilePath: storeFile ? undefined : LEGACY_STORE_FILE,
    modeEnvKey: 'AGENT_PROVIDER_PREFERENCES_STORAGE',
    keepFileMirror: true,
  });
  await stateStore.save(preferences);
}

export function getAgentProviderPreferencesSync({ storeFile } = {}) {
  return defaultMetadata(readStoreSync(storeFile));
}

export async function getAgentProviderPreferences({ storeFile } = {}) {
  return defaultMetadata(await readStore(storeFile));
}

export async function updateAgentProviderPreferences(input = {}, { storeFile } = {}) {
  if (input.headroomEnabled !== undefined && typeof input.headroomEnabled !== 'boolean') {
    throw new TypeError('headroomEnabled must be a boolean');
  }
  const current = await readStore(storeFile);
  const next = normalizePreferences({
    ...current,
    ...input,
  });
  await writeStore(next, storeFile);
  return defaultMetadata(next);
}

export function availableSpawnTypes(preferences = DEFAULT_PREFERENCES, capabilityOptions = {}) {
  const normalized = normalizePreferences(preferences);
  const types = [];
  if (normalized.claude) types.push('claude');
  if (normalized.codex) types.push('codex');
  if (normalized.deepseek) types.push('deepseek');
  if (normalized.pi) types.push('pi');
  if (availableInteractiveProviders(normalized, capabilityOptions).length >= 2) types.push('collab');
  return types;
}

export function availableProviders(preferences = DEFAULT_PREFERENCES) {
  return buildAgentProviderCatalog(preferences)
    .filter((entry) => entry.enabled)
    .map((entry) => entry.id);
}

export function availableInteractiveProviders(preferences = DEFAULT_PREFERENCES, capabilityOptions = {}) {
  return buildAgentProviderCatalog(normalizePreferences(preferences), capabilityOptions)
    .filter((entry) => entry.enabled && entry.supportsInteractiveSessions && entry.supportsCollaboration)
    .map((entry) => entry.id);
}

export function preferredSingleAgent(preferences = DEFAULT_PREFERENCES) {
  const normalized = normalizePreferences(preferences);
  if (normalized.codex) return 'codex';
  if (normalized.claude) return 'claude';
  if (normalized.deepseek) return 'deepseek';
  if (normalized.pi) return 'pi';
  return '';
}

export function preferredSingleProvider(preferences = DEFAULT_PREFERENCES) {
  const normalized = normalizePreferences(preferences);
  if (normalized.codex) return 'codex';
  if (normalized.claude) return 'claude';
  if (normalized.deepseek) return 'deepseek';
  if (normalized.pi) return 'xai';
  return '';
}

export function resolveSpawnType(requested, preferences = DEFAULT_PREFERENCES) {
  const normalizedPreferences = normalizePreferences(preferences);
  const normalized = String(requested || '').trim().toLowerCase();
  if (normalized === 'collab') {
    return availableInteractiveProviders(normalizedPreferences).length >= 2 ? 'collab' : preferredSingleAgent(normalizedPreferences);
  }
  if (normalized === 'claude') {
    return normalizedPreferences.claude ? 'claude' : preferredSingleAgent(normalizedPreferences);
  }
  if (normalized === 'codex') {
    return normalizedPreferences.codex ? 'codex' : preferredSingleAgent(normalizedPreferences);
  }
  if (normalized === 'pi') {
    return normalizedPreferences.pi ? 'pi' : preferredSingleAgent(normalizedPreferences);
  }
  if (normalized === 'deepseek') {
    return normalizedPreferences.deepseek ? 'deepseek' : preferredSingleAgent(normalizedPreferences);
  }
  return preferredSingleAgent(normalizedPreferences);
}

export function defaultModelForSpawnType(spawnType, { fast = false } = {}) {
  return unifiedDefaultModelForSpawnType(spawnType, { fast });
}

export function resolveTaskModel(requestedModel, spawnType, { fast = false } = {}) {
  const normalized = String(requestedModel || '').trim();
  return normalized || defaultModelForSpawnType(spawnType, { fast });
}

export function resolveCollabModels(preferences = DEFAULT_PREFERENCES, requested = {}, capabilityOptions = {}) {
  const normalized = normalizePreferences(preferences);
  const codexModel = String(requested?.codexModel || '').trim() || DEFAULT_CODEX_MODEL;
  const claudeModel = String(requested?.claudeModel || '').trim() || FAST_CLAUDE_MODEL;
  return {
    codexModel,
    claudeModel,
    enabled: availableInteractiveProviders(normalized, capabilityOptions).length >= 2,
  };
}

export async function agentProviderPreferencesPlugin(app, opts = {}) {
  app.get('/api/agent-provider-preferences', async () => getAgentProviderPreferences(opts));
  app.put('/api/agent-provider-preferences', async (req, reply) => {
    try {
      return await updateAgentProviderPreferences(req.body || {}, opts);
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });
}
