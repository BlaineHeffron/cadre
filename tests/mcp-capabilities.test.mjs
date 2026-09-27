import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMcpCapabilityCatalog,
  digestMcpConfiguration,
} from '../modules/integrations/mcp-server-catalog.mjs';
import {
  McpCapabilityError,
  mcpRequestForResolvedSelection,
  normalizeMcpCapabilityRequest,
  resolveMcpCapabilities,
} from '../modules/integrations/mcp-capability-resolver.mjs';

function catalog(options = {}) {
  return buildMcpCapabilityCatalog({
    sourceConfig: options.sourceConfig || { mcpCapabilities: options.mcpCapabilities || {} },
    availabilityById: {
      dueno: true,
      businessos: true,
      'paper-search': true,
      zotero: true,
      nodus: true,
      ...(options.availabilityById || {}),
    },
  });
}

function resolve(request = {}, options = {}) {
  return resolveMcpCapabilities({
    request,
    provider: options.provider || 'codex',
    runtime: options.runtime || 'codex',
    inherited: options.inherited ?? null,
    require: options.require || [],
    catalog: options.catalog || catalog(),
  });
}

describe('MCP capability catalog', () => {
  it('publishes fixed public descriptors without launch configuration or secrets', () => {
    const value = catalog({
      sourceConfig: {
        businessOsMcp: { mcpUrl: 'https://secret.example.test/mcp', operatorToken: 'secret-token' },
        researchWorkbench: { zoteroMcpPath: '/secret/zotero', nodusTokenFile: '/secret/token' },
      },
    });
    assert.equal(value.catalogVersion, 1);
    assert.deepEqual(value.servers.map((entry) => entry.id), [
      'dueno', 'businessos', 'paper-search', 'zotero', 'nodus', 'seodata', 'google-ads',
      'gmail', 'google-drive', 'slack', 'espocrm',
      'google-docs', 'google-sheets', 'google-slides', 'google-calendar', 'google-chat', 'google-contacts',
      'github', 'sentry', 'linear', 'vercel', 'supabase', 'cloudflare-observability',
      'notion', 'atlassian', 'exa', 'huggingface', 'deepwiki', 'wolfram',
      'playwright', 'filesystem', 'git', 'fetch', 'memory', 'sequential-thinking', 'time',
      'invoice-ninja',
    ]);
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes('secret-token'), false);
    assert.equal(serialized.includes('secret.example.test'), false);
    assert.equal(serialized.includes('/secret/'), false);
    assert.equal(/"(url|command|args|env|path|token)"\s*:/.test(serialized), false);
    assert.equal(value.servers.find((entry) => entry.id === 'dueno').required, true);
    assert.equal(value.servers.find((entry) => entry.id === 'businessos').required, false);
    assert.equal(value.servers.find((entry) => entry.id === 'businessos').requiresExplicitSelection, true);
    assert.throws(() => value.servers.push({}), TypeError);
  });

  it('loads config-owned profiles through the same catalog validation', () => {
    const value = catalog({
      mcpCapabilities: {
        profiles: {
          ops: { label: 'Ops', serverIds: ['dueno', 'businessos'] },
        },
      },
    });
    assert.deepEqual(value.profiles.find((entry) => entry.id === 'ops')?.serverIds, ['dueno', 'businessos']);
    assert.throws(
      () => catalog({ mcpCapabilities: { profiles: { bad: ['not-real'] } } }),
      /contains unknown server/
    );
    assert.throws(
      () => catalog({ mcpCapabilities: { profiles: { bad: [' dueno'] } } }),
      /Invalid MCP server ID/
    );
  });

  it('produces a deterministic digest independent of object key order', () => {
    assert.equal(
      digestMcpConfiguration({ b: 2, a: { d: 4, c: 3 } }),
      digestMcpConfiguration({ a: { c: 3, d: 4 }, b: 2 })
    );
    assert.match(catalog().catalogDigest, /^sha256:[a-f0-9]{64}$/);
  });
});

