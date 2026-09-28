/**
 * Endpoint and credential metadata for third-party catalog servers.
 *
 * The capability catalog (`mcp-server-catalog.mjs`) owns *what* an operator may
 * select; this module owns *how* the fleet reaches it and authenticates. Secret
 * material never lives here: an entry names an env key or an OAuth provider, and
 * the value is resolved at launch behind the loopback proxy.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { config } from '../../config.mjs';
import { readEnv } from '../platform/cadre-env.mjs';

export const REMOTE_MCP_AUTH = Object.freeze({
  /** Reachable with no credential. */
  none: 'none',
  /** Static secret read from an env key, injected as `Authorization: Bearer`. */
  apiKeyEnv: 'api_key_env',
  /** Access token minted by the fleet OAuth broker. */
  oauth: 'oauth',
});

function remote(value) {
  const headerEnv = Object.fromEntries(Object.entries(value.headerEnv || {})
    .map(([name, keys]) => [name, Object.freeze([...keys])]));
  return Object.freeze({
    transport: 'http',
    auth: REMOTE_MCP_AUTH.none,
    ...value,
    scopes: Object.freeze([...(value.scopes || [])]),
    args: Object.freeze([...(value.args || [])]),
    envKeys: Object.freeze([...(value.envKeys || [])]),
    headerEnv: Object.freeze(headerEnv),
    requiredHeaders: Object.freeze([...(value.requiredHeaders || [])]),
    oauthHeader: text(value.oauthHeader),
  });
}

const GOOGLE_SCOPE = (name) => `https://www.googleapis.com/auth/${name}`;

/**
 * Google server IDs and the workspace-mcp service name each one needs enabled.
 * In local mode every ID resolves to the same self-hosted endpoint; the service
 * list is what the operator passes to `workspace-mcp --tools`.
 */
export const GOOGLE_LOCAL_SERVICES = Object.freeze({
  gmail: 'gmail',
  'google-drive': 'drive',
  'google-docs': 'docs',
  'google-sheets': 'sheets',
  'google-slides': 'slides',
  'google-calendar': 'calendar',
  'google-chat': 'chat',
  'google-contacts': 'contacts',
});

/**
 * Google Workspace managed servers, per
 * https://developers.google.com/workspace/guides/configure-mcp-servers
 * (Workspace Developer Preview Program).
 */
