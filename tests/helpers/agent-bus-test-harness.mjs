import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordRuntimeHookEvent } from '../../modules/agent/hook-events.mjs';

function summarizeText(value, max = 600) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  const head = Math.max(160, Math.floor(max * 0.7));
  const tail = Math.max(80, max - head - 5);
  return `${text.slice(0, head)} ... ${text.slice(-tail)}`;
}

function summarizeEventData(data) {
  if (!data || typeof data !== 'object') return data;
  return {
    deliveryId: data.deliveryId ?? null,
    messageId: data.messageId ?? null,
    replyMessageId: data.replyMessageId ?? null,
    threadId: data.threadId ?? null,
    status: data.status ?? null,
    outcome: data.outcome ?? null,
    error: typeof data.error === 'string' ? summarizeText(data.error, 160) : null,
  };
}

function pushCapped(list, value, limit = 80) {
  list.push(value);
  if (list.length > limit) {
    list.splice(0, list.length - limit);
  }
}

async function rmWithRetries(path, opts = {}, attempts = 20) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(path, opts);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EBUSY' && error?.code !== 'EPERM') {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, 25 * (attempt + 1))));
    }
  }
  throw lastError;
}

function makeSessionState(detail = null) {
  return canonicalizeSessionState({
    state: 'waiting_for_input',
    needsInput: true,
    inputType: 'text',
    detail,
  });
}

function canonicalizeSessionState(state = {}) {
  if (state.status && state.capabilities) {
    const kind = state.interaction?.kind || 'none';
    const canSendNow = state.capabilities.canSendNow ?? state.capabilities.sendMessage === true;
    return {
      ...state,
      lifecycle: state.lifecycle || (state.status === 'ended' ? 'ended' : 'running'),
      execution: state.execution || (canSendNow ? 'idle' : ''),
      executionSource: state.executionSource || (canSendNow ? 'transcript' : ''),
      capabilities: {
        ...state.capabilities,
        canQueueMessage: state.capabilities.canQueueMessage ?? state.lifecycle === 'running',
        canSendNow,
        canAnswerInteraction: state.capabilities.canAnswerInteraction
          ?? ['permission', 'confirmation', 'selection', 'unknown_blocking'].includes(kind),
        canInterrupt: state.capabilities.canInterrupt ?? state.capabilities.interrupt === true,
      },
    };
  }
  const legacy = String(state.state || 'active');
  const status = legacy === 'waiting_for_input'
    ? 'ready'
    : ['needs_approval', 'needs_confirmation', 'parked'].includes(legacy)
      ? 'blocked'
      : legacy === 'exited' || legacy === 'ended'
        ? 'ended'
        : legacy === 'thinking'
          ? 'thinking'
          : legacy === 'working'
            ? 'working'
            : 'starting';
  const sendMessage = status === 'ready';
  const interactionKind = legacy === 'waiting_for_input'
    ? 'free_text'
    : legacy === 'needs_approval'
      ? 'permission'
      : legacy === 'needs_confirmation'
        ? 'confirmation'
        : legacy === 'parked'
          ? 'selection'
          : 'none';
  return {
    ...state,
    status,
    reason: state.detail || status,
    revision: Number(state.revision || 1),
    lifecycle: state.lifecycle || (status === 'ended' ? 'ended' : 'running'),
    execution: state.execution || (status === 'working' || status === 'thinking' ? status : 'idle'),
    executionSource: state.executionSource || (status === 'ended' ? '' : 'transcript'),
    capabilities: {
      canQueueMessage: status !== 'ended',
      canSendNow: sendMessage,
      canAnswerInteraction: ['permission', 'confirmation', 'selection'].includes(interactionKind),
      canInterrupt: status === 'working' || status === 'thinking' || status === 'awaiting_response',
      sendMessage,
      clear: sendMessage,
      interrupt: status === 'working' || status === 'thinking' || status === 'awaiting_response',
      autoClose: status === 'ended',
      needsAttention: status === 'blocked',
    },
    interaction: state.interaction || { kind: interactionKind, detail: state.detail || '', options: [], fingerprint: '' },
    runtime: state.runtime || {
      requestedModel: '', requestedThinkingLevel: '', effectiveModel: '', effectiveThinkingLevel: '',
    },
  };
}

function isSafeToClearState(state = {}) {
  return state?.state === 'waiting_for_input'
    && state?.needsInput !== false
    && (!state?.inputType || state.inputType === 'text');
}

