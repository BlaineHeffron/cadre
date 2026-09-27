import {
  ANTHROPIC_FALLBACK_MODELS,
  OPENAI_FALLBACK_MODELS,
  normalizeModelId,
} from '../sessions/model-catalog.mjs';
import { getAgentProviderDefinition, normalizeAgentProvider } from '../agent/provider-interface.mjs';

export const MCP_AGENT_PROVIDERS = Object.freeze(['claude', 'codex', 'xai', 'google', 'opencode-go', 'openrouter']);
export const MCP_CODEX_MODELS = Object.freeze(OPENAI_FALLBACK_MODELS.map((entry) => entry.id));
export const MCP_CLAUDE_MODELS = Object.freeze(ANTHROPIC_FALLBACK_MODELS.map((entry) => entry.id));
export const MCP_AGENT_MODELS = Object.freeze([...new Set([...MCP_CODEX_MODELS, ...MCP_CLAUDE_MODELS])]);

export const MCP_PROVIDER_SCHEMA = Object.freeze({
  type: 'string',
  description: 'Agent provider ID from monitor_list_agent_providers.',
});

export const MCP_CODEX_MODEL_SCHEMA = Object.freeze({
  type: 'string',
  enum: MCP_CODEX_MODELS,
  description: 'Codex model.',
});

export const MCP_CLAUDE_MODEL_SCHEMA = Object.freeze({
  type: 'string',
  enum: MCP_CLAUDE_MODELS,
  description: 'Claude model.',
});

export const MCP_AGENT_MODEL_SCHEMA = Object.freeze({
  type: 'string',
  description: 'Model ID from the server model catalog for the selected provider.',
});

export function assertMcpProviderModel(provider = '', model = '', { allowEmpty = true } = {}) {
  const normalizedProvider = normalizeAgentProvider(provider);
  const normalizedModel = normalizeModelId(model);
  if (!getAgentProviderDefinition(normalizedProvider)) {
    const error = new Error(`Unsupported agent provider "${normalizedProvider || provider}"`);
    error.statusCode = 400;
    throw error;
  }
  if (!normalizedModel) {
    if (allowEmpty) return '';
    throw unsupportedModelError(normalizedProvider, normalizedModel);
  }
  if (!['claude', 'codex'].includes(normalizedProvider)) return normalizedModel;
  const allowed = normalizedProvider === 'claude' ? MCP_CLAUDE_MODELS : MCP_CODEX_MODELS;
  if (!allowed.includes(normalizedModel)) {
    throw unsupportedModelError(normalizedProvider, normalizedModel);
  }
  return normalizedModel;
}

function unsupportedModelError(provider, model) {
  const allowed = provider === 'claude' ? MCP_CLAUDE_MODELS : MCP_CODEX_MODELS;
  const label = provider === 'claude' ? 'Claude' : 'Codex';
  const error = new Error(`Unsupported ${label} model "${model}". Allowed models: ${allowed.join(', ')}`);
  error.statusCode = 400;
  return error;
}
