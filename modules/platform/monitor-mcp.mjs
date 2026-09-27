/**
 * MCP server exposing Cadre tools for the command center AI.
 * Provides: session management, thread pinging, and timed operations.
 */

import { config } from '../../config.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeAgentProvider, resolveAgentProviderSelection } from '../agent/provider-interface.mjs';
import {
  MCP_AGENT_MODEL_SCHEMA,
  MCP_CLAUDE_MODEL_SCHEMA,
  MCP_CODEX_MODEL_SCHEMA,
  MCP_PROVIDER_SCHEMA,
  assertMcpProviderModel,
} from './mcp-model-schemas.mjs';
import { buildPromptProfileFieldSchema } from '../integrations/prompt-profile-catalog.mjs';
import {
  COORDINATOR_SCHEDULE_PROFILE,
  coordinatorPolicyForContext,
  filterCoordinatorSchedules,
  filterCoordinatorSessions,
  filterCoordinatorThreads,
} from '../agent-bus/coordinator-policy.mjs';

const MCP_SERVERS_SELECTION_SCHEMA = {
  type: 'object',
  properties: {
    add: { type: 'array', uniqueItems: true, items: { type: 'string' } },
    remove: { type: 'array', uniqueItems: true, items: { type: 'string' } },
  },
  additionalProperties: false,
};
const CODEX_PLUGIN_SELECTION_SCHEMA = {
  type: 'object',
  description: 'Per-session Codex installed-plugin selection. remove disables additional plugins; add re-enables plugins and wins over Fleet defaults. Separate from Fleet skills and mcpServers.',
  properties: {
    add: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$' } },
    remove: { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$' } },
  },
  additionalProperties: false,
};
const MCP_SELECTION_SCHEMA_PROPERTIES = {
  mcpProfile: { type: 'string', description: 'Server-owned MCP capability profile ID. Call monitor_list_mcp_servers for options.' },
  mcpServers: MCP_SERVERS_SELECTION_SCHEMA,
  promptProfile: buildPromptProfileFieldSchema(),
  skills: {
    type: 'array',
    uniqueItems: true,
    items: { type: 'string' },
    description: 'Fleet launch skill IDs to compose into the provider-bound startup prompt.',
  },
};

export function buildMonitorMcpServer({ requestImpl }) {
  if (!requestImpl) throw new Error('requestImpl is required');

  const DEFAULT_THREAD_LIMIT = 25;
  const DEFAULT_SESSION_LIMIT = 50;
  const MAX_PAGE_SIZE = 200;
  const callContext = new AsyncLocalStorage();

  async function request(path, opts) {
    const authContext = callContext.getStore()?.authContext || null;
    return requestImpl(path, {
      ...(opts || {}),
      ...(authContext ? { authContext } : {}),
    });
  }

  function normalizeLimit(value, fallback) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, MAX_PAGE_SIZE);
  }

  function normalizeOffset(value) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return parsed;
  }

  function assertLoopSessionArgs({ kind, session_id: sessionId, prompt, interval_seconds: intervalSeconds, max_iterations: maxIterations } = {}) {
    if (!String(kind || '').trim() || !String(sessionId || '').trim() || !String(prompt || '').trim()) {
      throw new Error('kind, session_id, and prompt are required');
    }
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 15 || intervalSeconds > 1296000) {
      throw new Error('interval_seconds must be an integer from 15 to 1296000');
    }
    if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 100) {
      throw new Error('max_iterations must be an integer from 1 to 100');
    }
  }

  function paginate(items, { limit, offset }) {
    const total = Array.isArray(items) ? items.length : 0;
    const page = total === 0 ? [] : items.slice(offset, offset + limit);
    return {
      total,
      limit,
      offset,
      hasMore: offset + page.length < total,
      items: page,
    };
  }

  function assertBootstrapOk(payload = {}) {
    if (payload.bootstrapOk !== false) return;
    const failed = Array.isArray(payload.failedParticipants) ? payload.failedParticipants : [];
    const details = failed
      .map((entry) => {
        const participant = entry?.participant || {};
        const target = `${participant.kind || 'unknown'}:${participant.sessionId || 'unknown'}`;
        const phase = entry?.phase ? ` ${entry.phase}` : '';
        return `${target}${phase}: ${entry?.error || 'startup injection failed'}`;
      })
      .join('; ');
    throw new Error(`Bootstrap incomplete${details ? `: ${details}` : ''}`);
  }

  function pickFields(item, fields) {
    if (!Array.isArray(fields) || fields.length === 0 || !item || typeof item !== 'object') return item;
    return fields.reduce((acc, key) => {
      if (Object.hasOwn(item, key)) acc[key] = item[key];
      return acc;
    }, {});
  }

  function normalizeOptionalBoolean(value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
    return undefined;
  }

  function normalizeProvider(value) {
    return normalizeAgentProvider(value);
  }

  function modelForParticipantProvider(provider, participantModel = '', defaultModel = '') {
    const explicitModel = String(participantModel || '').trim();
    if (explicitModel) {
      assertMcpProviderModel(provider, explicitModel);
      return explicitModel;
    }

    const fallbackModel = String(defaultModel || '').trim();
    if (!fallbackModel) return '';
    try {
      assertMcpProviderModel(provider, fallbackModel);
      return fallbackModel;
    } catch {
      return '';
    }
  }

  function normalizeParticipant(participant = {}, defaults = {}) {
    const sessionId = String(participant.session_id || participant.sessionId || '').trim();
    const selection = resolveAgentProviderSelection({
      provider: participant.provider || participant.kind,
      model: '',
      fallbackProvider: defaults.provider || '',
    });
    const model = modelForParticipantProvider(selection.provider, participant.model, defaults.model);
    const kind = selection.backendType;
    return {
      kind,
      sessionId,
      provider: selection.provider,
      create: sessionId ? participant.create === true : participant.create !== false,
      initialTask: String(participant.initial_task || participant.initialTask || '').trim(),
      model,
      thinkingLevel: String(participant.thinking_level || participant.thinkingLevel || defaults.thinkingLevel || '').trim(),
      displayName: String(participant.display_name || participant.displayName || defaults.displayName || '').trim(),
      workDir: String(participant.work_dir || participant.workDir || defaults.workDir || '').trim(),
      ...(participant.mcpProfile !== undefined
        ? { mcpProfile: participant.mcpProfile }
        : (defaults.mcpProfile !== undefined ? { mcpProfile: defaults.mcpProfile } : {})),
      ...(participant.mcpServers !== undefined
        ? { mcpServers: participant.mcpServers }
        : (defaults.mcpServers !== undefined ? { mcpServers: defaults.mcpServers } : {})),
      ...(selection.runtime === 'codex' && participant.codexPlugins !== undefined
        ? { codexPlugins: participant.codexPlugins }
        : (selection.runtime === 'codex' && defaults.codexPlugins !== undefined ? { codexPlugins: defaults.codexPlugins } : {})),
      ...(participant.promptProfile !== undefined
        ? { promptProfile: participant.promptProfile }
        : (defaults.promptProfile !== undefined ? { promptProfile: defaults.promptProfile } : {})),
      ...(participant.skills !== undefined
        ? { skills: participant.skills }
        : (defaults.skills !== undefined ? { skills: defaults.skills } : {})),
    };
  }

  function normalizeManagerLoopRoles(participants = [], defaults = {}, controlMode = 'manager') {
    if (!Array.isArray(participants) || participants.length < 1 || participants.length > 2) {
      throw new Error('participants must contain one or two entries');
    }
    const normalized = participants.map((participant) => normalizeParticipant(participant, defaults));
    const roles = normalized.map((participant, index) => ({
      ...participant,
      role: String(participants[index]?.role || '').trim().toLowerCase(),
    }));
    if (controlMode === 'bus') {
      const explicitWorker = roles.find((participant) => participant.role === 'worker');
      const explicitManager = roles.find((participant) => participant.role === 'manager');
      const worker = explicitWorker || roles[0];
      if (!worker) {
        throw new Error('bus-controlled loops require a worker participant');
      }
      return roles.map((participant) => ({
        ...participant,
        role: participant === worker ? 'worker' : (participant === explicitManager ? 'manager' : participant.role),
      }));
    }

    if (roles.length !== 2) {
      throw new Error('manager-controlled loops require exactly two participants');
    }
    const manager = roles.find((participant) => participant.role === 'manager');
    const worker = roles.find((participant) => participant.role === 'worker');
    if (!manager || !worker || manager.role === worker.role) {
      throw new Error('participants must assign exactly one `manager` and one `worker` role');
    }
    return roles;
  }

  function resolveExistingManagerLoopParticipant(threadParticipants = [], requestedParticipant, role) {
    if (!requestedParticipant) return null;

    const requestedSessionId = String(requestedParticipant.sessionId || '').trim();
    if (requestedSessionId) {
      const exact = threadParticipants.find((participant) => participant?.sessionId === requestedSessionId);
      if (!exact) {
        throw new Error(`Thread does not contain the requested ${role} session: ${requestedSessionId}`);
      }
      return exact;
    }

    const requestedKind = String(requestedParticipant.kind || '').trim();
    const matches = threadParticipants.filter((participant) => participant?.kind === requestedKind);
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw new Error(`Thread does not contain a ${role} participant matching kind "${requestedKind}"`);
    }
    throw new Error(`Thread has multiple ${requestedKind} participants; provide session_id for the ${role} role`);
  }



  async function getAgentProviderStatus() {
    const payload = await request('/api/agents/providers').catch(() => null);
    const providers = Array.isArray(payload?.providers) ? payload.providers : [];
    if (providers.length === 0) {
      return { known: false, enabled: new Set(), listed: new Set() };
    }

    const listed = new Set(
      providers
        .map((entry) => String(entry?.id || '').trim().toLowerCase())
        .filter(Boolean)
    );

    const enabled = new Set(
      providers
        .filter((entry) => entry?.enabled)
        .map((entry) => String(entry.id || '').trim().toLowerCase())
        .filter(Boolean)
    );

    return { known: true, enabled, listed };
  }

  function assertParticipantsEnabled(
    participants = [],
    providerStatus = { known: false, enabled: new Set(), listed: new Set() }
  ) {
    if (!providerStatus.known) return;

    for (const participant of participants) {
      const provider = String(participant?.provider || '').trim().toLowerCase();
      if (!provider || !providerStatus.listed.has(provider)) continue;
      if (!providerStatus.enabled.has(provider)) {
        const error = new Error(`Provider "${provider}" is disabled`);
        error.statusCode = 400;
        throw error;
      }
    }
  }
  function compactSession(session = {}) {
    const pendingResponse = Boolean(session.pendingResponse || session.state?.pendingResponse);
    const sentAt = session.pendingResponse?.sentAt || session.state?.sentAt || null;
    return {
      id: session.id || '',
      name: session.name || '',
      displayName: session.displayName || '',
      workDir: session.workDir || '',
      source: session.source || '',
      created: session.created ?? null,
      attached: session.attached ?? null,
      pid: session.pid ?? null,
      state: session.state?.state || null,
      stateDetail: session.state?.detail || null,
      needsInput: session.state?.needsInput ?? null,
      status: session.state?.status || null,
      capabilities: session.state?.capabilities || null,
      reason: session.state?.reason || null,
      revision: session.state?.revision ?? null,
      interaction: session.state?.interaction || null,
      runtime: session.state?.runtime || null,
      pendingResponse,
      sentAt,
      attention: !pendingResponse && session.attention?.active
        ? {
            kind: session.attention.kind || null,
            label: session.attention.label || null,
            createdAt: session.attention.createdAt || null,
          }
        : null,
    };
  }

  function compactThreadSummary(thread = {}, detail = {}, { includeMessages = false } = {}) {
    const summary = {
      id: thread.id || '',
      title: thread.title || '',
      status: thread.status || '',
      health: thread.health || 'ok',
      live_process_count: thread.live_process_count ?? 0,
      projectKey: thread.projectKey || '',
      participantCount: Array.isArray(thread.participants) ? thread.participants.length : 0,
      messageCount: detail.messageCount ?? 0,
      deliveryCount: detail.deliveryCount ?? 0,
      createdAt: thread.createdAt ?? null,
      updatedAt: thread.updatedAt ?? null,
      latestMessageAt: detail.latestMessageAt ?? null,
      latestDeliveryAt: detail.latestDeliveryAt ?? null,
    };

    if (includeMessages) {
      summary.messages = Array.isArray(detail.messages) ? detail.messages : [];
      summary.messagesTruncated = detail.messagesTruncated ?? false;
    }

    return summary;
  }

  function buildThreadDetailPath(threadId, { includeMessages = false, messageLimit = 10 } = {}) {
    const params = new URLSearchParams();
    params.set('messageLimit', String(includeMessages ? normalizeLimit(messageLimit, 10) : 0));
    params.set('deliveryLimit', '0');
    return `/api/agent-bus/threads/${encodeURIComponent(threadId)}?${params.toString()}`;
  }

  function resolveSessionBackendType(type = '') {
    const normalized = normalizeProvider(type);
    if (!normalized) {
      const error = new Error('type is required');
      error.statusCode = 400;
      throw error;
    }
    if (['claude', 'codex', 'pi'].includes(normalized)) return normalized;
    return resolveAgentProviderSelection({ provider: normalized }).backendType;
  }

  function buildSessionDetailPath(type, sessionId, { lines = 200 } = {}) {
    const params = new URLSearchParams();
    params.set('lines', String(normalizeLimit(lines, 200)));
    return `/api/${encodeURIComponent(resolveSessionBackendType(type))}/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`;
  }

  function sessionIdFromResult(result = {}) {
    return String(
      result?.session?.id
      || result?.result?.session?.id
      || result?.result?.sessionId
      || result?.id
      || result?.sessionId
      || ''
    ).trim();
  }

  function backendKindForSpawn(provider, result = {}) {
    const backend = String(result?.backendType || result?.session?.backendType || '').trim().toLowerCase();
    if (['claude', 'codex', 'pi'].includes(backend)) return backend;
    return resolveAgentProviderSelection({
      provider,
      model: result?.model || result?.session?.model || '',
    }).backendType;
  }

  async function bestEffortAttachParticipant(threadId, participant) {
    const normalizedThreadId = String(threadId || '').trim();
    if (!normalizedThreadId || !participant?.kind || !participant?.sessionId) {
      return { attached: false, reason: 'missing_thread_or_participant' };
    }
    try {
      const payload = await request(`/api/agent-bus/threads/${encodeURIComponent(normalizedThreadId)}/participants`, {
        method: 'POST',
        body: { participant },
      });
      return { attached: true, threadId: normalizedThreadId, participant, result: payload };
    } catch (err) {
      return { attached: false, threadId: normalizedThreadId, participant, error: err.message || 'attach_failed' };
    }
  }

  async function resolveSessionBackend(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    const participantCatalog = await request('/api/agent-bus/participants').catch(() => null);
    const supportedKinds = Array.isArray(participantCatalog?.supportedKinds)
      ? participantCatalog.supportedKinds
      : ['claude', 'codex', 'pi'];
    for (const kind of supportedKinds) {
      const listed = participantCatalog?.sessions?.[kind];
      const payload = Array.isArray(listed)
        ? { sessions: listed }
        : await request(`/api/${kind}/sessions`).catch(() => ({ sessions: [] }));
      const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
      if (sessions.some((session) => session?.id === id)) return kind;
    }
    return null;
  }

  async function listSessions(path, {
    limit = DEFAULT_SESSION_LIMIT,
    offset = 0,
    compact = true,
    fields,
  } = {}) {
    const payload = await request(path);
    const policy = coordinatorPolicyForContext(callContext.getStore()?.authContext);
    const rawSessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
    const sessions = policy ? filterCoordinatorSessions(policy, rawSessions) : rawSessions;
    const page = paginate(sessions, {
      limit: normalizeLimit(limit, DEFAULT_SESSION_LIMIT),
      offset: normalizeOffset(offset),
    });
    const items = page.items.map((session) => pickFields(compact ? compactSession(session) : session, fields));
    return {
      sessionCount: items.length,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      hasMore: page.hasMore,
      compact: compact !== false,
      sessions: items,
    };
  }

  const tools = [
    // ── Session management ──
    {
      name: 'monitor_list_claude_sessions',
      description: 'List Claude sessions in compact paginated form by default.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Maximum sessions to return. Defaults to 50.' },
          offset: { type: 'integer', description: 'Session offset for pagination. Defaults to 0.' },
          compact: { type: 'boolean', description: 'Return compact summaries by default. Set false for full session objects.' },
          fields: {
            type: 'array',
            description: 'Optional list of session fields to keep in each result.',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
      handler: async (args = {}) => listSessions('/api/claude/sessions', args),
    },
    {
      name: 'monitor_list_codex_sessions',
      description: 'List Codex sessions in compact paginated form by default.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Maximum sessions to return. Defaults to 50.' },
          offset: { type: 'integer', description: 'Session offset for pagination. Defaults to 0.' },
          compact: { type: 'boolean', description: 'Return compact summaries by default. Set false for full session objects.' },
          fields: {
            type: 'array',
            description: 'Optional list of session fields to keep in each result.',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
      handler: async (args = {}) => listSessions('/api/codex/sessions', args),
    },
    {
      name: 'monitor_list_pi_sessions',
      description: 'List Pi coding-agent sessions in compact paginated form by default.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Maximum sessions to return. Defaults to 50.' },
          offset: { type: 'integer', description: 'Session offset for pagination. Defaults to 0.' },
          compact: { type: 'boolean', description: 'Return compact summaries by default. Set false for full session objects.' },
          fields: {
            type: 'array',
            description: 'Optional list of session fields to keep in each result.',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
      handler: async (args = {}) => listSessions('/api/pi/sessions', args),
    },
    {
      name: 'monitor_spawn_claude',
      description: 'Legacy low-level tool. Spawn one Claude session in tmux. Prefer `spawn_session` for new agent flows.',
      inputSchema: {
        type: 'object',
        properties: {
          workDir: { type: 'string', description: 'Working directory for the session' },
          displayName: { type: 'string', description: 'Display name for the session' },
          model: MCP_CLAUDE_MODEL_SCHEMA,
          initialPrompt: { type: 'string', description: 'Optional prompt to inject after the session starts' },
          ...MCP_SELECTION_SCHEMA_PROPERTIES,
        },
        additionalProperties: false,
      },
      handler: async ({ workDir, displayName, model, initialPrompt, mcpProfile = 'dueno', mcpServers, promptProfile, skills }) => {
        assertMcpProviderModel('claude', model);
        return request('/api/claude/sessions', { method: 'POST', body: {
          workDir, displayName, model, initialPrompt,
          ...(skills !== undefined ? { skills } : {}),
          ...(mcpProfile !== undefined ? { mcpProfile } : {}),
          ...(mcpServers !== undefined ? { mcpServers } : {}),
          ...(promptProfile !== undefined ? { promptProfile } : {}),
        } });
      },
    },
    {
      name: 'monitor_spawn_codex',
      description: 'Legacy low-level tool. Spawn one Codex session in tmux. Prefer `spawn_session` for new agent flows.',
      inputSchema: {
        type: 'object',
        properties: {
          workDir: { type: 'string', description: 'Working directory for the session' },
          displayName: { type: 'string', description: 'Display name for the session' },
          model: MCP_CODEX_MODEL_SCHEMA,
          initialPrompt: { type: 'string', description: 'Optional prompt to inject after the session starts' },
          ...MCP_SELECTION_SCHEMA_PROPERTIES,
          codexPlugins: CODEX_PLUGIN_SELECTION_SCHEMA,
        },
        additionalProperties: false,
      },
      handler: async ({ workDir, displayName, model, initialPrompt, mcpProfile = 'dueno', mcpServers, codexPlugins, promptProfile, skills }) => {
        assertMcpProviderModel('codex', model);
        return request('/api/codex/sessions', { method: 'POST', body: {
          workDir, displayName, model, initialPrompt,
          ...(skills !== undefined ? { skills } : {}),
          ...(mcpProfile !== undefined ? { mcpProfile } : {}),
          ...(mcpServers !== undefined ? { mcpServers } : {}),
          ...(codexPlugins !== undefined ? { codexPlugins } : {}),
          ...(promptProfile !== undefined ? { promptProfile } : {}),
        } });
      },
    },
    {
      name: 'spawn_session',
      description: 'Spawn exactly one interactive session using a provider returned by monitor_list_agent_providers.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: MCP_PROVIDER_SCHEMA,
          workDir: { type: 'string', description: 'Working directory for the session' },
          displayName: { type: 'string', description: 'Display name for the session' },
          model: MCP_AGENT_MODEL_SCHEMA,
          thinkingLevel: { type: 'string', description: 'Optional reasoning/effort level for the spawned session' },
          initialPrompt: { type: 'string', description: 'Optional prompt to inject after the session starts' },
          parentThreadId: { type: 'string', description: 'Optional existing agent-bus thread id to attach the spawned session to as a participant.' },
          ...MCP_SELECTION_SCHEMA_PROPERTIES,
          codexPlugins: CODEX_PLUGIN_SELECTION_SCHEMA,
        },
        required: ['provider'],
        additionalProperties: false,
      },
      handler: async ({ provider, workDir, displayName, model, thinkingLevel, initialPrompt, parentThreadId, mcpProfile = 'dueno', mcpServers, codexPlugins, promptProfile, skills }) => {
        assertMcpProviderModel(provider, model);
        const result = await request('/api/agents/sessions', {
          method: 'POST',
          body: {
            workDir, displayName, model, provider, thinkingLevel, initialPrompt,
            ...(skills !== undefined ? { skills } : {}),
            ...(mcpProfile !== undefined ? { mcpProfile } : {}),
            ...(mcpServers !== undefined ? { mcpServers } : {}),
            ...(provider === 'codex' && codexPlugins !== undefined ? { codexPlugins } : {}),
            ...(promptProfile !== undefined ? { promptProfile } : {}),
          },
        });
        const sessionId = sessionIdFromResult(result);
        const participant = sessionId ? { kind: backendKindForSpawn(provider, result), sessionId } : null;
        const parentThread = await bestEffortAttachParticipant(parentThreadId, participant);
        return parentThreadId ? { ...result, parentThread } : result;
      },
    },
    {
      name: 'monitor_terminate_session',
      description: 'Terminate and verify an existing agent session by session id. Returns terminated, already_gone, refused, failed, or not_found without laundering failures as success.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Session id to terminate.' },
        },
        required: ['session_id'],
        additionalProperties: false,
      },
      handler: async ({ session_id }) => {
        const sessionId = String(session_id || '').trim();
        if (!sessionId) return { ok: false, status: 'not_found', sessionId: '' };
        const kind = await resolveSessionBackend(sessionId);
        if (!kind) return { ok: false, status: 'not_found', sessionId };
        try {
          const result = await request(`/api/${kind}/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
          if (result?.ok === true && ['terminated', 'already_gone'].includes(result.status)) {
            return { ...result, kind, sessionId };
          }
          return {
            ok: false,
            status: 'failed',
            kind,
            sessionId,
            residual: Array.isArray(result?.residual) ? result.residual : [],
            reason: result?.reason || 'invalid_termination_result',
          };
        } catch (err) {
          const payload = err.payload || {};
          return {
            ok: false,
            status: payload.status === 'refused' ? 'refused' : 'failed',
            kind,
            sessionId,
            residual: Array.isArray(payload.residual) ? payload.residual : [],
            reason: payload.reason || err.message || 'terminate_failed',
            error: err.message || 'terminate_failed',
          };
        }
      },
    },
    {
      name: 'monitor_list_agent_providers',
      description: 'List agent providers, runtimes, and one-off execution capabilities from the unified agent layer.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async () => request('/api/agents/providers'),
    },
    {
      name: 'monitor_list_mcp_servers',
      description: 'List server-owned MCP capability profiles, allowlisted servers, compatibility, and sanitized availability.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async () => request('/api/agents/mcp-servers'),
    },
    {
      name: 'monitor_agent_bus_auth_readiness',
      description: 'Report live sessions that still lack a scoped Agent Bus MCP credential before enforce rollout.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async () => request('/api/agent-bus/auth/readiness'),
    },
    {
      name: 'monitor_list_prompt_profiles',
      description: 'List style prompt profile IDs, labels, and short descriptions. Prompt bodies are omitted.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async () => request('/api/agents/prompt-profiles'),
    },
    {
      name: 'monitor_run_agent_task',
      description: 'Run a one-off task through the unified agent layer without leaving a long-lived interactive session behind.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: MCP_PROVIDER_SCHEMA,
          prompt: { type: 'string', description: 'Task prompt to execute.' },
          workDir: { type: 'string', description: 'Working directory for the task.' },
          displayName: { type: 'string', description: 'Optional short task label.' },
          model: MCP_AGENT_MODEL_SCHEMA,
          thinkingLevel: { type: 'string', description: 'Optional reasoning/effort override.' },
          timeoutMs: { type: 'integer', description: 'Optional one-off task timeout in milliseconds.' },
          ...MCP_SELECTION_SCHEMA_PROPERTIES,
          codexPlugins: CODEX_PLUGIN_SELECTION_SCHEMA,
        },
        required: ['provider', 'prompt'],
        additionalProperties: false,
      },
      handler: async ({ provider, prompt, workDir, displayName, model, thinkingLevel, timeoutMs, mcpProfile = 'dueno', mcpServers, codexPlugins, promptProfile, skills }) => {
        assertMcpProviderModel(provider, model);
        return request('/api/agents/tasks', {
          method: 'POST',
          body: {
            provider, prompt, workDir, displayName, model, thinkingLevel, timeoutMs,
            ...(skills !== undefined ? { skills } : {}),
            ...(promptProfile !== undefined ? { promptProfile } : {}),
            ...(mcpProfile !== undefined ? { mcpProfile } : {}),
            ...(mcpServers !== undefined ? { mcpServers } : {}),
            ...(provider === 'codex' && codexPlugins !== undefined ? { codexPlugins } : {}),
          },
        });
      },
    },
    {
      name: 'register_scheduled_agent',
      description: 'Register a recurring agent task. Registration works even when the background pump is disabled.',
      inputSchema: {
        type: 'object',
        properties: {
          workDir: { type: 'string', description: 'Persistent working directory for every run.' },
          work_dir: { type: 'string', description: 'Alias for workDir.' },
          prompt: { type: 'string', description: 'Prompt injected into each fresh session.' },
          provider: MCP_PROVIDER_SCHEMA,
          model: MCP_AGENT_MODEL_SCHEMA,
          intervalSeconds: { type: 'integer', description: 'Run interval in seconds, clamped 15..3600.' },
          interval_seconds: { type: 'integer', description: 'Alias for intervalSeconds.' },
          maxIterations: { type: 'integer', description: 'Maximum runs; 0 means unlimited.' },
          max_iterations: { type: 'integer', description: 'Alias for maxIterations.' },
          parentThreadId: { type: 'string', description: 'Optional agent-bus thread to attach each run to.' },
          parent_thread_id: { type: 'string', description: 'Alias for parentThreadId.' },
          startImmediately: { type: 'boolean', description: 'When true, first run is due immediately. Defaults true.' },
          start_immediately: { type: 'boolean', description: 'Alias for startImmediately.' },
          controlProfile: {
            type: 'string',
            enum: [COORDINATOR_SCHEDULE_PROFILE],
            description: 'Optional server-owned control profile. coordinator-v1 grants only the fenced coordinator workflow.',
          },
          control_profile: {
            type: 'string',
            enum: [COORDINATOR_SCHEDULE_PROFILE],
            description: 'Alias for controlProfile.',
          },
          coordinator: {
            type: 'object',
            description: 'Required settings when controlProfile is coordinator-v1. Fleet validates and stamps these as trusted schedule metadata.',
            properties: {
              policyId: { type: 'string' },
              repository: { type: 'string', description: 'Primary owner/repo. Prefer repositories for multi-repository loops.' },
              repositories: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string' } },
              projectRoots: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string' } },
              protectedSessionIds: { type: 'array', maxItems: 64, uniqueItems: true, items: { type: 'string' } },
            },
            required: ['policyId', 'projectRoots'],
            anyOf: [
              { required: ['repository'] },
              { required: ['repositories'] },
            ],
            additionalProperties: false,
          },
          ...MCP_SELECTION_SCHEMA_PROPERTIES,
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      handler: async (args = {}) => {
        assertMcpProviderModel(args.provider || 'codex', args.model);
        return request('/api/agents/scheduled', { method: 'POST', body: { mcpProfile: 'dueno', ...args } });
      },
    },
    {
      name: 'spawn_loop_session',
      description: 'Start a bounded loop that periodically injects a fixed prompt into one live agent session.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', minLength: 1, description: 'Target agent session kind.' },
          session_id: { type: 'string', minLength: 1, description: 'Target agent session ID.' },
          prompt: { type: 'string', minLength: 1, description: 'Fixed prompt injected on every tick.' },
          interval_seconds: { type: 'integer', minimum: 15, maximum: 1296000 },
          max_iterations: { type: 'integer', minimum: 1, maximum: 100 },
          title: { type: 'string', description: 'Optional loop title.' },
          display_name: { type: 'string', description: 'Optional display label.' },
        },
        required: ['kind', 'session_id', 'prompt', 'interval_seconds', 'max_iterations'],
        additionalProperties: false,
      },
      handler: async (args = {}) => {
        assertLoopSessionArgs(args);
        const { kind, session_id: sessionId, prompt, interval_seconds: intervalSeconds, max_iterations: maxIterations, title, display_name: displayName } = args;
        return request('/api/agents/scheduled', {
          method: 'POST',
          body: {
            type: 'inject',
            targetSession: { kind, sessionId },
            prompt,
            intervalSeconds,
            maxIterations,
            metadata: {
              ...(title ? { title } : {}),
              ...(displayName ? { displayName } : {}),
            },
          },
        });
      },
    },
    {
      name: 'list_scheduled_agents',
      description: 'List registered scheduled agent tasks.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async () => {
        const payload = await request('/api/agents/scheduled');
        const policy = coordinatorPolicyForContext(callContext.getStore()?.authContext);
        if (!policy) return payload;
        const tasks = filterCoordinatorSchedules(policy, payload?.tasks);
        return { ...payload, tasks, taskCount: tasks.length };
      },
    },
    {
      name: 'cancel_scheduled_agent',
      description: 'Cancel a registered scheduled agent task.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Scheduled task id.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async ({ id }) =>
        request(`/api/agents/scheduled/${encodeURIComponent(String(id || ''))}/cancel`, { method: 'POST', body: {} }),
    },
    {
      name: 'monitor_step_scheduled_agents',
      description: 'Run one manual scheduled-agent tick now, independent of the background pump.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async () =>
        request('/api/agents/scheduled/step-now', { method: 'POST', body: {} }),
    },
    {
      name: 'monitor_list_human_queue',
      description: 'List Command Center human-decision queue items populated by fleet supervisors.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['open', 'answered', 'routed', 'delivery_failed', 'acknowledged', 'all'],
            description: 'Queue status filter: open, answered, routed, delivery_failed, acknowledged, or all. Defaults to open.',
          },
        },
        additionalProperties: false,
      },
      handler: async ({ status = 'open' } = {}) => {
        const params = new URLSearchParams();
        params.set('status', status || 'open');
        return request(`/api/command-center/work-queue?${params.toString()}`);
      },
    },
    {
      name: 'monitor_add_human_queue_item',
      description: 'Add a Command Center work-queue item when a session needs a user decision.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short queue item title.' },
          question: { type: 'string', description: 'Decision question for the user.' },
          details: { type: 'string', description: 'Brief context needed to answer.' },
          source: { type: 'string', description: 'Source label, e.g. fleet_supervisor.' },
          priority: { type: 'string', description: 'Priority label such as low, normal, high, or urgent.' },
          sessionKind: { type: 'string', description: 'Related session backend kind: claude, codex, or pi.' },
          sessionId: { type: 'string', description: 'Related session id.' },
          threadId: { type: 'string', description: 'Related agent-bus thread id.' },
          passThrough: { type: 'boolean', description: 'When true, the answer is routed directly to sessionKind/sessionId instead of back through the supervisor.' },
          allowFreeform: { type: 'boolean', description: 'Whether free-form answer input is allowed. Defaults true.' },
          options: {
            type: 'array',
            description: 'Optional multiple-choice answers.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                value: { type: 'string' },
                description: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        required: ['question'],
        additionalProperties: false,
      },
      handler: async (args = {}) =>
        request('/api/command-center/work-queue', { method: 'POST', body: args }),
    },
    {
      name: 'monitor_answer_human_queue_item',
      description: 'Answer a Command Center human-decision queue item, usually after the user provides the decision.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Queue item id.' },
          answer: { type: 'string', description: 'Free-form answer text.' },
          optionId: { type: 'string', description: 'Selected option id.' },
          optionValue: { type: 'string', description: 'Selected option value.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async ({ id, answer, optionId, optionValue }) =>
        request(`/api/command-center/work-queue/${encodeURIComponent(String(id || ''))}/answer`, {
          method: 'POST',
          body: { answer, optionId, optionValue },
        }),
    },
    {
      name: 'monitor_acknowledge_human_queue_item',
      description: 'Mark a Command Center human queue item as acknowledged after routed session action is verified.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Queue item id.' },
          note: { type: 'string', description: 'Optional acknowledgement note.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async ({ id, note }) =>
        request(`/api/command-center/work-queue/${encodeURIComponent(String(id || ''))}/acknowledge`, {
          method: 'POST',
          body: { note },
        }),
    },
    {
      name: 'monitor_send_to_session',
      description: 'Queue text input for an agent session. accepted/queued is Fleet queue acceptance only; delivery status comes from monitor_list_session_deliveries(transactionId). sent means keystrokes delivered to the provider pane, not that the agent read or applied it. Results must come from the worker (room_send/agent_dm).',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['claude', 'codex', 'pi'], description: 'Session backend type' },
          sessionId: { type: 'string', description: 'Session ID' },
          text: { type: 'string', description: 'Text to send' },
        },
        required: ['type', 'sessionId', 'text'],
        additionalProperties: false,
      },
      handler: async ({ type, sessionId, text }) => {
        const payload = await request(`/api/${type}/sessions/${sessionId}/input`, {
          method: 'POST',
          body: { text, enter: true, source: 'monitor_send_to_session' },
        });
        return {
          ok: payload?.ok === true,
          accepted: payload?.accepted === true,
          transactionId: payload?.transactionId || '',
          state: payload?.state || '',
        };
      },
    },
    {
      name: 'monitor_list_session_deliveries',
      description: 'List recent direct session input delivery audit records, including monitor_send_to_session sends. Records are append-only per transition, newest first; the first record for a transactionId is its current state. metadata.confirmation holds submit evidence.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['claude', 'codex', 'pi'], description: 'Optional session backend filter.' },
          sessionId: { type: 'string', description: 'Optional session ID filter.' },
          source: { type: 'string', description: 'Optional delivery source filter, such as monitor_send_to_session.' },
          status: {
            type: 'string',
            enum: ['queued', 'sending', 'awaiting_response', 'sent', 'failed', 'dropped'],
            description: 'Optional delivery status filter.',
          },
          transactionId: { type: 'string', description: 'Optional command transaction ID filter.' },
          limit: { type: 'integer', description: 'Maximum records to return. Defaults to 100 and caps at 500.' },
        },
        additionalProperties: false,
      },
      handler: async ({ type, sessionId, source, status, transactionId, limit } = {}) => {
        const params = new URLSearchParams();
        if (type) params.set('kind', type);
        if (sessionId) params.set('sessionId', sessionId);
        if (source) params.set('source', source);
        if (status) params.set('status', status);
        if (transactionId) params.set('transactionId', transactionId);
        if (limit != null) params.set('limit', String(limit));
        return request(`/api/session-deliveries${params.size ? `?${params.toString()}` : ''}`);
      },
    },
    {
      name: 'monitor_get_session_output',
      description: 'Fetch the current captured output for an interactive session.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Session backend type or provider alias.' },
          sessionId: { type: 'string', description: 'Session ID' },
          lines: { type: 'integer', description: 'How many trailing transcript lines to capture. Defaults to 200 and is capped at 200.' },
        },
        required: ['type', 'sessionId'],
        additionalProperties: false,
      },
      handler: async ({ type, sessionId, lines }) =>
        request(buildSessionDetailPath(type, sessionId, { lines })),
    },
    {
      name: 'monitor_scheduled_send',
      description: 'Schedule a message to be sent to a session after a delay. Use for timed check-ins, follow-ups, or recurring pings.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['claude', 'codex', 'pi'], description: 'Session backend type' },
          sessionId: { type: 'string', description: 'Session ID' },
          text: { type: 'string', description: 'Text to send' },
          delayMs: { type: 'number', description: 'Delay in milliseconds before sending' },
          sendAt: { type: 'string', description: 'ISO timestamp to send at (alternative to delayMs)' },
        },
        required: ['type', 'sessionId', 'text'],
        additionalProperties: false,
      },
      handler: async ({ type, sessionId, text, delayMs, sendAt }) =>
        request(`/api/${type}/sessions/${sessionId}/scheduled-send`, { method: 'POST', body: { text, delayMs, sendAt } }),
    },

    // ── Thread management ──
    {
      name: 'monitor_list_threads',
      description: 'List collaboration threads in compact paginated form. Defaults to open threads only.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Thread status filter: open, stale, closed, or all. Defaults to open.' },
          limit: { type: 'integer', description: 'Maximum threads to return. Defaults to 25.' },
          offset: { type: 'integer', description: 'Thread offset for pagination. Defaults to 0.' },
          compact: { type: 'boolean', description: 'Return compact summaries by default. Set false for full thread metadata.' },
          include_messages: { type: 'boolean', description: 'Include recent messages for returned threads.' },
          message_limit: { type: 'integer', description: 'Maximum messages per thread when include_messages=true. Defaults to 10.' },
          fields: {
            type: 'array',
            description: 'Optional list of thread fields to keep in each result.',
            items: { type: 'string' },
          },
        },
        additionalProperties: false,
      },
      handler: async ({
        status = 'open',
        limit = DEFAULT_THREAD_LIMIT,
        offset = 0,
        compact = true,
        include_messages = false,
        message_limit = 10,
        fields,
      } = {}) => {
        const listParams = new URLSearchParams();
        if (status && status !== 'all') listParams.set('status', status);
        const payload = await request(`/api/agent-bus/threads${listParams.size ? `?${listParams.toString()}` : ''}`);
        const policy = coordinatorPolicyForContext(callContext.getStore()?.authContext);
        const rawThreads = Array.isArray(payload?.threads) ? payload.threads : [];
        const threads = policy ? filterCoordinatorThreads(policy, rawThreads) : rawThreads;
        const page = paginate(threads, {
          limit: normalizeLimit(limit, DEFAULT_THREAD_LIMIT),
          offset: normalizeOffset(offset),
        });
        const details = await Promise.all(page.items.map((thread) =>
          request(buildThreadDetailPath(thread.id, {
            includeMessages: include_messages === true,
            messageLimit: message_limit,
          }))
        ));
        const items = page.items.map((thread, index) => {
          const detail = details[index] || {};
          const base = compact !== false
            ? compactThreadSummary(thread, detail, { includeMessages: include_messages === true })
            : {
                ...thread,
                messageCount: detail.messageCount ?? 0,
                deliveryCount: detail.deliveryCount ?? 0,
                latestMessageAt: detail.latestMessageAt ?? null,
                latestDeliveryAt: detail.latestDeliveryAt ?? null,
                ...(include_messages === true
                  ? {
                      messages: Array.isArray(detail.messages) ? detail.messages : [],
                      messagesTruncated: detail.messagesTruncated ?? false,
                    }
                  : {}),
              };
          return pickFields(base, fields);
        });
        return {
          status: status || 'open',
          threadCount: items.length,
          total: page.total,
          limit: page.limit,
          offset: page.offset,
          hasMore: page.hasMore,
          compact: compact !== false,
          includeMessages: include_messages === true,
          threads: items,
        };
      },
    },
    {
      name: 'spawn_collab_session',
      description: 'Spawn exactly two participants in one collaboration thread and inject the standard Cadre collaboration onboarding prompt into both sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Thread title' },
          projectKey: { type: 'string', description: 'Project path/key for the collaboration thread' },
          workDir: { type: 'string', description: 'Default working directory for newly created sessions' },
          initialTask: { type: 'string', description: 'Shared task for both participants' },
          model: MCP_AGENT_MODEL_SCHEMA,
          thinkingLevel: { type: 'string', description: 'Optional default reasoning/effort level for newly created participants' },
          ...MCP_SELECTION_SCHEMA_PROPERTIES,
          codexPlugins: CODEX_PLUGIN_SELECTION_SCHEMA,
          participants: {
            type: 'array',
            minItems: 2,
            maxItems: 2,
            description: 'Exactly two participants. Each participant may attach an existing session via session_id or create a new one via provider/model.',
            items: {
              type: 'object',
              properties: {
                provider: MCP_PROVIDER_SCHEMA,
                session_id: { type: 'string', description: 'Existing session id to attach instead of creating a new one.' },
                create: { type: 'boolean', description: 'Create a new session when true. Defaults to true when session_id is omitted.' },
                model: MCP_AGENT_MODEL_SCHEMA,
                thinking_level: { type: 'string', description: 'Optional reasoning/effort override for a newly created participant.' },
                display_name: { type: 'string', description: 'Optional display name for a newly created participant.' },
                initial_task: { type: 'string', description: 'Optional participant-specific task.' },
                work_dir: { type: 'string', description: 'Optional working directory override for this participant.' },
                ...MCP_SELECTION_SCHEMA_PROPERTIES,
                codexPlugins: CODEX_PLUGIN_SELECTION_SCHEMA,
              },
              additionalProperties: false,
            },
          },
        },
        required: ['title', 'participants'],
        additionalProperties: false,
      },
      handler: async ({ title, projectKey, workDir, initialTask, model, thinkingLevel, mcpProfile = 'dueno', mcpServers, codexPlugins, promptProfile, skills, participants }) => {
        const normalizedParticipants = participants.map((participant) =>
          normalizeParticipant(participant, { model, thinkingLevel, displayName: title, workDir, mcpProfile, mcpServers, codexPlugins, promptProfile })
        );
        const providerStatus = await getAgentProviderStatus();
        assertParticipantsEnabled(normalizedParticipants, providerStatus);
        const payload = await request('/api/agent-bus/bootstrap', {
          method: 'POST',
          body: {
            title,
            projectKey: projectKey || '',
            workDir: workDir || '',
            initialTask: initialTask || '',
            skills: skills || [],
            thinkingLevel: thinkingLevel || '',
            ...(mcpProfile !== undefined ? { mcpProfile } : {}),
            ...(mcpServers !== undefined ? { mcpServers } : {}),
            ...(codexPlugins !== undefined ? { codexPlugins } : {}),
            ...(promptProfile !== undefined ? { promptProfile } : {}),
            participants: normalizedParticipants,
          },
        });
        assertBootstrapOk(payload);
        return { ...payload, threadType: 'collab' };
      },
    },
    {
      name: 'spawn_conference_session',
      description: 'Spawn a multi-participant collaboration conference thread with two or more participants. Use this when you want a shared thread across N sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Conference thread title' },
          projectKey: { type: 'string', description: 'Project path/key for the conference thread' },
          workDir: { type: 'string', description: 'Default working directory for newly created sessions' },
          initialTask: { type: 'string', description: 'Shared task for the full conference' },
          model: MCP_AGENT_MODEL_SCHEMA,
          thinkingLevel: { type: 'string', description: 'Optional default reasoning/effort level for newly created participants' },
          ...MCP_SELECTION_SCHEMA_PROPERTIES,
          codexPlugins: CODEX_PLUGIN_SELECTION_SCHEMA,
          participants: {
            type: 'array',
            minItems: 2,
            description: 'Conference participants. Each participant may attach an existing session or create a new one via provider/model.',
            items: {
              type: 'object',
              properties: {
                provider: MCP_PROVIDER_SCHEMA,
                session_id: { type: 'string', description: 'Existing session id to attach instead of creating a new one.' },
                create: { type: 'boolean', description: 'Create a new session when true. Defaults to true when session_id is omitted.' },
                model: MCP_AGENT_MODEL_SCHEMA,
                thinking_level: { type: 'string', description: 'Optional reasoning/effort override for a newly created participant.' },
                display_name: { type: 'string', description: 'Optional display name for a newly created participant.' },
                initial_task: { type: 'string', description: 'Optional participant-specific task.' },
                work_dir: { type: 'string', description: 'Optional working directory override for this participant.' },
                ...MCP_SELECTION_SCHEMA_PROPERTIES,
                codexPlugins: CODEX_PLUGIN_SELECTION_SCHEMA,
              },
              additionalProperties: false,
            },
          },
        },
        required: ['title', 'participants'],
        additionalProperties: false,
      },
      handler: async ({ title, projectKey, workDir, initialTask, model, thinkingLevel, mcpProfile = 'dueno', mcpServers, codexPlugins, promptProfile, skills, participants }) => {
        const normalizedParticipants = participants.map((participant) =>
          normalizeParticipant(participant, { model, thinkingLevel, displayName: title, workDir, mcpProfile, mcpServers, codexPlugins, promptProfile })
        );
        const providerStatus = await getAgentProviderStatus();
        assertParticipantsEnabled(normalizedParticipants, providerStatus);
        const payload = await request('/api/agent-bus/bootstrap', {
          method: 'POST',
          body: {
            title,
            projectKey: projectKey || '',
            workDir: workDir || '',
            initialTask: initialTask || '',
            skills: skills || [],
            thinkingLevel: thinkingLevel || '',
            ...(mcpProfile !== undefined ? { mcpProfile } : {}),
            ...(mcpServers !== undefined ? { mcpServers } : {}),
            ...(codexPlugins !== undefined ? { codexPlugins } : {}),
            ...(promptProfile !== undefined ? { promptProfile } : {}),
            participants: normalizedParticipants,
          },
        });
        assertBootstrapOk(payload);
        return { ...payload, threadType: 'conference' };
      },
    },
    // ── Recording evidence ──
    {
      name: 'monitor_scan_audio_recordings',
      description: 'Scan the configured audio recording inbox and ingest exported transcript/summary files as gated evidence packets.',
      inputSchema: {
        type: 'object',
        properties: {
        },
        additionalProperties: false,
      },
      handler: async () => request('/api/recordings/scan', { method: 'POST', body: {} }),
    },
    {
      name: 'monitor_list_audio_recordings',
      description: 'List ingested audio recording manifests. Transcript and summary text are not included.',
      inputSchema: {
        type: 'object',
        properties: {
          sourceTool: { type: 'string', description: 'Optional source tool filter.' },
          tag: { type: 'string', description: 'Optional tag filter.' },
          limit: { type: 'integer', description: 'Maximum records to return. Defaults to 50.' },
          offset: { type: 'integer', description: 'Pagination offset. Defaults to 0.' },
        },
        additionalProperties: false,
      },
      handler: async ({ sourceTool = '', tag = '', limit, offset } = {}) => {
        const params = new URLSearchParams();
        if (sourceTool) params.set('sourceTool', sourceTool);
        if (tag) params.set('tag', tag);
        if (limit != null) params.set('limit', String(limit));
        if (offset != null) params.set('offset', String(offset));
        return request(`/api/recordings${params.size ? `?${params.toString()}` : ''}`);
      },
    },
    {
      name: 'monitor_read_audio_recording',
      description: 'Read one ingested audio recording manifest. Transcript and summary text are not included.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Recording id or audio_recording evidence ref.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async ({ id }) =>
        request(`/api/recordings/${encodeURIComponent(String(id || ''))}`),
    },
    {
      name: 'monitor_read_audio_recording_evidence',
      description: 'Read one gated audio recording evidence packet with verbatim, capped transcript/summary text.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Recording id.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async ({ id }) =>
        request(`/api/recordings/${encodeURIComponent(String(id || ''))}/evidence`),
    },
    {
      name: 'monitor_act_on_audio_recording',
      description: 'Spawn a scoped action session for one recording. The prompt contains safe counts only; evidence is staged in the workdir.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Recording id.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async ({ id }) =>
        request(`/api/recordings/${encodeURIComponent(String(id || ''))}/act`, { method: 'POST', body: {} }),
    },

    // ── System ──
    {
      name: 'monitor_health',
      description: 'Check Cadre server health, scheduler status, and session counts.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => {
        const [health, claude, codex, pi] = await Promise.all([
          request('/api/health'),
          request('/api/claude/sessions').catch(() => ({ sessions: [] })),
          request('/api/codex/sessions').catch(() => ({ sessions: [] })),
          request('/api/pi/sessions').catch(() => ({ sessions: [] })),
        ]);
        return {
          ...health,
          claudeSessions: claude.sessions?.length || 0,
          codexSessions: codex.sessions?.length || 0,
          piSessions: pi.sessions?.length || 0,
        };
      },
    },
  ];

  // Discoverability whitelist: only session spawn/comm/status + collab/loop tools
  // are exposed via listTools / extraTools. Other handlers remain callable by
  // name (kept for internal/back-compat use) but are hidden from MCP discovery.
  const DISCOVERABLE_TOOL_NAMES = new Set([
    'monitor_list_claude_sessions',
    'monitor_list_codex_sessions',
    'monitor_list_pi_sessions',
    'monitor_spawn_claude',
    'monitor_spawn_codex',
    'spawn_session',
    'monitor_terminate_session',
    'monitor_list_agent_providers',
    'monitor_list_mcp_servers',
    'monitor_agent_bus_auth_readiness',
    'monitor_list_prompt_profiles',
    'monitor_run_agent_task',
    'register_scheduled_agent',
    'spawn_loop_session',
    'list_scheduled_agents',
    'cancel_scheduled_agent',
    'monitor_step_scheduled_agents',
    'monitor_list_human_queue',
    'monitor_add_human_queue_item',
    'monitor_answer_human_queue_item',
    'monitor_send_to_session',
    'monitor_list_session_deliveries',
    'monitor_get_session_output',
    'monitor_scheduled_send',
    'monitor_list_threads',
    'spawn_collab_session',
    'spawn_conference_session',
    'monitor_scan_audio_recordings',
    'monitor_list_audio_recordings',
    'monitor_read_audio_recording',
    'monitor_read_audio_recording_evidence',
    'monitor_act_on_audio_recording',
  ]);

  const discoverableTools = tools.filter((t) => (
    DISCOVERABLE_TOOL_NAMES.has(t.name)
  ));

  // MCP protocol handler
  return {
    tools: discoverableTools,
    allTools: tools,
    async handleToolCall(name, args, context = null) {
      const tool = tools.find(t => t.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      return callContext.run({ authContext: context?.authContext || null }, () => tool.handler(args || {}, context));
    },
    listTools() {
      return discoverableTools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },
  };
}
