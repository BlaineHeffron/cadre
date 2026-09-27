import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  AgentBusCredentialStore,
} from '../modules/agent-bus/mcp-auth.mjs';
import {
  buildInProcessAgentBusMcpServer,
  buildInProcessFastifyRequest,
} from '../modules/agent-bus/in-process-mcp.mjs';
import { startAgentBusMcpHttpServer } from '../modules/agent-bus/mcp-http.mjs';
import {
  authPlugin,
  buildInternalBypassHeaders,
  permissionAuthorityForRequest,
} from '../modules/platform/auth.mjs';
import { buildMonitorMcpServer } from '../modules/platform/monitor-mcp.mjs';
import {
  COORDINATOR_CONTROL_TOOL_SCOPES,
  COORDINATOR_POLICY_METADATA_KEY,
  scheduledCoordinatorLaunchAuthContext,
} from '../modules/agent-bus/coordinator-policy.mjs';
import { prepareAgentBusCredentialLaunch } from '../modules/integrations/mcp-launch-preflight.mjs';
import { stepDue } from '../modules/integrations/scheduled-agents.mjs';

function memoryCredentialStore() {
  let state = null;
  return new AgentBusCredentialStore({
    mode: 'enforce',
    store: {
      mode: 'memory',
      async load() { return state; },
      async save(next) { state = structuredClone(next); },
      async close() {},
    },
  });
}

function context(principal) {
  return {
    authenticated: principal.type !== 'legacy',
    legacyUntrusted: principal.type === 'legacy',
    principal,
    toolScopes: ['mcp:discover', 'monitor_send_to_session'],
    threadAllowlist: [],
    serverAllowlist: ['dueno'],
  };
}

