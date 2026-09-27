import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

describe('dashboard replay eligible control', () => {
  it('requires confirmation before bulk replay mutation', async () => {
    const source = await readFile(new URL('../public/pages/dashboard.mjs', import.meta.url), 'utf8');
    const confirmIndex = source.indexOf('window.confirm');
    const replayIndex = source.indexOf("api.post('/agent-bus/deliveries/replay-eligible'");

    assert.ok(confirmIndex > 0, 'dashboard replay should ask for confirmation');
    assert.ok(replayIndex > confirmIndex, 'confirmation should happen before replay POST');
  });
});
