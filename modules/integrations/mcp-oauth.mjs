/**
 * OAuth broker for catalog MCP servers.
 *
 * Spawned agents run headless in tmux, so the CLI's own loopback-browser OAuth
 * flow cannot complete (anthropics/claude-code#69205). The fleet instead holds
 * the grant: an operator consents once in the fleet UI, refresh tokens are kept
 * server-side at 0600, and the session proxy injects a fresh access token per
 * request. Tokens are never written into agent workspaces, prompts, or configs.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { config } from '../../config.mjs';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import { remoteMcpProviderScopes } from './mcp-remote-servers.mjs';
import { readEnv } from '../platform/cadre-env.mjs';

const DEFAULT_STORE_FILE = runtimeStatePath('mcp_oauth_tokens.json');
const PENDING_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;

/**
 * Google publishes stable OAuth endpoints. Every other provider follows the MCP
 * spec: authorization-server metadata is discovered from the server URL, and a
 * client is dynamically registered when no static client id is configured.
 */
export const MCP_OAUTH_PROVIDERS = Object.freeze({
  google: {
    id: 'google',
    label: 'Google Workspace',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientIdEnv: ['DM_MCP_GOOGLE_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_ID'],
    clientSecretEnv: ['DM_MCP_GOOGLE_CLIENT_SECRET', 'GOOGLE_OAUTH_CLIENT_SECRET'],
    requiresStaticClient: true,
    authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  },
  'google-ads': {
    id: 'google-ads',
    label: 'Google Ads',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientIdEnv: ['DM_MCP_GOOGLE_ADS_CLIENT_ID'],
    clientSecretEnv: ['DM_MCP_GOOGLE_ADS_CLIENT_SECRET'],
    requiresStaticClient: true,
    exactScopes: ['https://www.googleapis.com/auth/adwords'],
    authorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' },
  },
  slack: {
    id: 'slack',
    label: 'Slack',
    // Managed mode only. Slack does not support dynamic client registration;
    // a workspace-internal (or Marketplace) app must supply a confidential client.
    authorizeUrl: 'https://slack.com/oauth/v2_user/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.user.access',
    clientIdEnv: ['DM_MCP_SLACK_CLIENT_ID', 'SLACK_CLIENT_ID'],
    clientSecretEnv: ['DM_MCP_SLACK_CLIENT_SECRET', 'SLACK_CLIENT_SECRET'],
    requiresStaticClient: true,
  },
  notion: { id: 'notion', label: 'Notion', discoverFrom: 'https://mcp.notion.com/mcp' },
  atlassian: { id: 'atlassian', label: 'Atlassian', discoverFrom: 'https://mcp.atlassian.com/v1/mcp' },
  linear: { id: 'linear', label: 'Linear', discoverFrom: 'https://mcp.linear.app/mcp' },
  sentry: { id: 'sentry', label: 'Sentry', discoverFrom: 'https://mcp.sentry.dev/mcp' },
  vercel: { id: 'vercel', label: 'Vercel', discoverFrom: 'https://mcp.vercel.com/' },
  supabase: { id: 'supabase', label: 'Supabase', discoverFrom: 'https://mcp.supabase.com/mcp' },
  cloudflare: {
    id: 'cloudflare',
    label: 'Cloudflare',
    discoverFrom: 'https://observability.mcp.cloudflare.com/mcp',
  },
});

function text(value) {
  return String(value ?? '').trim();
}

function envValue(keys = [], env = process.env) {
  for (const key of [].concat(keys)) {
    const value = text(readEnv(key, env));
    if (value) return value;
  }
  return '';
}

function providerDef(providerId) {
  return MCP_OAUTH_PROVIDERS[text(providerId)] || null;
}

function staticClientFor(def, env = process.env) {
  return {
    clientId: envValue(def?.clientIdEnv || [], env),
    clientSecret: envValue(def?.clientSecretEnv || [], env),
  };
}

function oauthScopeList(tokens, fallback = []) {
  const raw = text(tokens?.scope) || text(tokens?.authed_user?.scope);
  return raw ? raw.split(/[\s,]+/).filter(Boolean) : [...fallback];
}

function resolveGrantScopes(providerId, tokens, requested = []) {
  const raw = text(tokens?.scope) || text(tokens?.authed_user?.scope);
  if (raw) return raw.split(/[\s,]+/).filter(Boolean);
  if (providerDef(providerId)?.exactScopes && !grantScopesValid(providerId, { scopes: requested })) {
    return [];
  }
  return [...requested];
}

function grantScopesValid(providerId, entry) {
  const expected = providerDef(providerId)?.exactScopes;
  if (!expected) return true;
  const actual = new Set(entry?.scopes || []);
  return actual.size === expected.length && expected.every((scope) => actual.has(scope));
}

