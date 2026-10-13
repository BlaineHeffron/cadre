import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { cloudSessionsPlugin } from '../modules/integrations/cloud-sessions-plugin.mjs';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';
import {
  cloudLaunch,
  cloudOutput,
  cloudSend,
  cloudSessionState,
  cloudStatus,
  findCloudReply,
} from '../modules/integrations/cloud-sessions.mjs';

test('cloudSessionState mirrors the CLI mapping', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const cases = [
    [{ worker_status: 'idle', status_bucket: 'completed' }, { state: 'done' }],
    [{ worker_status: 'idle' }, { state: 'done' }],
    [{ worker_status: 'idle', status_bucket: 'working' }, { state: 'working' }],
    [{ worker_status: 'idle', status_bucket: 'blocked' }, { state: 'blocked' }],
    [{ worker_status: 'idle', status_bucket: 'failed', post_turn_summary: { status_detail: 'tests broke' } }, { state: 'failed', reason: 'tests broke' }],
    [{ worker_status: 'idle', status_bucket: 'failed' }, { state: 'failed', reason: 'the last turn failed' }],
    [{ status: 'paused', worker_status: 'running' }, { state: 'stopped', reason: 'paused · reply to resume' }],
    [{ status: 'paused', worker_status: 'requires_action' }, { state: 'blocked' }],
    [{ status: 'active', worker_status: 'requires_action' }, { state: 'working' }],
    [{ worker_status: 'running', connection_status: 'disconnected' }, { state: 'stopped', reason: 'lost contact with the cloud environment' }],
    [{ worker_status: 'running', connection_status: 'connected' }, { state: 'working' }],
    [{}, { state: 'working' }],
    [{ status: 'failed' }, { state: 'failed', reason: 'the cloud environment could not be provisioned' }],
    [{ external_metadata: { last_init_error: { message: 'no image', recoverable: false } } }, { state: 'failed', reason: 'no image' }],
    // A recent recoverable init error is not a failure yet; a stale one is.
    [{ external_metadata: { last_init_error: { message: 'retrying', recoverable: true, at: '2026-10-13T11:59:30Z' } } }, { state: 'working' }],
    [{ external_metadata: { last_init_error: { message: 'retrying', recoverable: true, at: '2026-10-13T11:50:00Z' } } }, { state: 'failed', reason: 'retrying' }],
    [{ worker_status: 'idle', external_metadata: { last_init_error: { message: 'gone', error_kind: 'environment_deleted' } } }, { state: 'failed', reason: 'gone' }],
    [{ environment_kind: 'bridge', worker_status: 'idle', external_metadata: { last_init_error: { message: 'x' } } }, { state: 'done' }],
  ];
  for (const [session, expected] of cases) assert.deepEqual(cloudSessionState(session, now), expected, JSON.stringify(session));
});

test('findCloudReply ignores the previous turn result until our own message appears', () => {
  const state = { sawOwnMessage: false };
  const stale = [{ sequence_num: '6', event_type: 'result', payload: { result: 'old' } }];
  assert.equal(findCloudReply(stale, state), null);
  // A worker-side user event (tool result) is not our message.
  assert.equal(findCloudReply([{ event_type: 'user', source: 'worker' }, { event_type: 'result', payload: { result: 'old2' } }], state), null);
  assert.equal(findCloudReply([{ event_type: 'user', source: 'client' }], state), null);
  assert.equal(state.sawOwnMessage, true);
  const reply = { sequence_num: '9', event_type: 'result', payload: { result: 'new' } };
  assert.equal(findCloudReply([{ event_type: 'assistant' }, reply], state), reply);
});

const ACCESS = 'access-secret-1';
const REFRESHED = 'access-secret-2';

