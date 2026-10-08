import { randomBytes } from 'node:crypto';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { legacyRootStatePath, runtimeStatePath } from '../ops/runtime-state.mjs';
import { normalizeMcpCapabilityRequest } from './mcp-capability-resolver.mjs';
import {
  COORDINATOR_POLICY_METADATA_KEY,
  stripReservedCoordinatorMetadata,
} from '../agent-bus/coordinator-policy.mjs';

const DEFAULT_STORE_FILE = runtimeStatePath('scheduled_agents.json');
const LEGACY_STORE_FILE = legacyRootStatePath('scheduled_agents.json');
const MIN_INTERVAL_SECONDS = 15;
const INJECT_SESSION_KINDS = new Set(['claude', 'codex', 'pi']);
const MAX_INTERVAL_SECONDS = 1296000;
const DEFAULT_RUN_CLAIM_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_SESSION_GRACE_MS = 60 * 1000;
// Pane-derived session state is unreliable in the "looks busy" direction, so a live
// previous session may suppress at most this many consecutive ticks before the pump
// spawns anyway. 0 disables the cap and restores unbounded skipping.
const DEFAULT_MAX_CONSECUTIVE_SKIPS = 3;

function normalizeText(value) {
  return String(value || '').trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeInt(value, fallback = 0, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  const parsed = Number.isInteger(number) ? number : fallback;
  return Math.min(Math.max(parsed, min), max);
}

function newScheduledAgentId() {
  return `sched_${randomBytes(6).toString('hex')}`;
}

export function normalizeScheduledAgent(input = {}, { nowMs = Date.now() } = {}) {
  const type = normalizeText(input.type) || 'spawn';
  if (!['spawn', 'inject'].includes(type)) {
    const error = new Error('scheduled agent type must be spawn or inject');
    error.code = 'scheduled_agent_type_invalid';
    throw error;
  }
  const workDir = normalizeText(input.workDir ?? input.work_dir);
  if (type === 'spawn' && !workDir) {
    const error = new Error('scheduled agent workDir is required');
    error.code = 'scheduled_agent_workdir_required';
    throw error;
  }
  const prompt = normalizeText(input.prompt);
  if (!prompt) {
    const error = new Error('scheduled agent prompt is required');
    error.code = 'scheduled_agent_prompt_required';
    throw error;
  }
  const intervalSeconds = normalizeInt(
    input.intervalSeconds ?? input.interval_seconds,
    MIN_INTERVAL_SECONDS,
    { min: MIN_INTERVAL_SECONDS, max: MAX_INTERVAL_SECONDS },
  );
  const startImmediately = input.startImmediately ?? input.start_immediately;
  const createdAt = normalizeMs(input.createdAt ?? input.created_at) || nowMs;
  const currentIteration = normalizeInt(
    input.currentIteration ?? input.current_iteration,
    0,
    { min: 0 },
  );
  const existingNextRunAt = normalizeMs(input.nextRunAtEpochMs ?? input.next_run_at_epoch_ms);
  const nextRunAtEpochMs = existingNextRunAt || (
    startImmediately === false ? nowMs + intervalSeconds * 1000 : nowMs
  );
  const requestedMcpProfile = normalizeText(input.mcpProfile);
  const normalizedMcp = type === 'spawn' ? normalizeMcpCapabilityRequest({
    ...(requestedMcpProfile ? { mcpProfile: requestedMcpProfile } : {}),
    ...(input.mcpServers !== undefined ? { mcpServers: input.mcpServers } : {}),
  }) : null;
  const targetSession = type === 'inject' ? {
    kind: normalizeText(input.targetSession?.kind ?? input.target_session?.kind).toLowerCase(),
    sessionId: normalizeText(
      input.targetSession?.sessionId
      ?? input.targetSession?.session_id
      ?? input.target_session?.sessionId
      ?? input.target_session?.session_id,
    ),
  } : null;
  if (type === 'inject' && (!targetSession.kind || !targetSession.sessionId)) {
    const error = new Error('inject scheduled agent targetSession kind and sessionId are required');
    error.code = 'scheduled_agent_target_required';
    throw error;
  }
  if (type === 'inject' && !INJECT_SESSION_KINDS.has(targetSession.kind)) {
    const error = new Error('inject scheduled agent targetSession kind must be claude, codex, or pi');
    error.code = 'scheduled_agent_target_kind_invalid';
    throw error;
  }
  const rawMaxIterations = input.maxIterations ?? input.max_iterations;
  if (type === 'inject' && (!Number.isInteger(Number(rawMaxIterations)) || Number(rawMaxIterations) < 1 || Number(rawMaxIterations) > 100)) {
    const error = new Error('inject scheduled agent maxIterations must be an integer from 1 to 100');
    error.code = 'scheduled_agent_max_iterations_invalid';
    throw error;
  }

  return {
    id: normalizeText(input.id) || newScheduledAgentId(),
    type,
    ...(type === 'spawn' ? {
      workDir,
      provider: normalizeText(input.provider) || 'codex',
      model: normalizeText(input.model) || null,
      mcpProfile: normalizedMcp.profileProvided ? normalizedMcp.mcpProfile : null,
      mcpServers: {
        add: [...normalizedMcp.mcpServers.add],
        remove: [...normalizedMcp.mcpServers.remove],
      },
    } : { targetSession }),
    prompt,
    intervalSeconds,
    maxIterations: normalizeInt(
      rawMaxIterations,
      0,
      { min: 0, max: type === 'inject' ? 100 : Number.MAX_SAFE_INTEGER },
    ),
    parentThreadId: normalizeText(input.parentThreadId ?? input.parent_thread_id) || null,
    status: normalizeScheduledAgentStatus(input.status),
    currentIteration,
    nextRunAtEpochMs,
    lastSessionId: normalizeText(input.lastSessionId ?? input.last_session_id) || null,
    lastSpawnAtEpochMs: normalizeMs(input.lastSpawnAtEpochMs ?? input.last_spawn_at_epoch_ms),
    consecutiveSkips: normalizeInt(input.consecutiveSkips ?? input.consecutive_skips, 0, { min: 0 }),
    ...(type === 'inject' ? {
      tickLog: normalizeTickLog(input.tickLog ?? input.tick_log),
      stopReason: normalizeText(input.stopReason ?? input.stop_reason) || null,
    } : {}),
    metadata: normalizeMetadata(input.metadata),
    createdAt,
    updatedAt: normalizeMs(input.updatedAt ?? input.updated_at) || nowMs,
  };
}

export function buildScheduledAgentStore({
  storeFile = DEFAULT_STORE_FILE,
  namespace = 'scheduled_agents',
  stateStore,
  env = process.env,
  modeEnvKey = 'APP_STATE_STORAGE',
  now = () => Date.now(),
} = {}) {
  const backingStore = stateStore || buildPostgresJsonStore({
    namespace,
    filePath: storeFile,
    legacyFilePath: storeFile === DEFAULT_STORE_FILE ? LEGACY_STORE_FILE : undefined,
    env,
    modeEnvKey,
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
    const snapshot = clone(state);
    const write = saveQueue.catch(() => {}).then(() => backingStore.save(snapshot));
    saveQueue = write.catch(() => {});
    await write;
  }

  async function register(input = {}) {
    await load();
    const nowMs = now();
    const agent = normalizeScheduledAgent(input, { nowMs });
    const prior = state.agents[agent.id];
    state.agents[agent.id] = {
      ...agent,
      createdAt: prior?.createdAt || agent.createdAt,
      updatedAt: nowMs,
    };
    await save();
    return clone(state.agents[agent.id]);
  }

  async function update(id, patch = {}) {
    await load();
    const agentId = normalizeText(id);
    const prior = state.agents[agentId];
    if (!prior) return null;
    const nowMs = normalizeMs(patch.updatedAt ?? patch.updated_at) || now();
    const next = normalizeScheduledAgent({ ...prior, ...patch, id: agentId }, { nowMs });
    state.agents[agentId] = {
      ...next,
      createdAt: prior.createdAt || next.createdAt,
      updatedAt: nowMs,
    };
    await save();
    return clone(state.agents[agentId]);
  }

  async function claimRun(id, {
    expectedNextRunAtEpochMs = 0,
    nowMs = now(),
    leaseMs = DEFAULT_RUN_CLAIM_LEASE_MS,
    metadata = undefined,
  } = {}) {
    const agentId = normalizeText(id);
    const applyClaim = (rawState = {}) => {
      const nextState = normalizeStoreState(rawState || {});
      const prior = nextState.agents[agentId];
      if (!prior || prior.status !== 'active') return { state: nextState, result: null };
      if (Number(prior.nextRunAtEpochMs || 0) !== Number(expectedNextRunAtEpochMs || 0)) return { state: nextState, result: null };
      if (Number(prior.nextRunAtEpochMs || 0) > nowMs) return { state: nextState, result: null };

      const priorClaim = prior.metadata?.runClaim;
      if (priorClaim?.leaseId && Number(priorClaim.expiresAtEpochMs || 0) > nowMs) return { state: nextState, result: null };

      const leaseId = `claim_${randomBytes(6).toString('hex')}`;
      const nextMetadata = {
        ...(metadata && typeof metadata === 'object' ? clone(metadata) : normalizeMetadata(prior.metadata)),
        runClaim: {
          leaseId,
          claimedAtEpochMs: nowMs,
          expiresAtEpochMs: nowMs + Math.max(1000, Number(leaseMs) || DEFAULT_RUN_CLAIM_LEASE_MS),
          iteration: prior.currentIteration + 1,
          originalNextRunAtEpochMs: prior.nextRunAtEpochMs,
        },
      };
      const next = normalizeScheduledAgent({
        ...prior,
        metadata: nextMetadata,
        updatedAt: nowMs,
      }, { nowMs });
      nextState.agents[agentId] = {
        ...next,
        createdAt: prior.createdAt || next.createdAt,
        updatedAt: nowMs,
      };
      return {
        state: nextState,
        result: {
          task: clone(nextState.agents[agentId]),
          leaseId,
          original: clone(prior),
        },
      };
    };

    if (typeof backingStore.mutate === 'function') {
      await saveQueue.catch(() => {});
      const result = await backingStore.mutate((rawState) => {
        const mutation = applyClaim(rawState);
        return { data: mutation.state, result: mutation.result };
      });
      state = normalizeStoreState(await backingStore.load().catch(() => null) || state);
      loaded = true;
      return result;
    }

    await load();
    const mutation = applyClaim(state);
    state = mutation.state;
    if (mutation.result) await save();
    return mutation.result;
  }

  async function list() {
    await load();
    return Object.values(state.agents)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(clone);
  }

  async function get(id) {
    await load();
    const agent = state.agents[normalizeText(id)];
    return agent ? clone(agent) : null;
  }

  async function cancel(id) {
    return update(id, { status: 'canceled' });
  }

  async function remove(id) {
    await load();
    const agentId = normalizeText(id);
    const existing = state.agents[agentId];
    if (!existing) return null;
    delete state.agents[agentId];
    await save();
    return clone(existing);
  }

  async function close() {
    await saveQueue.catch(() => {});
    if (typeof backingStore.close === 'function') await backingStore.close();
  }

  return { register, list, get, update, claimRun, cancel, remove, close };
}

export async function stepDue(nowMs = Date.now(), {
  store,
  sessionLauncher,
  lookupSessionState,
  shouldLaunchTask,
  idleSessionGraceMs = DEFAULT_IDLE_SESSION_GRACE_MS,
  maxConsecutiveSkips = DEFAULT_MAX_CONSECUTIVE_SKIPS,
  logger = null,
} = {}) {
  const tasks = [];
  const summary = {
    checked: 0,
    spawned: 0,
    injected: 0,
    skippedRunning: 0,
    completed: 0,
    tasks,
  };
  const all = store?.list ? await store.list() : [];
  const due = all
    .filter((task) => task.status === 'active' && Number(task.nextRunAtEpochMs || 0) <= nowMs)
    .sort((a, b) => Number(a.nextRunAtEpochMs || 0) - Number(b.nextRunAtEpochMs || 0));
  summary.checked = due.length;

  for (const task of due) {
    if (task.maxIterations > 0 && task.currentIteration >= task.maxIterations) {
      const updated = await store.update(task.id, { status: 'completed', updatedAt: nowMs });
      summary.completed += 1;
      tasks.push({ id: task.id, action: 'completed', task: updated });
      continue;
    }

    let launchOverLiveSession = '';
    if (task.type === 'spawn' && task.lastSessionId) {
      const state = typeof lookupSessionState === 'function'
        ? await lookupSessionState(task.lastSessionId)
        : { state: 'unknown' };
      if (sessionBlocksNextRun(state, { nowMs, idleSessionGraceMs, task })) {
        const skips = normalizeInt(task.consecutiveSkips, 0, { min: 0 }) + 1;
        const capped = maxConsecutiveSkips > 0 && skips > maxConsecutiveSkips;
        if (!capped) {
          const nextRunAtEpochMs = advanceNextRunAt(task, nowMs);
          const updated = await store.update(task.id, {
            nextRunAtEpochMs,
            consecutiveSkips: skips,
            updatedAt: nowMs,
          });
          summary.skippedRunning += 1;
          tasks.push({ id: task.id, action: 'skippedRunning', task: updated });
          continue;
        }
        launchOverLiveSession = 'skipCap';
      } else if (!isTerminalSessionState(state)) {
        launchOverLiveSession = 'idle';
      }
      if (launchOverLiveSession && logger?.warn) {
        logger.warn(
          { taskId: task.id, sessionId: task.lastSessionId, reason: launchOverLiveSession },
          'Scheduled agent starting next tick while the previous session is still alive',
        );
      }
    }

    const claim = typeof store.claimRun === 'function'
      ? await store.claimRun(task.id, {
        expectedNextRunAtEpochMs: task.nextRunAtEpochMs,
        nowMs,
      })
      : null;
    if (!claim && typeof store.claimRun === 'function') {
      const current = await store.get?.(task.id);
      tasks.push({ id: task.id, action: task.type === 'inject' ? 'skipped_claim' : 'claimSkipped', task: current });
      continue;
    }

    const claimedTask = claim?.task || task;
    const claimMetadata = normalizeMetadata(claimedTask.metadata);
    delete claimMetadata.runClaim;

    try {
      const injectDecision = task.type === 'inject'
        ? await shouldLaunchInjectTask(task, { nowMs, lookupSessionState })
        : null;
      if (injectDecision?.stopReason) {
        delete claimMetadata.runClaim;
        const updated = await store.update(task.id, {
          status: 'completed',
          stopReason: injectDecision.stopReason,
          tickLog: appendTick(task, nowMs, 'failed', injectDecision.error),
          metadata: claimMetadata,
          updatedAt: nowMs,
        });
        summary.completed += 1;
        tasks.push({ id: task.id, action: 'failed', task: updated });
        continue;
      }
      if (injectDecision || (task.type === 'spawn' && typeof shouldLaunchTask === 'function')) {
        const decision = injectDecision || await shouldLaunchTask({ ...task, metadata: claimMetadata }, { nowMs });
        if (decision?.launch === false) {
          const decisionMetadata = decision.metadata ?? claimMetadata;
          delete decisionMetadata.runClaim;
          const nextRunAtEpochMs = Number(decision.nextRunAtEpochMs || 0) || advanceNextRunAt(task, nowMs);
          const updated = await store.update(task.id, {
            nextRunAtEpochMs,
            ...(task.type === 'inject' ? {
              tickLog: appendTick(task, nowMs, decision.action, decision.error),
            } : {}),
            metadata: decisionMetadata,
            updatedAt: nowMs,
          });
          tasks.push({ id: task.id, action: normalizeText(decision.action) || 'skipped', task: updated });
          continue;
        }
        if (decision?.metadata) Object.assign(claimMetadata, normalizeMetadata(decision.metadata));
      }
    } catch (error) {
      if (claim) {
        await store.update(task.id, {
          nextRunAtEpochMs: claim.original.nextRunAtEpochMs,
          metadata: claimMetadata,
          updatedAt: nowMs,
        }).catch(() => {});
      }
      throw error;
    }

    if (typeof sessionLauncher !== 'function') {
      if (claim) {
        await store.update(task.id, {
          nextRunAtEpochMs: claim.original.nextRunAtEpochMs,
          metadata: claimMetadata,
          updatedAt: nowMs,
        }).catch(() => {});
      }
      const error = new Error('scheduled agent sessionLauncher is required');
      error.code = 'scheduled_agent_launcher_required';
      throw error;
    }

    const nextIteration = task.currentIteration + 1;
    let session;
    try {
      session = await sessionLauncher(task.type === 'inject' ? {
        type: 'inject',
        prompt: task.prompt,
        targetSession: task.targetSession,
        taskId: task.id,
      } : {
        prompt: task.prompt,
        workDir: task.workDir,
        provider: task.provider,
        model: task.model,
        displayName: `Scheduled ${task.id} #${nextIteration}`,
        parentThreadId: task.parentThreadId,
        taskId: task.id,
        ...(claimMetadata[COORDINATOR_POLICY_METADATA_KEY]
          ? { trustedCoordinatorMetadata: { [COORDINATOR_POLICY_METADATA_KEY]: clone(claimMetadata[COORDINATOR_POLICY_METADATA_KEY]) } }
          : {}),
        ...(task.mcpProfile ? { mcpProfile: task.mcpProfile } : {}),
        ...(
          task.mcpProfile
          || task.mcpServers?.add?.length
          || task.mcpServers?.remove?.length
            ? { mcpServers: task.mcpServers }
            : {}
        ),
      });
    } catch (error) {
      if (task.type === 'inject' || error?.code === 'mcp_invalid_arguments' || error?.statusCode === 400) {
        delete claimMetadata.runClaim;
        if (task.type === 'spawn') {
          claimMetadata.lastError = { code: error?.code || 'invalid_arguments', message: error?.message || 'Launch failed' };
        }
        const updated = await store.update(task.id, {
          nextRunAtEpochMs: advanceNextRunAt(task, nowMs),
          ...(task.type === 'inject' ? { tickLog: appendTick(task, nowMs, 'failed', error?.message) } : {}),
          metadata: claimMetadata,
          updatedAt: nowMs,
        });
        if (task.type === 'spawn' && logger?.warn) {
          logger.warn({ taskId: task.id, ...claimMetadata.lastError }, 'Scheduled agent launch failed');
        }
        tasks.push({ id: task.id, action: 'failed', task: updated });
        continue;
      }
      if (claim) {
        await store.update(task.id, {
          nextRunAtEpochMs: claim.original.nextRunAtEpochMs,
          metadata: claimMetadata,
          updatedAt: nowMs,
        }).catch(() => {});
      }
      throw error;
    }
    applyLauncherSessionMetadata(claimMetadata, session);
    if (isLauncherSkip(session)) {
      tasks.push(await recordLauncherSkip({ store, task, session, claimMetadata, nowMs }));
      continue;
    }
    const status = task.maxIterations > 0 && nextIteration >= task.maxIterations
      ? 'completed'
      : 'active';
    const updated = await store.update(task.id, {
      currentIteration: nextIteration,
      lastSessionId: task.type === 'inject'
        ? task.targetSession.sessionId
        : normalizeText(session?.id || session?.sessionId || session?.participants?.[0]?.session_id) || null,
      lastSpawnAtEpochMs: nowMs,
      consecutiveSkips: 0,
      nextRunAtEpochMs: advanceNextRunAt(task, nowMs),
      status,
      ...(task.type === 'inject' ? { tickLog: appendTick(task, nowMs, 'injected') } : {}),
      metadata: claimMetadata,
      updatedAt: nowMs,
    });
    if (task.type === 'inject') summary.injected += 1;
    else summary.spawned += 1;
    if (status === 'completed') summary.completed += 1;
    tasks.push({
      id: task.id,
      action: task.type === 'inject' ? 'injected' : 'spawned',
      sessionId: updated?.lastSessionId || null,
      ...(launchOverLiveSession ? { launchedOverLiveSession: launchOverLiveSession } : {}),
      task: updated,
    });
  }

  return summary;
}

export class SchedulerLoop {
  constructor({
    config = {},
    store,
    sessionLauncher,
    lookupSessionState,
    shouldLaunchTask,
    now = () => Date.now(),
    logger = null,
  } = {}) {
    this.config = config;
    this.store = store;
    this.sessionLauncher = sessionLauncher;
    this.lookupSessionState = lookupSessionState;
    this.shouldLaunchTask = shouldLaunchTask;
    this.idleSessionGraceMs = resolveIdleSessionGraceMs(config);
    this.maxConsecutiveSkips = resolveMaxConsecutiveSkips(config);
    this.now = now;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  async step() {
    if (this.running) {
      if (this.logger?.warn) this.logger.warn('Scheduled agent loop skipped overlapping tick');
      return {
        checked: 0,
        spawned: 0,
        injected: 0,
        skippedRunning: 0,
        completed: 0,
        skippedOverlap: 1,
        tasks: [],
      };
    }
    this.running = true;
    try {
      return await stepDue(this.now(), {
        store: this.store,
        sessionLauncher: this.sessionLauncher,
        lookupSessionState: this.lookupSessionState,
        shouldLaunchTask: this.shouldLaunchTask,
        idleSessionGraceMs: this.idleSessionGraceMs,
        maxConsecutiveSkips: this.maxConsecutiveSkips,
        logger: this.logger,
      });
    } finally {
      this.running = false;
    }
  }

  start() {
    this.stop();
    if (this.config?.enabled !== true) return;
    const intervalSec = Math.min(Math.max(Number(this.config.tickIntervalSec || 5), 1), 60);
    this.timer = setInterval(() => {
      void this.step().catch((error) => {
        if (this.logger?.warn) this.logger.warn({ code: error?.code || 'unknown', message: error?.message }, 'Scheduled agent loop failed');
      });
    }, intervalSec * 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function advanceNextRunAt(task = {}, nowMs = Date.now()) {
  const intervalMs = normalizeInt(task.intervalSeconds, MIN_INTERVAL_SECONDS, {
    min: MIN_INTERVAL_SECONDS,
    max: MAX_INTERVAL_SECONDS,
  }) * 1000;
  let next = Number(task.nextRunAtEpochMs || 0) + intervalMs;
  while (next <= nowMs) next += intervalMs;
  return next;
}

function normalizeScheduledAgentStatus(value) {
  const status = normalizeText(value) || 'active';
  return ['active', 'canceled', 'completed'].includes(status) ? status : 'active';
}

function normalizeStoreState(raw = {}) {
  const agents = {};
  const source = raw?.agents && typeof raw.agents === 'object' ? raw.agents : {};
  for (const value of Object.values(source)) {
    try {
      const agent = normalizeScheduledAgent(value);
      agents[agent.id] = agent;
    } catch {
      // Ignore malformed persisted rows; route layer can surface validation on writes.
    }
  }
  return { version: 1, agents };
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return clone(value);
}

function normalizeTickLog(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-50).flatMap((entry) => {
    const tickAt = normalizeMs(entry?.tickAt ?? entry?.tick_at);
    const action = normalizeText(entry?.action);
    if (!tickAt || !['injected', 'skipped_busy', 'skipped_claim', 'failed'].includes(action)) return [];
    const error = normalizeText(entry?.error);
    return [{ tickAt, action, ...(error ? { error } : {}) }];
  });
}

function appendTick(task, tickAt, action, error = '') {
  return [...(task.tickLog || []), {
    tickAt,
    action,
    ...(normalizeText(error) ? { error: normalizeText(error) } : {}),
  }].slice(-50);
}

async function shouldLaunchInjectTask(task, { nowMs, lookupSessionState }) {
  let state;
  try {
    state = typeof lookupSessionState === 'function'
      ? await lookupSessionState(task.targetSession.sessionId, task.targetSession.kind)
      : null;
  } catch (error) {
    return { launch: false, action: 'failed', error: error?.message || 'Target state lookup failed' };
  }
  if (state?.lifecycle === 'missing') {
    return {
      launch: false,
      action: 'failed',
      stopReason: 'target_missing',
      error: state.error || `Target ${task.targetSession.kind}:${task.targetSession.sessionId} not found`,
    };
  }
  if (!state) return { launch: false, action: 'failed', error: 'Target state lookup failed' };
  const capabilities = state.capabilities || state.state?.capabilities || {};
  const lifecycle = state.lifecycle || state.state?.lifecycle || '';
  if (lifecycle === 'missing') {
    return {
      launch: false,
      action: 'failed',
      stopReason: 'target_missing',
      error: state.error || `Target ${task.targetSession.kind}:${task.targetSession.sessionId} not found`,
    };
  }
  if (capabilities.canSendNow === true) return { launch: true };
  return { launch: false, action: 'skipped_busy' };
}

function applyLauncherSessionMetadata(claimMetadata, session) {
  if (session?.metadata) {
    Object.assign(claimMetadata, stripReservedCoordinatorMetadata(normalizeMetadata(session.metadata)));
  }
  delete claimMetadata.runClaim;
}

function isLauncherSkip(session) {
  return session?.skip === true || session?.launch === false;
}

async function recordLauncherSkip({ store, task, session, claimMetadata, nowMs }) {
  const updated = await store.update(task.id, {
    nextRunAtEpochMs: Number(session?.nextRunAtEpochMs || 0) || advanceNextRunAt(task, nowMs),
    metadata: claimMetadata,
    updatedAt: nowMs,
  });
  return {
    id: task.id,
    action: normalizeText(session?.action) || 'skipped',
    task: updated,
  };
}

function isTerminalSessionState(value) {
  if (value == null || value === false) return true;
  return value?.status === 'ended' || ['ended', 'missing'].includes(value?.lifecycle);
}

// A scheduled tick is a one-shot prompt: interactive panes stay alive at a free-text
// prompt after the model stops. Those panes are done as far as scheduling is concerned.
export function isIdleSessionState(value) {
  if (!value || typeof value !== 'object') return false;
  if (isTerminalSessionState(value)) return false;
  const source = normalizeText(value.executionSource);
  if (
    normalizeText(value.execution) === 'idle'
    && (source === 'transcript' || source === 'hook')
  ) return true;
  // Fail open when we only have pane facts: a live idle composer is a finished tick.
  return normalizeText(value.lifecycle) === 'running'
    && normalizeText(value.execution) === 'idle'
    && normalizeText(value.interaction?.kind) === 'free_text';
}

export function sessionBlocksNextRun(state, {
  nowMs = Date.now(),
  idleSessionGraceMs = DEFAULT_IDLE_SESSION_GRACE_MS,
  task = {},
} = {}) {
  if (isTerminalSessionState(state)) return false;
  if (!isIdleSessionState(state)) return true;
  // Guard the spawn race: a freshly launched pane reads as idle until the prompt lands.
  // Measured from our own spawn timestamp, never from the snapshot's updatedAt, which
  // tracks when state last *changed as observed* and flaps with observer cadence.
  const spawnedAt = normalizeMs(task?.lastSpawnAtEpochMs);
  if (!spawnedAt) return false;
  return nowMs - spawnedAt < Math.max(Number(idleSessionGraceMs) || 0, 0);
}

export function resolveMaxConsecutiveSkips(config = {}) {
  const value = Number(config?.maxConsecutiveSkips);
  if (!Number.isInteger(value) || value < 0) return DEFAULT_MAX_CONSECUTIVE_SKIPS;
  return value;
}

export function resolveIdleSessionGraceMs(config = {}) {
  const seconds = Number(config?.idleSessionGraceSec);
  if (!Number.isFinite(seconds) || seconds < 0) return DEFAULT_IDLE_SESSION_GRACE_MS;
  return Math.min(seconds, 3600) * 1000;
}
