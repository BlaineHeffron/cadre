import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { createRevisionGuard } from '../public/app/revision-guard.mjs';

describe('agent session content ordering', () => {
  it('marks an HTTP snapshot stale after realtime content arrives', () => {
    const guard = createRevisionGuard();
    const requestRevision = guard.capture();

    assert.equal(guard.isCurrent(requestRevision), true);
    guard.advance();
    assert.equal(guard.isCurrent(requestRevision), false);
  });

  it('does not let the initial HTTP response replace newer realtime history', async () => {
    const page = await readFile('public/pages/agent-session-detail.mjs', 'utf8');

    assert.match(page, /const initialLines = shouldReduceNetworkActivity\(\) \? INITIAL_LINES : FULL_LINES/);
    assert.match(page, /loadContent\(id, initialLines, descriptor/);
    assert.match(page, /\}, \{ lines: initialLines \}\)/);
    assert.match(page, /const requestRevision = contentRevision\.capture\(\)/);
    assert.match(page, /if \(contentRevision\.isCurrent\(requestRevision\)\)/);
    assert.match(page, /contentRevision\.advance\(\);\s*content\.value = data\.content/);
  });
});
