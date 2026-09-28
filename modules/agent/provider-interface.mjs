import { DEFAULT_CLAUDE_MODEL, DEFAULT_CODEX_MODEL } from '../sessions/provider-models.mjs';
import { assertValidClaudeModel, isKnownClaudeModel, normalizeClaudeModel } from '../sessions/claude-models.mjs';
import { assertValidCodexModel, isKnownCodexModel } from '../sessions/codex-models.mjs';
import { assertPiProviderModel, isKnownPiProviderModel, PI_PROVIDER_DEFINITIONS } from '../sessions/pi-model-catalog.mjs';
import { createBaseCapabilities } from './agent-transport.mjs';
import { codexAppServerCapabilities } from './codex-app-server-transport.mjs';
import {
  deepSeekBusE2eEvidence,
  deepSeekCollaborationEligible,
  deepSeekMcpCatalogCapabilities,
} from '../sessions/deepseek-mcp.mjs';
import {
  claudeStreamJsonBusE2eEvidence,
  claudeStreamJsonCollaborationEligible,
  claudeStreamJsonMcpCapabilities,
  readClaudeStreamJsonVersionSync,
} from '../sessions/claude-stream-json-mcp.mjs';

function claudeStreamJsonTransportCapabilities(e2eEvidence) {
  return createBaseCapabilities({
    protocol: { name: 'claude-stream-json', version: '1' },
    delivery: 'structured', cancellation: 'best_effort',
    interaction: { permissions: 'structured_options', elicitation: false, questions: true, answerOnce: true },
    streaming: 'delta_plus_committed',
    streamFeatures: { tool_events: true, thought_events: true, plan: false, usage: true },
    transcript: 'committed_text',
    recovery: { processSurvivesFleetRestart: false, fleetRecoverable: 'none' },
    identity: 'connection_bound',
    ...claudeStreamJsonMcpCapabilities({ discoveryProven: true, e2eEvidence }),
    promptCapabilities: {
      types: ['text', 'image'], deliveryMode: 'inline',
      mimeAllowlist: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      maxBytes: 8 * 1024 * 1024, maxCount: 8, maxSessionBytes: 64 * 1024 * 1024,
    },
    runtimeSharing: 'exclusive',
  });
}

function deepSeekTransportCapabilities(e2eEvidence = deepSeekBusE2eEvidence()) {
  return createBaseCapabilities({
    protocol: { name: 'acp', version: '1' },
    delivery: 'structured',
    cancellation: 'best_effort',
    interaction: { permissions: 'structured_options', elicitation: false, answerOnce: true },
    streaming: 'committed_messages',
    streamFeatures: { tool_events: false, thought_events: false, plan: false, usage: false },
    transcript: 'committed_text',
    recovery: { processSurvivesFleetRestart: false, fleetRecoverable: 'none' },
    identity: 'connection_bound',
    ...deepSeekMcpCatalogCapabilities({ e2eEvidence }),
    runtimeSharing: 'exclusive',
  });
}

function tmuxTransportCapabilities() {
  return createBaseCapabilities({
    protocol: { name: 'tmux', version: '1' },
    delivery: 'keystroke',
    cancellation: 'best_effort',
    interaction: { permissions: 'scraped_options', elicitation: false, answerOnce: false },
    streaming: 'pane_poll',
    transcript: 'pane_render',
    recovery: { processSurvivesFleetRestart: true, fleetRecoverable: 'attach_live_process' },
    identity: 'env_asserted',
    busParticipation: 'authenticated_scoped',
    promptCapabilities: {
      types: ['text', 'image'],
      deliveryMode: 'reference',
      mimeAllowlist: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      maxBytes: 8 * 1024 * 1024,
      maxCount: 8,
      maxSessionBytes: 64 * 1024 * 1024,
    },
  });
}

