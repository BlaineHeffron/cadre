import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  REMOTE_MCP_AUTH,
  remoteMcpAvailability,
  remoteMcpHeaders,
  remoteMcpProviderScopes,
  remoteMcpSecret,
  remoteMcpServer,
  remoteMcpStdioEnv,
} from '../modules/integrations/mcp-remote-servers.mjs';
import {
  buildRemoteMcpCredentialStore,
  createRemoteMcpProxy,
  prepareRemoteMcpServer,
} from '../modules/integrations/mcp-remote-credentials.mjs';
import {
  buildMcpOauthBroker,
  buildMcpOauthStore,
  configuredOauthProvidersSync,
} from '../modules/integrations/mcp-oauth.mjs';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length) await rm(tempDirs.pop(), { recursive: true, force: true });
});

async function tempFile(name) {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-mcp-remote-'));
  tempDirs.push(dir);
  return join(dir, name);
}

function testConfig(overrides = {}) {
  return {
    host: '127.0.0.1',
    port: 8443,
    agentBusMcpHttp: { host: '127.0.0.1', port: 9876, path: '/mcp' },
    mcpCredentials: {
      overrides: {},
      proxyPathPrefix: '/mcp-proxy-test',
      ...overrides,
    },
  };
}

function fakeRequest({ method = 'POST', path = '/', body = '', ip = '127.0.0.1' } = {}) {
  return {
    method,
    url: path,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    socket: { remoteAddress: ip },
    async *[Symbol.asyncIterator]() {
      if (body) yield Buffer.from(body);
    },
  };
}

function fakeReply() {
  return {
    statusCode: null,
    headers: null,
    body: Buffer.alloc(0),
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body = '') {
      this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    },
  };
}

describe('local Google workspace-mcp mode', () => {
  const localConfig = (overrides = {}) => testConfig({
    googleMode: 'local',
    googleLocalUrl: 'http://127.0.0.1:8000/mcp',
    ...overrides,
  });

  it('resolves every Google ID to the loopback server with no credential', () => {
    const sourceConfig = localConfig();
    for (const id of ['gmail', 'google-drive', 'google-calendar', 'google-contacts']) {
      const server = remoteMcpServer(id, { sourceConfig });
      assert.equal(server.url, 'http://127.0.0.1:8000/mcp');
      assert.equal(server.auth, REMOTE_MCP_AUTH.none);
      assert.equal(server.oauthProvider, undefined);
      assert.equal(server.healthProbe, true);
      assert.equal(remoteMcpAvailability(id, { sourceConfig }).configured, true);
    }
  });

  it('needs no Google OAuth client, so the broker asks for no Google scopes', () => {
    assert.deepEqual(remoteMcpProviderScopes('google', { sourceConfig: localConfig() }), []);
  });

  it('reports the missing endpoint when the local server URL is blank', () => {
    const availability = remoteMcpAvailability('gmail', { sourceConfig: localConfig({ googleLocalUrl: '' }) });
    assert.deepEqual(availability, { configured: false, reasonCode: 'local_server_not_configured' });
  });

  it('falls back to the managed endpoints and broker when mode is managed', () => {
    const sourceConfig = testConfig({ googleMode: 'managed' });
    const server = remoteMcpServer('gmail', { sourceConfig });
    assert.equal(server.url, 'https://gmailmcp.googleapis.com/mcp/v1');
    assert.equal(server.auth, REMOTE_MCP_AUTH.oauth);
    assert.equal(remoteMcpAvailability('gmail', { sourceConfig, connectedOauthProviders: new Set() }).reasonCode, 'oauth_not_connected');
  });
});