/** Providers whose static client is present, or that rely on dynamic registration. */
export function configuredOauthProvidersSync({ env = process.env } = {}) {
  const ready = new Set();
  for (const [providerId, def] of Object.entries(MCP_OAUTH_PROVIDERS)) {
    if (!def.requiresStaticClient) {
      ready.add(providerId);
      continue;
    }
    const client = staticClientFor(def, env);
    if (client.clientId && client.clientSecret) ready.add(providerId);
  }
  return ready;
}

/** Union of the scopes every catalog entry bound to this provider asks for. */
export function providerScopes(providerId, { sourceConfig = config } = {}) {
  return remoteMcpProviderScopes(providerId, { sourceConfig });
}

function normalizeState(raw = {}) {
  const providers = {};
  const source = raw?.providers && typeof raw.providers === 'object' ? raw.providers : {};
  for (const [providerId, value] of Object.entries(source)) {
    if (!providerDef(providerId)) continue;
    const refreshToken = text(value?.refreshToken);
    const accessToken = text(value?.accessToken);
    if (!refreshToken && !accessToken) continue;
    providers[providerId] = {
      refreshToken,
      accessToken,
      expiresAt: Number(value?.expiresAt || 0) || 0,
      scopes: Array.isArray(value?.scopes) ? value.scopes.map(text).filter(Boolean) : [],
      clientId: text(value?.clientId),
      clientSecret: text(value?.clientSecret),
      tokenUrl: text(value?.tokenUrl),
      connectedAt: Number(value?.connectedAt || 0) || 0,
    };
  }
  return { version: 1, providers };
}

export function buildMcpOauthStore({ stateStore, storeFile = DEFAULT_STORE_FILE, env = process.env } = {}) {
  const backingStore = stateStore || buildPostgresJsonStore({
    namespace: 'mcp_oauth_tokens',
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
    const snapshot = JSON.parse(JSON.stringify(state));
    const write = saveQueue.catch(() => {}).then(() => backingStore.save(snapshot));
    saveQueue = write.catch(() => {});
    await write;
    if (storeFile) await chmod(storeFile, 0o600).catch(() => {});
  }

  return {
    /** Snapshot of the in-memory state, for sync catalog availability checks. */
    listSync() {
      return Object.fromEntries(Object.entries(state.providers).map(([id, entry]) => [id, { ...entry }]));
    },
    async get(providerId) {
      await load();
      const entry = state.providers[text(providerId)];
      return entry ? { ...entry } : null;
    },
    async list() {
      await load();
      return Object.fromEntries(Object.entries(state.providers).map(([id, entry]) => [id, { ...entry }]));
    },
    async put(providerId, entry) {
      await load();
      const id = text(providerId);
      if (!id || !providerDef(id)) return null;
      const previous = state.providers[id] || {};
      const next = {
        ...previous,
        ...entry,
        refreshToken: text(entry?.refreshToken) || text(previous.refreshToken),
        connectedAt: previous.connectedAt || Date.now(),
      };
      state.providers[id] = next;
      await save();
      return { ...next };
    },
    async delete(providerId) {
      await load();
      const id = text(providerId);
      if (!state.providers[id]) return false;
      delete state.providers[id];
      await save();
      return true;
    },
  };
}

let defaultStore = null;

export function getMcpOauthStore(sourceConfig = config) {
  if (!defaultStore) {
    defaultStore = buildMcpOauthStore({
      storeFile: sourceConfig.mcpCredentials?.oauthStateFile || DEFAULT_STORE_FILE,
    });
  }
  return defaultStore;
}

async function fetchJson(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`OAuth request failed (${response.status}) for ${url}: ${detail.slice(0, 200)}`);
    error.statusCode = 502;
    throw error;
  }
  return response.json();
}

/** RFC 8414 / OpenID discovery against the MCP server's origin. */
async function discoverEndpoints(def, { fetchImpl = fetch } = {}) {
  if (def.authorizeUrl && def.tokenUrl) {
    return { authorizeUrl: def.authorizeUrl, tokenUrl: def.tokenUrl, registrationUrl: '' };
  }
  const origin = new URL(def.discoverFrom).origin;
  const candidates = [
    `${origin}/.well-known/oauth-authorization-server`,
    `${origin}/.well-known/openid-configuration`,
  ];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const metadata = await fetchJson(fetchImpl, candidate, { headers: { Accept: 'application/json' } });
      const authorizeUrl = text(metadata.authorization_endpoint);
      const tokenUrl = text(metadata.token_endpoint);
      if (authorizeUrl && tokenUrl) {
        return { authorizeUrl, tokenUrl, registrationUrl: text(metadata.registration_endpoint) };
      }
    } catch (error) {
      lastError = error;
    }
  }
  const error = new Error(`No OAuth metadata published for ${def.id}`);
  error.statusCode = 502;
  error.cause = lastError;
  throw error;
}

