import { randomBytes, randomUUID } from 'node:crypto';
import { createManagedWorktree, linkManagedWorktreePr, cleanupManagedWorktree, sweepManagedWorktrees } from './managed-worktrees.mjs';
import { listCodexModels } from '../sessions/codex-models.mjs';
import { listProviderModels } from '../sessions/model-catalog.mjs';
import { listPiModels, PI_FALLBACK_MODELS, PI_PROVIDER_DEFINITIONS } from '../sessions/pi-model-catalog.mjs';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CODEX_MODEL } from '../sessions/provider-models.mjs';
import { renderCollabStartupPrompt } from './protocol.mjs';
import { collectReplayEligibleDeliveriesFromStore } from './replay-eligible.mjs';
import { isDurableTaskRecord } from '../sessions/task-record.mjs';

const ID_MAX = 240;
const BODY_MAX = 200000;
const string = (maxLength = ID_MAX, minLength = 0) => ({ type: 'string', minLength, maxLength });
const agentRef = { type: 'object', required: ['kind', 'sessionId'], additionalProperties: true,
  properties: { kind: string(ID_MAX, 1), sessionId: string(ID_MAX, 1) } };
const bodySchema = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });
const params = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const limit = { anyOf: [{ type: 'integer', minimum: 0, maximum: 500 }, { type: 'string', pattern: '^\\d{1,3}$' }] };
const query = (properties, required = []) => ({ type: 'object', additionalProperties: false, required, properties });

export async function buildAgentModelCatalog({ listCodexModelsImpl = listCodexModels,
  listProviderModelsImpl = listProviderModels, listPiModelsImpl = listPiModels, logger = null } = {}) {
  const [codex, claude, pi] = await Promise.allSettled([
    listCodexModelsImpl(), listProviderModelsImpl('anthropic'), listPiModelsImpl(),
  ]);
  const failures = [codex, claude, pi].filter((item) => item.status === 'rejected').map((item) => item.reason?.message || 'discovery failed');
  if (failures.length) logger?.warn?.(`agent-bus model catalog partial failure: ${failures.join('; ')}`);
  const codexModels = codex.status === 'fulfilled' ? codex.value || [] : [];
  const claudeModels = claude.status === 'fulfilled' ? claude.value?.models || [] : [];
  const piCatalog = pi.status === 'fulfilled' ? pi.value || {} : {};
  const models = { codex: codexModels, claude: claudeModels, ...(piCatalog.models || {}) };
  const providers = [...(piCatalog.providers || [])];
  const xai = PI_PROVIDER_DEFINITIONS.xai;
  if (!models.xai?.length) models.xai = [...PI_FALLBACK_MODELS.xai];
  if (!providers.some((item) => item.id === 'xai')) providers.push(xai);
  const defaultModel = (items, fallback = '') => {
    const ids = new Set((items || []).map((entry) => entry?.id).filter(Boolean));
    if (fallback && ids.has(fallback)) return fallback;
    return (items || [])[0]?.id || fallback;
  };
  return { providers: [
    { id: 'codex', label: 'Codex', backendType: 'codex', runtime: 'codex', sessionKind: 'codex', defaultModel: defaultModel(codexModels, DEFAULT_CODEX_MODEL) },
    { id: 'claude', label: 'Claude', backendType: 'claude', runtime: 'claude', sessionKind: 'claude', defaultModel: defaultModel(claudeModels, DEFAULT_CLAUDE_MODEL) },
    ...providers.map((item) => ({ ...item, backendType: 'pi', runtime: 'pi', sessionKind: 'pi',
      defaultModel: defaultModel(models[item.id] || [], item.defaultModel) })),
  ], models };
}

function dmKey(left, right) {
  return [ `${left.kind}:${left.sessionId}`, `${right.kind}:${right.sessionId}` ].sort().join('|');
}
function isDashboardUser(ref) {
  return ref?.kind === 'user' && ref?.sessionId === 'dashboard';
}
function threadMatchesQuery(snapshot, needle) {
  const thread = snapshot?.thread || {};
  const haystack = [
    thread.id, thread.title, thread.projectKey, thread.status,
    ...(thread.participants || []).flatMap((item) => [item.kind, item.sessionId, item.display_name, item.session_name]),
    ...(snapshot?.messages || []).map((item) => item.body),
  ].join(' ').toLowerCase();
  return haystack.includes(needle);
}