describe('local Slack MCP mode', () => {
  const localConfig = (overrides = {}) => testConfig({
    slackMode: 'local',
    slackLocalUrl: 'http://127.0.0.1:13080/mcp',
    ...overrides,
  });

  it('resolves slack to the loopback server with no fleet credential', () => {
    const sourceConfig = localConfig();
    const server = remoteMcpServer('slack', { sourceConfig });
    assert.equal(server.url, 'http://127.0.0.1:13080/mcp');
    assert.equal(server.auth, REMOTE_MCP_AUTH.none);
    assert.equal(server.oauthProvider, undefined);
    assert.equal(server.healthProbe, true);
    assert.equal(remoteMcpProviderScopes('slack', { sourceConfig }).length, 0);
  });

  it('needs a browser session or user token before it is selectable', () => {
    const sourceConfig = localConfig();
    assert.deepEqual(
      remoteMcpAvailability('slack', { sourceConfig, env: {} }),
      { configured: false, reasonCode: 'credential_missing' },
    );
    assert.equal(
      remoteMcpAvailability('slack', {
        sourceConfig,
        env: { SLACK_MCP_XOXP_TOKEN: 'xoxp-user' },
      }).configured,
      true,
    );
    assert.equal(
      remoteMcpAvailability('slack', {
        sourceConfig,
        env: { SLACK_MCP_XOXC_TOKEN: 'xoxc-1', SLACK_MCP_XOXD_TOKEN: 'xoxd-1' },
      }).configured,
      true,
    );
    assert.equal(
      remoteMcpAvailability('slack', {
        sourceConfig,
        env: { SLACK_MCP_XOXC_TOKEN: 'xoxc-only' },
      }).reasonCode,
      'credential_missing',
    );
  });

  it('reports the missing endpoint when the local server URL is blank', () => {
    const availability = remoteMcpAvailability('slack', {
      sourceConfig: localConfig({ slackLocalUrl: '' }),
      env: { SLACK_MCP_XOXP_TOKEN: 'xoxp-user' },
    });
    assert.deepEqual(availability, { configured: false, reasonCode: 'local_server_not_configured' });
  });

  it('falls back to Slack hosted MCP and the broker when mode is managed', () => {
    const sourceConfig = testConfig({ slackMode: 'managed' });
    const server = remoteMcpServer('slack', { sourceConfig });
    assert.equal(server.url, 'https://mcp.slack.com/mcp');
    assert.equal(server.auth, REMOTE_MCP_AUTH.oauth);
    assert.equal(server.oauthProvider, 'slack');
    assert.equal(
      remoteMcpAvailability('slack', {
        sourceConfig,
        configuredOauthProviders: new Set(),
        connectedOauthProviders: new Set(),
      }).reasonCode,
      'oauth_client_missing',
    );
    assert.equal(remoteMcpProviderScopes('slack', { sourceConfig }).includes('chat:write'), true);
  });
});

describe('remote MCP server metadata', () => {
  it('keeps Google Ads separate and requires endpoint, developer token, and OAuth', () => {
    const base = testConfig({ googleAdsUrl: '' });
    assert.deepEqual(remoteMcpAvailability('google-ads', { sourceConfig: base, env: {} }), {
      configured: false,
      reasonCode: 'endpoint_not_configured',
    });

    const sourceConfig = testConfig({ googleAdsUrl: 'http://127.0.0.1:3300/mcp' });
    const server = remoteMcpServer('google-ads', { sourceConfig });
    assert.equal(server.transport, 'http');
    assert.equal(server.oauthProvider, 'google-ads');
    assert.equal(server.oauthHeader, 'x-google-ads-access-token');
    assert.deepEqual(server.scopes, ['https://www.googleapis.com/auth/adwords']);
    assert.deepEqual(remoteMcpAvailability('google-ads', {
      sourceConfig,
      env: {},
      configuredOauthProviders: new Set(['google-ads']),
      connectedOauthProviders: new Set(['google-ads']),
    }), { configured: false, reasonCode: 'credential_missing' });
    assert.deepEqual(remoteMcpAvailability('google-ads', {
      sourceConfig,
      env: { DM_MCP_GOOGLE_ADS_DEVELOPER_TOKEN: 'developer' },
      configuredOauthProviders: new Set(['google-ads']),
      connectedOauthProviders: new Set(),
    }), { configured: false, reasonCode: 'oauth_not_connected' });
    assert.deepEqual(remoteMcpAvailability('google-ads', {
      sourceConfig,
      env: { DM_MCP_GOOGLE_ADS_DEVELOPER_TOKEN: 'developer' },
      configuredOauthProviders: new Set(['google-ads']),
      connectedOauthProviders: new Set(['google-ads']),
    }), { configured: true });
    assert.deepEqual(remoteMcpHeaders(server, { env: {
      DM_MCP_GOOGLE_ADS_DEVELOPER_TOKEN: 'developer',
      DM_MCP_GOOGLE_ADS_LOGIN_CUSTOMER_ID: '1234567890',
    } }), {
      'developer-token': 'developer',
      'login-customer-id': '1234567890',
    });
  });

  it('reports Slack OAuth unavailable until a static app client is present and connected', () => {
    const sourceConfig = testConfig({ slackMode: 'managed' });
    assert.deepEqual(
      remoteMcpAvailability('slack', {
        sourceConfig,
        configuredOauthProviders: new Set(),
        connectedOauthProviders: new Set(),
      }),
      { configured: false, reasonCode: 'oauth_client_missing' },
    );
    assert.deepEqual(
      remoteMcpAvailability('slack', {
        sourceConfig,
        configuredOauthProviders: new Set(['slack']),
        connectedOauthProviders: new Set(),
      }),
      { configured: false, reasonCode: 'oauth_not_connected' },
    );
    assert.deepEqual(
      remoteMcpAvailability('slack', {
        sourceConfig,
        configuredOauthProviders: new Set(['slack']),
        connectedOauthProviders: new Set(['slack']),
      }),
      { configured: true },
    );
  });

  it('reports an OAuth server unavailable until its provider is connected', () => {
    const sourceConfig = testConfig({ googleMode: 'managed' });
    assert.deepEqual(
      remoteMcpAvailability('gmail', { sourceConfig, connectedOauthProviders: new Set() }),
      { configured: false, reasonCode: 'oauth_not_connected' },
    );
    assert.deepEqual(
      remoteMcpAvailability('gmail', { sourceConfig, connectedOauthProviders: new Set(['google']) }),
      { configured: true },
    );
  });

  it('gates api-key servers on their env credential', () => {
    const sourceConfig = testConfig();
    assert.equal(remoteMcpAvailability('github', { sourceConfig, env: {} }).reasonCode, 'credential_missing');
    assert.equal(remoteMcpAvailability('github', { sourceConfig, env: { GITHUB_TOKEN: 'pat' } }).configured, true);
    assert.equal(remoteMcpSecret(remoteMcpServer('github'), { env: { DM_MCP_GITHUB_TOKEN: 'pat' } }), 'pat');
  });

  it('requires an operator override for self-hosted servers with no public endpoint', () => {
    assert.equal(remoteMcpAvailability('espocrm', { sourceConfig: testConfig(), env: {} }).reasonCode, 'endpoint_not_configured');
    const overridden = testConfig({ overrides: { espocrm: { url: 'https://crm.internal/mcp' } } });
    assert.equal(
      remoteMcpAvailability('espocrm', { sourceConfig: overridden, env: { DM_MCP_ESPOCRM_TOKEN: 'k' } }).configured,
      true,
    );
  });

  it('unions Google scopes across every Google-backed server', () => {
    const scopes = remoteMcpProviderScopes('google', { sourceConfig: testConfig({ googleMode: 'managed' }) });
    assert.equal(scopes.includes('https://www.googleapis.com/auth/gmail.readonly'), true);
    assert.equal(scopes.includes('https://www.googleapis.com/auth/calendar.events.readonly'), true);
    assert.equal(scopes.some((scope) => scope.includes('gmail.send')), false);
    assert.equal(scopes.includes('https://www.googleapis.com/auth/adwords'), false);
    assert.deepEqual(remoteMcpProviderScopes('google-ads', { sourceConfig: testConfig() }), [
      'https://www.googleapis.com/auth/adwords',
    ]);
  });
});

