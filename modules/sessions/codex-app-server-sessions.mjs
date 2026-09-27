import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CodexAppServerTransport } from '../agent/codex-app-server-transport.mjs';
import { prepareHeadroomLaunch } from '../agent/headroom.mjs';
import { ProcessSupervisor } from '../agent/process-supervisor.mjs';
import { prepareAgentBusCredentialLaunch, cleanupAgentBusCredentialLaunch } from '../integrations/mcp-launch-preflight.mjs';
import { buildAgentBusMcpUrl } from '../platform/mcp-seed.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import { SessionService } from './session-service.mjs';
import { createJournalStore } from './journal-store.mjs';
import { registerProtocolSessionProvider } from './protocol-session-registry.mjs';
import { normalizeSessionWorkDir } from './workdir.mjs';
import { assertValidCodexModel } from './codex-models.mjs';
import { config } from '../../config.mjs';
import { withCadreEnv } from '../platform/cadre-env.mjs';

export function projectCodexAppServerSession(session) {
  const ready = session.lifecycle === 'ready';
  const ended = ['ended', 'interrupted'].includes(session.lifecycle);
  const busy = ['working', 'blocked', 'cancelling'].includes(session.lifecycle);
  const interaction = session.interactions.find((entry) => entry.status === 'open');
  const state = { state: ready ? 'waiting_for_input' : session.lifecycle, status: session.lifecycle,
    lifecycle: ended ? 'ended' : 'running', execution: busy ? 'busy' : 'idle',
    detail: session.detail, revision: session.revision, updatedAt: session.updatedAt,
    runtime: { provider: 'codex-app-server', harness: 'codex', transport: 'app-server' },
    interaction: interaction ? { kind: interaction.kind, fingerprint: interaction.interactionId,
      detail: interaction.toolCall?.title, options: interaction.options } : { kind: ready ? 'free_text' : 'none', options: [] },
    capabilities: { canSendNow: ready, canQueueMessage: ready, canInterrupt: busy, canAnswerInteraction: Boolean(interaction) },
  };
  const deltaTurns = new Set(session.transcript.filter((entry) => entry.type === 'message.delta').map((entry) => entry.turnId));
  const content = session.transcript.map((entry) => entry.type === 'message.delta' ? entry.delta?.text || ''
    : entry.type === 'message.committed' && !deltaTurns.has(entry.turnId) ? entry.blocks?.map((block) => block.text || '').join('') || ''
      : entry.type === 'user.message' ? `\n> ${(entry.blocks || []).map((block) => block.text || '').join('\n')}\n` : '').join('');
  return { ...session, name: `codex-${session.id}`, sessionName: `codex-${session.id}`, provider: 'codex-app-server', runtime: 'codex',
    transport: 'app-server', source: 'app_server_committed_text', transcriptGrade: 'committed_text', content,
    state, canonicalState: state, created: session.createdAt,
    pendingResponse: busy ? { sentAt: session.updatedAt } : null,
    canResume: session.negotiated?.sessionOps?.resume === 'supported', attachCommand: '' };
}

