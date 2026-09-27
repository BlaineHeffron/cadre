import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';

import { reconcileSessionMaps } from '../modules/sessions/index.mjs';

describe('session map reconcile', () => {
  it('drops sessions forgotten while discovery ran', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const next = reconcileSessionMaps(
      new Map([['b', b]]),
      new Map([['a', a], ['b', b]]),
      new Map([['a', a], ['b', b]]),
    );
    assert.deepEqual([...next.keys()], ['b']);
    assert.equal(next.get('b'), b);
  });

  it('keeps sessions created while discovery ran', () => {
    const a = { id: 'a' };
    const c = { id: 'c' };
    const next = reconcileSessionMaps(
      new Map([['a', a], ['c', c]]),
      new Map([['a', a]]),
      new Map([['a', a]]),
    );
    assert.equal(next.get('c'), c);
    assert.equal(next.get('a'), a);
  });

  it('prefers replaced live metadata over the discovery snapshot', () => {
    const previous = { id: 'a', name: 'old' };
    const current = { id: 'a', name: 'new' };
    const next = reconcileSessionMaps(
      new Map([['a', current]]),
      new Map([['a', previous]]),
      new Map([['a', { id: 'a', name: 'from-tmux' }]]),
    );
    assert.equal(next.get('a'), current);
  });

  it('keeps in-place discovery mutations when the live object is unchanged', () => {
    const a = { id: 'a', workDir: '' };
    a.workDir = '/tmp/project';
    const next = reconcileSessionMaps(
      new Map([['a', a]]),
      new Map([['a', a]]),
      new Map([['a', a]]),
    );
    assert.equal(next.get('a'), a);
    assert.equal(next.get('a').workDir, '/tmp/project');
  });

  it('does not resurrect killed sessions from a stale observer list', async () => {
    const source = await readFile('modules/sessions/index.mjs', 'utf8');
    assert.match(source, /sessions = reconcileSessionMaps\(sessions, baseline, nextSessions\)/);
    assert.match(source, /broadcastSessionList\(wsManager, list\.filter\(\(s\) => sessions\.has\(s\.id\)\)\)/);
    assert.doesNotMatch(
      source,
      /if \(!sessions\.has\(s\.id\)\) \{\s*sessions\.set\(s\.id, \{/,
    );
  });
});