/** RFC 7591 dynamic client registration, used when no static client is configured. */
async function registerClient(def, { registrationUrl, redirectUri, fetchImpl = fetch }) {
  if (!registrationUrl) {
    const error = new Error(`${def.id} requires a preconfigured OAuth client id`);
    error.statusCode = 400;
    throw error;
  }
  const registration = await fetchJson(fetchImpl, registrationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Cadre',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  return {
    clientId: text(registration.client_id),
    clientSecret: text(registration.client_secret),
  };
}

function pkcePair() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function safeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length || !left.length) return false;
  return timingSafeEqual(left, right);
}

export function buildMcpOauthBroker({
  store = getMcpOauthStore(),
  sourceConfig = config,
  fetchImpl = fetch,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  const pending = new Map();
  const refreshing = new Map();

  function prunePending() {
    for (const [state, entry] of pending) {
      if (now() - entry.createdAt > PENDING_TTL_MS) pending.delete(state);
    }
  }

  function redirectUri() {
    const base = text(sourceConfig.mcpCredentials?.oauthPublicBaseUrl)
      || `http://${text(sourceConfig.host) || '127.0.0.1'}:${sourceConfig.port}`;
    return `${base.replace(/\/+$/, '')}/api/mcp/oauth/callback`;
  }

  function staticClient(def) {
    return staticClientFor(def, env);
  }

  async function status() {
    const stored = await store.list();
    const result = {};
    for (const [providerId, def] of Object.entries(MCP_OAUTH_PROVIDERS)) {
      const client = staticClient(def);
      const entry = stored[providerId] || null;
      result[providerId] = {
        id: providerId,
        label: def.label,
        // Providers with dynamic registration need no operator credential up front.
        configured: def.requiresStaticClient ? Boolean(client.clientId && client.clientSecret) : true,
        connected: Boolean(entry?.refreshToken || entry?.accessToken) && grantScopesValid(providerId, entry),
        scopes: entry?.scopes || providerScopes(providerId, { sourceConfig }),
        expiresAt: entry?.expiresAt || 0,
        connectedAt: entry?.connectedAt || 0,
        requiresStaticClient: Boolean(def.requiresStaticClient),
      };
    }
    return result;
  }

  async function startAuthorization(providerId) {
    const def = providerDef(providerId);
    if (!def) {
      const error = new Error(`Unknown MCP OAuth provider: ${providerId}`);
      error.statusCode = 404;
      throw error;
    }
    const uri = redirectUri();
    const endpoints = await discoverEndpoints(def, { fetchImpl });
    let { clientId, clientSecret } = staticClient(def);
    if (!clientId) {
      if (def.requiresStaticClient) {
        const error = new Error(`${def.label} MCP OAuth requires ${[].concat(def.clientIdEnv)[0]} and ${[].concat(def.clientSecretEnv)[0]}`);
        error.statusCode = 400;
        throw error;
      }
      ({ clientId, clientSecret } = await registerClient(def, {
        registrationUrl: endpoints.registrationUrl,
        redirectUri: uri,
        fetchImpl,
      }));
    }

    const scopes = providerScopes(providerId, { sourceConfig });
    const { verifier, challenge } = pkcePair();
    const stateToken = randomBytes(32).toString('base64url');
    prunePending();
    pending.set(stateToken, {
      providerId,
      verifier,
      clientId,
      clientSecret,
      tokenUrl: endpoints.tokenUrl,
      redirectUri: uri,
      scopes,
      createdAt: now(),
    });

    const authorizeUrl = new URL(endpoints.authorizeUrl);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', uri);
    authorizeUrl.searchParams.set('state', stateToken);
    authorizeUrl.searchParams.set('code_challenge', challenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    if (scopes.length) authorizeUrl.searchParams.set('scope', scopes.join(' '));
    for (const [key, value] of Object.entries(def.authorizeParams || {})) {
      authorizeUrl.searchParams.set(key, value);
    }
    return { providerId, authorizeUrl: authorizeUrl.toString(), redirectUri: uri, scopes };
  }

  async function exchange({ tokenUrl, clientId, clientSecret, body }) {
    const params = new URLSearchParams({ client_id: clientId, ...body });
    if (clientSecret) params.set('client_secret', clientSecret);
    const tokens = await fetchJson(fetchImpl, tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: params.toString(),
    });
    // Slack answers HTTP 200 with `{ ok: false, error }` instead of a 4xx.
    if (tokens && tokens.ok === false) {
      const error = new Error(`OAuth token request failed for ${tokenUrl}: ${text(tokens.error) || 'unknown_error'}`);
      error.statusCode = 502;
      throw error;
    }
    return tokens;
  }

  async function completeAuthorization({ state: stateToken, code } = {}) {
    prunePending();
    const key = [...pending.keys()].find((candidate) => safeEqual(candidate, text(stateToken)));
    const entry = key ? pending.get(key) : null;
    if (!entry) {
      const error = new Error('Unknown or expired OAuth state');
      error.statusCode = 400;
      throw error;
    }
    pending.delete(key);
    if (!text(code)) {
      const error = new Error('OAuth callback is missing an authorization code');
      error.statusCode = 400;
      throw error;
    }

    const tokens = await exchange({
      tokenUrl: entry.tokenUrl,
      clientId: entry.clientId,
      clientSecret: entry.clientSecret,
      body: {
        grant_type: 'authorization_code',
        code: text(code),
        redirect_uri: entry.redirectUri,
        code_verifier: entry.verifier,
      },
    });

    const expiresIn = Number(tokens.expires_in || 0);
    const scopes = resolveGrantScopes(entry.providerId, tokens, entry.scopes);
    if (!grantScopesValid(entry.providerId, { scopes })) {
      const error = new Error(`${providerDef(entry.providerId)?.label || entry.providerId} returned unexpected OAuth scopes`);
      error.statusCode = 400;
      throw error;
    }
    await store.put(entry.providerId, {
      accessToken: text(tokens.access_token),
      refreshToken: text(tokens.refresh_token),
      expiresAt: expiresIn > 0 ? now() + expiresIn * 1000 : 0,
      scopes,
      clientId: entry.clientId,
      clientSecret: entry.clientSecret,
      tokenUrl: entry.tokenUrl,
    });
    return { providerId: entry.providerId, connected: true };
  }

  async function refresh(providerId, entry) {
    const tokens = await exchange({
      tokenUrl: entry.tokenUrl,
      clientId: entry.clientId,
      clientSecret: entry.clientSecret,
      body: { grant_type: 'refresh_token', refresh_token: entry.refreshToken },
    });
    const expiresIn = Number(tokens.expires_in || 0);
    const scopes = resolveGrantScopes(providerId, tokens, entry.scopes);
    if (!grantScopesValid(providerId, { scopes })) {
      await store.delete(providerId);
      throw new Error(`${providerDef(providerId)?.label || providerId} returned unexpected OAuth scopes`);
    }
    const saved = await store.put(providerId, {
      accessToken: text(tokens.access_token),
      refreshToken: text(tokens.refresh_token) || entry.refreshToken,
      expiresAt: expiresIn > 0 ? now() + expiresIn * 1000 : 0,
      scopes,
    });
    return saved.accessToken;
  }

  /** Fresh bearer for the proxy. Refreshes ahead of expiry, one flight per provider. */
  async function getAccessToken(providerId) {
    const entry = await store.get(providerId);
    if (!entry || !grantScopesValid(providerId, entry)) return '';
    const valid = entry.accessToken && (!entry.expiresAt || entry.expiresAt - now() > REFRESH_SKEW_MS);
    if (valid) return entry.accessToken;
    if (!entry.refreshToken || !entry.tokenUrl || !entry.clientId) return entry.accessToken || '';
    if (!refreshing.has(providerId)) {
      refreshing.set(
        providerId,
        refresh(providerId, entry).finally(() => refreshing.delete(providerId)),
      );
    }
    return refreshing.get(providerId);
  }

  async function disconnect(providerId) {
    if (!providerDef(providerId)) {
      const error = new Error(`Unknown MCP OAuth provider: ${providerId}`);
      error.statusCode = 404;
      throw error;
    }
    return { providerId, disconnected: await store.delete(providerId) };
  }

  return { status, startAuthorization, completeAuthorization, getAccessToken, disconnect, redirectUri };
}

let defaultBroker = null;

export function getMcpOauthBroker(sourceConfig = config) {
  if (!defaultBroker) defaultBroker = buildMcpOauthBroker({ sourceConfig });
  return defaultBroker;
}

export function mcpOauthProviderIds() {
  return Object.keys(MCP_OAUTH_PROVIDERS);
}

/**
 * Providers with a stored grant, read synchronously so the capability catalog
 * can report availability without awaiting the broker.
 */
export function connectedOauthProvidersSync(sourceConfig = config) {
  const stored = getMcpOauthStore(sourceConfig).listSync?.() || {};
  return new Set(
    Object.entries(stored)
      .filter(([providerId, entry]) => Boolean(entry?.refreshToken || entry?.accessToken) && grantScopesValid(providerId, entry))
      .map(([providerId]) => providerId),
  );
}
