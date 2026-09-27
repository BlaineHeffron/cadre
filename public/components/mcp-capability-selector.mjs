import { h } from 'preact';
import { html } from 'htm/preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo } from 'preact/hooks';
import { api } from '../app/api.mjs';

const EMPTY_SELECTION = Object.freeze({
  mcpProfile: 'default',
  mcpServers: Object.freeze({ add: Object.freeze([]), remove: Object.freeze([]) }),
});

function text(value) {
  return String(value || '').trim();
}

function profileFor(catalog, profileId) {
  return (catalog?.profiles || []).find((profile) => profile?.id === profileId)
    || (catalog?.profiles || []).find((profile) => profile?.id === catalog?.defaultProfileId)
    || (catalog?.profiles || [])[0]
    || { id: 'default', serverIds: [] };
}

function selectedIdsFor(profile, selection) {
  const selected = new Set(profile.serverIds || []);
  for (const id of selection?.mcpServers?.remove || []) selected.delete(id);
  for (const id of selection?.mcpServers?.add || []) selected.add(id);
  return selected;
}

export function canonicalMcpSelectorSelection(profile, selected) {
  const base = new Set(profile.serverIds || []);
  const add = [];
  const remove = [];
  for (const id of selected) {
    if (!base.has(id)) add.push(id);
  }
  for (const id of base) {
    if (!selected.has(id)) remove.push(id);
  }
  return {
    mcpProfile: profile.id,
    mcpServers: { add, remove },
  };
}

function isCompatible(server, provider, runtime) {
  const providerId = text(provider).toLowerCase();
  const runtimeId = text(runtime).toLowerCase();
  return (!providerId || (server.providers || []).includes(providerId))
    && (!runtimeId || (server.runtimes || []).includes(runtimeId));
}

const REASON_LABELS = {
  not_configured: 'Not configured',
  oauth_not_connected: 'Needs consent',
  oauth_client_missing: 'Missing OAuth app',
  credential_missing: 'Missing credential',
  endpoint_not_configured: 'No endpoint set',
  command_missing: 'Command unavailable',
  local_server_not_configured: 'Local server URL unset',
  entry_point_missing: 'Not built',
  health_check_failed: 'Local server unreachable',
};

function availabilityLabel(server) {
  if (server?.availability?.state === 'configured') return 'Available';
  return REASON_LABELS[server?.availability?.reasonCode] || 'Unavailable';
}

async function connectOauthProvider(providerId) {
  const data = await api.post(`/mcp/oauth/${encodeURIComponent(providerId)}/start`, {});
  if (data?.authorizeUrl) window.open(data.authorizeUrl, '_blank', 'noopener');
}

function compatibilityLabel(server, provider, runtime) {
  if (isCompatible(server, provider, runtime)) return 'Compatible';
  const context = text(runtime) || text(provider) || 'selected runtime';
  return `Not compatible with ${context}`;
}

export function normalizeMcpSelectorSelection(value = {}) {
  const add = Array.isArray(value?.mcpServers?.add) ? value.mcpServers.add.filter((id) => typeof id === 'string') : [];
  const remove = Array.isArray(value?.mcpServers?.remove) ? value.mcpServers.remove.filter((id) => typeof id === 'string') : [];
  return {
    mcpProfile: text(value.mcpProfile) || 'default',
    mcpServers: {
      add: [...new Set(add)],
      remove: [...new Set(remove)],
    },
  };
}