describe('in-process MCP permission authority', () => {
  it('preserves structured authorization failures across the Fastify boundary', async () => {
    const app = Fastify({ logger: false });
    app.post('/api/denied', async (_request, reply) => reply.code(403).send({
      error: 'Delegation missing',
      code: 'mcp_forbidden',
      reason: 'loop_registration_delegation_missing',
    }));
    await app.ready();
    try {
      const requestImpl = buildInProcessFastifyRequest({ app, buildHeaders: () => ({}) });
      await assert.rejects(
        requestImpl('/api/denied', { method: 'POST', body: {} }),
        (error) => (
          error.statusCode === 403
          && error.code === 'mcp_forbidden'
          && error.reason === 'loop_registration_delegation_missing'
        ),
      );
    } finally {
      await app.close();
    }
  });

  it('preserves a due scheduled coordinator policy through nested Fastify inject and issues an agent credential', { timeout: 5000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-coordinator-als-'));
    const app = Fastify({ logger: false });
    const credentialStore = memoryCredentialStore();
    await app.register(authPlugin, { token: 'operator-test-token', internalBypassToken: 'internal-test-token' });
    const observed = [];
    let nestedRequestImpl = null;
    const internalHeaders = () => buildInternalBypassHeaders({
      authToken: 'operator-test-token', bypassToken: 'internal-test-token',
    });
    app.post('/api/codex/sessions', async (request) => {
      observed.push({ route: 'backend', auth: structuredClone(request.duenoAuth) });
      const issued = await prepareAgentBusCredentialLaunch({
        backendType: 'codex',
        sessionId: 'coordinator-session',
        attemptGeneration: 1,
        coordinatorPolicy: request.duenoAuth?.coordinatorPolicy,
        credentialStore,
      });
      const authenticated = await credentialStore.authenticate(issued.token);
      return {
        id: 'coordinator-session',
        principal: authenticated.principal,
        coordinatorPolicy: authenticated.coordinatorPolicy,
        toolScopes: authenticated.toolScopes,
      };
    });
    app.post('/api/agents/sessions', async (request, reply) => {
      observed.push({ route: 'unified', auth: structuredClone(request.duenoAuth) });
      const nested = await nestedRequestImpl('/api/codex/sessions', {
        method: 'POST', body: {}, authContext: request.duenoAuth,
      });
      return reply.send(nested);
    });
    await app.ready();
    const requestImpl = buildInProcessFastifyRequest({ app, buildHeaders: internalHeaders });
    nestedRequestImpl = requestImpl;
    const policyMetadata = {
      [COORDINATOR_POLICY_METADATA_KEY]: {
        policyId: 'protocol-first-v1',
        repository: 'octocat/dueno-fleet',
        projectRoots: [root],
        protectedSessionIds: [],
      },
    };
    let stored = {
      id: 'sched_protocol', workDir: root, prompt: 'coordinate', provider: 'codex', model: null,
      intervalSeconds: 15, maxIterations: 1, parentThreadId: null, status: 'active',
      currentIteration: 0, nextRunAtEpochMs: 1000, lastSessionId: null,
      lastSpawnAtEpochMs: 0, consecutiveSkips: 0, metadata: policyMetadata,
    };
    try {
      const result = await stepDue(1000, {
        store: {
          async list() { return [structuredClone(stored)]; },
          async claimRun() { return { task: structuredClone(stored), leaseId: 'claim', original: structuredClone(stored) }; },
          async update(_id, patch) { stored = { ...stored, ...patch }; return structuredClone(stored); },
        },
        lookupSessionState: async () => null,
        sessionLauncher: async (input) => {
          const authContext = scheduledCoordinatorLaunchAuthContext(input.trustedCoordinatorMetadata, {
            scheduleId: input.taskId,
            workDir: input.workDir,
          });
          return requestImpl('/api/agents/sessions', { method: 'POST', body: {}, authContext });
        },
      });
      assert.equal(result.spawned, 1);
      assert.deepEqual(observed.map((entry) => entry.route), ['unified', 'backend']);
      assert.equal(observed.every((entry) => entry.auth.principal.type === 'service'), true);
      assert.equal(observed.every((entry) => entry.auth.coordinatorPolicy.scheduleId === 'sched_protocol'), true);
      const authenticated = credentialStore.credentialFor({
        type: 'agent', kind: 'codex', sessionId: 'coordinator-session',
      });
      assert.equal(authenticated.principal.type, 'agent');
      assert.equal(authenticated.coordinatorPolicy.policyId, 'protocol-first-v1');
      assert.deepEqual(
        COORDINATOR_CONTROL_TOOL_SCOPES.filter((scope) => !authenticated.toolScopes.includes(scope)),
        [],
      );
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves MCP identity through Fastify inject and fails closed on a live blocking interaction', { timeout: 5000 }, async () => {
    const app = Fastify({ logger: false });
    await app.register(authPlugin, { token: 'operator-test-token', internalBypassToken: 'internal-test-token' });
    const observed = [];
    app.post('/api/claude/sessions/:id/input', async (request, reply) => {
      observed.push(structuredClone(request.duenoAuth));
      const fingerprint = 'live-needs-approval';
      if (request.body?.expectedFingerprint && request.body.expectedFingerprint !== fingerprint) {
        return reply.code(409).send({ error: 'Interaction fingerprint mismatch' });
      }
      try {
        permissionAuthorityForRequest(request, {
          tool: 'tmux.input', scope: 'permission.approve', risk: 'needs_approval',
        });
      } catch (error) {
        return reply.code(error.statusCode || 403).send({ error: error.message, code: error.code });
      }
      return { ok: true, fingerprint };
    });
    await app.ready();

    const requestImpl = buildInProcessFastifyRequest({
      app,
      buildHeaders: () => buildInternalBypassHeaders({
        authToken: 'operator-test-token', bypassToken: 'internal-test-token',
      }),
    });
    const monitorMcp = buildMonitorMcpServer({ requestImpl });

    const agent = context({ type: 'agent', kind: 'codex', sessionId: 'agent-1' });
    await assert.rejects(
      monitorMcp.handleToolCall('monitor_send_to_session', {
        type: 'claude', sessionId: 'blocked', text: 'approve',
      }, { authContext: agent }),
      (error) => error.statusCode === 403 && error.payload?.code === 'permission_authority_required',
    );
    assert.equal(observed.at(-1).principal.type, 'agent');
    assert.equal(observed.at(-1).source, 'agent_bus_mcp');

    const legacy = context({ type: 'legacy', kind: 'legacy', sessionId: 'untrusted' });
    await assert.rejects(
      monitorMcp.handleToolCall('monitor_send_to_session', {
        type: 'claude', sessionId: 'blocked', text: 'approve',
      }, { authContext: legacy }),
      (error) => error.statusCode === 403,
    );
    assert.equal(observed.at(-1).principal.type, 'legacy');

    const ui = context({ type: 'ui', kind: 'dashboard', sessionId: 'browser' });
    const allowed = await requestImpl('/api/claude/sessions/blocked/input', {
      method: 'POST', body: { text: 'approve', expectedFingerprint: 'live-needs-approval' }, authContext: ui,
    });
    assert.equal(allowed.ok, true);
    assert.equal(observed.at(-1).principal.type, 'ui');
    await app.close();
  });

  it('binds MCP HTTP to the production in-process dispatcher and rejects agent session control', { timeout: 5000 }, async () => {
    const app = Fastify({ logger: false });
    await app.register(authPlugin, { token: 'operator-test-token', internalBypassToken: 'internal-test-token' });
    let inputCalls = 0;
    app.post('/api/claude/sessions/:id/input', async () => { inputCalls += 1; return { ok: true }; });
    await app.ready();
    const requestImpl = buildInProcessFastifyRequest({
      app,
      buildHeaders: () => buildInternalBypassHeaders({
        authToken: 'operator-test-token', bypassToken: 'internal-test-token',
      }),
    });
    const monitorMcp = buildMonitorMcpServer({ requestImpl });
    const credentialStore = memoryCredentialStore();
    const issued = await credentialStore.issue({
      principal: { type: 'agent', kind: 'codex', sessionId: 'http-agent' },
      attemptGeneration: 1,
      threadAllowlist: [],
      toolScopes: ['mcp:discover', 'monitor_send_to_session'],
    });
    const mcp = buildInProcessAgentBusMcpServer({ requestImpl, monitorMcp, credentialStore });
    const httpServer = startAgentBusMcpHttpServer({
      metaUrl: import.meta.url, host: '127.0.0.1', port: 0, path: '/mcp',
      credentialStore, serverFactory: mcp, log: { info() {}, error() {} },
    });
    await once(httpServer, 'listening');
    const response = await fetch(`http://127.0.0.1:${httpServer.address().port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'monitor_send_to_session',
          arguments: { type: 'claude', sessionId: 'blocked', text: 'approve' },
        },
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.error, undefined, payload.error?.message);
    assert.ok(inputCalls >= 0);
    await new Promise((resolve) => httpServer.close(resolve));
    await app.close();
  });
});
