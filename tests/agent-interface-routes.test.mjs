import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

const TEST_TOKEN = 'agent-interface-route-token';
const authHeaders = () => ({ authorization: `Bearer ${TEST_TOKEN}` });

function bosParsedIds(value = {}) {
  const sessionId = value.result?.session?.id
    || value.session?.id
    || value.result?.sessionId
    || null;
  const threadId = value.result?.threadId
    || value.result?.thread?.id
    || value.thread?.id
    || value.threadId
    || value.session?.threadId
    || null;
  return { sessionId, threadId };
}

function makeMemoryIdempotencyStore(initial = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    async get(key) {
      const value = entries.get(key);
      return value ? JSON.parse(JSON.stringify(value)) : null;
    },
    async set(key, value) {
      entries.set(key, JSON.parse(JSON.stringify(value)));
      return value;
    },
    async close() {},
  };
}

async function buildApp({ idempotencyStore = makeMemoryIdempotencyStore(), sessionExistsImpl = async () => true, worktreeCreator } = {}) {
  process.env.AUTH_TOKEN = TEST_TOKEN;
  process.env.INTERNAL_BYPASS_TOKEN = TEST_TOKEN;
  const { agentInterfacePlugin } = await import(`../modules/agent/interface.mjs?agentInterfaceRoutes=${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const app = Fastify({ logger: false });
  let spawnCount = 0;
  const createBodies = [];

  app.post('/api/codex/sessions', async (req) => {
    spawnCount += 1;
    createBodies.push(req.body);
    return { id: `codex_route_${spawnCount}`, sessionName: `codex-route-${spawnCount}` };
  });
  app.post('/api/pi/sessions', async (_req, reply) => reply.code(503).send({
    error: 'Pi CLI binary not found',
    code: 'pi_binary_missing',
  }));
  app.get('/api/codex/sessions/:id', async (req) => ({
    id: req.params.id,
    content: 'Ready',
    state: {
      state: 'waiting_for_input',
      detail: null,
      status: 'ready',
      reason: 'Stable free-text prompt visible',
      revision: 1,
      capabilities: {
        sendMessage: true,
        clear: true,
        interrupt: false,
        autoClose: true,
        needsAttention: true,
      },
      interaction: { kind: 'free_text', detail: '', options: [], fingerprint: 'route-ready' },
    },
  }));
  app.post('/api/codex/sessions/:id/startup-input', async () => ({ ok: true }));
  app.delete('/api/codex/sessions/:id', async () => ({ ok: true }));
  await app.register(agentInterfacePlugin, {
    idempotencyStore,
    idempotencyTtlMs: 3_600_000,
    now: () => 10_000,
    sessionExistsImpl,
    worktreeCreator,
    getPreferences: async () => ({
      claudeEnabled: true,
      codexEnabled: true,
      piEnabled: true,
      preferredSingleProvider: 'codex',
    }),
  });

  return {
    app,
    createBodies,
    get spawnCount() {
      return spawnCount;
    },
  };
}

describe('agent interface routes', () => {
  it('publishes the sanitized MCP capability catalog', async () => {
    const harness = await buildApp();
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/agents/mcp-servers',
      headers: authHeaders(),
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.defaultProfileId, 'default');
    assert.match(body.catalogDigest, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(body.profiles.find((entry) => entry.id === 'default').serverIds, []);
    assert.deepEqual(body.profiles.find((entry) => entry.id === 'dueno').serverIds, ['dueno']);
    assert.equal(body.servers.some((entry) => entry.id === 'businessos'), true);
    assert.equal(/"(url|command|args|env|path|token)"\s*:/.test(JSON.stringify(body)), false);
    await harness.app.close();
  });

  it('publishes the public prompt profile catalog without bodies', async () => {
    const harness = await buildApp();
    const res = await harness.app.inject({
      method: 'GET',
      url: '/api/agents/prompt-profiles',
      headers: authHeaders(),
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.defaultProfileId, 'none');
    assert.equal(body.profiles.find((entry) => entry.id === 'command-center').hasBody, true);
    assert.equal(JSON.stringify(body).includes('Blaine'), false);
    await harness.app.close();
  });

  it('accepts BusinessOS-shaped requests without creating a room', async () => {
    const harness = await buildApp();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/agents/sessions',
      headers: authHeaders(),
      payload: {
        provider: 'codex',
        executor: 'tmux',
        workDir: '/tmp/bos',
        displayName: 'BusinessOS debug',
        initialPrompt: 'Investigate this row.',
        idempotencyKey: 'route-key',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.id, 'codex_route_1');
    assert.equal(body.thread, null);
    assert.deepEqual(bosParsedIds(body), { sessionId: 'codex_route_1', threadId: null });
    assert.equal(body.session.threadId, '');
    assert.equal(body.workspaceDir, '/tmp/bos');
    await harness.app.close();
  });

  it('dedupes same idempotencyKey at the route layer', async () => {
    const harness = await buildApp();
    const payload = {
      provider: 'codex',
      workDir: '/tmp/bos',
      displayName: 'BusinessOS work item',
      initialPrompt: 'Launch once.',
      idempotencyKey: 'route-same-key',
    };
    const first = await harness.app.inject({
      method: 'POST',
      url: '/api/agents/sessions',
      headers: authHeaders(),
      payload,
    });
    const second = await harness.app.inject({
      method: 'POST',
      url: '/api/agents/sessions',
      headers: authHeaders(),
      payload,
    });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(harness.spawnCount, 1);
    assert.equal(second.json().session.id, first.json().session.id);
    assert.equal(second.json().session.threadId, '');
    await harness.app.close();
  });

  it('forwards only an explicit structured-runtime request to the backend create route', async () => {
    const harness = await buildApp();
    for (const structured of [true, 'yes', undefined]) {
      const res = await harness.app.inject({
        method: 'POST', url: '/api/agents/sessions', headers: authHeaders(),
        payload: { provider: 'codex', workDir: '/tmp/bos', structured },
      });
      assert.equal(res.statusCode, 200, res.body);
    }
    assert.deepEqual(harness.createBodies.map((body) => body.structured), [true, undefined, undefined]);
    await harness.app.close();
  });

  it('keeps isolated-worktree spawns on tmux, whose delete path removes the worktree', async () => {
    const harness = await buildApp({
      worktreeCreator: async ({ repoPath }) => ({ worktreePath: `${repoPath}-wt`, branch: 'wt', baseRef: 'main', repoPath }),
    });
    const res = await harness.app.inject({
      method: 'POST', url: '/api/agents/sessions', headers: authHeaders(),
      payload: { provider: 'codex', workDir: '/tmp/bos', structured: true, isolatedWorktree: true },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(harness.createBodies[0].workDir, '/tmp/bos-wt');
    assert.equal(harness.createBodies[0].structured, undefined);
    await harness.app.close();
  });

  it('preserves explicit Pi preflight errors through the unified route', async () => {
    const harness = await buildApp();
    const res = await harness.app.inject({
      method: 'POST',
      url: '/api/agents/sessions',
      headers: authHeaders(),
      payload: { provider: 'xai', model: 'grok-4.6', workDir: '/tmp/pi' },
    });

    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { error: 'Pi CLI binary not found', code: 'pi_binary_missing' });
    await harness.app.close();
  });
});
