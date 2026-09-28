import { randomBytes } from 'node:crypto';
import { prepareHeadroomLaunch } from '../agent/headroom.mjs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AttachmentStore } from '../agent/attachment-store.mjs';
import { ClaudeStreamJsonTransport } from '../agent/claude-stream-json-transport.mjs';
import { cleanupClaudeHookSettings, prepareClaudeHookSettings } from '../agent/claude-hook-settings.mjs';
import { ProcessSupervisor } from '../agent/process-supervisor.mjs';
import { resolveMcpCapabilities } from '../integrations/mcp-capability-resolver.mjs';
import {
  cleanupMcpCapabilityLaunch,
  prepareMcpCapabilityLaunch,
  sanitizedMcpSnapshot,
} from '../integrations/mcp-launch-preflight.mjs';
import { buildMcpCapabilityCatalog } from '../integrations/mcp-server-catalog.mjs';
import { buildPromptLaunchArgs, cleanupPromptProfileLaunch, preparePromptProfileLaunch } from '../integrations/prompt-profile-launch.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import { permissionAuthorityForRequest } from '../platform/auth.mjs';
import { buildAgentBusMcpUrl, seedClaudeWorkspaceTrust } from '../platform/mcp-seed.mjs';
import { projectCompatibility } from '../session-state/contract.mjs';
import { createJournalStore } from './journal-store.mjs';
import { assertValidClaudeModel } from './claude-models.mjs';
import { registerProtocolSessionProvider } from './protocol-session-registry.mjs';
import { notifyAgentSessionDeleted } from '../agent/session-delete-events.mjs';
import { SessionService } from './session-service.mjs';
import { normalizeSessionWorkDir } from './workdir.mjs';
import { discoverDeepSeekDuenoTools } from './deepseek-mcp.mjs';
import {
  claudeStreamJsonBusE2eEvidence,
  CLAUDE_STREAM_JSON_MCP_TOKEN_ENV_VAR,
  claudeStreamJsonMcpCapabilities,
  readClaudeStreamJsonVersion,
  claudeStreamJsonMcpConfigPath,
} from './claude-stream-json-mcp.mjs';
import { config } from '../../config.mjs';
import { withCadreEnv } from '../platform/cadre-env.mjs';

const text = (value) => String(value || '').trim();

function openInteraction(session) {
  return session.interactions.find((interaction) => interaction.status === 'open') || null;
}

