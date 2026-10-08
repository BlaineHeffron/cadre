import { access, chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config } from '../../config.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import { buildAgentBusMcpUrl } from '../platform/mcp-seed.mjs';
import { CODEX_APP_SERVER_ENV_ALLOWLIST } from '../agent/codex-app-server-transport.mjs';
import {
  AGENT_BUS_AGENT_TOOL_SCOPES,
  AGENT_SPAWN_TOOL_SCOPES,
  getAgentBusCredentialStore,
} from '../agent-bus/mcp-auth.mjs';
import {
  COORDINATOR_CONTROL_TOOL_SCOPES,
  normalizeCredentialCoordinatorPolicy,
  normalizeLoopRegistrationPolicy,
} from '../agent-bus/coordinator-policy.mjs';
import {
  buildBusinessOsCodexConfigArgs,
  clearBusinessOsMcpForSession,
  prepareBusinessOsMcpForSession,
} from './businessos-mcp.mjs';
import {
  PAPER_SEARCH_ENV_KEYS,
  PAPER_SEARCH_READ_TOOLS,
  RESEARCH_PLUGIN_REF,
  researchProfilePaths,
} from './research-profile.mjs';
import { remoteMcpServer, remoteMcpStdioEnv } from './mcp-remote-servers.mjs';
import {
  clearRemoteMcpServersForSession,
  prepareRemoteMcpServer,
} from './mcp-remote-credentials.mjs';

const RESEARCH_IDS = new Set(['paper-search', 'zotero', 'nodus']);
const HEALTH_PROBE_TIMEOUT_MS = 1500;
const STDIO_PROBE_TIMEOUT_MS = 30000;

export const FLEET_SUPERVISOR_MCP_CREDENTIAL_PROFILE = 'fleet-supervisor';
export const FLEET_SUPERVISOR_MCP_TOOL_SCOPES = Object.freeze([
  ...AGENT_BUS_AGENT_TOOL_SCOPES,
  'monitor_list_claude_sessions',
  'monitor_list_codex_sessions',
  'monitor_get_session_output',
  'monitor_send_to_session',
  'monitor_terminate_session',
  'monitor_list_threads',
  'monitor_add_human_queue_item',
  'monitor_list_human_queue',
]);

function credentialProfileDefaults(profile, { backendType, sessionId } = {}) {
  if (profile === FLEET_SUPERVISOR_MCP_CREDENTIAL_PROFILE) {
    return {
      principal: { type: 'service', kind: FLEET_SUPERVISOR_MCP_CREDENTIAL_PROFILE, sessionId },
      threadAllowlist: ['*'],
      toolScopes: FLEET_SUPERVISOR_MCP_TOOL_SCOPES,
    };
  }
  if (profile && profile !== 'agent') {
    throw new TypeError(`Unknown MCP credential profile: ${profile}`);
  }
  return {
    principal: { type: 'agent', kind: backendType, sessionId },
    threadAllowlist: ['@member'],
    toolScopes: Object.freeze(['*', ...AGENT_BUS_AGENT_TOOL_SCOPES]),
  };
}

/**
 * Self-hosted endpoints can be configured but not running. Any HTTP answer
 * counts as up: MCP servers legitimately reject a bare GET. A streamable-HTTP
 * GET that stays open until the probe timeout also counts — Slack's local
 * server does that.
 */
async function endpointReachable(url, { fetchImpl = fetch } = {}) {
  try {
    await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json, text/event-stream' },
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    return true;
  } catch (error) {
    return error?.name === 'TimeoutError' || error?.name === 'AbortError';
  }
}

function text(value) {
  return String(value || '').trim();
}

function assertLoopbackUrl(value) {
  const url = new URL(text(value));
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', '::1', 'localhost'].includes(url.hostname)) {
    throw new TypeError('Cadre MCP bearer URL must be loopback HTTP(S)');
  }
  return url.href;
}

function toml(value) {
  return JSON.stringify(String(value || ''));
}