async function fixture(t, { expiresAt = Date.now() + 3600000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-cloud-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const claudeDir = join(dir, '.claude');
  await mkdir(claudeDir);
  await writeFile(join(claudeDir, '.credentials.json'), JSON.stringify({
    other: 'kept',
    claudeAiOauth: { accessToken: ACCESS, refreshToken: 'refresh-secret-1', expiresAt, scopes: ['user:inference', 'user:sessions:claude_code'] },
  }));
  const claudeJsonPath = join(dir, '.claude.json');
  await writeFile(claudeJsonPath, JSON.stringify({ oauthAccount: { organizationUuid: 'org-1' } }));

  const requests = [];
  const events = [];
  const routes = {};
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://x');
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    const route = routes[`${req.method} ${url.pathname}`];
    const [status, payload] = route ? await route(url, body) : [404, { error: 'nope' }];
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const ghLog = join(dir, 'gh.log');
  const ghBin = join(dir, 'gh');
  await writeFile(ghBin, `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const branch = process.argv[process.argv.indexOf('--head') + 1];
process.stdout.write(branch === 'claude/has-pr' ? '[{"number":7,"url":"https://github.com/o/r/pull/7","state":"OPEN"}]' : '[]');
`);
  await chmod(ghBin, 0o755);

  return { dir, claudeDir, requests, events, routes, ghLog, opts: { baseUrl, claudeDir, claudeJsonPath, ghBin, pollMs: 10, rereadMs: 10 } };
}

function eventsRoute(events) {
  return (url) => {
    const desc = url.searchParams.get('sort_order') === 'desc';
    const cursor = url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor')) : null;
    const limit = Number(url.searchParams.get('limit') || 50);
    let rows = events.filter((e) => cursor === null || (desc ? Number(e.sequence_num) < cursor : Number(e.sequence_num) > cursor));
    if (desc) rows = rows.slice().reverse();
    rows = rows.slice(0, limit);
    return [200, { data: rows, next_cursor: rows.at(-1)?.sequence_num ?? null }];
  };
}

const cloudSession = (id, extra = {}) => ({
  id,
  title: `Title ${id}`,
  environment_kind: 'anthropic_cloud',
  status: 'active',
  worker_status: 'idle',
  status_bucket: 'completed',
  session_url: `https://claude.ai/code/cshk_${id}`,
  config: { outcomes: [{ type: 'git_repository', git_info: { repo: 'o/r', branches: ['claude/outcome'] } }] },
  external_metadata: { current_branches: { '': 'claude/has-pr' }, usage: { cost_usd: 1.5 }, post_turn_summary: { status_detail: 'PR opened', needs_action: '' } },
  ...extra,
});

test('cloudStatus lists cloud sessions with usage, sends auth headers and never returns tokens', async (t) => {
  const f = await fixture(t);
  f.routes['GET /v1/code/sessions'] = (url) => (url.searchParams.get('cursor') === 'p2'
    ? [200, { data: [{ id: 'cse_c', environment_kind: 'anthropic_cloud' }, { id: 'cse_rc2', environment_kind: 'bridge' }], next_cursor: null }]
    : [200, { data: [cloudSession('cse_a'), { id: 'cse_rc', environment_kind: 'bridge' }], next_cursor: 'p2' }]);
  f.routes['GET /v1/code/sessions/cse_a'] = () => [200, { response_shape: cloudSession('cse_a') }];
  f.routes['GET /v1/code/sessions/cse_c'] = () => [200, { response_shape: cloudSession('cse_c', { config: {}, external_metadata: {} }) }];
  f.routes['GET /api/oauth/usage'] = () => [200, {
    five_hour: { utilization: 16, resets_at: 'a', extra: 1 },
    seven_day: { utilization: 27, resets_at: 'b' },
    iguana_necktie: { utilization: 8, resets_at: 'c', limit_dollars: 250, used_dollars: 20.8, remaining_dollars: 229.2 },
  }];

  const result = await cloudStatus({}, f.opts);

  assert.equal(result.truncated, undefined);
  assert.deepEqual(result.sessions.map((s) => s.id), ['cse_a', 'cse_c']);
  assert.deepEqual(f.requests.filter((r) => r.path === '/v1/code/sessions').map((r) => r.query), [{ limit: '100' }, { limit: '100', cursor: 'p2' }]);
  assert.deepEqual(result.sessions[0], {
    id: 'cse_a', title: 'Title cse_a', state: 'done', detail: 'PR opened', needs_action: '', branches: ['claude/has-pr'],
    pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' }, url: 'https://claude.ai/code/cshk_cse_a', cost_usd: 1.5,
  });
  assert.deepEqual(result.usage.five_hour, { utilization: 16, resets_at: 'a' });
  assert.deepEqual(result.usage.seven_day, { utilization: 27, resets_at: 'b' });
  assert.equal(result.usage.cloud_credit.inferred, true);
  assert.match(result.usage.cloud_credit.note, /Inferred/);
  assert.equal(result.usage.cloud_credit.remaining_dollars, 229.2);
  assert.equal(JSON.stringify(result).includes('secret'), false);

  const usageReq = f.requests.find((r) => r.path === '/api/oauth/usage');
  assert.equal(usageReq.headers['anthropic-beta'], 'oauth-2025-04-20');
  for (const r of f.requests) {
    assert.equal(r.headers.authorization, `Bearer ${ACCESS}`);
    assert.equal(r.headers['x-organization-uuid'], 'org-1');
    assert.equal(r.headers['anthropic-version'], '2023-06-01');
  }
  // Bridge (Remote Control) sessions are never fetched, on any page.
  assert.equal(f.requests.some((r) => /cse_rc/.test(r.path)), false);
  const gh = (await readFile(f.ghLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(gh[0].slice(0, 6), ['pr', 'list', '--repo', 'o/r', '--head', 'claude/has-pr']);
});

test('cloudStatus stops the list walk at the CLI page cap and says so', async (t) => {
  const f = await fixture(t);
  let page = 0;
  f.routes['GET /v1/code/sessions'] = () => [200, { data: [{ id: `cse_${++page}`, environment_kind: 'anthropic_cloud' }], next_cursor: `p${page}` }];
  for (let i = 1; i <= 11; i++) f.routes[`GET /v1/code/sessions/cse_${i}`] = () => [200, { response_shape: cloudSession(`cse_${i}`, { config: {}, external_metadata: {} }) }];
  f.routes['GET /api/oauth/usage'] = () => [500, {}];
  const result = await cloudStatus({}, f.opts);
  assert.equal(result.sessions.length, 10);
  assert.match(result.truncated, /10 pages of 100/);
  assert.match(result.usage.error, /HTTP 500/);
});

test('cloudStatus gets one session, falls back to outcome branches and reports HTTP errors without tokens', async (t) => {
  const f = await fixture(t);
  f.routes['GET /v1/code/sessions/cse_b'] = () => [200, { response_shape: cloudSession('cse_b', {
    worker_status: 'running', status_bucket: 'working', external_metadata: { task_summary: 'building' },
  }) }];
  const one = await cloudStatus({ id: 'cse_b' }, f.opts);
  assert.equal(one.state, 'working');
  assert.equal(one.detail, 'building');
  assert.deepEqual(one.branches, ['claude/outcome']);
  assert.equal(one.pr, null);
  assert.equal(one.cost_usd, null);

  await assert.rejects(cloudStatus({ id: 'cse_missing' }, f.opts), (err) => {
    assert.match(err.message, /HTTP 404/);
    assert.equal(err.message.includes('secret'), false);
    return true;
  });
});

test('an expired token is re-read once, never refreshed, and the error names the cause', async (t) => {
  const f = await fixture(t, { expiresAt: Date.now() + 60000 });
  const credsPath = join(f.claudeDir, '.credentials.json');
  const before = await readFile(credsPath, 'utf8');
  f.routes['GET /v1/code/sessions/cse_a'] = () => [200, { response_shape: cloudSession('cse_a', { config: {} }) }];

  await assert.rejects(cloudStatus({ id: 'cse_a' }, f.opts), {
    message: 'Claude OAuth token expired; it refreshes when any Claude Code session runs.',
  });

  assert.equal(await readFile(credsPath, 'utf8'), before);
  assert.deepEqual(await readdir(f.claudeDir), ['.credentials.json']);
  assert.equal(f.requests.length, 0);
});

test('a re-read that finds a token refreshed by a Claude Code session uses it without POSTing', async (t) => {
  const f = await fixture(t, { expiresAt: Date.now() + 60000 });
  const credsPath = join(f.claudeDir, '.credentials.json');
  f.routes['GET /v1/code/sessions/cse_a'] = () => [200, { response_shape: cloudSession('cse_a', { config: {} }) }];
  // The CLI rewrites the file while Cadre waits before its one re-read.
  setTimeout(() => writeFile(credsPath, JSON.stringify({ claudeAiOauth: { accessToken: REFRESHED, expiresAt: Date.now() + 3600000 } })), 5);

  await cloudStatus({ id: 'cse_a' }, { ...f.opts, rereadMs: 100 });

  assert.deepEqual(f.requests.map((r) => `${r.method} ${r.path}`), ['GET /v1/code/sessions/cse_a']);
  assert.equal(f.requests[0].headers.authorization, `Bearer ${REFRESHED}`);
});

test('cloudOutput tails newest events or continues after a sequence number', async (t) => {
  const f = await fixture(t);
  f.events.push(
    { sequence_num: '1', event_type: 'user', source: 'client', payload: { message: { role: 'user', content: 'do it' } } },
    { sequence_num: '2', event_type: 'system', payload: { subtype: 'init' } },
    { sequence_num: '3', event_type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'working on it' }, { type: 'tool_use', name: 'Bash' }] } } },
    { sequence_num: '4', event_type: 'user', payload: { message: { content: [{ type: 'tool_result', content: 'ok' }] } } },
    { sequence_num: '5', event_type: 'assistant', payload: { message: { content: [{ type: 'tool_use', name: 'Edit' }] } } },
    { sequence_num: '6', event_type: 'result', payload: { subtype: 'success', result: 'done' } },
  );
  f.routes['GET /v1/code/sessions/cse_a/events'] = eventsRoute(f.events);

  const tail = await cloudOutput({ id: 'cse_a', limit: 5 }, f.opts);
  assert.deepEqual(tail, {
    lines: [
      { seq: 3, role: 'assistant', text: 'working on it\n[Bash]' },
      { seq: 5, role: 'assistant', text: '[Edit]' },
      { seq: 6, role: 'result', text: 'success: done' },
    ],
    last_assistant_text: 'working on it',
    next_seq: 6,
  });
  const more = await cloudOutput({ id: 'cse_a', after_seq: 0, limit: 2 }, f.opts);
  assert.deepEqual(more.lines, [{ seq: 1, role: 'user', text: 'do it' }]);
  assert.equal(more.next_seq, 2);
  const empty = await cloudOutput({ id: 'cse_a', after_seq: 6 }, f.opts);
  assert.deepEqual(empty, { lines: [], last_assistant_text: '', next_seq: 6 });
});

