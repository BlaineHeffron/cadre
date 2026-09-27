/**
 * Session-scoped credential injection for remote catalog MCP servers.
 *
 * Same posture as the BusinessOS path: the agent only ever receives a random
 * loopback capability URL, the credential is attached by this proxy, and the
 * mapping is deleted when the session ends. Tokens never reach agent
 * workspaces, prompts, transcripts, or persisted session metadata.
 */

import { randomBytes } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { config } from '../../config.mjs';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import {
  REMOTE_MCP_AUTH,
  remoteMcpHeaders,
  remoteMcpSecret,
  remoteMcpServer,
} from './mcp-remote-servers.mjs';
import { getMcpOauthBroker } from './mcp-oauth.mjs';

const DEFAULT_STORE_FILE = runtimeStatePath('mcp_session_servers.json');
const DEFAULT_PROXY_PREFIX = '/mcp-proxy';

function text(value) {
  return String(value ?? '').trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeUrl(value = '') {
  const raw = text(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

function normalizeState(raw = {}) {
  const sessions = {};
  const source = raw?.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
  for (const [key, value] of Object.entries(source)) {
    const capability = text(value?.capability || key);
    const serverId = text(value?.serverId);
    const backendType = text(value?.backendType);
    const sessionId = text(value?.sessionId);
    const mcpUrl = normalizeUrl(value?.mcpUrl);
    if (!capability || !serverId || !backendType || !sessionId || !mcpUrl) continue;
    sessions[capability] = {
      capability,
      serverId,
      backendType,
      sessionId,
      mcpUrl,
      auth: text(value?.auth) || REMOTE_MCP_AUTH.none,
      oauthProvider: text(value?.oauthProvider),
      token: text(value?.token),
      createdAt: Number(value?.createdAt || 0) || Date.now(),
    };
  }
  return { version: 1, sessions };
}

export function buildRemoteMcpCredentialStore({ stateStore, storeFile = DEFAULT_STORE_FILE, env = process.env } = {}) {
  const backingStore = stateStore || buildPostgresJsonStore({
    namespace: 'mcp_session_servers',
    filePath: storeFile,
    env,
  });
  let loaded = false;
  let loading = null;
  let saveQueue = Promise.resolve();
  let state = normalizeState(backingStore.loadSync?.() || {});

  async function load() {
    if (loaded) return;
    if (!loading) {
      loading = (async () => {
        const raw = await backingStore.load().catch(() => null);
        if (raw && typeof raw === 'object') state = normalizeState(raw);
        loaded = true;
      })().finally(() => { loading = null; });
    }
    await loading;
  }

  async function save() {
    const snapshot = clone(state);
    const write = saveQueue.catch(() => {}).then(() => backingStore.save(snapshot));
    saveQueue = write.catch(() => {});
    await write;
    if (storeFile) await chmod(storeFile, 0o600).catch(() => {});
  }

  return {
    async put({ serverId, backendType, sessionId, mcpUrl, auth = REMOTE_MCP_AUTH.none, oauthProvider = '', token = '' }) {
      await load();
      if (!text(serverId) || !text(backendType) || !text(sessionId) || !normalizeUrl(mcpUrl)) return null;
      const capability = randomBytes(32).toString('hex');
      const entry = {
        capability,
        serverId: text(serverId),
        backendType: text(backendType),
        sessionId: text(sessionId),
        mcpUrl: normalizeUrl(mcpUrl),
        auth: text(auth) || REMOTE_MCP_AUTH.none,
        oauthProvider: text(oauthProvider),
        token: text(token),
        createdAt: Date.now(),
      };
      state.sessions[capability] = entry;
      await save();
      return clone(entry);
    },
    async getByCapability(capability) {
      await load();
      const entry = state.sessions[text(capability)];
      return entry ? clone(entry) : null;
    },
    async delete(backendType, sessionId) {
      await load();
      let changed = false;
      for (const [capability, entry] of Object.entries(state.sessions)) {
        if (entry.backendType === text(backendType) && entry.sessionId === text(sessionId)) {
          delete state.sessions[capability];
          changed = true;
        }
      }
      if (changed) await save();
    },
    async close() {
      await saveQueue.catch(() => {});
      if (typeof backingStore.close === 'function') await backingStore.close();
    },
  };
}

let defaultStore = null;

export function getRemoteMcpCredentialStore(sourceConfig = config) {
  if (!defaultStore) {
    defaultStore = buildRemoteMcpCredentialStore({
      storeFile: sourceConfig.mcpCredentials?.stateFile || DEFAULT_STORE_FILE,
    });
  }
  return defaultStore;
}

export function remoteMcpProxyPrefix(sourceConfig = config) {
  const prefix = text(sourceConfig.mcpCredentials?.proxyPathPrefix) || DEFAULT_PROXY_PREFIX;
  return `/${prefix.replace(/^\/+|\/+$/g, '')}`;
}

export function buildRemoteMcpProxyUrl({ capability, sourceConfig = config } = {}) {
  const mcp = sourceConfig.agentBusMcpHttp || {};
  return `http://${mcp.host}:${mcp.port}${remoteMcpProxyPrefix(sourceConfig)}/${encodeURIComponent(text(capability))}`;
}

/**
 * Launch URL for one selected remote server. Credential-free servers are handed
 * over directly; anything needing a secret gets a capability URL instead.
 */
export async function prepareRemoteMcpServer({
  serverId,
  backendType,
  sessionId,
  sourceConfig = config,
  store = getRemoteMcpCredentialStore(sourceConfig),
  env = process.env,
  broker = getMcpOauthBroker(sourceConfig),
} = {}) {
  const server = remoteMcpServer(serverId, { sourceConfig });
  if (!server || server.transport !== 'http') return null;
  if (server.auth === REMOTE_MCP_AUTH.none) return { url: server.url, proxied: false };

  const headers = remoteMcpHeaders(server, { env });
  if ((server.requiredHeaders || []).some((name) => !headers[name])) {
    return { reasonCode: 'credential_missing' };
  }
  const secret = remoteMcpSecret(server, { env });
  if (server.auth === REMOTE_MCP_AUTH.apiKeyEnv && !secret) return { reasonCode: 'credential_missing' };
  if (server.auth === REMOTE_MCP_AUTH.oauth && !await broker.getAccessToken(server.oauthProvider).catch(() => '')) {
    return { reasonCode: 'oauth_not_connected' };
  }
  const entry = await store.put({
    serverId,
    backendType,
    sessionId,
    mcpUrl: server.url,
    auth: server.auth,
    oauthProvider: server.oauthProvider || '',
    token: server.auth === REMOTE_MCP_AUTH.apiKeyEnv ? secret : '',
  });
  if (!entry) return null;
  return { url: buildRemoteMcpProxyUrl({ capability: entry.capability, sourceConfig }), proxied: true };
}

export async function clearRemoteMcpServersForSession({
  backendType,
  sessionId,
  sourceConfig = config,
  store = getRemoteMcpCredentialStore(sourceConfig),
} = {}) {
  await store.delete(backendType, sessionId);
}

function responseHeaders(headers, protocolVersion = '') {
  const next = {};
  const contentType = headers.get('content-type');
  if (contentType) next['Content-Type'] = contentType;
  const mcpVersion = headers.get('mcp-protocol-version') || protocolVersion;
  if (mcpVersion) next['MCP-Protocol-Version'] = mcpVersion;
  const sessionId = headers.get('mcp-session-id');
  if (sessionId) next['Mcp-Session-Id'] = sessionId;
  next['Cache-Control'] = 'no-store';
  return next;
}

async function readRawBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function isLoopbackAddress(ip = '') {
  const normalized = text(ip);
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1' || normalized === 'localhost';
}

/** Loopback proxy that injects the credential the agent is never given. */
export function createRemoteMcpProxy({
  store = getRemoteMcpCredentialStore(),
  broker = getMcpOauthBroker(),
  sourceConfig = config,
  fetchImpl = fetch,
  log = console,
  env = process.env,
} = {}) {
  const normalizedPrefix = remoteMcpProxyPrefix(sourceConfig);
  const bindHost = text(sourceConfig.agentBusMcpHttp?.host || '127.0.0.1');

  function match(pathname = '') {
    if (!pathname.startsWith(`${normalizedPrefix}/`)) return null;
    const parts = pathname.slice(`${normalizedPrefix}/`.length).split('/').map(decodeURIComponent);
    if (parts.length !== 1 || !parts[0]) return null;
    return { capability: parts[0] };
  }

  async function credentialFor(session) {
    if (session.auth === REMOTE_MCP_AUTH.oauth) {
      return broker.getAccessToken(session.oauthProvider).catch(() => '');
    }
    return session.token;
  }

  return {
    prefix: normalizedPrefix,
    match,
    async handle(request, reply, { requestUrl, protocolVersion = '' } = {}) {
      const params = match(requestUrl.pathname);
      if (!params) return false;
      if (!isLoopbackAddress(bindHost)) {
        reply.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        reply.end(JSON.stringify({ error: 'MCP proxy requires loopback bind host' }));
        return true;
      }
      if (!isLoopbackAddress(request.socket?.remoteAddress || request.connection?.remoteAddress || '')) {
        reply.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        reply.end(JSON.stringify({ error: 'MCP proxy requires loopback client' }));
        return true;
      }
      if (!['GET', 'POST', 'DELETE', 'OPTIONS'].includes(request.method)) {
        reply.writeHead(405, { Allow: 'GET, POST, DELETE, OPTIONS', 'Cache-Control': 'no-store' });
        reply.end();
        return true;
      }
      if (request.method === 'OPTIONS') {
        reply.writeHead(204, {
          Allow: 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id',
          'Cache-Control': 'no-store',
        });
        reply.end();
        return true;
      }

      const session = await store.getByCapability(params.capability);
      if (!session) {
        reply.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        reply.end(JSON.stringify({ error: 'MCP session capability not found' }));
        return true;
      }

      const credential = await credentialFor(session);
      if (!credential) {
        log.warn?.({ code: 'mcp_proxy_credential_missing', serverId: session.serverId }, 'MCP proxy has no usable credential');
        reply.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        reply.end(JSON.stringify({ error: 'MCP credential unavailable' }));
        return true;
      }

      const target = new URL(session.mcpUrl);
      const remote = remoteMcpServer(session.serverId, { sourceConfig });
      const serverHeaders = remoteMcpHeaders(remote, { env });
      if ((remote?.requiredHeaders || []).some((name) => !serverHeaders[name])) {
        reply.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        reply.end(JSON.stringify({ error: 'MCP credential unavailable' }));
        return true;
      }
      const authHeaders = session.auth === REMOTE_MCP_AUTH.oauth && remote?.oauthHeader
        ? { [remote.oauthHeader]: credential }
        : { Authorization: `Bearer ${credential}` };
      target.search = requestUrl.search;
      const body = request.method === 'POST' ? await readRawBody(request) : undefined;
      try {
        const response = await fetchImpl(target, {
          method: request.method,
          headers: {
            Accept: request.headers.accept || 'application/json',
            ...(request.headers['content-type'] ? { 'Content-Type': request.headers['content-type'] } : {}),
            ...(protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {}),
            ...(request.headers['mcp-method'] ? { 'Mcp-Method': request.headers['mcp-method'] } : {}),
            ...(request.headers['mcp-name'] ? { 'Mcp-Name': request.headers['mcp-name'] } : {}),
            ...(request.headers['mcp-session-id'] ? { 'Mcp-Session-Id': request.headers['mcp-session-id'] } : {}),
            ...serverHeaders,
            ...authHeaders,
          },
          ...(body ? { body } : {}),
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        reply.writeHead(response.status, responseHeaders(response.headers, protocolVersion));
        reply.end(buffer);
      } catch {
        log.warn?.({ code: 'mcp_proxy_fetch_failed', serverId: session.serverId }, 'MCP proxy request failed');
        reply.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        reply.end(JSON.stringify({ error: 'MCP proxy request failed' }));
      }
      return true;
    },
  };
}