const DEFINITIONS = Object.freeze({
  gmail: remote({
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    auth: REMOTE_MCP_AUTH.oauth,
    oauthProvider: 'google',
    scopes: [GOOGLE_SCOPE('gmail.readonly'), GOOGLE_SCOPE('gmail.compose')],
    docsUrl: 'https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server',
  }),
  'google-drive': remote({
    url: 'https://drivemcp.googleapis.com/mcp/v1',
    auth: REMOTE_MCP_AUTH.oauth,
    oauthProvider: 'google',
    scopes: [GOOGLE_SCOPE('drive.readonly'), GOOGLE_SCOPE('drive.file')],
  }),
  'google-docs': remote({
    url: 'https://docsmcp.googleapis.com/mcp/v1',
    auth: REMOTE_MCP_AUTH.oauth,
    oauthProvider: 'google',
    scopes: [GOOGLE_SCOPE('drive.readonly'), GOOGLE_SCOPE('drive.file'), GOOGLE_SCOPE('documents')],
  }),
  'google-sheets': remote({
    url: 'https://sheetsmcp.googleapis.com/mcp/v1',
    auth: REMOTE_MCP_AUTH.oauth,
    oauthProvider: 'google',
    scopes: [GOOGLE_SCOPE('drive.readonly'), GOOGLE_SCOPE('drive.file'), GOOGLE_SCOPE('spreadsheets')],
  }),
  'google-slides': remote({
    url: 'https://slidesmcp.googleapis.com/mcp/v1',
    auth: REMOTE_MCP_AUTH.oauth,
    oauthProvider: 'google',
    scopes: [GOOGLE_SCOPE('drive.readonly'), GOOGLE_SCOPE('drive.file'), GOOGLE_SCOPE('presentations')],
  }),
  'google-calendar': remote({
    url: 'https://calendarmcp.googleapis.com/mcp/v1',
    auth: REMOTE_MCP_AUTH.oauth,
    oauthProvider: 'google',
    scopes: [
      GOOGLE_SCOPE('calendar.calendarlist.readonly'),
      GOOGLE_SCOPE('calendar.events.freebusy'),
      GOOGLE_SCOPE('calendar.events.readonly'),
    ],
    docsUrl: 'https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server',
  }),
  'google-chat': remote({
    url: 'https://chatmcp.googleapis.com/mcp/v1',
    auth: REMOTE_MCP_AUTH.oauth,
    oauthProvider: 'google',
    scopes: [
      GOOGLE_SCOPE('chat.spaces.readonly'),
      GOOGLE_SCOPE('chat.memberships.readonly'),
      GOOGLE_SCOPE('chat.messages.readonly'),
    ],
  }),
  'google-contacts': remote({
    url: 'https://people.googleapis.com/mcp/v1',
    auth: REMOTE_MCP_AUTH.oauth,
    oauthProvider: 'google',
    scopes: [GOOGLE_SCOPE('userinfo.profile'), GOOGLE_SCOPE('contacts.readonly')],
  }),
  'google-ads': remote({
    url: '',
    auth: REMOTE_MCP_AUTH.oauth,
    oauthProvider: 'google-ads',
    oauthHeader: 'x-google-ads-access-token',
    scopes: [GOOGLE_SCOPE('adwords')],
    headerEnv: {
      'developer-token': ['DM_MCP_GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_DEVELOPER_TOKEN'],
      'login-customer-id': ['DM_MCP_GOOGLE_ADS_LOGIN_CUSTOMER_ID', 'GOOGLE_ADS_LOGIN_CUSTOMER_ID'],
    },
    requiredHeaders: ['developer-token'],
    healthProbe: true,
  }),

  // A PAT keeps GitHub out of the consent round-trip entirely.
  github: remote({
    url: 'https://api.githubcopilot.com/mcp/',
    auth: REMOTE_MCP_AUTH.apiKeyEnv,
    secretEnv: ['DM_MCP_GITHUB_TOKEN', 'GITHUB_TOKEN'],
    docsUrl: 'https://github.com/github/github-mcp-server',
  }),
  sentry: remote({
    url: 'https://mcp.sentry.dev/mcp',
    auth: REMOTE_MCP_AUTH.oauth,
    oauthProvider: 'sentry',
  }),
  linear: remote({
    url: 'https://mcp.linear.app/mcp',
    auth: REMOTE_MCP_AUTH.oauth,
    oauthProvider: 'linear',
  }),
  vercel: remote({
    url: 'https://mcp.vercel.com/',
    auth: REMOTE_MCP_AUTH.oauth,
    oauthProvider: 'vercel',
  }),
  supabase: remote({
    url: 'https://mcp.supabase.com/mcp',
    auth: REMOTE_MCP_AUTH.oauth,
    oauthProvider: 'supabase',
  }),
  'cloudflare-observability': remote({
    url: 'https://observability.mcp.cloudflare.com/mcp',
    auth: REMOTE_MCP_AUTH.oauth,
    oauthProvider: 'cloudflare',
  }),
  slack: remote({
    url: 'https://mcp.slack.com/mcp',
    auth: REMOTE_MCP_AUTH.oauth,
    oauthProvider: 'slack',
    // User-token scopes Slack's hosted MCP lists as required for its tools.
    // https://docs.slack.dev/ai/slack-mcp-server/
    scopes: [
      'canvases:read',
      'canvases:write',
      'channels:history',
      'channels:read',
      'channels:write',
      'chat:write',
      'emoji:read',
      'files:read',
      'files:write',
      'groups:history',
      'groups:read',
      'groups:write',
      'im:history',
      'im:read',
      'im:write',
      'lists:read',
      'lists:write',
      'mpim:history',
      'mpim:read',
      'mpim:write',
      'reactions:read',
      'reactions:write',
      'search:read.files',
      'search:read.im',
      'search:read.mpim',
      'search:read.private',
      'search:read.public',
      'search:read.users',
      'users:read',
      'users:read.email',
    ],
    docsUrl: 'https://docs.slack.dev/ai/slack-mcp-server/',
  }),
  notion: remote({
    url: 'https://mcp.notion.com/mcp',
    auth: REMOTE_MCP_AUTH.oauth,
    oauthProvider: 'notion',
  }),
  atlassian: remote({
    url: 'https://mcp.atlassian.com/v1/mcp',
    auth: REMOTE_MCP_AUTH.oauth,
    oauthProvider: 'atlassian',
  }),
  exa: remote({
    url: 'https://mcp.exa.ai/mcp',
    auth: REMOTE_MCP_AUTH.apiKeyEnv,
    secretEnv: ['DM_MCP_EXA_API_KEY', 'EXA_API_KEY'],
  }),
  huggingface: remote({
    url: 'https://hf.co/mcp',
    auth: REMOTE_MCP_AUTH.apiKeyEnv,
    secretEnv: ['DM_MCP_HUGGINGFACE_TOKEN', 'HF_TOKEN'],
  }),
  deepwiki: remote({ url: 'https://mcp.deepwiki.com/mcp' }),
  wolfram: remote({ url: 'https://agenttools.wolfram.com/mcp' }),

  // Self-hosted. No public endpoint exists, so both need an operator override.
  espocrm: remote({
    url: '',
    auth: REMOTE_MCP_AUTH.apiKeyEnv,
    secretEnv: ['DM_MCP_ESPOCRM_TOKEN'],
  }),
  'invoice-ninja': remote({
    url: '',
    auth: REMOTE_MCP_AUTH.apiKeyEnv,
    secretEnv: ['DM_MCP_INVOICE_NINJA_TOKEN'],
  }),

  // Locally built seodata MCP server. Anonymous calls
  // work; SEODATA_API_KEY in the fleet environment raises the rate limit.
  seodata: remote({
    transport: 'stdio',
    command: 'node',
    entryPathKey: 'seodataPath',
    // tmux sessions inherit the tmux server's environment, not the fleet's, so
    // these have to be forwarded explicitly to reach the spawned server.
    envKeys: ['SEODATA_API_KEY', 'SEODATA_BASE_URL'],
  }),
  // Installed dependency, not `npx @latest`: concurrent npx installs corrupt the shared cache.
  playwright: remote({
    transport: 'stdio',
    command: process.execPath,
    args: [
      join(dirname(createRequire(import.meta.url).resolve('@playwright/mcp/package.json')), 'cli.js'),
      '--headless',
      '--isolated',
    ],
  }),
  filesystem: remote({
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    appendWorkDir: true,
  }),
  git: remote({ transport: 'stdio', command: 'uvx', args: ['mcp-server-git'] }),
  fetch: remote({ transport: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] }),
  memory: remote({ transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] }),
  'sequential-thinking': remote({
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  }),
  time: remote({ transport: 'stdio', command: 'uvx', args: ['mcp-server-time'] }),
});