describe('seodata stdio server', () => {
  it('launches the built entry point from config', () => {
    const sourceConfig = testConfig({ seodataPath: '/home/dev/projects/seodata-mcp/dist/index.js' });
    const server = remoteMcpServer('seodata', { sourceConfig });
    assert.equal(server.transport, 'stdio');
    assert.equal(server.command, 'node');
    assert.deepEqual(server.args, ['/home/dev/projects/seodata-mcp/dist/index.js']);
  });

  it('stays unavailable until the entry point is built', () => {
    const missing = remoteMcpAvailability('seodata', {
      sourceConfig: testConfig({ seodataPath: '/nonexistent/seodata/dist/index.js' }),
    });
    assert.deepEqual(missing, { configured: false, reasonCode: 'entry_point_missing' });

    const blank = remoteMcpAvailability('seodata', { sourceConfig: testConfig({ seodataPath: '' }) });
    assert.equal(blank.reasonCode, 'entry_point_missing');
  });

  it('forwards only the seodata keys that are actually set', () => {
    const server = remoteMcpServer('seodata', { sourceConfig: testConfig() });
    assert.deepEqual(remoteMcpStdioEnv(server, { env: {} }), {});
    assert.deepEqual(
      remoteMcpStdioEnv(server, { env: { SEODATA_API_KEY: 'k', UNRELATED: 'x' } }),
      { SEODATA_API_KEY: 'k' },
    );
  });

  it('reports available once the entry point exists', () => {
    const sourceConfig = testConfig({ seodataPath: new URL(import.meta.url).pathname });
    assert.equal(remoteMcpAvailability('seodata', { sourceConfig }).configured, true);
  });
});

describe('paid-credit servers', () => {
  it('keeps meshy unavailable until its key is set, then forwards it', () => {
    const sourceConfig = testConfig();
    const server = remoteMcpServer('meshy', { sourceConfig });
    assert.equal(server.command, process.execPath);
    assert.equal(server.args.length, 1);
    assert.match(server.args[0], /@meshy-ai[/\\]meshy-mcp-server[/\\]dist[/\\]index\.js$/);
    assert.deepEqual(
      remoteMcpAvailability('meshy', { sourceConfig, env: {} }),
      { configured: false, reasonCode: 'credential_missing' },
    );
    assert.equal(remoteMcpAvailability('meshy', { sourceConfig, env: { MESHY_API_KEY: 'k' } }).configured, true);
    assert.deepEqual(remoteMcpStdioEnv(server, { env: { MESHY_API_KEY: 'k' } }), {
      MESHY_API_KEY: 'k',
    });
  });

  it('keeps pixellab unavailable until its key is set', () => {
    const sourceConfig = testConfig();
    const server = remoteMcpServer('pixellab', { sourceConfig });
    assert.equal(server.url, 'https://api.pixellab.ai/mcp');
    assert.equal(server.auth, REMOTE_MCP_AUTH.apiKeyEnv);
    assert.equal(remoteMcpAvailability('pixellab', { sourceConfig, env: {} }).reasonCode, 'credential_missing');
    assert.equal(remoteMcpAvailability('pixellab', { sourceConfig, env: { PIXELLAB_API_KEY: 'k' } }).configured, true);
    assert.equal(remoteMcpSecret(server, { env: { DM_MCP_PIXELLAB_API_KEY: 'k' } }), 'k');
  });
});