const PROVIDER_DEFINITIONS = Object.freeze({
  codex: Object.freeze({
    id: 'codex',
    label: 'Codex',
    backendType: 'codex',
    runtime: 'codex',
    backendProvider: 'codex',
    defaultModel: DEFAULT_CODEX_MODEL,
    get transportCapabilities() { return tmuxTransportCapabilities(); },
  }),
  'codex-app-server': Object.freeze({
    id: 'codex-app-server', label: 'Codex App Server', backendType: 'codex-app-server',
    runtime: 'codex', backendProvider: 'codex-app-server', defaultModel: DEFAULT_CODEX_MODEL,
    supportsInteractiveSessions: false, supportsCollaboration: false, supportsOneOffTasks: false, oneOffExecutionMode: 'unsupported', experimental: true,
    get transportCapabilities() { return codexAppServerCapabilities(); },
  }),
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude',
    backendType: 'claude',
    runtime: 'claude',
    backendProvider: 'claude',
    defaultModel: DEFAULT_CLAUDE_MODEL,
    get transportCapabilities() { return tmuxTransportCapabilities(); },
  }),
  deepseek: Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek Harness',
    backendType: 'deepseek',
    runtime: 'deepseek',
    backendProvider: 'deepseek',
    defaultModel: 'deepseek-v4-pro',
    models: Object.freeze(['deepseek-v4-pro', 'deepseek-v4-flash']),
    supportsInteractiveSessions: true,
    supportsOneOffTasks: false,
    oneOffExecutionMode: 'unsupported',
    experimental: true,
    get transportCapabilities() { return deepSeekTransportCapabilities(); },
  }),
  xai: Object.freeze({
    id: 'xai',
    label: PI_PROVIDER_DEFINITIONS.xai.label,
    backendType: 'pi',
    runtime: 'pi',
    backendProvider: 'xai',
    defaultModel: PI_PROVIDER_DEFINITIONS.xai.defaultModel,
    get transportCapabilities() { return tmuxTransportCapabilities(); },
  }),
  google: Object.freeze({
    id: 'google',
    label: PI_PROVIDER_DEFINITIONS.google.label,
    backendType: 'pi',
    runtime: 'pi',
    backendProvider: 'google',
    defaultModel: PI_PROVIDER_DEFINITIONS.google.defaultModel,
    get transportCapabilities() { return tmuxTransportCapabilities(); },
  }),
  'opencode-go': Object.freeze({
    id: 'opencode-go',
    label: PI_PROVIDER_DEFINITIONS['opencode-go'].label,
    backendType: 'pi',
    runtime: 'pi',
    backendProvider: 'opencode-go',
    defaultModel: PI_PROVIDER_DEFINITIONS['opencode-go'].defaultModel,
    get transportCapabilities() { return tmuxTransportCapabilities(); },
  }),
  openrouter: Object.freeze({
    id: 'openrouter',
    label: PI_PROVIDER_DEFINITIONS.openrouter.label,
    backendType: 'pi',
    runtime: 'pi',
    backendProvider: 'openrouter',
    defaultModel: PI_PROVIDER_DEFINITIONS.openrouter.defaultModel,
    get transportCapabilities() { return tmuxTransportCapabilities(); },
  }),
});

export function normalizeAgentProvider(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized === 'anthropic') return 'claude';
  if (normalized === 'openai' || normalized === 'openai-codex' || normalized === 'chatgpt') return 'codex';
  if (normalized === 'gemini') return 'google';
  if (normalized === 'opencode') return 'opencode-go';
  if (normalized === 'dsh' || normalized === 'deepseek-harness') return 'deepseek';
  return normalized;
}

export function inferAgentProviderFromModel(model = '') {
  const normalized = String(model || '').trim().toLowerCase();
  if (!normalized) return '';
  const normalizedClaudeModel = normalizeClaudeModel(normalized).toLowerCase();
  if (normalizedClaudeModel.startsWith('claude')) return 'claude';
  if (
    normalized.startsWith('gpt')
    || normalized.startsWith('o')
    || normalized.includes('codex')
  ) return 'codex';
  if (normalized.startsWith('grok')) return 'xai';
  if (normalized.startsWith('gemini')) return 'google';
  // DSH owns model selection in its profile configuration. DeepSeek model IDs
  // exposed by Pi remain OpenCode Go models rather than implying this harness.
  if (
    normalized.startsWith('glm-')
    || normalized.startsWith('kimi-')
    || normalized.startsWith('deepseek-')
    || normalized.startsWith('minimax-')
    || normalized.startsWith('mimo-')
    || normalized.startsWith('qwen')
    || normalized === 'hy3'
  ) return 'opencode-go';
  return '';
}

