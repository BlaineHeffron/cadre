import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

describe('collab thread search UI', () => {
  it('trusts server-filtered thread results while a search query is active', async () => {
    const source = await readFile(new URL('../public/pages/agent-collab.mjs', import.meta.url), 'utf8');

    assert.match(source, /normalizeSearchText\(threadSearch\.value\)\s*\?\s*agentThreads\.value/);
    assert.match(source, /\/agent-bus\/threads\$\{search \? `\?q=\$\{encodeURIComponent\(search\)\}` : ''\}/);
  });
});
