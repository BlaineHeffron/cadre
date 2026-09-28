import { randomBytes } from 'node:crypto';
import { prepareHeadroomLaunch } from '../agent/headroom.mjs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AttachmentStore } from '../agent/attachment-store.mjs';
import { ClaudeStreamJsonTransport } from '../agent/claude-stream-json-transport.mjs';
import { CodexAppServerTransport } from '../agent/codex-app-server-transport.mjs';
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
import { assertValidCodexModel } from './codex-models.mjs';
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

// Shared by structured Claude (stream-json) and Codex (app-server) interactive sessions.
export function projectClaudeStreamJsonSession(session, kind = 'claude') {
  const state = projectCompatibility(session.canonicalState);
  const canResume = session.lifecycle === 'interrupted' && session.negotiated?.sessionOps?.resume === 'supported'
    && session.attempts.some((attempt) => attempt.protocolSessionId);
  return {
    id: session.id, name: `${kind}-${session.id}`, sessionName: `${kind}-${session.id}`,
    displayName: session.displayName, provider: kind, runtime: kind,
    ...(kind === 'claude'
      ? { source: 'stream_json_committed_text', transport: 'stream-json' }
      : { source: 'app_server_committed_text', transport: 'app-server' }),
    transcriptGrade: 'committed_text',
    workDir: session.workDir, created: session.createdAt, content: content(session),
    diagnostics: session.diagnostics.map((entry) => entry.message || '').join('\n'),
    state, canonicalState: session.canonicalState,
    pendingResponse: state.execution === 'working' ? { sentAt: session.updatedAt } : null,
    canResume, nonResumable: !canResume && (session.nonResumable || session.lifecycle === 'interrupted'),
    endedWithHistory: session.endedWithHistory || session.lifecycle === 'interrupted', attachCommand: '',
    attempts: session.attempts, turns: session.turns, negotiated: session.negotiated,
    mcpCapabilities: session.mcpCapabilities,
  };
}

function errorReply(reply, error) {
  return reply.code(error?.statusCode || 500).send({ error: error?.message || 'Structured session request failed', code: error?.code || null });
}

