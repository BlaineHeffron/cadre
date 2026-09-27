import { execFile, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export const CLAUDE_STREAM_JSON_E2E_VERSION = '2.1.251';
export const CLAUDE_STREAM_JSON_MCP_TOKEN_ENV_VAR = 'DUENO_AGENT_BUS_TOKEN';
let detectedCliVersion;

const text = (value) => String(value || '').trim();

// Minimum-version gate: the E2E contract was proven on CLAUDE_STREAM_JSON_E2E_VERSION;
// later CLI releases are accepted so the Claude Code auto-updater cannot brick launches.
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function claudeStreamJsonBusE2eEvidence({ cliVersion = '' } = {}) {
  const installedVersion = text(cliVersion).match(/\d+\.\d+\.\d+/)?.[0] || '';
  return Object.freeze({
    proven: Boolean(installedVersion) && compareVersions(installedVersion, CLAUDE_STREAM_JSON_E2E_VERSION) >= 0,
    expectedVersion: CLAUDE_STREAM_JSON_E2E_VERSION,
    installedVersion,
    test: 'tests/claude-stream-json-transport.test.mjs',
    contract: 'mcp-list+tool-call+can-use-tool-roundtrip',
  });
}

export async function readClaudeStreamJsonVersion(binary = 'claude', execImpl = execFile) {
  return new Promise((resolveVersion) => execImpl(binary, ['--version'], { timeout: 5000 }, (error, stdout, stderr) => {
    resolveVersion(error ? '' : `${stdout || ''}\n${stderr || ''}`.trim());
  }));
}

export function readClaudeStreamJsonVersionSync(binary = 'claude', execImpl = execFileSync) {
  if (execImpl === execFileSync && binary === 'claude' && detectedCliVersion !== undefined) return detectedCliVersion;
  try {
    const version = text(execImpl(binary, ['--version'], { encoding: 'utf8', timeout: 5000 }));
    if (execImpl === execFileSync && binary === 'claude') detectedCliVersion = version;
    return version;
  } catch { return ''; }
}

export function claudeStreamJsonMcpConfigPath(sessionRoot, sessionId, generation = 1) {
  return resolve(sessionRoot, text(sessionId), `attempt-${Number(generation)}`, 'dueno-mcp.json');
}

export function claudeStreamJsonMcpCapabilities({ discoveryProven = false, e2eEvidence } = {}) {
  const proven = discoveryProven === true && e2eEvidence?.proven === true;
  return Object.freeze(proven ? {
    mcpAttachment: 'launch_time_mcp_client',
    mcpFeatures: Object.freeze({ tools: true, resources: false, prompts: false }),
    busParticipation: 'authenticated_scoped', collaborationE2eProven: true,
  } : {
    mcpAttachment: 'none',
    mcpFeatures: Object.freeze({ tools: false, resources: false, prompts: false }),
    busParticipation: 'none', collaborationE2eProven: false,
  });
}

export function claudeStreamJsonCollaborationEligible(capabilities = {}) {
  return capabilities.busParticipation === 'authenticated_scoped'
    && capabilities.collaborationE2eProven === true;
}
