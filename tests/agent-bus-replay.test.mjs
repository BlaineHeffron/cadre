import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';

test('failed delivery replay is preserved and successful replay records history', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  const thread = await h.store.createThread({ title: 'replay', participants: [
    { kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' },
  ] });
  const created = await h.store.createMessage({ threadId: thread.id, from: thread.participants[0],
    targets: [thread.participants[1]], body: 'retry' });
  const delivery = created.deliveries[0];
  await h.store.updateDelivery(delivery.id, { status: 'failed', error: 'first failure' });
  const response = await h.app.inject({ method: 'POST', url: `/api/agent-bus/deliveries/${delivery.id}/replay`,
    headers: h.authHeaders, payload: { requestedBy: 'test' } });
  assert.equal(response.statusCode, 200, response.body);
  for (let attempt = 0; attempt < 20 && h.store.getDelivery(delivery.id).status === 'queued'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const replayed = h.store.getDelivery(delivery.id);
  assert.equal(replayed.status, 'injected');
  assert.equal(replayed.replayAttempts, 1);
  assert.equal(replayed.replayHistory[0].requestedBy, 'test');
});

test('queued and injected deliveries are not replay eligible', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  const thread = await h.store.createThread({ title: 'replay', participants: [
    { kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' },
  ] });
  const created = await h.store.createMessage({ threadId: thread.id, from: thread.participants[0],
    targets: [thread.participants[1]], body: 'no retry' });
  const response = await h.app.inject({ method: 'POST', url: `/api/agent-bus/deliveries/${created.deliveries[0].id}/replay`,
    headers: h.authHeaders, payload: {} });
  assert.equal(response.statusCode, 409);
});
