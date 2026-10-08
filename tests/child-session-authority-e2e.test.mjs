import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { AgentBusCredentialStore } from '../modules/agent-bus/mcp-auth.mjs';
import { buildInProcessAgentBusMcpServer } from '../modules/agent-bus/in-process-mcp.mjs';
import { prepareMcpCapabilityLaunch } from '../modules/integrations/mcp-launch-preflight.mjs';
import { buildMonitorMcpServer } from '../modules/platform/monitor-mcp.mjs';

const tempDirs = [];
const originalStateDir = process.env.CADRE_STATE_DIR;

afterEach(async () => {
  if (originalStateDir === undefined) delete process.env.CADRE_STATE_DIR;
  else process.env.CADRE_STATE_DIR = originalStateDir;
  while (tempDirs.length) await rm(tempDirs.pop(), { recursive: true, force: true });
});

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

function resolvedDueno() {
  return {
    profileId: 'dueno',
    serverIds: ['dueno'],
    catalogVersion: 1,
    configurationDigest: `sha256:${'d'.repeat(64)}`,
    provider: 'codex',
    runtime: 'codex',
  };
}

function sourceConfig() {
  return {
    agentBusMcpHttp: { host: '127.0.0.1', port: 49876, path: '/mcp' },
    researchWorkbench: {},
  };
}

function mcpCatalog() {
  const compatible = {
    providers: ['claude', 'codex', 'xai', 'google', 'opencode-go', 'deepseek'],
    runtimes: ['claude', 'codex', 'pi', 'deepseek'],
    transport: 'stdio',
    required: false,
    dependencies: [],
    requiresExplicitSelection: false,
  };
  return {
    catalogVersion: 1,
    defaultProfileId: 'default',
    profiles: [
      { id: 'default', serverIds: [] },
      { id: 'dueno', serverIds: ['dueno'] },
    ],
    servers: [
      {
        ...compatible,
        id: 'dueno',
        transport: 'http',
        required: true,
        authorization: 'server_owned',
        availability: { state: 'configured', reasonCode: null },
      },
      ...['seodata', 'fetch'].map((id) => ({
        ...compatible,
        id,
        availability: { state: 'configured', reasonCode: null },
      })),
      {
        ...compatible,
        id: 'claude-only',
        providers: ['claude'],
        availability: { state: 'configured', reasonCode: null },
      },
      {
        ...compatible,
        id: 'unconfigured-test',
        availability: { state: 'unconfigured', reasonCode: 'entry_point_missing' },
      },
      {
        ...compatible,
        id: 'businessos',
        transport: 'http',
        requiresExplicitSelection: true,
        authorization: 'operator_bearer_token_required',
        availability: { state: 'configured', reasonCode: null },
      },
    ],
  };
}

function rpc(server, name, args, authContext) {
  return server.handleRequest({
    jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: args },
  }, { authContext });
}

