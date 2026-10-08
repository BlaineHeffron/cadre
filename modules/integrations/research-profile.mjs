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
/** Optional keys paper-search reads; forwarded by name when set in the fleet environment. */
export const PAPER_SEARCH_ENV_KEYS = Object.freeze([
  'SEMANTIC_SCHOLAR_API_KEY',
  'ADS_API_KEY',
  'OPENALEX_EMAIL',
  'UNPAYWALL_EMAIL',
]);

export function researchProfilePaths(source = {}) {
  return {
    zotero: (source.zoteroMcpPath || source.zotero) ? resolve(source.zoteroMcpPath || source.zotero) : '',
    nodus: (source.nodusMcpPath || source.nodus) ? resolve(source.nodusMcpPath || source.nodus) : '',
    paperSearch: (source.paperSearchPath || source.paperSearch) ? resolve(source.paperSearchPath || source.paperSearch) : '',
    nodusTokenFile: source.nodusTokenFile ? resolve(source.nodusTokenFile) : '',
  };
}

export function hasResearchWorkbenchLaunchProfile(metadata = {}) {
  return metadata?.researchWorkbench?.profileId === RESEARCH_PROFILE_ID;
}
