/**
 * Cadre-side cloud session tracking: launch with an owner, a 60 s watcher that
 * DMs the owner on state changes, and room attach. An attached session is a
 * `cloud` agent-bus participant (see adapters.mjs): room messages reach it
 * through cloudSend, and its assistant replies are posted back as its own
 * messages, which the bus never delivers to their sender.
 */
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import { cloudLaunch, cloudOutput, cloudSend, cloudStatus } from './cloud-sessions.mjs';

const POLL_MS = 60_000;
const cloudRef = (id) => ({ kind: 'cloud', sessionId: id });

/** Owner notices for one session, from its last-seen record to its current cloudStatus view. */
function cloudNotices(seen, view) {
  const lines = [];
  const asks = Boolean(view.needs_action) && view.needs_action !== seen.needs_action;
  if (view.state === 'blocked' && (view.state !== seen.state || asks)) lines.push(`blocked: ${view.needs_action || view.detail || 'needs input'}`);
  else if (view.state !== seen.state && view.state === 'failed') lines.push(`failed: ${view.detail}`);
  else if (view.state === 'done' && seen.state === 'working') lines.push(`done: ${view.detail}`);
  if (asks && view.state !== 'blocked') lines.push(`needs action: ${view.needs_action}`);
  if (view.pr && !seen.prs.includes(view.pr.number)) lines.push(`PR opened #${view.pr.number} ${view.pr.url}`);
  return lines;
}

export async function cloudSessionsPlugin(app, {
  pollEnabled = false,
  store = buildPostgresJsonStore({ namespace: 'cloud_sessions', filePath: runtimeStatePath('cloud_sessions.json') }),
  watchPr = async () => { throw new Error('PR watches unavailable'); },
  cloudOpts = {},
} = {}) {
  const state = { sessions: {}, ...(await store.load().catch(() => null)) };
  const save = () => store.save(state);

  function caller(req) {
    const p = req.duenoAuth?.principal;
    if (p?.type !== 'agent' || !p.kind || !p.sessionId) throw Object.assign(new Error('Authenticated agent identity required'), { statusCode: 403 });
    return { kind: p.kind, sessionId: p.sessionId };
  }

  // Track `id` for `owner`. The baseline is the session's current view, so registering never notifies.
  async function track(id, owner, view, patch = {}) {
    const prior = state.sessions[id];
    if (prior && (prior.owner.kind !== owner.kind || prior.owner.sessionId !== owner.sessionId)) {
      throw Object.assign(new Error(`Cloud session ${id} is owned by ${prior.owner.kind}:${prior.owner.sessionId}`), { statusCode: 403 });
    }
    state.sessions[id] = { prs: [], ...prior, owner, state: view.state, needs_action: view.needs_action || '', ...(view.pr ? { prs: [view.pr.number] } : {}), ...patch };
    await save();
    return state.sessions[id];
  }

  // True once the bus accepted the DM; until then the last-seen state stays put so the next pass retries.
  async function notify(id, owner, body) {
    try {
      const result = await app.agentBusLifecycle.directMessage({ from: cloudRef(id), target: owner, body });
      if (result.statusCode === 200) return true;
      app.log.warn({ id, owner, error: result.payload?.error }, 'Cloud session owner DM failed');
    } catch (err) { app.log.warn({ id, owner, err: err.message }, 'Cloud session owner DM failed'); }
    return false;
  }

  async function relay(id, seen) {
    const thread = app.agentBusLifecycle.getThread(seen.threadId)?.thread;
    if (thread?.status !== 'open') return;
    const out = await cloudOutput({ id, after_seq: seen.seq, limit: 200 }, cloudOpts);
    for (const line of out.lines) {
      const body = line.role === 'assistant' && line.text.split('\n').filter((l) => !/^\[[^\]]+\]$/.test(l)).join('\n').trim();
      if (body) await app.agentBusLifecycle.send({ threadId: seen.threadId, from: cloudRef(id), body, deliveryMode: 'enqueue' });
    }
    seen.seq = out.next_seq;
  }

  /** One watcher pass over every tracked session; the 60 s loop calls this. */
  async function step() {
    for (const [id, seen] of Object.entries(state.sessions)) {
      try {
        const view = await cloudStatus({ id }, cloudOpts);
        const lines = cloudNotices(seen, view);
        if (!lines.length || await notify(id, seen.owner, `Cloud session ${id} (${view.title}) ${lines.join('\n')}\n${view.url || ''}`.trim())) {
          if (view.pr && !seen.prs.includes(view.pr.number)) {
            seen.prs.push(view.pr.number);
            const repo = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(view.pr.url || '')?.[1];
            await watchPr({ repo, number: view.pr.number }, seen.owner).catch((err) => app.log.warn({ id, repo, err: err.message }, 'Cloud session PR watch not registered'));
          }
          Object.assign(seen, { state: view.state, needs_action: view.needs_action });
        }
        if (seen.threadId) await relay(id, seen);
      } catch (err) {
        if (/HTTP 404/.test(err.message)) delete state.sessions[id];
        else app.log.warn({ id, err: err.message }, 'Cloud session watch failed');
      }
      await save();
    }
  }

  // On the shared lifecycle object so the agent-bus `cloud` adapter can reach it.
  app.agentBusLifecycle.cloudSessions = {
    get: (id) => state.sessions[id] || null,
    send: (id, text) => cloudSend({ id, text }, cloudOpts),
    step,
  };

  app.post('/api/cloud/sessions', async (req) => {
    const owner = caller(req);
    const launched = await cloudLaunch(req.body, cloudOpts);
    await track(launched.id, owner, { state: 'working' });
    return launched;
  });

  app.post('/api/cloud/watch', async (req) => {
    const owner = caller(req);
    const view = await cloudStatus({ id: req.body.id }, cloudOpts);
    const seen = await track(req.body.id, owner, view);
    return { id: req.body.id, state: seen.state, status: 'watching' };
  });

  app.post('/api/cloud/attach', async (req, reply) => {
    const owner = caller(req);
    const { id, thread_id: threadId } = req.body;
    const thread = app.agentBusLifecycle.getThread(threadId)?.thread;
    if (!thread || thread.status !== 'open') return reply.code(404).send({ error: 'Open room not found' });
    if (thread.metadata?.dm) return reply.code(400).send({ error: 'Cloud sessions attach to rooms, not DMs' });
    const same = (ref) => ref?.kind === owner.kind && ref?.sessionId === owner.sessionId;
    if (!same(thread.createdBy) && !thread.participants?.some(same)) return reply.code(403).send({ error: 'Room owner or participant required' });
    const [view, tail] = await Promise.all([cloudStatus({ id }, cloudOpts), cloudOutput({ id, limit: 1 }, cloudOpts)]);
    await track(id, owner, view, { threadId, seq: tail.next_seq ?? 0 });
    await app.agentBusLifecycle.addParticipant(threadId, cloudRef(id));
    return { id, thread_id: threadId, status: 'attached' };
  });

  if (pollEnabled) {
    let running = null;
    const timer = setInterval(() => {
      running ||= step().catch((err) => app.log.warn({ err: err.message }, 'Cloud session watcher failed')).finally(() => { running = null; });
    }, POLL_MS);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }
}
