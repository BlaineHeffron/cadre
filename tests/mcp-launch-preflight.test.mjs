import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupMcpCapabilityLaunch,
  FLEET_SUPERVISOR_MCP_CREDENTIAL_PROFILE,
  FLEET_SUPERVISOR_MCP_TOOL_SCOPES,
  prepareMcpCapabilityLaunch,
  sanitizedMcpSnapshot,
} from '../modules/integrations/mcp-launch-preflight.mjs';
import { resolveMcpCapabilities } from '../modules/integrations/mcp-capability-resolver.mjs';
import { buildMcpCapabilityCatalog } from '../modules/integrations/mcp-server-catalog.mjs';
import { AgentBusCredentialStore } from '../modules/agent-bus/mcp-auth.mjs';
import { AGENT_SPAWN_TOOL_SCOPES } from '../modules/agent-bus/mcp-auth.mjs';
import { buildInProcessAgentBusMcpServer } from '../modules/agent-bus/in-process-mcp.mjs';
import { buildMonitorMcpServer } from '../modules/platform/monitor-mcp.mjs';
import { renderAgentSessionLaunch } from '../modules/sessions/index.mjs';
import { buildAgentRuntimeLaunchArgs } from '../modules/agent/runtime-args.mjs';

const tempDirs = [];
const originalStateDir = process.env.CADRE_STATE_DIR;

afterEach(async () => {
  if (originalStateDir === undefined) delete process.env.CADRE_STATE_DIR;
  else process.env.CADRE_STATE_DIR = originalStateDir;
  while (tempDirs.length) await rm(tempDirs.pop(), { recursive: true, force: true });
});

function resolved(serverIds, provider = 'codex', runtime = 'codex') {
  return {
    profileId: 'default',
    serverIds,
    catalogVersion: 1,
    configurationDigest: `sha256:${'a'.repeat(64)}`,
    provider,
    runtime,
  };
}

function sourceConfig() {
  return {
    agentBusMcpHttp: { host: '127.0.0.1', port: 9876, path: '/mcp' },
    researchWorkbench: {
      zoteroMcpPath: '/missing/private/zotero',
      nodusMcpPath: '/missing/private/nodus',
      paperSearchPath: '/missing/private/paper-search',
      nodusTokenFile: '/missing/private/token',
    },
  };
}

function credentialStore() {
  let state = null;
  return new AgentBusCredentialStore({
    mode: 'issue_only',
    store: {
      mode: 'memory',
      async load() { return state; },
      async save(next) { state = structuredClone(next); },
      async close() {},
    },
  });
}

