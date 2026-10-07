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

test('observer delivers a blocked-dialog notice to the room owner after five minutes', async (t) => {
  const h = await createAgentBusHarness({ pollMs: 10 }); t.after(() => h.cleanup());
  h.sessionStates.claude.set('claude-1', { state: 'needs_approval', needsInput: true });
  const owner = { kind: 'codex', sessionId: 'codex-1' };
  const thread = await h.store.createThread({ title: 'blocked', participants: [owner, { kind: 'claude', sessionId: 'claude-1' }] });
  await h.store.transferThread(thread.id, owner);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const sent = await h.app.inject({ method: 'POST', url: '/api/agent-bus/messages', headers: h.authHeaders,
    payload: { threadId: thread.id, from: owner, body: 'review this' } });
  assert.equal(sent.statusCode, 200, sent.body);
  // target_busy is written after the first blocked observation opens the episode.
  const held = () => h.store.getThread(thread.id).deliveries[0].holdReason === 'target_busy';
  for (let attempt = 0; attempt < 150 && !held(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  t.mock.timers.tick(5 * 60_000);
  const notice = /\[ROOM_MESSAGE id=\S+ room=\S+ from=system:agent-bus\].*claude:claude-1 held 5 min on a blocking permission interaction/;
  for (let attempt = 0; attempt < 150 && !h.injected.codex.some((text) => notice.test(text)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(h.injected.codex.filter((text) => notice.test(text)).length, 1, h.injected.codex.join('\n'));
  assert.equal(h.injected.claude.length, 0);
});