export function mcpClientConfigPath(backendType, sessionId) {
  return runtimeStatePath(`mcp_client_configs/${text(backendType)}-${text(sessionId)}.json`);
}

export function mcpClientCredentialPath(backendType, sessionId) {
  return runtimeStatePath(`mcp_client_configs/${text(backendType)}-${text(sessionId)}.token`);
}

export function mcpClientEnvPath(backendType, sessionId) {
  return runtimeStatePath(`mcp_client_configs/${text(backendType)}-${text(sessionId)}.env`);
}

function codexHttpServerArgs(id, url, { bearerTokenEnvVar = '' } = {}) {
  return [
    '-c', `mcp_servers.${id}.type="http"`,
    '-c', `mcp_servers.${id}.url=${toml(url)}`,
    '-c', `mcp_servers.${id}.enabled=true`,
    '-c', `mcp_servers.${id}.startup_timeout_sec=30`,
    '-c', `mcp_servers.${id}.tool_timeout_sec=60`,
    ...(bearerTokenEnvVar ? ['-c', `mcp_servers.${id}.bearer_token_env_var=${toml(bearerTokenEnvVar)}`] : []),
  ];
}

// Codex copies these from its own environment, so secret values never reach its argv.
function codexEnvVarsArgs(id, names) {
  return names.length ? ['-c', `mcp_servers.${id}.env_vars=[${names.map(toml).join(', ')}]`] : [];
}

function codexStdioServerArgs(id, command, args, env = {}, forwardedKeys = []) {
  const envEntries = Object.entries(env).filter(([key]) => !forwardedKeys.includes(key));
  return [
    '-c', `mcp_servers.${id}.command=${toml(command)}`,
    ...(args.length ? ['-c', `mcp_servers.${id}.args=[${args.map(toml).join(', ')}]`] : []),
    ...(envEntries.length
      ? ['-c', `mcp_servers.${id}.env={${envEntries.map(([key, value]) => `${key}=${toml(value)}`).join(', ')}}`]
      : []),
    ...codexEnvVarsArgs(id, Object.keys(env).filter((key) => forwardedKeys.includes(key))),
    '-c', `mcp_servers.${id}.enabled=true`,
    '-c', `mcp_servers.${id}.startup_timeout_sec=30`,
    '-c', `mcp_servers.${id}.tool_timeout_sec=60`,
  ];
}

function codexResearchServerArgs(id, paths, env) {
  if (id === 'zotero') {
    return [
      '-c', 'mcp_servers.zotero.command="node"',
      '-c', `mcp_servers.zotero.args=[${toml(paths.zotero)}]`,
      '-c', 'mcp_servers.zotero.enabled=true',
      '-c', 'mcp_servers.zotero.default_tools_approval_mode="writes"',
      '-c', 'mcp_servers.zotero.startup_timeout_sec=30',
      '-c', 'mcp_servers.zotero.tool_timeout_sec=60',
    ];
  }
  if (id === 'nodus') {
    return [
      '-c', 'mcp_servers.nodus.command="node"',
      '-c', `mcp_servers.nodus.args=[${toml(paths.nodus)}]`,
      '-c', `mcp_servers.nodus.env={NODUS_MCP_TOKEN_FILE=${toml(paths.nodusTokenFile)}}`,
      '-c', 'mcp_servers.nodus.enabled=true',
      '-c', 'mcp_servers.nodus.default_tools_approval_mode="writes"',
      '-c', 'mcp_servers.nodus.startup_timeout_sec=30',
      '-c', 'mcp_servers.nodus.tool_timeout_sec=60',
    ];
  }
  if (id === 'paper-search') {
    const args = [
      '-c', `mcp_servers.paper-search.command=${toml(paths.paperSearch)}`,
      '-c', 'mcp_servers.paper-search.enabled=true',
      '-c', 'mcp_servers.paper-search.default_tools_approval_mode="writes"',
      '-c', 'mcp_servers.paper-search.startup_timeout_sec=30',
      '-c', 'mcp_servers.paper-search.tool_timeout_sec=60',
      ...codexEnvVarsArgs('paper-search', Object.keys(env)),
    ];
    for (const tool of PAPER_SEARCH_READ_TOOLS) {
      args.push('-c', `mcp_servers.paper-search.tools.${tool}.approval_mode="approve"`);
    }
    return args;
  }
  return [];
}