export function McpCapabilitySelector({
  provider = '',
  runtime = provider,
  value = EMPTY_SELECTION,
  onChange,
  title = 'MCP capabilities',
  onWarning = null,
} = {}) {
  const catalog = useMemo(() => signal(null), []);
  const loading = useMemo(() => signal(false), []);
  const error = useMemo(() => signal(''), []);
  const profileId = useMemo(() => signal(text(value?.mcpProfile) || 'default'), []);
  const selectedIds = useMemo(() => signal(new Set()), []);
  const search = useMemo(() => signal(''), []);
  const normalizedValue = normalizeMcpSelectorSelection(value);
  const valueSignature = JSON.stringify(normalizedValue);

  useEffect(() => {
    let active = true;
    loading.value = true;
    error.value = '';
    api.get('/agents/mcp-servers').then((result) => {
      if (!active) return;
      catalog.value = result || {};
      const profile = profileFor(result, profileId.value);
      profileId.value = profile.id;
      selectedIds.value = selectedIdsFor(profile, normalizeMcpSelectorSelection(value));
    }).catch((cause) => {
      if (active) error.value = cause?.message || 'Unable to load MCP capabilities.';
    }).finally(() => {
      if (active) loading.value = false;
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!catalog.value) return;
    const profile = profileFor(catalog.value, normalizedValue.mcpProfile);
    profileId.value = profile.id;
    selectedIds.value = selectedIdsFor(profile, normalizedValue);
  }, [catalog.value?.catalogDigest, valueSignature]);

  const currentProfile = profileFor(catalog.value, profileId.value);
  const servers = Array.isArray(catalog.value?.servers) ? catalog.value.servers : [];
  const effectiveServers = servers.filter((server) => selectedIds.value.has(server.id));
  const filteredServers = servers.filter((server) => {
    const needle = text(search.value).toLowerCase();
    if (!needle) return true;
    return [server.id, server.label, server.description, server.category]
      .map((item) => text(item).toLowerCase()).join(' ').includes(needle);
  });
  const duenoRemoved = !selectedIds.value.has('dueno');
  const hasWarning = Boolean(catalog.value) && (
    duenoRemoved
    || effectiveServers.some((server) => !isCompatible(server, provider, runtime)
      || server?.availability?.state !== 'configured')
  );

  useEffect(() => {
    onWarning?.(hasWarning);
  }, [hasWarning]);

  function emitSelection(profile = currentProfile, selected = selectedIds.value) {
    const next = canonicalMcpSelectorSelection(profile, selected);
    onChange?.(next);
  }

  function selectProfile(nextId) {
    const profile = profileFor(catalog.value, nextId);
    const selected = new Set(profile.serverIds || []);
    profileId.value = profile.id;
    selectedIds.value = selected;
    emitSelection(profile, selected);
  }

  function toggleServer(server, checked) {
    if (checked && (!isCompatible(server, provider, runtime) || server?.availability?.state !== 'configured')) return;
    const next = new Set(selectedIds.value);
    if (checked) next.add(server.id);
    else next.delete(server.id);
    selectedIds.value = next;
    emitSelection(currentProfile, next);
  }

  return html`
    <section class="mcp-capability-selector" aria-label=${title}>
      <div class="mcp-selector-head">
        <strong>${title}</strong>
        ${catalog.value?.catalogVersion ? html`<span class="badge badge-info">Catalog v${catalog.value.catalogVersion}</span>` : null}
      </div>
      ${loading.value ? html`<p class="collab-helper">Loading MCP capabilities...</p>` : null}
      ${error.value ? html`<p class="collab-helper mcp-selector-error">${error.value}</p>` : null}
      ${catalog.value ? html`
        <div class="mcp-selector-controls">
          <label class="mcp-selector-control">
            <span>Profile</span>
            <select class="input" value=${currentProfile.id} onInput=${(event) => selectProfile(event.target.value)}>
              ${(catalog.value.profiles || []).map((profile) => html`
                <option value=${profile.id}>${profile.label || profile.id}</option>
              `)}
            </select>
          </label>
          <label class="mcp-selector-control">
            <span>Search</span>
            <input class="input" type="search" placeholder="Filter allowlisted servers" value=${search.value}
              onInput=${(event) => { search.value = event.target.value; }} />
          </label>
        </div>
        ${currentProfile.description ? html`<p class="mcp-selector-profile-note">${currentProfile.description}</p>` : null}
        <div class="mcp-selector-list" role="group" aria-label="MCP servers">
          ${filteredServers.map((server) => {
            const compatible = isCompatible(server, provider, runtime);
            const available = server?.availability?.state === 'configured';
            const checked = selectedIds.value.has(server.id);
            const permissionsId = (checked && server.permissions) ? `mcp-perm-${server.id}` : undefined;
            return html`
              <label class="mcp-selector-row ${compatible && available ? '' : 'mcp-selector-row-disabled'}">
                <input type="checkbox" checked=${checked} disabled=${!checked && (!compatible || !available)}
                  aria-label=${`Select ${server.label || server.id}`}
                  aria-describedby=${permissionsId}
                  onInput=${(event) => toggleServer(server, event.target.checked)} />
                <span class="mcp-selector-row-body">
                  <span class="mcp-selector-row-title" title=${server.permissions ? `Permissions: ${server.permissions}` : ''}>
                    <strong>${server.label || server.id}</strong>
                    ${!available ? html`<span class="badge badge-warning">${availabilityLabel(server)}</span>` : null}
                    ${!compatible ? html`<span class="badge badge-critical">${compatibilityLabel(server, provider, runtime)}</span>` : null}
                    ${server.required ? html`<span class="badge badge-medium">Required</span>` : null}
                    ${(!available && server.oauthProvider && server.availability?.reasonCode === 'oauth_not_connected') ? html`
                      <button class="btn mcp-selector-connect" type="button"
                        onclick=${(event) => {
                          event.preventDefault();
                          connectOauthProvider(server.oauthProvider).catch(() => {});
                        }}>Connect ${server.oauthProvider}</button>
                    ` : null}
                  </span>
                  <span class="mcp-selector-row-desc" title=${server.description || ''}>${server.description || ''}</span>
                  ${permissionsId ? html`
                    <span class="mcp-selector-row-perms" id=${permissionsId}>Permissions: ${server.permissions}</span>
                  ` : null}
                </span>
              </label>
            `;
          })}
        </div>
        <p class="mcp-selector-effective">
          <strong>Effective selection:</strong>${' '}
          ${effectiveServers.length ? effectiveServers.map((server) => server.label || server.id).join(', ') : 'No MCP servers selected'}
        </p>
        ${duenoRemoved ? html`
          <div role="alert" class="mcp-selector-alert">
            Cadre MCP (dueno) removed: agent-bus tools and Cadre onboarding will be unavailable.
          </div>
        ` : null}
      ` : null}
    </section>
  `;
}
