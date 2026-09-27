import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

describe('browser auth source', () => {
  it('does not persist or send operator bearer tokens from browser modules', async () => {
    const files = [
      'public/app/state.mjs',
      'public/app/api.mjs',
      'public/app/ws-client.mjs',
      'public/pages/settings.mjs',
    ];
    const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
    assert.doesNotMatch(source, /localStorage\.getItem\(['"]dueno_token['"]\)/);
    assert.doesNotMatch(source, /localStorage\.setItem\(['"]dueno_token['"]/);
    assert.doesNotMatch(source, /document\.cookie\s*=/);
    assert.doesNotMatch(source, /Authorization['"]?\s*:\s*`Bearer/);
  });
});