function claudeResearchServer(id, paths, env) {
  if (id === 'zotero') return { command: 'node', args: [paths.zotero] };
  if (id === 'nodus') {
    return {
      command: 'node',
      args: [paths.nodus],
      env: { NODUS_MCP_TOKEN_FILE: paths.nodusTokenFile },
    };
  }
  if (id === 'paper-search') {
    return { command: paths.paperSearch, args: [], ...(Object.keys(env).length ? { env } : {}) };
  }
  return null;
}

export async function probeDuenoCredentialHandshake({
  url,
  token,
  fetchImpl = fetch,
} = {}) {
  const target = text(url);
  if (!target || !text(token)) {
    return { state: 'degraded', reasonCode: 'credential_unusable' };
  }
  try {
    const response = await fetchImpl(target, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'dueno-mcp-preflight', version: '0.1.0' },
        },
      }),
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { state: 'degraded', reasonCode: 'credential_unusable' };
    }
    if (!response.ok) return { state: 'degraded', reasonCode: 'handshake_failed' };
    const payload = await response.json().catch(() => null);
    if (payload?.error) return { state: 'degraded', reasonCode: 'handshake_failed' };
    return { state: 'ready' };
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return { state: 'degraded', reasonCode: 'handshake_failed' };
    }
    return { state: 'degraded', reasonCode: 'endpoint_unreachable' };
  }
}

function stdioProbeEnv(serverEnv = {}) {
  const env = { ...serverEnv };
  for (const key of ['PATH', 'HOME']) {
    if (!env[key] && process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function probeCause(error) {
  const message = text(error?.message || error);
  return message.slice(0, 300);
}

async function stdioServerReady(command, args = [], env = {}) {
  const transport = new StdioClientTransport({
    command, args, env: stdioProbeEnv(env), stderr: 'pipe',
  });
  const client = new Client({ name: 'dueno-mcp-preflight', version: '1' });
  try {
    try {
      await client.connect(transport, { timeout: STDIO_PROBE_TIMEOUT_MS });
    } catch (error) {
      return { state: 'degraded', reasonCode: 'mcp_initialize_failed', cause: probeCause(error) };
    }
    try {
      const result = await client.listTools(undefined, { timeout: STDIO_PROBE_TIMEOUT_MS });
      return { state: 'ready', toolCount: result.tools.length };
    } catch (error) {
      return { state: 'degraded', reasonCode: 'mcp_tools_list_failed', cause: probeCause(error) };
    }
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

function handshakeRequiredOutsideTests() {
  return !process.env.NODE_TEST_CONTEXT;
}

function mcpLaunchError(message, code, cause) {
  const error = new Error(cause ? `${message}: ${cause}` : message);
  error.statusCode = 503;
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

async function researchServerReady(id, paths) {
  if (id === 'zotero') return access(paths.zotero).then(() => true, () => false);
  if (id === 'paper-search') return access(paths.paperSearch).then(() => true, () => false);
  if (id === 'nodus') {
    const checks = await Promise.all([
      access(paths.nodus).then(() => true, () => false),
      access(paths.nodusTokenFile).then(() => true, () => false),
    ]);
    return checks.every(Boolean);
  }
  return false;
}

async function writeClaudeConfig(sessionId, mcpServers, configPath = mcpClientConfigPath('claude', sessionId)) {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ mcpServers }, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600).catch(() => {});
  return configPath;
}

async function writePiConfig(sessionId, mcpServers) {
  const configPath = mcpClientConfigPath('pi', sessionId);
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ mcpServers }, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600).catch(() => {});
  return configPath;
}

async function writePrivateFile(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode: 0o600 });
  await chmod(path, 0o600).catch(() => {});
  return path;
}

