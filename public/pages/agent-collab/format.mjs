export const DEFAULT_CONFERENCE_PROVIDERS = ['codex', 'claude'];

export function fmtTime(ts) {
  if (!ts) return '-';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '-';
  }
}

export function agentLabel(ref) {
  if (!ref) return 'unknown';
  if (ref.display_name || ref.displayName) return ref.display_name || ref.displayName;
  const kind = ref.kind || 'agent';
  const sessionId = ref.sessionId || '?';
  if (kind === 'user' && sessionId === 'dashboard') return 'you';
  return `${kind}:${sessionId}`;
}

export function participantSummary(participants) {
  return (participants || []).map(agentLabel).join(' -> ');
}

export function createConferenceParticipant(provider = 'codex') {
  return {
    provider,
    mode: 'new',
    sessionId: '',
    model: '',
    thinkingLevel: '',
    initialTask: '',
    mcpProfile: 'dueno',
    mcpServers: { add: [], remove: [] },
  };
}

export function uniqueProviders(providers = []) {
  return [...new Set((providers || []).map((provider) => normalizeConferenceProvider(provider)).filter(Boolean))];
}

export function defaultConferenceParticipants(providers = DEFAULT_CONFERENCE_PROVIDERS) {
  const normalized = uniqueProviders(providers);
  if (normalized.length === 0) {
    return DEFAULT_CONFERENCE_PROVIDERS.map((provider) => createConferenceParticipant(provider));
  }
  if (normalized.length === 1) {
    return [createConferenceParticipant(normalized[0]), createConferenceParticipant(normalized[0])];
  }
  return normalized.slice(0, 2).map((provider) => createConferenceParticipant(provider));
}

export function normalizeConferenceProvider(provider) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (!normalized) return 'codex';
  if (normalized === 'anthropic') return 'claude';
  return normalized;
}

export function providerLabel(provider) {
  const normalized = normalizeConferenceProvider(provider);
  if (normalized === 'codex') return 'Codex';
  if (normalized === 'claude') return 'Claude';
  return normalized || 'agent';
}

function providerCatalogEntry(provider, catalog = []) {
  const normalized = normalizeConferenceProvider(provider);
  return (Array.isArray(catalog) ? catalog : [])
    .find((entry) => normalizeConferenceProvider(entry?.id) === normalized) || null;
}

export function providerRuntime(provider, catalog = []) {
  const entry = providerCatalogEntry(provider, catalog);
  if (entry?.runtime) return String(entry.runtime);
  const normalized = normalizeConferenceProvider(provider);
  if (normalized === 'codex') return 'codex';
  if (normalized === 'claude') return 'claude';
  return '';
}

export function sessionKindForProvider(provider, catalog = []) {
  const entry = providerCatalogEntry(provider, catalog);
  if (entry?.sessionKind || entry?.backendType) return String(entry.sessionKind || entry.backendType);
  const normalized = normalizeConferenceProvider(provider);
  if (normalized === 'codex' || normalized === 'claude') return normalized;
  return '';
}

export function sessionDisplayName(session) {
  return session.name || session.sessionName || session.id;
}

export function agentRefKey(ref) {
  if (!ref) return '';
  return `${ref.kind || ''}:${ref.sessionId || ''}`;
}

export function transcriptStageLabel(stage) {
  if (stage === 'protocol') return 'Protocol';
  if (stage === 'startup_prompt') return 'Startup';
  if (stage === 'startup_instruction') return 'Startup';
  if (stage === 'error') return 'Error';
  return stage || 'Entry';
}

export function bootstrapStatusClass(status) {
  if (status === 'failed') return 'badge-critical';
  if (status === 'ready') return 'badge-success';
  if (status === 'protocol_injected' || status === 'startup_instruction_injected') return 'badge-info';
  if (status === 'ready_detected') return 'badge-warning';
  return 'badge-medium';
}

export function bootstrapStatusLabel(status) {
  if (status === 'session_created') return 'Session created';
  if (status === 'session_attached') return 'Existing session';
  if (status === 'ready_detected') return 'Ready detected';
  if (status === 'protocol_injected') return 'Protocol injected';
  if (status === 'startup_instruction_injected') return 'Startup injected';
  if (status === 'ready') return 'Bootstrap complete';
  if (status === 'failed') return 'Bootstrap failed';
  return status || 'Unknown';
}

export function threadStatusClass(status) {
  if (status === 'closed') return 'badge-success';
  return 'badge-info';
}

export function mcpHealthBadgeClass(health) {
  if (!health) return 'badge-medium';
  return health.ok ? 'badge-success' : 'badge-critical';
}

export function mcpHealthLabel(health) {
  if (!health) return 'MCP unknown';
  return health.ok ? 'MCP up' : 'MCP down';
}

export function isActiveThread(thread) {
  return thread?.status === 'open';
}

export function roomLabel(thread) {
  if (!thread?.metadata?.dm) return thread?.title || thread?.id || 'Untitled room';
  return `DM · ${(thread.participants || []).map(agentLabel).join(' & ') || 'participants'}`;
}

export function normalizeSearchText(value) {
  return String(value || '').trim().toLowerCase();
}

export function threadMatchesSearch(thread = {}, query = '') {
  const needle = normalizeSearchText(query);
  if (!needle) return true;
  const haystack = [
    thread.title,
    ...(Array.isArray(thread.lastMessageBodies) ? thread.lastMessageBodies : []),
  ].map(normalizeSearchText).join('\n');
  return haystack.includes(needle);
}
