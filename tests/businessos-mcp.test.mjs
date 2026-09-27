import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBusinessOsCodexConfigArgs,
  buildBusinessOsMcpSessionStore,
  clearBusinessOsMcpForSession,
  createBusinessOsMcpProxy,
  prepareBusinessOsMcpForSession,
  publicBusinessOsMcpDescriptor,
  resolveBusinessOsMcpSelection,
  writeBusinessOsClaudeMcpConfig,
} from '../modules/integrations/businessos-mcp.mjs';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length) await rm(tempDirs.pop(), { recursive: true, force: true });
});

async function tempFile() {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-businessos-mcp-'));
  tempDirs.push(dir);
  return join(dir, 'businessos_mcp_sessions.json');
}

function testConfig({ token = 'bos-secret-token' } = {}) {
  return {
    agentBusMcpHttp: { host: '127.0.0.1', port: 9876, path: '/mcp' },
    businessOsMcp: {
      mcpUrl: 'https://bos.example.test/api/agent-mcp',
      operatorToken: token,
      proxyPathPrefix: '/businessos-test',
    },
  };
}

function fakeRequest({ method = 'GET', path = '/', body = '', ip = '127.0.0.1', headers = {} } = {}) {
  return {
    method,
    url: path,
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
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

describe('BusinessOS MCP proxy', () => {
  it('normalizes persisted sessions and drops incomplete or unsafe records', async () => {
    const persisted = {
      version: 0,
      sessions: {
        legacy_key: {
          capability: ' persisted_capability ',
          backendType: ' codex ',
          sessionId: ' session_1 ',
          mcpUrl: 'https://bos.example.test/api/agent-mcp',
          token: ' secret-token ',
          createdAt: '1234',
        },
        key_as_capability: {
          backendType: 'codex',
          sessionId: 'session_key',
          mcpUrl: 'https://bos.example.test/api/agent-mcp',
          token: 'key-token',
          createdAt: 0,
        },
        missing_token: {
          backendType: 'codex',
          sessionId: 'session_2',
          mcpUrl: 'https://bos.example.test/api/agent-mcp',
        },
        unsafe_url: {
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
    const store = buildBusinessOsMcpSessionStore({ stateStore, storeFile: '' });
    const after = Date.now();

    assert.deepEqual(await store.getByCapability('persisted_capability'), {
      backendType: 'codex',
      sessionId: 'session_1',
      mcpUrl: 'https://bos.example.test/api/agent-mcp',
      token: 'secret-token',
      createdAt: 1234,
      capability: 'persisted_capability',
    });
    const keyed = await store.getByCapability('key_as_capability');
    assert.equal(keyed?.sessionId, 'session_key');
    assert.equal(keyed?.token, 'key-token');
    assert.ok(keyed.createdAt >= before - 1000 && keyed.createdAt <= after + 1000);
    assert.equal(await store.getByCapability('missing_token'), null);
    assert.equal(await store.getByCapability('unsafe_url'), null);
    await store.close();

    const emptyStore = buildBusinessOsMcpSessionStore({
      stateStore: { loadSync: () => ({ version: 0, sessions: 'nope' }), load: async () => ({}), save: async () => {} },
      storeFile: '',
    });
    assert.equal(await emptyStore.getByCapability('persisted_capability'), null);
    await emptyStore.close();
  });

  it('never publishes the configured upstream URL or bearer token', () => {
    const descriptor = publicBusinessOsMcpDescriptor(testConfig());
    assert.equal(descriptor.configured, true);
    assert.equal(Object.hasOwn(descriptor, 'url'), false);
    const serialized = JSON.stringify(descriptor);
    assert.equal(serialized.includes('bos.example.test'), false);
    assert.equal(serialized.includes('bos-secret-token'), false);
  });

  it('refuses to send Fleet bearer tokens to caller-advertised URLs', () => {
    assert.throws(
      () => resolveBusinessOsMcpSelection({
        selectedMcpServers: ['businessos'],
        mcpServers: {
          businessos: {
            type: 'http',
            url: 'https://evil.example.test/api/agent-mcp',
          },
        },
      }, { sourceConfig: testConfig() }),
      /advertised server URL does not match configured BOS MCP URL/,
    );
  });

  it('builds per-launch BusinessOS MCP config without workspace writes or bearer material', async () => {
    const storeFile = await tempFile();
    const descriptor = { url: 'http://127.0.0.1:9876/businessos-test/capability' };
    const claudeConfigPath = await writeBusinessOsClaudeMcpConfig({
      businessOsMcp: descriptor,
      sessionId: 'claude_123',
    });
    tempDirs.push(claudeConfigPath);

    const codexArgs = buildBusinessOsCodexConfigArgs(descriptor);

    assert.equal(claudeConfigPath.includes('businessos_mcp_client_configs'), true);
    assert.equal(claudeConfigPath.startsWith(join(tmpdir(), 'workspace')), false);
    assert.deepEqual(codexArgs.slice(0, 2), ['-c', 'mcp_servers.businessos.type="http"']);
    assert.equal(JSON.stringify(codexArgs).includes('Bearer'), false);
    await rm(storeFile, { force: true });
  });

  it('creates an unguessable capability URL and stores the BOS bearer in a 0600 state file', async () => {
    const storeFile = await tempFile();
    const store = buildBusinessOsMcpSessionStore({ storeFile, env: { APP_STATE_STORAGE: 'file' } });

    const descriptor = await prepareBusinessOsMcpForSession({
      input: { selectedMcpServers: ['businessos'] },
      backendType: 'codex',
      sessionId: 'codex_123',
      sourceConfig: testConfig(),
      store,
    });

    assert.match(descriptor.url, /^http:\/\/127\.0\.0\.1:9876\/businessos-test\/[a-f0-9]{64}$/);
    assert.equal(descriptor.url.includes('codex_123'), false);
    assert.equal(descriptor.alwaysLoad, false);
    assert.equal((await stat(storeFile)).mode & 0o777, 0o600);
    await store.close();
  });

  it('injects Authorization out-of-band and rejects non-loopback proxy callers', async () => {
    const storeFile = await tempFile();
    const store = buildBusinessOsMcpSessionStore({ storeFile, env: { APP_STATE_STORAGE: 'file' } });
    const descriptor = await prepareBusinessOsMcpForSession({
      input: { selectedMcpServers: ['businessos'] },
      backendType: 'codex',
      sessionId: 'codex_abc',
      sourceConfig: testConfig(),
      store,
    });
    const path = new URL(descriptor.url).pathname;
    const calls = [];
    const proxy = createBusinessOsMcpProxy({
      store,
      sourceConfig: testConfig(),
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), options });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'mcp-session-id': 'bos-session-1',
          },
        });
      },
    });

    const blockedReply = fakeReply();
    await proxy.handle(fakeRequest({ path, ip: '10.1.2.3' }), blockedReply, { requestUrl: new URL(path, 'http://127.0.0.1') });
    assert.equal(blockedReply.statusCode, 403);
    assert.equal(calls.length, 0);

    const allowedReply = fakeReply();
    await proxy.handle(fakeRequest({
      path,
      headers: {
        'mcp-method': 'tools/call',
        'mcp-name': 'bos_work_queue_list',
        'mcp-session-id': 'client-session-1',
      },
    }), allowedReply, {
      requestUrl: new URL(path, 'http://127.0.0.1'),
      protocolVersion: '2026-07-28',
    });
    assert.equal(allowedReply.statusCode, 200);
    assert.equal(calls[0].url, 'https://bos.example.test/api/agent-mcp');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer bos-secret-token');
    assert.equal(calls[0].options.headers['MCP-Protocol-Version'], '2026-07-28');
    assert.equal(calls[0].options.headers['Mcp-Method'], 'tools/call');
    assert.equal(calls[0].options.headers['Mcp-Name'], 'bos_work_queue_list');
    assert.equal(calls[0].options.headers['Mcp-Session-Id'], 'client-session-1');
    assert.equal(allowedReply.headers['Mcp-Session-Id'], 'bos-session-1');
    await store.close();
  });

  it('rejects proxy service when the MCP HTTP server is configured for non-loopback bind', async () => {
    const sourceConfig = {
      ...testConfig(),
      agentBusMcpHttp: { host: '0.0.0.0', port: 9876, path: '/mcp' },
    };
    const storeFile = await tempFile();
    const store = buildBusinessOsMcpSessionStore({ storeFile, env: { APP_STATE_STORAGE: 'file' } });
    const descriptor = await prepareBusinessOsMcpForSession({
      input: { selectedMcpServers: ['businessos'] },
      backendType: 'codex',
      sessionId: 'codex_bind',
      sourceConfig,
      store,
    });
    const proxy = createBusinessOsMcpProxy({ store, sourceConfig });
    const path = new URL(descriptor.url).pathname;
    const reply = fakeReply();

    await proxy.handle(fakeRequest({ path }), reply, { requestUrl: new URL(path, 'http://127.0.0.1') });

    assert.equal(reply.statusCode, 503);
    await store.close();
  });

  it('does not log bearer tokens on upstream fetch failure', async () => {
    const token = 'bos-token-that-must-not-log';
    const storeFile = await tempFile();
    const store = buildBusinessOsMcpSessionStore({ storeFile, env: { APP_STATE_STORAGE: 'file' } });
    const descriptor = await prepareBusinessOsMcpForSession({
      input: { selectedMcpServers: ['businessos'] },
      backendType: 'codex',
      sessionId: 'codex_log',
      sourceConfig: testConfig({ token }),
      store,
    });
    const logs = [];
    const proxy = createBusinessOsMcpProxy({
      store,
      sourceConfig: testConfig({ token }),
      fetchImpl: async () => {
        throw new Error(`upstream saw ${token}`);
      },
      log: { warn: (...args) => logs.push(args) },
    });
    const path = new URL(descriptor.url).pathname;
    const reply = fakeReply();

    await proxy.handle(fakeRequest({ path }), reply, { requestUrl: new URL(path, 'http://127.0.0.1') });

    assert.equal(reply.statusCode, 502);
    assert.equal(JSON.stringify(logs).includes(token), false);
    await store.close();
  });

  it('purges the capability on session cleanup so stale URLs stop working', async () => {
    const storeFile = await tempFile();
    const store = buildBusinessOsMcpSessionStore({ storeFile, env: { APP_STATE_STORAGE: 'file' } });
    const descriptor = await prepareBusinessOsMcpForSession({
      input: { selectedMcpServers: ['businessos'] },
      backendType: 'claude',
      sessionId: 'claude_dead',
      sourceConfig: testConfig(),
      store,
    });
    const path = new URL(descriptor.url).pathname;
    await clearBusinessOsMcpForSession({
      backendType: 'claude',
      sessionId: 'claude_dead',
      sourceConfig: testConfig(),
      store,
    });
    const proxy = createBusinessOsMcpProxy({ store, sourceConfig: testConfig() });
    const reply = fakeReply();

    await proxy.handle(fakeRequest({ path }), reply, { requestUrl: new URL(path, 'http://127.0.0.1') });

    assert.equal(reply.statusCode, 404);
    await store.close();
  });
});
