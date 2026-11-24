import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgentProviderCatalog, isModelCompatibleWithProvider, listAgentProviderDefinitions } from './provider-interface.mjs';
import {
  DEFAULT_CODEX_MODEL,
  FAST_CLAUDE_MODEL,
  defaultModelForSpawnType as unifiedDefaultModelForSpawnType,
} from '../sessions/provider-models.mjs';
import { ANTHROPIC_FALLBACK_MODELS } from '../sessions/model-catalog.mjs';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { legacyRootStatePath, runtimeStatePath } from '../ops/runtime-state.mjs';

const DEFAULT_STORE_FILE = runtimeStatePath('agent_provider_preferences.json');
const LEGACY_STORE_FILE = legacyRootStatePath('agent_provider_preferences.json');
const HEADROOM_USERS_SCRIPT = fileURLToPath(new URL('../../scripts/headroom-users.sh', import.meta.url));

const DEFAULT_PREFERENCES = Object.freeze({
  claude: true,
  codex: true,
  deepseek: false,
  pi: true,
  headroomEnabled: true,
  graderSampleRate: null,
  graderModel: null,
  claudeCodeMode: false,
  jobProviders: {},
});

// Jobs whose provider/model come from envProviderModel in config.mjs; Settings can override each one.
export const JOB_PROVIDER_KEYS = ['githubAgents', 'fleetHygiene', 'dependencyWatch', 'skillsUpstream', 'jobOpportunities', 'repoQuality', 'architectureWatch'];
const JOB_FALLBACK = Object.freeze({ provider: 'claude', model: 'claude-opus-5-5' });

function jobProviderProblem(entry) {
  if (!listAgentProviderDefinitions().some((definition) => definition.id === entry?.provider)) return 'provider must be a known agent provider';
  if (entry.model != null && (typeof entry.model !== 'string' || (entry.model && !isModelCompatibleWithProvider(entry.provider, entry.model)))) {
    return `model must be empty or a ${entry.provider} model`;
  }
  return '';
}

function normalizeJobProviders(input = {}) {
  return Object.fromEntries(JOB_PROVIDER_KEYS
    .filter((job) => input?.[job] && !jobProviderProblem(input[job]))
    .map((job) => [job, { provider: input[job].provider, model: input[job].model || '' }]));
}

const GRADER_MODELS = ANTHROPIC_FALLBACK_MODELS.map((entry) => entry.id);
const validRate = (value) => typeof value === 'number' && value >= 0 && value <= 1;

function normalizePreferences(input = {}) {
  const normalized = {
    // The UI's *Enabled toggle wins over the stored key in both directions.
    claude: (input?.claudeEnabled ?? input?.claude) !== false,
    codex: (input?.codexEnabled ?? input?.codex) !== false,
    deepseek: (input?.deepseekEnabled ?? input?.deepseek) === true,
    pi: (input?.piEnabled ?? input?.pi) !== false,
    headroomEnabled: input?.headroomEnabled !== false,
    // null falls back to the env defaults in config.githubAgents.
    graderSampleRate: validRate(input?.graderSampleRate) ? input.graderSampleRate : null,
    graderModel: GRADER_MODELS.includes(input?.graderModel) ? input.graderModel : null,
    claudeCodeMode: input?.claudeCodeMode === true,
    jobProviders: normalizeJobProviders(input?.jobProviders),
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
    graderModels: GRADER_MODELS,
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
  if (input.claudeCodeMode !== undefined && typeof input.claudeCodeMode !== 'boolean') {
    throw new TypeError('claudeCodeMode must be a boolean');
  }
  if (input.graderSampleRate != null && !validRate(input.graderSampleRate)) {
    throw new TypeError('graderSampleRate must be a number from 0 to 1, or null for the env default');
  }
  if (input.graderModel != null && !GRADER_MODELS.includes(input.graderModel)) {
    throw new TypeError(`graderModel must be one of ${GRADER_MODELS.join(', ')}, or null for the env default`);
  }
  for (const [job, entry] of Object.entries(input.jobProviders || {})) {
    const problem = !JOB_PROVIDER_KEYS.includes(job) ? 'is not a known job' : entry === null ? '' : jobProviderProblem(entry);
    if (problem) throw new TypeError(`jobProviders.${job} ${problem}, or null for the env default`);
  }
  const current = await readStore(storeFile);
  const next = normalizePreferences({
    ...current,
    ...input,
    // A partial map: each named job is replaced, null clears it.
    jobProviders: { ...current.jobProviders, ...input.jobProviders },
  });
  await writeStore(next, storeFile);
  return defaultMetadata(next);
}

// A value saved in Settings overrides the env defaults; read on every merge, so no restart is needed.
export async function resolveGraderSettings(defaults = {}, { storeFile } = {}) {
  const saved = await readStore(storeFile);
  return { sampleRate: saved.graderSampleRate ?? defaults.sampleRate ?? 0, model: saved.graderModel ?? defaults.model };
}

// Settings > the job's current env/code pair; a disabled provider runs on claude/opus with one warning. Read on every launch.
export async function resolveJobProviderModel(job, pair = {}, { storeFile, logger = console } = {}) {
  const preferences = await getAgentProviderPreferences({ storeFile });
  const chosen = preferences.jobProviders[job] || { provider: pair.provider || '', model: pair.model || '' };
  if (preferences.availableProviders.includes(chosen.provider)) return chosen;
  logger.warn(`${job}: provider ${chosen.provider || '(none)'} is disabled; running on ${JOB_FALLBACK.provider}/${JOB_FALLBACK.model}`);
  return { ...JOB_FALLBACK };
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
  const withDefaults = (preferences) => ({ ...preferences, graderDefaults: opts.graderDefaults || null, jobDefaults: opts.jobDefaults || null });
  app.get('/api/agent-provider-preferences', async () => withDefaults(await getAgentProviderPreferences(opts)));
  app.put('/api/agent-provider-preferences', async (req, reply) => {
    let preferences;
    try {
      preferences = await updateAgentProviderPreferences(req.body || {}, opts);
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
    // Production only (smoke servers pass no exec): keep the proxy unit in step with the toggle.
    if (opts.exec && req.body?.headroomEnabled !== undefined) {
      const fail = (error) => ({ code: 1, stdout: '', stderr: error.message });
      const verb = preferences.headroomEnabled ? 'enable' : 'disable';
      let now = true;
      if (!preferences.headroomEnabled) {
        // Live sessions keep the proxy URL in their environment; stopping it would cut them off.
        const users = await opts.exec('bash', [HEADROOM_USERS_SCRIPT]).catch(fail);
        const count = users.code === 0 ? users.stdout.trim() : 'an unknown number of';
        now = count === '0';
        if (!now) req.log.info(`Headroom left running for ${count} process(es) still using it`);
      }
      const args = ['--user', verb, ...(now ? ['--now'] : []), 'dueno-headroom.service'];
      const result = await opts.exec('systemctl', args).catch(fail);
      if (result.code !== 0) req.log.warn({ stderr: result.stderr }, `systemctl ${verb} dueno-headroom.service failed`);
    }
    return withDefaults(preferences);
  });
}
