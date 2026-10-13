/**
 * Claude Code on the web ("cloud") sessions: status, transcript and send.
 *
 * Only `claude -p --cloud <id>` (used by cloudSend) is documented. Everything
 * else uses internal, undocumented endpoints read from the CLI bundle; they
 * were checked against Claude Code CLI 2.1.296 and may break on any release.
 * Endpoint paths and the state mapping live in this file only.
 *
 * Tokens are read from the CLI's own files and are never logged or returned.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Internal endpoints (CLI 2.1.296).
const API_BASE = 'https://api.anthropic.com';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const SESSIONS_PATH = '/v1/code/sessions';
const USAGE_PATH = '/api/oauth/usage';
// Probable cloud-credit bucket: its reset time matches the ccr_promotional limit.
const INFERRED_CLOUD_CREDIT_BUCKET = 'iguana_necktie';
const REFRESH_BUFFER_MS = 300000;
const LOCK_STALE_MS = 60000;
const INIT_ERROR_STALE_MS = 120000;

function defaults(opts = {}) {
  const claudeDir = opts.claudeDir || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  return {
    baseUrl: API_BASE,
    tokenUrl: TOKEN_URL,
    claudeBin: 'claude',
    ghBin: 'gh',
    pollMs: 2000,
    ...opts,
    claudeDir,
    claudeJsonPath: opts.claudeJsonPath || (process.env.CLAUDE_CONFIG_DIR ? join(claudeDir, '.claude.json') : join(homedir(), '.claude.json')),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

async function withRefreshLock(claudeDir, fn) {
  // Same lock directory the CLI's proper-lockfile takes before it refreshes.
  const lock = join(claudeDir, '.oauth_refresh.lock');
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > LOCK_STALE_MS) await rmdir(lock).catch(() => {});
      else if (attempt >= 5) throw new Error('OAuth refresh lock is held by another process');
      else await sleep(1000 + Math.random() * 1000);
    }
  }
  try { return await fn(); } finally { await rmdir(lock).catch(() => {}); }
}

async function refreshToken(o, credsPath) {
  return withRefreshLock(o.claudeDir, async () => {
    const file = await readJson(credsPath);
    const oauth = file.claudeAiOauth;
    if (oauth.expiresAt - Date.now() > REFRESH_BUFFER_MS) return oauth.accessToken; // another process refreshed
    const res = await fetch(o.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oauth.refreshToken, client_id: oauth.clientId || CLIENT_ID, scope: (oauth.scopes || []).join(' ') }),
    });
    if (res.status !== 200) throw new Error(`OAuth token refresh failed: HTTP ${res.status}`);
    const body = await res.json();
    const next = {
      ...oauth,
      accessToken: body.access_token,
      refreshToken: body.refresh_token || oauth.refreshToken,
      expiresAt: Date.now() + body.expires_in * 1000,
      ...(body.scope ? { scopes: body.scope.split(' ') } : {}),
    };
    // Compare-and-swap like the CLI: skip the write if someone else rotated the token meanwhile.
    const current = await readJson(credsPath);
    if (current.claudeAiOauth?.refreshToken === oauth.refreshToken) {
      const tmp = `${credsPath}.cadre-${process.pid}`;
      await writeFile(tmp, JSON.stringify({ ...current, claudeAiOauth: next }), { mode: 0o600 });
      await rename(tmp, credsPath);
    }
    return next.accessToken;
  });
}

async function auth(o) {
  const credsPath = join(o.claudeDir, '.credentials.json');
  const oauth = (await readJson(credsPath)).claudeAiOauth;
  if (!oauth?.accessToken) throw new Error('Cloud sessions need a claude.ai sign-in: run `claude auth login`');
  const orgUuid = (await readJson(o.claudeJsonPath)).oauthAccount?.organizationUuid;
  if (!orgUuid) throw new Error('Unable to get organization UUID');
  const accessToken = oauth.expiresAt - Date.now() > REFRESH_BUFFER_MS ? oauth.accessToken : await refreshToken(o, credsPath);
  return { accessToken, orgUuid };
}

async function api(o, path, { method = 'GET', headers = {} } = {}) {
  const { accessToken, orgUuid } = await auth(o);
  const res = await fetch(`${o.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, 'anthropic-version': '2023-06-01', 'x-organization-uuid': orgUuid, ...headers },
  });
  if (res.status !== 200) throw new Error(`${method} ${path.split('?')[0]} failed: HTTP ${res.status}`);
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

async function describe(o, s) {
  const { state, reason } = cloudSessionState(s);
  const summary = summaryOf(s);
  const branches = branchesOf(s);
  const repo = s.config?.outcomes?.find((x) => x?.type === 'git_repository')?.git_info?.repo;
  return {
    id: s.id,
    title: s.title || 'Untitled',
    state,
    detail: reason || text(summary?.status_detail) || text(s.external_metadata?.task_summary) || '',
    needs_action: text(summary?.needs_action),
    branches,
    pr: repo && branches.length ? await findPr(o, repo, branches) : null,
    url: s.session_url || null,
    cost_usd: s.external_metadata?.usage?.cost_usd ?? null,
  };
}

function bucket(b) {
  return b ? { utilization: b.utilization, resets_at: b.resets_at } : null;
}

/** List anthropic_cloud sessions with the account usage summary, or get one session. */
export async function cloudStatus({ id } = {}, opts = {}) {
  const o = defaults(opts);
  const get = async (sid) => {
    const body = await api(o, `${SESSIONS_PATH}/${encodeURIComponent(sid)}`);
    return describe(o, body.response_shape || body.session);
  };
  if (id) return get(id);
  const [list, usage] = await Promise.all([
    api(o, SESSIONS_PATH),
    api(o, USAGE_PATH, { headers: { 'anthropic-beta': 'oauth-2025-04-20' } }).catch((err) => ({ error: err.message })),
  ]);
  // List rows lack session_url and the post-turn summary, so read each cloud session in full.
  const sessions = await Promise.all((list.data || []).filter((s) => s.environment_kind === 'anthropic_cloud').map((s) => get(s.id)));
  const credit = usage[INFERRED_CLOUD_CREDIT_BUCKET];
  return {
    sessions,
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
