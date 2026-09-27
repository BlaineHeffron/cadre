import { once } from 'node:events';
import { createRequire } from 'node:module';
import { readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { apply as applyDshMcpClient } from '@deepseek-ai/dsh-mcp-client';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import { interpolate } from '@deepseek-ai/cordis-plugin-loader';
import yaml from 'js-yaml';
import {
  AGENT_BUS_AGENT_TOOL_SCOPES,
  AgentBusCredentialStore,
} from '../modules/agent-bus/mcp-auth.mjs';
import { startAgentBusMcpHttpServer } from '../modules/agent-bus/mcp-http.mjs';
import { buildAgentBusMcpServer } from '../modules/agent-bus/mcp.mjs';
import {
  DEEPSEEK_MCP_CLIENT_PACKAGE,
  DEEPSEEK_MCP_CLIENT_VERSION,
  deepSeekBusE2eEvidence,
  deepSeekAttemptConfigPath,
  deepSeekCollaborationEligible,
  deepSeekMcpCapabilities,
  discoverDeepSeekDuenoTools,
  renderDeepSeekAttemptCordis,
  removeDeepSeekAttemptCordis,
  writeDeepSeekAttemptCordis,
} from '../modules/sessions/deepseek-mcp.mjs';

const require = createRequire(import.meta.url);
const originalStateDir = process.env.CADRE_STATE_DIR;
const tempPaths = [];

afterEach(async () => {
  if (originalStateDir === undefined) delete process.env.CADRE_STATE_DIR;
  else process.env.CADRE_STATE_DIR = originalStateDir;
  while (tempPaths.length) await rm(tempPaths.pop(), { recursive: true, force: true });
});

function memoryCredentialStore(mode = 'enforce') {
  let state = null;
  return new AgentBusCredentialStore({
    mode,
    store: {
      mode: 'memory',
      async load() { return state; },
      async save(next) { state = structuredClone(next); },
      async close() {},
    },
  });
}

function fakeCordisContext() {
  const tools = new Map();
  const effects = [];
  const ctx = {
    root: {},
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`);
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    logger: { info() {}, warn() {}, error() {} },
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === 'function') effects.push(dispose);
      return dispose;
    },
  };
  return {
    ctx,
    tools,
    async dispose() {
      for (const dispose of effects.reverse()) await dispose();
    },
  };
}

describe('DeepSeek launch-time MCP renderer', () => {
  it('pins the audited leaf and writes a validated secret-free 0600 per-attempt Cordis file', { timeout: 10_000 }, async () => {
    const installed = require(`${DEEPSEEK_MCP_CLIENT_PACKAGE}/package.json`);
    assert.equal(installed.version, DEEPSEEK_MCP_CLIENT_VERSION);
    assert.equal(deepSeekBusE2eEvidence().proven, true);
    assert.equal(deepSeekBusE2eEvidence({ packageVersion: '0.1.0-rc.7' }).proven, false);

    const stateDir = join(tmpdir(), `dueno-deepseek-mcp-${process.pid}-${Date.now()}`);
    tempPaths.push(stateDir);
    process.env.CADRE_STATE_DIR = stateDir;
    const baseConfigPath = join(process.cwd(), 'config/deepseek-acp.cordis.yml');
    const bearer = 'dueno_mcp_v1.test.secret-that-must-not-render';
    const configPath = await writeDeepSeekAttemptCordis({
      baseConfigPath,
      sessionId: 'renderer-test',
      attemptGeneration: 2,
      model: 'deepseek-v4-flash',
      permissionMode: 'workspace-write',
      mcpUrl: 'http://127.0.0.1:8765/mcp',
    });
    assert.equal(configPath, deepSeekAttemptConfigPath('renderer-test', 2));
    const rendered = await readFile(configPath, 'utf8');
    assert.equal(rendered.includes(bearer), false);
    assert.equal(rendered.includes('dueno_mcp_v1.'), false);
    assert.match(rendered, /process\.env\.DUENO_AGENT_BUS_TOKEN/);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal(configPath.startsWith(stateDir), true);

    const entries = yaml.load(rendered, { schema: entryListSchema });
    assert.equal(entries.find((entry) => entry.id === 'acp-agent').config.model, 'deepseek-v4-flash');
    assert.equal(entries.find((entry) => entry.id === 'sandbox-policy').config.mode, 'workspace-write');
    const mcp = entries.find((entry) => entry.id === 'mcp-dueno');
    assert.equal(mcp.name, '@deepseek-ai/dsh-mcp-client');
    assert.equal(mcp.config.transport, 'streamable-http');
    assert.equal(mcp.config.url, 'http://127.0.0.1:8765/mcp');
    assert.equal(mcp.config.failOnStartupError, true);
    assert.deepEqual(mcp.config.headers.Authorization, {
      __jsExpr: "'Bearer ' + String(process.env.DUENO_AGENT_BUS_TOKEN || '')",
    });
    assert.equal(
      interpolate({ process: { env: { DUENO_AGENT_BUS_TOKEN: bearer } } }, mcp.config.headers.Authorization),
      `Bearer ${bearer}`,
      'Cordis Loader must evaluate the YAML node to a header string, not [object Object]',
    );

    await removeDeepSeekAttemptCordis({ sessionId: 'renderer-test', attemptGeneration: 2 });
    await assert.rejects(stat(configPath), /ENOENT/);
  });

  it('rejects unsafe URLs, arbitrary token env vars, and unstructured base configs', async () => {
    const baseConfigText = await readFile(join(process.cwd(), 'config/deepseek-acp.cordis.yml'), 'utf8');
    assert.throws(() => renderDeepSeekAttemptCordis({
      baseConfigText,
      model: 'deepseek-v4-pro',
      permissionMode: 'workspace-write',
      mcpUrl: 'https://attacker.example/mcp',
    }), /loopback/);
    assert.throws(() => renderDeepSeekAttemptCordis({
      baseConfigText,
      model: 'deepseek-v4-pro',
      permissionMode: 'workspace-write',
      mcpUrl: 'http://127.0.0.1:8765/mcp',
      tokenEnvVar: 'HOME',
    }), /DUENO_AGENT_BUS_TOKEN/);
    assert.throws(() => renderDeepSeekAttemptCordis({
      baseConfigText: '{}',
      model: 'deepseek-v4-pro',
      permissionMode: 'workspace-write',
      mcpUrl: 'http://127.0.0.1:8765/mcp',
    }), /top-level entry array/);
  });

  it('computes collaboration eligibility from authenticated grade and E2E proof', () => {
    const unproven = deepSeekMcpCapabilities({ discoveryProven: false });
    const proven = deepSeekMcpCapabilities({ discoveryProven: true });
    const noE2e = deepSeekMcpCapabilities({ discoveryProven: true, e2eEvidence: { proven: false } });
    assert.equal(unproven.busParticipation, 'none');
    assert.equal(deepSeekCollaborationEligible(unproven), false);
    assert.equal(noE2e.busParticipation, 'none');
    assert.equal(deepSeekCollaborationEligible(noE2e), false);
    assert.equal(proven.busParticipation, 'authenticated_scoped');
    assert.equal(deepSeekCollaborationEligible(proven), true);
    assert.deepEqual(proven.mcpFeatures, { tools: true, resources: false, prompts: false });
  });
});

describe('DeepSeek dsh-mcp-client authenticated Agent Bus E2E', () => {
  it('discovers Fleet tools and sends then receives a scoped bus message', { timeout: 20_000 }, async () => {
    const threadId = 'thr_deepseek_e2e';
    const sessionId = 'deepseek-e2e';
    const thread = {
      id: threadId,
      title: 'DeepSeek MCP E2E',
      status: 'open',
      participants: [
        { kind: 'deepseek', sessionId },
        { kind: 'pi', sessionId: 'reviewer-e2e' },
      ],
    };
    const messages = [];
    const requestImpl = async (path, options = {}) => {
      if (path.startsWith(`/api/agent-bus/threads/${threadId}`)) {
        return { thread, messages: structuredClone(messages), deliveries: [], messageCount: messages.length, deliveryCount: 0 };
      }
      if (path === '/api/agent-bus/messages' && options.method === 'POST') {
        const message = { id: `msg_${messages.length + 1}`, ...structuredClone(options.body), createdAt: Date.now() };
        messages.push(message);
        return { message, delivery: { status: 'queued' } };
      }
      throw new Error(`Unexpected Agent Bus request: ${path}`);
    };
    const credentialStore = memoryCredentialStore('enforce');
    const issued = await credentialStore.issue({
      principal: { type: 'agent', kind: 'deepseek', sessionId },
      attemptGeneration: 1,
      threadAllowlist: [threadId],
      toolScopes: AGENT_BUS_AGENT_TOOL_SCOPES,
    });
    const mcpServer = buildAgentBusMcpServer({ requestImpl, credentialStore });
    const httpServer = startAgentBusMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      credentialStore,
      serverFactory: mcpServer,
      log: { info() {}, error() {} },
    });
    await once(httpServer, 'listening');
    const url = `http://127.0.0.1:${httpServer.address().port}/mcp`;
    const cordis = fakeCordisContext();
    try {
      const discovery = await discoverDeepSeekDuenoTools({ url, token: issued.token });
      assert.equal(discovery.authenticated, true);
      assert.ok(discovery.discoveredToolCount >= 2);

      await applyDshMcpClient(cordis.ctx, {
        serverName: 'dueno',
        transport: 'streamable-http',
        url,
        headers: { Authorization: `Bearer ${issued.token}` },
        toolCallTimeoutMs: 5_000,
        failOnStartupError: true,
        reconnect: { enabled: false, initialDelayMs: 10, maxDelayMs: 10, maxAttempts: 1 },
      });
      assert.ok(cordis.tools.has('mcp__dueno__room_send'));
      assert.ok(cordis.tools.has('mcp__dueno__room_context'));

      const exec = { signal: new AbortController().signal };
      const sent = await cordis.tools.get('mcp__dueno__room_send').execute({
        thread_id: threadId,
        body: 'DeepSeek authenticated bus E2E',
      }, exec);
      assert.equal(sent.structuredContent.message.id, 'msg_1');

      const received = await cordis.tools.get('mcp__dueno__room_context').execute({
        thread_id: threadId,
        limit: 10,
      }, exec);
      assert.equal(received.structuredContent.messages[0].body, 'DeepSeek authenticated bus E2E');
      assert.deepEqual(received.structuredContent.messages[0].from, { kind: 'deepseek', sessionId });
    } finally {
      await cordis.dispose();
      await new Promise((resolve) => httpServer.close(resolve));
    }
    assert.equal(cordis.tools.size, 0, 'dsh-mcp-client disposal must unregister discovered tools');
  });

  it('rejects failed authenticated discovery and never falls back to legacy', { timeout: 10_000 }, async () => {
    const credentialStore = memoryCredentialStore('enforce');
    const httpServer = startAgentBusMcpHttpServer({
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      credentialStore,
      serverFactory: buildAgentBusMcpServer({ requestImpl: async () => ({}) }),
      log: { info() {}, error() {} },
    });
    await once(httpServer, 'listening');
    const url = `http://127.0.0.1:${httpServer.address().port}/mcp`;
    try {
      await assert.rejects(
        discoverDeepSeekDuenoTools({ url, token: 'dueno_mcp_v1.unknown.invalid', timeoutMs: 2_000 }),
        (error) => error.statusCode === 503 && error.code === 'deepseek_mcp_discovery_failed',
      );
    } finally {
      await new Promise((resolve) => httpServer.close(resolve));
    }
  });
});
