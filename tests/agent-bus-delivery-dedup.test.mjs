import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentBusDelivery } from '../modules/agent-bus/delivery.mjs';
import { renderBusEnvelope } from '../modules/agent-bus/envelope.mjs';
import { createAgentAdapters } from '../modules/agent-bus/adapters.mjs';
import { registerProtocolSessionProvider } from '../modules/sessions/protocol-session-registry.mjs';
import { readFileSync } from 'node:fs';
import { observeCodexPane } from '../modules/session-state/providers/codex.mjs';
import { observeClaudePane } from '../modules/session-state/providers/claude.mjs';
import { createSessionStateTracker } from '../modules/session-state/tracker.mjs';

function idleSession() {
  return { state: { capabilities: { canSendNow: true }, status: 'waiting_for_input', execution: 'idle' } };
}

test('skips inject when the session transcript already contains the message id', async () => {
  const message = { id: 'msg_1', threadId: 'thr_1', from: { kind: 'codex', sessionId: 'c1' }, body: 'hello' };
  const delivery = { id: 'del_1', messageId: 'msg_1', target: { kind: 'claude', sessionId: 'a1' }, status: 'queued', attempts: 0 };
  const store = {
    getThread: () => ({ thread: { status: 'open' } }),
    getDelivery: () => delivery,
    getMessage: () => null,
    async updateDelivery(_id, patch) { return { ...delivery, ...patch }; },
  };
  let injected = 0;
  const { deliverMessage } = createAgentBusDelivery({
    app: {},
    store,
    wsManager: null,
    observedSessions: new Set(),
    deliveryInFlight: new Set(),
    sessionDeliveryInFlight: new Set(),
    broadcast() {},
    broadcastAlert() {},
    async resolveAgentSession() {
      return {
        async getSession() { return idleSession(); },
        async captureSession() { return renderBusEnvelope(message); },
        async injectEnvelope() { injected += 1; return { ok: true }; },
      };
    },
  });
  const updated = await deliverMessage(message, delivery);
  assert.equal(injected, 0);
  assert.equal(updated.status, 'injected');
  assert.equal(updated.resolution, 'already_present');
});

test('injects once when the session has not received the message', async () => {
  const message = { id: 'msg_2', threadId: 'thr_1', from: { kind: 'codex', sessionId: 'c1' }, body: 'hello' };
  const delivery = { id: 'del_2', messageId: 'msg_2', target: { kind: 'claude', sessionId: 'a1' }, status: 'queued', attempts: 0 };
  const store = {
    getThread: () => ({ thread: { status: 'open' } }),
    getDelivery: () => delivery,
    getMessage: () => null,
    async updateDelivery(_id, patch) { return { ...delivery, ...patch }; },
  };
  const envelopes = [];
  const { deliverMessage } = createAgentBusDelivery({
    app: {},
    store,
    wsManager: null,
    observedSessions: new Set(),
    deliveryInFlight: new Set(),
    sessionDeliveryInFlight: new Set(),
    broadcast() {},
    broadcastAlert() {},
    async resolveAgentSession() {
      return {
        async getSession() { return idleSession(); },
        async captureSession() { return ''; },
        async injectEnvelope(_app, _id, text, opts) {
          envelopes.push({ text, opts });
          return { ok: true, resolution: 'sent' };
        },
      };
    },
  });
  const updated = await deliverMessage(message, delivery);
  assert.equal(envelopes.length, 1);
  assert.match(envelopes[0].text, /id=msg_2/);
  assert.deepEqual(envelopes[0].opts, { deliveryId: 'del_2' });
  assert.equal(updated.status, 'injected');
});

test('protocol inject uses a stable delivery idempotency key', async () => {
  const prompts = [];
  const unregister = registerProtocolSessionProvider('deepseek', {
    service: {
      get() { return { lifecycle: 'running', content: '' }; },
      async prompt(_id, opts) { prompts.push(opts); return { turnId: `t${prompts.length}` }; },
    },
  });
  try {
    const adapter = createAgentAdapters().deepseek;
    await adapter.injectEnvelope({}, 'd1', 'hello', { deliveryId: 'del_9' });
    await adapter.injectEnvelope({}, 'd1', 'hello', { deliveryId: 'del_9' });
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0].idempotencyKey, 'agent-bus:del_9');
    assert.equal(prompts[1].idempotencyKey, 'agent-bus:del_9');
  } finally {
    unregister();
  }
});

function paneState(fixture, extra = []) {
  const content = readFileSync(new URL(`./fixtures/session-state/panes/${fixture}.pane`, import.meta.url), 'utf8');
  const observe = fixture.startsWith('claude-') ? observeClaudePane : observeCodexPane;
  const tracker = createSessionStateTracker({ now: () => 1000 });
  return tracker.observe('c1', [
    { source: 'process', kind: 'lifecycle', value: { lifecycle: 'running' }, observedAt: 1000, expiresAt: 0, fingerprint: 'process:running' },
    ...observe(content, { observedAt: 1000, expiresAt: 0 }),
    ...extra,
  ]);
}