export async function prepareAgentBusCredentialLaunch({
  backendType,
  sessionId,
  attemptGeneration = 1,
  threadAllowlist,
  serverAllowlist = ['dueno'],
  toolScopes,
  credentialProfile = 'agent',
  inheritSpawnScopes = true,
  coordinatorPolicy = null,
  loopRegistrationPolicy = null,
  credentialStore = getAgentBusCredentialStore(),
  rotation = false,
} = {}) {
  const profileDefaults = credentialProfileDefaults(credentialProfile, { backendType, sessionId });
  const normalizedCoordinatorPolicy = normalizeCredentialCoordinatorPolicy(coordinatorPolicy);
  const normalizedLoopRegistrationPolicy = normalizeLoopRegistrationPolicy(loopRegistrationPolicy);
  const baseToolScopes = toolScopes || profileDefaults.toolScopes;
  const resolvedToolScopes = [...new Set([
    ...baseToolScopes,
    ...(inheritSpawnScopes ? AGENT_SPAWN_TOOL_SCOPES : []),
    ...(normalizedCoordinatorPolicy ? COORDINATOR_CONTROL_TOOL_SCOPES : []),
  ])];
  const issued = await credentialStore.issue({
    principal: profileDefaults.principal,
    attemptGeneration,
    threadAllowlist: threadAllowlist || profileDefaults.threadAllowlist,
    serverAllowlist,
    toolScopes: resolvedToolScopes,
    coordinatorPolicy: normalizedCoordinatorPolicy,
    loopRegistrationPolicy: normalizedLoopRegistrationPolicy,
    reason: rotation ? 'rotate' : 'issue',
  });
  return issued ? { ...issued, credentialStore } : null;
}

export async function cleanupAgentBusCredentialLaunch({
  backendType,
  sessionId,
  credentialProfile = 'agent',
  credentialStore = getAgentBusCredentialStore(),
  reason = 'attempt_ended',
} = {}) {
  const profileDefaults = credentialProfileDefaults(credentialProfile, { backendType, sessionId });
  await Promise.all([
    rm(mcpClientCredentialPath(backendType, sessionId), { force: true }).catch(() => {}),
    credentialStore.revoke({
      principal: profileDefaults.principal,
      reason,
    }).catch(() => false),
  ]);
}

