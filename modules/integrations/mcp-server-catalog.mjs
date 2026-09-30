import { existsSync } from 'node:fs';
import { config } from '../../config.mjs';
import { hashJson, stableStringify } from '../ops/state-utils.mjs';
import { remoteMcpAvailability, remoteMcpServer } from './mcp-remote-servers.mjs';
import { configuredOauthProvidersSync, connectedOauthProvidersSync } from './mcp-oauth.mjs';

export const MCP_CATALOG_VERSION = 1;

const NATIVE_MCP_PROVIDERS = Object.freeze(['claude', 'codex', 'xai', 'google', 'opencode-go', 'openrouter']);
const NATIVE_MCP_RUNTIMES = Object.freeze(['claude', 'codex', 'pi']);
const DUENO_MCP_PROVIDERS = Object.freeze([...NATIVE_MCP_PROVIDERS, 'deepseek']);
const DUENO_MCP_RUNTIMES = Object.freeze([...NATIVE_MCP_RUNTIMES, 'deepseek']);

const SERVER_DEFINITIONS = Object.freeze([
  server({
    id: 'dueno',
    label: 'Cadre',
    description: 'Cadre session, thread, scheduling, and Fleet controls.',
    category: 'control-plane',
    providers: DUENO_MCP_PROVIDERS,
    runtimes: DUENO_MCP_RUNTIMES,
    transport: 'http',
    required: true,
    requiresExplicitSelection: false,
    alwaysLoad: false,
    authorization: 'server_owned',
    permissions: 'May inspect and control agent sessions and collaboration threads.',
  }),
  server({
    id: 'businessos',
    label: 'BusinessOS',
    description: 'Session-scoped BusinessOS operational context and tools.',
    category: 'operations',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    requiresExplicitSelection: true,
    alwaysLoad: false,
    authorization: 'operator_bearer_token_required',
    permissions: 'Uses a scoped operator capability; actions may affect BusinessOS.',
  }),
  server({
    id: 'paper-search',
    label: 'Paper Search',
    description: 'Federated and local scholarly paper search.',
    category: 'research',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'stdio',
    required: false,
    permissions: 'Reads scholarly indexes and local research data.',
  }),
  server({
    id: 'zotero',
    label: 'Zotero',
    description: 'Zotero library search, reading, and managed note operations.',
    category: 'research',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'stdio',
    required: false,
    permissions: 'Reads the Zotero library; approved tools may write notes.',
  }),
  server({
    id: 'nodus',
    label: 'Nodus',
    description: 'Research graph search and managed writing drafts.',
    category: 'research',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'stdio',
    required: false,
    dependencies: ['zotero'],
    permissions: 'Reads the research graph; approved tools may write drafts.',
  }),
  server({
    id: 'seodata',
    label: 'SEOdata',
    description: 'SEO reporting and analysis integration.',
    category: 'analytics',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'stdio',
    required: false,
    permissions: 'Reads configured SEO datasets and reports.',
  }),
  server({
    id: 'google-ads',
    label: 'Google Ads (write)',
    description: 'Explicit Google Ads campaign, ad group, ad, budget, and status operations.',
    category: 'advertising',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    requiresExplicitSelection: true,
    alwaysLoad: false,
    authorization: 'oauth_and_developer_token_required',
    permissions: 'May change live Google Ads spend, content, and serving state; new resources start paused.',
  }),
  server({
    id: 'gmail',
    label: 'Gmail',
    description: 'Google Mail integration.',
    category: 'communication',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'May read or modify mail according to server-owned authorization.',
  }),
  server({
    id: 'google-drive',
    label: 'Google Drive',
    description: 'Google Drive files and document integration.',
    category: 'documents',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'May read or modify Drive content according to server-owned authorization.',
  }),
  server({
    id: 'slack',
    label: 'Slack',
    description: 'Slack as your existing user: search, history, DMs, and channels in workspaces you already belong to.',
    category: 'communication',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'Acts as the operator\'s Slack user in workspaces they already belong to. Posting is off unless enabled on the local server.',
  }),
  server({
    id: 'espocrm',
    label: 'EspoCRM',
    description: 'EspoCRM records and workflows.',
    category: 'crm',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'May read or modify CRM records according to authorization.',
  }),
  server({
    id: 'google-docs',
    label: 'Google Docs',
    description: 'Google Docs document read and authoring integration.',
    category: 'documents',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'May read or modify documents according to the granted Google scopes.',
  }),
  server({
    id: 'google-sheets',
    label: 'Google Sheets',
    description: 'Google Sheets spreadsheet integration.',
    category: 'documents',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'May read or modify spreadsheets according to the granted Google scopes.',
  }),
  server({
    id: 'google-slides',
    label: 'Google Slides',
    description: 'Google Slides presentation integration.',
    category: 'documents',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'May read or modify presentations according to the granted Google scopes.',
  }),
  server({
    id: 'google-calendar',
    label: 'Google Calendar',
    description: 'Google Calendar events and free/busy lookup.',
    category: 'scheduling',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'Reads calendars and free/busy windows; no write scope is requested.',
  }),
  server({
    id: 'google-chat',
    label: 'Google Chat',
    description: 'Google Chat spaces and message history.',
    category: 'communication',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'Reads spaces, memberships, and messages.',
  }),
  server({
    id: 'google-contacts',
    label: 'Google Contacts',
    description: 'Google People directory and contact lookup.',
    category: 'communication',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'Reads profile and contact records.',
  }),
  server({
    id: 'github',
    label: 'GitHub',
    description: 'GitHub repositories, issues, pull requests, and Actions.',
    category: 'development',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'Acts with the configured personal access token; may write issues and pull requests.',
  }),
  server({
    id: 'sentry',
    label: 'Sentry',
    description: 'Sentry issues, events, and stack traces.',
    category: 'observability',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'Reads issues and may change issue state.',
  }),
  server({
    id: 'linear',
    label: 'Linear',
    description: 'Linear issues, projects, and cycles.',
    category: 'development',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'May read and modify Linear issues according to authorization.',
  }),
  server({
    id: 'vercel',
    label: 'Vercel',
    description: 'Vercel projects, deployments, and logs.',
    category: 'infrastructure',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'May inspect and act on deployments according to authorization.',
  }),
  server({
    id: 'supabase',
    label: 'Supabase',
    description: 'Supabase projects, database, and edge functions.',
    category: 'infrastructure',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'May read and modify project resources according to authorization.',
  }),
  server({
    id: 'cloudflare-observability',
    label: 'Cloudflare Observability',
    description: 'Cloudflare Workers logs and analytics.',
    category: 'observability',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'Reads Workers observability data.',
  }),
  server({
    id: 'notion',
    label: 'Notion',
    description: 'Notion pages, databases, and search.',
    category: 'knowledge',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'May read and modify shared Notion content according to authorization.',
  }),
  server({
    id: 'atlassian',
    label: 'Atlassian',
    description: 'Jira issues and Confluence pages.',
    category: 'knowledge',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'May read and modify Jira and Confluence content according to authorization.',
  }),
  server({
    id: 'exa',
    label: 'Exa Search',
    description: 'Exa neural web search and content retrieval.',
    category: 'research',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'Sends queries to Exa and reads public web content.',
  }),
  server({
    id: 'huggingface',
    label: 'Hugging Face',
    description: 'Hugging Face models, datasets, and spaces.',
    category: 'research',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'Reads Hub content with the configured token.',
  }),
  server({
    id: 'deepwiki',
    label: 'DeepWiki',
    description: 'Generated documentation for public repositories.',
    category: 'research',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'Reads public repository documentation.',
  }),
  server({
    id: 'wolfram',
    label: 'Wolfram',
    description: 'Wolfram computation and curated data.',
    category: 'research',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'Sends queries to Wolfram compute endpoints.',
  }),
  server({
    id: 'playwright',
    label: 'Playwright',
    description: 'Headless browser automation and page inspection.',
    category: 'development',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'stdio',
    required: false,
    permissions: 'Drives a headless browser and fetches arbitrary pages.',
  }),
  server({
    id: 'meshy',
    label: 'Meshy',
    description: 'Meshy 3D model, texture, rigging, and image generation.',
    category: 'creative',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'stdio',
    required: false,
    requiresExplicitSelection: true,
    alwaysLoad: false,
    permissions: 'Spends paid Meshy credits with the operator API key.',
  }),
  server({
    id: 'pixellab',
    label: 'PixelLab',
    description: 'PixelLab pixel-art character, animation, and tileset generation.',
    category: 'creative',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    requiresExplicitSelection: true,
    alwaysLoad: false,
    permissions: 'Spends paid PixelLab credits with the operator API key.',
  }),
  server({
    id: 'filesystem',
    label: 'Filesystem',
    description: 'Scoped file read and write inside the session work dir.',
    category: 'local',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'stdio',
    required: false,
    permissions: 'Reads and writes files under the session work dir only.',
  }),
  server({
    id: 'git',
    label: 'Git',
    description: 'Local repository history, diffs, and status.',
    category: 'local',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'stdio',
    required: false,
    permissions: 'Reads local repository state; approved tools may write commits.',
  }),
  server({
    id: 'fetch',
    label: 'Fetch',
    description: 'Retrieves and converts web pages to text.',
    category: 'local',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'stdio',
    required: false,
    permissions: 'Fetches arbitrary URLs from the fleet host.',
  }),
  server({
    id: 'memory',
    label: 'Memory',
    description: 'Persistent knowledge graph scratch space.',
    category: 'local',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'stdio',
    required: false,
    permissions: 'Reads and writes the local memory graph.',
  }),
  server({
    id: 'sequential-thinking',
    label: 'Sequential Thinking',
    description: 'Structured multi-step reasoning scaffold.',
    category: 'local',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'stdio',
    required: false,
    permissions: 'No external access.',
  }),
  server({
    id: 'time',
    label: 'Time',
    description: 'Current time and timezone conversion.',
    category: 'local',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'stdio',
    required: false,
    permissions: 'No external access.',
  }),
  server({
    id: 'invoice-ninja',
    label: 'Invoice Ninja',
    description: 'Invoice Ninja billing integration.',
    category: 'finance',
    providers: NATIVE_MCP_PROVIDERS,
    runtimes: NATIVE_MCP_RUNTIMES,
    transport: 'http',
    required: false,
    permissions: 'May read or modify billing data according to authorization.',
  }),
]);