async function harness() {
  const stateDir = await mkdtemp(join(tmpdir(), 'dueno-child-authority-state-'));
  const root = await mkdtemp(join(tmpdir(), 'dueno-child-authority-root-'));
  const childDir = join(root, 'child');
  const outside = await mkdtemp(join(tmpdir(), 'dueno-child-authority-outside-'));
  const live = join(root, 'cadre-live');
  const link = join(root, 'linked-outside');
  await Promise.all([mkdir(childDir), mkdir(live)]);
  await symlink(outside, link);
  tempDirs.push(stateDir, root, outside);
  process.env.CADRE_STATE_DIR = stateDir;

  const credentialStore = memoryCredentialStore();
  const prepared = await prepareMcpCapabilityLaunch({
    resolved: resolvedDueno(),
    backendType: 'codex',
    sessionId: 'ordinary-parent',
    workDir: root,
    sourceConfig: sourceConfig(),
    credentialStore,
  });
  const token = (await readFile(prepared.prepared.credentialPath, 'utf8')).trim();
  const authContext = await credentialStore.authenticate(token);
  assert.equal(authContext.ok, true);

  const calls = [];
  let nextSession = 0;
  let nextThread = 0;
  const requestImpl = async (path, options = {}) => {
    calls.push({ path, options: structuredClone(options) });
    if (path === '/api/agents/mcp-servers') return mcpCatalog();
    if (path === '/api/agents/providers') {
      return {
        preferredProvider: 'codex',
        providers: [
          { id: 'codex', enabled: true, backendType: 'codex', runtime: 'codex', defaultModel: 'gpt-5.6-sol' },
          { id: 'claude', enabled: true, backendType: 'claude', runtime: 'claude', defaultModel: 'claude-opus-5' },
          { id: 'xai', enabled: true, backendType: 'pi', runtime: 'pi', defaultModel: 'grok-4.6' },
        ],
      };
    }
    if (path === '/api/agents/sessions' || /^\/api\/(?:claude|codex)\/sessions$/.test(path)) {
      nextSession += 1;
      return { id: `child-${nextSession}`, sessionName: `child-${nextSession}` };
    }
    if (path === '/api/agents/tasks') return { status: 'completed', executionMode: 'ephemeral_session_fallback' };
    if (path === '/api/agents/scheduled') return { id: 'schedule-child', status: 'active' };
    if (path === '/api/agent-bus/bootstrap') {
      nextThread += 1;
      return {
        bootstrapOk: true,
        thread: { id: `thread-${nextThread}`, title: options.body?.title || 'child thread' },
        participants: (options.body?.participants || []).map((participant) => ({
          ...participant,
          kind: participant.kind || (participant.provider === 'claude' ? 'claude' : 'codex'),
          sessionId: participant.sessionId || `bootstrap-child-${nextSession += 1}`,
        })),
      };
    }
    if (path === '/api/agent-bus/threads') {
      nextThread += 1;
      return { thread: { id: `thread-${nextThread}`, title: options.body?.title || 'child loop' } };
    }
    if (path.startsWith('/api/agent-bus/threads/foreign-thread?')) {
      return {
        thread: {
          id: 'foreign-thread',
          participants: [{ kind: 'codex', sessionId: 'another-agent' }],
        },
      };
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const monitorMcp = buildMonitorMcpServer({ requestImpl });
  const server = buildInProcessAgentBusMcpServer({ requestImpl, monitorMcp, credentialStore });
  return { authContext, calls, childDir, credentialStore, link, live, outside, root, server };
}

describe('ordinary Dueno child-session authority E2E', () => {
  it('canonicalizes a symlink parent workDir and still allows in-tree children', async () => {
    const realRoot = await mkdtemp(join(tmpdir(), 'dueno-child-authority-real-'));
    const linkParent = await mkdtemp(join(tmpdir(), 'dueno-child-authority-linkparent-'));
    const alias = join(linkParent, 'alias-root');
    const childDir = join(realRoot, 'nested');
    await mkdir(childDir);
    await symlink(realRoot, alias);
    tempDirs.push(realRoot, linkParent);
    const stateDir = await mkdtemp(join(tmpdir(), 'dueno-child-authority-state-'));
    tempDirs.push(stateDir);
    process.env.CADRE_STATE_DIR = stateDir;
    const credentialStore = memoryCredentialStore();
    const prepared = await prepareMcpCapabilityLaunch({
      resolved: resolvedDueno(),
      backendType: 'codex',
      sessionId: 'symlink-parent',
      workDir: alias,
      sourceConfig: sourceConfig(),
      credentialStore,
    });
    const token = (await readFile(prepared.prepared.credentialPath, 'utf8')).trim();
    const authContext = await credentialStore.authenticate(token);
    const requestImpl = async (path) => {
      if (path === '/api/agents/mcp-servers') return mcpCatalog();
      if (path === '/api/agents/providers') {
        return { preferredProvider: 'codex', providers: [{ id: 'codex', enabled: true, backendType: 'codex', runtime: 'codex', defaultModel: 'gpt-5.6-sol' }] };
      }
      if (path === '/api/agents/sessions') return { id: 'child-symlink', sessionName: 'child-symlink' };
      throw new Error(`Unexpected request: ${path}`);
    };
    const monitorMcp = buildMonitorMcpServer({ requestImpl });
    const server = buildInProcessAgentBusMcpServer({ requestImpl, monitorMcp, credentialStore });
    const response = await rpc(server, 'spawn_session', { provider: 'codex', workDir: childDir }, authContext);
    assert.equal(response.error, undefined, response.error?.message);
  });

  it('launches every enabled child creation family through authenticated MCP without coordinator provenance', async () => {
    const { authContext, calls, childDir, credentialStore, root, server } = await harness();
    assert.equal(authContext.principal.type, 'agent');
    assert.equal(authContext.coordinatorPolicy, null);

    const listed = await server.handleRequest(
      { jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} },
      { authContext },
    );
    const names = new Set(listed.result.tools.map((tool) => tool.name));
    for (const name of [
      'spawn_session',
      'monitor_run_agent_task',
      'register_scheduled_agent',
      'spawn_collab_session',
      'spawn_conference_session',
    ]) assert.equal(names.has(name), true, `${name} should be discoverable`);

    const cases = [
      ['spawn_session', { provider: 'claude', workDir: childDir, model: 'claude-opus-5' }],
      ['spawn_session', { provider: 'codex', workDir: childDir, model: 'gpt-5.6-sol' }],
      ['monitor_run_agent_task', { provider: 'codex', prompt: 'bounded task', workDir: childDir, model: 'gpt-5.6-sol' }],
      ['register_scheduled_agent', { prompt: 'bounded loop tick', workDir: childDir, provider: 'codex', model: 'gpt-5.6-sol' }],
      ['spawn_collab_session', {
        title: 'collaboration', workDir: childDir, mcpProfile: 'dueno',
        mcpServers: { add: ['seodata', 'fetch'], remove: [] },
        participants: [{ provider: 'codex' }, { provider: 'xai', model: 'grok-4.6' }],
      }],
      ['spawn_conference_session', {
        title: 'conference', workDir: childDir, mcpProfile: 'dueno',
        participants: [{ provider: 'codex' }, { provider: 'claude' }, { provider: 'xai', model: 'grok-4.6' }],
      }],
    ];
    for (const [name, args] of cases) {
      const response = await rpc(server, name, args, authContext);
      assert.equal(response.error, undefined, `${name}: ${response.error?.message || ''}`);
    }

    const inheritedIssued = await credentialStore.issue({
      principal: { type: 'agent', kind: 'codex', sessionId: 'ordinary-inheriting-parent' },
      attemptGeneration: 1,
      toolScopes: authContext.toolScopes,
    });
    const inheritedAuth = await credentialStore.authenticate(inheritedIssued.token);
    const inheritedSpawn = await rpc(server, 'spawn_session', {
      provider: 'codex',
      workDir: childDir,
    }, inheritedAuth);
    assert.equal(inheritedSpawn.error, undefined, inheritedSpawn.error?.message);
    const inheritedCall = calls.filter((entry) => entry.path === '/api/agents/sessions').at(-1);
    assert.ok(inheritedCall);

    assert.equal(calls.some((entry) => entry.path === '/api/agents/tasks'), true);
    assert.equal(calls.some((entry) => entry.path === '/api/agents/scheduled'), true);
    assert.equal(calls.filter((entry) => entry.path === '/api/agent-bus/bootstrap').length, 2);
    assert.equal(calls.filter((entry) => [
      '/api/agents/sessions', '/api/agents/tasks', '/api/agents/scheduled', '/api/agent-bus/bootstrap',
    ].includes(entry.path)).every((entry) => entry.options.body.mcpProfile === 'dueno'), true);
    const businessCollab = calls.find((entry) => (
      entry.path === '/api/agent-bus/bootstrap'
      && entry.options.body?.title === 'collaboration'
    ));
    assert.equal(businessCollab.options.body.mcpProfile, 'dueno');
    assert.deepEqual(businessCollab.options.body.mcpServers, {
      add: ['seodata', 'fetch'],
      remove: [],
    });
    assert.equal(
      calls.filter((entry) => ['ordinary-parent', 'ordinary-inheriting-parent']
        .includes(entry.options.authContext?.principal?.sessionId)).length,
      calls.length,
      'the active authenticated parent context must survive every in-process launch hop',
    );
  });

  it('lets Fleet Supervisors select any enabled MCP servers for spawned agents', async () => {
    const { authContext, calls, childDir, server } = await harness();
    const supervisorAuth = {
      ...authContext,
      principal: { type: 'service', kind: 'fleet-supervisor', sessionId: 'fleet-supervisor-test' },
    };
    const response = await rpc(server, 'spawn_collab_session', {
      title: 'supervisor collaboration',
      workDir: childDir,
      mcpProfile: 'default',
      mcpServers: { add: ['seodata', 'fetch'], remove: [] },
      participants: [{ provider: 'codex' }, { provider: 'claude', mcpServers: { add: ['fetch'] } }],
    }, supervisorAuth);
    assert.equal(response.error, undefined, response.error?.message);
    const launch = calls.find((entry) => entry.path === '/api/agent-bus/bootstrap');
    assert.equal(launch.options.body.mcpProfile, 'default');
    assert.deepEqual(launch.options.body.mcpServers, { add: ['seodata', 'fetch'], remove: [] });
    assert.deepEqual(launch.options.body.participants[1].mcpServers, { add: ['fetch'] });
  });

  it('still requires an authenticated credential for spawn, and keeps thread membership on parentThreadId', async () => {
    const { authContext, childDir, server } = await harness();
    const foreignThread = await rpc(server, 'spawn_session', {
      provider: 'codex', workDir: childDir, parentThreadId: 'foreign-thread',
    }, authContext);
    assert.equal(foreignThread.error?.data?.reason === 'principal_type_denied', false);

    for (const destructive of ['monitor_terminate_session', 'monitor_answer_human_queue_item', 'cancel_scheduled_agent']) {
      const response = await rpc(server, destructive, {}, authContext);
      assert.equal(response.error?.data?.reason === 'scope_missing', false, destructive);
    }

    const legacy = {
      authenticated: false,
      legacyUntrusted: true,
      principal: { type: 'legacy', kind: 'legacy', sessionId: 'untrusted' },
      toolScopes: ['*'], threadAllowlist: ['*'], serverAllowlist: ['*'],
    };
    const legacyList = await server.handleRequest(
      { jsonrpc: '2.0', id: 'legacy-list', method: 'tools/list', params: {} },
      { authContext: legacy },
    );
    assert.equal(legacyList.result.tools.some((tool) => tool.name === 'spawn_session'), false);
    const legacySpawn = await rpc(server, 'spawn_session', { provider: 'codex', workDir: childDir }, legacy);
    assert.equal(legacySpawn.error?.data?.reason, 'child_session_credential_required');

    const defaultRoot = await rpc(server, 'spawn_session', { provider: 'codex' }, authContext);
    assert.equal(defaultRoot.error, undefined, defaultRoot.error?.message);
  });

});