function text(value) {
  return String(value ?? '').trim();
}

function overrideFor(id, sourceConfig) {
  const overrides = sourceConfig?.mcpCredentials?.overrides || {};
  const override = overrides[id];
  return override && typeof override === 'object' && !Array.isArray(override) ? override : {};
}

function googleLocalMode(sourceConfig) {
  return text(sourceConfig?.mcpCredentials?.googleMode || 'local').toLowerCase() !== 'managed';
}

function slackLocalMode(sourceConfig) {
  return text(sourceConfig?.mcpCredentials?.slackMode || 'local').toLowerCase() !== 'managed';
}

const SLACK_USER_TOKEN_ENV = Object.freeze([
  'SLACK_MCP_XOXP_TOKEN',
  'DM_MCP_SLACK_XOXP_TOKEN',
  'SLACK_MCP_XOXB_TOKEN',
  'DM_MCP_SLACK_XOXB_TOKEN',
]);
const SLACK_SESSION_TOKEN_ENV = Object.freeze({
  xoxc: ['SLACK_MCP_XOXC_TOKEN', 'DM_MCP_SLACK_XOXC_TOKEN'],
  xoxd: ['SLACK_MCP_XOXD_TOKEN', 'DM_MCP_SLACK_XOXD_TOKEN'],
});