describe('MCP launch preflight', () => {
  it('probes and injects profile additions for optional stdio servers on Codex, Pi, and Claude', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dueno-stdio-profile-add-'));
    tempDirs.push(stateDir);
    process.env.CADRE_STATE_DIR = stateDir;
    const fixture = new URL('./fixtures/mcp/stdio-tools-server.mjs', import.meta.url).pathname;
    const configured = {
      ...sourceConfig(),
      mcpCredentials: { seodataPath: fixture },
    };
    const catalog = buildMcpCapabilityCatalog({ sourceConfig: configured });
    const secret = 'seodata-test-key';

    for (const [backendType, provider, runtime] of [
      ['codex', 'codex', 'codex'],
      ['pi', 'xai', 'pi'],
      ['claude', 'claude', 'claude'],
    ]) {
      const selected = resolveMcpCapabilities({
        request: { mcpProfile: 'dueno', mcpServers: { add: ['seodata'], remove: [] } },
        provider,
        runtime,
        catalog,
      });
      assert.deepEqual(selected.serverIds, ['dueno', 'seodata']);
      const credentials = credentialStore();
      const result = await prepareMcpCapabilityLaunch({
        resolved: selected,
        backendType,
        sessionId: `${backendType}-stdio-profile-add`,
        sourceConfig: configured,
        credentialStore: credentials,
        stdioEnv: { SEODATA_API_KEY: secret },
        fetchImpl: async () => { throw new TypeError('offline test'); },
      });
      assert.deepEqual(result.preflight.seodata, { state: 'ready', toolCount: 3 });
      const snapshot = sanitizedMcpSnapshot(selected, result.preflight);
      assert.equal(JSON.stringify(snapshot).includes(secret), false);
      const rendered = renderAgentSessionLaunch({
        backendType,
        sessionBinary: `/opt/bin/${backendType}`,
        sessionId: `${backendType}-stdio-profile-add`,
        provider,
        buildOptions: { workDir: stateDir, runtime, provider, mcpLaunch: result.prepared },
      });
      if (backendType === 'codex') {
        assert.equal(rendered.allArgs.some((arg) => arg === 'mcp_servers.seodata.command="node"'), true);
        assert.equal(rendered.allArgs.some((arg) => arg.includes(fixture)), true);
        assert.equal(rendered.allArgs.some((arg) => arg.includes(`SEODATA_API_KEY="${secret}"`)), true);
      } else {
        const configPath = backendType === 'pi' ? result.prepared.piConfigPath : result.prepared.claudeConfigPath;
        const configFile = JSON.parse(await readFile(configPath, 'utf8'));
        assert.deepEqual(configFile.mcpServers.seodata, {
          command: 'node', args: [fixture], env: { SEODATA_API_KEY: secret },
        });
        if (backendType === 'pi') {
          assert.equal(rendered.allArgs.includes(result.prepared.piExtensionPath), true);
          assert.equal(rendered.paneCommand.includes(result.prepared.piConfigPath), true);
        } else {
          assert.deepEqual(rendered.allArgs.slice(-3), ['--mcp-config', result.prepared.claudeConfigPath, '--strict-mcp-config']);
        }
      }
      await cleanupMcpCapabilityLaunch({
        backendType,
        sessionId: `${backendType}-stdio-profile-add`,
        sourceConfig: configured,
        credentialStore: credentials,
      });
    }
  });

  it('gives only the trusted Fleet Supervisor its expanded Dueno inventory', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dueno-supervisor-mcp-preflight-'));
    tempDirs.push(stateDir);
    process.env.CADRE_STATE_DIR = stateDir;
    const credentials = credentialStore();
    const supervisor = await prepareMcpCapabilityLaunch({
      resolved: resolved(['dueno']),
      backendType: 'codex',
      sessionId: 'fleet-supervisor-test',
      sourceConfig: sourceConfig(),
      credentialProfile: FLEET_SUPERVISOR_MCP_CREDENTIAL_PROFILE,
      credentialStore: credentials,
    });
    const supervisorToken = (await readFile(supervisor.prepared.credentialPath, 'utf8')).trim();
    const supervisorAuth = await credentials.authenticate(supervisorToken);
    assert.equal(supervisorAuth.ok, true);
    assert.deepEqual(supervisorAuth.principal, {
      type: 'service', kind: 'fleet-supervisor', sessionId: 'fleet-supervisor-test',
    });
    assert.deepEqual(supervisorAuth.threadAllowlist, ['*']);
    assert.deepEqual(supervisorAuth.toolScopes, [...FLEET_SUPERVISOR_MCP_TOOL_SCOPES]);

    const requestImpl = async () => ({});
    const monitorMcp = buildMonitorMcpServer({ requestImpl });
    const server = buildInProcessAgentBusMcpServer({
      requestImpl,
      credentialStore: credentials,
      monitorMcp,
    });
    const listed = await server.handleRequest(
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { authContext: supervisorAuth },
    );
    assert.deepEqual(
      listed.result.tools.map((tool) => tool.name).sort(),
      FLEET_SUPERVISOR_MCP_TOOL_SCOPES.filter((name) => name !== 'mcp:discover').sort(),
    );
    assert.equal(listed.result.tools.some((tool) => tool.name === 'spawn_session'), true);
    assert.equal(listed.result.tools.some((tool) => tool.name === 'spawn_collab_session'), true);
    assert.equal(listed.result.tools.some((tool) => tool.name === 'monitor_terminate_session'), true);
    assert.equal(listed.result.tools.some((tool) => tool.name === 'monitor_answer_human_queue_item'), false);

    const ordinary = await prepareMcpCapabilityLaunch({
      resolved: resolved(['dueno']),
      backendType: 'codex',
      sessionId: 'ordinary-agent-test',
      workDir: stateDir,
      sourceConfig: sourceConfig(),
      credentialStore: credentials,
    });
    const ordinaryToken = (await readFile(ordinary.prepared.credentialPath, 'utf8')).trim();
    const ordinaryAuth = await credentials.authenticate(ordinaryToken);
    const ordinaryListed = await server.handleRequest(
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      { authContext: ordinaryAuth },
    );
    assert.equal(ordinaryAuth.principal.type, 'agent');
    assert.equal(ordinaryAuth.coordinatorPolicy, null);
    assert.deepEqual(
      AGENT_SPAWN_TOOL_SCOPES.filter((scope) => !ordinaryAuth.toolScopes.includes(scope)),
      [],
    );
    for (const name of [
      'spawn_session',
      'spawn_collab_session',
      'spawn_conference_session',
      'monitor_run_agent_task',
      'register_scheduled_agent',
    ]) assert.equal(ordinaryListed.result.tools.some((tool) => tool.name === name), true, name);
    assert.equal(ordinaryListed.result.tools.some((tool) => tool.name === 'monitor_terminate_session'), true);
    assert.equal(ordinaryListed.result.tools.some((tool) => tool.name === 'monitor_answer_human_queue_item'), true);

    const withoutDueno = await prepareMcpCapabilityLaunch({
      resolved: resolved([]),
      backendType: 'codex',
      sessionId: 'ordinary-without-dueno',
      workDir: stateDir,
      sourceConfig: sourceConfig(),
      credentialStore: credentials,
    });
    assert.equal(withoutDueno.prepared.credential.toolScopes.includes('spawn_session'), true);
    await cleanupMcpCapabilityLaunch({
      backendType: 'codex',
      sessionId: 'ordinary-without-dueno',
      sourceConfig: sourceConfig(),
      credentialStore: credentials,
    });

    await cleanupMcpCapabilityLaunch({
      backendType: 'codex',
      sessionId: 'fleet-supervisor-test',
      credentialProfile: FLEET_SUPERVISOR_MCP_CREDENTIAL_PROFILE,
      sourceConfig: sourceConfig(),
      credentialStore: credentials,
    });
    assert.equal((await credentials.authenticate(supervisorToken)).reason, 'revoked');
  });

  it('builds server-owned Codex overrides and degrades optional research failures', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dueno-codex-mcp-preflight-'));
    tempDirs.push(stateDir);
    process.env.CADRE_STATE_DIR = stateDir;
    const credentials = credentialStore();
    const result = await prepareMcpCapabilityLaunch({
      resolved: resolved(['dueno', 'paper-search']),
      backendType: 'codex',
      sessionId: 'codex-test',
      sourceConfig: sourceConfig(),
      credentialStore: credentials,
    });

    assert.deepEqual(result.preflight, {
      dueno: { state: 'ready' },
      'paper-search': { state: 'degraded', reasonCode: 'health_check_failed' },
    });
    assert.equal(result.prepared.codexArgs.includes('mcp_servers={}'), true);
    assert.equal(result.prepared.codexArgs.some((arg) => arg.includes('mcp_servers.dueno.url=')), true);
    assert.equal(result.prepared.codexArgs.some((arg) => arg.includes('bearer_token_env_var')), true);
    assert.equal(result.prepared.codexArgs.some((arg) => arg.includes('/missing/private')), false);
    const token = await readFile(result.prepared.credentialPath, 'utf8');
    assert.equal((await stat(result.prepared.credentialPath)).mode & 0o777, 0o600);
    assert.equal(result.prepared.codexArgs.some((arg) => arg.includes(token)), false);
    assert.equal(JSON.stringify(result.prepared).includes(token), false);
    await cleanupMcpCapabilityLaunch({
      backendType: 'codex', sessionId: 'codex-test', sourceConfig: sourceConfig(), credentialStore: credentials,
    });
    await assert.rejects(stat(result.prepared.credentialPath), /ENOENT/);
  });

  it('identifies the missing research path when an optional server is selected', async () => {
    const configured = sourceConfig();
    configured.researchWorkbench.paperSearchPath = '';
    const result = await prepareMcpCapabilityLaunch({
      resolved: resolved(['paper-search']), backendType: 'codex', sessionId: 'missing-paper-search',
      sourceConfig: configured, credentialStore: credentialStore(),
    });
    assert.deepEqual(result.preflight['paper-search'], {
      state: 'degraded', reasonCode: 'missing_RESEARCH_WORKBENCH_PAPER_SEARCH_PATH',
    });
  });

  it('writes one 0600 strict Claude config outside the workspace and cleans it up', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dueno-mcp-preflight-'));
    tempDirs.push(stateDir);
    process.env.CADRE_STATE_DIR = stateDir;
    const credentials = credentialStore();
    const result = await prepareMcpCapabilityLaunch({
      resolved: resolved(['dueno'], 'claude', 'claude'),
      backendType: 'claude',
      sessionId: 'claude-test',
      sourceConfig: sourceConfig(),
      credentialStore: credentials,
    });

    assert.match(result.prepared.claudeConfigPath, new RegExp(`^${stateDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));
    assert.equal((await stat(result.prepared.claudeConfigPath)).mode & 0o777, 0o600);
    const configFile = JSON.parse(await readFile(result.prepared.claudeConfigPath, 'utf8'));
    assert.equal(configFile.mcpServers.dueno.type, 'http');
    assert.equal(configFile.mcpServers.dueno.url, 'http://127.0.0.1:9876/mcp');
    assert.match(configFile.mcpServers.dueno.headers.Authorization, /^Bearer dueno_mcp_v1\./);
    assert.equal(JSON.stringify(result.prepared).includes(configFile.mcpServers.dueno.headers.Authorization.slice(7)), false);
    await cleanupMcpCapabilityLaunch({
      backendType: 'claude', sessionId: 'claude-test', sourceConfig: sourceConfig(), credentialStore: credentials,
    });
    await assert.rejects(stat(result.prepared.claudeConfigPath), /ENOENT/);
  });

  it('rejects a non-loopback env-token Claude config and revokes its credential', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dueno-claude-stream-loopback-'));
    tempDirs.push(stateDir);
    const credentials = credentialStore();
    const configPath = join(stateDir, 'attempt-1', 'dueno-mcp.json');
    await assert.rejects(prepareMcpCapabilityLaunch({
      resolved: resolved(['dueno'], 'claude', 'claude'),
      backendType: 'claude', sessionId: 'unsafe-stream-test',
      sourceConfig: { agentBusMcpHttp: { host: 'example.com', port: 9876, path: '/mcp' } },
      credentialStore: credentials, claudeConfigPath: configPath,
      duenoCredentialEnvVar: 'DUENO_AGENT_BUS_TOKEN',
    }), /loopback/);
    assert.deepEqual(credentials.auditEvents().map((event) => event.event), ['issue', 'revoke']);
    await assert.rejects(stat(configPath), /ENOENT/);
  });

  it('writes one 0600 Pi config and selects the Fleet MCP extension', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dueno-pi-mcp-preflight-'));
    tempDirs.push(stateDir);
    process.env.CADRE_STATE_DIR = stateDir;
    const credentials = credentialStore();
    const result = await prepareMcpCapabilityLaunch({
      resolved: resolved(['dueno'], 'openai', 'pi'),
      backendType: 'pi',
      sessionId: 'pi-test',
      sourceConfig: sourceConfig(),
      credentialStore: credentials,
    });

    assert.equal((await stat(result.prepared.piConfigPath)).mode & 0o777, 0o600);
    assert.match(result.prepared.piExtensionPath, /pi-mcp-extension\.mjs$/);
    const configFile = JSON.parse(await readFile(result.prepared.piConfigPath, 'utf8'));
    assert.equal(configFile.mcpServers.dueno.url, 'http://127.0.0.1:9876/mcp');
    assert.match(configFile.mcpServers.dueno.headers.Authorization, /^Bearer dueno_mcp_v1\./);
    assert.equal(JSON.stringify(result.prepared).includes(configFile.mcpServers.dueno.headers.Authorization.slice(7)), false);
    await cleanupMcpCapabilityLaunch({
      backendType: 'pi', sessionId: 'pi-test', sourceConfig: sourceConfig(), credentialStore: credentials,
    });
    await assert.rejects(stat(result.prepared.piConfigPath), /ENOENT/);
  });

  it('does not launch an optional server when its selected dependency degrades', async () => {
    const configured = sourceConfig();
    configured.researchWorkbench.nodusMcpPath = process.execPath;
    configured.researchWorkbench.nodusTokenFile = process.execPath;
    const result = await prepareMcpCapabilityLaunch({
      resolved: resolved(['zotero', 'nodus']),
      backendType: 'codex',
      sessionId: 'dependency-test',
      sourceConfig: configured,
      credentialStore: credentialStore(),
    });

    assert.deepEqual(result.preflight, {
      zotero: { state: 'degraded', reasonCode: 'health_check_failed' },
      nodus: { state: 'degraded', reasonCode: 'dependency_unavailable' },
    });
    assert.equal(result.prepared.codexArgs.some((arg) => arg.includes('mcp_servers.nodus.')), false);
  });

  it('returns a denylist-safe persisted snapshot', () => {
    const snapshot = sanitizedMcpSnapshot(resolved(['dueno', 'paper-search']), {
      dueno: { state: 'ready', toolCount: 3 },
      'paper-search': { state: 'degraded', reasonCode: 'health_check_failed', raw: 'secret output' },
    });
    assert.equal(snapshot.preflight.dueno.toolCount, 3);
    assert.deepEqual(snapshot.preflight['paper-search'], {
      state: 'degraded',
      reasonCode: 'health_check_failed',
    });
    assert.equal(/url|command|args|env|path|token|secret output/i.test(JSON.stringify(snapshot)), false);
  });

  it('keeps bearer values out of every backend argv and tmux pane command', { timeout: 10000 }, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dueno-backend-secret-boundary-'));
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-backend-workspace-'));
    tempDirs.push(stateDir, workDir);
    process.env.CADRE_STATE_DIR = stateDir;

    for (const backendType of ['codex', 'claude', 'pi']) {
      const credentials = credentialStore();
      const prepared = await prepareMcpCapabilityLaunch({
        resolved: resolved(['dueno'], backendType === 'pi' ? 'xai' : backendType, backendType),
        backendType,
        sessionId: `${backendType}-render`,
        workDir,
        sourceConfig: sourceConfig(),
        credentialStore: credentials,
      });
      let token;
      if (backendType === 'codex') token = (await readFile(prepared.prepared.credentialPath, 'utf8')).trim();
      if (backendType === 'claude') {
        token = JSON.parse(await readFile(prepared.prepared.claudeConfigPath, 'utf8'))
          .mcpServers.dueno.headers.Authorization.slice(7);
      }
      if (backendType === 'pi') {
        token = JSON.parse(await readFile(prepared.prepared.piConfigPath, 'utf8'))
          .mcpServers.dueno.headers.Authorization.slice(7);
      }

      const rendered = renderAgentSessionLaunch({
        backendType,
        sessionBinary: `/opt/bin/${backendType}`,
        launchLogPath: join(stateDir, `${backendType}.log`),
        sessionId: `${backendType}-render`,
        provider: backendType === 'pi' ? 'xai' : backendType,
        buildOptions: {
          workDir,
          runtime: backendType,
          provider: backendType === 'pi' ? 'xai' : backendType,
          model: '',
          mcpLaunch: prepared.prepared,
        },
      });
      assert.equal(JSON.stringify(rendered.allArgs).includes(token), false);
      assert.equal(rendered.paneCommand.includes(token), false);
      if (backendType === 'codex') {
        assert.equal(rendered.allArgs.some((arg) => arg.includes('bearer_token_env_var="DUENO_AGENT_BUS_TOKEN"')), true);
        assert.equal(rendered.paneCommand.includes(prepared.prepared.credentialPath), true);
      } else if (backendType === 'claude') {
        assert.deepEqual(
          rendered.allArgs.slice(rendered.allArgs.indexOf('--mcp-config'), rendered.allArgs.indexOf('--mcp-config') + 3),
          ['--mcp-config', prepared.prepared.claudeConfigPath, '--strict-mcp-config'],
        );
        assert.equal(rendered.paneCommand.includes(prepared.prepared.claudeConfigPath), true);
      } else {
        assert.equal(rendered.allArgs.includes(prepared.prepared.piExtensionPath), true);
        assert.equal(rendered.paneCommand.includes(prepared.prepared.piConfigPath), true);
      }
      assert.equal(prepared.prepared.claudeConfigPath?.startsWith(workDir) || false, false);
      assert.equal(prepared.prepared.piConfigPath?.startsWith(workDir) || false, false);
      assert.equal(prepared.prepared.credentialPath?.startsWith(workDir) || false, false);
      await cleanupMcpCapabilityLaunch({
        backendType, sessionId: `${backendType}-render`, sourceConfig: sourceConfig(), credentialStore: credentials,
      });
    }

    const deepSeekToken = 'dueno_mcp_v1.test.only-in-env';
    const deepSeekArgs = buildAgentRuntimeLaunchArgs({ runtime: 'deepseek', configPath: join(stateDir, 'deepseek.cordis.yml') });
    assert.equal(JSON.stringify(deepSeekArgs).includes(deepSeekToken), false);
    assert.deepEqual(deepSeekArgs, ['--config', join(stateDir, 'deepseek.cordis.yml')]);
  });

  it('rejects a Dueno credential the live MCP endpoint will not accept', async () => {
    const credentials = credentialStore();
    await assert.rejects(
      prepareMcpCapabilityLaunch({
        resolved: resolved(['dueno']),
        backendType: 'codex',
        sessionId: 'unusable-dueno',
        sourceConfig: sourceConfig(),
        credentialStore: credentials,
        requireLiveDuenoHandshake: true,
        fetchImpl: async () => new Response(JSON.stringify({
          jsonrpc: '2.0', id: null,
          error: { code: -32001, message: 'Agent Bus MCP authentication failed' },
        }), { status: 401, headers: { 'content-type': 'application/json' } }),
      }),
      (error) => error.code === 'mcp_credential_unusable',
    );
  });


  it('initializes the pinned rea server and lists its tools', { timeout: 30000 }, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dueno-rea-preflight-'));
    tempDirs.push(stateDir);
    process.env.CADRE_STATE_DIR = stateDir;
    const result = await prepareMcpCapabilityLaunch({
      resolved: resolved(['rea']),
      backendType: 'codex',
      sessionId: 'rea-preflight',
      sourceConfig: sourceConfig(),
      credentialStore: credentialStore(),
      stdioEnv: {},
    });
    assert.equal(result.preflight.rea.state, 'ready');
    assert.ok(result.preflight.rea.toolCount > 0);
  });

  it('launches the pinned image server with the key, model pin, and worktree output dir', { timeout: 30000 }, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dueno-image-preflight-'));
    tempDirs.push(stateDir);
    process.env.CADRE_STATE_DIR = stateDir;
    const result = await prepareMcpCapabilityLaunch({
      resolved: resolved(['gpt-image'], 'claude', 'claude'),
      backendType: 'claude',
      sessionId: 'gpt-image-preflight',
      workDir: '/work/tree',
      sourceConfig: sourceConfig(),
      credentialStore: credentialStore(),
      stdioEnv: { DM_MCP_OPENAI_API_KEY: 'test-key' },
    });
    assert.equal(result.preflight['gpt-image'].state, 'ready');
    assert.equal(result.preflight['gpt-image'].toolCount, 3);
    const configFile = JSON.parse(await readFile(result.prepared.claudeConfigPath, 'utf8'));
    assert.deepEqual(configFile.mcpServers['gpt-image'].env, {
      DEFAULT_OPENAI_IMAGE_MODEL: 'gpt-image-2.5-flare',
      OPENAI_API_KEY: 'test-key',
      DEFAULT_OUTPUT_DIR: '/work/tree/generated-images',
    });
  });

  it('rejects a selected stdio server when MCP initialize fails', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'dueno-stdio-preflight-'));
    tempDirs.push(stateDir);
    process.env.CADRE_STATE_DIR = stateDir;
    const entry = join(stateDir, 'index.js');
    await writeFile(entry, 'export {};\n');
    await assert.rejects(prepareMcpCapabilityLaunch({
      resolved: resolved(['seodata']),
      backendType: 'codex',
      sessionId: 'seodata-initialize-failure',
      sourceConfig: {
        ...sourceConfig(),
        mcpCredentials: { seodataPath: entry },
      },
      credentialStore: credentialStore(),
    }), (error) => error.code === 'mcp_initialize_failed' && error.statusCode === 503 && Boolean(error.cause));
  });

  it('rejects a selected stdio server when tools/list fails', async () => {
    const fixture = new URL('./fixtures/mcp/stdio-tools-server.mjs', import.meta.url).pathname;
    await assert.rejects(prepareMcpCapabilityLaunch({
      resolved: resolved(['seodata']),
      backendType: 'codex',
      sessionId: 'seodata-list-failure',
      sourceConfig: {
        ...sourceConfig(),
        mcpCredentials: {
          seodataPath: fixture,
          overrides: { seodata: { args: [fixture, '--fail-list'] } },
        },
      },
      credentialStore: credentialStore(),
      stdioEnv: {},
    }), (error) => error.code === 'mcp_tools_list_failed' && error.statusCode === 503 && Boolean(error.cause));
  });
});
