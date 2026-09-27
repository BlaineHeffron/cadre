import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include';
import yaml from 'js-yaml';
import { runtimeStatePath } from '../ops/runtime-state.mjs';

export const DEEPSEEK_MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';
export const DEEPSEEK_MCP_CLIENT_VERSION = '0.1.0-rc.8';
export const DEEPSEEK_MCP_TOKEN_ENV_VAR = 'DUENO_AGENT_BUS_TOKEN';
export const DEEPSEEK_MCP_REQUIRED_TOOLS = Object.freeze([
  'room_context',
  'room_send',
]);
const require = createRequire(import.meta.url);

export function deepSeekBusE2eEvidence({ packageVersion } = {}) {
  let installedVersion = text(packageVersion);
  if (!installedVersion) {
    try {
      installedVersion = text(require(`${DEEPSEEK_MCP_CLIENT_PACKAGE}/package.json`)?.version);
    } catch {
      installedVersion = '';
    }
  }
  return Object.freeze({
    proven: installedVersion === DEEPSEEK_MCP_CLIENT_VERSION,
    package: DEEPSEEK_MCP_CLIENT_PACKAGE,
    expectedVersion: DEEPSEEK_MCP_CLIENT_VERSION,
    installedVersion,
    test: 'tests/deepseek-mcp-integration.test.mjs',
    contract: 'list-tools+send+receive+dispose',
  });
}

function text(value) {
  return String(value || '').trim();
}

function assertDeepSeekModel(model) {
  const value = text(model);
  if (!['deepseek-v4-pro', 'deepseek-v4-flash'].includes(value)) {
    throw new TypeError(`Unsupported DeepSeek Harness model: ${value || '(empty)'}`);
  }
  return value;
}

function assertPermissionMode(permissionMode) {
  const value = text(permissionMode);
  if (!['workspace-write', 'danger-full-access'].includes(value)) {
    throw new TypeError(`Unsupported DeepSeek permission mode: ${value || '(empty)'}`);
  }
  return value;
}

function assertFleetMcpUrl(value) {
  let url;
  try {
    url = new URL(text(value));
  } catch {
    throw new TypeError('DeepSeek Cadre MCP URL must be a valid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('DeepSeek Cadre MCP URL must use HTTP(S)');
  if (!['127.0.0.1', '::1', 'localhost'].includes(url.hostname)) {
    throw new TypeError('DeepSeek Cadre MCP URL must use a loopback host');
  }
  return url.href;
}

function findEntry(entries, id, expectedName) {
  const matches = entries.filter((entry) => entry?.id === id);
  if (matches.length !== 1 || matches[0].name !== expectedName) {
    throw new TypeError(`DeepSeek Cordis base config must contain exactly one ${id} (${expectedName}) entry`);
  }
  return matches[0];
}

function jsExpression(source) {
  return { __jsExpr: String(source) };
}

export function deepSeekAttemptConfigPath(sessionId, attemptGeneration = 1) {
  const id = text(sessionId);
  const generation = Number(attemptGeneration);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new TypeError('DeepSeek session id is invalid');
  if (!Number.isInteger(generation) || generation < 1) throw new TypeError('DeepSeek attempt generation must be positive');
  return runtimeStatePath(`mcp_client_configs/deepseek-${id}-attempt-${generation}.cordis.yml`);
}

export function renderDeepSeekAttemptCordis({
  baseConfigText,
  model,
  permissionMode,
  mcpUrl,
  tokenEnvVar = DEEPSEEK_MCP_TOKEN_ENV_VAR,
} = {}) {
  if (text(tokenEnvVar) !== DEEPSEEK_MCP_TOKEN_ENV_VAR) {
    throw new TypeError(`DeepSeek MCP bearer must resolve from ${DEEPSEEK_MCP_TOKEN_ENV_VAR}`);
  }
  let entries;
  try {
    entries = yaml.load(String(baseConfigText || ''), { schema: entryListSchema });
  } catch (error) {
    throw new TypeError(`DeepSeek Cordis base config is invalid: ${error.message}`);
  }
  if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw new TypeError('DeepSeek Cordis base config must be a top-level entry array');
  }
  if (entries.some((entry) => entry.id === 'mcp-dueno' || entry.name === DEEPSEEK_MCP_CLIENT_PACKAGE)) {
    throw new TypeError('DeepSeek Cordis base config must not preconfigure an MCP client');
  }

  const selectedModel = assertDeepSeekModel(model);
  const selectedPermissionMode = assertPermissionMode(permissionMode);
  const selectedMcpUrl = assertFleetMcpUrl(mcpUrl);
  const acp = findEntry(entries, 'acp-agent', '@deepseek-ai/dsh-acp-demo');
  const sandbox = findEntry(entries, 'sandbox-policy', '@deepseek-ai/dsh-sandbox-policy');
  const approval = findEntry(entries, 'approval', '@deepseek-ai/dsh-user-approval');
  acp.config = { ...(acp.config || {}), model: selectedModel };
  sandbox.config = { ...(sandbox.config || {}), mode: selectedPermissionMode };
  approval.config = {
    ...(approval.config || {}),
    policy: selectedPermissionMode === 'danger-full-access' ? 'never' : 'ask',
  };
  entries.push({
    id: 'mcp-dueno',
    name: DEEPSEEK_MCP_CLIENT_PACKAGE,
    config: {
      serverName: 'dueno',
      transport: 'streamable-http',
      url: selectedMcpUrl,
      headers: {
        Authorization: jsExpression(`'Bearer ' + String(process.env.${DEEPSEEK_MCP_TOKEN_ENV_VAR} || '')`),
      },
      failOnStartupError: true,
      reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30_000, maxAttempts: 10 },
    },
  });

  const rendered = yaml.dump(entries, {
    schema: entryListSchema,
    noRefs: true,
    noCompatMode: true,
    lineWidth: 120,
    sortKeys: false,
  });
  if (rendered.includes('dueno_mcp_v1.') || rendered.includes('Bearer dueno_')) {
    throw new Error('DeepSeek Cordis renderer refused bearer material');
  }
  return rendered;
}

