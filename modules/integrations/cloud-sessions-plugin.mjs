/**
 * Cadre-side cloud session tracking: launch with an owner, a 60 s watcher that
 * DMs the owner on state changes, and room attach. An attached session is a
 * `cloud` agent-bus participant (see adapters.mjs): room messages reach it
 * through cloudSend, and its assistant replies are posted back as its own
 * messages, which the bus never delivers to their sender. cloud_detach takes it out of the room.
 *
 * A pending permission prompt becomes one Command Queue operator action, so only the
 * operator can answer it: Approve runs the allow route below; Reject is sent as a deny.
 */
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import { cloudLaunch, cloudOutput, cloudRespond, cloudSend, cloudStatus } from './cloud-sessions.mjs';

const POLL_MS = 60_000;
const PREAPPROVED_TOOLS = new Set(['mcp__claude-code-remote__delete_trigger']);
const cloudRef = (id) => ({ kind: 'cloud', sessionId: id });

/** Owner notices for one session, from its last-seen record to its current cloudStatus view. */
function cloudNotices(seen, view) {
  const lines = [];
  const asks = Boolean(view.needs_action) && view.needs_action !== seen.needs_action;
  if (view.state === 'blocked' && (view.state !== seen.state || asks)) lines.push(`blocked: ${view.needs_action || view.detail || 'needs input'}`);
  else if (view.state !== seen.state && view.state === 'failed') lines.push(`failed: ${view.detail}`);
  // An attached session's replies already reach its room, so its end of turn is not news.
  else if (view.state === 'done' && seen.state === 'working' && !seen.threadId) lines.push(`done: ${view.detail}`);
  if (asks && view.state !== 'blocked') lines.push(`needs action: ${view.needs_action}`);
  if (view.pr && !seen.prs.includes(view.pr.number)) lines.push(`PR opened #${view.pr.number} ${view.pr.url}`);
  return lines;
}