describe('image generation servers', () => {
  for (const [id, override, standard, pin] of [
    ['grok-imagine', 'DM_MCP_XAI_API_KEY', 'XAI_API_KEY', { DEFAULT_XAI_IMAGE_MODEL: 'grok-imagine-image-2.0' }],
    ['gpt-image', 'DM_MCP_OPENAI_API_KEY', 'OPENAI_API_KEY', { DEFAULT_OPENAI_IMAGE_MODEL: 'gpt-image-2.5-flare' }],
  ]) {
    it(`keeps ${id} unavailable until its key is set, then forwards it pinned`, () => {
      const sourceConfig = testConfig();
      const server = remoteMcpServer(id, { sourceConfig });
      assert.equal(server.command, process.execPath);
      assert.equal(server.args.length, 1);
      assert.match(server.args[0], /image-router-mcp[/\\]dist[/\\]index\.js$/);
      assert.deepEqual(
        remoteMcpAvailability(id, { sourceConfig, env: {} }),
        { configured: false, reasonCode: 'credential_missing' },
      );
      for (const key of [override, standard]) {
        assert.equal(remoteMcpAvailability(id, { sourceConfig, env: { [key]: 'k' } }).configured, true);
      }
      // The DM_MCP_* override wins, and the other provider's key never reaches this server.
      const env = { OPENAI_API_KEY: 'other', XAI_API_KEY: 'other', [override]: 'override', [standard]: 'standard' };
      assert.deepEqual(remoteMcpStdioEnv(server, { env, workDir: '/work/tree' }), {
        ...pin,
        [standard]: 'override',
        DEFAULT_OUTPUT_DIR: '/work/tree/generated-images',
      });
      assert.deepEqual(remoteMcpStdioEnv(server, { env: { [standard]: 'standard' } }), { ...pin, [standard]: 'standard' });
    });
  }
});