export async function writeDeepSeekAttemptCordis({
  baseConfigPath,
  sessionId,
  attemptGeneration = 1,
  model,
  permissionMode,
  mcpUrl,
} = {}) {
  const configPath = deepSeekAttemptConfigPath(sessionId, attemptGeneration);
  const baseConfigText = await readFile(baseConfigPath, 'utf8');
  const rendered = renderDeepSeekAttemptCordis({ baseConfigText, model, permissionMode, mcpUrl });
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, rendered, { mode: 0o600 });
  await chmod(configPath, 0o600);
  return configPath;
}

export async function removeDeepSeekAttemptCordis({ sessionId, attemptGeneration = 1 } = {}) {
  await rm(deepSeekAttemptConfigPath(sessionId, attemptGeneration), { force: true });
}

export async function discoverDeepSeekDuenoTools({
  url,
  token,
  requiredTools = DEEPSEEK_MCP_REQUIRED_TOOLS,
  timeoutMs = 10_000,
  clientFactory = (info, options) => new Client(info, options),
  transportFactory = (endpoint, options) => new StreamableHTTPClientTransport(endpoint, options),
} = {}) {
  const mcpUrl = assertFleetMcpUrl(url);
  const bearer = text(token);
  if (!bearer) {
    const error = new Error('Authenticated DeepSeek Cadre MCP discovery requires a bearer credential');
    error.code = 'deepseek_mcp_credential_required';
    error.statusCode = 503;
    throw error;
  }
  const client = clientFactory({ name: 'dueno-deepseek-preflight', version: '0.1.0' }, { capabilities: {} });
  const transport = transportFactory(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
  });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const result = await client.listTools(undefined, { timeout: timeoutMs });
    const names = new Set((result?.tools || []).map((tool) => text(tool?.name)).filter(Boolean));
    const missing = requiredTools.filter((name) => !names.has(name));
    if (missing.length) {
      const error = new Error(`Authenticated DeepSeek Cadre MCP discovery is missing required tools: ${missing.join(', ')}`);
      error.code = 'deepseek_mcp_tools_missing';
      error.statusCode = 503;
      throw error;
    }
    return Object.freeze({
      authenticated: true,
      requiredTools: Object.freeze([...requiredTools]),
      discoveredToolCount: names.size,
    });
  } catch (error) {
    if (String(error?.code || '').startsWith('deepseek_mcp_')) throw error;
    const wrapped = new Error(`Authenticated DeepSeek Cadre MCP discovery failed: ${error?.message || String(error)}`);
    wrapped.code = 'deepseek_mcp_discovery_failed';
    wrapped.statusCode = 503;
    throw wrapped;
  } finally {
    await client.close().catch(() => {});
  }
}

export function deepSeekMcpCapabilities({ discoveryProven = false, e2eEvidence = deepSeekBusE2eEvidence() } = {}) {
  const authenticatedScoped = discoveryProven === true && e2eEvidence?.proven === true;
  return Object.freeze({
    mcpAttachment: 'launch_time_mcp_client',
    mcpFeatures: Object.freeze({ tools: true, resources: false, prompts: false }),
    busParticipation: authenticatedScoped ? 'authenticated_scoped' : 'none',
    collaborationE2eProven: e2eEvidence?.proven === true,
  });
}

export function deepSeekMcpCatalogCapabilities({ e2eEvidence = deepSeekBusE2eEvidence() } = {}) {
  const e2eProven = e2eEvidence?.proven === true;
  return Object.freeze({
    mcpAttachment: 'launch_time_mcp_client',
    mcpFeatures: Object.freeze({ tools: true, resources: false, prompts: false }),
    busParticipation: e2eProven ? 'authenticated_scoped' : 'none',
    collaborationE2eProven: e2eProven,
  });
}

export function deepSeekCollaborationEligible(capabilities = {}) {
  return capabilities?.busParticipation === 'authenticated_scoped'
    && capabilities?.collaborationE2eProven === true;
}
