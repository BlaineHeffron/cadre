import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { AgentBusCredentialStore } from '../modules/agent-bus/mcp-auth.mjs';
import { AGENT_SPAWN_TOOL_SCOPES } from '../modules/agent-bus/mcp-auth.mjs';
import { agentBusPlugin } from '../modules/agent-bus/index.mjs';
import {
  buildInProcessAgentBusMcpServer,
  buildInProcessFastifyRequest,
} from '../modules/agent-bus/in-process-mcp.mjs';
import { startAgentBusMcpHttpServer } from '../modules/agent-bus/mcp-http.mjs';
import { AgentBusStore } from '../modules/agent-bus/store.mjs';
import {
  cleanupMcpCapabilityLaunch,
  prepareMcpCapabilityLaunch,
  sanitizedMcpSnapshot,
} from '../modules/integrations/mcp-launch-preflight.mjs';
import { buildMonitorMcpServer } from '../modules/platform/monitor-mcp.mjs';

const tempDirs = [];
const envKeys = [
  'AGENT_BUS_STORAGE',
  'AGENT_PROVIDER_PREFERENCES_FILE',
  'APP_STATE_STORAGE',
  'DATABASE_URL',
  'CADRE_STATE_DIR',
];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(async () => {
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  while (tempDirs.length) await rm(tempDirs.pop(), { recursive: true, force: true });
});

function resolvedDueno(provider = 'codex', runtime = provider === 'xai' ? 'pi' : provider) {
  return {
    profileId: 'dueno',
    serverIds: ['dueno'],
    catalogVersion: 1,
    configurationDigest: `sha256:${'d'.repeat(64)}`,
    provider,
    runtime,
  };
}

function mcpCatalog() {
  return {
    catalogVersion: 1,
    defaultProfileId: 'dueno',
    profiles: [{ id: 'dueno', serverIds: ['dueno'] }],
    servers: [{
      id: 'dueno',
      transport: 'http',
      required: true,
      authorization: 'server_owned',
      availability: { state: 'configured', reasonCode: null },
      dependencies: [],
      requiresExplicitSelection: false,
      providers: ['codex', 'xai'],
      runtimes: ['codex', 'pi'],
    }],
  };
}