describe('reverse-engineering servers', () => {
  it('launches the installed rea-agents bin as an MCP server', () => {
    const server = remoteMcpServer('rea', { sourceConfig: testConfig() });
    assert.equal(server.command, process.execPath);
    assert.match(server.args[0], /[/\\]node_modules[/\\]rea-agents[/\\]scripts[/\\]rea\.mjs$/);
    assert.equal(server.args[1], 'mcp');
    assert.equal(remoteMcpAvailability('rea', { sourceConfig: testConfig(), env: {} }).configured, true);
  });

  it('resolves bevy_brp_mcp from PATH, then ~/.cargo/bin, and reports it missing otherwise', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bevy-brp-'));
    try {
      const sourceConfig = testConfig();
      const env = { PATH: join(root, 'bin'), HOME: root };
      assert.deepEqual(
        remoteMcpAvailability('bevy_brp', { sourceConfig, env }),
        { configured: false, reasonCode: 'binary_missing' },
      );
      // A directory or a non-executable file with the binary's name is not an install.
      await mkdir(join(root, 'bin', 'bevy_brp_mcp'), { recursive: true });
      await mkdir(join(root, '.cargo', 'bin'), { recursive: true });
      await writeFile(join(root, '.cargo', 'bin', 'bevy_brp_mcp'), '#!/bin/sh\n', { mode: 0o644 });
      assert.equal(remoteMcpAvailability('bevy_brp', { sourceConfig, env }).reasonCode, 'binary_missing');
      await rm(join(root, '.cargo', 'bin', 'bevy_brp_mcp'));
      const cargoBin = join(root, '.cargo', 'bin', 'bevy_brp_mcp');
      await writeFile(cargoBin, '#!/bin/sh\n', { mode: 0o755 });
      assert.equal(remoteMcpServer('bevy_brp', { sourceConfig, env }).command, cargoBin);
      assert.equal(remoteMcpAvailability('bevy_brp', { sourceConfig, env }).configured, true);
      await rm(join(root, 'bin'), { recursive: true });
      const pathBin = join(root, 'bin', 'bevy_brp_mcp');
      await mkdir(dirname(pathBin), { recursive: true });
      await writeFile(pathBin, '#!/bin/sh\n', { mode: 0o755 });
      assert.equal(remoteMcpServer('bevy_brp', { sourceConfig, env }).command, pathBin);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('remote MCP credential injection', () => {
  it('normalizes persisted capabilities and drops incomplete or unsafe records', async () => {
    const persisted = {
      version: 0,
      sessions: {
        legacy_key: {
          capability: ' persisted_capability ',
          serverId: ' gmail ',
          backendType: ' codex ',
          sessionId: ' session_1 ',
          mcpUrl: 'https://gmail.mcp.example.test/',
          auth: '',
          oauthProvider: ' google ',
          token: ' secret-token ',
          createdAt: '1234',
        },
        key_as_capability: {
          serverId: 'gmail',
          backendType: 'codex',
          sessionId: 'session_key',
          mcpUrl: 'https://gmail.mcp.example.test/',
          createdAt: 0,
        },
        missing_session: {
          serverId: 'gmail',
          backendType: 'codex',
          mcpUrl: 'https://gmail.mcp.example.test/',
        },
        unsafe_url: {
          serverId: 'gmail',
          backendType: 'codex',
          sessionId: 'session_3',
          mcpUrl: 'file:///tmp/not-an-mcp-server',
          token: 'must-not-survive',
        },
      },
    };
    const stateStore = {
      loadSync: () => persisted,
      load: async () => persisted,
      save: async () => {},
    };
    const before = Date.now();
    const store = buildRemoteMcpCredentialStore({ stateStore, storeFile: '' });
    const after = Date.now();

    assert.deepEqual(await store.getByCapability('persisted_capability'), {
      capability: 'persisted_capability',
      serverId: 'gmail',
      backendType: 'codex',
      sessionId: 'session_1',
      mcpUrl: 'https://gmail.mcp.example.test/',
      auth: REMOTE_MCP_AUTH.none,
      oauthProvider: 'google',
      token: 'secret-token',
      createdAt: 1234,
    });
    const keyed = await store.getByCapability('key_as_capability');
    assert.equal(keyed?.sessionId, 'session_key');
    assert.equal(keyed?.capability, 'key_as_capability');
    assert.ok(keyed.createdAt >= before - 1000 && keyed.createdAt <= after + 1000);
    assert.equal(await store.getByCapability('missing_session'), null);
    assert.equal(await store.getByCapability('unsafe_url'), null);
    await store.close();

    const emptyStore = buildRemoteMcpCredentialStore({
      stateStore: { loadSync: () => ({ version: 0, sessions: null }), load: async () => ({}), save: async () => {} },
      storeFile: '',
    });
    assert.equal(await emptyStore.getByCapability('persisted_capability'), null);
    await emptyStore.close();
  });

  const broker = { getAccessToken: async () => 'access-token' };
  const managedConfig = () => testConfig({ googleMode: 'managed' });

  it('hands credential-free servers over directly and proxies the rest', async () => {
    const storeFile = await tempFile('mcp_session_servers.json');
    const store = buildRemoteMcpCredentialStore({ storeFile, env: { APP_STATE_STORAGE: 'file' } });
    const sourceConfig = managedConfig();

    const open = await prepareRemoteMcpServer({
      serverId: 'deepwiki', backendType: 'codex', sessionId: 'codex_1', sourceConfig, store, env: {},
    });
    assert.deepEqual(open, { url: 'https://mcp.deepwiki.com/mcp', proxied: false });

    const gated = await prepareRemoteMcpServer({
      serverId: 'gmail', backendType: 'codex', sessionId: 'codex_1', sourceConfig, store, env: {}, broker,
    });
    assert.match(gated.url, /^http:\/\/127\.0\.0\.1:9876\/mcp-proxy-test\/[a-f0-9]{64}$/);
    assert.equal(gated.url.includes('codex_1'), false);
    assert.equal((await stat(storeFile)).mode & 0o777, 0o600);
    await store.close();
  });

  it('injects the brokered token loopback-only and dies with the session', async () => {
    const storeFile = await tempFile('mcp_session_servers.json');
    const store = buildRemoteMcpCredentialStore({ storeFile, env: { APP_STATE_STORAGE: 'file' } });
    const sourceConfig = managedConfig();
    const prepared = await prepareRemoteMcpServer({
      serverId: 'gmail', backendType: 'codex', sessionId: 'codex_2', sourceConfig, store, env: {}, broker,
    });
    const capability = new URL(prepared.url).pathname.split('/').pop();
    const requestUrl = new URL(`http://127.0.0.1:9876/mcp-proxy-test/${capability}`);

    let seenHeaders;
    const proxy = createRemoteMcpProxy({
      store,
      broker,
      sourceConfig,
      fetchImpl: async (_url, init) => {
        seenHeaders = init.headers;
        return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const remoteReply = fakeReply();
    await proxy.handle(fakeRequest({ path: requestUrl.pathname, ip: '10.0.0.5' }), remoteReply, { requestUrl });
    assert.equal(remoteReply.statusCode, 403);

    const reply = fakeReply();
    assert.equal(await proxy.handle(fakeRequest({ path: requestUrl.pathname, body: '{}' }), reply, { requestUrl }), true);
    assert.equal(reply.statusCode, 200);
    assert.equal(seenHeaders.Authorization, 'Bearer access-token');
    assert.equal(seenHeaders['x-google-ads-access-token'], undefined);

    await store.delete('codex', 'codex_2');
    const goneReply = fakeReply();
    await proxy.handle(fakeRequest({ path: requestUrl.pathname, body: '{}' }), goneReply, { requestUrl });
    assert.equal(goneReply.statusCode, 404);
    await store.close();
  });

  it('injects Google Ads developer and MCC headers without persisting them in the capability', async () => {
    const storeFile = await tempFile('mcp_session_servers.json');
    const store = buildRemoteMcpCredentialStore({ storeFile, env: { APP_STATE_STORAGE: 'file' } });
    const sourceConfig = testConfig({ googleAdsUrl: 'http://127.0.0.1:3300/mcp' });
    assert.deepEqual(await prepareRemoteMcpServer({
      serverId: 'google-ads', backendType: 'codex', sessionId: 'missing_ads', sourceConfig, store, env: {}, broker,
    }), { reasonCode: 'credential_missing' });
    const prepared = await prepareRemoteMcpServer({
      serverId: 'google-ads', backendType: 'codex', sessionId: 'codex_ads', sourceConfig, store,
      env: { DM_MCP_GOOGLE_ADS_DEVELOPER_TOKEN: 'developer' }, broker,
    });
    const requestUrl = new URL(prepared.url);
    let seenHeaders;
    let upstreamCalls = 0;
    const proxyEnv = {
      DM_MCP_GOOGLE_ADS_DEVELOPER_TOKEN: 'developer',
      DM_MCP_GOOGLE_ADS_LOGIN_CUSTOMER_ID: '1234567890',
    };
    const proxy = createRemoteMcpProxy({
      store,
      broker,
      sourceConfig,
      env: proxyEnv,
      fetchImpl: async (_url, init) => {
        upstreamCalls += 1;
        seenHeaders = init.headers;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    const reply = fakeReply();
    await proxy.handle(fakeRequest({ path: requestUrl.pathname, body: '{}' }), reply, { requestUrl });
    assert.equal(seenHeaders.Authorization, undefined);
    assert.equal(seenHeaders['x-google-ads-access-token'], 'access-token');
    assert.equal(seenHeaders['developer-token'], 'developer');
    assert.equal(seenHeaders['login-customer-id'], '1234567890');
    const serialized = await readFile(storeFile, 'utf8');
    assert.equal(serialized.includes('developer'), false);
    assert.equal(serialized.includes('1234567890'), false);
    delete proxyEnv.DM_MCP_GOOGLE_ADS_DEVELOPER_TOKEN;
    const missingReply = fakeReply();
    await proxy.handle(fakeRequest({ path: requestUrl.pathname, body: '{}' }), missingReply, { requestUrl });
    assert.equal(missingReply.statusCode, 503);
    assert.equal(upstreamCalls, 1);
    await store.close();
  });

  it('refuses to serve a capability whose credential vanished', async () => {
    const storeFile = await tempFile('mcp_session_servers.json');
    const store = buildRemoteMcpCredentialStore({ storeFile, env: { APP_STATE_STORAGE: 'file' } });
    const sourceConfig = managedConfig();
    const prepared = await prepareRemoteMcpServer({
      serverId: 'gmail', backendType: 'codex', sessionId: 'codex_3', sourceConfig, store, env: {}, broker,
    });
    const requestUrl = new URL(prepared.url);
    const proxy = createRemoteMcpProxy({
      store,
      broker: { getAccessToken: async () => '' },
      sourceConfig,
      fetchImpl: async () => {
        throw new Error('must not reach the upstream without a credential');
      },
      log: { warn() {} },
    });
    const reply = fakeReply();
    await proxy.handle(fakeRequest({ path: requestUrl.pathname, body: '{}' }), reply, { requestUrl });
    assert.equal(reply.statusCode, 503);
    await store.close();
  });
});

describe('MCP OAuth broker', () => {
  const googleEnv = { DM_MCP_GOOGLE_CLIENT_ID: 'client-id', DM_MCP_GOOGLE_CLIENT_SECRET: 'client-secret' };
  const googleAdsEnv = { DM_MCP_GOOGLE_ADS_CLIENT_ID: 'ads-client', DM_MCP_GOOGLE_ADS_CLIENT_SECRET: 'ads-secret' };
  const slackEnv = { DM_MCP_SLACK_CLIENT_ID: 'slack-client', DM_MCP_SLACK_CLIENT_SECRET: 'slack-secret' };

  async function brokerWithStore({ fetchImpl, now = () => 1_000_000, env = {} } = {}) {
    const storeFile = await tempFile('mcp_oauth_tokens.json');
    const store = buildMcpOauthStore({ storeFile, env: { APP_STATE_STORAGE: 'file' } });
    const sourceConfig = testConfig({ googleMode: 'managed', slackMode: 'managed' });
    sourceConfig.mcpCredentials.oauthPublicBaseUrl = 'https://fleet.test';
    return {
      storeFile,
      broker: buildMcpOauthBroker({
        store,
        sourceConfig,
        fetchImpl,
        env: { ...googleEnv, ...googleAdsEnv, ...env },
        now,
      }),
    };
  }

  it('normalizes persisted grants and drops unknown or tokenless providers', () => {
    const persisted = {
      version: 0,
      providers: {
        google: {
          refreshToken: ' refresh-token ',
          accessToken: ' access-token ',
          expiresAt: '1234',
          scopes: [' gmail.readonly ', '', null],
          clientId: ' client-id ',
          clientSecret: ' client-secret ',
          tokenUrl: ' https://oauth.example.test/token ',
          connectedAt: '5678',
        },
        slack: {
          accessToken: ' slack-access-token ',
          scopes: 'chat:write',
        },
        unknown: { refreshToken: 'must-not-survive' },
        notion: { refreshToken: '', accessToken: '' },
      },
    };
    const store = buildMcpOauthStore({
      stateStore: {
        loadSync: () => persisted,
        load: async () => persisted,
        save: async () => {},
      },
      storeFile: '',
    });

    assert.deepEqual(store.listSync(), {
      google: {
        refreshToken: 'refresh-token',
        accessToken: 'access-token',
        expiresAt: 1234,
        scopes: ['gmail.readonly'],
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tokenUrl: 'https://oauth.example.test/token',
        connectedAt: 5678,
      },
      slack: {
        refreshToken: '',
        accessToken: 'slack-access-token',
        expiresAt: 0,
        scopes: [],
        clientId: '',
        clientSecret: '',
        tokenUrl: '',
        connectedAt: 0,
      },
    });
    store.close?.();

    const emptyStore = buildMcpOauthStore({
      stateStore: {
        loadSync: () => ({ version: 0, providers: 12 }),
        load: async () => ({}),
        save: async () => {},
      },
      storeFile: '',
    });
    assert.deepEqual(emptyStore.listSync(), {});
    emptyStore.close?.();
  });

  it('builds a PKCE authorization URL with the fleet callback and catalog scopes', async () => {
    const { broker } = await brokerWithStore();
    const url = new URL((await broker.startAuthorization('google')).authorizeUrl);
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://fleet.test/api/mcp/oauth/callback');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.match(url.searchParams.get('scope'), /gmail\.readonly/);
  });

  it('uses a separate Google Ads grant with only the Ads scope', async () => {
    const { broker } = await brokerWithStore();
    const url = new URL((await broker.startAuthorization('google-ads')).authorizeUrl);
    assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/adwords');
    assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
    assert.equal(configuredOauthProvidersSync({ env: googleAdsEnv }).has('google-ads'), true);
    assert.equal(configuredOauthProvidersSync({ env: googleEnv }).has('google-ads'), false);
  });

  it('rejects a Google Ads token response with broader scopes', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_in: 3600,
      scope: 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/gmail.readonly',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const { broker } = await brokerWithStore({ fetchImpl });
    const state = new URL((await broker.startAuthorization('google-ads')).authorizeUrl).searchParams.get('state');
    await assert.rejects(
      broker.completeAuthorization({ state, code: 'auth-code' }),
      /unexpected OAuth scopes/,
    );
    assert.equal((await broker.status())['google-ads'].connected, false);
  });

  it('accepts an unchanged Google Ads grant when the token response omits scope', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      access_token: 'access', refresh_token: 'refresh', expires_in: 3600,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const { broker } = await brokerWithStore({ fetchImpl });
    const state = new URL((await broker.startAuthorization('google-ads')).authorizeUrl).searchParams.get('state');
    await broker.completeAuthorization({ state, code: 'auth-code' });
    assert.deepEqual((await broker.status())['google-ads'].scopes, ['https://www.googleapis.com/auth/adwords']);
  });

  it('rejects broader Google Ads scopes returned during refresh', async () => {
    let now = 1_000_000;
    let requests = 0;
    const fetchImpl = async () => {
      requests += 1;
      return new Response(JSON.stringify(requests === 1
        ? { access_token: 'initial', refresh_token: 'refresh', expires_in: 1 }
        : {
            access_token: 'broadened', expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/gmail.readonly',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { broker } = await brokerWithStore({ fetchImpl, now: () => now });
    const state = new URL((await broker.startAuthorization('google-ads')).authorizeUrl).searchParams.get('state');
    await broker.completeAuthorization({ state, code: 'auth-code' });
    now += 2_000;
    await assert.rejects(broker.getAccessToken('google-ads'), /unexpected OAuth scopes/);
    assert.equal((await broker.status())['google-ads'].connected, false);
    assert.equal(await broker.getAccessToken('google-ads'), '');
  });

  it('rejects a callback whose state was never issued', async () => {
    const { broker } = await brokerWithStore();
    await assert.rejects(broker.completeAuthorization({ state: 'forged', code: 'abc' }), /Unknown or expired OAuth state/);
  });

  it('stores tokens at 0600 and refreshes them before expiry', async () => {
    let now = 1_000_000;
    const grants = [];
    const fetchImpl = async (_url, init) => {
      grants.push(new URLSearchParams(init.body).get('grant_type'));
      return new Response(JSON.stringify({
        access_token: `token-${grants.length}`,
        refresh_token: 'refresh-1',
        expires_in: 3600,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { broker, storeFile } = await brokerWithStore({ fetchImpl, now: () => now });

    const state = new URL((await broker.startAuthorization('google')).authorizeUrl).searchParams.get('state');
    await broker.completeAuthorization({ state, code: 'auth-code' });
    assert.equal((await stat(storeFile)).mode & 0o777, 0o600);
    assert.equal(await broker.getAccessToken('google'), 'token-1');

    now += 3_600_000;
    assert.equal(await broker.getAccessToken('google'), 'token-2');
    assert.deepEqual(grants, ['authorization_code', 'refresh_token']);
    assert.equal((await broker.status()).google.connected, true);

    await broker.disconnect('google');
    assert.equal((await broker.status()).google.connected, false);
  });

  it('discovers endpoints and registers a client for providers without a static one', async () => {
    const requested = [];
    const fetchImpl = async (url, init = {}) => {
      const href = String(url);
      requested.push(href);
      if (href.endsWith('/.well-known/oauth-authorization-server')) {
        return new Response(JSON.stringify({
          authorization_endpoint: 'https://notion.test/authorize',
          token_endpoint: 'https://notion.test/token',
          registration_endpoint: 'https://notion.test/register',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (href === 'https://notion.test/register') {
        assert.equal(JSON.parse(init.body).redirect_uris[0], 'https://fleet.test/api/mcp/oauth/callback');
        return new Response(JSON.stringify({ client_id: 'dyn-client' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${href}`);
    };
    const { broker } = await brokerWithStore({ fetchImpl });
    const url = new URL((await broker.startAuthorization('notion')).authorizeUrl);
    assert.equal(url.searchParams.get('client_id'), 'dyn-client');
    assert.equal(requested[0], 'https://mcp.notion.com/.well-known/oauth-authorization-server');
  });

  it('uses Slack user-token endpoints and the static app client', async () => {
    const { broker } = await brokerWithStore({ env: slackEnv });
    const started = await broker.startAuthorization('slack');
    const url = new URL(started.authorizeUrl);
    assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2_user/authorize');
    assert.equal(url.searchParams.get('client_id'), 'slack-client');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(url.searchParams.get('scope') || '', /chat:write/);
    assert.equal(started.redirectUri, 'https://fleet.test/api/mcp/oauth/callback');
    assert.equal(configuredOauthProvidersSync({ env: slackEnv }).has('slack'), true);
    assert.equal(configuredOauthProvidersSync({ env: {} }).has('slack'), false);
  });

  it('rejects Slack token replies that use HTTP 200 with ok:false', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ ok: false, error: 'invalid_code' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const { broker } = await brokerWithStore({ fetchImpl, env: slackEnv });
    const state = new URL((await broker.startAuthorization('slack')).authorizeUrl).searchParams.get('state');
    await assert.rejects(broker.completeAuthorization({ state, code: 'bad' }), /invalid_code/);
  });

  it('accepts a Slack user-token grant without a refresh token', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      ok: true,
      access_token: 'xoxp-user',
      token_type: 'user',
      authed_user: { id: 'U1', scope: 'chat:write,search:read.public' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const { broker } = await brokerWithStore({ fetchImpl, env: slackEnv });
    const state = new URL((await broker.startAuthorization('slack')).authorizeUrl).searchParams.get('state');
    await broker.completeAuthorization({ state, code: 'ok-code' });
    assert.equal(await broker.getAccessToken('slack'), 'xoxp-user');
    assert.equal((await broker.status()).slack.connected, true);
  });

  it('refuses Google consent when no operator client is configured', async () => {
    const storeFile = await tempFile('mcp_oauth_tokens.json');
    const broker = buildMcpOauthBroker({
      store: buildMcpOauthStore({ storeFile, env: { APP_STATE_STORAGE: 'file' } }),
      sourceConfig: testConfig({ googleMode: 'managed' }),
      env: {},
    });
    await assert.rejects(broker.startAuthorization('google'), /DM_MCP_GOOGLE_CLIENT_ID/);
    await assert.rejects(broker.startAuthorization('slack'), /DM_MCP_SLACK_CLIENT_ID/);
  });
});
