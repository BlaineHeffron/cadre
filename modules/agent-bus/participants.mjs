import {
  agentProvidersForBackendType,
  buildAgentProviderCatalog,
  getAgentProviderDefinition,
  inferAgentProviderFromModel,
  resolveAgentBackendType,
  resolveAgentProviderSelection,
} from '../agent/provider-interface.mjs';
import { buildMcpCapabilityCatalog } from '../integrations/mcp-server-catalog.mjs';
import {
  mcpRequestForResolvedSelection,
  resolveMcpCapabilities,
} from '../integrations/mcp-capability-resolver.mjs';
const BOOTSTRAP_STARTUP_INJECTION_ATTEMPTS = 3;
const BOOTSTRAP_STARTUP_RETRY_BASE_MS = 250;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const REQUIRED_COLLAB_MCP_SERVER_ID = 'dueno';

// Capabilities that were never recorded (older sessions, adapters that do not report them)
// are assumed to include the bus so onboarding keeps its instructions, but the assumption is
// reported rather than passing as a verified channel.
export function participantBusStatus(participant = {}) {
  const serverIds = participant?.mcpCapabilities?.serverIds;
  const known = Array.isArray(serverIds);
  return {
    known,
    available: !known || serverIds.includes(REQUIRED_COLLAB_MCP_SERVER_ID),
  };
}

export function participantBusWarnings(participant = {}) {
  const ref = { kind: participant.kind, sessionId: participant.sessionId };
  const warnings = (participant.mcpWarnings || []).map((warning) => ({ ...warning, participant: ref }));
  const { known, available } = participantBusStatus(participant);
  if (!available) {
    warnings.push({
      code: 'participant_bus_unavailable',
      message: `${ref.kind}:${ref.sessionId} has no "${REQUIRED_COLLAB_MCP_SERVER_ID}" MCP server, so it cannot use room tools in this thread.`,
      participant: ref,
    });
  } else if (!known && participant.created !== true) {
    warnings.push({
      code: 'participant_bus_unknown',
      message: `${ref.kind}:${ref.sessionId} reports no MCP capabilities, so its "${REQUIRED_COLLAB_MCP_SERVER_ID}" access could not be verified.`,
      participant: ref,
    });
  }
  return warnings;
}

