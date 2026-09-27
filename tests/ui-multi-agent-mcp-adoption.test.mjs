import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { taskInputFromForm } from '../public/pages/scheduled-agents.mjs';

describe('multi-agent MCP UI adoption contract', () => {
  it('sends scheduled-agent MCP profile and server deltas', () => {
    assert.deepEqual(taskInputFromForm({
      workDir: '/tmp/project', prompt: 'check', provider: 'codex', intervalHours: '1',
      maxIterations: '2', startImmediately: false, id: '', model: '',
      mcpProfile: 'research', mcpServers: { add: ['nodus'], remove: [] },
    }).mcpServers, { add: ['nodus'], remove: [] });
  });

  it('adopts the shared selector in conference and scheduled forms', async () => {
    const collab = await readFile(new URL('../public/pages/agent-collab.mjs', import.meta.url), 'utf8');
    const scheduled = await readFile(new URL('../public/pages/scheduled-agents.mjs', import.meta.url), 'utf8');
    assert.match(collab, /McpCapabilitySelector/);
    assert.match(collab, /mcpProfile: participant\.mcpProfile/);
    assert.match(collab, /mcpServers: participant\.mcpServers/);
    assert.match(scheduled, /McpCapabilitySelector/);
    assert.match(scheduled, /input\.mcpProfile/);
    assert.match(scheduled, /input\.mcpServers/);
  });
});
