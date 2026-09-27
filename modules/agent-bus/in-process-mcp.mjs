import { buildAgentBusMcpServer } from './mcp.mjs';
import {
  AGENT_BUS_MCP_IN_PROCESS_CONTEXT_HEADER,
  discardAgentBusMcpInProcessRequestContext,
  registerAgentBusMcpInProcessRequestContext,
  runWithAgentBusMcpAuthContext,
} from './mcp-auth.mjs';

export function buildInProcessFastifyRequest({ app, buildHeaders }) {
  if (!app?.inject) throw new TypeError('app.inject is required');
  if (typeof buildHeaders !== 'function') throw new TypeError('buildHeaders is required');
  return async function inProcessFastifyRequest(path, { method = 'GET', body, authContext = null } = {}) {
    const contextId = registerAgentBusMcpInProcessRequestContext(authContext);
    let response;
    try {
      response = await runWithAgentBusMcpAuthContext(authContext, () => app.inject({
        method,
        url: path,
        payload: body,
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(contextId ? { [AGENT_BUS_MCP_IN_PROCESS_CONTEXT_HEADER]: contextId } : {}),
          ...buildHeaders(),
        },
      }));
    } finally {
      discardAgentBusMcpInProcessRequestContext(contextId);
    }
    let payload = null;
    try {
      payload = response.body ? JSON.parse(response.body) : null;
    } catch {
      payload = null;
    }
    if (response.statusCode >= 400) {
      const error = new Error(payload?.error || `${method} ${path} failed with ${response.statusCode}`);
      error.statusCode = response.statusCode;
      if (payload?.code) error.code = payload.code;
      if (payload?.reason) error.reason = payload.reason;
      if (payload?.details && typeof payload.details === 'object') error.details = payload.details;
      error.payload = payload;
      throw error;
    }
    return payload;
  };
}

export function buildInProcessAgentBusMcpServer({ requestImpl, monitorMcp, credentialStore }) {
  if (typeof requestImpl !== 'function') throw new TypeError('requestImpl is required');
  if (!monitorMcp?.tools || typeof monitorMcp.handleToolCall !== 'function') {
    throw new TypeError('monitorMcp is required');
  }
  return buildAgentBusMcpServer({
    requestImpl,
    credentialStore,
    extraTools: monitorMcp.tools.map(({ handler: _handler, ...tool }) => ({
      ...tool,
      handler: (args, context) => monitorMcp.handleToolCall(tool.name, args, context),
    })),
  });
}
