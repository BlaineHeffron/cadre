import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { startAgentBusMcpHttpServer } from '../modules/agent-bus/mcp-http.mjs';
import { AgentBusCredentialStore } from '../modules/agent-bus/mcp-auth.mjs';

function inMemoryCredentialStore(mode = 'issue_only') {
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

describe('Agent bus MCP HTTP server', () => {
  it('serves MCP requests over loopback HTTP', async () => {
    const httpServer = startAgentBusMcpHttpServer({
      metaUrl: import.meta.url,
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      log: { info() {}, error() {} },
      credentialStore: inMemoryCredentialStore(),
      serverFactory: {
        async handleRequest(message) {
          if (message.method === 'initialize') {
            return {
              jsonrpc: '2.0',
              id: message.id,
              result: {
                protocolVersion: '2024-11-05',
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'dueno-agent-bus', version: '0.1.0' },
              },
            };
          }
          return {
            jsonrpc: '2.0',
            id: message.id,
            result: { ok: true },
          };
        },
      },
    });

    await once(httpServer, 'listening');
    const address = httpServer.address();
    const baseUrl = `http://127.0.0.1:${address.port}/mcp`;

    const healthResponse = await fetch(baseUrl);
    assert.equal(healthResponse.status, 200);
    const healthPayload = await healthResponse.json();
    assert.equal(healthPayload.transport, 'streamable-http');

    const initResponse = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2024-11-05',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      }),
    });
    assert.equal(initResponse.status, 200);
    assert.equal(initResponse.headers.get('mcp-protocol-version'), '2024-11-05');
    const initPayload = await initResponse.json();
    assert.equal(initPayload.result.serverInfo.name, 'dueno-agent-bus');

    const reservedHeader = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-dueno-inprocess-mcp-context': 'forged' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.equal(reservedHeader.status, 400);

    await new Promise((resolve) => httpServer.close(resolve));
  });

  it('rejects MCP JSON bodies over the 12MB cap', async () => {
    const httpServer = startAgentBusMcpHttpServer({
      metaUrl: import.meta.url,
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      log: { info() {}, error() {} },
      credentialStore: inMemoryCredentialStore(),
      serverFactory: {
        async handleRequest() {
          throw new Error('oversize body should be rejected before MCP handling');
        },
      },
    });

    await once(httpServer, 'listening');
    const address = httpServer.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'ping',
        params: { text: 'x'.repeat((12 * 1024 * 1024) + 1) },
      }),
    });

    assert.equal(response.status, 413);
    const payload = await response.json();
    assert.match(payload.error.message, /exceeds 12582912 byte limit/);

    await new Promise((resolve) => httpServer.close(resolve));
  });

  it('enforces sessionless 2026 request metadata and routing headers', async () => {
    const httpServer = startAgentBusMcpHttpServer({
      metaUrl: import.meta.url,
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      log: { info() {}, error() {} },
      credentialStore: inMemoryCredentialStore(),
      serverFactory: {
        async handleRequest(message, options) {
          assert.equal(options.protocolVersion, '2026-07-28');
          return {
            jsonrpc: '2.0',
            id: message.id,
            result: { resultType: 'complete', supportedVersions: ['2026-07-28'] },
          };
        },
      },
    });

    await once(httpServer, 'listening');
    const address = httpServer.address();
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 'discover',
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'server/discover',
      },
      body,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('mcp-session-id'), null);
    assert.deepEqual((await response.json()).result.supportedVersions, ['2026-07-28']);

    const mismatch = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
      body,
    });
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error.code, -32020);

    await new Promise((resolve) => httpServer.close(resolve));
  });
});
