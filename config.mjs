import { config as loadEnv } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveCompatibleProviderModelPair } from './modules/agent/provider-interface.mjs';
import { runtimeStatePath } from './modules/ops/runtime-state.mjs';
import { readEnv } from './modules/platform/cadre-env.mjs';

// Tests must not pick up the checkout's deployment .env; node --test sets NODE_TEST_CONTEXT.
if (!process.env.NODE_TEST_CONTEXT) loadEnv();

const env = (key, fallback) => readEnv(key) ?? fallback;
function envFlagValue(raw, fallback = true) {
  if (raw == null) return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

const envFlag = (key, fallback = true) => envFlagValue(readEnv(key), fallback);

export function wsQueryTokenCompatEnabled(envSource = process.env) {
  const raw = envSource.WS_QUERY_TOKEN_COMPAT;
  if (raw == null || String(raw).trim() === '') return false;
  return envFlagValue(raw, false);
}

const envInt = (key, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const parsed = Number.parseInt(readEnv(key) ?? '', 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(value, min), max);
};

function envJsonObject(key, fallback = {}) {
  const raw = readEnv(key);
  if (raw == null || String(raw).trim() === '') return fallback;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    console.warn(`${key} ignored: invalid JSON object`);
    return fallback;
  }
}

function envJsonFileObject(key, fallback = {}) {
  const path = readEnv(key);
  if (path == null || String(path).trim() === '') return fallback;
  try {
    const parsed = JSON.parse(readFileSync(resolve(path), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    console.warn(`${key} ignored: unreadable or invalid JSON object file`);
    return fallback;
  }
}

function envEnum(key, allowed, fallback) {
  const value = String(readEnv(key) ?? fallback).trim().toLowerCase();
  return allowed.includes(value) ? value : fallback;
}

function envProviderModel({
  providerKey,
  modelKey,
  defaultProvider = '',
  label,
} = {}) {
  return resolveCompatibleProviderModelPair({
    provider: env(providerKey, defaultProvider),
    model: env(modelKey, ''),
    fallbackProvider: defaultProvider || 'codex',
    allowEmpty: !defaultProvider,
    label,
  });
}

const githubAgentPair = envProviderModel({
  providerKey: 'DM_GITHUB_AGENT_PROVIDER',
  modelKey: 'DM_GITHUB_AGENT_MODEL',
  defaultProvider: 'xai',
  label: 'githubAgents',
});
const fleetHygienePair = envProviderModel({
  providerKey: 'DM_FLEET_HYGIENE_PROVIDER',
  modelKey: 'DM_FLEET_HYGIENE_MODEL',
  label: 'fleetHygiene',
});
const dependencyWatchPair = envProviderModel({
  providerKey: 'DM_DEPENDENCY_WATCH_PROVIDER',
  modelKey: 'DM_DEPENDENCY_WATCH_MODEL',
  label: 'dependencyWatch',
});
const skillsUpstreamPair = envProviderModel({
  providerKey: 'DM_SKILLS_UPSTREAM_PROVIDER',
  modelKey: 'DM_SKILLS_UPSTREAM_MODEL',
  label: 'skillsUpstream',
});
const jobOpportunitiesPair = envProviderModel({
  providerKey: 'DM_JOB_OPPORTUNITIES_PROVIDER',
  modelKey: 'DM_JOB_OPPORTUNITIES_MODEL',
  label: 'jobOpportunities',
});
const repoQualityPair = envProviderModel({
  providerKey: 'DM_REPO_QUALITY_PROVIDER',
  modelKey: 'DM_REPO_QUALITY_MODEL',
  defaultProvider: 'codex',
  label: 'repoQuality',
});

export const config = {
  host: env('HOST', '127.0.0.1'),
  port: Number(env('PORT', '8443')),
  logLevel: env('LOG_LEVEL', 'info'),
  tlsEnabled: envFlag('TLS_ENABLED', false),
  tlsRequired: envFlag('TLS_REQUIRED', false),

  tls: {
    cert: env('TLS_CERT', 'certs/server.crt'),
    key: env('TLS_KEY', 'certs/server.key'),
  },

  auth: {
    token: env('AUTH_TOKEN', ''),
    internalBypassToken: env('INTERNAL_BYPASS_TOKEN', ''),
    browserSessionSecret: env('BROWSER_SESSION_SECRET', ''),
    internalBypassTtlMs: Number(env('INTERNAL_BYPASS_TTL_MS', '60000')),
    browserSessionTtlMs: Number(env('BROWSER_SESSION_TTL_MS', '604800000')),
    wsQueryTokenCompat: wsQueryTokenCompatEnabled(),
  },

  permissionAuthority: {
    preapprovedAutomationPolicies: env('DM_PREAPPROVED_AUTOMATION_POLICIES', '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  },

  hookEventsRetentionDays: Number(env('CADRE_HOOK_EVENTS_RETENTION_DAYS', '7')),
  agentBus: {
    stateDir: env('AGENT_BUS_STATE_DIR', runtimeStatePath('agent_bus')),
    pollMs: Number(env('AGENT_BUS_POLL_MS', '1000')),
    ackTimeoutMs: Number(env('AGENT_BUS_ACK_TIMEOUT_MS', '120000')),
    replyTimeoutMs: Number(env('AGENT_BUS_REPLY_TIMEOUT_MS', '900000')),
    injectDeadlineMs: Number(env('AGENT_BUS_INJECT_DEADLINE_MS', '120000')),
    queuedTimeoutMs: Number(env('AGENT_BUS_QUEUED_TIMEOUT_MS', '900000')),
    closedThreadRetentionDays: Number(env('AGENT_BUS_CLOSED_THREAD_RETENTION_DAYS', '30')),
  },

  agentBusMcpHttp: {
    host: env('AGENT_BUS_MCP_HTTP_HOST', env('HOST', '127.0.0.1')),
    port: Number(env('AGENT_BUS_MCP_HTTP_PORT', '8765')),
    path: env('AGENT_BUS_MCP_HTTP_PATH', '/mcp'),
  },

  agentBusMcpAuth: {
    // Migration deliberately starts in issue_only: new attempts receive scoped
    // credentials while pre-P2 sessions remain usable until an operator retires them.
    mode: envEnum('DM_AGENT_BUS_MCP_AUTH', ['off', 'issue_only', 'enforce'], 'issue_only'),
  },

  agentInterface: {
    sessionIdempotencyTtlMs: envInt('AGENT_SESSION_IDEMPOTENCY_TTL_MS', 3_600_000, { min: 1_000, max: 86_400_000 }),
    worktreeBaseDir: env('AGENT_SESSION_WORKTREE_BASE_DIR', '~/.dueno-fleet/agent-worktrees'),
    claudeRemoteControlEnabled: envFlag('CLAUDE_REMOTE_CONTROL_ENABLED', false),
  },

  researchWorkbench: {
    tokenFile: env('RESEARCH_WORKBENCH_FLEET_TOKEN_FILE', '~/.research-workbench/fleet-bridge.json'),
    stateFile: env('RESEARCH_WORKBENCH_FLEET_STATE_FILE', runtimeStatePath('research_workbench_sessions.json')),
    baseUrl: env('RESEARCH_WORKBENCH_FLEET_BASE_URL', `http://127.0.0.1:${env('PORT', '4310')}`),
    defaultWorkDir: env('RESEARCH_WORKBENCH_DEFAULT_WORKDIR', ''),
    allowedWorkDirs: env('RESEARCH_WORKBENCH_ALLOWED_WORKDIRS', ''),
    pluginDir: env('RESEARCH_WORKBENCH_PLUGIN_DIR', ''),
    pluginRef: env('RESEARCH_WORKBENCH_PLUGIN_REF', 'research-workbench'),
    zoteroMcpPath: env('RESEARCH_WORKBENCH_ZOTERO_MCP_PATH', ''),
    nodusMcpPath: env('RESEARCH_WORKBENCH_NODUS_MCP_PATH', ''),
    paperSearchPath: env('RESEARCH_WORKBENCH_PAPER_SEARCH_PATH', ''),
    nodusTokenFile: env('RESEARCH_WORKBENCH_NODUS_TOKEN_FILE', ''),
    streamPollMs: envInt('RESEARCH_WORKBENCH_STREAM_POLL_MS', 750, { min: 250, max: 5000 }),
    streamTimeoutMs: envInt('RESEARCH_WORKBENCH_STREAM_TIMEOUT_MS', 900000, { min: 10000, max: 3600000 }),
  },

  mcpSeed: {
    enabled: envFlag('MCP_SEED_ENABLED', true),
  },

  mcpCapabilities: {
    profiles: envJsonObject('MCP_CAPABILITY_PROFILES_JSON', {}),
  },

  promptProfiles: {
    // DM_PROMPT_PROFILES_FILE loads a JSON object of profiles from disk (for
    // multi-line bodies systemd EnvironmentFile/dotenv can't hold); entries
    // from DM_PROMPT_PROFILES_JSON are merged on top and win on id conflicts.
    profiles: { ...envJsonFileObject('DM_PROMPT_PROFILES_FILE', {}), ...envJsonObject('DM_PROMPT_PROFILES_JSON', {}) },
  },

  launchSkills: {
    dir: env('DM_LAUNCH_SKILLS_DIR', resolve('config/skills')),
    // Path-delimited, read-only directories scanned after stock and before
    // local. A skill id present in more than one dir resolves to the last
    // directory listed (later directories override earlier ones).
    customDirs: env('DM_LAUNCH_SKILLS_CUSTOM_DIRS', ''),
    // Writable overlay for UI-authored skills. Git-ignored so live-deploy
    // `git reset --hard` never reverts them; sync-main.sh symlinks it from the
    // dev clone like the other runtime state.
    localDir: env('DM_LAUNCH_SKILLS_LOCAL_DIR', resolve('state/skills')),
  },

  // Credentials and endpoints for third-party catalog servers. Selection itself
  // stays in mcpCapabilities; this block only says how the fleet authenticates.
  mcpCredentials: {
    overrides: envJsonObject('DM_MCP_SERVER_OVERRIDES_JSON', {}),
    // 'local' points the Google servers at a self-hosted workspace-mcp instance,
    // which needs only an ordinary OAuth client. 'managed' uses Google's hosted
    // endpoints, which require Workspace Developer Preview enrollment.
    googleMode: env('DM_MCP_GOOGLE_MODE', 'local'),
    googleLocalUrl: env('DM_MCP_GOOGLE_LOCAL_URL', ''),
    googleAdsUrl: env('DM_MCP_GOOGLE_ADS_URL', ''),
    // 'local' points slack at a self-hosted slack-mcp-server that acts as the
    // operator's existing Slack user (no workspace admin install). 'managed'
    // uses Slack's hosted MCP and needs a Slack app on a workspace you own.
    slackMode: env('DM_MCP_SLACK_MODE', 'local'),
    slackLocalUrl: env('DM_MCP_SLACK_LOCAL_URL', ''),
    seodataPath: env('DM_MCP_SEODATA_PATH', ''),
    stateFile: env('DM_MCP_SESSION_STATE_FILE', runtimeStatePath('mcp_session_servers.json')),
    oauthStateFile: env('DM_MCP_OAUTH_STATE_FILE', runtimeStatePath('mcp_oauth_tokens.json')),
    oauthPublicBaseUrl: env('DM_MCP_OAUTH_PUBLIC_BASE_URL', ''),
    proxyPathPrefix: env('DM_MCP_PROXY_PATH_PREFIX', '/mcp-proxy'),
  },

  businessOsMcp: {
    baseUrl: env('BUSINESSOS_MCP_BASE_URL', env('BOS_MCP_BASE_URL', '')),
    mcpUrl: env('BUSINESSOS_MCP_URL', env('BOS_MCP_URL', '')),
    operatorToken: env('BUSINESSOS_MCP_OPERATOR_TOKEN', env('BOS_MCP_OPERATOR_TOKEN', '')),
    stateFile: env('BUSINESSOS_MCP_STATE_FILE', runtimeStatePath('businessos_mcp_sessions.json')),
    proxyPathPrefix: env('BUSINESSOS_MCP_PROXY_PATH_PREFIX', '/businessos-mcp'),
  },

  productionControls: {
    agentBusDeliveryReplayEnabled: envFlag('PC_FLAG_AGENT_BUS_DELIVERY_REPLAY_ENABLED', true),
  },

  fleet: {
    registryPath: env('DM_COMMAND_CENTER_DEPLOYMENT_REGISTRY_PATH', ''),
    registryInlineJson: env('DM_COMMAND_CENTER_DEPLOYMENT_REGISTRY_JSON', ''),
    remoteRefsEnabled: envFlag('DM_COMMAND_CENTER_REMOTE_BASE_URL_REFS_ENABLED', false),
    livePollingEnabled: envFlag('DM_COMMAND_CENTER_FLEET_LIVE_REMOTE_POLLING_ENABLED', false),
    privateHostAllowedRef: env('DM_FLEET_PRIVATE_HOSTS_REF', ''),
    healthyPollsToResolve: Number(env('DM_COMMAND_CENTER_FLEET_HEALTHY_POLLS_TO_RESOLVE', '2')),
    defaultIntervalSec: Number(env('DM_COMMAND_CENTER_FLEET_DEFAULT_INTERVAL_SECONDS', '120')),
    investigationWorkDir: env('DM_COMMAND_CENTER_FLEET_INVESTIGATION_WORKDIR', '~/.dueno-fleet/investigations'),
    investigationProvider: env('DM_COMMAND_CENTER_FLEET_INVESTIGATION_PROVIDER', 'codex'),
    investigationModel: env('DM_COMMAND_CENTER_FLEET_INVESTIGATION_MODEL', ''),
    investigationThinkingLevel: env('DM_COMMAND_CENTER_FLEET_INVESTIGATION_THINKING_LEVEL', ''),
    investigationWorktreeReapEnabled: envFlag('DM_COMMAND_CENTER_FLEET_INVESTIGATION_WORKTREE_REAP_ENABLED', false),
    investigationWorktreeReapMinAgeSec: envInt('DM_COMMAND_CENTER_FLEET_INVESTIGATION_WORKTREE_REAP_MIN_AGE_SECS', 300, { min: 0, max: 86400 }),
    investigationWorktreeReapMaxPerPass: envInt('DM_COMMAND_CENTER_FLEET_INVESTIGATION_WORKTREE_REAP_MAX_PER_PASS', 20, { min: 1, max: 100 }),
    repoPaths: envJsonObject('DM_FLEET_REPO_PATHS_JSON', {}),
    deploymentNotifyEnabled: envFlag('DM_FLEET_DEPLOYMENT_NOTIFY_ENABLED', false),
    deploymentNotifyProvider: env('DM_FLEET_DEPLOYMENT_NOTIFY_PROVIDER', 'codex'),
    deploymentNotifyModel: env('DM_FLEET_DEPLOYMENT_NOTIFY_MODEL', ''),
    deploymentNotifyThinkingLevel: env('DM_FLEET_DEPLOYMENT_NOTIFY_THINKING_LEVEL', ''),
    deploymentNotifyBusinessOsRepoPath: env('DM_FLEET_DEPLOYMENT_NOTIFY_BUSINESSOS_REPO_PATH', ''),
    deploymentNotifyWebhookPath: env('DM_FLEET_DEPLOYMENT_NOTIFY_WEBHOOK_PATH', '/api/webhooks/release-notes'),
    deploymentNotifyAgentTimeoutMs: envInt('DM_FLEET_DEPLOYMENT_NOTIFY_AGENT_TIMEOUT_MS', 600000, { min: 1000, max: 3600000 }),
    deploymentNotifyGitTimeoutMs: envInt('DM_FLEET_DEPLOYMENT_NOTIFY_GIT_TIMEOUT_MS', 30000, { min: 1000, max: 300000 }),
  },

  audio: {
    inboxDir: env('DM_COMMAND_CENTER_AUDIO_INBOX_DIR', '~/.dueno-fleet/audio-inbox'),
    ingestEnabled: envFlag('DM_COMMAND_CENTER_AUDIO_INGEST_ENABLED', false),
    watchEnabled: envFlag('DM_COMMAND_CENTER_AUDIO_WATCH_ENABLED', false),
    scanIntervalSec: envInt('DM_COMMAND_CENTER_AUDIO_SCAN_INTERVAL_SECS', 0, { min: 0, max: 86400 }),
    evidenceMaxBytes: envInt('DM_COMMAND_CENTER_AUDIO_EVIDENCE_MAX_BYTES', 262144, { min: 1024, max: 10 * 1024 * 1024 }),
    actionWorkDir: env('DM_COMMAND_CENTER_AUDIO_ACTION_WORKDIR', '~/.dueno-fleet/recordings'),
    actionProvider: env('DM_COMMAND_CENTER_AUDIO_ACTION_PROVIDER', 'codex'),
    actionModel: env('DM_COMMAND_CENTER_AUDIO_ACTION_MODEL', ''),
    actionThinkingLevel: env('DM_COMMAND_CENTER_AUDIO_ACTION_THINKING_LEVEL', ''),
    audioCleanupEnabled: envFlag('DM_COMMAND_CENTER_AUDIO_CLEANUP_ENABLED', false),
    audioCleanupMinAgeSec: envInt('DM_COMMAND_CENTER_AUDIO_CLEANUP_MIN_AGE_SECS', 86400, { min: 0, max: 2592000 }),
    audioCleanupMaxPerPass: envInt('DM_COMMAND_CENTER_AUDIO_CLEANUP_MAX_PER_PASS', 20, { min: 1, max: 200 }),
  },

  githubAgents: {
    enabled: envFlag('DM_GITHUB_AGENT_POLLER_ENABLED', envFlag('DM_GITHUB_AGENTS_ENABLED', false)),
    pollIntervalSec: envInt('DM_GITHUB_AGENT_POLL_INTERVAL_SECS', 60, { min: 15, max: 3600 }),
    autoReviewEnabled: envFlag('DM_GITHUB_AGENT_AUTO_REVIEW_ENABLED', true),
    worktreeReapEnabled: envFlag('DM_GITHUB_AGENT_WORKTREE_REAP_ENABLED', false),
    worktreeReapMinAgeSec: envInt('DM_GITHUB_AGENT_WORKTREE_REAP_MIN_AGE_SECS', 300, { min: 0, max: 86400 }),
    repoPaths: envJsonObject('DM_GITHUB_AGENT_REPO_PATHS_JSON', {}),
    workDir: env('DM_GITHUB_AGENT_WORKDIR', '~/.dueno-fleet/github-agents'),
    provider: githubAgentPair.provider,
    model: githubAgentPair.model,
    thinkingLevel: env('DM_GITHUB_AGENT_THINKING_LEVEL', 'low'),
    spawnOnStartup: envFlag('DM_GITHUB_AGENT_SPAWN_ON_STARTUP', false),
    maxSpawnsPerPoll: envInt('DM_GITHUB_AGENT_MAX_SPAWNS_PER_POLL', 5, { min: 1, max: 25 }),
    worktreeReapMaxPerPass: envInt('DM_GITHUB_AGENT_WORKTREE_REAP_MAX_PER_PASS', 20, { min: 1, max: 100 }),
  },

  scheduledAgents: {
    enabled: envFlag('DM_SCHEDULED_AGENT_PUMP_ENABLED', false),
    tickIntervalSec: envInt('DM_SCHEDULED_AGENT_TICK_SECS', 5, { min: 1, max: 60 }),
    idleSessionGraceSec: envInt('DM_SCHEDULED_AGENT_IDLE_GRACE_SECS', 60, { min: 0, max: 3600 }),
    maxConsecutiveSkips: envInt('DM_SCHEDULED_AGENT_MAX_CONSECUTIVE_SKIPS', 3, { min: 0, max: 100 }),
  },

  fleetHygiene: {
    repoPaths: envJsonObject('DM_FLEET_HYGIENE_REPO_PATHS_JSON', {}),
    provider: fleetHygienePair.provider,
    model: fleetHygienePair.model,
  },

  dependencyWatch: {
    repoPaths: envJsonObject('DM_DEPENDENCY_WATCH_REPO_PATHS_JSON', {}),
    provider: dependencyWatchPair.provider,
    model: dependencyWatchPair.model,
    intervalSeconds: envInt('DM_DEPENDENCY_WATCH_INTERVAL_SECONDS', 1296000, { min: 86400, max: 1296000 }),
  },

  skillsUpstream: {
    repoPath: env('DM_SKILLS_UPSTREAM_REPO_PATH', ''),
    provider: skillsUpstreamPair.provider,
    model: skillsUpstreamPair.model,
    intervalSeconds: envInt('DM_SKILLS_UPSTREAM_INTERVAL_SECONDS', 604800, { min: 86400, max: 1296000 }),
    worktreeBaseDir: env('DM_SKILLS_UPSTREAM_WORKTREE_BASE', '~/.dueno-fleet/agent-worktrees'),
    maxFanout: envInt('DM_SKILLS_UPSTREAM_MAX_FANOUT', 3, { min: 1, max: 10 }),
  },

  repoQuality: {
    repoPaths: envJsonObject('DM_REPO_QUALITY_REPO_PATHS_JSON', {}),
    provider: repoQualityPair.provider,
    model: repoQualityPair.model,
    intervalSeconds: envInt('DM_REPO_QUALITY_INTERVAL_SECONDS', 604800, { min: 86400, max: 1296000 }),
    worktreeBaseDir: env('DM_REPO_QUALITY_WORKTREE_BASE', '~/.dueno-fleet/agent-worktrees'),
    maxFanout: envInt('DM_REPO_QUALITY_MAX_FANOUT', 2, { min: 1, max: 10 }),
    topN: envInt('DM_REPO_QUALITY_TOP_N', 10, { min: 1, max: 50 }),
  },

  jobOpportunities: {
    scraperPath: env('DM_JOB_OPPORTUNITIES_SCRAPER_PATH', ''),
    scraperConfigPath: env('DM_JOB_OPPORTUNITIES_SCRAPER_CONFIG_PATH', resolve('config/job-opportunities-startup-scraper.yaml')),
    profilePath: env('DM_JOB_OPPORTUNITIES_PROFILE_PATH', resolve('config/job-opportunity-profile.md')),
    outputDir: env('DM_JOB_OPPORTUNITIES_OUTPUT_DIR', resolve('.dueno/job-opportunities')),
    provider: jobOpportunitiesPair.provider,
    model: jobOpportunitiesPair.model,
    intervalSeconds: envInt('DM_JOB_OPPORTUNITIES_INTERVAL_SECONDS', 86400, { min: 86400, max: 1296000 }),
  },

  telegramRelay: {
    enabled: envFlag('DM_TELEGRAM_RELAY_ENABLED', false),
    tickIntervalSec: envInt('DM_TELEGRAM_RELAY_TICK_SECS', 5, { min: 1, max: 60 }),
    captureLines: envInt('DM_TELEGRAM_RELAY_CAPTURE_LINES', 120, { min: 20, max: 500 }),
  },
};

export function assertDistinctAuthSecrets(auth = config.auth) {
  const token = String(auth?.token || '');
  const bypass = String(auth?.internalBypassToken || '');
  const session = String(auth?.browserSessionSecret || '');
  if (!token && !bypass && !session) return;
  const errors = [];
  if (!token) errors.push('AUTH_TOKEN is required when other auth secrets are set');
  if (!bypass) errors.push('INTERNAL_BYPASS_TOKEN is required when AUTH_TOKEN is set');
  if (!session) errors.push('BROWSER_SESSION_SECRET is required when AUTH_TOKEN is set');
  if (token && bypass && token === bypass) errors.push('INTERNAL_BYPASS_TOKEN must differ from AUTH_TOKEN');
  if (token && session && token === session) errors.push('BROWSER_SESSION_SECRET must differ from AUTH_TOKEN');
  if (bypass && session && bypass === session) errors.push('BROWSER_SESSION_SECRET must differ from INTERNAL_BYPASS_TOKEN');
  if (!errors.length) return;
  const error = new Error(`Auth secrets fail closed: ${errors.join('; ')}`);
  error.code = 'auth_secrets_not_distinct';
  throw error;
}

/**
 * Read TLS cert and key files. Returns null if files are missing,
 * allowing fallback to plain HTTP for development.
 * Logs specific errors for diagnosability.
 */
export function loadTlsOptions() {
  if (!config.tlsEnabled) {
    if (config.tlsRequired) {
      const error = new Error('TLS_REQUIRED=1 but TLS_ENABLED is not enabled');
      console.error(`TLS startup failed: ${error.message}`);
      throw error;
    }
    console.info('TLS mode: disabled via TLS_ENABLED env; serving plain HTTP');
    return null;
  }

  try {
    const tlsOptions = {
      cert: readFileSync(resolve(config.tls.cert)),
      key: readFileSync(resolve(config.tls.key)),
    };
    console.info(`TLS mode: enabled using cert=${config.tls.cert} key=${config.tls.key}`);
    return tlsOptions;
  } catch (err) {
    const message = `TLS cert/key load failed (${err.code || 'ERR_TLS_LOAD'}): ${err.message}`;
    if (config.tlsRequired) {
      console.error(`TLS startup failed: ${message}`);
      throw err;
    }
    console.warn(`${message} - falling back to HTTP`);
    return null;
  }
}
