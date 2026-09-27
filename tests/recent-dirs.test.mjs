import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recentWorkDirs } from '../public/app/recent-dirs.mjs';

describe('recentWorkDirs', () => {
  it('orders by newest timestamp, dedups, skips empty, caps at limit', () => {
    const claude = [
      { workDir: '/a', created: 100 },
      { workDir: '/b', updatedAt: 400 },
      { workDir: '', updatedAt: 999 },
    ];
    const codex = [
      { workDir: '/a', updatedAt: 500 }, // newer dup of /a → /a floats to front
      { workDir: '/c', lastActivity: 300 },
    ];
    assert.deepEqual(recentWorkDirs([claude, codex]), ['/a', '/b', '/c']);
  });

  it('respects the limit', () => {
    const sessions = Array.from({ length: 10 }, (_, i) => ({ workDir: `/d${i}`, created: i }));
    const recents = recentWorkDirs([sessions], 3);
    assert.equal(recents.length, 3);
    // newest first: /d9, /d8, /d7
    assert.deepEqual(recents, ['/d9', '/d8', '/d7']);
  });

  it('handles missing/odd input safely', () => {
    assert.deepEqual(recentWorkDirs(), []);
    assert.deepEqual(recentWorkDirs([null, undefined, []]), []);
    assert.deepEqual(recentWorkDirs([[{ foo: 1 }]]), []);
    assert.deepEqual(recentWorkDirs([[{ workDir: '  /trim  ', created: 1 }]]), ['/trim']);
  });
});