export function getAgentProviderDefinition(provider) {
  const normalized = normalizeAgentProvider(provider);
  return PROVIDER_DEFINITIONS[normalized] || null;
}

/**
 * Providers that run on one session backend. `claude` and `codex` have exactly one;
 * the Pi backend runs several providers, so a `pi` ref never implies
 * a provider on its own.
 */
export function agentProvidersForBackendType(backendType = '') {
  const normalized = String(backendType || '').trim().toLowerCase();
  if (!normalized) return [];
  return listAgentProviderDefinitions()
    .filter((definition) => definition.backendType === normalized)
    .map((definition) => definition.id);
}

/** Resolve a provider id (`xai`) or a backend type (`pi`) to its backend type. */
export function resolveAgentBackendType(value = '') {
  const normalized = normalizeAgentProvider(value);
  if (!normalized) return '';
  const definition = getAgentProviderDefinition(normalized);
  if (definition) return definition.backendType;
  return agentProvidersForBackendType(normalized).length > 0 ? normalized : '';
}

export function listAgentProviderDefinitions() {
  return Object.values(PROVIDER_DEFINITIONS);
}

export function resolveAgentProviderSelection({
  provider = '',
  model = '',
  fallbackProvider = 'codex',
} = {}) {
  const normalizedProvider = normalizeAgentProvider(provider);
  const resolvedProvider = normalizedProvider || normalizeAgentProvider(fallbackProvider) || 'codex';

  const definition = getAgentProviderDefinition(resolvedProvider);
  if (!definition) {
    const error = new Error('provider must be claude, codex, codex-app-server, deepseek, xai, google, opencode-go, or openrouter');
    error.statusCode = 400;
    throw error;
  }

  const rawModel = String(model || '').trim();
  const normalizedModel = definition.id === 'claude' ? normalizeClaudeModel(rawModel) : rawModel;
  return {
    ...definition,
    providerId: definition.id,
    provider: definition.id,
    model: normalizedModel || definition.defaultModel || '',
  };
}

export function isModelCompatibleWithProvider(provider, model = '') {
  const definition = getAgentProviderDefinition(provider);
  if (!definition) return false;
  const rawModel = String(model || '').trim();
  if (!rawModel) return true;
  const normalizedModel = definition.id === 'claude' ? normalizeClaudeModel(rawModel) : rawModel;

  if (['codex', 'codex-app-server'].includes(definition.backendType)) return isKnownCodexModel(normalizedModel);
  if (definition.backendType === 'claude') return isKnownClaudeModel(normalizedModel);
  if (definition.backendType === 'deepseek') return definition.models.includes(normalizedModel);
  return isKnownPiProviderModel(definition.id, normalizedModel);
}

/**
 * Resolve a configured provider/model pair so the two cannot desync.
 * An unset model uses the resolved provider's defaultModel. An explicit
 * incompatible pair logs loudly and falls back to that default.
 */
export function resolveCompatibleProviderModelPair({
  provider = '',
  model = '',
  fallbackProvider = 'codex',
  allowEmpty = false,
  label = 'agent',
  logger = console,
} = {}) {
  const rawProvider = String(provider || '').trim();
  const rawModel = String(model || '').trim();
  // Incomplete watcher overrides must stay incomplete so a later inherit
  // step can pair the pinned field with githubAgents (or another fallback).
  if (allowEmpty && !rawProvider) {
    return { provider: '', model: rawModel };
  }

  const selection = resolveAgentProviderSelection({
    provider: rawProvider,
    model: '',
    fallbackProvider,
  });
  if (!rawModel) {
    return { provider: selection.provider, model: selection.defaultModel || '' };
  }

  const resolved = resolveAgentProviderSelection({
    provider: rawProvider || selection.provider,
    model: rawModel,
    fallbackProvider: selection.provider,
  });
  if (isModelCompatibleWithProvider(resolved.provider, resolved.model)) {
    return { provider: resolved.provider, model: resolved.model };
  }

  const fallbackModel = selection.defaultModel || '';
  logger.error(
    `${label}: incompatible provider/model pair ${resolved.provider}/${resolved.model}; falling back to ${resolved.provider}/${fallbackModel}`,
  );
  return { provider: resolved.provider, model: fallbackModel };
}