function firstEnv(keys, env) {
  for (const key of keys) {
    const value = text(readEnv(key, env));
    if (value) return value;
  }
  return '';
}

/** Browser session (xoxc+xoxd) or a user/bot token — enough to run local Slack MCP. */
export function slackLocalCredentialPresent({ env = process.env } = {}) {
  if (SLACK_USER_TOKEN_ENV.some((key) => text(readEnv(key, env)))) return true;
  return Boolean(firstEnv(SLACK_SESSION_TOKEN_ENV.xoxc, env) && firstEnv(SLACK_SESSION_TOKEN_ENV.xoxd, env));
}

/**
 * In local mode a Google ID becomes a plain loopback endpoint: the self-hosted
 * server holds the Google grant itself, so the fleet needs no OAuth broker and
 * injects no credential.
 */
function localGoogleServer(id, sourceConfig) {
  return Object.freeze({
    transport: 'http',
    auth: REMOTE_MCP_AUTH.none,
    url: text(sourceConfig?.mcpCredentials?.googleLocalUrl),
    scopes: Object.freeze([]),
    args: Object.freeze([]),
    localService: GOOGLE_LOCAL_SERVICES[id],
    healthProbe: true,
    docsUrl: 'https://github.com/taylorwilsdon/google_workspace_mcp',
  });
}

/**
 * Local slack-mcp-server holds the operator's existing Slack session. No app
 * install on workspaces they do not own; agents never see the tokens.
 */
function localSlackServer(sourceConfig) {
  return Object.freeze({
    transport: 'http',
    auth: REMOTE_MCP_AUTH.none,
    url: text(sourceConfig?.mcpCredentials?.slackLocalUrl),
    scopes: Object.freeze([]),
    args: Object.freeze([]),
    localService: 'slack',
    healthProbe: true,
    docsUrl: 'https://github.com/korotovsky/slack-mcp-server',
  });
}

function googleAdsServer(sourceConfig) {
  return Object.freeze({
    ...DEFINITIONS['google-ads'],
    url: text(sourceConfig?.mcpCredentials?.googleAdsUrl),
  });
}

/**
 * Some stdio servers live outside the repo, so their entry point is a config
 * path rather than a fixed argv. Materialize it here so callers see plain args.
 */
function withEntryPath(server, sourceConfig) {
  if (!server?.entryPathKey) return server;
  const entryPath = text(sourceConfig?.mcpCredentials?.[server.entryPathKey]);
  return Object.freeze({
    ...server,
    entryPath,
    args: Object.freeze(entryPath ? [...server.args, entryPath] : [...server.args]),
  });
}

/** Definition with operator overrides (url/command/args) applied, or null. */
export function remoteMcpServer(id, { sourceConfig = config } = {}) {
  const serverId = text(id);
  const defined = GOOGLE_LOCAL_SERVICES[serverId] && googleLocalMode(sourceConfig)
    ? localGoogleServer(serverId, sourceConfig)
    : serverId === 'google-ads'
      ? googleAdsServer(sourceConfig)
      : serverId === 'slack' && slackLocalMode(sourceConfig)
        ? localSlackServer(sourceConfig)
        : DEFINITIONS[serverId];
  const base = withEntryPath(defined, sourceConfig);
  if (!base) return null;
  const override = overrideFor(text(id), sourceConfig);
  if (!Object.keys(override).length) return base;
  return Object.freeze({
    ...base,
    ...(override.url !== undefined ? { url: text(override.url) } : {}),
    ...(override.command !== undefined ? { command: text(override.command) } : {}),
    ...(Array.isArray(override.args) ? { args: Object.freeze(override.args.map(text)) } : {}),
  });
}

