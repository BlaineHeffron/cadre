import { randomBytes } from 'node:crypto';
import { prepareHeadroomLaunch } from '../agent/headroom.mjs';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpTransport } from '../agent/acp-transport.mjs';
import { AttachmentStore } from '../agent/attachment-store.mjs';
import { ProcessSupervisor } from '../agent/process-supervisor.mjs';
import { incrementOpsCounter } from '../ops/observability.mjs';
import { permissionAuthorityForRequest } from '../platform/auth.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import { projectCompatibility } from '../session-state/contract.mjs';
import { createJournalStore } from './journal-store.mjs';
import { registerProtocolSessionProvider } from './protocol-session-registry.mjs';
import { notifyAgentSessionDeleted } from '../agent/session-delete-events.mjs';
import { SessionService } from './session-service.mjs';
import { normalizeSessionWorkDir } from './workdir.mjs';
import {
  cleanupAgentBusCredentialLaunch,
  prepareAgentBusCredentialLaunch,
} from '../integrations/mcp-launch-preflight.mjs';
import { config } from '../../config.mjs';
import { buildAgentBusMcpUrl } from '../platform/mcp-seed.mjs';
import {
  deepSeekMcpCapabilities,
  discoverDeepSeekDuenoTools,
  removeDeepSeekAttemptCordis,
  writeDeepSeekAttemptCordis,
} from './deepseek-mcp.mjs';
import { withCadreEnv } from '../platform/cadre-env.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_CONFIG_PATH = resolve(REPO_ROOT, 'config/deepseek-acp.cordis.yml');
const LOCAL_ACP_BINARY = resolve(REPO_ROOT, 'node_modules/.bin/dsh-acp-demo');
const DEEPSEEK_MODELS = new Set(['deepseek-v4-pro', 'deepseek-v4-flash']);
const LIST_BROADCAST_MS = 250;
export const DEEPSEEK_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'DEEPSEEK_API_KEY',
  'DEEPSEEK_MODEL', 'DSH_SESSION_ROOT', 'DSH_PERMISSION_MODE', 'DSH_HOME',
  'DEEPSEEK_BASE_URL',
  'DUENO_AGENT_BUS_TOKEN',
]);
const UNSUPPORTED_CAPABILITY_FIELDS = Object.freeze(['thinkingLevel', 'mcpProfile', 'promptProfile']);

function text(value) {
  return String(value || '').trim();
}

export function defaultDeepSeekAcpBinary() {
  return process.env.DEEPSEEK_ACP_BIN || (existsSync(LOCAL_ACP_BINARY) ? LOCAL_ACP_BINARY : 'dsh-acp-demo');
}

export function defaultDeepSeekAcpConfigPath() {
  return process.env.DEEPSEEK_ACP_CONFIG || DEFAULT_CONFIG_PATH;
}

export function resolveDeepSeekPermissionMode(env = process.env) {
  return String(env.DSH_PERMISSION_MODE || env.DEEPSEEK_PERMISSION_MODE || '').trim() === 'danger-full-access'
    ? 'danger-full-access'
    : 'workspace-write';
}

export function buildDeepSeekChildEnv({ sourceEnv = process.env, model, sessionRoot, permissionMode, homeDir } = {}) {
  const env = {};
  for (const key of DEEPSEEK_ENV_ALLOWLIST) {
    if (sourceEnv[key] != null && sourceEnv[key] !== '') env[key] = String(sourceEnv[key]);
  }
  env.DEEPSEEK_MODEL = model || env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
  if (sessionRoot) env.DSH_SESSION_ROOT = sessionRoot;
  env.DSH_PERMISSION_MODE = permissionMode || resolveDeepSeekPermissionMode(sourceEnv);
  if (homeDir) {
    env.HOME = homeDir;
    env.DSH_HOME = homeDir;
  }
  if (!env.PATH) env.PATH = '/usr/bin:/bin';
  return env;
}

export function getDeepSeekProviderHealth({
  binary = defaultDeepSeekAcpBinary(), configPath = defaultDeepSeekAcpConfigPath(), env = process.env,
} = {}) {
  const binaryOk = Boolean(binary && (binary.includes('/') ? existsSync(binary) : true));
  const configOk = existsSync(configPath);
  const hasApiKey = Boolean(String(env.DEEPSEEK_API_KEY || '').trim());
  const ok = binaryOk && configOk && hasApiKey;
  return {
    ok, status: ok ? 'ok' : 'unavailable', binary, binaryOk, configPath, configOk, hasApiKey,
    experimental: true,
    detail: ok ? 'deepseek_acp_ready' : [
      !binaryOk ? 'binary_missing' : null,
      !configOk ? 'config_missing' : null,
      !hasApiKey ? 'api_key_missing' : null,
    ].filter(Boolean).join(','),
  };
}