export async function assertAgentProviderModelPair(provider, model = '', options = {}) {
  const selection = resolveAgentProviderSelection({ provider, model });
  if (['codex', 'codex-app-server'].includes(selection.backendType)) {
    await assertValidCodexModel(selection.model, options);
  } else if (selection.backendType === 'claude') {
    await assertValidClaudeModel(selection.model, options);
  } else if (selection.backendType === 'deepseek') {
    if (!selection.model || !selection.models.includes(selection.model)) {
      const error = new Error(`Unsupported DeepSeek Harness model "${selection.model}". Allowed models: ${selection.models.join(', ')}`);
      error.statusCode = 400;
      throw error;
    }
  } else {
    await assertPiProviderModel(selection.provider, selection.model, options);
  }
  return selection;
}

export function buildAgentProviderCatalog(preferences = {}, {
  deepSeekE2eEvidence = deepSeekBusE2eEvidence(),
  claudeStreamJsonEnabled = /^(1|true|yes)$/i.test(String(process.env.CLAUDE_STREAM_JSON_ENABLED || '')),
  claudeStreamJsonE2eEvidence = null,
  codexAppServerEvidence = null,
  codexAppServerEnabled = false,
} = {}) {
  const claudeE2eEvidence = claudeStreamJsonE2eEvidence || (claudeStreamJsonEnabled
    ? claudeStreamJsonBusE2eEvidence({ cliVersion: readClaudeStreamJsonVersionSync() })
    : { proven: false });
  return listAgentProviderDefinitions().map((definition) => {
    const legacyKey = `${definition.id}Enabled`;
    const piEnabled = definition.backendType !== 'pi'
      || (preferences?.piEnabled !== false && preferences?.pi !== false);
    const enabled = definition.id === 'deepseek'
      ? preferences?.deepseekEnabled === true || preferences?.deepseek === true
      : definition.id === 'codex-app-server'
        ? codexAppServerEnabled || preferences?.['codex-app-server'] === true
      : piEnabled && preferences?.[legacyKey] !== false && preferences?.[definition.id] !== false;
    const transportCapabilities = definition.id === 'deepseek'
      ? deepSeekTransportCapabilities(deepSeekE2eEvidence)
      : definition.id === 'codex-app-server'
        ? codexAppServerCapabilities(codexAppServerEvidence)
      : definition.id === 'claude' && claudeStreamJsonEnabled
        ? claudeStreamJsonTransportCapabilities(claudeE2eEvidence)
        : definition.transportCapabilities || null;
    const supportsCollaboration = definition.id === 'deepseek'
      ? deepSeekCollaborationEligible(transportCapabilities)
      : definition.id === 'codex-app-server'
        ? false // Individual task startup must prove authenticated room read/reply.
      : definition.id === 'claude' && claudeStreamJsonEnabled
        ? claudeStreamJsonCollaborationEligible(transportCapabilities)
        : definition.supportsCollaboration !== false;
    return {
      id: definition.id,
      label: definition.label,
      enabled,
      backendType: definition.backendType,
      sessionKind: definition.backendType,
      runtime: definition.runtime,
      backendProvider: definition.backendProvider,
      defaultModel: definition.defaultModel,
      supportsInteractiveSessions: definition.supportsInteractiveSessions !== false,
      supportsCollaboration,
      supportsOneOffTasks: definition.supportsOneOffTasks !== false,
      oneOffExecutionMode: definition.oneOffExecutionMode || 'ephemeral_session_fallback',
      experimental: definition.experimental === true,
      transportCapabilities,
    };
  });
}