function hasObservedClearReset(previousContent = '', currentContent = '') {
  const previous = typeof previousContent === 'string' ? previousContent : '';
  const current = typeof currentContent === 'string' ? currentContent : '';

  if (!current.trim()) return true;
  if (!previous) return false;
  if (current === previous) return false;
  if (current.length >= previous.length) return false;

  const previousTail = previous.slice(-Math.min(previous.length, 200));
  if (previousTail.length > 0 && current.includes(previousTail)) return false;

  return (
    current.length <= Math.floor(previous.length * 0.6)
    || current.length <= Math.max(20, previous.length - 80)
  );
}

const TOOL_BUSY_STATES = new Set(['working', 'thinking', 'needs_approval', 'needs_confirmation']);

const HARNESS_KINDS = ['claude', 'codex', 'deepseek', 'pi'];

function byKind(factory) {
  return Object.fromEntries(HARNESS_KINDS.map((kind) => [kind, factory(kind)]));
}

function resetSessionRegistry(catalog, states) {
  for (const kind of HARNESS_KINDS) {
    catalog[kind].clear();
    catalog[kind].add(`${kind}-1`);
    states[kind].clear();
    states[kind].set(`${kind}-1`, makeSessionState());
  }
}

export async function createAgentBusHarness({
  authToken = 'agent-bus-test-token',
  pollMs = 10,
  ackTimeoutMs = 5000,
  replyTimeoutMs = 5000,
  freshAgentBusModule = false,
  credentialStore = null,
  sessionDeleteTimeoutMs = undefined,
  beforeReady = async () => {},
} = {}) {
  process.env.AUTH_TOKEN = authToken;
  process.env.APP_STATE_STORAGE = 'file';
  process.env.AGENT_BUS_STORAGE = 'file';
  process.env.AGENT_BUS_POLL_MS = String(pollMs);
  process.env.AGENT_BUS_ACK_TIMEOUT_MS = String(ackTimeoutMs);
  process.env.AGENT_BUS_REPLY_TIMEOUT_MS = String(replyTimeoutMs);

  const stateDir = await mkdtemp(join(tmpdir(), 'agent-bus-'));
  const providerPreferencesFile = join(stateDir, 'agent-provider-preferences.json');
  process.env.AGENT_BUS_STATE_DIR = stateDir;
  process.env.AGENT_PROVIDER_PREFERENCES_FILE = providerPreferencesFile;
  await writeFile(providerPreferencesFile, JSON.stringify({ claudeEnabled: true, codexEnabled: true }, null, 2));

  const { default: Fastify } = await import('fastify');
  const { authPlugin } = await import('../../modules/platform/auth.mjs');
  const agentBusModuleRef = freshAgentBusModule
    ? `../../modules/agent-bus/index.mjs?agentBusHarness=${Date.now()}_${Math.random().toString(36).slice(2)}`
    : '../../modules/agent-bus/index.mjs';
  const { agentBusPlugin } = await import(agentBusModuleRef);
  const { AgentBusStore } = await import('../../modules/agent-bus/store.mjs');
  const { notifyAgentSessionDeleted } = await import('../../modules/agent/session-delete-events.mjs');

  const injected = byKind(() => []);
  const injectFailures = byKind(() => new Map());
  const createdSessions = byKind(() => []);
  const sessionFetchCounts = byKind(() => new Map());
  const inputObservers = byKind(() => null);
  const inputResponders = byKind(() => null);
  const sessionDetailResponders = byKind(() => null);
  const deleteResponders = byKind(() => null);
  const createResponders = byKind(() => null);
  const deletedSessions = byKind(() => []);
  const createCounters = byKind(() => 0);
  const content = byKind(() => '');
  const sessionWorkDirs = byKind((kind) => new Map([[`${kind}-1`, stateDir]]));
  const sessionStates = byKind((kind) => new Map([[`${kind}-1`, makeSessionState()]]));
  const sessionCatalog = byKind((kind) => new Set([`${kind}-1`]));
  const endedSessions = byKind(() => new Set());
  const lastHookedStates = byKind(() => new Map());
  const wsEvents = [];
  const store = new AgentBusStore({ stateDir });

  const app = Fastify();
  app.decorate('agentBusLifecycle', {});
  await app.register(authPlugin);

  async function emitRuntimeHook(kind, sessionId, eventName, data = {}) {
    await recordRuntimeHookEvent({
      workDir: sessionWorkDirs[kind].get(sessionId) || stateDir,
      provider: kind,
      sessionId,
      eventName,
      data,
    });
  }

  async function maybeEmitStateHooks(kind, sessionId, state, currentContent = '') {
    const nextState = String(state?.state || '').trim();
    if (!nextState) return;

    const previousState = String(lastHookedStates[kind].get(sessionId) || '').trim();
    if (previousState === nextState) return;
    lastHookedStates[kind].set(sessionId, nextState);

    const payload = {
      previousState: previousState || null,
      sessionState: nextState,
      detail: typeof state?.detail === 'string' ? state.detail : null,
      inputType: typeof state?.inputType === 'string' ? state.inputType : null,
      snippet: summarizeText(currentContent || '', 160) || null,
    };

    await emitRuntimeHook(kind, sessionId, 'SessionStateChanged', payload);
    if (TOOL_BUSY_STATES.has(nextState) && !TOOL_BUSY_STATES.has(previousState)) {
      await emitRuntimeHook(kind, sessionId, 'SessionToolStarted', payload);
    }
    if (TOOL_BUSY_STATES.has(previousState) && nextState === 'waiting_for_input') {
      await emitRuntimeHook(kind, sessionId, 'SessionToolFinished', payload);
    }
    if (nextState === 'waiting_for_input') {
      await emitRuntimeHook(kind, sessionId, 'SessionPromptReady', payload);
      return;
    }
    if (TOOL_BUSY_STATES.has(nextState)) {
      await emitRuntimeHook(kind, sessionId, 'SessionBusy', payload);
    }
  }

  for (const kind of HARNESS_KINDS) {
    app.get(`/api/${kind}/sessions`, async () => ({
      sessions: [...sessionCatalog[kind]].map((id) => ({ id, sessionName: id, source: 'test' })),
    }));

    app.get(`/api/${kind}/sessions/:id`, async (req, reply) => {
      sessionFetchCounts[kind].set(req.params.id, Number(sessionFetchCounts[kind].get(req.params.id) || 0) + 1);
      if (typeof sessionDetailResponders[kind] === 'function') {
        const response = await sessionDetailResponders[kind]({
          kind,
          sessionId: req.params.id,
          reply,
        });
        if (response && typeof response === 'object') {
          if (response.statusCode) {
            return reply.code(response.statusCode).send(response.payload || { error: response.error || 'Session detail failure' });
          }
          if (response.payload) {
            return response.payload.state
              ? { ...response.payload, state: canonicalizeSessionState(response.payload.state) }
              : response.payload;
          }
        }
      }
      if (endedSessions[kind].has(req.params.id)) {
        return {
          id: req.params.id,
          sessionName: req.params.id,
          source: 'test',
          content: '',
          workDir: sessionWorkDirs[kind].get(req.params.id) || stateDir,
          sessionEnded: true,
          state: canonicalizeSessionState({ state: 'ended', needsInput: false, inputType: null, detail: 'Session ended' }),
        };
      }
      if (!sessionCatalog[kind].has(req.params.id)) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      const state = canonicalizeSessionState(sessionStates[kind].get(req.params.id) || makeSessionState());
      await maybeEmitStateHooks(kind, req.params.id, state, content[kind]);
      return {
        id: req.params.id,
        sessionName: req.params.id,
        source: 'test',
        content: content[kind],
        workDir: sessionWorkDirs[kind].get(req.params.id) || stateDir,
        state,
      };
    });

    async function handleSessionInput(req, reply) {
      if (!sessionCatalog[kind].has(req.params.id)) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      if (typeof inputResponders[kind] === 'function') {
        const response = await inputResponders[kind]({
          kind,
          sessionId: req.params.id,
          text: req.body.text,
          body: req.body,
        });
        if (response && typeof response === 'object') {
          if (response.state) {
            sessionStates[kind].set(req.params.id, response.state);
          }
          if (Object.prototype.hasOwnProperty.call(response, 'content')) {
            content[kind] = typeof response.content === 'string' ? response.content : '';
          }
          if (response.statusCode) {
            return reply.code(response.statusCode).send(response.payload || { error: response.error || 'Injected input failure' });
          }
        }
      }
      const remainingFailures = Number(injectFailures[kind].get(req.params.id) || 0);
      if (remainingFailures > 0) {
        injectFailures[kind].set(req.params.id, remainingFailures - 1);
        return reply.code(502).send({ error: 'Injected delivery failure' });
      }
      pushCapped(injected[kind], summarizeText(
        req.body.text,
        req.url.includes('/startup-input') ? 4000 : 600,
      ));
      if (typeof inputObservers[kind] === 'function') {
        await inputObservers[kind]({
          kind,
          sessionId: req.params.id,
          text: req.body.text,
          body: req.body,
        });
      }
      return { ok: true };
    }

    app.post(`/api/${kind}/sessions/:id/input`, handleSessionInput);
    app.post(`/api/${kind}/sessions/:id/startup-input`, handleSessionInput);

    app.post(`/api/${kind}/sessions/:id/clear`, async (req, reply) => {
      if (!sessionCatalog[kind].has(req.params.id)) {
        return reply.code(404).send({ error: 'Session not found', code: 'session_not_found' });
      }

      const beforeState = sessionStates[kind].get(req.params.id) || makeSessionState();
      if (!isSafeToClearState(beforeState)) {
        await emitRuntimeHook(kind, req.params.id, 'SessionClearRejected', {
          sessionState: beforeState.state || null,
          detail: beforeState.detail || null,
          inputType: beforeState.inputType || null,
          safeToClear: false,
        });
        return reply.code(409).send({
          error: 'Session is not safe to clear right now',
          code: 'unsafe_session_state',
          safeToClear: false,
          sessionState: beforeState.state || null,
          inputType: beforeState.inputType || null,
          detail: beforeState.detail || null,
        });
      }

      const previousContent = content[kind];
      const clearIssuedAt = Date.now();
      await emitRuntimeHook(kind, req.params.id, 'SessionClearRequested', {
        sessionState: beforeState.state || null,
        detail: beforeState.detail || null,
        inputType: beforeState.inputType || null,
        previousContentLength: previousContent.length,
        clearIssuedAt,
      });
      if (typeof inputResponders[kind] === 'function') {
        const response = await inputResponders[kind]({
          kind,
          sessionId: req.params.id,
          text: '/clear',
          body: { text: '/clear', enter: true },
        });
        if (response && typeof response === 'object') {
          if (response.state) {
            sessionStates[kind].set(req.params.id, response.state);
          }
          if (Object.prototype.hasOwnProperty.call(response, 'content')) {
            content[kind] = typeof response.content === 'string' ? response.content : '';
          }
          if (response.statusCode) {
            return reply.code(response.statusCode).send(response.payload || { error: response.error || 'Injected clear failure' });
          }
        }
      }

      pushCapped(injected[kind], '/clear');
      if (typeof inputObservers[kind] === 'function') {
        await inputObservers[kind]({
          kind,
          sessionId: req.params.id,
          text: '/clear',
          body: { text: '/clear', enter: true },
        });
      } else {
        content[kind] = '';
      }

      let confirmedContent = content[kind];
      let confirmedState = sessionStates[kind].get(req.params.id) || makeSessionState();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        confirmedContent = content[kind];
        confirmedState = sessionStates[kind].get(req.params.id) || makeSessionState();
        if (isSafeToClearState(confirmedState) && hasObservedClearReset(previousContent, confirmedContent)) {
          await maybeEmitStateHooks(kind, req.params.id, confirmedState, confirmedContent);
          await emitRuntimeHook(kind, req.params.id, 'SessionClearConfirmed', {
            sessionState: confirmedState.state || null,
            detail: confirmedState.detail || null,
            inputType: confirmedState.inputType || null,
            previousContentLength: previousContent.length,
            confirmedContentLength: confirmedContent.length,
            clearIssuedAt,
            confirmedAt: Date.now(),
          });
          await emitRuntimeHook(kind, req.params.id, 'SessionPromptReadyAfterClear', {
            sessionState: confirmedState.state || null,
            detail: confirmedState.detail || null,
            inputType: confirmedState.inputType || null,
            confirmedContentLength: confirmedContent.length,
            clearIssuedAt,
          });
          return {
            ok: true,
            clearConfirmed: true,
            clearIssuedAt,
            confirmedAt: Date.now(),
            previousContentLength: previousContent.length,
            confirmedContentLength: confirmedContent.length,
            sessionState: confirmedState.state || null,
            state: confirmedState,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      return reply.code(504).send({
        error: 'Session clear did not confirm in time',
        code: 'clear_not_confirmed',
        safeToClear: false,
        sessionState: confirmedState.state || null,
        inputType: confirmedState.inputType || null,
        detail: confirmedState.detail || null,
        previousContentLength: previousContent.length,
        confirmedContentLength: confirmedContent.length,
      });
    });

    app.post(`/api/${kind}/sessions/:id/enter`, async (req, reply) => {
      if (!sessionCatalog[kind].has(req.params.id)) {
        return reply.code(404).send({ error: 'Session not found' });
      }
      return { ok: true };
    });

    app.post(`/api/${kind}/sessions`, async (req) => {
      if (typeof createResponders[kind] === 'function') {
        await createResponders[kind](req.body);
      }
      createdSessions[kind].push(req.body);
      createCounters[kind] += 1;
      const nextId = `${kind}-new-${createCounters[kind]}`;
      sessionCatalog[kind].add(nextId);
      sessionStates[kind].set(nextId, makeSessionState());
      sessionWorkDirs[kind].set(nextId, req.body?.workDir || stateDir);
      return { id: nextId, sessionName: `${kind}-boot` };
    });

    app.delete(`/api/${kind}/sessions/:id`, async (req, reply) => {
      if (typeof deleteResponders[kind] === 'function') {
        const response = await deleteResponders[kind](req.params.id);
        if (response?.statusCode) return reply.code(response.statusCode).send(response.body);
      }
      if (!sessionCatalog[kind].has(req.params.id)) {
        return { ok: true, status: 'already_gone', kind, sessionId: req.params.id, residual: [], reason: 'session_identity_absent' };
      }
      pushCapped(deletedSessions[kind], req.params.id);
      sessionCatalog[kind].delete(req.params.id);
      sessionStates[kind].delete(req.params.id);
      sessionWorkDirs[kind].delete(req.params.id);
      await notifyAgentSessionDeleted({ kind, sessionId: req.params.id },
        sessionDeleteTimeoutMs === undefined ? undefined : { timeoutMs: sessionDeleteTimeoutMs });
      return { ok: true, status: 'terminated', kind, sessionId: req.params.id, residual: [], reason: '' };
    });
  }

  await app.register(agentBusPlugin, {
    managedWorktreeBaseDir: join(stateDir, "managed-worktrees"),
    store,
    ...(credentialStore ? { credentialStore } : {}),
    wsManager: {
      broadcast(channel, type, data) {
        pushCapped(wsEvents, { channel, type, data: summarizeEventData(data) });
      },
      onChannel() {},
      send(_socket, channel, type, data) {
        pushCapped(wsEvents, { channel, type, data: summarizeEventData(data), direct: true });
      },
    },
  });

  await beforeReady(app, stateDir);
  await app.ready();

  const authHeaders = { authorization: `Bearer ${authToken}` };

  async function reset() {
    wsEvents.length = 0;
    for (const kind of HARNESS_KINDS) {
      injected[kind].length = 0;
      createdSessions[kind].length = 0;
      deletedSessions[kind].length = 0;
      sessionFetchCounts[kind].clear();
      injectFailures[kind].clear();
      endedSessions[kind].clear();
      lastHookedStates[kind].clear();
      content[kind] = '';
      createCounters[kind] = 0;
      inputResponders[kind] = null;
      sessionDetailResponders[kind] = null;
      deleteResponders[kind] = null;
      createResponders[kind] = null;
      sessionWorkDirs[kind].clear();
      sessionWorkDirs[kind].set(`${kind}-1`, stateDir);
    }
    resetSessionRegistry(sessionCatalog, sessionStates);
    await writeFile(providerPreferencesFile, JSON.stringify({ claudeEnabled: true, codexEnabled: true }, null, 2));

    const threadList = await app.inject({
      method: 'GET',
      url: '/api/agent-bus/threads',
      headers: authHeaders,
    });
    if (threadList.statusCode !== 200) return;

    for (const thread of threadList.json().threads || []) {
      await app.inject({
        method: 'DELETE',
        url: `/api/agent-bus/threads/${thread.id}`,
        headers: authHeaders,
      });
    }

    await rmWithRetries(join(stateDir, '.agent_bus', 'hooks'), { recursive: true, force: true });
    await mkdir(join(stateDir, '.agent_bus', 'hooks'), { recursive: true });
  }

  async function cleanup() {
    await app.close();
    await rmWithRetries(stateDir, { recursive: true, force: true });
    delete process.env.AUTH_TOKEN;
    delete process.env.AGENT_BUS_STATE_DIR;
    delete process.env.APP_STATE_STORAGE;
    delete process.env.AGENT_BUS_STORAGE;
    delete process.env.AGENT_BUS_POLL_MS;
    delete process.env.AGENT_BUS_ACK_TIMEOUT_MS;
    delete process.env.AGENT_BUS_REPLY_TIMEOUT_MS;
    delete process.env.AGENT_PROVIDER_PREFERENCES_FILE;
  }

  async function setProviderPreferences(preferences) {
    await writeFile(providerPreferencesFile, JSON.stringify(preferences, null, 2));
  }

  return {
    app,
    authHeaders,
    authToken,
    stateDir,
    injected,
    injectFailures,
    createdSessions,
    sessionFetchCounts,
    inputObservers,
    inputResponders,
    sessionDetailResponders,
    deleteResponders,
    createResponders,
    deletedSessions,
    content,
    sessionWorkDirs,
    sessionStates,
    sessionCatalog,
    endedSessions,
    wsEvents,
    providerPreferencesFile,
    store,
    setProviderPreferences,
    reset,
    cleanup,
  };
}
