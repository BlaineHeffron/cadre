import http from 'node:http';
import { createDefaultAgentBusMcpServer } from './mcp.mjs';
import {
  AGENT_BUS_MCP_IN_PROCESS_CONTEXT_HEADER,
  bearerTokenFromHeader,
  getAgentBusCredentialStore,
} from './mcp-auth.mjs';

const MAX_JSON_BODY_BYTES = 12 * 1024 * 1024;
const STATELESS_PROTOCOL_VERSION = '2026-07-28';
const DEFAULT_LEGACY_PROTOCOL_VERSION = '2025-03-26';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const NAMED_METHODS = new Set(['tools/call', 'resources/read', 'prompts/get']);
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
  STATELESS_PROTOCOL_VERSION,
]);

function sendJson(reply, statusCode, payload, protocolVersion) {
  const body = JSON.stringify(payload);
  reply.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
  });
  reply.end(body);
}

function sendEmpty(reply, statusCode, protocolVersion) {
  reply.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
  });
  reply.end();
}

async function readJsonBody(request, { maxBytes = MAX_JSON_BODY_BYTES } = {}) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      const error = new Error(`JSON body exceeds ${maxBytes} byte limit`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

function modernRequestError(request, message, protocolVersion) {
  if (!SUPPORTED_PROTOCOL_VERSIONS.has(protocolVersion)) {
    return {
      code: -32022,
      message: `Unsupported MCP protocol version: ${protocolVersion}`,
      data: { supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS] },
    };
  }
  const meta = message?.params?._meta;
  const claimsStateless = message?.method === 'server/discover'
    || protocolVersion === STATELESS_PROTOCOL_VERSION
    || meta?.[PROTOCOL_VERSION_META_KEY] === STATELESS_PROTOCOL_VERSION;
  if (!claimsStateless) return null;
  if (protocolVersion !== STATELESS_PROTOCOL_VERSION) {
    return {
      code: -32020,
      message: `MCP-Protocol-Version header must equal ${STATELESS_PROTOCOL_VERSION}`,
    };
  }
  if (!meta || meta[PROTOCOL_VERSION_META_KEY] !== STATELESS_PROTOCOL_VERSION) {
    return {
      code: -32602,
      message: `params._meta.${PROTOCOL_VERSION_META_KEY} must equal ${STATELESS_PROTOCOL_VERSION}`,
    };
  }
  if (!meta[CLIENT_CAPABILITIES_META_KEY] || typeof meta[CLIENT_CAPABILITIES_META_KEY] !== 'object') {
    return {
      code: -32602,
      message: `params._meta.${CLIENT_CAPABILITIES_META_KEY} must be an object`,
    };
  }
  const methodHeader = String(request.headers['mcp-method'] || '');
  if (!methodHeader || methodHeader !== message?.method) {
    return {
      code: -32020,
      message: 'Mcp-Method header must match the JSON-RPC method',
    };
  }
  if (NAMED_METHODS.has(message.method)) {
    const expectedName = String(message?.params?.name || message?.params?.uri || '');
    const nameHeader = String(request.headers['mcp-name'] || '');
    if (!nameHeader || nameHeader !== expectedName) {
      return {
        code: -32020,
        message: 'Mcp-Name header must match params.name or params.uri',
      };
    }
  }
  return null;
}