const BUILTIN_PROFILES = Object.freeze({
  default: profile({
    id: 'default',
    label: 'Default',
    description: 'No MCP servers. Add Cadre (dueno) or others explicitly.',
    serverIds: [],
  }),
  dueno: profile({
    id: 'dueno',
    label: 'Cadre',
    description: 'Cadre control-plane tools only.',
    serverIds: ['dueno'],
  }),
  research: profile({
    id: 'research',
    label: 'Research',
    description: 'Zotero, Nodus, and federated paper search.',
    serverIds: ['nodus', 'zotero', 'paper-search'],
  }),
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function server(input) {
  return deepFreeze({
    ...input,
    visibility: 'public',
    providers: [...input.providers],
    runtimes: [...input.runtimes],
    dependencies: [...(input.dependencies || [])],
    healthContract: input.healthContract || 'configuration',
  });
}

function profile(input) {
  return deepFreeze({ ...input, serverIds: [...input.serverIds] });
}

function text(value) {
  return String(value || '').trim();
}

export function stableMcpJson(value) {
  return stableStringify(value);
}

export function digestMcpConfiguration(value) {
  return `sha256:${hashJson(value)}`;
}

function configuredBusinessOs(sourceConfig) {
  const bos = sourceConfig?.businessOsMcp || {};
  return Boolean(text(bos.mcpUrl || bos.baseUrl) && text(bos.operatorToken));
}

function configuredResearchServer(id, sourceConfig) {
  const research = sourceConfig?.researchWorkbench || {};
  if (id === 'zotero') return Boolean(text(research.zoteroMcpPath) && existsSync(text(research.zoteroMcpPath)));
  if (id === 'paper-search') return Boolean(text(research.paperSearchPath) && existsSync(text(research.paperSearchPath)));
  if (id === 'nodus') {
    return Boolean(
      text(research.nodusMcpPath)
      && text(research.nodusTokenFile)
      && existsSync(text(research.nodusMcpPath))
      && existsSync(text(research.nodusTokenFile))
    );
  }
  return false;
}

function configuredServer(id, sourceConfig, availabilityById) {
  const override = availabilityById?.[id];
  if (typeof override?.configured === 'boolean') return override.configured;
  if (typeof override === 'boolean') return override;
  if (id === 'dueno') return true;
  if (id === 'businessos') return configuredBusinessOs(sourceConfig);
  if (['paper-search', 'zotero', 'nodus'].includes(id)) return configuredResearchServer(id, sourceConfig);
  return remoteMcpAvailability(id, oauthAvailabilityOptions(sourceConfig))?.configured === true;
}

function oauthAvailabilityOptions(sourceConfig) {
  return {
    sourceConfig,
    connectedOauthProviders: connectedOauthProvidersSync(sourceConfig),
    configuredOauthProviders: configuredOauthProvidersSync(),
  };
}

/** Why a third-party server is unusable, so the UI can name the missing piece. */
function remoteReasonCode(id, sourceConfig) {
  return remoteMcpAvailability(id, oauthAvailabilityOptions(sourceConfig))?.reasonCode || '';
}

function publicServer(definition, sourceConfig, availabilityById) {
  const configured = configuredServer(definition.id, sourceConfig, availabilityById);
  const override = availabilityById?.[definition.id];
  const reasonCode = configured
    ? null
    : text(override?.reasonCode) || remoteReasonCode(definition.id, sourceConfig) || 'not_configured';
  const remote = remoteMcpServer(definition.id, { sourceConfig });
  return deepFreeze({
    ...definition,
    ...(remote?.oauthProvider ? { oauthProvider: remote.oauthProvider } : {}),
    availability: {
      state: configured ? 'configured' : 'unconfigured',
      reasonCode,
    },
    health: {
      state: configured ? 'unknown' : 'unavailable',
      reasonCode,
    },
  });
}

function customProfiles(sourceConfig) {
  const entries = sourceConfig?.mcpCapabilities?.profiles;
  return entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : {};
}

function normalizeCustomProfile(id, value) {
  const profileId = text(id);
  const source = Array.isArray(value) ? { serverIds: value } : value;
  if (!profileId || profileId !== id || !source || typeof source !== 'object' || !Array.isArray(source.serverIds)) {
    throw new TypeError(`Invalid MCP capability profile: ${profileId || '<empty>'}`);
  }
  const serverIds = source.serverIds.map((serverId) => {
    if (typeof serverId !== 'string' || !serverId.trim() || serverId !== serverId.trim()) {
      throw new TypeError(`Invalid MCP server ID in profile ${profileId}`);
    }
    return serverId;
  });
  return profile({
    id: profileId,
    label: text(source.label) || profileId,
    description: text(source.description),
    serverIds,
  });
}

export function buildMcpCapabilityCatalog({
  sourceConfig = config,
  availabilityById = {},
} = {}) {
  const servers = SERVER_DEFINITIONS.map((definition) => publicServer(definition, sourceConfig, availabilityById));
  const knownIds = new Set(servers.map((entry) => entry.id));
  const profilesById = { ...BUILTIN_PROFILES };
  for (const [id, value] of Object.entries(customProfiles(sourceConfig))) {
    const normalized = normalizeCustomProfile(id, value);
    if (profilesById[normalized.id]) throw new TypeError(`MCP capability profile already exists: ${normalized.id}`);
    profilesById[normalized.id] = normalized;
  }
  const profiles = Object.values(profilesById).map((entry) => {
    for (const serverId of entry.serverIds) {
      if (!knownIds.has(serverId)) throw new TypeError(`MCP capability profile ${entry.id} contains unknown server: ${serverId}`);
    }
    return entry;
  });
  const digestInput = {
    catalogVersion: MCP_CATALOG_VERSION,
    servers: servers.map(({ id, providers, runtimes, transport, required, dependencies, availability }) => ({
      id,
      providers,
      runtimes,
      transport,
      required,
      dependencies,
      availability: availability.state,
    })),
    profiles: profiles.map(({ id, serverIds }) => ({ id, serverIds })),
  };
  return deepFreeze({
    catalogVersion: MCP_CATALOG_VERSION,
    catalogDigest: digestMcpConfiguration(digestInput),
    defaultProfileId: 'default',
    profiles,
    servers,
  });
}

export function getPublicMcpCapabilityCatalog(options = {}) {
  return buildMcpCapabilityCatalog(options);
}

export { BUILTIN_PROFILES, SERVER_DEFINITIONS };
