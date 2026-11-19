import { worktreeSchema } from '../agent-bus/managed-worktrees.mjs';
import { compileToolArguments } from '../agent-bus/mcp-validation.mjs';
import { reportServerRestart } from '../agent-bus/mcp.mjs';
import { DEFAULT_LIST_LIMIT, PAGE_PROPERTIES, normalizeLimit, normalizeOffset, paginate } from '../agent-bus/mcp-pagination.mjs';
/**
 * MCP server exposing Cadre tools for the command center AI.
 * Provides: session management, thread pinging, and timed operations.
 */

import { config } from '../../config.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeAgentProvider, resolveAgentProviderSelection } from '../agent/provider-interface.mjs';
import {
  MCP_AGENT_MODEL_SCHEMA,
  MCP_PROVIDER_SCHEMA,
  assertMcpProviderModel,
} from './mcp-model-schemas.mjs';
import { buildPromptProfileFieldSchema } from '../integrations/prompt-profile-catalog.mjs';
import { cloudOutput, cloudSend, cloudStatus } from '../integrations/cloud-sessions.mjs';
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
const CODEX_PLUGIN_LIST_SCHEMA = { type: 'array', uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$' } };
const CODEX_PLUGIN_SELECTION_SCHEMA = {
  type: 'object',
  description: 'Codex plugins, not skills or mcpServers; add wins over Fleet defaults.',
  properties: { add: CODEX_PLUGIN_LIST_SCHEMA, remove: CODEX_PLUGIN_LIST_SCHEMA },
  additionalProperties: false,
};
const CODE_MODE_SCHEMA = { type: 'boolean', description: 'Claude terminal Code Mode.' };
// Code Mode needs the terminal, but only an all-Claude room leaves the structured runtime for it;
// otherwise each Claude participant keeps its runtime and the bootstrap warns if it lost Code Mode.
const collabStructured = (codeMode, participants) => !(codeMode === true
  && participants.filter((participant) => participant.create).every((participant) => participant.kind === 'claude'));
const MCP_SELECTION_SCHEMA_PROPERTIES = {
  mcpProfile: { type: 'string', description: 'From monitor_list_mcp_servers.' },
  mcpServers: MCP_SERVERS_SELECTION_SCHEMA,
  promptProfile: buildPromptProfileFieldSchema(),
  skills: {
    type: 'array',
    uniqueItems: true,
    items: { type: 'string' },
    description: 'Fleet launch skill IDs.',
  },
};
// One participant entry for spawn_collab_session and spawn_conference_session. Fields that override a
// top-level field drop its description; the participants description says they override.
const undescribed = ({ description: _description, ...schema }) => schema;
const PARTICIPANT_PROPERTIES = {
  provider: MCP_PROVIDER_SCHEMA,
  session_id: { type: 'string', description: 'Existing session to attach.' },
  create: { type: 'boolean', description: 'Default true unless session_id is set.' },
  model: undescribed(MCP_AGENT_MODEL_SCHEMA),
  thinking_level: { type: 'string' },
  display_name: { type: 'string' },
  initial_task: { type: 'string', description: 'Participant-specific task.' },
  work_dir: { type: 'string' },
  ...Object.fromEntries(Object.entries(MCP_SELECTION_SCHEMA_PROPERTIES).map(([key, schema]) => [key, undescribed(schema)])),
  codexPlugins: undescribed(CODEX_PLUGIN_SELECTION_SCHEMA),
};
const QUEUE_OPTION_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string' }, label: { type: 'string' }, value: { type: 'string' }, description: { type: 'string' } },
  additionalProperties: false,
};

