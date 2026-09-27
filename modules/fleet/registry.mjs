import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';

const DEFAULT_REGISTRY_PATH = 'examples/command-center/deployment-registry.json';
const VALID_AUTH_MODES = new Set(['bearer_ref', 'local_fixture_header_ref', 'none_local_fixture']);
const VALID_HEALTH_CONTRACTS = new Set(['businessos_diagnostics']);
const MIN_INTERVAL_SECONDS = 15;
const MAX_INTERVAL_SECONDS = 3600;

function normalizeText(value) {
  return String(value || '').trim();
}

function boolValue(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const text = normalizeText(value).toLowerCase();
  if (!text) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(text);
}

function envValue(env, key) {
  return normalizeText(env?.[key]);
}

function isUpperRef(value) {
  return /^[A-Z0-9_]+$/.test(normalizeText(value));
}

function fail(code, detail) {
  const error = new Error(detail);
  error.code = code;
  throw error;
}

function requiredRef(value, field, deploymentId, { rejectSecretLike = false } = {}) {
  const ref = normalizeText(value);
  if (!ref) fail('fleet_registry_ref_missing', `deployment ${deploymentId} missing ${field}`);
  if (!isUpperRef(ref) || ref.includes('://')) {
    fail('fleet_registry_ref_invalid', `deployment ${deploymentId} ${field} must be env-style ref`);
  }
  const lower = ref.toLowerCase();
  if (
    rejectSecretLike
    && (
      lower.startsWith('sk_')
      || lower.startsWith('ghp_')
      || lower.startsWith('xox')
      || lower.includes('bearer')
      || lower.includes('cookie')
      || lower.includes('session')
      || lower.includes('browser')
      || lower.includes('oauth')
      || lower.includes('operator_token')
    )
  ) {
    fail('fleet_registry_auth_ref_invalid', `deployment ${deploymentId} ${field} looks like inline token material`);
  }
  return ref;
}

function requiredSlug(value, field, deploymentId) {
  const text = normalizeText(value);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(text) || text.endsWith('-') || text.endsWith('_')) {
    fail('fleet_registry_slug_invalid', `deployment ${deploymentId} invalid ${field}`);
  }
  return text;
}

function parseOrigin(raw, deploymentId) {
  const value = normalizeText(raw);
  if (!value || value !== raw) fail('fleet_registry_base_url_invalid', `deployment ${deploymentId} base URL must be non-blank and unpadded`);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('fleet_registry_base_url_invalid', `deployment ${deploymentId} base URL is invalid`);
  }
  if (url.protocol !== 'https:') fail('fleet_registry_base_url_invalid', `deployment ${deploymentId} base URL must be https`);
  if (url.username || url.password || url.search || url.hash) {
    fail('fleet_registry_base_url_invalid', `deployment ${deploymentId} base URL must not contain credentials, query, or fragment`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    fail('fleet_registry_base_url_invalid', `deployment ${deploymentId} base URL must be an origin without path`);
  }
  return {
    baseUrl: url.origin,
    host: url.hostname.toLowerCase(),
  };
}

function privateAllowedHosts(env, privateHostAllowedRef) {
  const ref = normalizeText(privateHostAllowedRef);
  if (!ref) return new Set();
  return new Set(
    envValue(env, ref)
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  );
}

function hostIsPrivate(host) {
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.ts.net')
  ) {
    return true;
  }
  const ipVersion = isIP(host);
  if (!ipVersion) return false;
  if (ipVersion === 6) {
    return host === '::1'
      || host === '::'
      || host.toLowerCase().startsWith('fc')
      || host.toLowerCase().startsWith('fd')
      || host.toLowerCase().startsWith('fe80:');
  }
  const parts = host.split('.').map((part) => Number(part));
  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127)
    || a === 0;
}

