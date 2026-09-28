import { config } from '../../config.mjs';
import { buildInternalBypassHeaders } from '../platform/auth.mjs';
import { buildAgentProviderCatalog, resolveAgentProviderSelection } from './provider-interface.mjs';
import { getAgentProviderPreferences } from './provider-preferences.mjs';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { legacyRootStatePath, runtimeStatePath } from '../ops/runtime-state.mjs';
import { getPublicMcpCapabilityCatalog } from '../integrations/mcp-server-catalog.mjs';
import { getPublicPromptProfileCatalog } from '../integrations/prompt-profile-catalog.mjs';
import { composeLaunchUserPrompt, publicLaunchSkills } from '../integrations/launch-skills.mjs';
import { createAgentSessionWorktree } from '../fleet/git-worktree.mjs';
import { expandHomePath } from '../sessions/workdir.mjs';
import { buildInProcessFastifyRequest } from '../agent-bus/in-process-mcp.mjs';

const DEFAULT_TASK_TIMEOUT_MS = 180000;
const DEFAULT_TASK_POLL_INTERVAL_MS = 1000;
const DEFAULT_TASK_LINES = 400;
const BUSY_ONE_OFF_STATUSES = new Set(['working', 'thinking', 'awaiting_response']);
const DEFAULT_IDEMPOTENCY_TTL_MS = 3_600_000;
const DEFAULT_IDEMPOTENCY_STORE_FILE = runtimeStatePath('agent_session_idempotency.json');
const LEGACY_IDEMPOTENCY_STORE_FILE = legacyRootStatePath('agent_session_idempotency.json');

function compactBody(value = {}) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, entry]) => entry !== undefined));
}

function buildSingleSessionStartupPrompt(input = {}) {
  return composeLaunchUserPrompt({
    skillIds: input.skills,
    initialPrompt: input.initialPrompt,
  });
}