export function remoteMcpServerIds() {
  return Object.keys(DEFINITIONS);
}

/**
 * Environment a stdio server needs, taken from the fleet process. Absent keys
 * are omitted so the server falls back to its own defaults.
 */
export function remoteMcpStdioEnv(server, { env = process.env } = {}) {
  const result = {};
  for (const key of server?.envKeys || []) {
    const value = text(env[key]);
    if (value) result[key] = value;
  }
  return result;
}

/** Static secret for an api-key server, or '' when unset. */
export function remoteMcpSecret(server, { env = process.env } = {}) {
  if (!server || server.auth !== REMOTE_MCP_AUTH.apiKeyEnv) return '';
  for (const key of server.secretEnv || []) {
    const value = text(readEnv(key, env));
    if (value) return value;
  }
  return '';
}

/** Fixed per-server headers resolved from fleet-owned environment keys. */
export function remoteMcpHeaders(server, { env = process.env } = {}) {
  const result = {};
  for (const [name, keys] of Object.entries(server?.headerEnv || {})) {
    const value = firstEnv(keys, env);
    if (value) result[name] = value;
  }
  return result;
}

/** Scopes every Google-style provider entry asks for, unioned. */
export function remoteMcpProviderScopes(providerId, { sourceConfig = config } = {}) {
  const scopes = new Set();
  for (const id of remoteMcpServerIds()) {
    const server = remoteMcpServer(id, { sourceConfig });
    if (server?.oauthProvider !== providerId) continue;
    for (const scope of server.scopes) scopes.add(scope);
  }
  return [...scopes];
}

/**
 * Whether a launch could actually reach the server. OAuth readiness is decided
 * by the broker, so callers pass `connectedOauthProviders`.
 */
export function remoteMcpAvailability(id, {
  sourceConfig = config,
  env = process.env,
  connectedOauthProviders = new Set(),
  configuredOauthProviders = null,
} = {}) {
  const server = remoteMcpServer(id, { sourceConfig });
  if (!server) return null;
  if (server.transport === 'stdio') {
    if (!text(server.command)) return { configured: false, reasonCode: 'command_missing' };
    // An out-of-repo entry point may simply not be built yet.
    if (server.entryPathKey && !(text(server.entryPath) && existsSync(server.entryPath))) {
      return { configured: false, reasonCode: 'entry_point_missing' };
    }
    return { configured: true };
  }
  if (!text(server.url)) {
    return {
      configured: false,
      reasonCode: server.localService ? 'local_server_not_configured' : 'endpoint_not_configured',
    };
  }
  const headers = remoteMcpHeaders(server, { env });
  if ((server.requiredHeaders || []).some((name) => !headers[name])) {
    return { configured: false, reasonCode: 'credential_missing' };
  }
  if (server.localService === 'slack' && !slackLocalCredentialPresent({ env })) {
    return { configured: false, reasonCode: 'credential_missing' };
  }
  if (server.auth === REMOTE_MCP_AUTH.oauth) {
    if (configuredOauthProviders && !configuredOauthProviders.has(server.oauthProvider)) {
      return { configured: false, reasonCode: 'oauth_client_missing' };
    }
    return connectedOauthProviders.has(server.oauthProvider)
      ? { configured: true }
      : { configured: false, reasonCode: 'oauth_not_connected' };
  }
  if (server.auth === REMOTE_MCP_AUTH.apiKeyEnv) {
    return remoteMcpSecret(server, { env })
      ? { configured: true }
      : { configured: false, reasonCode: 'credential_missing' };
  }
  return { configured: true };
}
