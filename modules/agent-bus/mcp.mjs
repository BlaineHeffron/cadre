import { readFileSync, existsSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { getAgentBusCredentialStore, isAgentSpawnTool } from './mcp-auth.mjs';
import { messageSummary } from './envelope.mjs';
import { TASK_TOOLS } from './task-routes.mjs';
import {
  coordinatorAuditTarget,
  coordinatorPolicyForContext,
  filterCoordinatorControlResult,
  isCoordinatorControlTool,
  loopRegistrationPolicyForContext,
} from './coordinator-policy.mjs';
import { readEnv } from '../platform/cadre-env.mjs';

const LEGACY_PROTOCOL_VERSION = '2025-11-25';
const STATELESS_PROTOCOL_VERSION = '2026-07-28';
const SERVER_NAME = 'dueno-agent-bus';
const SERVER_VERSION = '0.1.0';
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const CACHEABLE_METHODS = new Set([
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
]);
const EMPTY_LIST = Object.freeze([]);
const DEFAULT_CONTEXT_MESSAGE_LIMIT = 8;
const DEFAULT_CONTEXT_BODY_CHARS = 1200;
const MCP_ID_MAX = 240;
const MCP_BODY_MAX = 200000;
const AGENT_PERMISSION_AUTHORITY_TOOLS = new Set([
  'monitor_answer_human_queue_item',
  'monitor_send_to_session',
  'monitor_scheduled_send',
]);
const AGENT_PRIVILEGED_CONTROL_TOOLS = new Set([
  'spawn_session',
  'spawn_collab_session',
  'register_scheduled_agent',
  'monitor_step_scheduled_agents',
  'monitor_terminate_session',
]);

function repoRootFromMeta(metaUrl) {
  return resolve(dirname(fileURLToPath(metaUrl)), '..');
}

function parseDotEnv(raw) {
  const env = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function loadLocalEnv(repoRoot) {
  const envPath = resolve(repoRoot, '.env');
  if (!existsSync(envPath)) return {};
  try {
    return parseDotEnv(readFileSync(envPath, 'utf8'));
  } catch {
    return {};
  }
}

function inferBaseUrl(repoRoot, env = process.env) {
  const localEnv = loadLocalEnv(repoRoot);
  const host = readEnv('DUENO_MONITOR_HOST', env) || env.HOST || localEnv.HOST || '127.0.0.1';
  const port = readEnv('DUENO_MONITOR_PORT', env) || env.PORT || localEnv.PORT || '8443';
  const tlsKey = env.TLS_KEY || localEnv.TLS_KEY || 'certs/server.key';
  const tlsCert = env.TLS_CERT || localEnv.TLS_CERT || 'certs/server.crt';
  const hasTls = existsSync(resolve(repoRoot, tlsKey)) && existsSync(resolve(repoRoot, tlsCert));
  return `${hasTls ? 'https' : 'http'}://${host}:${port}`;
}

function inferAuthToken(repoRoot, env = process.env) {
  const localEnv = loadLocalEnv(repoRoot);
  return readEnv('DUENO_MONITOR_TOKEN', env) || env.AUTH_TOKEN || localEnv.AUTH_TOKEN || '';
}

function envFlagEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function buildAgentBusMcpRequest({
  baseUrl,
  authToken = '',
  allowInsecureTls = false,
  httpRequestImpl = httpRequest,
  httpsRequestImpl = httpsRequest,
} = {}) {
  if (!baseUrl) throw new Error('baseUrl is required');

  const normalizedBaseUrl = new URL(baseUrl);
  const requestImpl = normalizedBaseUrl.protocol === 'https:' ? httpsRequestImpl : httpRequestImpl;
  const tlsAgent = normalizedBaseUrl.protocol === 'https:'
    ? new HttpsAgent({ rejectUnauthorized: !allowInsecureTls })
    : null;

  return async function agentBusMcpRequest(path, { method = 'GET', body } = {}) {
    const requestUrl = new URL(path, normalizedBaseUrl);
    const headers = { Accept: 'application/json' };
    const payload = body === undefined ? null : JSON.stringify(body);
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const response = await new Promise((resolveRequest, rejectRequest) => {
      const req = requestImpl(requestUrl, {
        method,
        headers,
        ...(tlsAgent ? { agent: tlsAgent } : {}),
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = null;
          }
          resolveRequest({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            payload: parsed,
          });
        });
      });

      req.on('error', rejectRequest);
      if (payload !== null) req.write(payload);
      req.end();
    });

    if (!response.ok) {
      throw new Error(response.payload?.error || `${method} ${path} failed with ${response.status}`);
    }

    return response.payload;
  };
}