function content(session) {
  let value = '';
  const deltaTurns = new Set(session.transcript.filter((entry) => entry.type === 'message.delta').map((entry) => entry.turnId));
  for (const entry of session.transcript) {
    if (entry.type === 'user.message') {
      const prompt = (entry.blocks || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
      if (prompt) value += `${value ? '\n\n' : ''}> ${prompt}`;
    } else if (entry.type === 'message.delta' && entry.delta?.type === 'text') value += String(entry.delta.text || '');
    else if (entry.type === 'message.committed' && !deltaTurns.has(entry.turnId)) {
      value += (entry.blocks || []).filter((block) => block.type === 'text').map((block) => block.text).join('');
    }
  }
  return value;
}

export function projectClaudeStreamJsonSession(session) {
  const state = projectCompatibility(session.canonicalState);
  return {
    id: session.id, name: `claude-${session.id}`, sessionName: `claude-${session.id}`,
    displayName: session.displayName, provider: 'claude', runtime: 'claude',
    source: 'stream_json_committed_text', transport: 'stream-json', transcriptGrade: 'committed_text',
    workDir: session.workDir, created: session.createdAt, content: content(session),
    diagnostics: session.diagnostics.map((entry) => entry.message || '').join('\n'),
    state, canonicalState: session.canonicalState,
    pendingResponse: state.execution === 'working' ? { sentAt: session.updatedAt } : null,
    canResume: false, nonResumable: session.nonResumable || session.lifecycle === 'interrupted',
    endedWithHistory: session.endedWithHistory || session.lifecycle === 'interrupted', attachCommand: '',
    attempts: session.attempts, turns: session.turns, negotiated: session.negotiated,
    mcpCapabilities: session.mcpCapabilities,
  };
}

function errorReply(reply, error) {
  return reply.code(error?.statusCode || 500).send({ error: error?.message || 'Claude stream-json request failed', code: error?.code || null });
}

export async function claudeStreamJsonSessionsPlugin(app, {
  wsManager, transportFactory = null, supervisor = null, journal = null,
  binary = 'claude', credentialStore, sourceConfig = config,
  mcpDiscovery = discoverDeepSeekDuenoTools,
  mcpCatalog = null,
  versionReader = readClaudeStreamJsonVersion, e2eEvidence = null,
  sessionRoot = runtimeStatePath('claude_stream_json_sessions'),
  sessionDeliveryAuditStore = null, attachmentStore = null,
} = {}) {
  await mkdir(sessionRoot, { recursive: true });
  const processSupervisor = supervisor || new ProcessSupervisor({ ledgerPath: resolve(sessionRoot, 'ledger.json') });
  await processSupervisor.init();
  const service = new SessionService({
    provider: 'claude', journal: journal || createJournalStore({ rootDir: resolve(sessionRoot, 'journal') }),
    attachmentStore: attachmentStore || new AttachmentStore({ rootDir: resolve(sessionRoot, 'attachments') }),
    deliveryAuditStore: sessionDeliveryAuditStore, logger: app.log,
    transportFactory: (spec) => transportFactory?.(spec) || new ClaudeStreamJsonTransport({
      binary, env: spec.env, supervisor: processSupervisor, capabilityEvidence: spec.capabilityEvidence,
    }),
  });
  await service.init();
  const unregister = registerProtocolSessionProvider('claude', { service, project: projectClaudeStreamJsonSession });

  async function cleanupAttempt(sessionId, generation = 1, reason = 'attempt_ended', serverIds = null) {
    const selected = serverIds || service.get(sessionId)?.mcpCapabilities?.serverIds || [];
    await cleanupMcpCapabilityLaunch({
      backendType: 'claude', sessionId, sourceConfig, reason,
      claudeConfigPath: claudeStreamJsonMcpConfigPath(sessionRoot, sessionId, generation),
      serverIds: selected,
      ...(credentialStore ? { credentialStore } : {}),
    });
  }

  async function cleanupSessionLaunch(sessionId, generation = 1, reason = 'attempt_ended', serverIds = null) {
    await Promise.all([
      cleanupAttempt(sessionId, generation, reason, serverIds),
      cleanupPromptProfileLaunch({ backendType: 'claude', sessionId }),
      cleanupClaudeHookSettings({ sessionId }),
    ]);
  }
  let listTimer = null;
  function broadcastList() {
    if (!wsManager || listTimer) return;
    listTimer = setTimeout(() => {
      listTimer = null;
      wsManager.broadcast('claude:sessions', 'sessions', { sessions: service.list().map(projectClaudeStreamJsonSession) });
    }, 250);
    listTimer.unref?.();
  }
  const unsubscribe = service.subscribe((session, event) => {
    const projected = projectClaudeStreamJsonSession(session);
    const appended = event.type === 'transport.event' && event.data?.event?.type === 'message.delta'
      ? String(event.data.event.delta?.text || '') : '';
    wsManager?.broadcast(`claude:session:${session.id}`, 'content', {
      revision: projected.state.revision, cursor: event.seq, appended,
      content: appended ? undefined : projected.content, state: projected.state,
      canonicalState: projected.canonicalState, pendingResponse: projected.pendingResponse,
    });
    broadcastList();
    if (event.type === 'transport.event' && event.data?.event?.type === 'attempt.exited') {
      const generation = session.attempts.find((attempt) => attempt.attemptId === event.data.event.provenance?.attemptId)?.generation || 1;
      void cleanupAttempt(session.id, generation, 'attempt_process_ended', session.mcpCapabilities?.serverIds);
    }
  });

  function requireSession(id) {
    const session = service.get(String(id || ''));
    if (session) return session;
    const error = new Error(`Claude session not found: ${id}`);
    error.statusCode = 404; error.code = 'session_not_found'; throw error;
  }

  async function interactionAuthority(req, session, interaction) {
    try {
      return permissionAuthorityForRequest(req, {
        tool: interaction?.toolCall?.name || 'claude.permission',
        scope: 'permission.approve', risk: 'provider_tool_execution',
      });
    } catch (error) {
      if (error.authorityAudit) {
        await service.recordInteractionAuthority(session.id, {
          interactionId: interaction.interactionId, authority: error.authorityAudit,
        }).catch(() => {});
      }
      throw error;
    }
  }

  app.get('/api/claude/sessions', async () => ({ sessions: service.list().map(projectClaudeStreamJsonSession) }));
  app.post('/api/claude/sessions', async (req, reply) => {
    let id = '';
    let selectedMcpServerIds = [];
    try {
      const workDir = await normalizeSessionWorkDir(req.body?.workDir);
      if (!workDir) return reply.code(400).send({ error: 'workDir is required for Claude sessions' });
      id = randomBytes(8).toString('hex');
      const model = await assertValidClaudeModel(text(req.body?.model));
      const resolvedMcp = resolveMcpCapabilities({
        request: {
          ...(req.body?.mcpProfile !== undefined ? { mcpProfile: req.body.mcpProfile } : {}),
          ...(req.body?.mcpServers !== undefined ? { mcpServers: req.body.mcpServers } : {}),
        },
        provider: 'claude', runtime: 'claude', require: ['dueno'],
        catalog: mcpCatalog || buildMcpCapabilityCatalog({ sourceConfig }),
      });
      const mcpPreparation = await prepareMcpCapabilityLaunch({
        resolved: resolvedMcp, backendType: 'claude', sessionId: id, workDir,
        sourceConfig, attemptGeneration: 1,
        serverAllowlist: resolvedMcp.serverIds,
        claudeConfigPath: claudeStreamJsonMcpConfigPath(sessionRoot, id, 1),
        duenoCredentialEnvVar: CLAUDE_STREAM_JSON_MCP_TOKEN_ENV_VAR,
        ...(credentialStore ? { credentialStore } : {}),
      });
      selectedMcpServerIds = resolvedMcp.serverIds;
      if (!mcpPreparation.credentialToken) {
        const error = new Error('Claude stream-json requires an authenticated Cadre MCP credential');
        error.statusCode = 503; error.code = 'claude_mcp_credential_required'; throw error;
      }
      const mcpConfigPath = mcpPreparation.prepared.claudeConfigPath;
      const mcpUrl = buildAgentBusMcpUrl(sourceConfig);
      const discovery = await mcpDiscovery({ url: mcpUrl, token: mcpPreparation.credentialToken });
      const evidence = e2eEvidence || claudeStreamJsonBusE2eEvidence({
        cliVersion: await versionReader(binary),
      });
      const capabilityEvidence = claudeStreamJsonMcpCapabilities({
        discoveryProven: discovery?.authenticated === true, e2eEvidence: evidence,
      });
      if (capabilityEvidence.busParticipation !== 'authenticated_scoped') {
        const error = new Error(`Claude stream-json Agent Bus E2E proof requires Claude Code ${evidence.expectedVersion}`);
        error.statusCode = 503; error.code = 'claude_mcp_capability_unproven'; throw error;
      }
      const promptPreparation = await preparePromptProfileLaunch({
        promptProfile: req.body?.promptProfile, backendType: 'claude', sessionId: id,
      });
      const hookSettings = await prepareClaudeHookSettings({ sessionId: id });
      await seedClaudeWorkspaceTrust(workDir, { logger: app.log });
      let session = await service.start({
        sessionId: id, displayName: text(req.body?.displayName), workDir,
        model, permissionMode: text(req.body?.permissionMode) || 'workspace-write',
        mcpConfigPath, settingsPath: hookSettings.settingsPath,
        promptArgs: buildPromptLaunchArgs({ runtime: 'claude', promptLaunch: promptPreparation.prepared }),
        capabilityEvidence,
        mcpCapabilities: sanitizedMcpSnapshot(resolvedMcp, mcpPreparation.preflight),
        env: {
          ...process.env,
          ...(await prepareHeadroomLaunch('claude')).env,
          ...withCadreEnv({
            [CLAUDE_STREAM_JSON_MCP_TOKEN_ENV_VAR]: mcpPreparation.credentialToken,
            DUENO_SESSION_ID: id,
            DUENO_PROVIDER: 'claude',
          }),
        },
      });
      const initialPrompt = text(req.body?.initialPrompt);
      if (initialPrompt) {
        await service.prompt(id, { blocks: [{ type: 'text', text: initialPrompt }], idempotencyKey: `initial:${id}`, source: 'session_create' });
        session = service.get(id);
      }
      return {
        ...projectClaudeStreamJsonSession(session),
        mcpWarnings: resolvedMcp.warnings.map((warning) => ({ ...warning })),
        initialPromptInjected: Boolean(initialPrompt),
      };
    } catch (error) {
      if (id && service.get(id) && !['ended', 'interrupted'].includes(service.get(id).lifecycle)) {
        await service.terminate(id, { reason: 'start_failed' }).catch(() => {});
      }
      if (id) await cleanupSessionLaunch(id, 1, 'start_failed', selectedMcpServerIds);
      return errorReply(reply, error);
    }
  });
  app.get('/api/claude/sessions/:id', async (req, reply) => {
    try { return projectClaudeStreamJsonSession(requireSession(req.params.id)); } catch (error) { return errorReply(reply, error); }
  });
  const input = async (req, reply) => {
    try {
      const session = requireSession(req.params.id);
      if (req.body?.blocks != null && !Array.isArray(req.body.blocks)) {
        const error = new TypeError('blocks must be an array when provided');
        error.statusCode = 400; error.code = 'invalid_prompt_blocks'; throw error;
      }
      const blocks = Array.isArray(req.body?.blocks) && req.body.blocks.length
        ? structuredClone(req.body.blocks) : [{ type: 'text', text: text(req.body?.text || req.body?.keys) }];
      const interaction = openInteraction(session);
      if (interaction) {
        await service.answerInteraction(session.id, {
          interactionId: interaction.interactionId,
          optionId: text(req.body?.optionId || req.body?.text || req.body?.keys),
          authority: await interactionAuthority(req, session, interaction),
        expected: req.body || {},
        });
      } else {
        service.assertExpectedState(session.id, req.body || {});
        await service.prompt(req.params.id, {
          blocks, idempotencyKey: text(req.body?.idempotencyKey) || randomBytes(16).toString('hex'),
          source: text(req.body?.source) || 'api',
        });
      }
      return { ok: true, state: 'sent' };
    } catch (error) { return errorReply(reply, error); }
  };
  app.post('/api/claude/sessions/:id/input', input);
  app.post('/api/claude/sessions/:id/startup-input', input);
  app.post('/api/claude/sessions/:id/interaction', async (req, reply) => {
    try {
      const session = requireSession(req.params.id);
      const interaction = text(req.body?.interactionId)
        ? session.interactions.find((item) => item.interactionId === text(req.body.interactionId))
        : openInteraction(session);
      if (!interaction) {
        const error = new Error('No open Claude interaction');
        error.statusCode = 409; error.code = 'interaction_not_open'; throw error;
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
  app.post('/api/claude/sessions/:id/keys', async (req, reply) => {
    try {
      requireSession(req.params.id);
      const keys = text(req.body?.keys);
      if (keys === 'Escape' || keys === 'C-c') return { ok: true, ...(await service.cancel(req.params.id)) };
      const error = new Error(`Claude stream-json does not support terminal keys: ${keys || '(empty)'}`);
      error.statusCode = 400; error.code = 'unsupported_capability'; throw error;
    } catch (error) { return errorReply(reply, error); }
  });
  app.post('/api/claude/sessions/:id/enter', async (req, reply) => {
    try { requireSession(req.params.id); return { ok: true, noop: true }; } catch (error) { return errorReply(reply, error); }
  });
  app.post('/api/claude/sessions/:id/escape', async (req, reply) => {
    try { return { ok: true, ...(await service.cancel(req.params.id)) }; } catch (error) { return errorReply(reply, error); }
  });
  app.get('/api/claude/sessions/:id/transcript', async (req, reply) => {
    try {
      const session = requireSession(req.params.id);
      return { text: content(session), entries: session.transcript, source: 'stream_json_committed_text', transcriptGrade: 'committed_text' };
    } catch (error) { return errorReply(reply, error); }
  });
  app.get('/api/claude/sessions/:id/events', async (req, reply) => {
    try { requireSession(req.params.id); return await service.cursor(req.params.id, req.query); } catch (error) { return errorReply(reply, error); }
  });
  app.delete('/api/claude/sessions/:id', async (req, reply) => {
    try {
      const existing = service.get(req.params.id);
      if (!existing) {
        await notifyAgentSessionDeleted({ kind: 'claude', sessionId: req.params.id });
        return { ok: true, status: 'already_gone', residual: [] };
      }
      const generation = existing.attempts.at(-1)?.generation || 1;
      const serverIds = existing.mcpCapabilities?.serverIds || [];
      const verdict = await service.delete(req.params.id, { reason: 'Deleted' });
      if (verdict.ok) await notifyAgentSessionDeleted({ kind: 'claude', sessionId: req.params.id });
      await cleanupSessionLaunch(req.params.id, generation, 'session_terminated', serverIds);
      return verdict.ok ? verdict : reply.code(500).send(verdict);
    } catch (error) { return errorReply(reply, error); }
  });
  app.addHook('onClose', async () => {
    if (listTimer) clearTimeout(listTimer);
    unsubscribe(); unregister();
    await service.close({ interrupt: true });
    await Promise.all(service.list().map((session) => cleanupSessionLaunch(
      session.id, session.attempts.at(-1)?.generation || 1, 'fleet_shutdown', session.mcpCapabilities?.serverIds,
    )));
    await processSupervisor.close();
  });
}
