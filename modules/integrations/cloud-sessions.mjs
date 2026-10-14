/**
 * Claude Code on the web ("cloud") sessions: status, transcript, send and launch.
 *
 * Only `claude -p --cloud <id>` (used by cloudSend) is documented. Everything
 * else uses internal, undocumented endpoints read from the CLI bundle; they
 * were checked against Claude Code CLI 2.1.296 and may break on any release.
 * Endpoint paths and the state mapping live in this file only.
 *
 * Tokens are read (never refreshed or written) from the CLI's own files and are
 * never logged or returned.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Internal endpoints (CLI 2.1.296).
const API_BASE = 'https://api.anthropic.com';
const SESSIONS_PATH = '/v1/code/sessions';
const ENVIRONMENTS_PATH = '/v1/environment_providers';
const USAGE_PATH = '/api/oauth/usage';
// Probable cloud-credit bucket: its reset time matches the ccr_promotional limit.
const INFERRED_CLOUD_CREDIT_BUCKET = 'iguana_necktie';
const LIST_PAGE_LIMIT = 100; // the CLI's own list walk: limit=100, at most 10 pages
const LIST_MAX_PAGES = 10;
const EXPIRY_BUFFER_MS = 300000; // the CLI treats a token this close to expiry as expired
const INIT_ERROR_STALE_MS = 120000;

function defaults(opts = {}) {
  const claudeDir = opts.claudeDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return {
    baseUrl: API_BASE,
    claudeBin: 'claude',
    ghBin: 'gh',
    pollMs: 2000,
    rereadMs: 1000,
    ...opts,
    claudeDir,
    claudeJsonPath: opts.claudeJsonPath || (process.env.CLAUDE_CONFIG_DIR ? join(claudeDir, '.claude.json') : join(homedir(), '.claude.json')),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

// Read-only: Cadre never refreshes the shared CLI login or writes under ~/.claude.
async function readOAuth(o) {
  const oauth = (await readJson(join(o.claudeDir, '.credentials.json'))).claudeAiOauth;
  if (!oauth?.accessToken) throw new Error('Cloud sessions need a claude.ai sign-in: run `claude auth login`');
  return oauth;
}

async function auth(o) {
  let oauth = await readOAuth(o);
  if (oauth.expiresAt - Date.now() <= EXPIRY_BUFFER_MS) {
    // A running Claude Code session refreshes the file; give it one more look.
    await sleep(o.rereadMs);
    oauth = await readOAuth(o);
    if (oauth.expiresAt - Date.now() <= EXPIRY_BUFFER_MS) throw new Error('Claude OAuth token expired; it refreshes when any Claude Code session runs.');
  }
  const orgUuid = (await readJson(o.claudeJsonPath)).oauthAccount?.organizationUuid;
  if (!orgUuid) throw new Error('Unable to get organization UUID');
  return { accessToken: oauth.accessToken, orgUuid };
}

async function api(o, path, { method = 'GET', headers = {}, body } = {}) {
  const { accessToken, orgUuid } = await auth(o);
  const res = await fetch(`${o.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`, 'anthropic-version': '2023-06-01', 'x-organization-uuid': orgUuid,
      ...(body ? { 'content-type': 'application/json' } : {}), ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`${method} ${path.split('?')[0]} failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`.trim());
  }
  return res.json();
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

function startupFailure(s, now) {
  const err = s.environment_kind === 'bridge' ? null : s.external_metadata?.last_init_error;
  if (err) {
    const live = ['running', 'idle', 'requires_action'].includes(s.worker_status);
    const at = Date.parse(err.at);
    const stale = Number.isFinite(at) && now - at > INIT_ERROR_STALE_MS;
    if (err.error_kind === 'environment_deleted' || (!live && (String(err.recoverable) !== 'true' || stale))) {
      return text(err.message) || 'the cloud environment failed to start';
    }
  }
  if (s.status === 'failed') return 'the cloud environment could not be provisioned';
  return undefined;
}

/** Mirrors the CLI's session-state mapping (function `Nm` in CLI 2.1.296). */
export function cloudSessionState(s, now = Date.now()) {
  const failure = startupFailure(s, now);
  if (failure !== undefined) return { state: 'failed', reason: failure };
  if (s.worker_status === 'requires_action') return { state: s.status === 'paused' ? 'blocked' : 'working' };
  if (s.worker_status === 'idle' || s.status === 'paused') {
    switch (s.status_bucket) {
      case 'blocked': return { state: 'blocked' };
      case 'failed': return { state: 'failed', reason: text(summaryOf(s)?.status_detail) || 'the last turn failed' };
      case 'working': return { state: 'working' };
      case 'completed': return { state: 'done' };
      default: return s.worker_status === 'idle' ? { state: 'done' } : { state: 'stopped', reason: 'paused · reply to resume' };
    }
  }
  if (s.worker_status === 'running' && s.connection_status === 'disconnected') {
    return { state: 'stopped', reason: 'lost contact with the cloud environment' };
  }
  return { state: 'working' };
}

