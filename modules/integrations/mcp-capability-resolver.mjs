import {
  buildMcpCapabilityCatalog,
  digestMcpConfiguration,
} from './mcp-server-catalog.mjs';

const REQUEST_FIELDS = new Set(['mcpProfile', 'mcpServers']);
const SERVER_SELECTION_FIELDS = new Set(['add', 'remove']);

export class McpCapabilityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'McpCapabilityError';
    this.code = code;
    this.statusCode = 400;
    this.details = details;
  }
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpCapabilityError('mcp_selection_invalid', `${label} must be an object`);
  }
}

function assertKnownFields(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new McpCapabilityError('mcp_selection_unknown_field', `Unknown ${label} field: ${key}`, { field: key });
    }
  }
}

function normalizeIdList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new McpCapabilityError('mcp_selection_invalid', `${field} must be an array`, { field });
  }
  const result = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string' || !raw.trim() || raw !== raw.trim()) {
      throw new McpCapabilityError('mcp_server_id_invalid', `${field} contains an invalid server ID`, { field });
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      result.push(raw);
    }
  }
  return result;
}

export function normalizeMcpCapabilityRequest(value = {}) {
  assertPlainObject(value, 'MCP capability selection');
  assertKnownFields(value, REQUEST_FIELDS, 'MCP capability selection');
  const profileProvided = own(value, 'mcpProfile');
  let mcpProfile = null;
  if (profileProvided) {
    if (typeof value.mcpProfile !== 'string' || !value.mcpProfile.trim() || value.mcpProfile !== value.mcpProfile.trim()) {
      throw new McpCapabilityError('mcp_profile_id_invalid', 'mcpProfile must be an exact non-empty profile ID');
    }
    mcpProfile = value.mcpProfile;
  }

  const servers = value.mcpServers === undefined ? {} : value.mcpServers;
  assertPlainObject(servers, 'mcpServers');
  assertKnownFields(servers, SERVER_SELECTION_FIELDS, 'mcpServers');
  return Object.freeze({
    profileProvided,
    mcpProfile,
    mcpServers: Object.freeze({
      add: Object.freeze(normalizeIdList(servers.add, 'mcpServers.add')),
      remove: Object.freeze(normalizeIdList(servers.remove, 'mcpServers.remove')),
    }),
  });
}

function inheritedServerIds(inherited, knownIds) {
  if (inherited == null) return [];
  assertPlainObject(inherited, 'inherited MCP selection');
  if (!Array.isArray(inherited.serverIds)) {
    throw new McpCapabilityError('mcp_inherited_selection_invalid', 'Inherited MCP selection must contain serverIds');
  }
  const ids = normalizeIdList(inherited.serverIds, 'inherited.serverIds');
  for (const id of ids) assertKnownServer(id, knownIds);
  return ids;
}

function assertKnownServer(id, knownIds) {
  if (!knownIds.has(id)) {
    throw new McpCapabilityError('mcp_server_unknown', `Unknown MCP server: ${id}`, { serverId: id });
  }
}

function assertSelectable(server, provider, runtime) {
  if (server.availability?.state !== 'configured') {
    throw new McpCapabilityError('mcp_server_unconfigured', `MCP server is not configured: ${server.id}`, {
      serverId: server.id,
      reasonCode: server.availability?.reasonCode || 'not_configured',
    });
  }
  if (provider && !server.providers.includes(provider)) {
    throw new McpCapabilityError('mcp_provider_unsupported', `MCP server ${server.id} does not support provider ${provider}`, {
      serverId: server.id,
      provider,
      runtime,
    });
  }
  if (runtime && !server.runtimes.includes(runtime)) {
    throw new McpCapabilityError('mcp_runtime_unsupported', `MCP server ${server.id} does not support runtime ${runtime}`, {
      serverId: server.id,
      provider,
      runtime,
    });
  }
}

function selectedConfiguration(server) {
  return {
    id: server.id,
    providers: server.providers,
    runtimes: server.runtimes,
    transport: server.transport,
    required: server.required,
    requiresExplicitSelection: server.requiresExplicitSelection === true,
    dependencies: server.dependencies,
    availability: server.availability?.state || 'unconfigured',
  };
}

/**
 * Resolve IDs only. No transport configuration, filesystem paths, URLs, or secrets
 * are accepted or returned by this boundary.
 */
