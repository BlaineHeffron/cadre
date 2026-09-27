import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  canonicalMcpSelectorSelection,
  normalizeMcpSelectorSelection,
} from '../public/components/mcp-capability-selector.mjs';

describe('MCP capability selector UI contract', () => {
  it('normalizes the canonical request without accepting arbitrary launch config', () => {
    assert.deepEqual(normalizeMcpSelectorSelection({
      mcpProfile: 'research',
      mcpServers: { add: ['dueno', 'dueno'], remove: ['nodus', 'nodus'] },
      command: 'rm -rf /',
    }), {
      mcpProfile: 'research',
      mcpServers: { add: ['dueno'], remove: ['nodus'] },
    });
  });

  it('canonicalizes deltas against the newly selected profile', () => {
    assert.deepEqual(canonicalMcpSelectorSelection(
      { id: 'research', serverIds: ['paper-search', 'zotero', 'nodus'] },
      new Set(['dueno', 'paper-search', 'zotero'])
    ), {
      mcpProfile: 'research',
      mcpServers: { add: ['dueno'], remove: ['nodus'] },
    });
  });

  it('renders availability, compatibility, permissions, effective IDs, search, and Dueno warning', async () => {
    const source = await readFile(new URL('../public/components/mcp-capability-selector.mjs', import.meta.url), 'utf8');
    assert.match(source, /api\.get\('\/agents\/mcp-servers'\)/);
    assert.match(source, /type="search"/);
    assert.match(source, /availabilityLabel/);
    assert.match(source, /oauth_client_missing/);
    assert.match(source, /reasonCode === 'oauth_not_connected'/);
    assert.match(source, /compatibilityLabel/);
    assert.match(source, /Permissions:/);
    assert.match(source, /Effective selection/);
    assert.match(source, /Cadre MCP \(dueno\) removed/);
    assert.match(source, /mcpServers: { add, remove }/);
    assert.match(source, /disabled=\$\{!checked && \(!compatible \|\| !available\)\}/);
  });

  it('adopts the selector in the single-session modal and sends canonical fields', async () => {
    const source = await readFile(new URL('../public/pages/agents.mjs', import.meta.url), 'utf8');
    assert.match(source, /McpCapabilitySelector/);
    assert.match(source, /PromptProfileSelector/);
    assert.match(source, /LaunchSkillSelector/);
    assert.match(source, /body\.mcpProfile = newMcpSelection\.value\.mcpProfile/);
    assert.match(source, /body\.mcpServers = newMcpSelection\.value\.mcpServers/);
    assert.match(source, /body\.promptProfile = newPromptProfile\.value/);
    assert.match(source, /body\.initialPrompt = newPrompt\.value/);
    assert.match(source, /SkillPromptComposer/);
    assert.match(source, /newPromptProfile\.value = 'none'/);
    const controlBar = await readFile(new URL('../public/components/agent-control-bar.mjs', import.meta.url), 'utf8');
    assert.match(controlBar, /LaunchSkillSelector/);
    assert.match(controlBar, /compact=\$\{true\}/);
    const compactSelector = await readFile(new URL('../public/components/launch-skill-selector.mjs', import.meta.url), 'utf8');
    assert.match(compactSelector, /Insert skill/);
    assert.doesNotMatch(compactSelector, /ctrl-slash-cmd/);
    const conference = await readFile(new URL('../public/pages/agent-collab/format.mjs', import.meta.url), 'utf8');
    assert.match(conference, /mcpProfile: 'dueno'/);
    const collabPage = await readFile(new URL('../public/pages/agent-collab.mjs', import.meta.url), 'utf8');
    assert.match(collabPage, /mcpProfile: participant\.mcpProfile/);
    assert.match(source, /runtime=\$\{runtimeForProvider\(newProvider\.value, modelCatalogState\.value\)\}/);
    assert.doesNotMatch(source, /selectedMcpServers/);
    assert.doesNotMatch(source, /newBusinessOsMcp/);
  });
});
