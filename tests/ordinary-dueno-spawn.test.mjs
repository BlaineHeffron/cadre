import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBusCredentialStore } from '../modules/agent-bus/mcp-auth.mjs';
import { buildInProcessAgentBusMcpServer } from '../modules/agent-bus/in-process-mcp.mjs';
import { buildMonitorMcpServer } from '../modules/platform/monitor-mcp.mjs';
import { prepareAgentBusCredentialLaunch } from '../modules/integrations/mcp-launch-preflight.mjs';

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

function rpc(server, name, args, authContext) {
  return server.handleRequest({
    jsonrpc: '2.0',
    id: name,
    method: 'tools/call',
    params: { name, arguments: args },
  }, { authContext });
}

describe('ordinary Dueno session spawn authority', () => {
  it('lets an ordinary Dueno credential spawn one-off, collab, and conference children', async () => {
    const workDir = join(tmpdir(), `dueno-ordinary-spawn-${Date.now()}`);
    await mkdir(workDir, { recursive: true });
    const credentialStore = memoryCredentialStore();
    const issued = await prepareAgentBusCredentialLaunch({
      backendType: 'codex',
      sessionId: 'ordinary-parent',
      attemptGeneration: 1,
      credentialStore,
    });
    const auth = await credentialStore.authenticate(issued.token);
    assert.equal(auth.principal.type, 'agent');
    assert.equal(auth.coordinatorPolicy, null);

    const calls = [];
    const requestImpl = async (path, opts = {}) => {
      calls.push({ path, method: opts.method || 'GET', body: opts.body });
      if (path === '/api/agents/mcp-servers') {
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
      if (path === '/api/agents/providers') {
        return {
          providers: [
            { id: 'codex', enabled: true, supportsCollaboration: true },
            { id: 'xai', enabled: true, supportsCollaboration: true },
          ],
        };
      }
      if (path === '/api/agents/sessions') {
        return { id: 'child-one-off', sessionId: 'child-one-off' };
      }
      if (path === '/api/agent-bus/bootstrap') {
        return {
          thread: { id: 'thr_child', participants: [{ kind: 'codex', sessionId: 'a' }, { kind: 'pi', sessionId: 'b' }] },
          participants: [{ kind: 'codex', sessionId: 'a' }, { kind: 'pi', sessionId: 'b' }],
        };
      }
      throw new Error(`Unexpected request ${path}`);
    };
    const monitorMcp = buildMonitorMcpServer({ requestImpl });
    const server = buildInProcessAgentBusMcpServer({
      requestImpl,
      credentialStore,
      monitorMcp,
    });

    const listed = await server.handleRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { authContext: auth },
    );
    const names = listed.result.tools.map((tool) => tool.name);
    for (const tool of [
      'spawn_session',
      'spawn_collab_session',
      'spawn_conference_session',
    ]) {
      assert.equal(names.includes(tool), true, tool);
    }
    assert.equal(names.includes('monitor_terminate_session'), true);

    const oneOff = await rpc(server, 'spawn_session', {
      provider: 'codex', workDir, displayName: 'one-off',
    }, auth);
    assert.equal(oneOff.error, undefined, oneOff.error?.message);
    assert.equal(oneOff.result.structuredContent.id, 'child-one-off');

    const collab = await rpc(server, 'spawn_collab_session', {
      title: 'pair',
      workDir,
      participants: [{ provider: 'codex' }, { provider: 'xai' }],
    }, auth);
    assert.equal(collab.error, undefined, collab.error?.message);
    assert.equal(collab.result.structuredContent.threadType, 'collab');

    const conference = await rpc(server, 'spawn_conference_session', {
      title: 'room',
      workDir,
      participants: [{ provider: 'codex' }, { provider: 'xai' }, { provider: 'codex' }],
    }, auth);
    assert.equal(conference.error, undefined, conference.error?.message);
    assert.equal(conference.result.structuredContent.threadType, 'conference');

  });
});