function deliveryHarness(kind, initialState) {
  let state = initialState;
  const deliveries = new Map();
  const created = [];
  let failCreate = false;
  const store = {
    getThread: () => ({ thread: { status: 'open', createdBy: { kind: 'codex', sessionId: 'owner' } } }),
    getDelivery: (id) => deliveries.get(id),
    getMessage: () => null,
    async updateDelivery(id, patch) { deliveries.set(id, { ...deliveries.get(id), ...patch }); return deliveries.get(id); },
    async createMessage(input) {
      if (failCreate) throw new Error('store down');
      created.push(input);
      return { message: input, deliveries: [] };
    },
  };
  let injected = 0;
  const { deliverMessage } = createAgentBusDelivery({
    app: {},
    store,
    adapters: createAgentAdapters(),
    wsManager: null,
    observedSessions: new Set(),
    deliveryInFlight: new Set(),
    sessionDeliveryInFlight: new Set(),
    broadcast() {},
    broadcastAlert() {},
    async resolveAgentSession() {
      return {
        async getSession() { return { state }; },
        async captureSession() { return ''; },
        async injectEnvelope() { injected += 1; return { ok: true, resolution: 'sent' }; },
      };
    },
  });
  return {
    created,
    setState(next) { state = next; },
    failCreate(value) { failCreate = value; },
    async deliver(n = 3) {
      const message = { id: `msg_${n}`, threadId: 'thr_1', from: { kind: 'claude', sessionId: 'a1' }, body: 'hello' };
      const id = `del_${n}`;
      if (!deliveries.has(id)) deliveries.set(id, { id, messageId: message.id, target: { kind, sessionId: 'c1' }, status: 'queued', attempts: 0 });
      const updated = await deliverMessage(message, deliveries.get(id));
      return { injected, status: updated.status, holdReason: updated.holdReason };
    },
  };
}

function deliverTo(kind, state) {
  return deliveryHarness(kind, state).deliver();
}

test('delivers to a working Codex pane, which steers input into the running turn', async () => {
  for (const fixture of ['codex-e5ea5b75-background-terminal', 'codex-reconstructed-working']) {
    const state = paneState(fixture);
    assert.equal(state.status, 'working');
    assert.equal(state.capabilities.canSendNow, false);
    assert.deepEqual(await deliverTo('codex', state), { injected: 1, status: 'injected', holdReason: null });
    assert.deepEqual(await deliverTo('pi', state), { injected: 0, status: 'queued', holdReason: 'target_busy' });
  }
});

test('delivers to a working or thinking Claude pane, which queues input for the running turn', async () => {
  const transcriptWorking = { source: 'transcript', kind: 'execution', value: { execution: 'working', activity: 'working' },
    observedAt: 1000, expiresAt: 0, fingerprint: 'transcript:working' };
  for (const [fixture, status, extra] of [
    ['claude-working-tool-osmosing', 'working', [transcriptWorking]],
    ['claude-thinking-moseying', 'thinking', []],
  ]) {
    const state = paneState(fixture, extra);
    assert.equal(state.status, status);
    assert.equal(state.capabilities.canSendNow, false);
    assert.deepEqual(await deliverTo('claude', state), { injected: 1, status: 'injected', holdReason: null });
  }
});

test('holds Claude delivery behind a permission dialog and tells the owner once per episode after five minutes', async (t) => {
  const blocked = paneState('claude-2-1-293-permission');
  assert.equal(blocked.status, 'blocked');
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const harness = deliveryHarness('claude', blocked);
  assert.deepEqual(await harness.deliver(1), { injected: 0, status: 'queued', holdReason: 'target_busy' });
  t.mock.timers.tick(5 * 60_000 - 1);
  await harness.deliver(2);
  assert.equal(harness.created.length, 0);

  // A notice that fails to persist is retried on the next attempt.
  t.mock.timers.tick(1);
  harness.failCreate(true);
  await harness.deliver(1);
  harness.failCreate(false);
  assert.equal(harness.created.length, 0);

  // Both deliveries to the blocked target share one episode and one notice.
  await harness.deliver(1);
  await harness.deliver(2);
  t.mock.timers.tick(10 * 60_000);
  assert.deepEqual(await harness.deliver(2), { injected: 0, status: 'queued', holdReason: 'target_busy' });
  assert.equal(harness.created.length, 1);
  assert.deepEqual(harness.created[0].targets, [{ kind: 'codex', sessionId: 'owner' }]);
  assert.match(harness.created[0].body, /claude:c1 held 5 min on a blocking selection interaction/);

  // The dialog clears, then a new one blocks: a new episode notifies again.
  harness.setState(paneState('claude-f609b0f7-idle'));
  assert.deepEqual(await harness.deliver(1), { injected: 1, status: 'injected', holdReason: null });
  harness.setState(paneState('claude-reconstructed-permission'));
  await harness.deliver(2);
  t.mock.timers.tick(5 * 60_000);
  await harness.deliver(2);
  assert.equal(harness.created.length, 2);
  assert.match(harness.created[1].body, /blocking permission interaction/);
});

test('holds Claude delivery while a prior send to the working pane awaits response', async () => {
  const state = paneState('claude-working-tool-osmosing', [{
    source: 'delivery', kind: 'command_gate', value: { state: 'awaiting_response' }, observedAt: 1000, expiresAt: 0, fingerprint: 'cmd_1:awaiting_response',
  }]);
  assert.equal(state.status, 'awaiting_response');
  assert.deepEqual(await deliverTo('claude', state), { injected: 0, status: 'queued', holdReason: 'target_busy' });
});

test('holds Codex delivery behind a visible permission prompt', async () => {
  const state = paneState('codex-reconstructed-permission');
  assert.equal(state.status, 'blocked');
  assert.deepEqual(await deliverTo('codex', state), { injected: 0, status: 'queued', holdReason: 'target_busy' });
});

test('holds Codex delivery while a prior send to the working pane awaits response', async () => {
  const state = paneState('codex-reconstructed-working', [{
    source: 'delivery', kind: 'command_gate', value: { state: 'awaiting_response' }, observedAt: 1000, expiresAt: 0, fingerprint: 'cmd_1:awaiting_response',
  }]);
  assert.equal(state.execution, 'working');
  assert.equal(state.status, 'awaiting_response');
  assert.deepEqual(await deliverTo('codex', state), { injected: 0, status: 'queued', holdReason: 'target_busy' });
});