// Coordinator owns route/MCP wiring. The binding's start boundary prepares scoped
// credentials through the existing launch path before SessionService may launch.
export async function createCodexAppServerSessionProvider({
  sessionRoot = runtimeStatePath('codex_app_server_sessions'), binary = 'codex',
  supervisor = null, journal = null, transportFactory = null, sourceConfig = config,
  credentialStore, prepareLaunch = prepareAgentBusCredentialLaunch,
  cleanupLaunch = cleanupAgentBusCredentialLaunch, modelValidator = assertValidCodexModel,
  prepareHeadroom = prepareHeadroomLaunch,
  observationSink, deliveryAuditStore, logger,
} = {}) {
  await mkdir(sessionRoot, { recursive: true });
  const processSupervisor = supervisor || new ProcessSupervisor({ ledgerPath: resolve(sessionRoot, 'ledger.json') });
  await processSupervisor.init();
  const service = new SessionService({ provider: 'codex-app-server', journal: journal || createJournalStore({ rootDir: resolve(sessionRoot, 'journal') }),
    observationSink, deliveryAuditStore, logger,
    transportFactory: (spec) => transportFactory?.(spec) || new CodexAppServerTransport({ binary, supervisor: processSupervisor, env: spec.env }),
  });
  await service.init();
  const cleanup = (sessionId, reason) => cleanupLaunch({ backendType: 'codex-app-server', sessionId, sourceConfig, reason,
    ...(credentialStore ? { credentialStore } : {}) });
  const binding = { service, project: projectCodexAppServerSession, async start(spec = {}) {
    const sessionId = spec.sessionId || randomBytes(8).toString('hex');
    const workDir = await normalizeSessionWorkDir(spec.workDir);
    if (!workDir) throw new TypeError('App Server workDir is required');
    const model = await modelValidator(spec.model || '');
    // A task caller supplies server-resolved scopes. No wildcard or implicit spawn grant.
    const toolScopes = spec.toolScopes || spec.scope?.toolScopes || ['mcp:discover', 'room_context', 'room_send'];
    const threadAllowlist = spec.threadAllowlist || spec.scope?.threadAllowlist || (spec.threadId ? [spec.threadId] : []);
    if (!threadAllowlist.length || threadAllowlist.includes('*') || toolScopes.includes('*')) {
      throw Object.assign(new Error('App Server launch requires bounded tool scopes and thread allowlist'), { code: 'task_scope_required', statusCode: 403 });
    }
    const url = new URL(buildAgentBusMcpUrl(sourceConfig));
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new TypeError('Cadre MCP URL must use loopback HTTP(S)');
    const args = ['-c', 'features.apps=false', '-c', `mcp_servers.dueno.url=${JSON.stringify(url.href)}`, '-c', 'mcp_servers.dueno.enabled=true',
      '-c', 'mcp_servers.dueno.bearer_token_env_var="DUENO_AGENT_BUS_TOKEN"'];
    try {
      const headroom = await prepareHeadroom('codex');
      args.unshift(...headroom.args);
      if (headroom.modelProvider) args.push('-c', `model_provider=${JSON.stringify(headroom.modelProvider)}`);
      const prepared = await prepareLaunch({ backendType: 'codex-app-server', sessionId, workDir, sourceConfig,
        attemptGeneration: spec.generation || 1, toolScopes, threadAllowlist, serverAllowlist: ['dueno'], inheritSpawnScopes: false,
        duenoCredentialEnvVar: 'DUENO_AGENT_BUS_TOKEN', ...(credentialStore ? { credentialStore } : {}) });
      const granted = prepared?.credential?.toolScopes;
      if (!Array.isArray(granted) || granted.some((scope) => !toolScopes.includes(scope))) {
        throw Object.assign(new Error('Credential launch expanded requested tool scopes'), { code: 'credential_scope_expanded', statusCode: 403 });
      }
      if (!prepared.token) throw Object.assign(new Error('Authenticated Cadre MCP credential required'), { code: 'codex_mcp_credential_required', statusCode: 503 });
      const result = await service.start({ ...spec, sessionId, workDir, model,
        permissionMode: spec.permissionMode || 'workspace-write', args,
        config: { features: { apps: false }, mcp_servers: { dueno: {
          url: url.href, bearer_token_env_var: 'DUENO_AGENT_BUS_TOKEN', enabled: true,
          tools: Object.fromEntries(['room_context', 'room_send', 'task_spawn', 'task_send', 'task_wait', 'task_status', 'task_cancel', 'task_resume']
            .filter((tool) => toolScopes.includes(tool)).map((tool) => [tool, { approval_mode: 'approve' }])),
        } } },
        requiredTools: ['room_context', 'room_send'], allowedMcpServers: ['dueno'], allowedMcpTools: toolScopes, mcpCapabilities: { serverIds: ['dueno'] },
        env: { ...process.env, ...headroom.env, ...withCadreEnv({ DUENO_SESSION_ID: sessionId, DUENO_PROVIDER: 'codex-app-server', DUENO_AGENT_BUS_TOKEN: prepared.token }) },
      });
      return result;
    } catch (error) { await cleanup(sessionId, 'start_failed'); throw error; }
  }, async close() {
    unregister(); unsubscribe(); await service.close({ interrupt: true });
    await Promise.all(service.list().map((session) => cleanup(session.id, 'fleet_shutdown')));
    await processSupervisor.close();
  } };
  const unregister = registerProtocolSessionProvider('codex-app-server', binding);
  const unsubscribe = service.subscribe((session, event) => {
    if (event.type === 'transport.event' && event.data?.event?.type === 'attempt.exited') void cleanup(session.id, 'attempt_ended').catch(() => {});
  });
  return binding;
}