export function validateFleetBaseUrl(raw, {
  deploymentId = 'deployment',
  env = process.env,
  privateHostAllowedRef = '',
} = {}) {
  const parsed = parseOrigin(raw, deploymentId);
  if (hostIsPrivate(parsed.host)) {
    const allowed = privateAllowedHosts(env, privateHostAllowedRef);
    if (!allowed.has(parsed.host) && !allowed.has(parsed.baseUrl.toLowerCase())) {
      fail('fleet_registry_private_host_blocked', `deployment ${deploymentId} base URL host is private`);
    }
  }
  return parsed.baseUrl;
}

export function parseFleetRegistry(rawRegistry, {
  env = process.env,
  remoteRefsEnabled = false,
  privateHostAllowedRef = '',
} = {}) {
  const registry = typeof rawRegistry === 'string' ? JSON.parse(rawRegistry) : rawRegistry;
  const deployments = Array.isArray(registry?.deployments) ? registry.deployments : [];
  if (deployments.length === 0) fail('fleet_registry_deployments_empty', 'fleet registry has no deployments');

  const ids = new Set();
  return {
    schemaVersion: Number(registry.schema_version || 1),
    deployments: deployments.map((deployment) => {
      const deploymentId = requiredSlug(deployment.deployment_id, 'deployment_id', deployment.deployment_id || 'unknown');
      if (ids.has(deploymentId)) fail('fleet_registry_duplicate_deployment', `duplicate deployment ${deploymentId}`);
      ids.add(deploymentId);

      const publicBaseUrlRef = requiredRef(deployment.public_base_url_ref, 'public_base_url_ref', deploymentId);
      const authMode = normalizeText(deployment.auth_mode || 'bearer_ref');
      if (!VALID_AUTH_MODES.has(authMode)) fail('fleet_registry_auth_mode_invalid', `deployment ${deploymentId} invalid auth_mode`);
      const authRef = authMode === 'none_local_fixture'
        ? null
        : requiredRef(deployment.auth_ref, 'auth_ref', deploymentId, { rejectSecretLike: true });
      const healthContract = normalizeText(deployment.health_contract || 'businessos_diagnostics');
      if (!VALID_HEALTH_CONTRACTS.has(healthContract)) {
        fail('fleet_registry_health_contract_invalid', `deployment ${deploymentId} invalid health_contract`);
      }
      const pollingIntervalSeconds = Number(deployment.polling_interval_seconds || 120);
      if (
        !Number.isInteger(pollingIntervalSeconds)
        || pollingIntervalSeconds < MIN_INTERVAL_SECONDS
        || pollingIntervalSeconds > MAX_INTERVAL_SECONDS
      ) {
        fail('fleet_registry_poll_interval_invalid', `deployment ${deploymentId} invalid polling interval`);
      }

      const baseUrl = remoteRefsEnabled
        ? validateFleetBaseUrl(envValue(env, publicBaseUrlRef), { deploymentId, env, privateHostAllowedRef })
        : null;
      const token = remoteRefsEnabled && authRef ? envValue(env, authRef) : null;
      if (remoteRefsEnabled && authMode === 'bearer_ref' && !token) {
        fail('fleet_registry_auth_ref_unresolved', `deployment ${deploymentId} auth ref is unresolved`);
      }

      return {
        deploymentId,
        profile: requiredSlug(deployment.profile, 'profile', deploymentId),
        environment: requiredSlug(deployment.environment, 'environment', deploymentId),
        publicBaseUrlRef,
        baseUrl,
        authMode,
        authRef,
        token,
        healthContract,
        enabledModules: Array.isArray(deployment.enabled_modules) ? deployment.enabled_modules.map(normalizeText).filter(Boolean) : [],
        pollingIntervalSeconds,
        debugFetchOnDegraded: true,
      };
    }),
  };
}

export async function loadFleetRegistry({
  registryInlineJson = '',
  registryPath = '',
  env = process.env,
  remoteRefsEnabled = false,
  privateHostAllowedRef = '',
} = {}) {
  const raw = normalizeText(registryInlineJson)
    || await readFile(registryPath || DEFAULT_REGISTRY_PATH, 'utf8');
  return parseFleetRegistry(raw, { env, remoteRefsEnabled, privateHostAllowedRef });
}
