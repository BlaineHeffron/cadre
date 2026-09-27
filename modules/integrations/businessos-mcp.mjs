import { randomBytes } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import { config } from '../../config.mjs';

const SERVER_NAME = 'businessos';
const DEFAULT_PROXY_PREFIX = '/businessos-mcp';
const DEFAULT_STORE_FILE = runtimeStatePath('businessos_mcp_sessions.json');

function text(value) {
  return String(value || '').trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
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

function buildMcpUrlFromBase(baseUrl = '') {
  const raw = normalizeUrl(baseUrl);
  if (!raw) return '';
  const url = new URL(raw);
  if (url.pathname.replace(/\/+$/, '').endsWith('/api/agent-mcp')) return url.toString();
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/api/agent-mcp`;
  return url.toString();
}

export function configuredBusinessOsMcp(sourceConfig = config) {
  const mcp = sourceConfig.businessOsMcp || {};
  return {
    mcpUrl: normalizeUrl(mcp.mcpUrl) || buildMcpUrlFromBase(mcp.baseUrl),
    token: text(mcp.operatorToken),
    proxyPathPrefix: text(mcp.proxyPathPrefix) || DEFAULT_PROXY_PREFIX,
  };
}

function selectedBusinessOs(input = {}) {
  const values = [
    input.selectedMcpServers,
    input.includeMcpServers,
    input.enabledMcpServers,
    input.mcpServerSelection,
  ];
  for (const value of values) {
    if (Array.isArray(value) && value.map(text).includes(SERVER_NAME)) return true;
    if (typeof value === 'string' && value.split(',').map(text).includes(SERVER_NAME)) return true;
    if (value && typeof value === 'object' && value[SERVER_NAME] === true) return true;
  }
  return input.businessOsMcp === true || input.enableBusinessOsMcp === true;
}

function advertisedBusinessOs(input = {}) {
  const servers = input.mcpServers && typeof input.mcpServers === 'object' ? input.mcpServers : {};
  const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
  const server = servers[SERVER_NAME] && typeof servers[SERVER_NAME] === 'object' ? servers[SERVER_NAME] : null;
  const bosMeta = metadata.businessOsMcp && typeof metadata.businessOsMcp === 'object' ? metadata.businessOsMcp : null;
  return { server, metadata: bosMeta };
}

export function publicBusinessOsMcpDescriptor(sourceConfig = config) {
  const configured = configuredBusinessOsMcp(sourceConfig);
  return {
    name: SERVER_NAME,
    label: 'BusinessOS',
    configured: Boolean(configured.mcpUrl && configured.token),
    requiresExplicitSelection: true,
    alwaysLoad: false,
    authorization: 'operator_bearer_token_required',
    injection: 'explicit_bos_context_only',
  };
}

export function resolveBusinessOsMcpSelection(input = {}, { sourceConfig = config } = {}) {
  if (!selectedBusinessOs(input)) return null;

  const configured = configuredBusinessOsMcp(sourceConfig);
  const advertised = advertisedBusinessOs(input);
  const advertisedUrl = normalizeUrl(advertised.server?.url);
  const mcpUrl = configured.mcpUrl;
  if (!mcpUrl) {
    const error = new Error('BusinessOS MCP selected but no BOS MCP URL is configured');
    error.statusCode = 400;
    throw error;
  }
  if (advertisedUrl && advertisedUrl !== mcpUrl) {
    const error = new Error('BusinessOS MCP selected but advertised server URL does not match configured BOS MCP URL');
    error.statusCode = 400;
    throw error;
  }
  if (!configured.token) {
    const error = new Error('BusinessOS MCP selected but BUSINESSOS_MCP_OPERATOR_TOKEN is not configured');
    error.statusCode = 400;
    throw error;
  }

  if (advertised.server && advertised.server.type && advertised.server.type !== 'http') {
    const error = new Error('BusinessOS MCP selected but advertised server type is not http');
    error.statusCode = 400;
    throw error;
  }

  return {
    serverName: SERVER_NAME,
    mcpUrl,
    token: configured.token,
    requiresExplicitSelection: true,
    alwaysLoad: false,
    authorization: 'operator_bearer_token_required',
    advertised: {
      server: advertised.server ? {
        type: text(advertised.server.type || 'http') || 'http',
        url: mcpUrl,
        authorization: text(advertised.server.authorization || 'operator_bearer_token_required') || 'operator_bearer_token_required',
        alwaysLoad: false,
      } : null,
      metadata: advertised.metadata ? {
        serverName: text(advertised.metadata.serverName || SERVER_NAME) || SERVER_NAME,
        requiresExplicitSelection: true,
        authorization: text(advertised.metadata.authorization || 'operator_bearer_token_required') || 'operator_bearer_token_required',
      } : null,
    },
  };
}

function normalizeState(raw = {}) {
  const sessions = {};
  const source = raw?.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
  for (const [key, value] of Object.entries(source)) {
    const capability = text(value?.capability || key);
    const backendType = text(value?.backendType);
    const sessionId = text(value?.sessionId);
    const mcpUrl = normalizeUrl(value?.mcpUrl);
    const token = text(value?.token);
    if (!capability || !backendType || !sessionId || !mcpUrl || !token) continue;
    sessions[capability] = {
      backendType,
      sessionId,
      mcpUrl,
      token,
      createdAt: Number(value?.createdAt || 0) || Date.now(),
      capability,
    };
  }
  return { version: 1, sessions };
}

export function sessionKey(backendType, sessionId) {
  return `${text(backendType)}:${text(sessionId)}`;
}

export function buildBusinessOsMcpSessionStore({
  stateStore,
  storeFile = DEFAULT_STORE_FILE,
  env = process.env,
} = {}) {
  const backingStore = stateStore || buildPostgresJsonStore({
    namespace: 'businessos_mcp_sessions',
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
      })().finally(() => {
        loading = null;
      });
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
    async put({ backendType, sessionId, mcpUrl, token }) {
      await load();
      const key = sessionKey(backendType, sessionId);
      if (!key.includes(':') || !text(mcpUrl) || !text(token)) return null;
      const capability = randomBytes(32).toString('hex');
      const entry = {
        backendType: text(backendType),
        sessionId: text(sessionId),
        mcpUrl: normalizeUrl(mcpUrl),
        token: text(token),
        createdAt: Date.now(),
        capability,
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

export function getBusinessOsMcpSessionStore(sourceConfig = config) {
  if (!defaultStore) {
    defaultStore = buildBusinessOsMcpSessionStore({
      storeFile: sourceConfig.businessOsMcp?.stateFile || DEFAULT_STORE_FILE,
    });
  }
  return defaultStore;
}

export function buildBusinessOsMcpProxyUrl({
  capability,
  sourceConfig = config,
} = {}) {
  const mcp = sourceConfig.agentBusMcpHttp || {};
  const bos = configuredBusinessOsMcp(sourceConfig);
  const prefix = bos.proxyPathPrefix || DEFAULT_PROXY_PREFIX;
  return `http://${mcp.host}:${mcp.port}${prefix}/${encodeURIComponent(text(capability))}`;
}

export function buildBusinessOsCodexConfigArgs(businessOsMcp = null) {
  const url = text(businessOsMcp?.url);
  if (!url) return [];
  return [
    '-c',
    'mcp_servers.businessos.type="http"',
    '-c',
    `mcp_servers.businessos.url=${JSON.stringify(url)}`,
    '-c',
    'mcp_servers.businessos.enabled=true',
    '-c',
    'mcp_servers.businessos.startup_timeout_sec=30',
    '-c',
    'mcp_servers.businessos.tool_timeout_sec=60',
  ];
}

export async function writeBusinessOsClaudeMcpConfig({
  businessOsMcp = null,
  sessionId = '',
} = {}) {
  const url = text(businessOsMcp?.url);
  if (!url) return '';
  const configPath = runtimeStatePath(`businessos_mcp_client_configs/claude-${text(sessionId) || randomBytes(4).toString('hex')}.json`);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({
    mcpServers: {
      businessos: { type: 'http', url },
    },
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600).catch(() => {});
  return configPath;
}

export async function prepareBusinessOsMcpForSession({
  input = {},
  backendType,
  sessionId,
  sourceConfig = config,
  store = getBusinessOsMcpSessionStore(sourceConfig),
} = {}) {
  const selection = resolveBusinessOsMcpSelection(input, { sourceConfig });
  if (!selection) return null;
  const entry = await store.put({
    backendType,
    sessionId,
    mcpUrl: selection.mcpUrl,
    token: selection.token,
  });
  return {
    serverName: SERVER_NAME,
    type: 'http',
    url: buildBusinessOsMcpProxyUrl({ capability: entry.capability, sourceConfig }),
    requiresExplicitSelection: true,
    alwaysLoad: false,
    authorization: 'operator_bearer_token_required',
  };
}

export async function clearBusinessOsMcpForSession({
  backendType,
  sessionId,
  sourceConfig = config,
  store = getBusinessOsMcpSessionStore(sourceConfig),
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

export function createBusinessOsMcpProxy({
  store = getBusinessOsMcpSessionStore(),
  sourceConfig = config,
  fetchImpl = fetch,
  log = console,
} = {}) {
  const prefix = configuredBusinessOsMcp(sourceConfig).proxyPathPrefix || DEFAULT_PROXY_PREFIX;
  const normalizedPrefix = `/${prefix.replace(/^\/+|\/+$/g, '')}`;
  const bindHost = text(sourceConfig.agentBusMcpHttp?.host || '127.0.0.1');

  function match(pathname = '') {
    if (!pathname.startsWith(`${normalizedPrefix}/`)) return null;
    const parts = pathname.slice(`${normalizedPrefix}/`.length).split('/').map(decodeURIComponent);
    if (parts.length !== 1 || !parts[0]) return null;
    return { capability: parts[0] };
  }

  function isLoopbackAddress(ip = '') {
    const normalized = text(ip);
    return normalized === '127.0.0.1' || normalized === '::1' || normalized === '::ffff:127.0.0.1' || normalized === 'localhost';
  }

  function isLoopbackRequest(request) {
    return isLoopbackAddress(request.socket?.remoteAddress || request.connection?.remoteAddress || '');
  }

  return {
    prefix: normalizedPrefix,
    match,
    async handle(request, reply, { requestUrl, protocolVersion = '' } = {}) {
      const params = match(requestUrl.pathname);
      if (!params) return false;
      if (!isLoopbackAddress(bindHost)) {
        reply.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        reply.end(JSON.stringify({ error: 'BusinessOS MCP proxy requires loopback bind host' }));
        return true;
      }
      if (!isLoopbackRequest(request)) {
        reply.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        reply.end(JSON.stringify({ error: 'BusinessOS MCP proxy requires loopback client' }));
        return true;
      }
      if (!['GET', 'POST', 'OPTIONS'].includes(request.method)) {
        reply.writeHead(405, { Allow: 'GET, POST, OPTIONS', 'Cache-Control': 'no-store' });
        reply.end();
        return true;
      }
      if (request.method === 'OPTIONS') {
        reply.writeHead(204, {
          Allow: 'GET, POST, OPTIONS',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id',
          'Cache-Control': 'no-store',
        });
        reply.end();
        return true;
      }

      const session = await store.getByCapability(params.capability);
      if (!session) {
        reply.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        reply.end(JSON.stringify({ error: 'BusinessOS MCP session not found' }));
        return true;
      }

      const target = new URL(session.mcpUrl);
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
            Authorization: `Bearer ${session.token}`,
          },
          ...(body ? { body } : {}),
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        reply.writeHead(response.status, responseHeaders(response.headers, protocolVersion));
        reply.end(buffer);
      } catch (error) {
        log.warn?.({ code: 'businessos_mcp_proxy_fetch_failed' }, 'BusinessOS MCP proxy request failed');
        reply.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        reply.end(JSON.stringify({ error: 'BusinessOS MCP proxy request failed' }));
      }
      return true;
    },
  };
}

export function stripBusinessOsMcpSecrets(value = {}) {
  const copy = clone(value || {});
  if (copy.token) copy.token = '[redacted]';
  if (hasOwn(copy, 'operatorToken')) copy.operatorToken = '[redacted]';
  return copy;
}