function createdByFromRequest(req) {
  const principal = req?.duenoAuth?.principal;
  if (!principal?.kind || !principal.sessionId) return null;
  return { kind: String(principal.kind), sessionId: String(principal.sessionId) };
}

export function registerAgentBusRoutes({ app, store, adapters, wsManager, productionControls, observedSessions, deliveryInFlight,
  broadcast, broadcastAlert, broadcastThreadSnapshot, broadcastThreadSummary, enrichThread, normalizeThreadSummary,
  threadMatchesStatusFilter, buildStateSnapshotEntry, normalizeCollectionLimit, participantKey, participantRef,
  threadHasParticipant, threadHasOwner, uniqueAgentRefs, isAgentRef, pruneObservedParticipant, planParticipant, executeParticipantPlan,
  discardCreatedParticipants, waitForSessionReady, injectBootstrapStartupText, createBootstrapMessage,
  deliverMessage, failDelivery, replayDelivery, taskService = null, managedWorktreeBaseDir }) {
  const endingThreads = new Set();
  async function cleanupWorktree(metadata, spawnFailed = false) {
    try {
      const sessions = [];
      for (const adapter of Object.values(adapters)) for (const summary of await adapter.listSessions(app)) {
        if (summary.lifecycle === 'ended') continue;
        if (summary.lifecycle === 'interrupted') {
          if (!summary.workDir) throw new Error('interrupted session working directory unknown');
          sessions.push(summary); continue;
        }
        try {
          const session = await adapter.getSession(app, summary.id || summary.sessionId);
          const workDir = session.workDir || session.session?.workDir;
          if (!workDir) throw new Error('live session working directory unknown');
          sessions.push({ workDir });
        } catch (error) { if (error.statusCode !== 404) throw error; }
      }
      return cleanupManagedWorktree(metadata, { rooms: store.listThreads(), sessions, baseDir: managedWorktreeBaseDir, spawnFailed,
        getPr: (value) => app.agentBusLifecycle.getWorktreePr?.(value) });
    } catch (error) { return { removed: false, reason: error.message, report: `worktree: kept (${error.message})` }; }
  }
  app.agentBusLifecycle.sweepWorktrees = () => sweepManagedWorktrees({
    baseDir: managedWorktreeBaseDir, getRoom: (id) => store.getThread(id)?.thread, cleanup: cleanupWorktree, log: app.log,
  });
  async function sessionExists(ref) {
    if (!adapters[ref?.kind]) return true;
    try { await adapters[ref.kind].getSession(app, ref.sessionId); return true; }
    catch (err) { if (err.statusCode === 404) return false; throw err; }
  }

  async function authorizeLifecycle(req, thread, action) {
    if (req.duenoAuth?.principal?.type !== 'agent' || threadHasOwner(thread, createdByFromRequest(req))) return;
    if (action === 'transfer' && participantKey(req.body.to) === participantKey(createdByFromRequest(req))
      && thread.createdBy && !await sessionExists(thread.createdBy)) return;
    if (action === 'close' && (!thread.metadata?.dm || threadHasParticipant(thread, createdByFromRequest(req)))) return;
    throw Object.assign(new Error('Room ownership required'), { statusCode: 403, code: 'room_owner_required' });
  }

  app.post('/api/agent-bus/threads/:threadId/transfer', { schema: { params: params({ threadId: string(ID_MAX, 1) }),
    body: bodySchema({ to: agentRef }, ['to']) } }, async (req, reply) => {
    const snapshot = store.getThread(req.params.threadId);
    if (!snapshot) return reply.code(404).send({ error: 'Thread not found' });
    await authorizeLifecycle(req, snapshot.thread, 'transfer');
    if (!adapters[req.body.to.kind] || !await sessionExists(req.body.to)) {
      return reply.code(400).send({ error: 'Owner must be an existing agent session' });
    }
    const thread = await store.transferThread(snapshot.thread.id, req.body.to);
    await broadcastThreadSummary(thread.id);
    return { thread: normalizeThreadSummary(await enrichThread(thread)) };
  });

  app.get('/api/agent-bus/participants', async (_req, reply) => {
    const supportedKinds = Object.keys(adapters);
    const sessions = {};
    for (const kind of supportedKinds) {
      try { sessions[kind] = await adapters[kind].listSessions(app); }
      catch (err) {
        sessions[kind] = [];
        reply.log?.warn?.(`agent-bus participant list failed for ${kind}: ${err.message}`);
      }
    }
    return { supportedKinds, sessions };
  });

  app.get('/api/agent-bus/model-catalog', async () => buildAgentModelCatalog({ logger: app.log }));

  app.get('/api/agent-bus/threads', { schema: { querystring: query({ status: string(), projectKey: string(4096), q: string(512) }) } },
    async (req) => {
      const found = [];
      const needle = String(req.query?.q || '').toLowerCase();
      for (const thread of store.listThreads({ projectKey: req.query?.projectKey || undefined })) {
        const enriched = thread.status === 'open' || req.query?.status === 'stale'
          ? await enrichThread(thread, store.getThread(thread.id))
          : thread;
        if (!threadMatchesStatusFilter(enriched, req.query?.status)) continue;
        if (needle && !threadMatchesQuery(store.getThread(thread.id), needle)) continue;
        found.push(normalizeThreadSummary(enriched));
      }
      return { threads: found };
    });

  app.get('/api/agent-bus/threads/by-participant', { schema: { querystring: query({
    kind: string(ID_MAX, 1), sessionId: string(ID_MAX, 1), projectKey: string(4096), status: string(),
  }, ['kind', 'sessionId']) } }, async (req) => {
    const ref = { kind: req.query.kind, sessionId: req.query.sessionId };
    const threads = [];
    for (const thread of store.listThreads({ projectKey: req.query.projectKey || undefined })) {
      if (!threadHasParticipant(thread, ref) && !threadHasOwner(thread, ref)) continue;
      const enriched = thread.status === 'open' || req.query.status === 'stale'
        ? await enrichThread(thread, store.getThread(thread.id))
        : thread;
      if (threadMatchesStatusFilter(enriched, req.query.status)) threads.push(normalizeThreadSummary(enriched));
    }
    return { threads };
  });

  app.get('/api/agent-bus/state', { schema: { querystring: query({ kind: string(), sessionId: string(),
    projectKey: string(4096), status: string(), includeMessages: { enum: ['true', 'false'] },
    includeDeliveries: { enum: ['true', 'false'] }, messageLimit: limit, deliveryLimit: limit }) } }, async (req) => {
    const entries = [];
    const includeMessages = req.query.includeMessages !== 'false';
    const includeDeliveries = req.query.includeDeliveries !== 'false';
    for (const thread of store.listThreads({ projectKey: req.query.projectKey || undefined })) {
      if (req.query.kind && (!req.query.sessionId || !threadHasParticipant(thread, req.query))) continue;
      const snapshot = store.getThread(thread.id);
      const enriched = thread.status === 'open' || req.query.status === 'stale'
        ? await enrichThread(thread, snapshot)
        : thread;
      if (!threadMatchesStatusFilter(enriched, req.query.status)) continue;
      entries.push(buildStateSnapshotEntry(snapshot, enriched, { includeMessages, includeDeliveries,
        messageLimit: normalizeCollectionLimit(req.query.messageLimit, 10),
        deliveryLimit: normalizeCollectionLimit(req.query.deliveryLimit, 10) }));
    }
    return { threads: entries };
  });

  app.post('/api/agent-bus/threads', { schema: { body: bodySchema({ title: string(240), projectKey: string(4096),
    participants: { type: 'array', minItems: 2, maxItems: 24, items: agentRef }, metadata: { type: 'object' } },
  ['participants']) } }, async (req, reply) => {
    if (isDurableTaskRecord(req.body.metadata?.task)) {
      return reply.code(400).send({ error: 'Durable task records must be created through task_spawn', code: 'task_metadata_reserved' });
    }
    const participants = uniqueAgentRefs(req.body.participants);
    if (participants.length < 2) return reply.code(400).send({ error: 'At least two unique participants are required' });
    const thread = await store.createThread({ title: req.body.title, projectKey: req.body.projectKey,
      participants, metadata: req.body.metadata, createdBy: createdByFromRequest(req) });
    participants.forEach((item) => observedSessions.add(participantKey(item)));
    return { thread: normalizeThreadSummary(await enrichThread(thread)) };
  });

  app.post('/api/agent-bus/threads/:threadId/participants', { schema: { params: params({ threadId: string(ID_MAX, 1) }),
    body: bodySchema({ participant: agentRef }, ['participant']) } }, async (req, reply) => {
    const thread = await store.addThreadParticipant(req.params.threadId, req.body.participant);
    if (!thread) return reply.code(404).send({ error: 'Thread not found' });
    observedSessions.add(participantKey(req.body.participant));
    return { thread: normalizeThreadSummary(await enrichThread(thread)) };
  });

  app.post('/api/agent-bus/bootstrap', async (req, reply) => {
    const requested = Array.isArray(req.body?.participants) ? req.body.participants : [];
    if (requested.length < 2) return reply.code(400).send({ error: 'At least two participants are required' });
    const created = [];
    let worktree = null;
    let thread = null;
    const roomId = `thr_${randomUUID().replaceAll('-', '')}`;
    try {
      if (req.body.worktree && requested.some((p) => p.sessionId || p.create === false)) throw new Error('managed worktrees require newly created participants');
      const plans = [];
      for (const participant of requested) plans.push(await planParticipant(participant, req.body.workDir || '', {
        model: req.body.model, thinkingLevel: req.body.thinkingLevel, mcpProfile: req.body.mcpProfile,
        mcpServers: req.body.mcpServers, codexPlugins: req.body.codexPlugins,
        promptProfile: req.body.promptProfile, requireDueno: true, structured: req.body.structured === true,
        ...(req.body.sandbox !== undefined ? { sandbox: req.body.sandbox } : {}),
      }));
      if (req.body.worktree) worktree = await createManagedWorktree({ ...req.body.worktree, roomId, baseDir: managedWorktreeBaseDir });
      const roster = plans.map((plan) => plan.mode === 'attach' ? plan.participant : {
        kind: plan.resolvedSelection.backendType, sessionId: randomBytes(4).toString('hex'),
        displayName: plan.createArgs.displayName,
      });
      const prompts = roster.map((participant, index) => renderCollabStartupPrompt({
        self: { ...participant, role: requested[index]?.role }, participants: roster,
        threadId: roomId, title: req.body.title, initialTask: req.body.initialTask,
        participantTask: requested[index]?.initialTask,
      }));
      thread = await store.createThread({ id: roomId, title: req.body.title, projectKey: req.body.projectKey,
        participants: roster.map(participantRef), metadata: { source: 'bootstrap', ...(worktree ? { worktree } : {}) },
        createdBy: createdByFromRequest(req) });
      const records = [];
      for (let index = 0; index < plans.length; index += 1) {
        if (plans[index].mode === 'create') records[index] = await createBootstrapMessage({
          threadId: thread.id, participant: roster[index], body: prompts[index], deliveryStatus: 'injected',
        });
      }
      for (let index = 0; index < plans.length; index += 1) {
        const plan = plans[index];
        if (worktree && plan.mode === 'create') plan.createArgs.workDir = worktree.path;
        if (plan.mode === 'create') {
          plan.createArgs.sessionId = roster[index].sessionId;
          plan.createArgs.initialPrompt = prompts[index];
        }
        created.push(await executeParticipantPlan(plan).catch((err) => {
          err.message = `Participant ${plan.resolvedSelection?.backendType || plan.participant?.kind}: ${err.message}`;
          throw err;
        }));
        if (plan.mode === 'create' && created.at(-1).sessionId !== roster[index].sessionId) throw new Error(`Participant ${roster[index].kind}: create ignored reserved sessionId`);
      }
      const messages = []; const deliveries = [];
      for (let index = 0; index < created.length; index += 1) {
        const participant = created[index];
        const prompt = prompts[index];
        const record = records[index] || await createBootstrapMessage({ threadId: thread.id, participant, body: prompt });
        let delivery = record.deliveries[0];
        try {
          let result;
          if (plans[index].createArgs?.initialPrompt) {
            result = { attempts: 0, resolution: { channel: 'launch' } };
          } else {
            await waitForSessionReady(participant.kind, participant.sessionId);
            result = await injectBootstrapStartupText(adapters[participant.kind], app, participant, prompt);
          }
          delivery = await store.updateDelivery(delivery.id, { status: 'injected', attempts: result.attempts,
            lastAttemptAt: Date.now(), resolution: result.resolution, error: null });
        } catch (err) {
          delivery = await store.updateDelivery(delivery.id, { status: 'failed', attempts: Number(err.bootstrapStartupAttempts || 1),
            lastAttemptAt: Date.now(), error: err.message });
          throw new Error(`Participant ${participantKey(participant)} failed bootstrap: ${err.message}`);
        }
        observedSessions.add(participantKey(participant)); messages.push(record.message); deliveries.push(delivery);
      }
      return { thread: normalizeThreadSummary(await enrichThread(thread, store.getThread(thread.id))), participants: created,
        messages, deliveries, bootstrapOk: true, warnings: [] };
    } catch (err) {
      if (thread) {
        await store.closeThread(thread.id, err.message);
        thread.participants.forEach(pruneObservedParticipant);
      }
      const cleanupFailures = await discardCreatedParticipants(created);
      if (cleanupFailures?.length) err.message += `; session rollback failed: ${cleanupFailures.join('; ')}`;
      const result = worktree ? await cleanupWorktree(worktree, true) : undefined;
      if (thread) await broadcastThreadSummary(thread.id);
      return reply.code(400).send({ ...(result ? { worktree: result } : {}), error: err.message, ...(err.rollbackError ? { rollbackError: err.rollbackError, worktree: { removed: false, report: `worktree: kept (${err.rollbackError})` } } : {}), ...(err.code ? { code: err.code } : {}) });
    }
  });

  app.get('/api/agent-bus/threads/:threadId', { schema: { params: params({ threadId: string(ID_MAX, 1) }),
    querystring: query({ messageLimit: limit, deliveryLimit: limit }) } }, async (req, reply) => {
    const snapshot = store.getThread(req.params.threadId); if (!snapshot) return reply.code(404).send({ error: 'Thread not found' });
    const enriched = await enrichThread(snapshot.thread, snapshot);
    // Scope checks request metadata only. A handshake needs an actual content read
    // by this task's authenticated child, never an internal access lookup.
    if (taskService && isDurableTaskRecord(snapshot.thread.metadata?.task) && req.duenoAuth?.authenticated
      && req.duenoAuth.source === 'agent_bus_mcp' && req.duenoAuth.taskRoomRead === true && Number(req.query.messageLimit) > 0) {
      const principal = req.duenoAuth.principal;
      const task = snapshot.thread.metadata.task;
      if (principal?.kind === task.provider && principal.sessionId === task.attempts?.at(-1)?.sessionId) {
        await taskService.observeHandshake(snapshot.thread.id, { ...principal, threadId: snapshot.thread.id, operation: 'room_context' });
      }
    }
    return buildStateSnapshotEntry(snapshot, enriched, { includeMessages: true, includeDeliveries: true,
      messageLimit: normalizeCollectionLimit(req.query.messageLimit, null), deliveryLimit: normalizeCollectionLimit(req.query.deliveryLimit, null),
      includeFullThreadMetadata: true });
  });

  app.post('/api/agent-bus/threads/:threadId/close', { schema: { params: params({ threadId: string(ID_MAX, 1) }),
    body: bodySchema({ reason: string(512), cancelPending: { type: 'boolean' } }) } }, async (req, reply) => {
    const snapshot = store.getThread(req.params.threadId);
    if (!snapshot) return reply.code(404).send({ error: 'Thread not found' });
    await authorizeLifecycle(req, snapshot.thread, 'close');
    const pending = snapshot.deliveries.filter((item) => item.status === 'queued');
    if (pending.length && req.body?.cancelPending !== true) {
      return reply.code(409).send({ error: 'Room has pending deliveries; drain them or explicitly cancelPending',
        code: 'pending_deliveries', pending: pending.length });
    }
    if (snapshot.deliveries.some((item) => deliveryInFlight.has(item.id))) {
      return reply.code(409).send({ error: 'Room has delivery in flight; retry after it settles', code: 'delivery_in_flight' });
    }
    const thread = await store.closeThread(req.params.threadId, req.body?.reason || '');
    if (!thread) return reply.code(404).send({ error: 'Thread not found' });
    thread.participants.forEach(pruneObservedParticipant); await broadcastThreadSummary(thread.id);
    return { ok: true, status: 'closed', thread: normalizeThreadSummary(await enrichThread(thread)), preserved: thread.participants.map(participantRef) };
  });

  app.post('/api/agent-bus/threads/:threadId/reopen', { schema: { params: params({ threadId: string(ID_MAX, 1) }) } }, async (req, reply) => {
    const id = store.getThread(req.params.threadId)?.thread.id;
    if (endingThreads.has(id)) return reply.code(409).send({ error: 'Room is ending', code: 'room_ending' });
    const thread = await store.reopenThread(req.params.threadId);
    if (!thread) return reply.code(404).send({ error: 'Thread not found' });
    thread.participants.forEach((participant) => observedSessions.add(participantKey(participant)));
    await broadcastThreadSummary(thread.id);
    return { ok: true, status: 'open', thread: normalizeThreadSummary(await enrichThread(thread)) };
  });

  async function endRoom(req, reply) {
    const snapshot = store.getThread(req.params.threadId); if (!snapshot) return reply.code(404).send({ error: 'Thread not found' });
    await authorizeLifecycle(req, snapshot.thread, 'end');
    if (snapshot.thread.metadata?.dm) return reply.code(400).send({ error: 'DM rooms may only be closed' });
    if (endingThreads.has(snapshot.thread.id)) return reply.code(409).send({ error: 'Room is ending', code: 'room_ending' });
    endingThreads.add(snapshot.thread.id);
    try {
    const thread = await store.closeThread(snapshot.thread.id, req.body?.reason || 'ended');
    const openRooms = store.listThreads({ status: 'open' });
    const participants = snapshot.thread.participants || [];
    const skipped = participants.filter((participant) => openRooms.some((room) => room.id !== snapshot.thread.id
      && !room.metadata?.dm && threadHasParticipant(room, participant))).map(participantRef);
    const outcomes = await Promise.allSettled(participants.map(async (participant) => {
      if (skipped.some((ref) => participantKey(ref) === participantKey(participant))) return { status: 'skipped' };
      return adapters[participant.kind].deleteSession(app, participant.sessionId);
    }));
    const results = outcomes.map((outcome, index) => {
      const participant = participantRef(participants[index]);
      if (outcome.status === 'fulfilled') return { participant, status: outcome.value.status };
      const err = outcome.reason;
      return err.statusCode === 404 || err.payload?.sessionEnded === true
        ? { participant, status: 'already_gone' }
        : { participant, status: 'failed', reason: err.message };
    });
    thread.participants.forEach(pruneObservedParticipant); await broadcastThreadSummary(thread.id);
    const worktree = thread.metadata?.worktree ? await cleanupWorktree(thread.metadata.worktree) : undefined;
    return { ...(worktree ? { worktree } : {}), ok: results.every((item) => item.status !== 'failed'), status: 'ended', thread: normalizeThreadSummary(await enrichThread(thread)), results, skipped };
    } finally { endingThreads.delete(snapshot.thread.id); }
  }

  Object.assign(app.agentBusLifecycle, {
    getThread: (id) => store.getThread(id),
    linkWorktreePr: async (id, pr) => {
      const metadata = store.getThread(id)?.thread.metadata?.worktree;
      if (metadata) await store.updateThreadMetadata(id, { worktree: await linkManagedWorktreePr(metadata, pr) });
    },
    endThread: (id, options) => endRoom({ params: { threadId: id }, body: options }, {
      code(statusCode) { return { send(payload) { throw Object.assign(new Error(payload.error), { statusCode, code: payload.code }); } }; },
    }),
  });
  app.post('/api/agent-bus/threads/:threadId/end', { schema: { params: params({ threadId: string(ID_MAX, 1) }),
    body: bodySchema({ reason: string(512) }) } }, async (req, reply) => {
    return endRoom(req, reply);
  });

  app.delete('/api/agent-bus/threads/:threadId', { schema: { params: params({ threadId: string(ID_MAX, 1) }) } }, async (req, reply) => {
    const snapshot = store.getThread(req.params.threadId); if (!snapshot) return reply.code(404).send({ error: 'Thread not found' });
    if (endingThreads.has(snapshot.thread.id) || snapshot.deliveries.some((item) => deliveryInFlight.has(item.id))) {
      return reply.code(409).send({ error: 'Room has lifecycle or delivery work in flight', code: 'room_in_flight' });
    }
    await store.deleteThread(req.params.threadId); snapshot.thread.participants.forEach(pruneObservedParticipant);
    broadcast(wsManager, 'agent-bus:threads', 'thread_deleted', { threadId: req.params.threadId }); return { ok: true };
  });

  async function send({ threadId, from, body, summary, type = 'message', replyTo = null, metadata = null, deliveryMode = 'wait' }) {
    const snapshot = store.getThread(threadId); if (!snapshot) return { statusCode: 404, payload: { error: 'Thread not found' } };
    if (snapshot.thread.status !== 'open') return { statusCode: 409, payload: { error: 'Thread is closed' } };
    const managed = snapshot.thread.metadata?.task;
    if (isDurableTaskRecord(managed) && (from?.kind !== managed.provider || from?.sessionId !== managed.attempts?.at(-1)?.sessionId)) {
      return { statusCode: 409, payload: { error: 'Managed task input requires task_send', code: 'task_input_required' } };
    }
    if (snapshot.thread.metadata?.dm && !threadHasParticipant(snapshot.thread, from) && !threadHasOwner(snapshot.thread, from)) {
      return { statusCode: 403, payload: { error: 'Sender is not a participant in this DM' } };
    }
    const resolvedType = type === 'result' ? 'result' : (type || 'message');
    const duplicate = [...(snapshot.messages || [])].reverse().find((item) => (
      participantKey(item.from) === participantKey(from)
      && item.body === body
      && item.metadata?.summary === summary
      && (item.replyTo || null) === (replyTo || null)
      && (item.type || 'message') === resolvedType
      && Date.now() - Number(item.createdAt || 0) < 180000
    ));
    if (duplicate) {
      return { statusCode: 200, payload: { message: duplicate, deliveries: (snapshot.deliveries || []).filter((item) => item.messageId === duplicate.id), deduped: true } };
    }
    const targets = snapshot.thread.participants.filter((item) => adapters[item.kind]
      && participantKey(item) !== participantKey(from)).map(participantRef);
    const owner = snapshot.thread.createdBy;
    if (resolvedType === 'result' && adapters[owner?.kind] && !threadHasParticipant(snapshot.thread, owner)
      && participantKey(owner) !== participantKey(from)) targets.push(participantRef(owner));
    const record = await store.createMessage({ threadId, from: participantRef(from), targets, type: resolvedType, body,
      replyTo, metadata: { ...(metadata || {}), ...(summary !== undefined ? { summary } : {}), ...(snapshot.thread.metadata?.dm ? { dm: true } : {}) } });
    broadcast(wsManager, `agent-bus:thread:${threadId}`, 'message_created', { message: record.message, deliveries: record.deliveries });
    if (deliveryMode === 'wait') await Promise.all(record.deliveries.map(async (delivery) => {
      try { return await deliverMessage(record.message, delivery); }
      catch (err) { return failDelivery(record.message, delivery, err); }
    }));
    return { statusCode: 200, payload: { message: record.message,
      deliveries: record.deliveries.map((item) => store.getDelivery(item.id) || item) } };
  }

  app.post('/api/agent-bus/messages', { schema: { body: bodySchema({ threadId: string(ID_MAX, 1), from: agentRef,
    type: string(512), body: string(BODY_MAX, 1), summary: string(200), replyTo: string(ID_MAX), deliveryMode: { enum: ['wait', 'enqueue'] } },
  ['threadId', 'from', 'body']) } }, async (req, reply) => {
    const result = await send(req.body);
    const task = store.getThread(req.body.threadId)?.thread?.metadata?.task;
    const principal = req.duenoAuth?.principal;
    if (taskService && result.statusCode === 200 && isDurableTaskRecord(task) && req.duenoAuth?.authenticated
      && req.duenoAuth.source === 'agent_bus_mcp' && principal?.kind === task.provider
      && principal.sessionId === task.attempts?.at(-1)?.sessionId
      && participantKey(principal) === participantKey(result.payload.message?.from)) {
      await taskService.observeHandshake(req.body.threadId, { ...principal, threadId: req.body.threadId,
        operation: 'room_send', messageId: result.payload.message.id });
    }
    return reply.code(result.statusCode).send(result.payload);
  });

  async function assertKnownDmRef(ref, label, reply) {
    if (isDashboardUser(ref)) return true;
    const adapter = adapters[ref.kind];
    if (!adapter) { await reply.code(404).send({ error: `Unknown ${label} kind` }); return false; }
    try {
      const session = await adapter.getSession(app, ref.sessionId);
      if (session) return true;
    } catch (err) {
      if (err.payload?.sessionEnded === true || err.payload?.state?.status === 'ended') {
        await reply.code(410).send({ error: `${label} session ended`, code: 'session_ended', sessionEnded: true });
        return false;
      }
      if (err.statusCode !== 404 && err.code !== 'session_not_found') throw err;
    }
    await reply.code(404).send({ error: `${label} agent not found`, code: 'session_not_found' });
    return false;
  }

  app.post('/api/agent-bus/dm', { schema: { body: bodySchema({ from: agentRef, target: agentRef,
    body: string(BODY_MAX, 1), summary: string(200), replyTo: string(ID_MAX) }, ['from', 'target', 'body']) } }, async (req, reply) => {
    if (participantKey(req.body.from) === participantKey(req.body.target)) {
      return reply.code(400).send({ error: 'Cannot create a DM with yourself' });
    }
    if (!await assertKnownDmRef(req.body.from, 'Sender', reply)) return;
    if (!await assertKnownDmRef(req.body.target, 'Target', reply)) return;
    const key = dmKey(req.body.from, req.body.target);
    let thread = store.listThreads().find((item) => item.metadata?.dmKey === key);
    if (!thread) thread = await store.createThread({ title: `DM: ${key}`, projectKey: '',
      participants: uniqueAgentRefs([req.body.from, req.body.target]), metadata: { dm: true, dmKey: key } });
    else if (thread.status !== 'open') {
      if (endingThreads.has(thread.id)) return reply.code(409).send({ error: 'Room is ending', code: 'room_ending' });
      thread = await store.reopenThread(thread.id);
    }
    thread.participants.forEach((participant) => observedSessions.add(participantKey(participant)));
    const result = await send({ threadId: thread.id, from: req.body.from, body: req.body.body, summary: req.body.summary, replyTo: req.body.replyTo,
      metadata: { dm: true } });
    return reply.code(result.statusCode).send({ thread: normalizeThreadSummary(await enrichThread(thread)), ...result.payload });
  });

  app.get('/api/agent-bus/messages/:messageId/context', async (req, reply) => {
    const message = store.getMessage(req.params.messageId); if (!message) return reply.code(404).send({ error: 'Message not found' });
    return { message, deliveries: store.getThread(message.threadId)?.deliveries.filter((item) => item.messageId === message.id) || [],
      thread: normalizeThreadSummary(store.getThread(message.threadId).thread) };
  });

  app.post('/api/agent-bus/deliveries/:deliveryId/replay', async (req, reply) => {
    try { productionControls.assertEnabled('agentBus.deliveryReplay'); return { ok: true,
      delivery: await replayDelivery(req.params.deliveryId, { requestedBy: req.body?.requestedBy }) }; }
    catch (err) { return reply.code(/Only failed|Reopen the room/.test(err.message) ? 409 : 502).send({ error: err.message }); }
  });
  app.post('/api/agent-bus/deliveries/replay-eligible', async (req) => {
    const eligible = collectReplayEligibleDeliveriesFromStore(store, { limit: req.body?.limit || 50 });
    const results = await Promise.all(eligible.map(async (item) => {
      try { return { ...item, ok: true, delivery: await replayDelivery(item.deliveryId, { requestedBy: req.body?.requestedBy }) }; }
      catch (err) { return { ...item, ok: false, error: err.message }; }
    }));
    return { ok: results.every((item) => item.ok), eligibleCount: eligible.length, replayedCount: results.filter((item) => item.ok).length,
      failedCount: results.filter((item) => !item.ok).length, results };
  });
}