function normalizeTimeoutMs(value, fallback = DEFAULT_TASK_TIMEOUT_MS) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function normalizePollIntervalMs(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TASK_POLL_INTERVAL_MS;
  return Math.max(250, Math.min(parsed, 5000));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionBasePath(backendType) {
  return `/api/${backendType}/sessions`;
}

function taskOutputFromSession(session = {}) {
  return typeof session?.content === 'string' ? session.content.trim() : '';
}

function buildTaskResult(selection, sessionResult, taskResult) {
  return {
    status: 'completed',
    provider: selection.provider,
    backendType: selection.backendType,
    runtime: selection.runtime,
    executionMode: 'ephemeral_session_fallback',
    session: {
      id: sessionResult.id,
      sessionName: sessionResult.sessionName,
      initialPromptInjected: sessionResult.initialPromptInjected !== false,
    },
    task: taskResult,
  };
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeIdempotencyKey(value) {
  return normalizeText(value).slice(0, 300);
}

function flagEnabled(value) {
  return value === true || ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function addDmrCompatSessionShape(result = {}) {
  const sessionId = normalizeText(result.id || result.sessionId || result.session?.id);
  const threadId = normalizeText(result.thread?.id || result.threadId || result.session?.threadId);
  return {
    ...result,
    session: {
      ...(result.session && typeof result.session === 'object' ? result.session : {}),
      id: sessionId,
      threadId,
    },
  };
}

function idempotentResultFromRecord(record = {}) {
  return addDmrCompatSessionShape({
    id: normalizeText(record.sessionId),
    provider: normalizeText(record.provider),
    backendType: normalizeText(record.backendType),
    runtime: normalizeText(record.runtime),
    executionMode: normalizeText(record.executionMode || 'interactive_session'),
    initialPromptInjected: true,
    idempotencyReplay: true,
    thread: normalizeText(record.threadId) ? { id: normalizeText(record.threadId) } : null,
  });
}

function normalizeStoreState(raw = {}) {
  const entries = {};
  const source = raw?.entries && typeof raw.entries === 'object' ? raw.entries : {};
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = normalizeIdempotencyKey(key);
    const sessionId = normalizeText(value?.sessionId);
    if (!normalizedKey || !sessionId) continue;
    entries[normalizedKey] = {
      key: normalizedKey,
      sessionId,
      threadId: normalizeText(value?.threadId),
      backendType: normalizeText(value?.backendType),
      provider: normalizeText(value?.provider),
      runtime: normalizeText(value?.runtime),
      executionMode: normalizeText(value?.executionMode || 'interactive_session'),
      createdAtMs: normalizeMs(value?.createdAtMs),
    };
  }
  return { version: 1, entries };
}

export function buildAgentSessionIdempotencyStore({
  stateStore,
  storeFile = DEFAULT_IDEMPOTENCY_STORE_FILE,
  namespace = 'agent_session_idempotency',
  env = process.env,
} = {}) {
  const backingStore = stateStore || buildPostgresJsonStore({
    namespace,
    filePath: storeFile,
    legacyFilePath: storeFile === DEFAULT_IDEMPOTENCY_STORE_FILE ? LEGACY_IDEMPOTENCY_STORE_FILE : undefined,
    env,
  });
  let loaded = false;
  let loadingPromise = null;
  let saveQueue = Promise.resolve();
  let state = normalizeStoreState(backingStore.loadSync?.() || {});

  async function load() {
    if (loaded) return;
    if (!loadingPromise) {
      loadingPromise = (async () => {
        const raw = await backingStore.load().catch(() => null);
        if (raw && typeof raw === 'object') state = normalizeStoreState(raw);
        loaded = true;
      })().finally(() => {
        loadingPromise = null;
      });
    }
    await loadingPromise;
  }

  async function save() {
    const snapshot = JSON.parse(JSON.stringify(state));
    const write = saveQueue.catch(() => {}).then(() => backingStore.save(snapshot));
    saveQueue = write.catch(() => {});
    await write;
  }

  async function get(key) {
    await load();
    const record = state.entries[normalizeIdempotencyKey(key)];
    return record ? JSON.parse(JSON.stringify(record)) : null;
  }

  async function set(key, record = {}) {
    await load();
    const normalizedKey = normalizeIdempotencyKey(key);
    if (!normalizedKey) return null;
    state.entries[normalizedKey] = {
      key: normalizedKey,
      sessionId: normalizeText(record.sessionId),
      threadId: normalizeText(record.threadId),
      backendType: normalizeText(record.backendType),
      provider: normalizeText(record.provider),
      runtime: normalizeText(record.runtime),
      executionMode: normalizeText(record.executionMode || 'interactive_session'),
      createdAtMs: normalizeMs(record.createdAtMs) || Date.now(),
    };
    await save();
    return JSON.parse(JSON.stringify(state.entries[normalizedKey]));
  }

  async function close() {
    await saveQueue.catch(() => {});
    if (typeof backingStore.close === 'function') await backingStore.close();
  }

  return { get, set, close };
}

export function buildAgentInterface({
  requestImpl,
  getPreferences = getAgentProviderPreferences,
  idempotencyStore = null,
  idempotencyTtlMs = DEFAULT_IDEMPOTENCY_TTL_MS,
  now = () => Date.now(),
  sessionExistsImpl = null,
  worktreeCreator = null,
  worktreeBaseDir = '~/.dueno-fleet/agent-worktrees',
} = {}) {
  if (!requestImpl) throw new Error('requestImpl is required');

  async function request(path, opts) {
    return requestImpl(path, opts);
  }

  async function getSelection(input = {}) {
    const preferences = await getPreferences();
    const fallbackProvider = preferences?.preferredSingleProvider || preferences?.preferredSingleAgent || 'codex';
    const selection = resolveAgentProviderSelection({
      provider: input.provider,
      model: input.model,
      fallbackProvider,
    });
    const catalog = buildAgentProviderCatalog(preferences);
    const providerConfig = catalog.find((entry) => entry.id === selection.provider);
    if (!providerConfig?.enabled) {
      const error = new Error(`Provider "${selection.provider}" is disabled`);
      error.statusCode = 400;
      throw error;
    }
    return { preferences, selection, providerConfig };
  }

  async function sessionExists(selection, sessionId) {
    if (!sessionId) return false;
    if (typeof sessionExistsImpl === 'function') {
      return sessionExistsImpl({ selection, sessionId });
    }
    try {
      await request(`${sessionBasePath(selection.backendType)}/${encodeURIComponent(sessionId)}?lines=1`);
      return true;
    } catch {
      return false;
    }
  }

  async function waitForInteractiveSessionReady(selection, sessionId, {
    attempts = 90,
    intervalMs = 500,
  } = {}) {
    let lastError = null;
    for (let i = 0; i < attempts; i += 1) {
      try {
        const session = await request(`${sessionBasePath(selection.backendType)}/${encodeURIComponent(sessionId)}?lines=200`);
        const status = String(session?.state?.status || '').trim();
        if (session?.state?.revision > 0 && status !== 'starting' && status !== 'unknown') return session;
      } catch (error) {
        lastError = error;
      }

      await sleep(intervalMs);
    }

    if (lastError) throw lastError;
    throw new Error(`Session ${selection.backendType}:${sessionId} did not become ready in time`);
  }

  async function injectInteractiveSessionPrompt(selection, sessionId, text) {
    const prompt = typeof text === 'string' ? text.trim() : '';
    if (!prompt) {
      return { injected: false, error: null };
    }

    await waitForInteractiveSessionReady(selection, sessionId);

    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await sleep(selection.backendType === 'codex' ? 350 : 500);

      try {
        await request(`${sessionBasePath(selection.backendType)}/${encodeURIComponent(sessionId)}/startup-input`, {
          method: 'POST',
          body: { text: prompt, enter: true },
        });
        return { injected: true, error: null };
      } catch (error) {
        lastError = error;
      }
    }

    return {
      injected: false,
      error: lastError?.message || 'Initial prompt injection failed',
    };
  }

  async function listProviders() {
    const preferences = await getPreferences();
    const providers = buildAgentProviderCatalog(preferences);
    return {
      preferredProvider: preferences?.preferredSingleProvider || preferences?.preferredSingleAgent || 'codex',
      collabEnabled: preferences?.collabEnabled !== false,
      providers,
    };
  }

  function listMcpServers() {
    return getPublicMcpCapabilityCatalog();
  }

  function listPromptProfiles() {
    return getPublicPromptProfileCatalog();
  }

  function listLaunchSkills() {
    return { skills: publicLaunchSkills() };
  }

  async function createInteractiveSession(input = {}) {
    const { selection } = await getSelection(input);
    const requestedWorkDir = normalizeText(input.workDir);
    let sessionWorkDir = requestedWorkDir;
    let worktree = null;
    if (flagEnabled(input.isolatedWorktree)) {
      if (!requestedWorkDir) {
        const error = new Error('workDir is required when isolatedWorktree is enabled');
        error.statusCode = 400;
        throw error;
      }
      const createWorktree = worktreeCreator || createAgentSessionWorktree;
      worktree = await createWorktree({
        repoPath: requestedWorkDir,
        baseDir: expandHomePath(input.worktreeBaseDir || worktreeBaseDir),
        displayName: input.displayName || selection.provider,
        nowMs: now(),
      });
      sessionWorkDir = worktree.worktreePath;
    }
    const result = await request(sessionBasePath(selection.backendType), {
      method: 'POST',
      ...(input._serverAuthContext ? { authContext: input._serverAuthContext } : {}),
      body: compactBody({
        workDir: sessionWorkDir,
        displayName: input.displayName,
        model: selection.model,
        provider: selection.backendProvider,
        thinkingLevel: input.thinkingLevel,
        mcpProfile: input.mcpProfile,
        mcpServers: input.mcpServers,
        ...(selection.backendType === 'codex' ? { codexPlugins: input.codexPlugins } : {}),
        promptProfile: input.promptProfile,
        skills: input.skills,
        initialPrompt: input.initialPrompt,
        structured: input.structured === true || undefined,
        metadata: {
          ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
          ...(worktree ? {
            isolatedWorktree: true,
            requestedWorkDir,
            worktreePath: worktree.worktreePath || '',
            worktreeBranch: worktree.branch || '',
            worktreeBaseRef: worktree.baseRef || '',
            worktreeRepoPath: worktree.repoPath || requestedWorkDir || '',
          } : {}),
        },
      }),
    });

    try {
      const startupPrompt = buildSingleSessionStartupPrompt(input);
      let injection = {
        injected: result.initialPromptInjected === true,
        error: result.initialPromptError || null,
      };
      const unconfirmed = result.initialPromptDelivery?.submission === 'unconfirmed'
        || /submission was not confirmed/i.test(result.initialPromptError || '');
      if (startupPrompt && result.initialPromptInjected !== true && !unconfirmed) {
        injection = await injectInteractiveSessionPrompt(selection, result.id, startupPrompt);
        if (!injection.injected) {
          const error = new Error(injection.error || 'Initial prompt injection failed');
          error.statusCode = 500;
          throw error;
        }
      }

      return addDmrCompatSessionShape({
        // Flat snapshot fields kept for Fleet-native consumers (read result.id).
        ...result,
        // dm-runner (dmr) wire shape: external callers read the session id at
        // /session/id. Standalone sessions intentionally have no thread id.
        session: {
          ...result,
          initialPromptInjected: injection.injected,
          initialPromptError: injection.error,
        },
        workspaceDir: sessionWorkDir || '',
        requestedWorkspaceDir: requestedWorkDir,
        isolatedWorktree: Boolean(worktree),
        worktree,
        initialPromptInjected: injection.injected,
        initialPromptError: injection.error,
        provider: selection.provider,
        backendType: selection.backendType,
        runtime: selection.runtime,
        executionMode: 'interactive_session',
        thread: null,
      });
    } catch (error) {
      try {
        await request(`${sessionBasePath(selection.backendType)}/${encodeURIComponent(result.id)}`, {
          method: 'DELETE',
        });
      } catch {
        // Best effort cleanup on post-create failure.
      }
      throw error;
    }
  }

  const inFlightIdempotency = new Map();

  async function createInteractiveSessionIdempotent(input = {}) {
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    if (!idempotencyKey || !idempotencyStore) {
      return createInteractiveSession(input);
    }
    const existingPromise = inFlightIdempotency.get(idempotencyKey);
    if (existingPromise) return existingPromise;
    const promise = (async () => {
      const { selection } = await getSelection(input);
      const record = await idempotencyStore.get(idempotencyKey);
      const ttlMs = Number(idempotencyTtlMs || DEFAULT_IDEMPOTENCY_TTL_MS);
      const fresh = record && (now() - normalizeMs(record.createdAtMs)) <= ttlMs;
      if (fresh && await sessionExists(selection, record.sessionId)) {
        return idempotentResultFromRecord(record);
      }
      const created = await createInteractiveSession(input);
      await idempotencyStore.set(idempotencyKey, {
        sessionId: created.id,
        threadId: created.thread?.id || created.session?.threadId || '',
        backendType: created.backendType,
        provider: created.provider,
        runtime: created.runtime,
        executionMode: created.executionMode,
        createdAtMs: now(),
      });
      return created;
    })().finally(() => {
      inFlightIdempotency.delete(idempotencyKey);
    });
    inFlightIdempotency.set(idempotencyKey, promise);
    return promise;
  }

  async function waitForOneOffTask(selection, sessionId, {
    timeoutMs = DEFAULT_TASK_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_TASK_POLL_INTERVAL_MS,
    lines = DEFAULT_TASK_LINES,
  } = {}) {
    const startedAt = Date.now();
    let lastSession = null;
    let sawBusy = false;

    while ((Date.now() - startedAt) < timeoutMs) {
      const session = await request(`${sessionBasePath(selection.backendType)}/${encodeURIComponent(sessionId)}?lines=${lines}`);
      const state = String(session?.state?.state || '').trim();
      const status = String(session?.state?.status || '').trim();
      const detail = String(session?.state?.reason || session?.state?.detail || '').trim();
      const output = taskOutputFromSession(session);
      lastSession = session;
      if (BUSY_ONE_OFF_STATUSES.has(status)) sawBusy = true;

      if (status === 'blocked') {
        const error = new Error(detail || `Task requires interactive input (${status})`);
        error.statusCode = 409;
        error.taskResult = {
          state,
          status,
          reason: session?.state?.reason || null,
          revision: session?.state?.revision ?? null,
          detail: detail || null,
          output,
          timedOut: false,
        };
        throw error;
      }

      // New sessions are often `ready` before the injected prompt starts work.
      // Ending that early deletes the session before it can write its result.
      if (status === 'ended' || (status === 'ready' && sawBusy)) {
        return {
          state,
          status,
          reason: session?.state?.reason || null,
          revision: session?.state?.revision ?? null,
          detail: detail || null,
          output,
          timedOut: false,
        };
      }

      await sleep(pollIntervalMs);
    }

    const timeoutError = new Error(`Timed out waiting for ${selection.provider} task completion`);
    timeoutError.statusCode = 504;
    timeoutError.taskResult = {
      state: lastSession?.state?.state || null,
      status: lastSession?.state?.status || null,
      reason: lastSession?.state?.reason || null,
      revision: lastSession?.state?.revision ?? null,
      detail: lastSession?.state?.detail || null,
      output: taskOutputFromSession(lastSession),
      timedOut: true,
    };
    throw timeoutError;
  }

  async function runOneOffTask(input = {}) {
    const { selection } = await getSelection(input);
    const timeoutMs = normalizeTimeoutMs(input.timeoutMs);
    const pollIntervalMs = normalizePollIntervalMs(input.pollIntervalMs);
    const sessionResult = await request(sessionBasePath(selection.backendType), {
      method: 'POST',
      body: compactBody({
        workDir: input.workDir,
        displayName: input.displayName,
        model: selection.model,
        provider: selection.backendProvider,
        thinkingLevel: input.thinkingLevel,
        initialPrompt: input.prompt,
        mcpProfile: input.mcpProfile,
        mcpServers: input.mcpServers,
        ...(selection.backendType === 'codex' ? { codexPlugins: input.codexPlugins } : {}),
        promptProfile: input.promptProfile,
        skills: input.skills,
        metadata: input.metadata,
      }),
    });

    if (sessionResult?.initialPromptInjected === false) {
      const error = new Error(sessionResult?.initialPromptError || 'Initial prompt injection failed');
      error.statusCode = 500;
      throw error;
    }

    let taskResult = null;
    try {
      taskResult = await waitForOneOffTask(selection, sessionResult.id, {
        timeoutMs,
        pollIntervalMs,
        lines: input.lines,
      });
      return buildTaskResult(selection, sessionResult, taskResult);
    } catch (error) {
      taskResult = error?.taskResult || null;
      error.taskExecution = {
        status: 'failed',
        provider: selection.provider,
        backendType: selection.backendType,
        runtime: selection.runtime,
        executionMode: 'ephemeral_session_fallback',
        session: {
          id: sessionResult.id,
          sessionName: sessionResult.sessionName,
        },
        task: taskResult,
      };
      throw error;
    } finally {
      try {
        await request(`${sessionBasePath(selection.backendType)}/${encodeURIComponent(sessionResult.id)}`, {
          method: 'DELETE',
        });
      } catch {
        // Best effort cleanup.
      }
    }
  }

  return {
    listProviders,
    listMcpServers,
    listPromptProfiles,
    listLaunchSkills,
    createInteractiveSession,
    createInteractiveSessionIdempotent,
    runOneOffTask,
  };
}

export async function agentInterfacePlugin(app, opts = {}) {
  const requestImpl = buildInProcessFastifyRequest({
    app,
    buildHeaders: () => buildInternalBypassHeaders(),
  });

  const idempotencyStore = opts.idempotencyStore || buildAgentSessionIdempotencyStore({ env: opts.env || process.env });
  const api = buildAgentInterface({
    requestImpl,
    getPreferences: opts.getPreferences || getAgentProviderPreferences,
    idempotencyStore,
    idempotencyTtlMs: opts.idempotencyTtlMs || config.agentInterface.sessionIdempotencyTtlMs,
    now: opts.now || (() => Date.now()),
    sessionExistsImpl: opts.sessionExistsImpl,
    worktreeCreator: opts.worktreeCreator,
    worktreeBaseDir: opts.worktreeBaseDir || config.agentInterface.worktreeBaseDir,
  });

  app.addHook('onClose', async () => {
    if (typeof idempotencyStore.close === 'function') await idempotencyStore.close();
  });

  app.get('/api/agents/providers', async () => api.listProviders());
  app.get('/api/agents/mcp-servers', async () => api.listMcpServers());
  app.get('/api/agents/prompt-profiles', async () => api.listPromptProfiles());
  app.get('/api/agents/skills', async () => api.listLaunchSkills());

  app.post('/api/agents/sessions', async (req, reply) => {
    try {
      return await api.createInteractiveSessionIdempotent({
        ...(req.body || {}),
        _serverAuthContext: req.duenoAuth || null,
      });
    } catch (error) {
      return reply.code(error.statusCode || 500).send({
        error: error.message,
        code: error.code || error.payload?.code || null,
      });
    }
  });

  app.post('/api/agents/tasks', async (req, reply) => {
    try {
      return await api.runOneOffTask(req.body || {});
    } catch (error) {
      return reply.code(error.statusCode || 500).send({
        error: error.message,
        code: error.code || error.payload?.code || null,
        execution: error.taskExecution || null,
      });
    }
  });
}
