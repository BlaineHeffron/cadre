import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { STARTUP_INJECT_DEADLINE_MS } from '../modules/agent/startup-input.mjs';

describe('agent startup injection bound', () => {
  it('exports a finite startup deadline used by injectInitialPrompt', async () => {
    assert.equal(STARTUP_INJECT_DEADLINE_MS, 20_000);
    const source = await readFile(new URL('../modules/sessions/index.mjs', import.meta.url), 'utf8');
    assert.match(source, /STARTUP_INJECT_DEADLINE_MS/);
    assert.match(source, /deadlineAt:\s*Date\.now\(\)\s*\+\s*STARTUP_INJECT_DEADLINE_MS/);
    assert.doesNotMatch(source, /waitForAgentPromptReady|sendStartupPromptToReadyAgent/);
  });
});