function credentialStore(stateFile) {
  return new AgentBusCredentialStore({
    stateFile,
    mode: 'enforce',
    env: {
      APP_STATE_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
}

async function buildControlPlane({ root, stateFile }) {
  const app = Fastify({ logger: false });
  const issuer = credentialStore(stateFile);
  const sessions = new Map();
  let sequence = 0;
  let mcpPort = 1;

  const sourceConfig = () => ({
    agentBusMcpHttp: { host: '127.0.0.1', port: mcpPort, path: '/mcp' },
    researchWorkbench: {},
  });

  for (const kind of ['claude', 'codex', 'pi']) {
    app.get(`/api/${kind}/sessions`, async () => ({
      sessions: [...sessions.values()].filter((session) => session.kind === kind),
    }));
    app.post(`/api/${kind}/sessions`, async (request) => {
      const body = request.body || {};
      const provider = kind === 'pi' ? String(body.provider || 'xai') : kind;
      const sessionId = `${kind}-${sequence += 1}`;
      const prepared = await prepareMcpCapabilityLaunch({
        resolved: resolvedDueno(provider, kind),
        backendType: kind,
        sessionId,
        workDir: body.workDir || root,
        sourceConfig: sourceConfig(),
        credentialStore: issuer,
        requireLiveDuenoHandshake: true,
      });
      const session = {
        id: sessionId,
        kind,
        provider,
        model: body.model || '',
        workDir: body.workDir || root,
        displayName: body.displayName || '',
        state: { revision: 1, status: 'ready' },
        mcpCapabilities: sanitizedMcpSnapshot(resolvedDueno(provider, kind), prepared.preflight),
        credentialPath: prepared.prepared.credentialPath,
      };
      sessions.set(sessionId, session);
      return { id: sessionId, sessionName: `test-${sessionId}`, mcpCapabilities: session.mcpCapabilities };
    });
    app.get(`/api/${kind}/sessions/:sessionId`, async (request, reply) => {
      const session = sessions.get(request.params.sessionId);
      return session || reply.code(404).send({ error: 'Session not found', code: 'session_not_found' });
    });
    app.post(`/api/${kind}/sessions/:sessionId/startup-input`, async (request, reply) => (
      sessions.has(request.params.sessionId)
        ? { ok: true, state: 'injected' }
        : reply.code(404).send({ error: 'Session not found', code: 'session_not_found' })
    ));
    app.post(`/api/${kind}/sessions/:sessionId/input`, async (request, reply) => (
      sessions.has(request.params.sessionId)
        ? { ok: true, state: 'injected' }
        : reply.code(404).send({ error: 'Session not found', code: 'session_not_found' })
    ));
    app.delete(`/api/${kind}/sessions/:sessionId`, async (request) => {
      const session = sessions.get(request.params.sessionId);
      if (!session) return { ok: true, status: 'already_gone', residual: [] };
      await cleanupMcpCapabilityLaunch({
        backendType: kind,
        sessionId: session.id,
        sourceConfig: sourceConfig(),
        credentialStore: issuer,
      });
      sessions.delete(session.id);
      return { ok: true, status: 'terminated', residual: [] };
    });
  }

  app.get('/api/agents/mcp-servers', async () => mcpCatalog());
  app.get('/api/agents/providers', async () => ({
    preferredProvider: 'codex',
    providers: [
      {
        id: 'codex', enabled: true, backendType: 'codex', runtime: 'codex',
        defaultModel: 'gpt-5.6-sol', models: ['gpt-5.6-sol'], supportsCollaboration: true,
      },
      {
        id: 'xai', enabled: true, backendType: 'pi', runtime: 'pi',
        defaultModel: 'grok-4.6', models: ['grok-4.6'], supportsCollaboration: true,
      },
    ],
  }));

  const busStore = new AgentBusStore({ stateDir: join(root, 'agent-bus') });
  await app.register(agentBusPlugin, {
    credentialStore: issuer,
    store: busStore,
    wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
  });
  await app.ready();

  const internalRequest = buildInProcessFastifyRequest({ app, buildHeaders: () => ({}) });
  const monitorMcp = buildMonitorMcpServer({ requestImpl: internalRequest });
  const verifier = credentialStore(stateFile);
  await verifier.init();
  const mcp = buildInProcessAgentBusMcpServer({
    requestImpl: internalRequest,
    monitorMcp,
    credentialStore: verifier,
  });
  const httpServer = startAgentBusMcpHttpServer({
    metaUrl: import.meta.url,
    host: '127.0.0.1',
    port: 0,
    path: '/mcp',
    credentialStore: verifier,
    serverFactory: mcp,
    log: { info() {}, error() {} },
  });
  await once(httpServer, 'listening');
  mcpPort = httpServer.address().port;

  return {
    app,
    busStore,
    httpServer,
    issuer,
    mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
    sessions,
    verifier,
    async close() {
      await new Promise((resolve) => httpServer.close(resolve));
      await app.close();
      await Promise.all([issuer.close(), verifier.close()]);
    },
  };
}

async function mcpRequest(url, token, method, params = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

describe('ordinary Dueno authority after control-plane restart', () => {
  it('lists real scoped tools and atomically spawns a Codex + xAI collaboration', { timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-ordinary-restart-e2e-'));
    tempDirs.push(root);
    process.env.CADRE_STATE_DIR = join(root, 'runtime');
    process.env.APP_STATE_STORAGE = 'file';
    process.env.AGENT_BUS_STORAGE = 'file';
    process.env.DATABASE_URL = '';
    process.env.AGENT_PROVIDER_PREFERENCES_FILE = join(root, 'provider-preferences.json');
    const stateFile = join(root, 'credentials.json');

    const beforeRestart = await buildControlPlane({ root, stateFile });
    await beforeRestart.close();

    const restarted = await buildControlPlane({ root, stateFile });
    try {
      const created = await restarted.app.inject({
        method: 'POST',
        url: '/api/codex/sessions',
        payload: {
          workDir: root,
          provider: 'codex',
          model: 'gpt-5.6-sol',
          displayName: 'ordinary parent',
          mcpProfile: 'dueno',
        },
      });
      assert.equal(created.statusCode, 200, created.body);
      const parent = restarted.sessions.get(created.json().id);
      const token = (await readFile(parent.credentialPath, 'utf8')).trim();
      const auth = await restarted.verifier.authenticate(token);
      assert.equal(auth.ok, true);
      assert.equal(auth.principal.type, 'agent');
      assert.equal(auth.coordinatorPolicy, null);
      assert.deepEqual(
        AGENT_SPAWN_TOOL_SCOPES.filter((scope) => !auth.toolScopes.includes(scope)),
        [],
      );

      const listed = await mcpRequest(restarted.mcpUrl, token, 'tools/list');
      const toolNames = new Set(listed.result.tools.map((tool) => tool.name));
      for (const name of AGENT_SPAWN_TOOL_SCOPES) {
        assert.equal(toolNames.has(name), true, `${name} must be mounted after restart`);
      }
      assert.equal(toolNames.has('monitor_terminate_session'), true);
      assert.equal(toolNames.has('monitor_answer_human_queue_item'), true);

      const spawned = await mcpRequest(restarted.mcpUrl, token, 'tools/call', {
        name: 'spawn_collab_session',
        arguments: {
          title: 'restart acceptance pair',
          workDir: root,
          initialTask: 'bounded mocked acceptance task',
          mcpProfile: 'dueno',
          participants: [
            { provider: 'codex', model: 'gpt-5.6-sol' },
            { provider: 'xai', model: 'grok-4.6' },
          ],
        },
      });
      assert.equal(spawned.error, undefined, spawned.error?.message);
      assert.equal(spawned.result.structuredContent.bootstrapOk, true);
      const thread = restarted.busStore.getThread(spawned.result.structuredContent.thread.id).thread;
      assert.deepEqual(thread.participants.map((entry) => entry.kind).sort(), ['codex', 'pi']);
      const childSessions = thread.participants.map((entry) => restarted.sessions.get(entry.sessionId));
      assert.deepEqual(childSessions.map((entry) => `${entry.provider}/${entry.model}`).sort(), [
        'codex/gpt-5.6-sol',
        'xai/grok-4.6',
      ]);

      const ended = await restarted.app.inject({
        method: 'POST',
        url: `/api/agent-bus/threads/${encodeURIComponent(thread.id)}/end`,
        payload: { reason: 'bounded regression cleanup' },
      });
      assert.equal(ended.statusCode, 200, ended.body);
      assert.equal(ended.json().status, 'ended');
      assert.equal(thread.participants.every((entry) => !restarted.sessions.has(entry.sessionId)), true);
      const deletedThread = await restarted.app.inject({
        method: 'DELETE',
        url: `/api/agent-bus/threads/${encodeURIComponent(thread.id)}`,
      });
      assert.equal(deletedThread.statusCode, 200, deletedThread.body);
      const deletedParent = await restarted.app.inject({
        method: 'DELETE',
        url: `/api/codex/sessions/${encodeURIComponent(parent.id)}`,
      });
      assert.equal(deletedParent.statusCode, 200, deletedParent.body);
      assert.equal(restarted.sessions.size, 0);
      assert.equal(restarted.busStore.listThreads().length, 0);
    } finally {
      await restarted.close();
    }
  });
});
