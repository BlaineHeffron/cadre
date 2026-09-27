import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../../config.mjs';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { incrementOpsCounter } from '../ops/observability.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import {
  normalizeCredentialCoordinatorPolicy,
  normalizeLoopRegistrationPolicy,
} from './coordinator-policy.mjs';
import { readEnv } from '../platform/cadre-env.mjs';

export const AGENT_BUS_MCP_AUDIENCE = 'dueno-mcp';
export const AGENT_BUS_MCP_SERVER_ID = 'dueno';
export const AGENT_BUS_MCP_IN_PROCESS_CONTEXT_HEADER = 'x-dueno-inprocess-mcp-context';
export const AGENT_BUS_MCP_AUTH_MODES = Object.freeze(['off', 'issue_only', 'enforce']);
export const AGENT_SPAWN_TOOL_SCOPES = Object.freeze([
  'spawn_session',
  'spawn_collab_session',
  'spawn_conference_session',
  'monitor_spawn_claude',
  'monitor_spawn_codex',
  'monitor_run_agent_task',
  'register_scheduled_agent',
  'spawn_loop_session',
]);
export const AGENT_BUS_AGENT_TOOL_SCOPES = Object.freeze([
  'mcp:discover',
  'room_send',
  'room_context',
  'room_list',
  'room_close',
  'room_reopen',
  'room_end',
  'agent_dm',
  'agent_directory',
  'task_spawn', 'task_send', 'task_wait', 'task_status', 'task_cancel', 'task_resume',
  ...AGENT_SPAWN_TOOL_SCOPES,
]);

export function isAgentSpawnTool(name) {
  return AGENT_SPAWN_TOOL_SCOPES.includes(String(name || ''));
}

const MAX_AUDIT_EVENTS = 2_000;
const TOKEN_PREFIX = 'dueno_mcp_v1';
const inProcessAuthContext = new AsyncLocalStorage();
const inProcessRequestContexts = new Map();
// Bound to inject duration: Fastify auth consumes the id; the caller also discards in finally.
const IN_PROCESS_CONTEXT_TTL_MS = 30_000;
const DEFAULT_AUDIT_PERSIST_EVERY = 50;
const DEFAULT_AUDIT_PERSIST_INTERVAL_MS = 1_000;

export function runWithAgentBusMcpAuthContext(authContext, fn) {
  return inProcessAuthContext.run(authContext || null, fn);
}

export function currentAgentBusMcpAuthContext() {
  return inProcessAuthContext.getStore() || null;
}

export function registerAgentBusMcpInProcessRequestContext(authContext, now = Date.now()) {
  if (!authContext) return '';
  const id = randomBytes(32).toString('base64url');
  inProcessRequestContexts.set(id, { authContext: clone(authContext), expiresAt: now + IN_PROCESS_CONTEXT_TTL_MS });
  return id;
}

export function consumeAgentBusMcpInProcessRequestContext(id, now = Date.now()) {
  const key = text(id);
  if (!key) return null;
  const entry = inProcessRequestContexts.get(key);
  inProcessRequestContexts.delete(key);
  if (!entry || entry.expiresAt < now) return null;
  return clone(entry.authContext);
}

export function discardAgentBusMcpInProcessRequestContext(id) {
  if (id) inProcessRequestContexts.delete(String(id));
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function text(value) {
  return String(value || '').trim();
}

function uniqueStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];
}