export function createAgentBusParticipants({
  app,
  store,
  adapters,
  readProviderPreferences,
  isAgentRef,
  participantKey,
  defaultThinkingLevelForKind,
}) {

  async function getParticipantRuntime(participant, cache = new Map()) {
    const key = participantKey(participant);
    if (cache.has(key)) return cache.get(key);

    const promise = (async () => {
      const adapter = adapters[participant.kind];
      if (!adapter) {
        return {
          exists: false,
          live_process_count: 0,
          activity_status: 'done',
          last_active_at: null,
          session_state: null,
          session_detail: null,
          session_name: null,
          display_name: null,
          source: null,
        };
      }

      try {
        const session = await adapter.getSession(app, participant.sessionId);
        const canonicalStatus = session?.state?.status || null;
        const sessionState = session?.state?.state || null;
        const sessionDetail = session?.state?.detail || session?.state?.reason || null;
        const sessionActivity = session?.state?.activity || null;
        const sessionStateSource = session?.state?.state_source
          || (session?.state?.revision == null ? null : 'canonical');
        const lastHookEventAt = session?.state?.last_hook_event_at || null;
        const source = session?.source || null;
        const sessionEnded = session?.sessionEnded === true || canonicalStatus === 'ended';
        const liveProcessCount = session && !sessionEnded ? 1 : 0;
        let activityStatus = 'idle';
        if (sessionEnded) activityStatus = 'done';
        else if (['working', 'thinking', 'awaiting_response'].includes(canonicalStatus)) activityStatus = 'active';

        return {
          exists: !sessionEnded,
          live_process_count: liveProcessCount,
          activity_status: activityStatus,
          last_active_at: null,
          session_state: sessionState,
          canonical_status: canonicalStatus,
          session_detail: sessionDetail,
          session_reason: session?.state?.reason || null,
          state_revision: session?.state?.revision ?? null,
          capabilities: session?.state?.capabilities || null,
          interaction: session?.state?.interaction || null,
          runtime: session?.state?.runtime || null,
          activity: sessionActivity,
          state_source: sessionStateSource,
          last_hook_event_at: lastHookEventAt,
          session_name: session?.sessionName || session?.name || null,
          display_name: session?.displayName || null,
          source,
        };
      } catch (err) {
        const endedPayload = err?.payload || null;
        const endedStatus = endedPayload?.state?.status || null;
        const sessionEnded = endedPayload?.sessionEnded === true || endedStatus === 'ended';
        return {
          exists: false,
          live_process_count: 0,
          activity_status: 'done',
          last_active_at: null,
          session_state: sessionEnded ? (endedPayload?.state?.state || null) : null,
          canonical_status: sessionEnded ? endedStatus : null,
          session_detail: sessionEnded ? (endedPayload?.state?.detail || endedPayload?.state?.reason || endedPayload?.error || null) : null,
          session_reason: sessionEnded ? (endedPayload?.state?.reason || endedPayload?.error || null) : null,
          state_revision: sessionEnded ? (endedPayload?.state?.revision ?? null) : null,
          capabilities: sessionEnded ? (endedPayload?.state?.capabilities || null) : null,
          interaction: sessionEnded ? (endedPayload?.state?.interaction || null) : null,
          runtime: sessionEnded ? (endedPayload?.state?.runtime || null) : null,
          session_name: sessionEnded ? (endedPayload?.sessionName || endedPayload?.name || null) : null,
          display_name: sessionEnded ? (endedPayload?.displayName || null) : null,
          source: sessionEnded ? (endedPayload?.source || null) : null,
        };
      }
    })();

    cache.set(key, promise);
    return promise;
  }

  async function resolveAgentSession(agentRef) {
    if (!isAgentRef(agentRef)) {
      throw new Error('Invalid agent reference');
    }
    const adapter = adapters[agentRef.kind];
    if (!adapter) {
      throw new Error(`Unsupported agent kind: ${agentRef.kind}`);
    }
    try { await adapter.getSession(app, agentRef.sessionId); } catch (err) {
      if (err.statusCode !== 404 && err.code !== 'session_not_found' && err.payload?.sessionEnded !== true
        && err.payload?.state?.status !== 'ended') throw err;
      // Session routes report unknown ids as ended, so name the kind that owns a live session with this id.
      for (const [kind, other] of Object.entries(adapters)) {
        if (kind === agentRef.kind || !await other.getSession(app, agentRef.sessionId).catch(() => null)) continue;
        throw Object.assign(new Error(`no ${agentRef.kind} session ${agentRef.sessionId}; a ${kind} session with that id exists`),
          { statusCode: 404, code: 'session_kind_mismatch', cause: err });
      }
      throw err;
    }
    return adapter;
  }

  // Resolution is split from creation so a caller that spawns several participants can
  // validate all of them before the first session exists; otherwise a participant that fails
  // validation (an unavailable required MCP server, a disabled provider) leaves the sessions
  // created ahead of it orphaned with no thread.
  async function planParticipant(participant, fallbackWorkDir = '', createDefaults = {}) {
    if (!participant || typeof participant !== 'object' || typeof participant.kind !== 'string') {
      throw new Error('Invalid participant');
    }

    const rawProvider = typeof participant.provider === 'string' ? participant.provider.trim() : '';
    if (rawProvider && !resolveAgentBackendType(rawProvider)) {
      const error = new Error('provider must be claude, codex, deepseek, xai, google, opencode-go, or openrouter');
      error.statusCode = 400;
      throw error;
    }
    // A bus ref names the session backend (`claude`, `codex`, `pi`), which is not always a
    // provider id: the Pi backend runs xai, google, and opencode-go. A provider field that
    // itself names a backend (`provider: "pi"` — stored by older threads and legacy clients)
    // carries no provider information either.
    const explicitProvider = getAgentProviderDefinition(rawProvider)?.id || '';
    const backendKind = resolveAgentBackendType(rawProvider || participant.kind) || participant.kind;
    const adapter = adapters[backendKind];
    if (!adapter) {
      throw new Error(`Unsupported agent kind: ${participant.kind}`);
    }

    // An attached session already carries its own provider; the backend kind is enough.
    if (participant.sessionId) {
      const existing = await adapter.getSession(app, participant.sessionId);
      return {
        mode: 'attach',
        participant: {
          kind: backendKind,
          sessionId: participant.sessionId,
          created: false,
          mcpCapabilities: existing?.mcpCapabilities || existing?.session?.mcpCapabilities || null,
          mcpWarnings: [],
        },
      };
    }

    if (!participant.create) {
      throw new Error(`Participant ${participant.kind} requires sessionId or create=true`);
    }

    const preferences = readProviderPreferences();
    const fallbackProvider = preferences?.preferredSingleProvider || preferences?.preferredSingleAgent || 'codex';
    const explicitModel = typeof participant.model === 'string' ? participant.model.trim() : '';
    const defaultModel = typeof createDefaults.model === 'string' ? createDefaults.model.trim() : '';
    const backendProviders = agentProvidersForBackendType(backendKind);
    const providerFromModel = (model) => {
      const inferred = inferAgentProviderFromModel(model);
      return inferred && resolveAgentBackendType(inferred) === backendKind ? inferred : '';
    };
    // A provider id used as the kind (`{kind: "xai"}`) is as explicit as a provider field.
    const kindProviderDefinition = getAgentProviderDefinition(participant.kind);
    const kindProvider = kindProviderDefinition?.backendType === backendKind ? kindProviderDefinition.id : '';
    const requestedProvider = explicitProvider
      || kindProvider
      || providerFromModel(explicitModel)
      || providerFromModel(defaultModel)
      || (backendProviders.length === 1 ? backendProviders[0] : '')
      || (backendProviders.length === 0 ? participant.kind : '');
    if (!requestedProvider) {
      throw new Error(
        `Participant kind "${participant.kind}" requires an explicit provider (${backendProviders.join(', ')})`
      );
    }
    const selection = resolveAgentProviderSelection({
      provider: requestedProvider,
      model: '',
      fallbackProvider,
    });
    const defaultModelProvider = inferAgentProviderFromModel(defaultModel);
    const requestedModel = explicitModel
      || (defaultModel && (!defaultModelProvider || defaultModelProvider === selection.provider) ? defaultModel : '');
    const resolvedSelection = requestedModel
      ? resolveAgentProviderSelection({
          provider: selection.provider,
          model: requestedModel,
          fallbackProvider,
        })
      : selection;

    const providerCatalog = buildAgentProviderCatalog(preferences);
    const providerConfig = providerCatalog.find((entry) => entry.id === resolvedSelection.provider);
    if (!providerConfig?.enabled) {
      throw new Error(`Provider "${resolvedSelection.provider}" is disabled`);
    }
    if (providerConfig.supportsCollaboration === false) {
      throw new Error(`Provider "${resolvedSelection.provider}" does not support Agent Bus collaboration`);
    }

    const createAdapter = adapters[resolvedSelection.backendType];
    if (!createAdapter) {
      throw new Error(`Unsupported agent kind: ${resolvedSelection.backendType}`);
    }

    const mcpCatalog = buildMcpCapabilityCatalog();
    const threadMcp = resolveMcpCapabilities({
      request: {
        ...(createDefaults.mcpProfile !== undefined ? { mcpProfile: createDefaults.mcpProfile } : {}),
        ...(createDefaults.mcpServers !== undefined ? { mcpServers: createDefaults.mcpServers } : {}),
      },
      provider: resolvedSelection.provider,
      runtime: resolvedSelection.runtime,
      catalog: mcpCatalog,
    });
    // A collaboration thread is only a thread if its members can reach the bus, so bootstrap
    // spawns force `dueno` in regardless of the requested profile instead of silently
    // downgrading to a mute participant.
    const requireDueno = createDefaults.requireDueno === true;
    // Forcing the bus into a spawn that asked for no MCP servers overrides nothing, so that
    // warning is only worth carrying when a selection was actually requested.
    const mcpSelectionRequested = participant.mcpProfile !== undefined
      || participant.mcpServers !== undefined
      || createDefaults.mcpProfile !== undefined
      || createDefaults.mcpServers !== undefined;
    let participantMcp;
    try {
      participantMcp = resolveMcpCapabilities({
        request: {
          ...(participant.mcpProfile !== undefined ? { mcpProfile: participant.mcpProfile } : {}),
          ...(participant.mcpServers !== undefined ? { mcpServers: participant.mcpServers } : {}),
        },
        inherited: threadMcp,
        provider: resolvedSelection.provider,
        runtime: resolvedSelection.runtime,
        require: requireDueno ? [REQUIRED_COLLAB_MCP_SERVER_ID] : [],
        catalog: mcpCatalog,
      });
    } catch (err) {
      if (err?.code !== 'mcp_required_server_unavailable') throw err;
      const error = new Error(
        `Participant ${participant.kind} cannot join a collaboration thread: the required `
        + `"${REQUIRED_COLLAB_MCP_SERVER_ID}" MCP server is unavailable for provider `
        + `${resolvedSelection.provider} / runtime ${resolvedSelection.runtime} (${err.details?.reasonCode || err.code}). `
        + 'Fix the Cadre MCP (dueno) configuration for this provider, choose a provider that supports it, '
        + 'or spawn a solo session instead of a thread.'
      );
      error.statusCode = 400;
      error.code = 'collab_bus_mcp_unavailable';
      error.details = err.details || {};
      throw error;
    }
    const effectiveMcpRequest = mcpRequestForResolvedSelection(participantMcp, mcpCatalog);
    if ((createDefaults.sandbox ?? 'none') !== 'none' && !['claude', 'codex'].includes(resolvedSelection.backendType)) {
      throw Object.assign(new Error(`Participant ${participant.kind}: nono sandbox supports Claude and Codex sessions only`), {
        statusCode: 400, code: 'sandbox_unsupported',
      });
    }

    return {
      mode: 'create',
      createAdapter,
      resolvedSelection,
      mcpWarnings: participantMcp.warnings
        .filter((warning) => mcpSelectionRequested || warning.code !== 'mcp_required_server_forced')
        .map((warning) => ({ ...warning })),
      createArgs: {
        workDir: participant.workDir || fallbackWorkDir || '',
        args: Array.isArray(participant.args) ? participant.args : [],
        provider: resolvedSelection.backendProvider,
        model: resolvedSelection.model,
        thinkingLevel: typeof participant.thinkingLevel === 'string' && participant.thinkingLevel.trim()
          ? participant.thinkingLevel.trim()
          : (typeof createDefaults.thinkingLevel === 'string' && createDefaults.thinkingLevel.trim()
              ? createDefaults.thinkingLevel.trim()
              : defaultThinkingLevelForKind(participant.kind)),
        displayName: typeof participant.displayName === 'string' && participant.displayName.trim()
          ? participant.displayName.trim()
          : (typeof createDefaults.displayName === 'string' ? createDefaults.displayName.trim() : ''),
        ...(createDefaults.authContext && typeof createDefaults.authContext === 'object'
          ? { authContext: structuredClone(createDefaults.authContext) }
          : {}),
        ...effectiveMcpRequest,
        ...(resolvedSelection.runtime === 'codex' && (participant.codexPlugins !== undefined || createDefaults.codexPlugins !== undefined)
          ? { codexPlugins: participant.codexPlugins ?? createDefaults.codexPlugins }
          : {}),
        ...(participant.promptProfile !== undefined
          ? { promptProfile: participant.promptProfile }
          : (createDefaults.promptProfile !== undefined ? { promptProfile: createDefaults.promptProfile } : {})),
        ...(createDefaults.structured === true ? { structured: true } : {}),
        ...(createDefaults.sandbox !== undefined ? { sandbox: createDefaults.sandbox } : {}),
      },
    };
  }

  async function executeParticipantPlan(plan) {
    if (plan.mode === 'attach') return plan.participant;

    const created = await plan.createAdapter.createSession(app, plan.createArgs);
    return {
      kind: plan.resolvedSelection.backendType,
      sessionId: created.id,
      created: true,
      provider: plan.resolvedSelection.provider,
      sessionName: created.sessionName,
      displayName: created.displayName || plan.createArgs.displayName,
      mcpCapabilities: created.mcpCapabilities || null,
      mcpWarnings: plan.mcpWarnings.map((warning) => ({ ...warning })),
    };
  }

  async function resolveOrCreateParticipant(participant, fallbackWorkDir = '', createDefaults = {}) {
    return executeParticipantPlan(await planParticipant(participant, fallbackWorkDir, createDefaults));
  }

  // Deletes sessions this request created so a later validation or creation failure does not
  // leave orphaned agents behind with no thread to join.
  async function discardCreatedParticipants(participants = []) {
    const failures = [];
    for (const entry of participants) {
      if (!entry?.created || !entry.sessionId) continue;
      try { await adapters[entry.kind].deleteSession(app, entry.sessionId); }
      catch (err) { failures.push(`${participantKey(entry)}: ${err.message}`); }
    }
    return failures;
  }

  async function waitForSessionReady(kind, sessionId, { attempts = 90, intervalMs = 500 } = {}) {
    const adapter = adapters[kind];
    if (!adapter) {
      throw new Error(`Unsupported agent kind: ${kind}`);
    }

    let lastSession = null;
    for (let i = 0; i < attempts; i++) {
      try {
        const session = await adapter.getSession(app, sessionId);
        lastSession = session;
        const status = session?.state?.status || '';
        if (session?.state?.revision > 0 && status !== 'starting' && status !== 'unknown') {
          return session;
        }
      } catch {
        // Observation can flap while the pane is coming up. Keep polling.
      }

      await sleep(intervalMs);
    }

    // Fail open: startup injection has its own deadline and verifies after acting.
    // status unknown is "no confident read", not "unsafe to inject".
    return lastSession;
  }

  function isRetryableStartupInjectionError(error = {}) {
    const statusCode = Number(error.statusCode || error.payload?.statusCode || 0);
    const code = String(error.code || error.payload?.code || '').trim();
    if (code === 'startup_pane_unavailable') return false;
    return statusCode === 409
      || statusCode >= 500
      || code === 'agent_prompt_not_ready'
      || code === 'startup_input_failed';
  }

  async function injectBootstrapStartupText(adapter, app, participant, startupPrompt) {
    let lastError = null;
    const attempts = BOOTSTRAP_STARTUP_INJECTION_ATTEMPTS;
    let actualAttempts = 0;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      actualAttempts = attempt;
      try {
        const result = await adapter.injectStartupText(app, participant.sessionId, startupPrompt);
        return { attempts: attempt, resolution: result?.resolution || null };
      } catch (err) {
        lastError = err;
        if (attempt >= attempts || !isRetryableStartupInjectionError(err)) break;
        await sleep(BOOTSTRAP_STARTUP_RETRY_BASE_MS * attempt);
      }
    }

    throw Object.assign(lastError || new Error('Startup injection failed'), {
      bootstrapFailurePhase: 'startup_injection',
      bootstrapStartupAttempts: actualAttempts || 1,
    });
  }

  async function createBootstrapMessage({ threadId, participant, body, deliveryStatus }) {
    return store.createMessage({
      threadId,
      from: { kind: 'system', sessionId: 'bootstrap' },
      targets: [{ kind: participant.kind, sessionId: participant.sessionId }],
      type: 'startup_prompt',
      deliveryStatus,
      body,
      artifacts: [],
      createdBy: 'bootstrap',
      replyTo: null,
    });
  }


  return {
    getParticipantRuntime,
    resolveAgentSession,
    planParticipant,
    executeParticipantPlan,
    discardCreatedParticipants,
    resolveOrCreateParticipant,
    waitForSessionReady,
    injectBootstrapStartupText,
    createBootstrapMessage,
  };
}