export async function claudeStreamJsonSessionsPlugin(app, {
  provider: kind = 'claude',
  wsManager, transportFactory = null, supervisor = null, journal = null,
  binary = kind, credentialStore, sourceConfig = config,
  mcpDiscovery = discoverDeepSeekDuenoTools,
  mcpCatalog = null,
  versionReader = readClaudeStreamJsonVersion, e2eEvidence = null,
  sessionRoot = runtimeStatePath(kind === 'claude' ? 'claude_stream_json_sessions' : `${kind}_app_server_interactive_sessions`),
  sessionDeliveryAuditStore = null, attachmentStore = null,
} = {}) {
  const claude = kind === 'claude';
  const label = claude ? 'Claude' : 'Codex';
  const project = (session) => projectClaudeStreamJsonSession(session, kind);
  await mkdir(sessionRoot, { recursive: true });
  const processSupervisor = supervisor || new ProcessSupervisor({ ledgerPath: resolve(sessionRoot, 'ledger.json') });
  await processSupervisor.init();
  const service = new SessionService({
    provider: kind, journal: journal || createJournalStore({ rootDir: resolve(sessionRoot, 'journal') }),
    attachmentStore: attachmentStore || new AttachmentStore({ rootDir: resolve(sessionRoot, 'attachments') }),
    deliveryAuditStore: sessionDeliveryAuditStore, logger: app.log,
    transportFactory: (spec) => transportFactory?.(spec) || (claude ? new ClaudeStreamJsonTransport({
      binary, env: spec.env, supervisor: processSupervisor, capabilityEvidence: spec.capabilityEvidence,
    }) : new CodexAppServerTransport({ binary, env: spec.env, supervisor: processSupervisor })),
  });
  await service.init();
  // Interactive Codex stays off the task registry; task launches keep their own bounded provider.
  const unregister = claude ? registerProtocolSessionProvider('claude', { service, project }) : () => {};

  async function cleanupAttempt(sessionId, generation = 1, reason = 'attempt_ended', serverIds = null) {
    const selected = serverIds || service.get(sessionId)?.mcpCapabilities?.serverIds || [];
    await cleanupMcpCapabilityLaunch({
      backendType: kind, sessionId, sourceConfig, reason,
      ...(claude ? { claudeConfigPath: claudeStreamJsonMcpConfigPath(sessionRoot, sessionId, generation) } : {}),
      serverIds: selected,
      ...(credentialStore ? { credentialStore } : {}),
    });
  }

  async function cleanupSessionLaunch(sessionId, generation = 1, reason = 'attempt_ended', serverIds = null) {
    await Promise.all([
      cleanupAttempt(sessionId, generation, reason, serverIds),
      cleanupPromptProfileLaunch({ backendType: kind, sessionId }),
      claude && cleanupClaudeHookSettings({ sessionId }),
    ]);
  }

  // Scoped credential, MCP config, and launch args for one attempt. A resumed attempt reuses the
  // persisted MCP selection; the provider replays the system prompt it recorded at first launch.
  async function prepareAttempt({ id, workDir, body = {}, generation = 1, resolvedMcp }) {
    const mcpPreparation = await prepareMcpCapabilityLaunch({
      resolved: resolvedMcp, backendType: kind, sessionId: id, workDir,
      sourceConfig, attemptGeneration: generation, rotation: generation > 1,
      serverAllowlist: resolvedMcp.serverIds,
      ...(claude ? { claudeConfigPath: claudeStreamJsonMcpConfigPath(sessionRoot, id, generation) } : {}),
      duenoCredentialEnvVar: CLAUDE_STREAM_JSON_MCP_TOKEN_ENV_VAR,
      ...(credentialStore ? { credentialStore } : {}),
    });
    if (!mcpPreparation.credentialToken) {
      const error = new Error(`${label} ${claude ? 'stream-json' : 'app-server'} requires an authenticated Cadre MCP credential`);
      error.statusCode = 503; error.code = `${kind}_mcp_credential_required`; throw error;
    }
    const promptLaunch = generation > 1 ? null : (await preparePromptProfileLaunch({
      promptProfile: body.promptProfile, backendType: kind, sessionId: id,
    })).prepared;
    const promptArgs = buildPromptLaunchArgs({ runtime: kind, promptLaunch });
    const headroom = await prepareHeadroomLaunch(kind);
    const env = {
      ...process.env,
      ...headroom.env,
      ...withCadreEnv({
        [CLAUDE_STREAM_JSON_MCP_TOKEN_ENV_VAR]: mcpPreparation.credentialToken,
        DUENO_SESSION_ID: id,
        DUENO_PROVIDER: kind,
      }),
    };
    if (!claude) {
      return { env, preflight: mcpPreparation.preflight, args: [...headroom.args, ...mcpPreparation.prepared.codexArgs, ...promptArgs,
        ...(headroom.modelProvider ? ['-c', `model_provider=${JSON.stringify(headroom.modelProvider)}`] : [])] };
    }
    const discovery = await mcpDiscovery({ url: buildAgentBusMcpUrl(sourceConfig), token: mcpPreparation.credentialToken });
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
    const hookSettings = await prepareClaudeHookSettings({ sessionId: id });
    await seedClaudeWorkspaceTrust(workDir, { logger: app.log });
    return {
      env, preflight: mcpPreparation.preflight, promptArgs, capabilityEvidence,
      mcpConfigPath: mcpPreparation.prepared.claudeConfigPath, settingsPath: hookSettings.settingsPath,
    };
  }

  let listTimer = null;
  function broadcastList() {
    if (!wsManager || listTimer) return;
    listTimer = setTimeout(() => {
      listTimer = null;
      wsManager.broadcast(`${kind}:sessions`, 'sessions', { sessions: service.list().map(project) });
    }, 250);
    listTimer.unref?.();
  }
  const unsubscribe = service.subscribe((session, event) => {
    const projected = project(session);
    const appended = event.type === 'transport.event' && event.data?.event?.type === 'message.delta'
      ? String(event.data.event.delta?.text || '') : '';
    wsManager?.broadcast(`${kind}:session:${session.id}`, 'content', {
      revision: projected.state.revision, cursor: event.seq, appended,
      content: appended ? undefined : projected.content, state: projected.state,
      canonicalState: projected.canonicalState, pendingResponse: projected.pendingResponse,
    });
    broadcastList();
    // While (re)starting, the launching route owns credential cleanup; a stale exit must not revoke the new attempt.
    if (event.type === 'transport.event' && event.data?.event?.type === 'attempt.exited' && session.lifecycle !== 'starting') {
      const generation = session.attempts.find((attempt) => attempt.attemptId === event.data.event.provenance?.attemptId)?.generation || 1;
      void cleanupAttempt(session.id, generation, 'attempt_process_ended', session.mcpCapabilities?.serverIds);
    }
  });

  function requireSession(id) {
    const session = service.get(String(id || ''));
    if (session) return session;
    const error = new Error(`${label} session not found: ${id}`);
    error.statusCode = 404; error.code = 'session_not_found'; throw error;
  }

  async function interactionAuthority(req, session, interaction) {
    try {
      return permissionAuthorityForRequest(req, {
        tool: interaction?.toolCall?.name || `${kind}.permission`,
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

  app.get(`/api/${kind}/sessions`, async () => ({ sessions: service.list().map(project) }));
  app.post(`/api/${kind}/sessions`, async (req, reply) => {
    let id = '';
    let selectedMcpServerIds = [];
    try {
      const workDir = await normalizeSessionWorkDir(req.body?.workDir);
      if (!workDir) return reply.code(400).send({ error: `workDir is required for ${label} sessions` });
      id = randomBytes(8).toString('hex');
      const model = await (claude ? assertValidClaudeModel : assertValidCodexModel)(text(req.body?.model));
      const resolvedMcp = resolveMcpCapabilities({
        request: {
          ...(req.body?.mcpProfile !== undefined ? { mcpProfile: req.body.mcpProfile } : {}),
          ...(req.body?.mcpServers !== undefined ? { mcpServers: req.body.mcpServers } : {}),
        },
        provider: kind, runtime: kind, require: ['dueno'],
        catalog: mcpCatalog || buildMcpCapabilityCatalog({ sourceConfig }),
      });
      selectedMcpServerIds = resolvedMcp.serverIds;
      const { preflight, ...launch } = await prepareAttempt({ id, workDir, body: req.body || {}, resolvedMcp });
      let session = await service.start({
        ...launch, sessionId: id, displayName: text(req.body?.displayName), workDir,
        model, permissionMode: text(req.body?.permissionMode) || 'workspace-write',
        mcpCapabilities: sanitizedMcpSnapshot(resolvedMcp, preflight),
      });
      const initialPrompt = text(req.body?.initialPrompt);
      if (initialPrompt) {
        await service.prompt(id, { blocks: [{ type: 'text', text: initialPrompt }], idempotencyKey: `initial:${id}`, source: 'session_create' });
        session = service.get(id);
      }
      return {
        ...project(session),
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
  app.get(`/api/${kind}/sessions/:id`, async (req, reply) => {
    try { return project(requireSession(req.params.id)); } catch (error) { return errorReply(reply, error); }
  });
  // Reattach an interrupted session (e.g. after a Fleet restart) to its provider conversation.
  app.post(`/api/${kind}/sessions/:id/resume`, async (req, reply) => {
    let attempt = null;
    try {
      const session = requireSession(req.params.id);
      if (!project(session).canResume) {
        const error = new Error(`${label} session is ${session.lifecycle} and cannot be resumed`);
        error.statusCode = 409; error.code = 'session_not_resumable'; throw error;
      }
      attempt = { generation: session.generation + 1, serverIds: session.mcpCapabilities?.serverIds || [] };
      const { preflight: _preflight, ...launch } = await prepareAttempt({
        id: session.id, workDir: session.workDir, generation: attempt.generation, resolvedMcp: { serverIds: attempt.serverIds },
      });
      return project(await service.resume(session.id, launch));
    } catch (error) {
      if (attempt) await cleanupSessionLaunch(req.params.id, attempt.generation, 'resume_failed', attempt.serverIds);
      return errorReply(reply, error);
    }
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
  app.post(`/api/${kind}/sessions/:id/input`, input);
  app.post(`/api/${kind}/sessions/:id/startup-input`, input);
  app.post(`/api/${kind}/sessions/:id/interaction`, async (req, reply) => {
    try {
      const session = requireSession(req.params.id);
      const interaction = text(req.body?.interactionId)
        ? session.interactions.find((item) => item.interactionId === text(req.body.interactionId))
        : openInteraction(session);
      if (!interaction) {
        const error = new Error(`No open ${label} interaction`);
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
  app.post(`/api/${kind}/sessions/:id/keys`, async (req, reply) => {
    try {
      requireSession(req.params.id);
      const keys = text(req.body?.keys);
      if (keys === 'Escape' || keys === 'C-c') return { ok: true, ...(await service.cancel(req.params.id)) };
      const error = new Error(`${label} ${claude ? 'stream-json' : 'app-server'} does not support terminal keys: ${keys || '(empty)'}`);
      error.statusCode = 400; error.code = 'unsupported_capability'; throw error;
    } catch (error) { return errorReply(reply, error); }
  });
  app.post(`/api/${kind}/sessions/:id/enter`, async (req, reply) => {
    try { requireSession(req.params.id); return { ok: true, noop: true }; } catch (error) { return errorReply(reply, error); }
  });
  app.post(`/api/${kind}/sessions/:id/escape`, async (req, reply) => {
    try { return { ok: true, ...(await service.cancel(req.params.id)) }; } catch (error) { return errorReply(reply, error); }
  });
  app.get(`/api/${kind}/sessions/:id/transcript`, async (req, reply) => {
    try {
      const session = requireSession(req.params.id);
      const { source, transcriptGrade } = project(session);
      return { text: content(session), entries: session.transcript, source, transcriptGrade };
    } catch (error) { return errorReply(reply, error); }
  });
  app.get(`/api/${kind}/sessions/:id/events`, async (req, reply) => {
    try { requireSession(req.params.id); return await service.cursor(req.params.id, req.query); } catch (error) { return errorReply(reply, error); }
  });
  app.delete(`/api/${kind}/sessions/:id`, async (req, reply) => {
    try {
      const existing = service.get(req.params.id);
      if (!existing) {
        await notifyAgentSessionDeleted({ kind, sessionId: req.params.id });
        return { ok: true, status: 'already_gone', residual: [] };
      }
      const generation = existing.attempts.at(-1)?.generation || 1;
      const serverIds = existing.mcpCapabilities?.serverIds || [];
      const verdict = await service.delete(req.params.id, { reason: 'Deleted' });
      if (verdict.ok) await notifyAgentSessionDeleted({ kind, sessionId: req.params.id });
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
