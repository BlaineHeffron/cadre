import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDmBusThread, legacyTopicKeyFor, resolveTopicRoute } from '../modules/telegram/routing.mjs';

const CLAUDE = { id: 'aaaa1111', runtime: 'claude', workDir: '/home/dev/projects/fleet', name: 'Opus Architect' };
const CODEX = { id: 'bbbb2222', runtime: 'codex', workDir: '/home/dev/projects/fleet', name: 'GPT Implementer' };
const THREAD = { id: 'thr_abc123', title: 'Refactor Telegram Bus Relay' };

describe('telegram topic routing', () => {
  it('routes a bus-thread participant to the thread topic named after the thread title', () => {
    const route = resolveTopicRoute({ session: CLAUDE, busThread: THREAD });
    assert.equal(route.key, 'thread:thr_abc123');
    assert.equal(route.name, 'Refactor Telegram Bus Relay');
    assert.equal(route.scopeType, 'thread');
    assert.equal(route.scopeId, 'thr_abc123');
    assert.equal(route.canRename, true);
  });

  it('routes both participants of one thread to the same topic key and name', () => {
    const claudeRoute = resolveTopicRoute({ session: CLAUDE, busThread: THREAD });
    const codexRoute = resolveTopicRoute({ session: CODEX, busThread: THREAD });
    assert.equal(claudeRoute.key, codexRoute.key);
    assert.equal(claudeRoute.name, codexRoute.name);
    assert.equal(claudeRoute.name, THREAD.title);
    assert.ok(!claudeRoute.key.startsWith('session:'));
    assert.ok(!codexRoute.key.startsWith('session:'));
  });

  it('never lets a session-scope hint override an active bus thread', () => {
    for (const hint of [
      { telegram_topic_scope: 'session' },
      { topic_scope: 'session' },
      { scope: 'session' },
    ]) {
      const route = resolveTopicRoute({ session: { ...CLAUDE, ...hint }, busThread: THREAD });
      assert.equal(route.key, 'thread:thr_abc123', `hint ${JSON.stringify(hint)} escaped thread scope`);
      assert.equal(route.scopeType, 'thread');
    }
  });

  it('detects DM rooms by metadata and by the deterministic DM title', () => {
    assert.equal(isDmBusThread({ metadata: { dm: true }, title: 'Pair chat' }), true);
    assert.equal(isDmBusThread({ dm: true }), true);
    assert.equal(isDmBusThread({ title: 'DM: claude:aaaa1111|codex:bbbb2222' }), true);
    assert.equal(isDmBusThread({ title: 'Release room' }), false);
    assert.equal(isDmBusThread({ title: 'DM: planning' }), false);
  });

  it('keeps a named session on its own topic when the bus thread is a DM', () => {
    const route = resolveTopicRoute({
      session: CLAUDE,
      busThread: { id: 'thr_dm', title: 'DM: claude:aaaa1111|codex:bbbb2222', metadata: { dm: true } },
    });
    assert.equal(route.key, 'session:aaaa1111');
    assert.equal(route.scopeType, 'session');
    assert.equal(route.name, 'Opus Architect');
    assert.equal(route.canRename, true);
  });

  it('falls back to session scope only when no thread exists', () => {
    for (const busThread of [null, undefined, {}, { id: '' }, { id: '   ' }]) {
      const route = resolveTopicRoute({ session: CLAUDE, busThread });
      assert.equal(route.key, 'session:aaaa1111');
      assert.equal(route.scopeType, 'session');
      assert.equal(route.name, 'Opus Architect');
      assert.equal(route.canRename, true);
    }
  });

  it('derives a session name from id and workdir when no display name is set, and refuses to rename with it', () => {
    const route = resolveTopicRoute({ session: { ...CLAUDE, name: '' }, busThread: null });
    assert.equal(route.name, 'aaaa1111 fleet');
    assert.equal(route.canRename, false);
  });

  it('uses a thread with a blank title but still refuses to rename the topic with a derived name', () => {
    const route = resolveTopicRoute({ session: CLAUDE, busThread: { id: 'thr_x', title: '  ' } });
    assert.equal(route.key, 'thread:thr_x');
    assert.equal(route.scopeType, 'thread');
    assert.equal(route.canRename, false);
  });

  it('clamps topic names to the Telegram limit', () => {
    const route = resolveTopicRoute({ session: CLAUDE, busThread: { id: 'thr_x', title: 'z'.repeat(400) } });
    assert.equal(route.name.length, 128);
  });

  it('requires a session id', () => {
    assert.throws(() => resolveTopicRoute({ session: {}, busThread: THREAD }), /session\.id/);
  });

  it('exposes the legacy per-session topic key a thread route may adopt', () => {
    const threadRoute = resolveTopicRoute({ session: CLAUDE, busThread: THREAD });
    assert.equal(legacyTopicKeyFor(threadRoute), 'session:aaaa1111');
    const sessionRoute = resolveTopicRoute({ session: CLAUDE, busThread: null });
    assert.equal(legacyTopicKeyFor(sessionRoute), '');
  });
});