async function fakeClaude(f, events) {
  const bin = join(f.dir, 'claude');
  const argsLog = join(f.dir, 'claude.log');
  await writeFile(bin, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));
const id = process.argv[process.argv.indexOf('--cloud') + 1];
process.stdout.write(JSON.stringify({ ok: true, session_id: id, url: 'https://claude.ai/code/' + id }));
`);
  await chmod(bin, 0o755);
  f.routes['GET /v1/code/sessions/cse_a/events'] = eventsRoute(events);
  return { claudeBin: bin, argsLog };
}

test('cloudSend uses the documented CLI path and returns immediately without wait_s', async (t) => {
  const f = await fixture(t);
  const { claudeBin, argsLog } = await fakeClaude(f, f.events);
  const sent = await cloudSend({ id: 'cse_a', text: 'hello' }, { ...f.opts, claudeBin });
  assert.deepEqual(sent, { ok: true, id: 'cse_a', url: 'https://claude.ai/code/cse_a', status: 'sent' });
  assert.deepEqual(JSON.parse(await readFile(argsLog, 'utf8')), ['-p', 'hello', '--cloud', 'cse_a', '--output-format', 'json']);
  assert.equal(f.requests.length, 0);
});

test('cloudSend waits past the stale previous result for the reply to its own message', async (t) => {
  const f = await fixture(t);
  const events = [{ sequence_num: '5', event_type: 'result', payload: { result: 'older turn' } }];
  const { claudeBin } = await fakeClaude(f, events);
  let polls = 0;
  const route = f.routes['GET /v1/code/sessions/cse_a/events'];
  f.routes['GET /v1/code/sessions/cse_a/events'] = (url) => {
    if (url.searchParams.get('sort_order') === 'asc') {
      polls += 1;
      // The previous turn's result lands after the baseline, before our message.
      if (polls === 1) events.push({ sequence_num: '6', event_type: 'result', payload: { result: 'previous turn' } });
      if (polls === 2) events.push({ sequence_num: '7', event_type: 'user', source: 'client', payload: { message: { content: 'hello' } } });
      if (polls === 3) {
        events.push(
          { sequence_num: '8', event_type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'Hi there' }] } } },
          { sequence_num: '9', event_type: 'result', payload: { result: '', is_error: false } },
        );
      }
    }
    return route(url);
  };

  const reply = await cloudSend({ id: 'cse_a', text: 'hello', wait_s: 5 }, { ...f.opts, claudeBin });

  assert.deepEqual(reply, { ok: true, id: 'cse_a', url: 'https://claude.ai/code/cse_a', status: 'replied', reply: 'Hi there', is_error: false, next_seq: 9 });
  const cursors = f.requests.filter((r) => r.query.sort_order === 'asc').map((r) => r.query.cursor);
  assert.deepEqual(cursors, ['5', '6', '7']);
});

test('cloudSend reports a timeout with the last cursor when no reply arrives', async (t) => {
  const f = await fixture(t);
  const { claudeBin } = await fakeClaude(f, []);
  const reply = await cloudSend({ id: 'cse_a', text: 'hello', wait_s: 0.05 }, { ...f.opts, claudeBin });
  assert.equal(reply.status, 'timeout');
  assert.equal(reply.next_seq, 0);
});

test('monitor MCP exposes the cloud tools and validates their arguments', async () => {
  const { buildMonitorMcpServer } = await import('../modules/platform/monitor-mcp.mjs');
  const mcp = buildMonitorMcpServer({ requestImpl: async () => ({}) });
  const names = mcp.listTools().map((tool) => tool.name);
  for (const name of ['cloud_status', 'cloud_output', 'cloud_send', 'cloud_launch', 'cloud_watch', 'cloud_attach']) assert.ok(names.includes(name), name);
  await assert.rejects(mcp.handleToolCall('cloud_launch', { prompt: 'hi', repo: 'not a repo' }));
  await assert.rejects(mcp.handleToolCall('cloud_attach', { id: 'cse_a' }));
  await assert.rejects(mcp.handleToolCall('cloud_send', { id: 'cse_a' }));
  await assert.rejects(mcp.handleToolCall('cloud_send', { id: 'cse_a', text: 'hi', wait_s: 601 }));
  await assert.rejects(mcp.handleToolCall('cloud_output', { id: 'cse_a', limit: 0 }));
});

test('cloudLaunch posts the CLI launch shape to the anthropic_cloud environment', async (t) => {
  const f = await fixture(t);
  f.routes['GET /v1/environment_providers'] = () => [200, { environments: [
    { kind: 'bridge', environment_id: 'env_rc' }, { kind: 'anthropic_cloud', environment_id: 'env_cloud' },
  ] }];
  f.routes['POST /v1/code/sessions'] = () => [201, { session: { id: 'cse_new', session_url: 'https://claude.ai/code/cse_new' } }];

  const launched = await cloudLaunch({ prompt: 'Fix the bug', repo: 'o/r', ref: 'main', name: 'Fix: the bug!', model: 'claude-opus-5-5' }, f.opts);

  assert.deepEqual(launched, { id: 'cse_new', url: 'https://claude.ai/code/cse_new' });
  const post = f.requests.find((r) => r.method === 'POST');
  assert.equal(post.headers['content-type'], 'application/json');
  assert.equal(post.headers.authorization, `Bearer ${ACCESS}`);
  const body = JSON.parse(post.body);
  assert.match(body.events[0].payload.uuid, /^[0-9a-f-]{36}$/);
  delete body.events[0].payload.uuid;
  assert.deepEqual(body, {
    title: 'Fix: the bug!',
    environment_id: 'env_cloud',
    events: [{ payload: { session_id: '', type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'Fix the bug' } } }],
    config: {
      sources: [{ type: 'git_repository', url: 'https://github.com/o/r', revision: 'main' }],
      outcomes: [{ type: 'git_repository', git_info: { type: 'github', repo: 'o/r', branches: ['claude/fix-the-bug'] } }],
      model: 'claude-opus-5-5',
    },
  });

  f.routes['GET /v1/environment_providers'] = () => [200, { environments: [{ kind: 'bridge', environment_id: 'env_rc' }] }];
  await assert.rejects(cloudLaunch({ prompt: 'x', repo: 'o/r' }, f.opts), /No anthropic_cloud environment/);
});

function memoryStore() {
  let data = null;
  return { load: async () => structuredClone(data), save: async (next) => { data = structuredClone(next); } };
}

// A bare app: the watcher's agent-bus edges (DM, rooms) are recorded, and requests run as `owner`.
async function watcherApp(t, f, store, owner) {
  const app = Fastify();
  const dms = [];
  const watches = [];
  const bus = { dmStatus: 200 };
  // Records accepted DMs; a DM the bus refuses is counted as an attempt only.
  app.decorate('agentBusLifecycle', {
    directMessage: async (dm) => {
      bus.attempts = (bus.attempts || 0) + 1;
      if (bus.dmStatus === 200) dms.push(dm);
      return { statusCode: bus.dmStatus, payload: {} };
    },
  });
  app.addHook('onRequest', async (req) => { req.duenoAuth = { principal: { type: 'agent', ...owner } }; });
  await cloudSessionsPlugin(app, { store, cloudOpts: f.opts, watchPr: async (watch, creator) => { watches.push({ watch, creator }); } });
  await app.ready();
  t.after(() => app.close());
  return { app, dms, watches, bus, step: () => app.agentBusLifecycle.cloudSessions.step() };
}

test('the watcher DMs the launching owner on each transition once, across a restart, and registers new PRs', async (t) => {
  const f = await fixture(t);
  const owner = { kind: 'claude', sessionId: 'claude-1' };
  const store = memoryStore();
  let session = cloudSession('cse_w', { worker_status: 'running', status_bucket: 'working', external_metadata: { current_branches: { '': 'claude/none' } } });
  f.routes['GET /v1/environment_providers'] = () => [200, { environments: [{ kind: 'anthropic_cloud', environment_id: 'env_cloud' }] }];
  f.routes['POST /v1/code/sessions'] = () => [200, { session: { id: 'cse_w', session_url: 'https://claude.ai/code/cse_w' } }];
  f.routes['GET /v1/code/sessions/cse_w'] = () => (session ? [200, { response_shape: session }] : [404, {}]);
  const set = (extra) => { session = cloudSession('cse_w', extra); };

  const first = await watcherApp(t, f, store, owner);
  const launched = await first.app.inject({ method: 'POST', url: '/api/cloud/sessions', payload: { prompt: 'go', repo: 'o/r' } });
  assert.deepEqual(launched.json(), { id: 'cse_w', url: 'https://claude.ai/code/cse_w' });
  await first.step();
  assert.deepEqual(first.dms, []);

  set({ external_metadata: { current_branches: { '': 'claude/has-pr' }, post_turn_summary: { status_detail: 'Fixed it' } } });
  await first.step();
  assert.equal(first.dms.length, 1);
  assert.deepEqual(first.dms[0].from, { kind: 'cloud', sessionId: 'cse_w' });
  assert.deepEqual(first.dms[0].target, owner);
  assert.match(first.dms[0].body, /done: Fixed it\nPR opened #7 https:\/\/github.com\/o\/r\/pull\/7/);
  assert.deepEqual(first.watches, [{ watch: { repo: 'o/r', number: 7 }, creator: owner }]);
  await first.step();
  assert.equal(first.dms.length, 1);

  // A restarted Cadre reads the last-seen state and does not repeat the notice.
  await first.app.close();
  const second = await watcherApp(t, f, store, owner);
  await second.step();
  assert.deepEqual(second.dms, []);
  assert.deepEqual(second.watches, []);

  set({ status_bucket: 'failed', external_metadata: { current_branches: { '': 'claude/has-pr' }, post_turn_summary: { status_detail: 'tests broke' } } });
  await second.step();
  set({ status_bucket: 'blocked', external_metadata: { current_branches: { '': 'claude/has-pr' }, post_turn_summary: { needs_action: 'Which DB?' } } });
  await second.step();
  await second.step();
  // A new question while still blocked is a new notice.
  set({ status_bucket: 'blocked', external_metadata: { current_branches: { '': 'claude/has-pr' }, post_turn_summary: { needs_action: 'Which port?' } } });
  await second.step();
  const notices = () => second.dms.map((dm) => dm.body.split('\n')[0].replace(/^Cloud session cse_w \(Title cse_w\) /, ''));
  assert.deepEqual(notices(), ['failed: tests broke', 'blocked: Which DB?', 'blocked: Which port?']);

  // A refused DM leaves the last-seen state alone, so later passes (and restarts) retry it.
  second.bus.dmStatus = 500;
  second.bus.attempts = 0;
  set({ status_bucket: 'failed', external_metadata: { current_branches: { '': 'claude/has-pr' }, post_turn_summary: { status_detail: 'disk full' } } });
  await second.step();
  await second.step();
  assert.equal(second.bus.attempts, 2);
  assert.equal(second.app.agentBusLifecycle.cloudSessions.get('cse_w').state, 'blocked');
  second.bus.dmStatus = 200;
  await second.step();
  await second.step();
  assert.equal(second.bus.attempts, 3);
  assert.deepEqual(notices().slice(3), ['failed: disk full']);

  // A deleted session stops being tracked.
  session = null;
  await second.step();
  assert.equal(second.app.agentBusLifecycle.cloudSessions.get('cse_w'), null);
});

test('cloud_watch baselines an existing session without notifying and keeps its first owner', async (t) => {
  const f = await fixture(t);
  f.routes['GET /v1/code/sessions/cse_a'] = () => [200, { response_shape: cloudSession('cse_a') }];
  const w = await watcherApp(t, f, memoryStore(), { kind: 'claude', sessionId: 'claude-1' });
  const watched = await w.app.inject({ method: 'POST', url: '/api/cloud/watch', payload: { id: 'cse_a' } });
  assert.deepEqual(watched.json(), { id: 'cse_a', state: 'done', status: 'watching' });
  await w.step();
  assert.deepEqual(w.dms, []);
  assert.deepEqual(w.watches, []);
  w.app.agentBusLifecycle.cloudSessions.get('cse_a').owner = { kind: 'codex', sessionId: 'codex-1' };
  const taken = await w.app.inject({ method: 'POST', url: '/api/cloud/watch', payload: { id: 'cse_a' } });
  assert.equal(taken.statusCode, 403);
});

test('cloud_attach relays room messages to the cloud session and its replies back, without echoing', async (t) => {
  const f = await fixture(t);
  process.env.INTERNAL_BYPASS_TOKEN = 'cloud-attach-test';
  t.after(() => { delete process.env.INTERNAL_BYPASS_TOKEN; });
  const sendLog = join(f.dir, 'sends.log');
  const claudeBin = join(f.dir, 'claude');
  await writeFile(claudeBin, `#!/usr/bin/env node
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(sendLog)}, JSON.stringify(args) + '\\n');
process.stdout.write(JSON.stringify({ ok: true, session_id: args[args.indexOf('--cloud') + 1] }));
`);
  await chmod(claudeBin, 0o755);
  const sends = async () => (await readFile(sendLog, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  f.events.push(
    { sequence_num: '1', event_type: 'user', source: 'client', payload: { message: { content: 'old task' } } },
    { sequence_num: '2', event_type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'old reply' }] } } },
  );
  f.routes['GET /v1/code/sessions/cse_a/events'] = eventsRoute(f.events);
  f.routes['GET /v1/code/sessions/cse_a'] = () => [200, { response_shape: cloudSession('cse_a', { external_metadata: {} }) }];

  const h = await createAgentBusHarness({ pollMs: 60000, beforeReady: (app) => cloudSessionsPlugin(app, { store: memoryStore(), cloudOpts: { ...f.opts, claudeBin } }) });
  t.after(() => h.cleanup());
  const owner = { kind: 'claude', sessionId: 'claude-1' };
  const peer = { kind: 'codex', sessionId: 'codex-1' };
  const cloud = { kind: 'cloud', sessionId: 'cse_a' };
  const thread = await h.store.createThread({ title: 'cloud room', participants: [owner, peer], createdBy: owner });
  const { buildMonitorMcpServer } = await import('../modules/platform/monitor-mcp.mjs');
  const { buildInProcessFastifyRequest } = await import('../modules/agent-bus/in-process-mcp.mjs');
  const { buildInternalBypassHeaders } = await import('../modules/platform/auth.mjs');
  const request = buildInProcessFastifyRequest({ app: h.app, buildHeaders: () => buildInternalBypassHeaders({ authToken: h.authToken }) });
  const mcp = buildMonitorMcpServer({ requestImpl: request });
  const as = (ref) => ({ authContext: { authenticated: true, principal: { type: 'agent', ...ref } } });

  await assert.rejects(mcp.handleToolCall('cloud_attach', { id: 'cse_a', thread_id: thread.id }, as({ kind: 'pi', sessionId: 'pi-1' })), /Room owner or participant/);
  const attached = await mcp.handleToolCall('cloud_attach', { id: 'cse_a', thread_id: thread.id }, as(owner));
  assert.deepEqual(attached, { id: 'cse_a', thread_id: thread.id, status: 'attached' });
  assert.ok(h.store.getThread(thread.id).thread.participants.some((p) => p.kind === 'cloud' && p.sessionId === 'cse_a'));

  // Room -> cloud: a peer's message goes out through `claude -p --cloud`, without the room_send hint.
  const sent = await request('/api/agent-bus/messages', { method: 'POST', body: { threadId: thread.id, from: peer, body: 'Please add tests' } });
  assert.equal(sent.deliveries.find((d) => d.target.kind === 'cloud').status, 'injected');
  const [args] = await sends();
  assert.deepEqual([args[0], args[2], args[3]], ['-p', '--cloud', 'cse_a']);
  assert.match(args[1], /from=codex:codex-1\]\nPlease add tests\n\[\/ROOM_MESSAGE\]$/);

  // Cloud -> room: new assistant text after the attach cursor comes back as the cloud participant.
  f.events.push(
    { sequence_num: '3', event_type: 'user', source: 'client', payload: { message: { content: args[1] } } },
    { sequence_num: '4', event_type: 'assistant', payload: { message: { content: [{ type: 'text', text: 'Tests added' }, { type: 'tool_use', name: 'Bash' }] } } },
    { sequence_num: '5', event_type: 'assistant', payload: { message: { content: [{ type: 'tool_use', name: 'Edit' }] } } },
    { sequence_num: '6', event_type: 'result', payload: { result: 'Tests added' } },
  );
  await h.app.agentBusLifecycle.cloudSessions.step();
  await h.app.agentBusLifecycle.cloudSessions.step();
  const fromCloud = h.store.getThread(thread.id).messages.filter((m) => m.from.kind === 'cloud');
  assert.deepEqual(fromCloud.map((m) => m.body), ['Tests added']);
  const relayed = h.store.getThread(thread.id).deliveries.filter((d) => d.messageId === fromCloud[0].id);
  assert.deepEqual(relayed.map((d) => d.target).sort((a, b) => a.kind.localeCompare(b.kind)), [peer, owner].sort((a, b) => a.kind.localeCompare(b.kind)));
  assert.equal(relayed.some((d) => d.target.kind === cloud.kind), false);
  assert.equal((await sends()).length, 1);

  // An owner reply in the watcher's notice DM is never forwarded; room messages still are.
  const dm = await h.app.agentBusLifecycle.directMessage({ from: cloud, target: owner, body: 'Cloud session cse_a done: ok' });
  assert.equal(dm.statusCode, 200);
  const reply = await request('/api/agent-bus/messages', { method: 'POST', body: { threadId: dm.payload.thread.id, from: owner, body: 'done, thanks' } });
  assert.equal(reply.deliveries[0].resolution, 'not_forwarded');
  assert.equal((await sends()).length, 1);
  await request('/api/agent-bus/messages', { method: 'POST', body: { threadId: thread.id, from: owner, body: 'One more thing' } });
  assert.equal((await sends()).length, 2);
});