describe('MCP capability request contract', () => {
  it('accepts only profile and exact add/remove ID arrays', () => {
    assert.deepEqual(normalizeMcpCapabilityRequest({
      mcpProfile: 'research',
      mcpServers: { add: ['dueno', 'dueno'], remove: ['nodus'] },
    }).mcpServers, { add: ['dueno'], remove: ['nodus'] });
    assert.throws(
      () => normalizeMcpCapabilityRequest({ mcpServers: { add: [' dueno'] } }),
      (error) => error instanceof McpCapabilityError && error.code === 'mcp_server_id_invalid'
    );
    assert.throws(
      () => normalizeMcpCapabilityRequest({ mcpServers: { url: 'https://evil.test' } }),
      (error) => error.code === 'mcp_selection_unknown_field'
    );
    assert.throws(
      () => normalizeMcpCapabilityRequest({ selectedMcpServers: ['dueno'] }),
      (error) => error.code === 'mcp_selection_unknown_field'
    );
  });
});

describe('MCP capability resolver', () => {
  it('defaults omitted selection to no MCP servers', () => {
    const value = resolve();
    assert.equal(value.profileId, 'default');
    assert.deepEqual(value.serverIds, []);
    assert.equal(value.warnings[0].code, 'dueno_not_selected');
  });

  it('applies removals then additions and emits catalog order', () => {
    const value = resolve({
      mcpProfile: 'research',
      mcpServers: {
        remove: ['nodus', 'dueno'],
        add: ['zotero', 'dueno', 'businessos', 'nodus'],
      },
    });
    assert.deepEqual(value.serverIds, ['dueno', 'businessos', 'paper-search', 'zotero', 'nodus']);
  });

  it('inherits thread-effective IDs unless participant explicitly replaces the profile', () => {
    const inherited = resolve({ mcpServers: { add: ['businessos'] } });
    const participant = resolve({ mcpServers: { add: ['zotero'] } }, { inherited });
    assert.deepEqual(participant.serverIds, ['businessos', 'zotero']);
    assert.equal(participant.profileId, 'default');
    assert.equal(participant.warnings[0].code, 'dueno_not_selected');

    const replaced = resolve({ mcpProfile: 'research', mcpServers: { remove: ['nodus'] } }, { inherited });
    assert.deepEqual(replaced.serverIds, ['paper-search', 'zotero']);
    assert.equal(replaced.profileId, 'research');
  });

  it('returns typed errors for unknown, unconfigured, and incompatible selections', () => {
    assert.throws(
      () => resolve({ mcpServers: { add: ['Dueno'] } }),
      (error) => error.code === 'mcp_server_unknown' && error.details.serverId === 'Dueno'
    );
    assert.throws(
      () => resolve({ mcpServers: { add: ['slack'] } }),
      (error) => error.code === 'mcp_server_unconfigured' && error.details.serverId === 'slack'
    );
    assert.deepEqual(
      resolve({}, { provider: 'xai', runtime: 'pi' }).serverIds,
      []
    );
    assert.throws(
      () => resolve({ mcpProfile: 'dueno' }, { provider: 'ollama', runtime: 'pi' }),
      (error) => error.code === 'mcp_provider_unsupported' && error.details.provider === 'ollama'
    );
    assert.deepEqual(
      resolve({ mcpProfile: 'dueno' }, { provider: 'deepseek', runtime: 'deepseek' }).serverIds,
      ['dueno'],
    );
    assert.throws(
      () => resolve({ mcpServers: { add: ['businessos'] } }, { provider: 'deepseek', runtime: 'deepseek' }),
      (error) => error.code === 'mcp_provider_unsupported' && error.details.provider === 'deepseek',
    );
  });

  it('rejects effective selections missing declared dependencies', () => {
    assert.throws(
      () => resolve({ mcpProfile: 'research', mcpServers: { remove: ['zotero'] } }),
      (error) => error.code === 'mcp_server_dependency_missing'
        && error.details.serverId === 'nodus'
        && error.details.dependencyId === 'zotero'
    );
  });

  it('requires launch context for any non-empty effective selection', () => {
    const empty = resolveMcpCapabilities({
      request: {},
      provider: '',
      runtime: '',
      catalog: catalog(),
    });
    assert.deepEqual(empty.serverIds, []);
    assert.throws(
      () => resolveMcpCapabilities({
        request: { mcpProfile: 'dueno' },
        provider: '',
        runtime: '',
        catalog: catalog(),
      }),
      (error) => error.code === 'mcp_resolver_missing_context'
    );
  });

  it('uses a selection-scoped digest and ignores unrelated server availability', () => {
    const configured = resolve({}, { catalog: catalog({ availabilityById: { businessos: true } }) });
    const unavailable = resolve({}, { catalog: catalog({ availabilityById: { businessos: false } }) });
    assert.equal(configured.configurationDigest, unavailable.configurationDigest);

    const selectedConfigured = resolve(
      { mcpServers: { add: ['businessos'] } },
      { catalog: catalog({ availabilityById: { businessos: true } }) }
    );
    assert.notEqual(configured.configurationDigest, selectedConfigured.configurationDigest);
  });

  it('reconstructs exact IDs against default when a stored profile no longer exists', () => {
    const value = mcpRequestForResolvedSelection(
      { profileId: 'removed-profile', serverIds: ['zotero'] },
      catalog()
    );
    assert.deepEqual(value, {
      mcpProfile: 'default',
      mcpServers: { add: ['zotero'], remove: [] },
    });
    assert.deepEqual(resolve(value).serverIds, ['zotero']);
  });

  it('forces required servers past a profile or removal that would drop them', () => {
    const research = resolve({ mcpProfile: 'research' }, { require: ['dueno'] });
    assert.equal(research.serverIds.includes('dueno'), true);
    assert.deepEqual([...research.serverIds].sort(), ['dueno', 'nodus', 'paper-search', 'zotero']);
    assert.deepEqual(
      research.warnings.map((warning) => [warning.code, warning.serverId]),
      [['mcp_required_server_forced', 'dueno']]
    );

    const removed = resolve({ mcpServers: { remove: ['dueno'] } }, { require: ['dueno'] });
    assert.deepEqual(removed.serverIds, ['dueno']);

    const inheritedWithout = resolve({ mcpServers: { remove: ['dueno'] } });
    assert.deepEqual(inheritedWithout.warnings.map((warning) => warning.code), ['dueno_not_selected']);
    const forcedFromInherited = resolve({}, { inherited: inheritedWithout, require: ['dueno'] });
    assert.deepEqual(forcedFromInherited.serverIds, ['dueno']);
    assert.deepEqual(
      mcpRequestForResolvedSelection(forcedFromInherited, catalog()),
      { mcpProfile: 'default', mcpServers: { add: ['dueno'], remove: [] } }
    );
  });

  it('forces the dependencies of a required server so the requirement stays satisfiable', () => {
    const resolved = resolve({ mcpProfile: 'default' }, { require: ['nodus'] });
    assert.deepEqual([...resolved.serverIds].sort(), ['nodus', 'zotero']);
    assert.deepEqual(
      resolved.warnings.filter((warning) => warning.code === 'mcp_required_server_forced')
        .map((warning) => warning.serverId).sort(),
      ['nodus', 'zotero']
    );
    // An unusable dependency fails as a required-server failure, not as a dependency gap the
    // spawn path cannot recognize.
    assert.throws(
      () => resolve({}, { require: ['nodus'], catalog: catalog({ availabilityById: { zotero: false } }) }),
      (error) => error.code === 'mcp_required_server_unavailable' && error.details.serverId === 'zotero'
    );
  });

  it('reports a distinct error code when a required server cannot be selected', () => {
    assert.throws(
      () => resolve({}, { require: ['dueno'], catalog: catalog({ availabilityById: { dueno: false } }) }),
      (error) => error instanceof McpCapabilityError
        && error.code === 'mcp_required_server_unavailable'
        && error.details.serverId === 'dueno'
        && error.details.required === true
        && error.details.reasonCode === 'mcp_server_unconfigured'
    );
    assert.throws(
      () => resolve({}, { require: ['not-a-server'] }),
      (error) => error.code === 'mcp_server_unknown'
    );
  });

  it('rejects an unconfigured profile member and never returns private data', () => {
    const unavailable = catalog({ availabilityById: { nodus: false } });
    assert.throws(
      () => resolve({ mcpProfile: 'research' }, { catalog: unavailable }),
      (error) => error.code === 'mcp_server_unconfigured' && error.details.reasonCode === 'not_configured'
    );
    const serialized = JSON.stringify(resolve({ mcpServers: { add: ['businessos'] } }));
    assert.equal(/url|command|token|secret|\/home\//i.test(serialized), false);
  });
});