export async function cloudSessionsPlugin(app, {
  pollEnabled = false,
  store = buildPostgresJsonStore({ namespace: 'cloud_sessions', filePath: runtimeStatePath('cloud_sessions.json') }),
  watchPr = async () => { throw new Error('PR watches unavailable'); },
  cloudOpts = {},
  wsManager,
} = {}) {
  const state = { sessions: {}, ...(await store.load().catch(() => null)) };
  const save = () => store.save(state);

  const same = (ref, owner) => ref?.kind === owner.kind && ref?.sessionId === owner.sessionId;

  function caller(req) {
    const p = req.duenoAuth?.principal;
    if (p?.type !== 'agent' || !p.kind || !p.sessionId) throw Object.assign(new Error('Authenticated agent identity required'), { statusCode: 403 });
    return { kind: p.kind, sessionId: p.sessionId };
  }

  // Track `id` for `owner`. The baseline is the session's current view, so registering never notifies.
  // The owner of the room a session is attached to may take it over, so room_transfer hands off its clouds.
  async function track(id, owner, view, patch = {}) {
    const prior = state.sessions[id];
    const roomOwner = prior?.threadId && same(app.agentBusLifecycle.getThread(prior.threadId)?.thread?.createdBy, owner);
    if (prior && !same(prior.owner, owner) && !roomOwner) {
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
    // One room message per turn: its last assistant text, posted when the turn's result arrives.
    for (const line of out.lines) {
      if (line.role === 'assistant') seen.reply = line.text.split('\n').filter((l) => !/^\[[^\]]+\]$/.test(l)).join('\n').trim() || seen.reply;
      if (line.role !== 'result') continue;
      const body = seen.reply || line.text;
      if (body) await app.agentBusLifecycle.send({ threadId: seen.threadId, from: cloudRef(id), body, deliveryMode: 'enqueue' });
      delete seen.reply;
    }
    seen.seq = out.next_seq;
  }

  // One queue item per pending request, filed as the owner; withdrawn if the request clears unanswered.
  // The operator pre-approved removing a session's own PR-activity trigger (Cadre watches the PR).
  async function permissionPass(id, seen, view) {
    const { addHumanQueueItem, dismissHumanQueueItem, serializeWorkQueue } = await import('./command-center-ai.mjs');
    const principal = { type: 'agent', ...seen.owner };
    const asked = seen.permission;
    const item = asked && (await serializeWorkQueue({ status: 'all' })).items.find((entry) => entry.id === asked.itemId);
    const result = item?.operatorActionResult;
    // An approval whose allow post failed is dropped, so the still-pending request gets a fresh item.
    const allowFailed = result && result.status !== 'rejected' && !(result.statusCode >= 200 && result.statusCode < 300);
    if (asked && (asked.request_id !== view.permission?.request_id || allowFailed)) {
      if (item?.status === 'open') await dismissHumanQueueItem(item.id, { wsManager, principal });
      delete seen.permission;
    } else if (result?.status === 'rejected' && !asked.denied) {
      await cloudRespond({ id, request_id: asked.request_id, allow: false }, cloudOpts);
      asked.denied = true;
    }
    if (view.permission && !seen.permission && PREAPPROVED_TOOLS.has(view.permission.name)) {
      await cloudRespond({ id, request_id: view.permission.request_id, allow: true }, cloudOpts);
      seen.permission = { request_id: view.permission.request_id, auto: true };
      app.log.info({ id, tool: view.permission.name }, 'Cloud permission auto-approved');
    }
    if (view.permission && !seen.permission) {
      const { request_id: requestId, tool, action, input } = view.permission;
      const filed = await addHumanQueueItem({
        title: `Cloud session ${view.title}`,
        question: `Allow ${tool}${action ? ` — ${action}` : ''}?`,
        details: `Approve and run allows it; Reject denies it.\nInput: ${JSON.stringify(input).slice(0, 2000)}\n${view.url || id}`,
        source: 'cloud_session',
        operatorAction: { method: 'POST', path: `/api/cloud/sessions/${encodeURIComponent(id)}/permission`, body: { request_id: requestId } },
      }, { wsManager, principal });
      seen.permission = { request_id: requestId, itemId: filed.id };
    }
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
        await permissionPass(id, seen, view);
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

  // Dashboard only (the queue item's operator action); agents hold the bearer token, never this cookie.
  app.post('/api/cloud/sessions/:id/permission', async (req, reply) => {
    if (req.duenoAuth?.principal?.kind !== 'dashboard') return reply.code(403).send({ error: 'Only the operator can answer a cloud permission prompt' });
    return cloudRespond({ id: req.params.id, request_id: req.body?.request_id, allow: true }, cloudOpts);
  });

  app.post('/api/cloud/watch', async (req) => {
    const owner = caller(req);
    const view = await cloudStatus({ id: req.body.id }, cloudOpts);
    const seen = await track(req.body.id, owner, view);
    return { id: req.body.id, state: seen.state, status: 'watching' };
  });

  // Attach and detach take the same caller, the room's owner or one of its participants; [status, error] otherwise.
  function roomDenied(owner, threadId) {
    const thread = app.agentBusLifecycle.getThread(threadId)?.thread;
    if (!thread || thread.status !== 'open') return [404, 'Open room not found'];
    if (thread.metadata?.dm) return [400, 'Cloud sessions attach to rooms, not DMs'];
    if (!same(thread.createdBy, owner) && !thread.participants?.some((ref) => same(ref, owner))) return [403, 'Room owner or participant required'];
    return null;
  }

  app.post('/api/cloud/attach', async (req, reply) => {
    const owner = caller(req);
    const { id, thread_id: threadId } = req.body;
    const denied = roomDenied(owner, threadId);
    if (denied) return reply.code(denied[0]).send({ error: denied[1] });
    const [view, tail] = await Promise.all([cloudStatus({ id }, cloudOpts), cloudOutput({ id, limit: 1 }, cloudOpts)]);
    await track(id, owner, view, { threadId, seq: tail.next_seq ?? 0, title: view.title });
    await app.agentBusLifecycle.addParticipant(threadId, cloudRef(id));
    return { id, thread_id: threadId, status: 'attached' };
  });

  // The session keeps running and stays watched; it just leaves the room. Without its threadId
  // the watcher stops posting its turns and the adapter stops forwarding room messages to it.
  app.post('/api/cloud/detach', async (req, reply) => {
    const { id, thread_id: threadId } = req.body;
    const denied = roomDenied(caller(req), threadId);
    if (denied) return reply.code(denied[0]).send({ error: denied[1] });
    await app.agentBusLifecycle.removeParticipant(threadId, cloudRef(id));
    const seen = state.sessions[id];
    if (seen?.threadId === threadId) {
      delete seen.threadId;
      await save();
    }
    return { id, thread_id: threadId, status: 'detached' };
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