function rejectUnsupportedCapabilities(body = {}) {
  const reasons = [];
  for (const field of UNSUPPORTED_CAPABILITY_FIELDS) {
    if (body[field] != null && body[field] !== '' && body[field] !== 'default') reasons.push(field);
  }
  if (Array.isArray(body.mcpServers) && body.mcpServers.length) reasons.push('mcpServers');
  if (body.mcpServers && !Array.isArray(body.mcpServers) && typeof body.mcpServers === 'object' && Object.keys(body.mcpServers).length) reasons.push('mcpServers');
  if (Array.isArray(body.skills) && body.skills.length) reasons.push('skills');
  if (body.image || body.images || body.attachment || body.attachments || body.files) reasons.push('attachments');
  if (reasons.length) {
    const error = new Error(`DeepSeek Harness does not support: ${reasons.join(', ')}`);
    error.statusCode = 400;
    error.code = 'unsupported_capability';
    throw error;
  }
}

function openInteraction(session) {
  return session.interactions.find((interaction) => interaction.status === 'open') || null;
}

function contentFromTranscript(session) {
  let result = '';
  const turnsWithDeltas = new Set(session.transcript.filter((entry) => entry.type === 'message.delta').map((entry) => entry.turnId));
  for (const entry of session.transcript) {
    if (entry.type === 'user.message') {
      const value = (entry.blocks || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      if (value) result += `${result ? '\n\n' : ''}> ${value}`;
    } else if (entry.type === 'message.delta' && entry.delta?.type === 'text') {
      result += String(entry.delta.text || '');
    } else if (entry.type === 'message.committed' && !turnsWithDeltas.has(entry.turnId)) {
      result += (entry.blocks || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
    }
  }
  return result;
}

export function projectDeepSeekSession(session) {
  const state = projectCompatibility(session.canonicalState);
  return {
    id: session.id,
    name: `deepseek-${session.id}`,
    sessionName: `deepseek-${session.id}`,
    displayName: session.displayName,
    provider: 'deepseek', runtime: 'deepseek', source: 'acp_committed_text', transport: 'acp',
    transcriptGrade: 'committed_text', experimental: true,
    workDir: session.workDir,
    created: session.createdAt,
    content: contentFromTranscript(session),
    diagnostics: session.diagnostics.map((entry) => entry.message || '').join('\n'),
    state, canonicalState: session.canonicalState,
    pendingResponse: state.execution === 'working' ? { sentAt: session.updatedAt } : null,
    canResume: false,
    nonResumable: session.nonResumable || session.lifecycle === 'interrupted',
    endedWithHistory: session.endedWithHistory || session.lifecycle === 'interrupted',
    attachCommand: '',
    attempts: session.attempts,
    turns: session.turns,
    negotiated: session.negotiated,
  };
}

function errorReply(reply, error, fallbackCode = 500) {
  return reply.code(error?.statusCode || fallbackCode).send({ error: error?.message || 'DeepSeek ACP request failed', code: error?.code || null });
}

export async function deepseekSessionsPlugin(app, {
  wsManager,
  transportFactory = null,
  supervisor = null,
  journal = null,
  binary = defaultDeepSeekAcpBinary(),
  configPath = defaultDeepSeekAcpConfigPath(),
  sessionRoot = process.env.DEEPSEEK_SESSION_ROOT || runtimeStatePath('deepseek_sessions'),
  homeDir = process.env.DEEPSEEK_DSH_HOME || runtimeStatePath('deepseek_home'),
  healthFn = getDeepSeekProviderHealth,
  permissionMode = resolveDeepSeekPermissionMode(),
  credentialStore,
  sourceConfig = config,
  mcpDiscovery = discoverDeepSeekDuenoTools,
  attemptConfigWriter = writeDeepSeekAttemptCordis,
  attemptConfigRemover = removeDeepSeekAttemptCordis,
  sessionDeliveryAuditStore = null,
  attachmentStore = null,
} = {}) {
  await mkdir(sessionRoot, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  const processSupervisor = supervisor || new ProcessSupervisor({
    ledgerPath: resolve(sessionRoot, 'ledger.json'),
    onOrphanReaped: (verdict) => {
      incrementOpsCounter('structured_orphan_reaped', 1, {
        transport: 'acp', provider: 'deepseek', outcome: verdict.status,
      });
    },
  });
  await processSupervisor.init();
  const journalStore = journal || createJournalStore({ rootDir: resolve(sessionRoot, 'journal') });
  const fleetAttachmentStore = attachmentStore || new AttachmentStore({
    rootDir: resolve(sessionRoot, 'attachments'),
  });
  const service = new SessionService({
    journal: journalStore,
    attachmentStore: fleetAttachmentStore,
    provider: 'deepseek',
    deliveryAuditStore: sessionDeliveryAuditStore,
    logger: app.log,
    transportFactory: (spec) => {
      if (transportFactory) return transportFactory(spec);
      return new AcpTransport({
        binary, configPath: spec.configPath || configPath,
        env: spec.env,
        allowedEnvKeys: DEEPSEEK_ENV_ALLOWLIST,
        supervisor: processSupervisor,
        capabilityEvidence: spec.capabilityEvidence,
      });
    },
  });
  await service.init();
  const unregister = registerProtocolSessionProvider('deepseek', { service, project: projectDeepSeekSession });

  async function cleanupAttempt(sessionId, attemptGeneration = 1, reason = 'attempt_ended') {
    await Promise.all([
      attemptConfigRemover({ sessionId, attemptGeneration }).catch(() => {}),
      cleanupAgentBusCredentialLaunch({
        backendType: 'deepseek', sessionId, reason,
        ...(credentialStore ? { credentialStore } : {}),
      }),
    ]);
  }

  let listBroadcastTimer = null;
  function broadcastList() {
    if (listBroadcastTimer) return;
    listBroadcastTimer = setTimeout(() => {
      listBroadcastTimer = null;
      wsManager?.broadcast('deepseek:sessions', 'sessions', { sessions: service.list().map(projectDeepSeekSession) });
    }, LIST_BROADCAST_MS);
    listBroadcastTimer.unref?.();
  }
  const unsubscribe = service.subscribe((session, event) => {
    const projected = projectDeepSeekSession(session);
    const appended = event.type === 'transport.event' && event.data?.event?.type === 'message.delta'
      ? String(event.data.event.delta?.text || '')
      : '';
    wsManager?.broadcast(`deepseek:session:${session.id}`, 'content', {
      revision: projected.state.revision,
      cursor: event.seq,
      appended,
      content: appended ? undefined : projected.content,
      state: projected.state,
      canonicalState: projected.canonicalState,
      pendingResponse: projected.pendingResponse,
    });
    wsManager?.broadcast(`deepseek:session:${session.id}`, 'events', { events: [event], cursor: event.seq });
    broadcastList();
    if (event.type === 'transport.event' && event.data?.event?.type === 'attempt.exited') {
      const generation = session.attempts.find((attempt) => attempt.attemptId === event.data.event.provenance?.attemptId)?.generation || 1;
      void cleanupAttempt(session.id, generation, 'attempt_process_ended');
    }
  });

  function requireSession(id) {
    const session = service.get(String(id || ''));
    if (!session) {
      const error = new Error(`DeepSeek session not found: ${id}`);
      error.statusCode = 404;
      error.code = 'session_not_found';
      throw error;
    }
    return session;
  }

  async function interactionAuthority(req, session, interaction) {
    try {
      return permissionAuthorityForRequest(req, {
        tool: interaction?.toolCall?.title || 'deepseek.permission',
        scope: 'permission.approve',
        risk: interaction?.toolCall?.kind || 'provider_tool_execution',
      });
    } catch (error) {
      if (error.authorityAudit) {
        await service.recordInteractionAuthority(session.id, {
          interactionId: interaction.interactionId,
          authority: error.authorityAudit,
        }).catch(() => {});
      }
      throw error;
    }
  }

  app.get('/api/deepseek/health', async () => healthFn({ binary, configPath }));
  app.get('/api/deepseek/sessions', async () => ({ sessions: service.list().map(projectDeepSeekSession) }));
  app.post('/api/deepseek/sessions', async (req, reply) => {
    let id = '';
    try {
      rejectUnsupportedCapabilities(req.body || {});
      const health = healthFn({ binary, configPath });
      if (!health.ok) {
        const error = new Error(`DeepSeek Harness is unavailable (${health.detail})`);
        error.statusCode = 503;
        error.code = health.detail || 'deepseek_unhealthy';
        throw error;
      }
      const workDir = await normalizeSessionWorkDir(req.body?.workDir);
      if (!workDir) {
        const error = new Error('workDir is required for DeepSeek Harness sessions');
        error.statusCode = 400;
        throw error;
      }
      const model = text(req.body?.model) || 'deepseek-v4-pro';
      if (!DEEPSEEK_MODELS.has(model)) {
        const error = new Error(`Unsupported DeepSeek Harness model: ${model}`);
        error.statusCode = 400;
        error.code = 'unsupported_model';
        throw error;
      }
      const requestedId = req.body?.sessionId || randomBytes(8).toString('hex');
      if (typeof requestedId !== 'string' || !/^[a-f0-9]{8,32}$/.test(requestedId) || service.get(requestedId)) throw Object.assign(new Error('Invalid or duplicate sessionId'), { statusCode: 400 });
      id = requestedId;
      const busCredential = await prepareAgentBusCredentialLaunch({
        backendType: 'deepseek',
        sessionId: id,
        attemptGeneration: 1,
        ...(credentialStore ? { credentialStore } : {}),
      });
      if (!busCredential?.token) {
        const error = new Error('DeepSeek Harness requires an authenticated Cadre MCP credential');
        error.statusCode = 503;
        error.code = 'deepseek_mcp_credential_required';
        throw error;
      }
      const mcpUrl = buildAgentBusMcpUrl(sourceConfig);
      const attemptConfigPath = await attemptConfigWriter({
        baseConfigPath: configPath,
        sessionId: id,
        attemptGeneration: 1,
        model,
        permissionMode,
        mcpUrl,
      });
      const discovery = await mcpDiscovery({ url: mcpUrl, token: busCredential.token });
      const capabilityEvidence = deepSeekMcpCapabilities({ discoveryProven: discovery?.authenticated === true });
      if (capabilityEvidence.busParticipation !== 'authenticated_scoped') {
        const error = new Error('DeepSeek authenticated Agent Bus capability proof failed');
        error.statusCode = 503;
        error.code = 'deepseek_mcp_capability_unproven';
        throw error;
      }
      const childEnv = buildDeepSeekChildEnv({
        model,
        sessionRoot: resolve(sessionRoot, id),
        permissionMode,
        homeDir: resolve(homeDir, id),
      });
      Object.assign(childEnv, withCadreEnv({ DUENO_AGENT_BUS_TOKEN: busCredential.token }));
      Object.assign(childEnv, (await prepareHeadroomLaunch('deepseek')).env);
      await mkdir(childEnv.DSH_SESSION_ROOT, { recursive: true });
      await mkdir(childEnv.DSH_HOME, { recursive: true });
      let session = await service.start({
        sessionId: id,
        provider: 'deepseek',
        metadata: req.body?.metadata,
        displayName: text(req.body?.displayName),
        workDir,
        model,
        permissionMode,
        configPath: attemptConfigPath,
        capabilityEvidence,
        env: childEnv,
        allowedEnvKeys: DEEPSEEK_ENV_ALLOWLIST,
      });
      const initialPrompt = text(req.body?.initialPrompt);
      if (initialPrompt) {
        await service.prompt(id, {
          blocks: [{ type: 'text', text: initialPrompt }],
          idempotencyKey: text(req.body?.idempotencyKey) || `initial:${id}`,
          source: 'session_create',
        });
        session = service.get(id);
      }
      return { ...projectDeepSeekSession(session), initialPromptInjected: Boolean(initialPrompt) };
    } catch (error) {
      if (id && service.get(id) && !['ended', 'interrupted'].includes(service.get(id).lifecycle)) {
        await service.terminate(id, { reason: 'start_failed' }).catch(() => {});
      }
      if (id) await cleanupAttempt(id, 1, 'start_failed');
      return errorReply(reply, error);
    }
  });

  app.get('/api/deepseek/sessions/:id', async (req, reply) => {
    try { return projectDeepSeekSession(requireSession(req.params.id)); } catch (error) { return errorReply(reply, error); }
  });

  const inputHandler = async (req, reply) => {
    try {
      const session = requireSession(req.params.id);
      const value = text(req.body?.text || req.body?.keys || req.body?.optionId);
      if (req.body?.blocks != null && !Array.isArray(req.body.blocks)) {
        const error = new TypeError('blocks must be an array when provided');
        error.code = 'invalid_prompt_blocks';
        error.statusCode = 400;
        throw error;
      }
      const blocks = Array.isArray(req.body?.blocks) && req.body.blocks.length
        ? structuredClone(req.body.blocks)
        : null;
      const interaction = openInteraction(session);
      if (interaction) {
        const authority = await interactionAuthority(req, session, interaction);
        await service.answerInteraction(session.id, {
          interactionId: interaction.interactionId,
          optionId: value,
          authority,
          expected: req.body || {},
        });
      } else {
        service.assertExpectedState(session.id, req.body || {});
        await service.prompt(session.id, {
          blocks: blocks || [{ type: 'text', text: value }],
          idempotencyKey: text(req.body?.idempotencyKey) || randomBytes(16).toString('hex'),
          source: text(req.body?.source) || 'api',
        });
      }
      return { ok: true, state: 'sent' };
    } catch (error) { return errorReply(reply, error); }
  };
  app.post('/api/deepseek/sessions/:id/input', inputHandler);
  app.post('/api/deepseek/sessions/:id/startup-input', inputHandler);
  app.post('/api/deepseek/sessions/:id/keys', inputHandler);

  app.post('/api/deepseek/sessions/:id/interaction', async (req, reply) => {
    try {
      const session = requireSession(req.params.id);
      const interaction = text(req.body?.interactionId)
        ? session.interactions.find((item) => item.interactionId === text(req.body.interactionId))
        : openInteraction(session);
      if (!interaction) {
        const error = new Error('No open DeepSeek interaction');
        error.statusCode = 409;
        error.code = 'interaction_not_open';
        throw error;
      }
      await service.answerInteraction(session.id, {
        interactionId: interaction.interactionId,
        optionId: text(req.body?.optionId) || undefined,
        text: text(req.body?.text) || undefined,
        authority: await interactionAuthority(req, session, interaction),
        expected: req.body || {},
      });
      return { ok: true, state: 'sent' };
    } catch (error) { return errorReply(reply, error); }
  });

  app.post('/api/deepseek/sessions/:id/enter', async (req, reply) => {
    try { requireSession(req.params.id); return { ok: true }; } catch (error) { return errorReply(reply, error); }
  });
  app.post('/api/deepseek/sessions/:id/escape', async (req, reply) => {
    try { return { ok: true, ...(await service.cancel(req.params.id)) }; } catch (error) { return errorReply(reply, error); }
  });
  app.get('/api/deepseek/sessions/:id/transcript', async (req, reply) => {
    try {
      const session = requireSession(req.params.id);
      return { text: contentFromTranscript(session), entries: session.transcript, source: 'acp_committed_text', transcriptGrade: 'committed_text' };
    } catch (error) { return errorReply(reply, error); }
  });
  app.get('/api/deepseek/sessions/:id/events', async (req, reply) => {
    try { requireSession(req.params.id); return await service.cursor(req.params.id, { after: req.query?.after, limit: req.query?.limit }); } catch (error) { return errorReply(reply, error); }
  });
  app.delete('/api/deepseek/sessions/:id', async (req, reply) => {
    try {
      const existing = service.get(req.params.id);
      if (!existing) {
        await notifyAgentSessionDeleted({ kind: 'deepseek', sessionId: req.params.id });
        return { ok: true, status: 'already_gone', residual: [] };
      }
      const generation = existing.attempts.at(-1)?.generation || 1;
      const verdict = await service.delete(req.params.id, { reason: 'Deleted' });
      if (verdict.ok) await notifyAgentSessionDeleted({ kind: 'deepseek', sessionId: req.params.id });
      await cleanupAttempt(req.params.id, generation, 'session_terminated');
      return verdict.ok ? verdict : reply.code(500).send(verdict);
    } catch (error) { return errorReply(reply, error); }
  });

  wsManager?.onChannel('deepseek', async (socket, channel, data) => {
    const match = channel.match(/^deepseek:session:([^:]+)$/);
    if (data?.action !== 'subscribe' || !match) return;
    const session = service.get(match[1]);
    if (!session) return;
    const snapshot = projectDeepSeekSession(session);
    const page = await service.cursor(session.id, { after: data.after ?? data.cursor ?? 0, limit: data.limit ?? 1000 });
    wsManager.send(socket, channel, 'events', page);
    wsManager.send(socket, channel, 'content', {
      content: snapshot.content, revision: snapshot.state.revision, cursor: page.cursor,
      appended: '', state: snapshot.state, canonicalState: snapshot.canonicalState,
      pendingResponse: snapshot.pendingResponse,
    });
  });

  app.addHook('onClose', async () => {
    if (listBroadcastTimer) clearTimeout(listBroadcastTimer);
    unsubscribe();
    unregister();
    await service.close({ interrupt: true });
    await Promise.all(service.list().map((session) => cleanupAttempt(
      session.id,
      session.attempts.at(-1)?.generation || 1,
      'fleet_shutdown',
    )));
    await processSupervisor.close();
  });
}
