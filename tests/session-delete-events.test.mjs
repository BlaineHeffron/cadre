import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyAgentSessionDeleted, onAgentSessionDeleted } from '../modules/agent/session-delete-events.mjs';

test('session deletion listeners are isolated, bounded, and removable', async () => {
  const events = [];
  const stops = [
    onAgentSessionDeleted(async () => { throw new Error('listener_failed'); }),
    onAgentSessionDeleted(async () => new Promise(() => {})),
    onAgentSessionDeleted((event) => { events.push(event); }),
  ];

  const results = await notifyAgentSessionDeleted({ kind: ' codex ', sessionId: ' c1 ' }, { timeoutMs: 10 });
  assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected', 'fulfilled']);
  assert.equal(results[1].reason.message, 'session_delete_listener_timeout');
  assert.deepEqual(events, [{ kind: 'codex', sessionId: 'c1' }]);

  stops.forEach((stop) => stop());
  await notifyAgentSessionDeleted({ kind: 'codex', sessionId: 'c2' }, { timeoutMs: 10 });
  assert.equal(events.length, 1);
});