/** Private boundary. Returned prepared material must never be persisted or exposed. */
export async function prepareMcpCapabilityLaunch({
  resolved,
  backendType,
  sessionId,
  workDir = '',
  sourceConfig = config,
  attemptGeneration = 1,
  threadAllowlist,
  serverAllowlist,
  toolScopes,
  credentialProfile = 'agent',
  inheritSpawnScopes = true,
  coordinatorPolicy = null,
  loopRegistrationPolicy = null,
  credentialStore = getAgentBusCredentialStore(),
  rotation = false,
  fetchImpl = fetch,
  requireLiveDuenoHandshake = handshakeRequiredOutsideTests(),
  claudeConfigPath = '',
  duenoCredentialEnvVar = '',
  stdioEnv = process.env,
} = {}) {
  const serverIds = Array.isArray(resolved?.serverIds) ? resolved.serverIds : [];
  const preflight = {};
  const codexArgs = ['-c', 'mcp_servers={}'];
  const claudeServers = {};
  const piServers = {};
  const codexEnv = {};
  const paths = researchProfilePaths(sourceConfig.researchWorkbench || {});
  let businessOsPrepared = false;
  let remotePrepared = false;
  let busCredential = null;

  try {
    busCredential = await prepareAgentBusCredentialLaunch({
      backendType,
      sessionId,
      attemptGeneration,
      ...(serverAllowlist ? { serverAllowlist } : {}),
      threadAllowlist,
      toolScopes,
      credentialProfile,
      inheritSpawnScopes,
      coordinatorPolicy,
      loopRegistrationPolicy,
      credentialStore,
      rotation,
    });
    for (const id of serverIds) {
      if (id === 'dueno') {
        const configuredUrl = buildAgentBusMcpUrl(sourceConfig);
        const url = duenoCredentialEnvVar ? assertLoopbackUrl(configuredUrl) : configuredUrl;
        const authorization = busCredential?.token ? `Bearer ${busCredential.token}` : '';
        if (backendType === 'codex') codexArgs.push(...codexHttpServerArgs(id, url, {
          bearerTokenEnvVar: busCredential?.token ? 'DUENO_AGENT_BUS_TOKEN' : '',
        }));
        if (backendType === 'claude') claudeServers.dueno = {
          type: 'http', url,
          ...(authorization ? { headers: { Authorization: duenoCredentialEnvVar
            ? `Bearer \${${duenoCredentialEnvVar}}`
            : authorization } } : {}),
        };
        if (backendType === 'pi') piServers.dueno = {
          url,
          ...(authorization ? { headers: { Authorization: authorization } } : {}),
        };
        const handshake = busCredential?.token
          ? await probeDuenoCredentialHandshake({
            url,
            token: busCredential.token,
            fetchImpl,
          })
          : { state: 'degraded', reasonCode: 'credential_unusable' };
        if (handshake.state !== 'ready') {
          const localAuth = busCredential?.token
            ? await credentialStore.authenticate(busCredential.token)
            : { ok: false };
          const allowLocalOnly = !requireLiveDuenoHandshake
            && handshake.reasonCode === 'endpoint_unreachable'
            && localAuth?.ok === true;
          if (!allowLocalOnly) {
            throw mcpLaunchError(
              'Issued Cadre credential is not usable by the live MCP endpoint',
              handshake.reasonCode === 'endpoint_unreachable'
                ? 'mcp_endpoint_unreachable'
                : 'mcp_credential_unusable',
            );
          }
        }
        preflight[id] = { state: 'ready' };
        continue;
      }

      if (id === 'businessos') {
        const descriptor = await prepareBusinessOsMcpForSession({
          input: { selectedMcpServers: ['businessos'] },
          backendType,
          sessionId,
          sourceConfig,
        });
        businessOsPrepared = true;
        if (backendType === 'codex') codexArgs.push(...buildBusinessOsCodexConfigArgs(descriptor));
        if (backendType === 'claude') claudeServers.businessos = { type: 'http', url: descriptor.url };
        if (backendType === 'pi') piServers.businessos = { url: descriptor.url };
        preflight[id] = { state: 'ready' };
        continue;
      }

      if (RESEARCH_IDS.has(id)) {
        const required = id === 'nodus' ? ['nodus', 'nodusTokenFile'] : [id === 'paper-search' ? 'paperSearch' : id];
        const missing = required.find((key) => !paths[key]);
        if (missing) {
          const envKey = {
            zotero: 'RESEARCH_WORKBENCH_ZOTERO_MCP_PATH',
            nodus: 'RESEARCH_WORKBENCH_NODUS_MCP_PATH',
            paperSearch: 'RESEARCH_WORKBENCH_PAPER_SEARCH_PATH',
            nodusTokenFile: 'RESEARCH_WORKBENCH_NODUS_TOKEN_FILE',
          }[missing];
          preflight[id] = { state: 'degraded', reasonCode: `missing_${envKey}` };
          continue;
        }
        if (id === 'nodus' && preflight.zotero?.state !== 'ready') {
          preflight[id] = { state: 'degraded', reasonCode: 'dependency_unavailable' };
          continue;
        }
        if (!await researchServerReady(id, paths)) {
          preflight[id] = { state: 'degraded', reasonCode: 'health_check_failed' };
          continue;
        }
        const serverEnv = id === 'paper-search'
          ? remoteMcpStdioEnv({ envKeys: PAPER_SEARCH_ENV_KEYS }, { env: stdioEnv })
          : {};
        if (backendType === 'codex') {
          codexArgs.push(...codexResearchServerArgs(id, paths, serverEnv));
          Object.assign(codexEnv, serverEnv);
        }
        if (backendType === 'claude') claudeServers[id] = claudeResearchServer(id, paths, serverEnv);
        if (backendType === 'pi') piServers[id] = claudeResearchServer(id, paths, serverEnv);
        preflight[id] = { state: 'ready' };
        continue;
      }

      const remote = remoteMcpServer(id, { sourceConfig });
      if (remote?.transport === 'stdio' && text(remote.command)) {
        const args = [...remote.args, ...(remote.appendWorkDir && text(workDir) ? [text(workDir)] : [])];
        const serverEnv = remoteMcpStdioEnv(remote, { env: stdioEnv, workDir });
        const hasEnv = Object.keys(serverEnv).length > 0;
        if (backendType === 'codex') {
          // A name Codex reads for itself (OPENAI_API_KEY) goes by name only when it already holds that value;
          // a differing DM_MCP_* alias stays inline so it never replaces Codex's own key.
          const forwardedKeys = remote.envKeys.filter((key) => key && serverEnv[key]
            && (!CODEX_APP_SERVER_ENV_ALLOWLIST.includes(key) || text(stdioEnv[key]) === serverEnv[key]));
          codexArgs.push(...codexStdioServerArgs(id, remote.command, args, serverEnv, forwardedKeys));
          for (const key of forwardedKeys) codexEnv[key] = serverEnv[key];
        }
        if (backendType === 'claude') claudeServers[id] = { command: remote.command, args, ...(hasEnv ? { env: serverEnv } : {}) };
        if (backendType === 'pi') piServers[id] = { command: remote.command, args, ...(hasEnv ? { env: serverEnv } : {}) };
        const stdioReady = await stdioServerReady(remote.command, args, serverEnv);
        if (stdioReady.state !== 'ready') {
          const operation = stdioReady.reasonCode === 'mcp_initialize_failed' ? 'initialize' : 'tools/list';
          throw mcpLaunchError(`MCP ${operation} failed for ${id}`, stdioReady.reasonCode, stdioReady.cause);
        }
        preflight[id] = { state: 'ready', toolCount: stdioReady.toolCount };
        continue;
      }
      if (remote?.transport === 'http') {
        if (remote.healthProbe && !await endpointReachable(remote.url)) {
          preflight[id] = { state: 'degraded', reasonCode: 'health_check_failed' };
          continue;
        }
        const prepared = await prepareRemoteMcpServer({ serverId: id, backendType, sessionId, sourceConfig });
        if (!prepared?.url) {
          preflight[id] = { state: 'degraded', reasonCode: prepared?.reasonCode || 'credential_unavailable' };
          continue;
        }
        remotePrepared = true;
        if (backendType === 'codex') codexArgs.push(...codexHttpServerArgs(id, prepared.url));
        if (backendType === 'claude') claudeServers[id] = { type: 'http', url: prepared.url };
        if (backendType === 'pi') piServers[id] = { url: prepared.url };
        preflight[id] = { state: 'ready' };
        continue;
      }

      const error = new Error(`No private MCP launch factory exists for ${id}`);
      error.statusCode = 400;
      error.code = 'mcp_server_unconfigured';
      throw error;
    }

    if (backendType === 'codex' && serverIds.some((id) => RESEARCH_IDS.has(id))) {
      const pluginRef = text(sourceConfig.researchWorkbench?.pluginRef || RESEARCH_PLUGIN_REF);
      codexArgs.unshift('-c', `plugins.${toml(pluginRef)}.enabled=true`);
    }

    const preparedClaudeConfigPath = backendType === 'claude'
      ? await writeClaudeConfig(sessionId, claudeServers, claudeConfigPath || undefined)
      : '';
    const piConfigPath = backendType === 'pi' && serverIds.length > 0
      ? await writePiConfig(sessionId, piServers)
      : '';
    const credentialPath = backendType === 'codex' && serverIds.includes('dueno') && busCredential?.token
      ? await writePrivateFile(mcpClientCredentialPath(backendType, sessionId), `${String(busCredential.token)}\n`)
      : '';
    // NUL-delimited NAME=value records; the tmux pane exports them without echoing a value.
    const envPath = Object.keys(codexEnv).length
      ? await writePrivateFile(mcpClientEnvPath(backendType, sessionId),
        Object.entries(codexEnv).map(([key, value]) => `${key}=${value}\0`).join(''))
      : '';
    return {
      preflight,
      credentialToken: duenoCredentialEnvVar && serverIds.includes('dueno') ? busCredential?.token || '' : '',
      codexEnv,
      prepared: {
        codexArgs,
        claudeConfigPath: preparedClaudeConfigPath,
        piConfigPath,
        piExtensionPath: backendType === 'pi' && piConfigPath
          ? resolve(dirname(fileURLToPath(import.meta.url)), 'pi-mcp-extension.mjs')
          : '',
        credentialPath,
        credentialEnvVar: credentialPath ? 'DUENO_AGENT_BUS_TOKEN' : '',
        envPath,
        credential: busCredential?.credential || null,
      },
    };
  } catch (error) {
    if (businessOsPrepared) {
      await clearBusinessOsMcpForSession({ backendType, sessionId, sourceConfig }).catch(() => {});
    }
    if (remotePrepared) {
      await clearRemoteMcpServersForSession({ backendType, sessionId, sourceConfig }).catch(() => {});
    }
    await rm(claudeConfigPath || mcpClientConfigPath(backendType, sessionId), { force: true }).catch(() => {});
    await rm(mcpClientEnvPath(backendType, sessionId), { force: true }).catch(() => {});
    await cleanupAgentBusCredentialLaunch({
      backendType, sessionId, credentialProfile, credentialStore, reason: 'launch_failed',
    });
    throw error;
  }
}

