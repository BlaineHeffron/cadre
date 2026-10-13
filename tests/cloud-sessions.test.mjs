import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
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
    const [status, payload] = route ? route(url, body) : [404, { error: 'nope' }];
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

  return { dir, claudeDir, requests, events, routes, ghLog, opts: { baseUrl, tokenUrl: `${baseUrl}/oauth/token`, claudeDir, claudeJsonPath, ghBin, pollMs: 10 } };
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
  f.routes['GET /v1/code/sessions'] = () => [200, { data: [cloudSession('cse_a'), { id: 'cse_rc', environment_kind: 'bridge' }], next_cursor: null }];
  f.routes['GET /v1/code/sessions/cse_a'] = () => [200, { response_shape: cloudSession('cse_a') }];
  f.routes['GET /api/oauth/usage'] = () => [200, {
    five_hour: { utilization: 16, resets_at: 'a', extra: 1 },
    seven_day: { utilization: 27, resets_at: 'b' },
    iguana_necktie: { utilization: 8, resets_at: 'c', limit_dollars: 250, used_dollars: 20.8, remaining_dollars: 229.2 },
  }];

  const result = await cloudStatus({}, f.opts);

  assert.deepEqual(result.sessions, [{
    id: 'cse_a', title: 'Title cse_a', state: 'done', detail: 'PR opened', needs_action: '', branches: ['claude/has-pr'],
    pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' }, url: 'https://claude.ai/code/cshk_cse_a', cost_usd: 1.5,
  }]);
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
  // The bridge (Remote Control) session is never fetched.
  assert.equal(f.requests.some((r) => r.path.endsWith('cse_rc')), false);
  const gh = (await readFile(f.ghLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(gh[0].slice(0, 6), ['pr', 'list', '--repo', 'o/r', '--head', 'claude/has-pr']);
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

test('an expiring token is refreshed under the CLI lock and written back', async (t) => {
  const f = await fixture(t, { expiresAt: Date.now() + 60000 });
  f.routes['POST /oauth/token'] = () => [200, { access_token: REFRESHED, refresh_token: 'refresh-secret-2', expires_in: 3600, scope: 'user:inference user:sessions:claude_code' }];
  f.routes['GET /v1/code/sessions/cse_a'] = () => [200, { response_shape: cloudSession('cse_a', { config: {} }) }];
  // A stale lock left by a dead process is taken over.
  await mkdir(join(f.claudeDir, '.oauth_refresh.lock'));
  const old = new Date(Date.now() - 120000);
  const { utimes } = await import('node:fs/promises');
  await utimes(join(f.claudeDir, '.oauth_refresh.lock'), old, old);

  await cloudStatus({ id: 'cse_a' }, f.opts);

  const tokenReq = f.requests.find((r) => r.path === '/oauth/token');
  assert.deepEqual(JSON.parse(tokenReq.body), {
    grant_type: 'refresh_token', refresh_token: 'refresh-secret-1', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', scope: 'user:inference user:sessions:claude_code',
  });
  assert.equal(f.requests.find((r) => r.path === '/v1/code/sessions/cse_a').headers.authorization, `Bearer ${REFRESHED}`);
  const credsPath = join(f.claudeDir, '.credentials.json');
  const saved = JSON.parse(await readFile(credsPath, 'utf8'));
  assert.equal(saved.other, 'kept');
  assert.equal(saved.claudeAiOauth.accessToken, REFRESHED);
  assert.equal(saved.claudeAiOauth.refreshToken, 'refresh-secret-2');
  assert.ok(saved.claudeAiOauth.expiresAt > Date.now() + 3000000);
  assert.equal((await stat(credsPath)).mode & 0o777, 0o600);
  await assert.rejects(stat(join(f.claudeDir, '.oauth_refresh.lock')), { code: 'ENOENT' });
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
  for (const name of ['cloud_status', 'cloud_output', 'cloud_send']) assert.ok(names.includes(name), name);
  await assert.rejects(mcp.handleToolCall('cloud_send', { id: 'cse_a' }));
  await assert.rejects(mcp.handleToolCall('cloud_send', { id: 'cse_a', text: 'hi', wait_s: 601 }));
  await assert.rejects(mcp.handleToolCall('cloud_output', { id: 'cse_a', limit: 0 }));
});
