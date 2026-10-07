import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';

test('observer injects queued deliveries only when canonical canSendNow becomes true', async (t) => {
  const h = await createAgentBusHarness({ pollMs: 10 }); t.after(() => h.cleanup());
  h.sessionStates.claude.set('claude-1', { state: 'needs_approval', needsInput: true });
  const threadResponse = await h.app.inject({ method: 'POST', url: '/api/agent-bus/threads', headers: h.authHeaders, payload: {
    title: 'queue', participants: [{ kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' }],
  } });
  const thread = threadResponse.json().thread;
  const created = await h.store.createMessage({ threadId: thread.id, from: thread.participants[0],
    targets: [thread.participants[1]], body: 'queued' });
  assert.equal(created.deliveries[0].status, 'queued');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.injected.claude.length, 0);
  h.sessionStates.claude.set('claude-1', { state: 'waiting_for_input', needsInput: true, inputType: 'text' });
  for (let attempt = 0; attempt < 150 && h.store.getDelivery(created.deliveries[0].id).status !== 'injected'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(h.store.getDelivery(created.deliveries[0].id).status, 'injected');
});

test('delivery lifecycle contains only queued, injected, and failed states', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  const thread = await h.store.createThread({ title: 'states', participants: [
    { kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' },
  ] });
  const created = await h.store.createMessage({ threadId: thread.id, from: thread.participants[0],
    targets: [thread.participants[1]], body: 'state' });
  assert.deepEqual(Object.keys(created.deliveries[0]).filter((key) => /ack|reply/i.test(key)), []);
});