export async function cleanupMcpCapabilityLaunch({
  backendType,
  sessionId,
  credentialProfile = 'agent',
  sourceConfig = config,
  credentialStore = getAgentBusCredentialStore(),
  reason = 'attempt_ended',
  claudeConfigPath = '',
  serverIds = null,
} = {}) {
  const selected = Array.isArray(serverIds) ? serverIds : null;
  const remoteCredentialSelected = selected?.some((id) => {
    const server = remoteMcpServer(id, { sourceConfig });
    return server?.transport === 'http' && server.auth !== 'none';
  });
  await Promise.all([
    rm(claudeConfigPath || mcpClientConfigPath(backendType, sessionId), { force: true }).catch(() => {}),
    rm(mcpClientEnvPath(backendType, sessionId), { force: true }).catch(() => {}),
    cleanupAgentBusCredentialLaunch({ backendType, sessionId, credentialProfile, credentialStore, reason }),
    ...(!selected || selected.includes('businessos')
      ? [clearBusinessOsMcpForSession({ backendType, sessionId, sourceConfig }).catch(() => {})] : []),
    ...(!selected || remoteCredentialSelected
      ? [clearRemoteMcpServersForSession({ backendType, sessionId, sourceConfig }).catch(() => {})] : []),
  ]);
}

export function sanitizedMcpSnapshot(resolved, preflight = {}) {
  return Object.freeze({
    profileId: resolved.profileId,
    serverIds: Object.freeze([...(resolved.serverIds || [])]),
    catalogVersion: resolved.catalogVersion,
    configurationDigest: resolved.configurationDigest,
    provider: resolved.provider,
    runtime: resolved.runtime,
    preflight: Object.freeze(Object.fromEntries(
      Object.entries(preflight).map(([id, state]) => [id, Object.freeze({
        state: state?.state === 'degraded' ? 'degraded' : 'ready',
        ...(state?.reasonCode ? { reasonCode: text(state.reasonCode) } : {}),
        ...(Number.isInteger(state?.toolCount) ? { toolCount: state.toolCount } : {}),
      })])
    )),
  });
}