export function buildMonitorMcpServer({ requestImpl }) {
  if (!requestImpl) throw new Error('requestImpl is required');

  const callContext = new AsyncLocalStorage();


  async function request(path, opts) {
    const authContext = callContext.getStore()?.authContext || null;
    return reportServerRestart(() => requestImpl(path, {
      ...(opts || {}),
      ...(authContext ? { authContext } : {}),
    }));
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
      ...(participant.machine ? { machine: String(participant.machine) } : {}),
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
    return {
      id: session.id || session.sessionId || '',
      displayName: session.displayName || session.name || '',
      status: session.state?.status || session.status || 'unknown',
      canSendNow: session.state?.capabilities?.canSendNow === true,
    };
  }

  function spawnResult(payload, { kind = '', threadId = null, displayName = '' } = {}) {
    return {
      thread_id: payload.thread?.id || threadId,
      participants: (payload.participants || [payload.session || payload]).map((entry) => ({
        kind: entry.kind || entry.backendType || kind,
        session_id: entry.sessionId || entry.id || sessionIdFromResult(entry),
        display_name: entry.displayName || entry.sessionName || displayName,
      })),
      ...(payload.warnings?.length || payload.initialPromptError ? { warnings: [...(payload.warnings || []), ...(payload.initialPromptError ? [payload.initialPromptError] : [])] } : {}),
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
    limit = DEFAULT_LIST_LIMIT,
    offset = 0,
    compact = true,
    fields,
  } = {}) {
    const payload = await request(path);
    const policy = coordinatorPolicyForContext(callContext.getStore()?.authContext);
    const rawSessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
    const sessions = policy ? filterCoordinatorSessions(policy, rawSessions) : rawSessions;
    const page = paginate(sessions.toSorted((a, b) => Number(b.created || 0) - Number(a.created || 0)), {
      limit: normalizeLimit(limit, DEFAULT_LIST_LIMIT),
      offset: normalizeOffset(offset),
    });
    const items = page.items.map((session) => pickFields(fields?.length ? { ...session, ...compactSession(session) } : compact ? compactSession(session) : session, fields));
    return {
      sessionCount: items.length,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      hasMore: page.hasMore,
      ...(page.hasMore ? { nextOffset: page.offset + items.length } : {}),
      compact: compact !== false,
      sessions: items,
    };
  }

  const tools = [
    // ── Session management ──
    {
      name: 'monitor_list_claude_sessions',
      description: 'List Claude sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Default 25.' },
          offset: { type: 'integer' },
          compact: { type: 'boolean', description: 'false returns full objects.' },
          fields: { type: 'array', description: 'Session fields to keep (overrides compact).', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      handler: async (args = {}) => listSessions('/api/claude/sessions', args),
    },
    {
      name: 'monitor_list_codex_sessions',
      description: 'List Codex sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Default 25.' },
          offset: { type: 'integer' },
          compact: { type: 'boolean', description: 'false returns full objects.' },
          fields: { type: 'array', description: 'Session fields to keep (overrides compact).', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      handler: async (args = {}) => listSessions('/api/codex/sessions', args),
    },
    {
      name: 'monitor_list_pi_sessions',
      description: 'List Pi sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Default 25.' },
          offset: { type: 'integer' },
          compact: { type: 'boolean', description: 'false returns full objects.' },
          fields: { type: 'array', description: 'Session fields to keep (overrides compact).', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      handler: async (args = {}) => listSessions('/api/pi/sessions', args),
    },
    {
      name: 'spawn_session',
      description: 'Spawn one interactive session. Returns thread_id, participant ids/names and warnings.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: MCP_PROVIDER_SCHEMA,
          workDir: { type: 'string' },
          displayName: { type: 'string' },
          model: MCP_AGENT_MODEL_SCHEMA,
          thinkingLevel: { type: 'string' },
          initialPrompt: { type: 'string' },
          parentThreadId: { type: 'string', description: 'Existing thread to add the session to as a participant.' },
          returnResults: { type: 'boolean', description: 'Claude without parentThreadId only: DMs you the final message of each turn that ends with no background work or returnResults workers outstanding; end your turn to wait, do not poll. Omit when only handing off context.' },
          machine: { type: 'string', description: 'Paired machine (Claude, Codex, Pi; not DeepSeek); workDir is a path there. Default hub.' },
          ...MCP_SELECTION_SCHEMA_PROPERTIES,
          codexPlugins: CODEX_PLUGIN_SELECTION_SCHEMA,
          codeMode: CODE_MODE_SCHEMA,
        },
        required: ['provider'],
        additionalProperties: false,
      },
      handler: async ({ provider, workDir, displayName, model, thinkingLevel, initialPrompt, parentThreadId, returnResults = false, machine, mcpProfile = 'dueno', mcpServers, codexPlugins, promptProfile, skills, codeMode }) => {
        assertMcpProviderModel(provider, model);
        const returnToSpawner = returnResults === true && provider === 'claude' && !parentThreadId;
        const result = await request('/api/agents/sessions', {
          method: 'POST',
          body: {
            workDir, displayName, model, provider, thinkingLevel, initialPrompt,
            ...(machine ? { machine } : {}),
            ...(returnToSpawner ? { metadata: { returnToSpawner } } : {}),
            ...(skills !== undefined ? { skills } : {}),
            ...(mcpProfile !== undefined ? { mcpProfile } : {}),
            ...(mcpServers !== undefined ? { mcpServers } : {}),
            ...(provider === 'codex' && codexPlugins !== undefined ? { codexPlugins } : {}),
            ...(promptProfile !== undefined ? { promptProfile } : {}),
            ...(codeMode !== undefined ? { codeMode } : {}),
            // Automated spawn: the structured runtime serves it when CADRE_STRUCTURED_AUTOMATED_SPAWNS is on.
            // Code Mode needs the terminal UI, so asking for it keeps the spawn on tmux.
            structured: codeMode !== true,
          },
        });
        const sessionId = sessionIdFromResult(result);
        const participant = sessionId ? { kind: backendKindForSpawn(provider, result), sessionId } : null;
        const parentThread = await bestEffortAttachParticipant(parentThreadId, participant);
        const compact = spawnResult(result, { kind: participant?.kind, threadId: parentThreadId || null, displayName });
        if (parentThreadId && !parentThread.attached) compact.warnings = [...(compact.warnings || []), parentThread.error || parentThread.reason];
        return compact;
      },
    },
    {
      name: 'handoff_session',
      description: 'Hand an idle session to another provider/model: a new linked session in the same workDir and profiles gets a text brief. The source stays idle and resumable; mid-turn sources are refused. Returns the new session id and links.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', minLength: 1, pattern: '\\S', description: 'Source session.' },
          provider: MCP_PROVIDER_SCHEMA,
          model: MCP_AGENT_MODEL_SCHEMA,
          thinkingLevel: { type: 'string' },
        },
        required: ['session_id', 'provider'],
        additionalProperties: false,
      },
      handler: async ({ session_id, provider, model, thinkingLevel }) => {
        assertMcpProviderModel(provider, model);
        const result = await request(`/api/agents/sessions/${encodeURIComponent(String(session_id).trim())}/handoff`, {
          method: 'POST',
          // Automated handoff: the structured runtime serves it when CADRE_STRUCTURED_AUTOMATED_SPAWNS is on.
          body: { provider, model, thinkingLevel, structured: true },
        });
        return {
          session_id: result.id, provider: result.provider, backendType: result.backendType,
          handoffFrom: result.handoffFrom, handoffTo: result.handoffTo,
          ...(result.dropped?.length ? { dropped: result.dropped } : {}), ...(result.linkError ? { warnings: [result.linkError] } : {}),
        };
      },
    },
    {
      name: 'monitor_terminate_session',
      description: 'Terminate a session and verify it. Returns session_id and status: terminated, already_gone, refused, failed or not_found (failures are never reported as success).',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', minLength: 1, pattern: '\\S' },
        },
        required: ['session_id'],
        additionalProperties: false,
      },
      handler: async ({ session_id }) => {
        const sessionId = String(session_id || '').trim();
        if (!sessionId) return { session_id: '', status: 'not_found' };
        const kind = await resolveSessionBackend(sessionId);
        if (!kind) return { session_id: sessionId, status: 'not_found' };
        try {
          const result = await request(`/api/${kind}/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
          if (result?.ok === true && ['terminated', 'already_gone'].includes(result.status)) {
            return { session_id: sessionId, status: result.status };
          }
          return {
            status: 'failed',
            session_id: sessionId,
            residual: Array.isArray(result?.residual) ? result.residual : [],
            reason: result?.reason || 'invalid_termination_result',
          };
        } catch (err) {
          const payload = err.payload || {};
          return {
            status: payload.status === 'refused' ? 'refused' : 'failed',
            session_id: sessionId,
            residual: Array.isArray(payload.residual) ? payload.residual : [],
            reason: payload.reason || err.message || 'terminate_failed',
            error: err.message || 'terminate_failed',
          };
        }
      },
    },
    {
      name: 'monitor_list_agent_providers',
      description: 'List agent providers and runtimes.',
      inputSchema: {
        type: 'object',
        properties: { ...PAGE_PROPERTIES },
        additionalProperties: false,
      },
      handler: async (args = {}) => {
        const payload = await request('/api/agents/providers');
        const { items, ...page } = paginate((payload.providers || []).map((row) => pickFields(row, ['id', 'label', 'enabled', 'runtime', 'backendType'])), args);
        return { providers: items, ...page };
      },
    },
    {
      name: 'monitor_list_mcp_servers',
      description: 'List MCP profiles and allowlisted servers with availability.',
      inputSchema: {
        type: 'object',
        properties: { ...PAGE_PROPERTIES, serverId: { type: 'string' } },
        additionalProperties: false,
      },
      handler: async (args = {}) => {
        const payload = await request('/api/agents/mcp-servers');
        return { defaultProfileId: payload.defaultProfileId,
          profiles: (payload.profiles || []).map((row) => pickFields(row, ['id', 'label', 'serverIds'])),
          servers: paginate((payload.servers || []).filter((row) => !args.serverId || row.id === args.serverId).map((row) => ({ id: row.id, label: row.label, state: row.availability?.state, providers: row.providers, runtimes: row.runtimes })), args) };
      },
    },
    {
      name: 'monitor_agent_bus_auth_readiness',
      description: 'List live sessions still lacking a scoped Agent Bus MCP credential.',
      inputSchema: {
        type: 'object',
        properties: { ...PAGE_PROPERTIES },
        additionalProperties: false,
      },
      handler: async (args = {}) => {
        const payload = await request('/api/agent-bus/auth/readiness');
        return { mode: payload.mode, readyForEnforce: payload.readyForEnforce, missingCredentialCount: payload.missingCredentialCount,
          ...paginate(payload.sessions || [], args) };
      },
    },
    {
      name: 'monitor_list_prompt_profiles',
      description: 'List style prompt profiles (no bodies).',
      inputSchema: {
        type: 'object',
        properties: { ...PAGE_PROPERTIES },
        additionalProperties: false,
      },
      handler: async (args = {}) => {
        const payload = await request('/api/agents/prompt-profiles');
        const { items, ...page } = paginate((payload.profiles || []).map((row) => pickFields(row, ['id', 'label', 'description'])), args);
        return { profiles: items, ...page };
      },
    },
    {
      name: 'monitor_run_agent_task',
      description: 'Run a one-off task with no lasting session. Returns status, session_id and the last 12000 characters of output.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: MCP_PROVIDER_SCHEMA,
          prompt: { type: 'string' },
          workDir: { type: 'string' },
          displayName: { type: 'string' },
          model: MCP_AGENT_MODEL_SCHEMA,
          thinkingLevel: { type: 'string' },
          timeoutMs: { type: 'integer' },
          ...MCP_SELECTION_SCHEMA_PROPERTIES,
          codexPlugins: CODEX_PLUGIN_SELECTION_SCHEMA,
        },
        required: ['provider', 'prompt'],
        additionalProperties: false,
      },
      handler: async ({ provider, prompt, workDir, displayName, model, thinkingLevel, timeoutMs, mcpProfile = 'dueno', mcpServers, codexPlugins, promptProfile, skills }) => {
        assertMcpProviderModel(provider, model);
        const result = await request('/api/agents/tasks', {
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
        const output = String(result.task?.output || result.output || '');
        return { status: result.status, session_id: sessionIdFromResult(result) || null, output: output.slice(-12000), output_length: output.length };
      },
    },
    {
      name: 'register_scheduled_agent',
      description: 'Register a recurring agent task (works with the pump off). snake_case fields are aliases. Returns id and status.',
      inputSchema: {
        type: 'object',
        properties: {
          workDir: { type: 'string', description: 'Used for every run.' },
          work_dir: { type: 'string' },
          prompt: { type: 'string', description: 'Injected into each fresh session.' },
          provider: MCP_PROVIDER_SCHEMA,
          model: MCP_AGENT_MODEL_SCHEMA,
          intervalSeconds: { type: 'integer', description: 'Clamped 15..3600.' },
          interval_seconds: { type: 'integer' },
          maxIterations: { type: 'integer', description: '0 = unlimited.' },
          max_iterations: { type: 'integer' },
          parentThreadId: { type: 'string', description: 'Thread each run joins.' },
          parent_thread_id: { type: 'string' },
          startImmediately: { type: 'boolean', description: 'Default true.' },
          start_immediately: { type: 'boolean' },
          controlProfile: {
            type: 'string',
            enum: [COORDINATOR_SCHEDULE_PROFILE],
            description: 'Grants only the fenced coordinator workflow.',
          },
          control_profile: {
            type: 'string',
            enum: [COORDINATOR_SCHEDULE_PROFILE],
          },
          coordinator: {
            type: 'object',
            description: 'Required with coordinator-v1; stamped as trusted schedule metadata.',
            properties: {
              policyId: { type: 'string' },
              repository: { type: 'string', description: 'owner/repo; prefer repositories for several.' },
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
        return request('/api/agents/scheduled', { method: 'POST', body: { mcpProfile: 'dueno', ...args } }).then((task) => ({ id: task.id, status: task.status }));
      },
    },
    {
      name: 'spawn_loop_session',
      description: 'Start a bounded loop that injects a fixed prompt into one live session on an interval. Returns id and status.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', minLength: 1 },
          session_id: { type: 'string', minLength: 1 },
          prompt: { type: 'string', minLength: 1 },
          interval_seconds: { type: 'integer', minimum: 15, maximum: 1296000 },
          max_iterations: { type: 'integer', minimum: 1, maximum: 100 },
          title: { type: 'string' },
          display_name: { type: 'string' },
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
        }).then((task) => ({ id: task.id, status: task.status }));
      },
    },
    {
      name: 'list_scheduled_agents',
      description: 'List scheduled agent tasks.',
      inputSchema: {
        type: 'object',
        properties: { ...PAGE_PROPERTIES, compact: { type: 'boolean', description: 'false returns full records.' } },
        additionalProperties: false,
      },
      handler: async (args = {}) => {
        const payload = await request('/api/agents/scheduled');
        const policy = coordinatorPolicyForContext(callContext.getStore()?.authContext);
        const tasks = policy ? filterCoordinatorSchedules(policy, payload?.tasks) : (payload.tasks || []);
        const { items, ...page } = paginate(tasks.map((row) => args.compact === false ? row : pickFields(row, ['id', 'type', 'provider', 'status', 'lastSessionId', 'parentThreadId', 'nextRunAtEpochMs'])), args);
        return { tasks: items, ...page };
      },
    },
    {
      name: 'cancel_scheduled_agent',
      description: 'Cancel a scheduled agent task. Returns id and status.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async ({ id }) =>
        request(`/api/agents/scheduled/${encodeURIComponent(String(id || ''))}/cancel`, { method: 'POST', body: {} }).then((task) => ({ id: task.id, status: task.status })),
    },
    {
      name: 'monitor_step_scheduled_agents',
      description: 'Run one scheduled-agent tick now, independent of the pump. Returns schedule ids, session ids and statuses.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async () =>
        request('/api/agents/scheduled/step-now', { method: 'POST', body: {} }).then((payload) => ({
          results: (payload.tasks || []).map((entry) => ({ id: entry.id, session_id: entry.sessionId, status: entry.action })),
        })),
    },
    {
      name: 'monitor_list_human_queue',
      description: 'List Command Center human-decision queue items.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PAGE_PROPERTIES,
          compact: { type: 'boolean', description: 'false returns full records.' },
          status: {
            type: 'string',
            enum: ['open', 'answered', 'routed', 'delivery_failed', 'acknowledged', 'dismissed', 'withdrawn', 'all'],
            description: 'Default open.',
          },
          source: { type: 'string' },
          sessionId: { type: 'string' },
        },
        additionalProperties: false,
      },
      handler: async ({ status = 'open', ...args } = {}) => {
        const params = new URLSearchParams();
        params.set('status', status || 'open');
        const payload = await request(`/api/command-center/work-queue?${params.toString()}`);
        const rows = (payload.items || []).filter((row) => (!args.source || row.source === args.source) && (!args.sessionId || row.sessionId === args.sessionId));
        const { items, ...page } = paginate(rows.map((row) => args.compact === false ? row : pickFields(row, ['id', 'title', 'status', 'priority', 'sessionKind', 'sessionId', 'threadId'])), args);
        return { items, ...page };
      },
    },
    {
      name: 'monitor_add_human_queue_item',
      description: 'Queue a decision for the user in Command Center. Returns id and status.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          question: { type: 'string' },
          details: { type: 'string', description: 'Context needed to answer.' },
          source: { type: 'string', description: 'e.g. fleet_supervisor.' },
          priority: { type: 'string', description: 'low, normal, high or urgent.' },
          sessionKind: { type: 'string', description: 'claude, codex or pi.' },
          sessionId: { type: 'string' },
          threadId: { type: 'string' },
          passThrough: { type: 'boolean', description: 'Route the answer to sessionKind/sessionId, not the supervisor.' },
          operatorAction: {
            type: 'object',
            description: 'Allowlisted operator request, run only after dashboard approval.',
            properties: { method: { type: 'string', enum: ['POST', 'DELETE'] }, path: { type: 'string' }, body: {} },
            required: ['method', 'path'],
            additionalProperties: false,
          },
          allowFreeform: { type: 'boolean', description: 'Default true.' },
          options: {
            type: 'array',
            description: 'Multiple-choice answers.',
            items: QUEUE_OPTION_SCHEMA,
          },
        },
        required: ['question'],
        additionalProperties: false,
      },
      handler: async (args = {}) =>
        request('/api/command-center/work-queue', { method: 'POST', body: args }).then((payload) => ({ id: payload.item?.id || payload.id, status: payload.item?.status || payload.status || 'created' })),
    },
    {
      name: 'monitor_answer_human_queue_item',
      description: 'Answer a human queue item, usually with the user\'s decision. Returns id and status.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          answer: { type: 'string', description: 'Free-form answer.' },
          optionId: { type: 'string' },
          optionValue: { type: 'string' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async ({ id, answer, optionId, optionValue }) =>
        request(`/api/command-center/work-queue/${encodeURIComponent(String(id || ''))}/answer`, {
          method: 'POST',
          body: { answer, optionId, optionValue },
        }).then((payload) => ({ id: payload.item?.id || payload.id, status: payload.item?.status || payload.status })),
    },
    {
      name: 'monitor_update_human_queue_item',
      description: 'Update your own open queue item instead of dismissing and re-adding it. Returns id and status.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          question: { type: 'string' },
          details: { type: 'string' },
          options: {
            type: 'array',
            items: QUEUE_OPTION_SCHEMA,
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async ({ id, ...body }) =>
        request(`/api/command-center/work-queue/${encodeURIComponent(String(id || ''))}/update`, { method: 'POST', body }).then((payload) => ({ id: payload.item?.id || payload.id, status: payload.item?.status || payload.status })),
    },
    {
      name: 'monitor_acknowledge_human_queue_item',
      description: 'Acknowledge a queue item once the routed session action is verified. Returns id and status.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async ({ id, note }) =>
        request(`/api/command-center/work-queue/${encodeURIComponent(String(id || ''))}/acknowledge`, {
          method: 'POST',
          body: { note },
        }).then((payload) => ({ id: payload.item?.id || payload.id, status: payload.item?.status || payload.status })),
    },
    {
      name: 'monitor_dismiss_human_queue_item',
      description: 'Withdraw a queue item that no longer needs a decision; your own item becomes withdrawn and nothing is sent back. Returns id and status.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async ({ id }) =>
        request(`/api/command-center/work-queue/${encodeURIComponent(String(id || ''))}/dismiss`, { method: 'POST', body: {} }).then((payload) => ({ id: payload.item?.id || payload.id, status: payload.item?.status || payload.status })),
    },
    {
      name: 'monitor_send_to_session',
      description: 'Queue text input for a session. Returns transaction_id and status: queued is queue acceptance only (track via monitor_list_session_deliveries(transactionId)); sent means keystrokes reached the pane, not that the agent read them. Results come from the worker via room_send/agent_dm.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['claude', 'codex', 'pi'] },
          sessionId: { type: 'string' },
          text: { type: 'string' },
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
          transaction_id: payload?.transactionId || null,
          status: payload?.state || (payload?.accepted ? 'queued' : payload?.ok ? 'sent' : 'failed'),
          ...(payload?.error ? { error: payload.error } : {}),
        };
      },
    },
    {
      name: 'monitor_list_session_deliveries',
      description: 'List session input delivery records. Append-only per transition, newest first: the first record for a transactionId is its current state. metadata.confirmation holds submit evidence.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['claude', 'codex', 'pi'] },
          sessionId: { type: 'string' },
          source: { type: 'string' },
          status: { type: 'string', enum: ['queued', 'sending', 'awaiting_response', 'sent', 'failed', 'dropped'] },
          transactionId: { type: 'string' },
          ...PAGE_PROPERTIES,
        },
        additionalProperties: false,
      },
      handler: async ({ type, sessionId, source, status, transactionId, ...args } = {}) => {
        const params = new URLSearchParams();
        if (type) params.set('kind', type);
        if (sessionId) params.set('sessionId', sessionId);
        if (source) params.set('source', source);
        if (status) params.set('status', status);
        if (transactionId) params.set('transactionId', transactionId);
        const limit = normalizeLimit(args.limit);
        const offset = normalizeOffset(args.offset);
        params.set('limit', String(limit + 1));
        params.set('offset', String(offset));
        const payload = await request(`/api/session-deliveries?${params.toString()}`);
        const deliveries = payload.deliveries || [];
        return { deliveries: deliveries.slice(0, limit).map((row) => ({ ...pickFields(row, ['id', 'target', 'status', 'createdAt', 'error']), ...(row.metadata?.transactionId ? { transactionId: row.metadata.transactionId } : {}) })),
          limit, offset, hasMore: deliveries.length > limit, ...(deliveries.length > limit ? { nextOffset: offset + limit } : {}) };
      },
    },
    {
      name: 'monitor_get_session_output',
      description: 'Fetch captured session output; page back with nextOffset.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: 'Backend type or provider alias.' },
          sessionId: { type: 'string' },
          lines: { type: 'integer', minimum: 1, maximum: 5000, description: 'History lines. Default 50.' },
          maxChars: { type: 'integer', minimum: 1, maximum: 12000, description: 'Characters per page. Default 3000.' },
          offset: { type: 'integer', minimum: 0, description: 'Characters back from the tail.' },
        },
        required: ['type', 'sessionId'],
        additionalProperties: false,
      },
      handler: async ({ type, sessionId, lines = 50, maxChars = 3000, offset = 0 }) => {
        const count = Math.min(Math.max(Number(lines) || 50, 1), 5000);
        const chars = Math.min(Math.max(Number(maxChars) || 3000, 1), 12000);
        const payload = await request(`/api/${encodeURIComponent(resolveSessionBackendType(type))}/sessions/${encodeURIComponent(sessionId)}?lines=${count}`);
        const text = String(payload.content || payload.output || '')
          .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
          .replace(/\x1b(?:[ -/]*[0-~])?/g, '')
          .replace(/\r+(\n|$)/g, '$1').replace(/[^\n]*\r/g, '');
        const end = Math.max(0, text.length - normalizeOffset(offset));
        const start = Math.max(0, end - chars);
        return { session_id: sessionId, content: text.slice(start, end),
          ...(start > 0 ? { nextOffset: normalizeOffset(offset) + end - start } : {}) };
      },
    },
    {
      name: 'monitor_scheduled_send',
      description: 'Send a message to a session after a delay or at a time. Returns id and status.',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['claude', 'codex', 'pi'] },
          sessionId: { type: 'string' },
          text: { type: 'string' },
          delayMs: { type: 'number' },
          sendAt: { type: 'string', description: 'ISO time; alternative to delayMs.' },
        },
        required: ['type', 'sessionId', 'text'],
        additionalProperties: false,
      },
      handler: async ({ type, sessionId, text, delayMs, sendAt }) =>
        request(`/api/${type}/sessions/${sessionId}/scheduled-send`, { method: 'POST', body: { text, delayMs, sendAt } }).then((payload) => ({ id: payload.sendId, status: payload.status || 'scheduled' })),
    },

    // ── Thread management ──
    {
      name: 'monitor_list_threads',
      description: 'List collaboration threads.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'open (default), stale, closed or all.' },
          limit: { type: 'integer', description: 'Default 25.' },
          offset: { type: 'integer' },
          compact: { type: 'boolean', description: 'false returns full metadata.' },
          include_messages: { type: 'boolean' },
          message_limit: { type: 'integer', description: 'Per thread. Default 10.' },
          fields: { type: 'array', description: 'Thread fields to keep.', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      handler: async ({
        status = 'open',
        limit = DEFAULT_LIST_LIMIT,
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
          limit: normalizeLimit(limit, DEFAULT_LIST_LIMIT),
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
          ...(page.hasMore ? { nextOffset: page.offset + items.length } : {}),
          compact: compact !== false,
          includeMessages: include_messages === true,
          threads: items,
        };
      },
    },
    {
      name: 'spawn_collab_session',
      description: 'Start a collaboration thread with exactly two participants, both given the Cadre onboarding prompt. Returns thread_id, participant ids/names and bootstrap failures.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          projectKey: { type: 'string' },
          worktree: worktreeSchema,
          workDir: { type: 'string', description: 'Default for new sessions.' },
          initialTask: { type: 'string', description: 'Shared task.' },
          model: MCP_AGENT_MODEL_SCHEMA,
          thinkingLevel: { type: 'string', description: 'Default for new participants.' },
          ...MCP_SELECTION_SCHEMA_PROPERTIES,
          codexPlugins: CODEX_PLUGIN_SELECTION_SCHEMA,
          codeMode: CODE_MODE_SCHEMA,
          participants: {
            type: 'array',
            minItems: 2,
            maxItems: 2,
            description: 'Attach session_id or create from provider/model; fields override top-level ones.',
            items: {
              type: 'object',
              properties: {
                ...PARTICIPANT_PROPERTIES,
                machine: { type: 'string', description: 'Paired machine for a new participant; work_dir and the worktree repo are paths there.' },
              },
              additionalProperties: false,
            },
          },
        },
        required: ['title', 'participants'],
        additionalProperties: false,
      },
      handler: async ({ title, projectKey, workDir, worktree, initialTask, model, thinkingLevel, mcpProfile = 'dueno', mcpServers, codexPlugins, promptProfile, skills, codeMode, participants }) => {
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
            ...(worktree ? { worktree } : {}),
            initialTask: initialTask || '',
            skills: skills || [],
            thinkingLevel: thinkingLevel || '',
            ...(mcpProfile !== undefined ? { mcpProfile } : {}),
            ...(mcpServers !== undefined ? { mcpServers } : {}),
            ...(codexPlugins !== undefined ? { codexPlugins } : {}),
            ...(promptProfile !== undefined ? { promptProfile } : {}),
            participants: normalizedParticipants,
            ...(codeMode !== undefined ? { codeMode } : {}),
            structured: collabStructured(codeMode, normalizedParticipants),
          },
        });
        return spawnResult(payload);
      },
    },
    {
      name: 'spawn_conference_session',
      description: 'Start a collaboration thread with two or more participants. Returns thread_id, participant ids/names and bootstrap failures.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          projectKey: { type: 'string' },
          worktree: worktreeSchema,
          workDir: { type: 'string', description: 'Default for new sessions.' },
          initialTask: { type: 'string', description: 'Shared task.' },
          model: MCP_AGENT_MODEL_SCHEMA,
          thinkingLevel: { type: 'string', description: 'Default for new participants.' },
          ...MCP_SELECTION_SCHEMA_PROPERTIES,
          codexPlugins: CODEX_PLUGIN_SELECTION_SCHEMA,
          codeMode: CODE_MODE_SCHEMA,
          participants: {
            type: 'array',
            minItems: 2,
            description: 'Attach session_id or create from provider/model; fields override top-level ones.',
            items: { type: 'object', properties: PARTICIPANT_PROPERTIES, additionalProperties: false },
          },
        },
        required: ['title', 'participants'],
        additionalProperties: false,
      },
      handler: async ({ title, projectKey, workDir, worktree, initialTask, model, thinkingLevel, mcpProfile = 'dueno', mcpServers, codexPlugins, promptProfile, skills, codeMode, participants }) => {
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
            ...(worktree ? { worktree } : {}),
            initialTask: initialTask || '',
            skills: skills || [],
            thinkingLevel: thinkingLevel || '',
            ...(mcpProfile !== undefined ? { mcpProfile } : {}),
            ...(mcpServers !== undefined ? { mcpServers } : {}),
            ...(codexPlugins !== undefined ? { codexPlugins } : {}),
            ...(promptProfile !== undefined ? { promptProfile } : {}),
            participants: normalizedParticipants,
            ...(codeMode !== undefined ? { codeMode } : {}),
            structured: collabStructured(codeMode, normalizedParticipants),
          },
        });
        return spawnResult(payload);
      },
    },
    // ── Recording evidence ──
    {
      name: 'monitor_scan_audio_recordings',
      description: 'Ingest transcript/summary files from the audio inbox as gated evidence. Returns recording ids/status and skipped errors.',
      inputSchema: {
        type: 'object',
        properties: {
        },
        additionalProperties: false,
      },
      handler: async () => request('/api/recordings/scan', { method: 'POST', body: {} }).then((payload) => ({
          results: (payload.imported || []).map((entry) => ({ id: entry.recording?.id || entry.id, status: 'imported' })),
          ...(payload.skipped?.length ? { skipped: payload.skipped } : {}),
        })),
    },
    {
      name: 'monitor_list_audio_recordings',
      description: 'List audio recording manifests (no transcript or summary text).',
      inputSchema: {
        type: 'object',
        properties: {
          sourceTool: { type: 'string' },
          tag: { type: 'string' },
          limit: { type: 'integer', description: 'Default 25.' },
          offset: { type: 'integer' },
        },
        additionalProperties: false,
      },
      handler: async ({ sourceTool = '', tag = '', limit, offset } = {}) => {
        const params = new URLSearchParams();
        if (sourceTool) params.set('sourceTool', sourceTool);
        if (tag) params.set('tag', tag);
        params.set('limit', String(normalizeLimit(limit)));
        params.set('offset', String(normalizeOffset(offset)));
        const payload = await request(`/api/recordings?${params.toString()}`);
        return { ...payload, recordings: (payload.recordings || []).map((row) => pickFields(row, ['id', 'stem', 'sourceTool', 'status', 'actionSessionId'])),
          ...(payload.hasMore ? { nextOffset: payload.offset + payload.recordings.length } : {}) };
      },
    },
    {
      name: 'monitor_read_audio_recording',
      description: 'Read one audio recording manifest (no transcript or summary text).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Recording id or evidence ref.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async ({ id }) =>
        request(`/api/recordings/${encodeURIComponent(String(id || ''))}`),
    },
    {
      name: 'monitor_read_audio_recording_evidence',
      description: 'Read one recording\'s evidence packet: verbatim, capped transcript/summary.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async ({ id }) =>
        request(`/api/recordings/${encodeURIComponent(String(id || ''))}/evidence`),
    },
    {
      name: 'monitor_act_on_audio_recording',
      description: 'Spawn a scoped action session for one recording; evidence is staged in its workdir, the prompt holds counts only. Returns id, session_id and status.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async ({ id }) =>
        request(`/api/recordings/${encodeURIComponent(String(id || ''))}/act`, { method: 'POST', body: {} }).then((payload) => ({
          id, session_id: payload.sessionId, status: 'spawned',
        })),
    },

    // ── Claude Code cloud sessions (internal, undocumented endpoints; see cloud-sessions.mjs) ──
    {
      name: 'cloud_status',
      description: 'List cloud sessions with account usage, or get one by id. Returns id, title, state, detail, needs_action, branches, pr, url and cost_usd.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Omit to list.' } },
        additionalProperties: false,
      },
      handler: async (args = {}) => cloudStatus(args),
    },
    {
      name: 'cloud_output',
      description: 'Tail a cloud session transcript. Returns lines, last_assistant_text and next_seq; pass next_seq as after_seq to continue.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          after_seq: { type: 'integer', minimum: 0, description: 'Omit for the newest events.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args) => cloudOutput(args),
    },
    {
      name: 'cloud_send',
      description: 'Send a message to a cloud session. With wait_s > 0, waits up to wait_s seconds and returns the reply.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string', minLength: 1 },
          wait_s: { type: 'integer', minimum: 0, maximum: 600, description: 'Default 0.' },
        },
        required: ['id', 'text'],
        additionalProperties: false,
      },
      handler: async (args) => cloudSend(args),
    },
    {
      name: 'cloud_launch',
      description: 'Launch a Claude Code cloud session on a GitHub repo, owned by you: Cadre DMs you when it blocks, fails, finishes or opens a PR (then watched via watch_pr). Returns id and url.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', minLength: 1 },
          repo: { type: 'string', pattern: '^[\\w.-]+/[\\w.-]+$', description: 'owner/name.' },
          ref: { type: 'string', minLength: 1, description: 'Default: repo default branch.' },
          name: { type: 'string', minLength: 1, description: 'Session title.' },
          model: { type: 'string', minLength: 1 },
        },
        required: ['prompt', 'repo'],
        additionalProperties: false,
      },
      handler: async (args) => request('/api/cloud/sessions', { method: 'POST', body: args }),
    },
    {
      name: 'cloud_watch',
      description: 'Own an existing cloud session: Cadre DMs you when it blocks, fails, finishes or opens a PR. Returns id, state and status.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1 } },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args) => request('/api/cloud/watch', { method: 'POST', body: args }),
    },
    {
      name: 'cloud_attach',
      description: 'Add a cloud session you then own to a room you own or are in, or with title to a new room you own but are not in (pair it with a reviewer who reports; a solo cloud DMs you, no room needed). Messages addressed to it (reply, id, title, @clouds) reach it; its replies post as cloud:<id>. Returns id, thread_id and status.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          thread_id: { type: 'string', minLength: 1, description: 'Pass this or title.' },
          title: { type: 'string', minLength: 1, description: 'New room title. Pass this or thread_id.' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args) => request('/api/cloud/attach', { method: 'POST', body: args }),
    },
    {
      name: 'cloud_detach',
      description: 'Remove a cloud session from a room you own or are in; it keeps running but stops exchanging room messages. Returns id, thread_id and status.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', minLength: 1 },
          thread_id: { type: 'string', minLength: 1 },
        },
        required: ['id', 'thread_id'],
        additionalProperties: false,
      },
      handler: async (args) => request('/api/cloud/detach', { method: 'POST', body: args }),
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
    'spawn_session',
    'handoff_session',
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
    'monitor_update_human_queue_item',
    'monitor_dismiss_human_queue_item',
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
    'cloud_status',
    'cloud_output',
    'cloud_send',
    'cloud_launch',
    'cloud_watch',
    'cloud_attach',
    'cloud_detach',
  ]);

  const discoverableTools = tools.filter((t) => (
    DISCOVERABLE_TOOL_NAMES.has(t.name)
  ));

  const validateArguments = compileToolArguments(tools);

  // MCP protocol handler
  return {
    tools: discoverableTools,
    allTools: tools,
    async handleToolCall(name, args, context = null) {
      const tool = tools.find(t => t.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      validateArguments(name, args === undefined ? {} : args);
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