function tokenHash(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function safeEqual(left, right) {
  try {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function principalKey(principal = {}) {
  return [text(principal.type), text(principal.kind), text(principal.sessionId)].join(':');
}

function normalizePrincipal(principal = {}) {
  const type = text(principal.type || 'agent').toLowerCase();
  const kind = text(principal.kind).toLowerCase();
  const sessionId = text(principal.sessionId);
  if (!['agent', 'ui', 'service'].includes(type)) throw new TypeError('principal.type must be agent, ui, or service');
  if (!kind) throw new TypeError('principal.kind is required');
  if (!sessionId) throw new TypeError('principal.sessionId is required');
  return Object.freeze({ type, kind, sessionId });
}

function normalizeState(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    credentials: source.credentials && typeof source.credentials === 'object' ? source.credentials : {},
    activeByPrincipal: source.activeByPrincipal && typeof source.activeByPrincipal === 'object' ? source.activeByPrincipal : {},
    attemptGenerations: source.attemptGenerations && typeof source.attemptGenerations === 'object' ? source.attemptGenerations : {},
    audit: Array.isArray(source.audit) ? source.audit.slice(-MAX_AUDIT_EVENTS) : [],
  };
}

export function normalizeAgentBusMcpAuthMode(value, fallback = 'issue_only') {
  const normalized = text(value).toLowerCase();
  return AGENT_BUS_MCP_AUTH_MODES.includes(normalized) ? normalized : fallback;
}

export function bearerTokenFromHeader(header = '') {
  const value = String(header || '');
  if (!value.startsWith('Bearer ')) return '';
  return value.slice(7).trim();
}

export class AgentBusCredentialStore {
  constructor({
    stateFile = runtimeStatePath('agent_bus_mcp_credentials.json'),
    env = process.env,
    mode = normalizeAgentBusMcpAuthMode(readEnv('DM_AGENT_BUS_MCP_AUTH', env)),
    now = () => Date.now(),
    auditPersistEvery = Number(readEnv('DM_AGENT_BUS_MCP_AUDIT_PERSIST_EVERY', env) || DEFAULT_AUDIT_PERSIST_EVERY),
    auditPersistIntervalMs = Number(readEnv('DM_AGENT_BUS_MCP_AUDIT_PERSIST_INTERVAL_MS', env) || DEFAULT_AUDIT_PERSIST_INTERVAL_MS),
    store = null,
  } = {}) {
    this.stateFile = stateFile;
    this.mode = mode;
    this.now = now;
    this.auditPersistEvery = Math.max(1, Number(auditPersistEvery) || DEFAULT_AUDIT_PERSIST_EVERY);
    this.auditPersistIntervalMs = Math.max(0, Number(auditPersistIntervalMs) || 0);
    this.auditDirty = 0;
    this.lastAuditPersistAt = this.now();
    this.store = store || buildPostgresJsonStore({
      namespace: 'agent_bus_mcp_credentials',
      filePath: stateFile,
      modeEnvKey: 'AGENT_BUS_CREDENTIALS_STORAGE',
      env,
    });
    this.state = normalizeState();
    this.initialized = false;
    this.initPromise = null;
  }

  async init() {
    if (this.initialized) return this;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        this.state = normalizeState(await this.store.load().catch(() => null));
        this.initialized = true;
        return this;
      })();
    }
    return this.initPromise;
  }

  async #reloadPersistedState({ preferMemory = true } = {}) {
    const persisted = normalizeState(await this.store.load().catch(() => null));
    if (!persisted) return;
    if (preferMemory) {
      this.state = {
        version: 1,
        credentials: { ...persisted.credentials, ...this.state.credentials },
        activeByPrincipal: { ...persisted.activeByPrincipal, ...this.state.activeByPrincipal },
        attemptGenerations: { ...persisted.attemptGenerations, ...this.state.attemptGenerations },
        audit: this.state.audit.length >= persisted.audit.length ? this.state.audit : persisted.audit,
      };
      return;
    }
    this.state = persisted;
  }

  #authenticateFromState(token, {
    audience = AGENT_BUS_MCP_AUDIENCE,
    serverId = AGENT_BUS_MCP_SERVER_ID,
  } = {}) {
    const value = String(token || '');
    const parts = value.split('.');
    const jti = parts.length === 3 && parts[0] === TOKEN_PREFIX ? text(parts[1]) : '';
    const record = jti ? this.state.credentials[jti] : null;
    if (!jti || !record || !safeEqual(record.tokenHash, tokenHash(value))) return this.#reject('unknown_token');
    if (record.status !== 'active') return this.#reject('revoked', record);
    if (record.audience !== text(audience)) return this.#reject('wrong_audience', record);
    if (!record.serverAllowlist.includes('*') && !record.serverAllowlist.includes(text(serverId))) {
      return this.#reject('wrong_server', record);
    }
    const key = principalKey(record.principal);
    if (this.state.activeByPrincipal[key] !== record.jti) return this.#reject('replayed_jti', record);
    if (Number(this.state.attemptGenerations[key]) !== Number(record.attemptGeneration)) {
      return this.#reject('attempt_generation_mismatch', record);
    }
    incrementOpsCounter('agent_bus_mcp_auth_accept_total', 1, { reason: 'credential' });
    return {
      ok: true,
      authenticated: true,
      legacyUntrusted: false,
      credential: this.#publicRecord(record),
      principal: clone(record.principal),
      toolScopes: [...record.toolScopes],
      threadAllowlist: [...record.threadAllowlist],
      serverAllowlist: [...record.serverAllowlist],
      coordinatorPolicy: clone(record.coordinatorPolicy || null),
      loopRegistrationPolicy: clone(record.loopRegistrationPolicy || null),
    };
  }

  async issue({
    principal,
    attemptGeneration,
    audience = AGENT_BUS_MCP_AUDIENCE,
    threadAllowlist,
    serverAllowlist = [AGENT_BUS_MCP_SERVER_ID],
    toolScopes = AGENT_BUS_AGENT_TOOL_SCOPES,
    coordinatorPolicy = null,
    loopRegistrationPolicy = null,
    reason = 'issue',
  } = {}) {
    await this.init();
    await this.#reloadPersistedState({ preferMemory: true });
    if (this.mode === 'off') return null;
    const normalizedPrincipal = normalizePrincipal(principal);
    const resolvedThreadAllowlist = threadAllowlist === undefined
      ? (normalizedPrincipal.type === 'agent' ? ['@member'] : [])
      : threadAllowlist;
    const generation = Number(attemptGeneration);
    if (!Number.isInteger(generation) || generation < 1) throw new TypeError('attemptGeneration must be a positive integer');
    const key = principalKey(normalizedPrincipal);
    const priorJti = this.state.activeByPrincipal[key];
    if (priorJti && this.state.credentials[priorJti]?.status === 'active') {
      this.#revokeRecord(this.state.credentials[priorJti], reason === 'rotate' ? 'rotated' : 'superseded');
    }

    const jti = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const token = `${TOKEN_PREFIX}.${jti}.${secret}`;
    const issuedAt = this.now();
    const record = {
      jti,
      tokenHash: tokenHash(token),
      principal: normalizedPrincipal,
      attemptGeneration: generation,
      audience: text(audience),
      threadAllowlist: uniqueStrings(resolvedThreadAllowlist),
      serverAllowlist: uniqueStrings(serverAllowlist),
      toolScopes: uniqueStrings(toolScopes),
      coordinatorPolicy: normalizeCredentialCoordinatorPolicy(coordinatorPolicy),
      loopRegistrationPolicy: normalizeLoopRegistrationPolicy(loopRegistrationPolicy),
      issuedAt,
      status: 'active',
      revokedAt: null,
      revokeReason: null,
    };
    this.state.credentials[jti] = record;
    this.state.activeByPrincipal[key] = jti;
    this.state.attemptGenerations[key] = generation;
    const event = priorJti || reason === 'rotate' ? 'rotate' : 'issue';
    this.#audit(event, record, { reason });
    incrementOpsCounter(event === 'rotate' ? 'agent_bus_mcp_token_rotated_total' : 'agent_bus_mcp_token_issued_total', 1, {
      principal: normalizedPrincipal.type,
    });
    await this.#persist();
    return { token, credential: this.#publicRecord(record) };
  }

  async setAttemptGeneration(principal, generation) {
    await this.init();
    const normalized = normalizePrincipal(principal);
    const numeric = Number(generation);
    if (!Number.isInteger(numeric) || numeric < 1) throw new TypeError('generation must be a positive integer');
    this.state.attemptGenerations[principalKey(normalized)] = numeric;
    await this.#persist();
  }

  async revoke({ principal, jti, reason = 'revoked' } = {}) {
    await this.init();
    const normalized = principal ? normalizePrincipal(principal) : null;
    const key = normalized ? principalKey(normalized) : '';
    const targetJti = text(jti) || (key ? this.state.activeByPrincipal[key] : '');
    const record = this.state.credentials[targetJti];
    if (!record || record.status !== 'active') return false;
    this.#revokeRecord(record, reason);
    if (this.state.activeByPrincipal[principalKey(record.principal)] === record.jti) {
      delete this.state.activeByPrincipal[principalKey(record.principal)];
    }
    this.#audit('revoke', record, { reason });
    incrementOpsCounter('agent_bus_mcp_token_revoked_total', 1, { principal: record.principal.type });
    await this.#persist();
    return true;
  }

  async authenticate(token, {
    audience = AGENT_BUS_MCP_AUDIENCE,
    serverId = AGENT_BUS_MCP_SERVER_ID,
  } = {}) {
    await this.init();
    const first = this.#authenticateFromState(token, { audience, serverId });
    if (first.ok || first.reason !== 'unknown_token') return first;
    await this.#reloadPersistedState({ preferMemory: true });
    return this.#authenticateFromState(token, { audience, serverId });
  }

  async recordLegacyCall(method = '') {
    await this.init();
    incrementOpsCounter('agent_bus_mcp_legacy_untrusted_total', 1, { mode: this.mode });
    this.state.audit.push({
      event: 'legacy_untrusted',
      at: this.now(),
      method: text(method).slice(0, 120),
    });
    this.#trimAudit();
    await this.#persistAudit();
  }

  async recordRejectedCall({ reason = 'forbidden', tool = '', principal = null } = {}) {
    await this.init();
    const normalizedReason = text(reason).toLowerCase().replace(/[^a-z0-9_:-]/g, '_').slice(0, 80) || 'forbidden';
    incrementOpsCounter('agent_bus_mcp_auth_reject_total', 1, { reason: normalizedReason });
    this.state.audit.push({
      event: 'reject',
      at: this.now(),
      reason: normalizedReason,
      tool: text(tool).slice(0, 120),
      principal: principal && typeof principal === 'object'
        ? {
            type: text(principal.type || 'unknown').slice(0, 40),
            kind: text(principal.kind || 'unknown').slice(0, 80),
            sessionId: text(principal.sessionId || 'unknown').slice(0, 160),
          }
        : null,
    });
    this.#trimAudit();
    await this.#persistAudit();
  }

  async recordCoordinatorAction({
    policyId = '',
    scheduleId = '',
    tool = '',
    target = '',
    outcome = 'denied',
    denialReason = '',
    principal = null,
  } = {}) {
    await this.init();
    const normalizedOutcome = ['attempted', 'succeeded', 'failed', 'denied'].includes(text(outcome))
      ? text(outcome)
      : 'failed';
    this.state.audit.push({
      event: 'coordinator_control',
      at: this.now(),
      policyId: text(policyId) || 'none',
      scheduleId: text(scheduleId) || 'unknown',
      tool: text(tool).slice(0, 120),
      target: text(target).slice(0, 500),
      outcome: normalizedOutcome,
      denialReason: text(denialReason).slice(0, 160) || null,
      principal: principal && typeof principal === 'object'
        ? {
            type: text(principal.type || 'unknown').slice(0, 40),
            kind: text(principal.kind || 'unknown').slice(0, 80),
            sessionId: text(principal.sessionId || 'unknown').slice(0, 160),
          }
        : null,
    });
    incrementOpsCounter('coordinator_control_total', 1, { outcome: normalizedOutcome });
    this.#trimAudit();
    // Privileged-control audit is part of the authorization boundary. Persist each
    // record immediately instead of using the ordinary high-volume audit batching.
    await this.#persist();
  }

  async recordLoopRegistrationAction({
    tool = 'register_scheduled_agent',
    target = '',
    outcome = 'denied',
    denialReason = '',
    principal = null,
  } = {}) {
    await this.init();
    const normalizedOutcome = ['succeeded', 'failed', 'denied'].includes(text(outcome)) ? text(outcome) : 'failed';
    this.state.audit.push({
      event: 'loop_registration',
      at: this.now(),
      tool: text(tool).slice(0, 120),
      target: text(target).slice(0, 500),
      outcome: normalizedOutcome,
      denialReason: text(denialReason).slice(0, 160) || null,
      principal: principal && typeof principal === 'object' ? {
        type: text(principal.type || 'unknown').slice(0, 40),
        kind: text(principal.kind || 'unknown').slice(0, 80),
        sessionId: text(principal.sessionId || 'unknown').slice(0, 160),
      } : null,
    });
    incrementOpsCounter('loop_registration_total', 1, { outcome: normalizedOutcome });
    this.#trimAudit();
    await this.#persist();
  }

  credentialFor(principal) {
    const normalized = normalizePrincipal(principal);
    const key = principalKey(normalized);
    const record = this.state.credentials[this.state.activeByPrincipal[key]];
    if (!record || record.status !== 'active') return null;
    if (record.audience !== AGENT_BUS_MCP_AUDIENCE) return null;
    if (!record.serverAllowlist.includes('*') && !record.serverAllowlist.includes(AGENT_BUS_MCP_SERVER_ID)) {
      return null;
    }
    if (Number(this.state.attemptGenerations[key]) !== Number(record.attemptGeneration)) return null;
    return this.#publicRecord(record);
  }

  readiness(sessions = []) {
    const checkedAt = this.now();
    const entries = (Array.isArray(sessions) ? sessions : []).map((session) => {
      const principal = normalizePrincipal({ type: 'agent', kind: session.kind, sessionId: session.sessionId });
      const credential = this.credentialFor(principal);
      return {
        kind: principal.kind,
        sessionId: principal.sessionId,
        authenticatedCredential: Boolean(credential),
        attemptGeneration: credential?.attemptGeneration || null,
      };
    });
    const missing = entries.filter((entry) => !entry.authenticatedCredential);
    return {
      mode: this.mode,
      readyForEnforce: missing.length === 0,
      checkedAt,
      sessionCount: entries.length,
      missingCredentialCount: missing.length,
      missing,
      sessions: entries,
      retirement: missing.length ? 'Resume each legacy session to rotate in a credential, or end it before enabling enforce.' : 'No legacy sessions detected.',
    };
  }

  auditEvents() {
    return clone(this.state.audit);
  }

  async close() {
    if (this.auditDirty) await this.#persist();
    await this.store.close?.();
  }

  #publicRecord(record) {
    const { tokenHash: _tokenHash, ...safe } = record;
    return clone(safe);
  }

  #reject(reason, record = null) {
    return { ok: false, reason, principal: record ? clone(record.principal) : null };
  }

  #revokeRecord(record, reason) {
    record.status = 'revoked';
    record.revokedAt = this.now();
    record.revokeReason = text(reason) || 'revoked';
  }

  #audit(event, record, details = {}) {
    this.state.audit.push({
      event,
      at: this.now(),
      jti: record.jti,
      principal: clone(record.principal),
      attemptGeneration: record.attemptGeneration,
      audience: record.audience,
      reason: text(details.reason),
    });
    this.#trimAudit();
  }

  #trimAudit() {
    if (this.state.audit.length > MAX_AUDIT_EVENTS) {
      this.state.audit.splice(0, this.state.audit.length - MAX_AUDIT_EVENTS);
    }
  }

  async #persistAudit() {
    this.auditDirty += 1;
    const elapsed = this.now() - this.lastAuditPersistAt;
    if (this.auditDirty < this.auditPersistEvery && elapsed < this.auditPersistIntervalMs) return;
    await this.#persist();
  }

  async #persist() {
    await this.store.save(this.state);
    this.auditDirty = 0;
    this.lastAuditPersistAt = this.now();
    if (this.store.mode !== 'postgres' && this.stateFile) await chmod(this.stateFile, 0o600).catch(() => {});
  }
}

let defaultStore = null;

export function getAgentBusCredentialStore() {
  if (!defaultStore) {
    defaultStore = new AgentBusCredentialStore({
      mode: config.agentBusMcpAuth?.mode || normalizeAgentBusMcpAuthMode(readEnv('DM_AGENT_BUS_MCP_AUTH')),
    });
  }
  return defaultStore;
}

export function resetAgentBusCredentialStoreForTests() {
  defaultStore = null;
}