export function resolveMcpCapabilities({
  request = {},
  inherited = null,
  provider = '',
  runtime = '',
  require: requiredServers = [],
  catalog = buildMcpCapabilityCatalog(),
} = {}) {
  const normalized = normalizeMcpCapabilityRequest(request);
  const serversById = new Map(catalog.servers.map((entry) => [entry.id, entry]));
  const profilesById = new Map(catalog.profiles.map((entry) => [entry.id, entry]));
  const knownIds = new Set(serversById.keys());
  // A required server is only usable with its dependencies, so the requirement expands
  // transitively; otherwise forcing it in would trip `mcp_server_dependency_missing`.
  const requiredSet = new Set();
  const requiredQueue = normalizeIdList(requiredServers, 'require');
  while (requiredQueue.length > 0) {
    const id = requiredQueue.shift();
    assertKnownServer(id, knownIds);
    if (requiredSet.has(id)) continue;
    requiredSet.add(id);
    for (const dependencyId of serversById.get(id).dependencies || []) requiredQueue.push(dependencyId);
  }
  const requiredIds = [...requiredSet];
  const hasInherited = inherited != null;
  const inheritedIds = inheritedServerIds(inherited, knownIds);

  let profileId;
  let baseIds;
  if (normalized.profileProvided) {
    profileId = normalized.mcpProfile;
    const profile = profilesById.get(profileId);
    if (!profile) {
      throw new McpCapabilityError('mcp_profile_unknown', `Unknown MCP capability profile: ${profileId}`, { profileId });
    }
    baseIds = [...profile.serverIds];
  } else if (hasInherited) {
    profileId = typeof inherited.profileId === 'string' && profilesById.has(inherited.profileId)
      ? inherited.profileId
      : null;
    baseIds = inheritedIds;
  } else {
    profileId = catalog.defaultProfileId;
    const profile = profilesById.get(profileId);
    if (!profile) throw new McpCapabilityError('mcp_profile_unknown', `Unknown default MCP capability profile: ${profileId}`);
    baseIds = [...profile.serverIds];
  }

  for (const id of [...baseIds, ...normalized.mcpServers.remove, ...normalized.mcpServers.add]) {
    assertKnownServer(id, knownIds);
  }

  const selected = new Set(baseIds);
  for (const id of normalized.mcpServers.remove) selected.delete(id);
  for (const id of normalized.mcpServers.add) selected.add(id);
  // Required servers are forced in last: a caller-supplied profile or `remove` must not be
  // able to drop a capability the spawn path treats as non-negotiable. Each override is
  // reported so the caller is never silently handed a selection it did not ask for; whether
  // the resolved selection reflects an actual request is known by the caller, not here.
  const forcedIds = requiredIds.filter((id) => !selected.has(id));
  for (const id of requiredIds) selected.add(id);
  const serverIds = catalog.servers.map((entry) => entry.id).filter((id) => selected.has(id));
  if (serverIds.length > 0 && (!String(provider || '').trim() || !String(runtime || '').trim())) {
    throw new McpCapabilityError(
      'mcp_resolver_missing_context',
      'MCP capability resolution requires provider and runtime context',
      { provider: String(provider || ''), runtime: String(runtime || '') }
    );
  }
  for (const id of serverIds) {
    const server = serversById.get(id);
    for (const dependencyId of server.dependencies || []) {
      if (!selected.has(dependencyId)) {
        throw new McpCapabilityError('mcp_server_dependency_missing', `MCP server ${id} requires ${dependencyId}`, {
          serverId: id,
          dependencyId,
        });
      }
    }
    try {
      assertSelectable(server, provider, runtime);
    } catch (err) {
      if (requiredSet.has(id) && err instanceof McpCapabilityError) {
        throw new McpCapabilityError(
          'mcp_required_server_unavailable',
          `Required MCP server ${id} cannot be selected: ${err.message}`,
          { ...err.details, serverId: id, required: true, reasonCode: err.code }
        );
      }
      throw err;
    }
  }

  const warnings = [];
  for (const id of forcedIds) {
    warnings.push(Object.freeze({
      code: 'mcp_required_server_forced',
      serverId: id,
      message: `MCP server ${id} is required for this spawn and was added back to the requested selection.`,
    }));
  }
  if (!selected.has('dueno')) {
    warnings.push(Object.freeze({
      code: 'dueno_not_selected',
      message: 'Cadre MCP (dueno) is not selected; agent-bus tools and Cadre onboarding will be unavailable.',
    }));
  }

  const configurationDigest = digestMcpConfiguration({
    catalogVersion: catalog.catalogVersion,
    serverIds,
    servers: serverIds.map((id) => selectedConfiguration(serversById.get(id))),
    provider: String(provider || ''),
    runtime: String(runtime || ''),
  });

  return Object.freeze({
    request: Object.freeze({
      ...(normalized.profileProvided ? { mcpProfile: normalized.mcpProfile } : {}),
      mcpServers: normalized.mcpServers,
    }),
    profileId,
    serverIds: Object.freeze(serverIds),
    catalogVersion: catalog.catalogVersion,
    configurationDigest,
    provider: String(provider || ''),
    runtime: String(runtime || ''),
    warnings: Object.freeze(warnings),
  });
}

export function mcpRequestForResolvedSelection(resolved, catalog = buildMcpCapabilityCatalog()) {
  const profileId = typeof resolved?.profileId === 'string' ? resolved.profileId : '';
  const profile = catalog.profiles.find((entry) => entry.id === profileId)
    || catalog.profiles.find((entry) => entry.id === catalog.defaultProfileId)
    || null;
  const base = new Set(profile?.serverIds || []);
  const effective = new Set(Array.isArray(resolved?.serverIds) ? resolved.serverIds : []);
  return Object.freeze({
    ...(profile ? { mcpProfile: profile.id } : {}),
    mcpServers: Object.freeze({
      remove: Object.freeze(catalog.servers.map((entry) => entry.id).filter((id) => base.has(id) && !effective.has(id))),
      add: Object.freeze(catalog.servers.map((entry) => entry.id).filter((id) => effective.has(id) && !base.has(id))),
    }),
  });
}