function textResult(text, structuredContent) {
  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

function compactRoomContext(payload, args = {}) {
  const summaryOnly = args.summary_only === true;
  const includeBodies = args.bodies !== false && !summaryOnly;
  const includeDeliveries = args.deliveries === true;
  const paging = Boolean(args.message_id);
  const bodyLimit = Number.isInteger(args.body_limit) && args.body_limit > 0
    ? Math.min(args.body_limit, DEFAULT_CONTEXT_BODY_CHARS)
    : DEFAULT_CONTEXT_BODY_CHARS;
  const bodyOffset = paging && Number.isInteger(args.body_offset) && args.body_offset > 0 ? args.body_offset : 0;
  let messages = Array.isArray(payload?.messages) ? payload.messages : [];
  if (paging) {
    messages = messages.filter((message) => message.id === args.message_id);
  } else {
    if (args.since) {
      const idx = messages.findIndex((message) => message.id === args.since);
      if (idx >= 0) messages = messages.slice(idx + 1);
    }
    if (args.after) {
      const ts = Date.parse(args.after) || Number(args.after);
      if (Number.isFinite(ts)) messages = messages.filter((message) => Number(message.createdAt) > ts);
    }
  }
  const compactMessages = messages.map((message) => {
    const body = String(message.body || '');
    if (!includeBodies) {
      return {
        id: message.id, from: message.from, type: message.type, createdAt: message.createdAt, replyTo: message.replyTo || null,
        ...(summaryOnly ? { summary: messageSummary(message) } : {}),
      };
    }
    const slice = body.slice(bodyOffset, bodyOffset + bodyLimit);
    const truncated = bodyOffset + slice.length < body.length;
    return {
      id: message.id, from: message.from, type: message.type, createdAt: message.createdAt, replyTo: message.replyTo || null,
      body: slice, truncated, bodyLength: body.length,
      ...(truncated ? { nextOffset: bodyOffset + slice.length } : {}),
    };
  });
  const participants = (payload?.thread?.participants || []).map((item) => ({
    kind: item.kind, sessionId: item.sessionId,
    canSendNow: item.session_capabilities?.canSendNow === true,
    canSendNowReason: item.can_send_now_reason || null,
    status: item.canonical_status || item.session_state || null,
  }));
  const deliveries = includeDeliveries ? (payload?.deliveries || []).map((delivery) => ({
    id: delivery.id, messageId: delivery.messageId, target: delivery.target, status: delivery.status,
    holdReason: delivery.holdReason || null, willInjectWhenIdle: delivery.willInjectWhenIdle === true,
    createdAt: delivery.createdAt, resolution: delivery.resolution || null, cancelledAt: delivery.cancelledAt || null,
    attempts: delivery.attempts, lastAttemptAt: delivery.lastAttemptAt, error: delivery.error || null,
  })) : undefined;
  return {
    thread: { id: payload?.thread?.id, title: payload?.thread?.title, status: payload?.thread?.status, health: payload?.thread?.health,
      deliveryHealth: payload?.thread?.metadata?.deliveryHealth, participants },
    messageCount: compactMessages.length,
    totalMessageCount: payload?.messageCount ?? compactMessages.length,
    messages: compactMessages,
    ...(deliveries ? { deliveries } : {}),
    ...(paging && compactMessages.length === 0 ? { missingMessageId: String(args.message_id) } : {}),
  };
}

function compactMessageResult(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const deliveries = Array.isArray(payload?.deliveries) ? payload.deliveries : [];
  const failedTargets = Array.isArray(payload?.failedTargets) ? payload.failedTargets : [];
  return {
    message: payload?.message || null,
    delivery: payload?.delivery || null,
    messageCount: messages.length,
    deliveryCount: deliveries.length,
    failedTargets: failedTargets.map((entry) => ({
      target: entry?.target || null,
      error: entry?.error || null,
      messageId: entry?.message?.id || null,
      deliveryId: entry?.delivery?.id || null,
    })),
  };
}

function assertMcpString(value, name, { maxLength = MCP_ID_MAX, allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`);
  }
  if (!allowEmpty && !value.trim()) {
    throw new Error(`${name} is required`);
  }
  if (value.length > maxLength) {
    throw new Error(`${name} must be at most ${maxLength} characters`);
  }
  return value;
}

function assertMcpAgentRef(kind, sessionId, label) {
  return {
    kind: assertMcpString(kind, `${label}_kind`),
    sessionId: assertMcpString(sessionId, `${label}_session_id`),
  };
}

function authenticatedContext(value = {}) {
  return value?.authenticated === true && value?.legacyUntrusted !== true;
}

function authorizationError(message, reason = 'forbidden') {
  const error = new Error(message);
  error.code = 'mcp_forbidden';
  error.reason = reason;
  error.statusCode = 403;
  return error;
}

function principalAgentRef(context = {}) {
  const principal = context.principal || {};
  if (!principal.kind || !principal.sessionId) throw authorizationError('Credential has no actor identity', 'principal_missing');
  return { kind: String(principal.kind), sessionId: String(principal.sessionId) };
}

function sameAgentRef(left, right) {
  return left?.kind === right?.kind && left?.sessionId === right?.sessionId;
}

function actorInThread(thread, actor) {
  return sameAgentRef(thread?.createdBy, actor)
    || (thread?.participants || []).some((entry) => sameAgentRef(entry, actor));
}

function contextAllowsThread(context, threadOrEntry) {
  if (!authenticatedContext(context)) return true;
  const thread = threadOrEntry?.thread || threadOrEntry || {};
  const allowlist = Array.isArray(context.threadAllowlist) ? context.threadAllowlist : [];
  if (allowlist.includes('*') || allowlist.includes(thread.id)) return true;
  if (!allowlist.includes('@member')) return false;
  return actorInThread(thread, principalAgentRef(context));
}

export function buildAgentBusMcpServer({
  baseUrl,
  authToken = '',
  fetchImpl = fetch,
  requestImpl = null,
  extraTools = [],
  credentialStore = getAgentBusCredentialStore(),
} = {}) {
  if (!baseUrl && !requestImpl) {
    throw new Error('baseUrl is required');
  }
  const requestContext = new AsyncLocalStorage();

  async function request(path, { method = 'GET', body, taskRoomRead = false } = {}) {
    if (requestImpl) {
      const context = requestContext.getStore();
      return requestImpl(path, { method, body, authContext: context ? { ...context, taskRoomRead } : null });
    }

    const headers = { Accept: 'application/json' };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      // Keep the server's error code/details: callers below discriminate on them instead of
      // pattern-matching a human-readable message.
      const error = new Error(payload?.error || `${method} ${path} failed with ${response.status}`);
      if (payload?.code) error.code = payload.code;
      if (payload?.reason) error.reason = payload.reason;
      if (payload?.details && typeof payload.details === 'object') error.details = payload.details;
      error.statusCode = response.status;
      throw error;
    }

    return payload;
  }

  async function rejectAuthorization(context, tool, reason, message) {
    await credentialStore.recordRejectedCall({ reason, tool, principal: context?.principal || null }).catch(() => {});
    throw authorizationError(message, reason);
  }

  async function assertToolScope(context, tool) {
    if (!authenticatedContext(context)) {
      if (context?.legacyUntrusted === true && AGENT_PERMISSION_AUTHORITY_TOOLS.has(tool)) {
        await rejectAuthorization(context, tool, 'permission_authority_denied', 'Unauthenticated legacy callers cannot send session input or approve permission interactions');
      }
      if (context?.legacyUntrusted === true && isAgentSpawnTool(tool)) {
        await rejectAuthorization(context, tool, 'child_session_credential_required', 'Child-session creation requires an authenticated Cadre session credential');
      }
      if (context?.legacyUntrusted === true && isCoordinatorControlTool(tool) && !isAgentSpawnTool(tool)) {
        await rejectAuthorization(context, tool, 'coordinator_credential_required', 'Coordinator controls require an authenticated scoped credential');
      }
      return;
    }
    const scopes = Array.isArray(context.toolScopes) ? context.toolScopes : [];
    if (!scopes.includes('*') && !scopes.includes(tool)) {
      await rejectAuthorization(context, tool, 'scope_missing', `Credential does not grant ${tool}`);
    }
  }

  async function authorizeCoordinatorControl(_context, _name, _args = {}) {
    return;
  }

  async function assertThreadAccess(context, threadId, tool, knownPayload = null) {
    if (!authenticatedContext(context)) return knownPayload;
    const id = String(threadId || '').trim();
    if (!id) await rejectAuthorization(context, tool, 'thread_missing', 'thread_id is required');
    const payload = knownPayload || await request(`/api/agent-bus/threads/${encodeURIComponent(id)}?messageLimit=0&deliveryLimit=0`);
    const resolvedId = String(payload?.thread?.id || id);
    const allowlist = Array.isArray(context.threadAllowlist) ? context.threadAllowlist : [];
    const explicitlyAllowlisted = allowlist.includes('*') || allowlist.includes(resolvedId);
    if (explicitlyAllowlisted) return payload;
    if (allowlist.includes('@member')) {
      if (!payload?.thread?.metadata?.dm && ['room_context', 'room_send', 'room_close', 'room_end', 'room_transfer'].includes(tool)) return payload;
      if (!actorInThread(payload?.thread, principalAgentRef(context))) {
        await rejectAuthorization(context, tool, 'thread_membership_required', `Actor is not a participant in thread ${resolvedId}`);
      }
      return payload;
    }
    await rejectAuthorization(context, tool, 'thread_not_allowlisted', `Credential is not valid for thread ${resolvedId}`);
    return payload;
  }

  async function authorizeTool(context, name, args) {
    await assertToolScope(context, name);
    if (!authenticatedContext(context)) return;
    await authorizeCoordinatorControl(context, name, args);
    if (['room_context', 'room_send', 'room_close', 'room_end', 'room_transfer', 'room_reopen', ...TASK_TOOLS.map((tool) => tool.name)].includes(name)) {
      await assertThreadAccess(context, args.thread_id, name);
    }
  }

  const tools = [
    ...TASK_TOOLS,
    ...['watch_pr', 'unwatch_pr'].map((name) => ({ name,
      description: name === 'watch_pr' ? 'Watch a configured repo PR for reviews, conflicts, merge or close. Ends the linked room on merge. Cadre never merges.' : 'Remove a PR watch.',
      inputSchema: { type: 'object', properties: { repo: { type: 'string' }, number: { type: 'integer', minimum: 1 },
        ...(name === 'watch_pr' ? { thread_id: { type: 'string' } } : {}) }, required: ['repo', 'number'], additionalProperties: false },
    })),
    {
      name: 'room_send',
      description: 'Post in any non-DM room without subscribing; DMs require membership. Participants receive messages; the owner also receives results. Set summary on type=result as <merged|ready|blocked|needs-decision> · PR #n · <one line>.',
      inputSchema: { type: 'object', properties: {
        thread_id: { type: 'string' }, body: { type: 'string' }, summary: { type: 'string', maxLength: 200 }, reply_to: { type: 'string' },
        type: { type: 'string', enum: ['message', 'result'] },
      }, required: ['thread_id', 'body'], additionalProperties: false },
    },
    {
      name: 'room_context',
      description: 'Read recent truncated messages in any non-DM room without subscribing; DMs require membership. Continue a truncated body with message_id and body_offset=nextOffset (ignores since/after). since=message id, after=timestamp; pass deliveries=true as needed, or bodies=false or summary_only=true (summaries, no bodies) to save context.',
      inputSchema: { type: 'object', properties: {
        thread_id: { type: 'string' }, limit: { type: 'integer', minimum: 0, maximum: 500 },
        since: { type: 'string' }, after: { type: 'string' }, message_id: { type: 'string' },
        body_offset: { type: 'integer', minimum: 0 }, body_limit: { type: 'integer', minimum: 1, maximum: 1200 },
        bodies: { type: 'boolean' }, deliveries: { type: 'boolean' }, summary_only: { type: 'boolean' },
      }, required: ['thread_id'], additionalProperties: false },
    },
    {
      name: 'room_list',
      description: 'List rooms the agent owns or subscribes to; scope=all lists all open non-DM rooms.',
      inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['all'] } }, additionalProperties: false },
    },
    {
      name: 'room_close',
      description: 'Archive a room without terminating sessions. Agents must own the room, be a DM participant, or all participants must be gone. Pending deliveries block closure unless cancel_pending explicitly cancels them.',
      inputSchema: { type: 'object', properties: { thread_id: { type: 'string' }, cancel_pending: { type: 'boolean' } },
        required: ['thread_id'], additionalProperties: false },
    },
    {
      name: 'room_reopen',
      description: 'Explicitly reopen an archived room. Cancelled deliveries stay terminal; legacy queued deliveries may resume.',
      inputSchema: { type: 'object', properties: { thread_id: { type: 'string' } },
        required: ['thread_id'], additionalProperties: false },
    },
    {
      name: 'room_end',
      description: 'Owners may close a non-DM room and terminate participants not shared with another open room. Ending always cancels queued deliveries.',
      inputSchema: { type: 'object', properties: { thread_id: { type: 'string' } },
        required: ['thread_id'], additionalProperties: false },
    },
    {
      name: 'room_transfer',
      description: 'Transfer room ownership as its owner, or claim it for yourself if the owner session is gone. The destination must be a live agent session. Operators may always transfer.',
      inputSchema: { type: 'object', properties: { thread_id: { type: 'string' },
        to: { type: 'object', properties: { kind: { type: 'string' }, session_id: { type: 'string' } },
          required: ['kind', 'session_id'], additionalProperties: false } },
        required: ['thread_id', 'to'], additionalProperties: false },
    },
    {
      name: 'agent_dm',
      description: 'Send a direct message to any agent, creating the deterministic pair room when needed.',
      inputSchema: { type: 'object', properties: {
        kind: { type: 'string' }, session_id: { type: 'string' }, body: { type: 'string' }, summary: { type: 'string', maxLength: 200 },
      }, required: ['kind', 'session_id', 'body'], additionalProperties: false },
    },
    {
      name: 'agent_directory',
      description: 'List agents across providers with display names and canonical session state.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];

  // Merge extra tools (e.g. monitor tools for command center AI)
  if (extraTools.length > 0) {
    for (const t of extraTools) {
      tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
    }
  }
  const exposedTools = tools;

  const prompts = [
    {
      name: 'collaboration_guidance',
      description: 'Brief instructions for using the Cadre collaboration bus tools.',
      arguments: [],
    },
  ];

  const resources = EMPTY_LIST;
  const resourceTemplates = EMPTY_LIST;

  async function callToolImpl(name, args = {}, authContext = null) {
    await authorizeTool(authContext, name, args);
    if (TASK_TOOLS.some((tool) => tool.name === name)) {
      if (!authenticatedContext(authContext)) throw authorizationError('Task operations require an authenticated credential', 'principal_missing');
      const payload = await request(`/api/agent-bus/tasks/${name.slice(5)}`, { method: 'POST', body: args });
      return textResult(JSON.stringify(payload), payload);
    }
    switch (name) {
      case 'watch_pr':
      case 'unwatch_pr': {
        if (!authenticatedContext(authContext)) throw authorizationError('PR watches require an authenticated agent credential', 'principal_missing');
        principalAgentRef(authContext);
        const payload = await request('/api/agents/github/watches', { method: name === 'watch_pr' ? 'POST' : 'DELETE',
          body: { repo: assertMcpString(args.repo, 'repo'), number: args.number,
            ...(name === 'watch_pr' && args.thread_id ? { thread_id: assertMcpString(args.thread_id, 'thread_id') } : {}) } });
        return textResult(JSON.stringify(payload), payload);
      }

      case 'room_context': {
        const threadId = assertMcpString(args.thread_id, 'thread_id');
        const count = Number.isInteger(args.limit) ? args.limit : DEFAULT_CONTEXT_MESSAGE_LIMIT;
        const fetchLimit = args.message_id ? Math.max(count, 500) : args.since || args.after ? Math.max(count, 200) : count;
        const deliveryLimit = args.deliveries === true ? fetchLimit : 0;
        const payload = await request(`/api/agent-bus/threads/${encodeURIComponent(threadId)}?messageLimit=${fetchLimit}&deliveryLimit=${deliveryLimit}`, {
          taskRoomRead: args.summary_only !== true && args.bodies !== false && count > 0,
        });
        const compact = compactRoomContext(payload, args);
        return textResult(JSON.stringify(compact), compact);
      }

      case 'room_send': {
        if (!authenticatedContext(authContext)) throw authorizationError('Room sends require an authenticated agent credential', 'principal_missing');
        const from = principalAgentRef(authContext);
        const payload = await request('/api/agent-bus/messages', { method: 'POST', body: {
          threadId: assertMcpString(args.thread_id, 'thread_id'), from,
          body: assertMcpString(args.body, 'body', { maxLength: MCP_BODY_MAX }),
          ...(args.summary !== undefined ? { summary: assertMcpString(args.summary, 'summary', { maxLength: 200, allowEmpty: true }) } : {}),
          ...(args.reply_to ? { replyTo: args.reply_to } : {}),
          ...(args.type === 'result' ? { type: 'result' } : {}),
          deliveryMode: 'enqueue',
        } });
        return textResult(`Broadcast ${payload.message?.id || 'message'} queued.`, compactMessageResult(payload));
      }

      case 'room_list': {
        if (!authenticatedContext(authContext)) throw authorizationError('Room listing requires an authenticated agent credential', 'principal_missing');
        const actor = principalAgentRef(authContext);
        const payload = await request(args.scope === 'all' ? '/api/agent-bus/threads?status=open'
          : `/api/agent-bus/threads/by-participant?kind=${encodeURIComponent(actor.kind)}&sessionId=${encodeURIComponent(actor.sessionId)}&status=all`);
        const rooms = (payload?.threads || []).filter((thread) => args.scope !== 'all' || !thread.metadata?.dm).map((thread) => ({ id: thread.id, title: thread.title,
          kind: thread.metadata?.dm ? 'dm' : 'room', status: thread.status, participants: thread.participants || [] }));
        return textResult(`${rooms.length} room(s).`, { rooms });
      }

      case 'room_transfer': {
        if (!authenticatedContext(authContext)) throw authorizationError('Room transfer requires an authenticated credential', 'principal_missing');
        const payload = await request(`/api/agent-bus/threads/${encodeURIComponent(assertMcpString(args.thread_id, 'thread_id'))}/transfer`, {
          method: 'POST', body: { to: assertMcpAgentRef(args.to?.kind, args.to?.session_id, 'to') },
        });
        return textResult('Room ownership transferred.', payload);
      }

      case 'room_close':
      case 'room_reopen':
      case 'room_end': {
        if (!authenticatedContext(authContext)) throw authorizationError('Room lifecycle actions require an authenticated agent credential', 'principal_missing');
        const threadId = assertMcpString(args.thread_id, 'thread_id');
        const action = name.slice('room_'.length);
        const payload = await request(`/api/agent-bus/threads/${encodeURIComponent(threadId)}/${action}`, { method: 'POST', body: name === 'room_close' && args.cancel_pending === true ? { cancelPending: true } : {} });
        return textResult(`Room ${threadId} ${payload.status || action}.`, payload);
      }

      case 'agent_dm': {
        if (!authenticatedContext(authContext)) throw authorizationError('Direct messages require an authenticated agent credential', 'principal_missing');
        const from = principalAgentRef(authContext);
        const payload = await request('/api/agent-bus/dm', { method: 'POST', body: {
          from, target: assertMcpAgentRef(args.kind, args.session_id, 'target'),
          body: assertMcpString(args.body, 'body', { maxLength: MCP_BODY_MAX }),
          ...(args.summary !== undefined ? { summary: assertMcpString(args.summary, 'summary', { maxLength: 200, allowEmpty: true }) } : {}),
        } });
        return textResult(`DM ${payload.message?.id || 'message'} queued.`, payload);
      }

      case 'agent_directory': {
        const kinds = ['claude', 'codex', 'pi'];
        const payloads = await Promise.all(kinds.map((kind) => request(`/api/${kind}/sessions`).catch(() => ({ sessions: [] }))));
        const agents = payloads.flatMap((payload, index) => (payload.sessions || []).map((session) => ({
          kind: kinds[index], sessionId: session.id || session.sessionId,
          displayName: session.displayName || session.sessionName || session.name || '',
          state: session.state?.status || session.status || 'unknown',
          canSendNow: session.state?.capabilities?.canSendNow === true,
          canSendNowReason: session.state?.capabilities?.canSendNow === true ? null : (session.state?.reason || null),
        }))).filter((agent) => agent.sessionId);
        return textResult(agents.map((agent) => `${agent.kind}:${agent.sessionId} ${agent.displayName} [${agent.state}]`).join('\n') || 'No agents.', { agents });
      }
      default: {
        // Check extra tools
        const extra = extraTools.find(t => t.name === name);
        if (extra) {
          const result = await extra.handler(args, { authContext });
          const policy = coordinatorPolicyForContext(authContext);
          const filtered = policy && isCoordinatorControlTool(name)
            ? filterCoordinatorControlResult(policy, name, result)
            : result;
          return textResult(
            typeof filtered === 'string' ? filtered : JSON.stringify(filtered, null, 2),
            filtered,
          );
        }
        throw new Error(`Unknown tool: ${name}`);
      }
    }
  }

  function callTool(name, args = {}, authContext = null) {
    return requestContext.run(authContext || null, async () => {
      const audited = authContext?.principal?.type === 'agent' && isCoordinatorControlTool(name);
      const registrationAudited = authContext?.principal?.type === 'agent'
        && ['register_scheduled_agent', 'spawn_loop_session'].includes(name);
      const policy = coordinatorPolicyForContext(authContext);
      const audit = async (outcome, denialReason = '') => {
        if (!audited) return;
        await credentialStore.recordCoordinatorAction({
          policyId: policy?.policyId || '',
          scheduleId: policy?.scheduleId || '',
          tool: name,
          target: coordinatorAuditTarget(name, args),
          outcome,
          denialReason,
          principal: authContext?.principal || null,
        });
      };
      const registrationAudit = async (outcome, denialReason = '') => {
        if (!registrationAudited) return;
        await credentialStore.recordLoopRegistrationAction({
          tool: name,
          target: coordinatorAuditTarget(name, args),
          outcome,
          denialReason,
          principal: authContext?.principal || null,
        });
      };
      try {
        const result = await callToolImpl(name, args, authContext);
        await audit('succeeded');
        await registrationAudit('succeeded');
        return result;
      } catch (error) {
        const denied = error?.code === 'mcp_forbidden' || Number(error?.statusCode) === 403;
        await audit(denied ? 'denied' : 'failed', error?.reason || error?.code || error?.message || 'tool_failed').catch(() => {});
        await registrationAudit(denied ? 'denied' : 'failed', error?.reason || error?.code || error?.message || 'tool_failed').catch(() => {});
        throw error;
      }
    });
  }

  async function handleRequest(message, options = {}) {
    const { id, method, params } = message;
    const requestedProtocolVersion = options.protocolVersion
      || params?._meta?.[PROTOCOL_VERSION_META_KEY]
      || '';
    const stateless = method === 'server/discover'
      || requestedProtocolVersion === STATELESS_PROTOCOL_VERSION;
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    const success = (result, { cacheable = CACHEABLE_METHODS.has(method) } = {}) => ({
      jsonrpc: '2.0',
      id,
      result: stateless ? {
        ...result,
        resultType: result?.resultType || 'complete',
        ...(cacheable ? { ttlMs: LIST_CACHE_TTL_MS, cacheScope: 'private' } : {}),
        _meta: {
          ...(result?._meta || {}),
          [SERVER_INFO_META_KEY]: serverInfo,
        },
      } : result,
    });

    if (method === 'server/discover') {
      if (authenticatedContext(options.authContext)) await assertToolScope(options.authContext, 'mcp:discover');
      return success({
        supportedVersions: [STATELESS_PROTOCOL_VERSION],
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
      }, { cacheable: true });
    }

    if (method === 'initialize' && !stateless) {
      return success({
        protocolVersion: params?.protocolVersion || LEGACY_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo,
      });
    }

    if (method === 'notifications/initialized' && !stateless) return null;

    if (method === 'ping') {
      if (stateless) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: 'Method not found: ping' },
        };
      }
      return success({});
    }

    if (method === 'tools/list') {
      const context = options.authContext || null;
      if (authenticatedContext(context)) await assertToolScope(context, 'mcp:discover');
      const visibleTools = authenticatedContext(context)
        ? exposedTools.filter((tool) => (
            context.toolScopes?.includes('*') || context.toolScopes?.includes(tool.name)
          ))
        : (context?.legacyUntrusted === true
            ? exposedTools.filter((tool) => !isCoordinatorControlTool(tool.name) && !isAgentSpawnTool(tool.name))
            : exposedTools);
      return success({ tools: visibleTools });
    }

    if (method === 'prompts/list') {
      if (authenticatedContext(options.authContext)) await assertToolScope(options.authContext, 'mcp:discover');
      return success({ prompts });
    }

    if (method === 'prompts/get') {
      if (authenticatedContext(options.authContext)) await assertToolScope(options.authContext, 'mcp:discover');
      if (params?.name !== 'collaboration_guidance') {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Unknown prompt: ${params?.name || ''}` },
        };
      }

      return success({
        description: prompts[0].description,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                  'Prefer the top-level spawn tools when they are available in your current MCP server: `spawn_session` for one agent, `spawn_collab_session` for a 2-agent thread, and `spawn_conference_session` for 2+ participants.',
                  'Non-DM rooms are open: any agent may read or post without subscribing. DMs remain member-only. Participants receive messages; owners also receive results. Use room_list(scope="all") for all open non-DM rooms.',
                  'Call room_list to rediscover your rooms and room_context before replying when you need room history.',
                  'room_context is truncated by default; continue with message_id and body_offset=nextOffset; set reply_to when addressing a prior claim; use type=result for a terminal outcome.',
                  'After opening a PR, the room owner may call watch_pr({repo, number, thread_id}). Cadre watches transitions and ends the linked room on merge; Cadre never merges.',
                  'Call room_send to broadcast. Owners use room_close to archive after deliveries settle; any agent may close once all participants are gone. Other participants post type=result and stop. Use room_reopen to recover an archived room. Room owners and operators use room_end to terminate unshared participants; room_transfer hands ownership to a successor or claims a room whose owner is gone.',
                  'Call agent_dm for a direct message and agent_directory for the unified roster.',
              ].join('\n'),
            },
          },
        ],
      });
    }

    if (method === 'resources/list') {
      if (authenticatedContext(options.authContext)) await assertToolScope(options.authContext, 'mcp:discover');
      return success({ resources });
    }

    if (method === 'resources/templates/list') {
      if (authenticatedContext(options.authContext)) await assertToolScope(options.authContext, 'mcp:discover');
      return success({ resourceTemplates });
    }

    if (method === 'tools/call') {
      try {
        const result = await callTool(params?.name, params?.arguments || {}, options.authContext || null);
        return success(result);
      } catch (err) {
        if (TASK_TOOLS.some((tool) => tool.name === params?.name) && err?.code !== 'mcp_forbidden') {
          const failure = { error: err.message || 'Task operation failed', code: err.code || null, statusCode: err.statusCode || 500 };
          return success({ isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }], structuredContent: failure });
        }
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: err?.code === 'mcp_forbidden' ? -32003 : -32000,
            message: err.message || 'Tool call failed',
            ...(err?.reason ? { data: { reason: err.reason } } : {}),
          },
        };
      }
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    };
  }

  return {
    tools: exposedTools,
    callTool,
    handleRequest,
  };
}

export function createDefaultAgentBusMcpServer(metaUrl, overrides = {}) {
  const repoRoot = repoRootFromMeta(metaUrl);
  const baseUrl = overrides.baseUrl || inferBaseUrl(repoRoot);

  return buildAgentBusMcpServer({
    baseUrl,
    authToken: overrides.authToken ?? inferAuthToken(repoRoot),
    fetchImpl: overrides.fetchImpl || fetch,
    requestImpl: overrides.requestImpl || (overrides.fetchImpl ? null : buildAgentBusMcpRequest({
      baseUrl,
      authToken: overrides.authToken ?? inferAuthToken(repoRoot),
      allowInsecureTls: envFlagEnabled(readEnv('DUENO_MONITOR_ALLOW_INSECURE_TLS')),
      httpRequestImpl: overrides.httpRequestImpl || httpRequest,
      httpsRequestImpl: overrides.httpsRequestImpl || httpsRequest,
    })),
  });
}