export function startAgentBusMcpHttpServer({
  metaUrl,
  host = '127.0.0.1',
  port = 8765,
  path = '/mcp',
  log = console,
  serverFactory,
  businessOsMcpProxy = null,
  mcpServerProxy = null,
  credentialStore = getAgentBusCredentialStore(),
} = {}) {
  const mcpServer = serverFactory || createDefaultAgentBusMcpServer(metaUrl);

  const httpServer = http.createServer(async (request, reply) => {
    const requestUrl = new URL(request.url || '/', `http://${host}:${port}`);
    const protocolVersion = String(
      request.headers['mcp-protocol-version'] || DEFAULT_LEGACY_PROTOCOL_VERSION,
    );

    if (businessOsMcpProxy && await businessOsMcpProxy.handle(request, reply, { requestUrl, protocolVersion })) {
      return;
    }

    if (mcpServerProxy && await mcpServerProxy.handle(request, reply, { requestUrl, protocolVersion })) {
      return;
    }

    if (requestUrl.pathname !== path) {
      sendJson(reply, 404, { error: 'Not Found' }, protocolVersion);
      return;
    }

    if (request.headers[AGENT_BUS_MCP_IN_PROCESS_CONTEXT_HEADER]) {
      sendJson(reply, 400, {
        jsonrpc: '2.0', id: null,
        error: { code: -32600, message: 'Reserved in-process MCP context header is not accepted' },
      }, protocolVersion);
      return;
    }

    if (request.method === 'OPTIONS') {
      reply.writeHead(204, {
        Allow: 'POST, GET, OPTIONS',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
        'Cache-Control': 'no-store',
      });
      reply.end();
      return;
    }

    let authContext = {
      authenticated: false,
      legacyUntrusted: true,
      principal: { type: 'legacy', kind: 'legacy', sessionId: 'untrusted' },
      toolScopes: ['*'],
      threadAllowlist: ['*'],
      serverAllowlist: ['*'],
    };
    try {
      await credentialStore.init();
      const mode = credentialStore.mode;
      const token = bearerTokenFromHeader(request.headers.authorization);
      if (mode !== 'off' && token) {
        const result = await credentialStore.authenticate(token);
        if (!result.ok) {
          await credentialStore.recordRejectedCall({ reason: result.reason });
          reply.writeHead(401, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'WWW-Authenticate': 'Bearer realm="dueno-agent-bus"',
            'MCP-Protocol-Version': protocolVersion,
          });
          reply.end(JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32001, message: 'Agent Bus MCP authentication failed' },
          }));
          return;
        }
        authContext = result;
      } else if (mode === 'enforce') {
        await credentialStore.recordRejectedCall({ reason: 'missing_credential' });
        reply.writeHead(401, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'WWW-Authenticate': 'Bearer realm="dueno-agent-bus"',
          'MCP-Protocol-Version': protocolVersion,
        });
        reply.end(JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32001, message: 'Agent Bus MCP credential required' },
        }));
        return;
      } else if (mode === 'issue_only' && request.method === 'POST') {
        await credentialStore.recordLegacyCall(request.headers['mcp-method'] || request.method || '');
      }
    } catch (error) {
      log.error?.({ err: error?.message || error }, '[agent-bus-mcp-http] authentication unavailable');
      sendJson(reply, 503, {
        jsonrpc: '2.0', id: null,
        error: { code: -32002, message: 'Agent Bus MCP authentication unavailable' },
      }, protocolVersion);
      return;
    }

    if (request.method === 'GET') {
      if (protocolVersion === STATELESS_PROTOCOL_VERSION) {
        sendJson(reply, 405, { error: 'Method Not Allowed' }, protocolVersion);
        return;
      }
      sendJson(reply, 200, {
        name: 'dueno-agent-bus',
        transport: 'streamable-http',
        path,
        stateless: true,
      }, protocolVersion);
      return;
    }

    if (request.method !== 'POST') {
      sendJson(reply, 405, { error: 'Method Not Allowed' }, protocolVersion);
      return;
    }

    let message = null;
    try {
      message = await readJsonBody(request);
    } catch (err) {
      const statusCode = Number(err?.statusCode) || 400;
      sendJson(reply, statusCode, {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: statusCode === 413 ? -32000 : -32700,
          message: statusCode === 413 ? err.message : `Invalid JSON: ${err.message}`,
        },
      }, protocolVersion);
      return;
    }

    const validationError = modernRequestError(request, message, protocolVersion);
    if (validationError) {
      sendJson(reply, 400, {
        jsonrpc: '2.0',
        id: message?.id ?? null,
        error: validationError,
      }, protocolVersion);
      return;
    }

    try {
      const response = await mcpServer.handleRequest(message, { protocolVersion, authContext });
      if (!response) {
        sendEmpty(reply, 202, protocolVersion);
        return;
      }
      sendJson(reply, 200, response, protocolVersion);
    } catch (err) {
      log.error?.(`[agent-bus-mcp-http] ${err.message || 'Unhandled MCP error'}`);
      sendJson(reply, 500, {
        jsonrpc: '2.0',
        id: message?.id ?? null,
        error: { code: -32000, message: err.message || 'Unhandled MCP error' },
      }, protocolVersion);
    }
  });

  httpServer.listen(port, host, () => {
    log.info?.(`[agent-bus-mcp-http] listening on http://${host}:${port}${path}`);
  });

  return httpServer;
}
