import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';

test('room schemas ignore legacy targeting/ack fields and reject removed endpoints and bad limits', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  const invalidThread = await h.app.inject({ method: 'GET', url: '/api/agent-bus/threads/x?messageLimit=1000', headers: h.authHeaders });
  assert.equal(invalidThread.statusCode, 400);
  const thread = await h.app.inject({ method: 'POST', url: '/api/agent-bus/threads', headers: h.authHeaders, payload: {
    participants: [{ kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' }],
  } });
  assert.equal(thread.statusCode, 200, thread.body);
  const legacy = await h.app.inject({ method: 'POST', url: '/api/agent-bus/messages', headers: h.authHeaders, payload: {
    threadId: thread.json().thread.id, from: { kind: 'codex', sessionId: 'codex-1' },
    to: { kind: 'claude', sessionId: 'claude-1' }, body: 'legacy', requiresAck: true,
  } });
  assert.equal(legacy.statusCode, 200);
  assert.equal(legacy.json().deliveries.length, 1);
  assert.equal('requiresAck' in legacy.json().message, false);
  const ack = await h.app.inject({ method: 'POST', url: '/api/agent-bus/ack', headers: h.authHeaders, payload: {} });
  assert.equal(ack.statusCode, 404);
  const loop = await h.app.inject({ method: 'POST', url: '/api/agent-bus/manager-loop/start', headers: h.authHeaders, payload: {} });
  assert.equal(loop.statusCode, 404);
});
