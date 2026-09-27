import { resolve } from 'node:path';

export const RESEARCH_PROFILE_ID = 'research-workbench-v1';
export const RESEARCH_PLUGIN_REF = 'research-workbench';
export const RESEARCH_MCP_NAMES = Object.freeze(['zotero', 'nodus', 'paper-search']);
export const PAPER_SEARCH_READ_TOOLS = Object.freeze([
  'list_sources',
  'search_papers',
  'get_paper',
  'get_citations',
  'get_references',
  'search_local',
  'search_similar',
  'get_pdf_url',
]);

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

export function researchProfilePaths(source = {}) {
  return {
    zotero: (source.zoteroMcpPath || source.zotero) ? resolve(source.zoteroMcpPath || source.zotero) : '',
    nodus: (source.nodusMcpPath || source.nodus) ? resolve(source.nodusMcpPath || source.nodus) : '',
    paperSearch: (source.paperSearchPath || source.paperSearch) ? resolve(source.paperSearchPath || source.paperSearch) : '',
    nodusTokenFile: source.nodusTokenFile ? resolve(source.nodusTokenFile) : '',
  };
}

/** Server-owned Codex overrides. No request field can add or replace these flags. */
export function buildResearchWorkbenchCodexArgs(source = {}) {
  const paths = researchProfilePaths(source);
  for (const [key, envKey] of Object.entries({
    zotero: 'RESEARCH_WORKBENCH_ZOTERO_MCP_PATH',
    nodus: 'RESEARCH_WORKBENCH_NODUS_MCP_PATH',
    paperSearch: 'RESEARCH_WORKBENCH_PAPER_SEARCH_PATH',
    nodusTokenFile: 'RESEARCH_WORKBENCH_NODUS_TOKEN_FILE',
  })) {
    if (!paths[key]) throw new Error(`Research Workbench requires ${envKey}`);
  }
  const pluginRef = String(source.pluginRef || RESEARCH_PLUGIN_REF);
  const args = [
    '-c', `plugins.${tomlString(pluginRef)}.enabled=true`,
    '-c', 'mcp_servers.zotero.command="node"',
    '-c', `mcp_servers.zotero.args=[${tomlString(paths.zotero)}]`,
    '-c', 'mcp_servers.zotero.enabled=true',
    '-c', 'mcp_servers.zotero.default_tools_approval_mode="writes"',
    '-c', 'mcp_servers.zotero.startup_timeout_sec=30',
    '-c', 'mcp_servers.zotero.tool_timeout_sec=60',
    '-c', 'mcp_servers.nodus.command="node"',
    '-c', `mcp_servers.nodus.args=[${tomlString(paths.nodus)}]`,
    '-c', `mcp_servers.nodus.env={NODUS_MCP_TOKEN_FILE=${tomlString(paths.nodusTokenFile)}}`,
    '-c', 'mcp_servers.nodus.enabled=true',
    '-c', 'mcp_servers.nodus.default_tools_approval_mode="writes"',
    '-c', 'mcp_servers.nodus.startup_timeout_sec=30',
    '-c', 'mcp_servers.nodus.tool_timeout_sec=60',
    '-c', `mcp_servers.paper-search.command=${tomlString(paths.paperSearch)}`,
    '-c', 'mcp_servers.paper-search.enabled=true',
    '-c', 'mcp_servers.paper-search.default_tools_approval_mode="writes"',
    '-c', 'mcp_servers.paper-search.startup_timeout_sec=30',
    '-c', 'mcp_servers.paper-search.tool_timeout_sec=60',
  ];
  for (const tool of PAPER_SEARCH_READ_TOOLS) {
    args.push('-c', `mcp_servers.paper-search.tools.${tool}.approval_mode="approve"`);
  }
  return args;
}

export function hasResearchWorkbenchLaunchProfile(metadata = {}) {
  return metadata?.researchWorkbench?.profileId === RESEARCH_PROFILE_ID;
}
