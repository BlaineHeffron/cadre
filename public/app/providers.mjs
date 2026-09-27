export const AGENT_PROVIDER_DESCRIPTORS = {
  claude: {
    kind: 'claude',
    label: 'Claude',
    apiBase: '/claude',
    routeBase: '/claude',
    sessionStorageKey: 'dueno_seen_sessions',
    attentionStorageKey: 'dueno_seen_claude_prompt_notifications',
    bootstrapStorageKey: 'dueno_last_claude_bootstrap',
    hasShiftTab: true,
    hasSlash: true,
    hasImage: true,
    enterSubmits: false,
  },
  codex: {
    kind: 'codex',
    label: 'Codex',
    apiBase: '/codex',
    routeBase: '/codex',
    sessionStorageKey: 'dueno_seen_codex_sessions',
    attentionStorageKey: 'dueno_seen_codex_prompt_notifications',
    bootstrapStorageKey: 'dueno_last_codex_bootstrap',
    hasShiftTab: false,
    hasSlash: false,
    hasImage: true,
    enterSubmits: true,
  },
  pi: {
    kind: 'pi',
    label: 'Pi',
    apiBase: '/pi',
    routeBase: '/pi',
    sessionStorageKey: 'dueno_seen_pi_sessions',
    attentionStorageKey: 'dueno_seen_pi_prompt_notifications',
    bootstrapStorageKey: 'dueno_last_pi_bootstrap',
    hasShiftTab: false,
    hasSlash: false,
    hasImage: true,
    enterSubmits: true,
  },
  deepseek: {
    kind: 'deepseek',
    label: 'DeepSeek Harness',
    apiBase: '/deepseek',
    routeBase: '/deepseek',
    sessionStorageKey: 'dueno_seen_deepseek_sessions',
    attentionStorageKey: 'dueno_seen_deepseek_prompt_notifications',
    bootstrapStorageKey: 'dueno_last_deepseek_bootstrap',
    hasShiftTab: false,
    hasSlash: false,
    hasImage: false,
    enterSubmits: true,
  },
};

export const AGENT_PROVIDER_KINDS = Object.keys(AGENT_PROVIDER_DESCRIPTORS);

export function normalizeAgentProviderKind(kind = '') {
  const normalized = String(kind || '').trim().toLowerCase();
  if (normalized === 'openai' || normalized === 'chatgpt') return 'codex';
  if (normalized === 'anthropic' || normalized === 'claude-code') return 'claude';
  if (normalized === 'dsh' || normalized === 'deepseek-harness') return 'deepseek';
  return normalized;
}

export function providerDescriptor(kind) {
  const normalized = normalizeAgentProviderKind(kind);
  return AGENT_PROVIDER_DESCRIPTORS[normalized] || AGENT_PROVIDER_DESCRIPTORS.claude;
}

export function isKnownAgentProvider(kind) {
  return Object.hasOwn(AGENT_PROVIDER_DESCRIPTORS, normalizeAgentProviderKind(kind));
}