function summaryOf(s) {
  return s.external_metadata?.post_turn_summary || s.post_turn_summary;
}

function branchesOf(s) {
  const current = Object.values(s.external_metadata?.current_branches || {}).filter(Boolean);
  if (current.length) return [...new Set(current)];
  return s.config?.outcomes?.find((x) => x?.type === 'git_repository')?.git_info?.branches || [];
}

async function findPr(o, repo, branches) {
  for (const branch of branches) {
    try {
      const { stdout } = await run(o.ghBin, ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,url,state'], { timeout: 15000 });
      const [pr] = JSON.parse(stdout);
      if (pr) return pr;
    } catch {
      // Best effort: gh missing, unauthenticated or offline.
    }
  }
  return null;
}

// A permission prompt the session is blocked on, as the CLI reads it (`oEr` in CLI 2.1.296).
// Questions and plans carry an empty request_id; only tool permissions are answerable here.
function pendingPermission(s) {
  const p = s.worker_status === 'requires_action' ? s.external_metadata?.pending_action : null;
  return p?.request_id && p.tool_name ? p : null;
}

async function describe(o, s) {
  const { state, reason } = cloudSessionState(s);
  const summary = summaryOf(s);
  const branches = branchesOf(s);
  const repo = s.config?.outcomes?.find((x) => x?.type === 'git_repository')?.git_info?.repo;
  const permission = pendingPermission(s);
  return {
    id: s.id,
    title: s.title || 'Untitled',
    state,
    detail: reason || text(summary?.status_detail) || text(s.external_metadata?.task_summary) || '',
    needs_action: text(summary?.needs_action),
    permission: permission && { request_id: permission.request_id, tool: permission.display_tool_name || permission.tool_name, action: text(permission.action_description), input: permission.input ?? null },
    branches,
    pr: repo && branches.length ? await findPr(o, repo, branches) : null,
    url: s.session_url || null,
    cost_usd: s.external_metadata?.usage?.cost_usd ?? null,
  };
}

function bucket(b) {
  return b ? { utilization: b.utilization, resets_at: b.resets_at } : null;
}

async function listSessions(o) {
  const rows = [];
  let cursor = null;
  for (let page = 0; page < LIST_MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: LIST_PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
    const body = await api(o, `${SESSIONS_PATH}?${query}`);
    rows.push(...(body.data || []).filter((s) => s.environment_kind === 'anthropic_cloud'));
    cursor = body.next_cursor;
    if (!cursor) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** List anthropic_cloud sessions with the account usage summary, or get one session. */
export async function cloudStatus({ id } = {}, opts = {}) {
  const o = defaults(opts);
  const get = async (sid) => describe(o, await getSession(o, sid));
  if (id) return get(id);
  const [list, usage] = await Promise.all([
    listSessions(o),
    api(o, USAGE_PATH, { headers: { 'anthropic-beta': 'oauth-2025-04-20' } }).catch((err) => ({ error: err.message })),
  ]);
  // List rows lack session_url and the post-turn summary, so read each cloud session in full.
  const sessions = await Promise.all(list.rows.map((s) => get(s.id)));
  const credit = usage[INFERRED_CLOUD_CREDIT_BUCKET];
  return {
    sessions,
    ...(list.truncated ? { truncated: `stopped after ${LIST_MAX_PAGES} pages of ${LIST_PAGE_LIMIT}; older sessions are not listed` } : {}),
    usage: usage.error ? { error: usage.error } : {
      five_hour: bucket(usage.five_hour),
      seven_day: bucket(usage.seven_day),
      cloud_credit: credit ? {
        inferred: true,
        note: `Inferred from the undocumented "${INFERRED_CLOUD_CREDIT_BUCKET}" bucket; not confirmed as cloud credit.`,
        used_dollars: credit.used_dollars,
        limit_dollars: credit.limit_dollars,
        remaining_dollars: credit.remaining_dollars,
        resets_at: credit.resets_at,
      } : null,
    },
  };
}

async function getSession(o, id) {
  const body = await api(o, `${SESSIONS_PATH}/${encodeURIComponent(id)}`);
  return body.response_shape || body.session;
}

/**
 * Answer a pending permission request the way the CLI's RemoteSessionManager does: a
 * control_response event. Refuses unless `request_id` is still the session's pending one.
 */
export async function cloudRespond({ id, request_id: requestId, allow } = {}, opts = {}) {
  const o = defaults(opts);
  const pending = pendingPermission(await getSession(o, id));
  if (!requestId || pending?.request_id !== requestId) throw Object.assign(new Error('Permission request is no longer pending'), { statusCode: 409 });
  const response = allow
    ? { behavior: 'allow', updatedInput: pending.input || {}, toolUseID: pending.tool_use_id }
    : { behavior: 'deny', message: 'Denied by the operator', toolUseID: pending.tool_use_id };
  await api(o, `${SESSIONS_PATH}/${encodeURIComponent(id)}/events`, { method: 'POST', body: {
    session_id: id,
    events: [{ payload: { type: 'control_response', uuid: randomUUID(), response: { subtype: 'success', request_id: requestId, response } } }],
  } });
  return { id, request_id: requestId, behavior: response.behavior };
}

function eventsPath(id, query) {
  return `${SESSIONS_PATH}/${encodeURIComponent(id)}/events?${new URLSearchParams(query)}`;
}

function contentText(content, { tools = false } = {}) {
  if (typeof content === 'string') return content.trim();
  return (Array.isArray(content) ? content : []).map((block) => {
    if (block?.type === 'text') return text(block.text);
    if (tools && block?.type === 'tool_use') return `[${block.name}]`;
    return '';
  }).filter(Boolean).join('\n');
}

/** Compact one transcript event to {seq, role, text}, or null when it carries no readable text. */
export function cloudEventLine(event) {
  const p = event.payload || {};
  const seq = Number(event.sequence_num);
  if (event.event_type === 'assistant') {
    const body = contentText(p.message?.content, { tools: true });
    return body ? { seq, role: 'assistant', text: body } : null;
  }
  if (event.event_type === 'user') {
    const body = contentText(p.message?.content);
    return body ? { seq, role: 'user', text: body } : null;
  }
  if (event.event_type === 'result') {
    return { seq, role: 'result', text: [p.subtype, text(p.result)].filter(Boolean).join(': ') };
  }
  return null;
}

function lastAssistantText(events, fallback = '') {
  const last = events.filter((e) => e.event_type === 'assistant').map((e) => contentText(e.payload?.message?.content)).filter(Boolean).at(-1);
  return last || fallback;
}

/** Tail transcript events: newest `limit` events, or the events after `after_seq`. */
export async function cloudOutput({ id, after_seq: afterSeq, limit = 50 } = {}, opts = {}) {
  const o = defaults(opts);
  const page = afterSeq === undefined
    ? (await api(o, eventsPath(id, { sort_order: 'desc', limit }))).data.reverse()
    : (await api(o, eventsPath(id, { sort_order: 'asc', cursor: afterSeq, limit }))).data;
  return {
    lines: page.map(cloudEventLine).filter(Boolean),
    last_assistant_text: lastAssistantText(page),
    next_seq: page.length ? Number(page.at(-1).sequence_num) : afterSeq ?? null,
  };
}

/**
 * Reply-wait rule from the spike: accept a `result` only after our own `user`
 * event (source "client") has appeared, so the previous turn's result is ignored.
 */
export function findCloudReply(events, state = { sawOwnMessage: false }) {
  for (const event of events) {
    if (!state.sawOwnMessage) {
      if (event.event_type === 'user' && event.source === 'client') state.sawOwnMessage = true;
    } else if (event.event_type === 'result') {
      return event;
    }
  }
  return null;
}

/** Send through the documented CLI path; with wait_s > 0, wait for the reply. */
export async function cloudSend({ id, text: message, wait_s: waitS = 0 } = {}, opts = {}) {
  const o = defaults(opts);
  let cursor = waitS > 0 ? Number((await api(o, eventsPath(id, { sort_order: 'desc', limit: 1 }))).data[0]?.sequence_num ?? 0) : null;
  const { stdout } = await run(o.claudeBin, ['-p', message, '--cloud', id, '--output-format', 'json'], { timeout: 120000 });
  const sent = JSON.parse(stdout);
  if (!sent.ok) throw new Error(`claude --cloud send failed: ${stdout.slice(0, 500)}`);
  const base = { ok: true, id: sent.session_id || id, url: sent.url };
  if (!(waitS > 0)) return { ...base, status: 'sent' };

  const deadline = Date.now() + waitS * 1000;
  const state = { sawOwnMessage: false };
  let lastAssistant = '';
  for (;;) {
    const { data } = await api(o, eventsPath(id, { sort_order: 'asc', cursor, limit: 100 }));
    lastAssistant = lastAssistantText(data, lastAssistant);
    const result = findCloudReply(data, state);
    if (result) {
      return { ...base, status: 'replied', reply: text(result.payload?.result) || lastAssistant, is_error: Boolean(result.payload?.is_error), next_seq: Number(result.sequence_num) };
    }
    if (data.length) cursor = Number(data.at(-1).sequence_num);
    if (Date.now() >= deadline) return { ...base, status: 'timeout', next_seq: cursor };
    await sleep(Math.min(o.pollMs, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Start a cloud session on the account's anthropic_cloud environment, cloned
 * from `repo` at `ref` and working on a claude/… outcome branch (the server
 * adds a unique suffix). Verified live 2026-10-13: the API ignores the CLI's
 * `session_context` field; `config` and `events[].payload` are honoured.
 */
// Cadre's watcher already follows the session's PR; a PR-activity trigger only adds a
// "Delete Trigger" permission prompt for the operator when the session cleans it up.
export const CLOUD_LAUNCH_NOTE = 'Cadre already watches this session and its PR. Do not create PR-activity triggers or subscriptions.';

export async function cloudLaunch({ prompt, repo, ref, name, model } = {}, opts = {}) {
  const o = defaults(opts);
  const { environments = [] } = await api(o, ENVIRONMENTS_PATH);
  const env = environments.find((e) => e.kind === 'anthropic_cloud');
  if (!env) throw new Error('No anthropic_cloud environment on this account');
  const title = text(name) || text(prompt).slice(0, 75);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
  const body = await api(o, SESSIONS_PATH, { method: 'POST', body: {
    title,
    environment_id: env.environment_id,
    events: [{ payload: { uuid: randomUUID(), session_id: '', type: 'user', parent_tool_use_id: null, message: { role: 'user', content: `${prompt}\n\n${CLOUD_LAUNCH_NOTE}` } } }],
    config: {
      sources: [{ type: 'git_repository', url: `https://github.com/${repo}`, ...(ref ? { revision: ref } : {}) }],
      outcomes: [{ type: 'git_repository', git_info: { type: 'github', repo, branches: [`claude/${slug}`] } }],
      ...(model ? { model } : {}),
    },
  } });
  const s = body.session || body.response_shape || body;
  return { id: s.id, url: s.session_url || null };
}
