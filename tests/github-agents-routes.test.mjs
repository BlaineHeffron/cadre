import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { rm } from 'node:fs/promises';
import { buildGithubAgentRepoStore } from '../modules/integrations/github-agents.mjs';
import {
  defaultSessionLauncher,
  githubAgentsPlugin,
} from '../modules/integrations/github-agents-plugin.mjs';

const TEST_TOKEN = 'github-route-token';
const tempFiles = [];
let activeToken = TEST_TOKEN;

afterEach(async () => {
  while (tempFiles.length > 0) {
    await rm(tempFiles.pop(), { force: true });
  }
});

describe('GitHub agents routes', () => {
  it('queues the default launcher startup prompt through the canonical command gate', async () => {
    const creates = [];
    const commands = [];
    const result = await defaultSessionLauncher({
      prompt: 'Implement issue 98',
      workDir: '/repo/demo',
      displayName: 'Issue 98',
      provider: 'codex',
      model: 'gpt-5.5',
      thinkingLevel: 'medium',
      metadata: { github_number: 98 },
      createSession: async (backendType, input) => {
        creates.push({ backendType, input });
        return { id: 'session-98', sessionName: 'codex-session-98' };
      },
      enqueueSessionCommand: async (backendType, sessionId, input) => {
        commands.push({ backendType, sessionId, input });
        return { ok: true };
      },
    });

    assert.equal(result.id, 'session-98');
    assert.equal(creates[0].backendType, 'codex');
    assert.deepEqual(commands, [{
      backendType: 'codex',
      sessionId: 'session-98',
      input: {
        source: 'github_agent_startup',
        operation: 'startup',
        text: 'Implement issue 98',
        enter: true,
      },
    }]);
  });

  it('requires auth for GitHub agent routes', async () => {
    const app = await buildApp({ requireAuth: true });
    const res = await app.inject({ method: 'GET', url: '/api/agents/github' });

    assert.equal(res.statusCode, 401);
    await app.close();
  });

  it('upserts and lists safe repo payloads without token values', async () => {
    const app = await buildApp({
      env: { GITHUB_TOKEN_REF: 'secret-token' },
    });

    const upsert = await app.inject({
      method: 'POST',
      url: '/api/agents/github',
      headers: authHeaders(),
      payload: {
        owner: 'octo',
        repo: 'demo',
        authRef: 'GITHUB_TOKEN_REF',
        prEnabled: true,
        issueEnabled: false,
      },
    });
    assert.equal(upsert.statusCode, 200);
    assert.equal(upsert.json().repo.id, 'octo/demo');
    assert.equal(upsert.json().repo.authRef, 'GITHUB_TOKEN_REF');

    const list = await app.inject({
      method: 'GET',
      url: '/api/agents/github',
      headers: authHeaders(),
    });
    const body = list.json();
    assert.equal(list.statusCode, 200);
    assert.equal(body.enabled, false);
    assert.equal(body.repos.length, 1);
    assert.equal(JSON.stringify(body).includes('secret-token'), false);
    assert.deepEqual(Object.keys(body.repos[0]).sort(), [
      'authRef',
      'autoReviewEnabled',
      'enabled',
      'id',
      'issueEnabled',
      'lastError',
      'lastEvent',
      'lastPollMs',
      'lastSeenIssueNumber',
      'lastSeenPrNumber',
      'lastSpawnSessionId',
      'owner',
      'prEnabled',
      'repo',
    ].sort());
    await app.close();
  });

  it('rejects inline GitHub token material on upsert', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/github',
      headers: authHeaders(),
      payload: { owner: 'octo', repo: 'demo', authRef: 'ghp_inline_secret' },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'github_auth_ref_invalid');
    await app.close();
  });

  it('poll-now with mock fetch spawns a scoped session and returns safe results', async () => {
    const launches = [];
    const broadcasts = [];
    const fetchCalls = [];
    const app = await buildApp({
      configOverrides: {
        enabled: true,
        repoPaths: { 'octo/demo': '/repo/demo' },
        workDir: '/tmp/github-agents',
        maxSpawnsPerPoll: 5,
      },
      env: { GITHUB_TOKEN_REF: 'secret-token' },
      fetchImpl: mockGithubFetch(fetchCalls, {
        pulls: [githubItem(4, 'PR 4')],
        issues: [githubItem(3, 'Issue 3')],
      }),
      wsManager: { broadcast: (channel, type, data) => broadcasts.push({ channel, type, data }) },
      createPrWorktree: async () => ({
        repoPath: '/repo/demo',
        worktreePath: '/tmp/github-agents/worktrees/octo-demo/pr-4/demo',
        branch: 'dueno-fleet/pr-4-test',
        sourceBranch: 'main',
        sourceHead: 'abc123',
        repoName: 'demo',
      }),
      createIssueWorktree: async () => ({
        repoPath: '/repo/demo',
        worktreePath: '/tmp/github-agents/worktrees/octo-demo/issue-3/demo',
        branch: 'dueno-fleet/issue/issue-3-test',
        sourceBranch: 'main',
        sourceHead: 'abc123',
        repoName: 'demo',
      }),
      sessionLauncher: async (launch) => {
        launches.push(launch);
        return { sessionId: `sess_${launch.metadata.github_kind}_${launch.metadata.github_number}` };
      },
    });

    await app.inject({
      method: 'POST',
      url: '/api/agents/github',
      headers: authHeaders(),
      payload: {
        owner: 'octo',
        repo: 'demo',
        authRef: 'GITHUB_TOKEN_REF',
        lastSeenPrNumber: 3,
        lastSeenIssueNumber: 2,
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/github/poll-now',
      headers: authHeaders(),
      payload: { id: 'octo/demo' },
    });
    const body = res.json();

    assert.equal(res.statusCode, 200);
    assert.equal(body.enabled, true);
    assert.equal(body.results.length, 1);
    assert.deepEqual(body.results[0].newPullRequestNumbers, [4]);
    assert.deepEqual(body.results[0].newIssueNumbers, [3]);
    assert.equal(body.results[0].spawned.length, 2);
    assert.equal(launches.length, 2);
    assert.equal(launches[0].metadata.github_repo, 'octo/demo');
    assert.match(launches[0].prompt, /autoReviewEnabled=true: you ARE authorized to post a GitHub pull-request review/);
    assert.doesNotMatch(launches[0].prompt, /Do not post comments, reviews, commits, pushes, GitHub mutations/);
    assert.equal(JSON.stringify(body).includes('secret-token'), false);
    assert.equal(JSON.stringify(broadcasts).includes('secret-token'), false);
    assert.equal(fetchCalls[0].headers.Authorization, 'Bearer secret-token');
    assert.equal(broadcasts.some((entry) => entry.channel === 'github:agents' && entry.type === 'snapshot'), true);
    await app.close();
  });

  it('poll-now does not fetch or spawn while disabled', async () => {
    let fetched = false;
    let spawned = false;
    const app = await buildApp({
      configOverrides: { enabled: false },
      env: { GITHUB_TOKEN_REF: 'secret-token' },
      fetchImpl: async () => { fetched = true; return response(200, []); },
      sessionLauncher: async () => { spawned = true; return {}; },
    });

    await app.inject({
      method: 'POST',
      url: '/api/agents/github',
      headers: authHeaders(),
      payload: { owner: 'octo', repo: 'demo', authRef: 'GITHUB_TOKEN_REF' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents/github/poll-now',
      headers: authHeaders(),
      payload: { id: 'octo/demo' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().skipped, true);
    assert.equal(fetched, false);
    assert.equal(spawned, false);
    await app.close();
  });

  it('boots with empty store without polling when disabled and deletes repos', async () => {
    let polled = false;
    const app = await buildApp({
      configOverrides: { enabled: false },
      fetchImpl: async () => { polled = true; return response(200, []); },
    });

    const upsert = await app.inject({
      method: 'POST',
      url: '/api/agents/github',
      headers: authHeaders(),
      payload: { owner: 'octo', repo: 'demo', authRef: 'GITHUB_TOKEN_REF' },
    });
    assert.equal(upsert.statusCode, 200);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/agents/github/${encodeURIComponent('octo/demo')}`,
      headers: authHeaders(),
    });
    assert.equal(del.statusCode, 200);

    const list = await app.inject({
      method: 'GET',
      url: '/api/agents/github',
      headers: authHeaders(),
    });
    assert.deepEqual(list.json().repos, []);
    assert.equal(polled, false);
    await app.close();
  });

  it('starts enabled poller with startup spawning suppressed by default', async () => {
    const calls = [];
    let started = false;
    let stopped = false;
    const app = await buildApp({
      configOverrides: { enabled: true },
      poller: {
        pollOnce: async (opts) => { calls.push(opts); return []; },
        start: () => { started = true; },
        stop: () => { stopped = true; },
      },
    });

    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [{ suppressSpawn: true }]);
    assert.equal(started, true);
    await app.close();
    assert.equal(stopped, true);
  });
});

async function buildApp({
  configOverrides = {},
  env = {},
  fetchImpl = async () => response(404, {}),
  sessionLauncher = async () => ({ sessionId: 'sess' }),
  wsManager = null,
  createPrWorktree = null,
  createIssueWorktree = null,
  poller = null,
  requireAuth = false,
} = {}) {
  process.env.AUTH_TOKEN = TEST_TOKEN;
  process.env.INTERNAL_BYPASS_TOKEN = TEST_TOKEN;
  const app = Fastify({ logger: false });
  if (requireAuth) {
    const { authPlugin } = await import(`../modules/platform/auth.mjs?githubRoutesTest=${Date.now()}${Math.random()}`);
    await app.register(authPlugin);
  }
  await app.register(githubAgentsPlugin, {
    repoStore: buildGithubAgentRepoStore({
      stateStore: memoryStateStore(),
      defaultAutoReviewEnabled: true,
    }),
    config: {
      enabled: false,
      pollIntervalSec: 15,
      autoReviewEnabled: true,
      workDir: '/tmp/github-agents',
      repoPaths: {},
      maxSpawnsPerPoll: 5,
      ...configOverrides,
    },
    env,
    fetchImpl,
    sessionLauncher,
    ...(poller ? { poller } : {}),
    ...(wsManager ? { wsManager } : {}),
    ...(createPrWorktree ? { createPrWorktree } : {}),
    ...(createIssueWorktree ? { createIssueWorktree } : {}),
  });
  await app.ready();
  return app;
}

function authHeaders() {
  return { authorization: `Bearer ${activeToken}` };
}

function memoryStateStore(initial = null) {
  let state = initial;
  return {
    loadSync: () => state,
    load: async () => state,
    save: async (next) => { state = JSON.parse(JSON.stringify(next)); },
    close: async () => {},
  };
}

function githubItem(number, title) {
  return {
    id: number * 10,
    number,
    title,
    state: 'open',
    html_url: `https://github.com/octo/demo/${number}`,
    url: `https://api.github.com/repos/octo/demo/issues/${number}`,
    created_at: '2026-06-22T12:00:00Z',
    updated_at: '2026-06-22T12:00:00Z',
    user: { login: 'alice' },
    author_association: 'OWNER',
  };
}

function mockGithubFetch(calls, { pulls = [], issues = [] } = {}) {
  return async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers });
    if (String(url).includes('/pulls?')) return response(200, pulls);
    if (String(url).includes('/issues?')) return response(200, issues);
    return response(404, { message: 'not found' });
  };
}

function response(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  };
}
