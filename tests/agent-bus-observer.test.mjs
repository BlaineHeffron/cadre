import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentBusObserver } from '../modules/agent-bus/observer.mjs';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';

test('thread directory subscription shares participant runtime lookups', async () => {
  let subscribe;
  let close;
  let lookups = 0;
  const sent = new Promise((resolve) => {
    const wsManager = {
      onChannel(_name, handler) { subscribe = handler; },
      send(_socket, _channel, _type, data) { resolve(data); },
    };
    const store = {
      listThreads: () => [
        { id: 'thread-1', status: 'open', participant: 'shared' },
        { id: 'thread-2', status: 'open', participant: 'shared' },
        { id: 'thread-3', status: 'closed', participant: 'archived' },
      ],
      getThread: (id) => ({ thread: { id } }),
      listMessages: () => [],
      listDeliveries: () => [],
    };
    createAgentBusObserver({
      app: { addHook(_name, handler) { close = handler; } },
      store,
      wsManager,
      deliveryInFlight: new Set(),
      observerIntervalMs: 60_000,
      enrichThread: async (thread, _snapshot, runtimeCache) => {
        if (!runtimeCache.has(thread.participant)) runtimeCache.set(thread.participant, ++lookups);
        return thread;
      },
      normalizeThreadSummary: (thread) => thread,
    });
  });

  subscribe({}, 'agent-bus:threads', { action: 'subscribe' });
  assert.equal((await sent).threads.length, 3);
  assert.equal(lookups, 1);
  await close();
});

test('thread state routes do not probe archived participant runtimes', async (t) => {
  const h = await createAgentBusHarness();
  t.after(() => h.cleanup());
  await h.store.createThread({ title: 'open', participants: [{ kind: 'codex', sessionId: 'codex-1' }] });
  const archived = await h.store.createThread({ title: 'archived', participants: [{ kind: 'codex', sessionId: 'archived' }] });
  await h.store.closeThread(archived.id);

  const response = await h.app.inject({
    method: 'GET',
    url: '/api/agent-bus/state?messageLimit=0&deliveryLimit=0',
    headers: h.authHeaders,
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().threads.length, 2);
  assert.equal(h.sessionFetchCounts.codex.get('codex-1'), 1);
  assert.equal(h.sessionFetchCounts.codex.get('archived'), undefined);
});

test('state endpoint filters participants and limits copied tails while keeping totals and latest timestamps', async (t) => {
  const h = await createAgentBusHarness();
  t.after(() => h.cleanup());
  const thread = await h.store.createThread({ participants: [
    { kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' },
  ] });
  await h.store.createThread({ participants: [
    { kind: 'codex', sessionId: 'codex-2' }, { kind: 'claude', sessionId: 'claude-1' },
  ] });
  let latest;
  for (const body of ['first', 'second', 'third']) {
    latest = await h.store.createMessage({ threadId: thread.id,
      from: { kind: 'codex', sessionId: 'codex-1' },
      targets: [{ kind: 'claude', sessionId: 'claude-1' }], body });
  }

  const response = await h.app.inject({ method: 'GET',
    url: '/api/agent-bus/state?kind=codex&sessionId=codex-1&messageLimit=1&deliveryLimit=1',
    headers: h.authHeaders });

  assert.equal(response.statusCode, 200, response.body);
  const [entry] = response.json().threads;
  assert.equal(response.json().threads.length, 1);
  assert.equal(entry.thread.id, thread.id);
  assert.deepEqual(entry.messages.map((message) => message.body), ['third']);
  assert.equal(entry.messageCount, 3);
  assert.equal(entry.messagesTruncated, true);
  assert.equal(entry.latestMessageAt, latest.message.createdAt);
  assert.equal(entry.deliveries.length, 1);
  assert.equal(entry.deliveryCount, 3);
  assert.equal(entry.deliveriesTruncated, true);
  assert.equal(entry.latestDeliveryAt, null);
});

test('state endpoint delivery health includes failed deliveries outside the requested tail', async (t) => {
  const h = await createAgentBusHarness();
  t.after(() => h.cleanup());
  const thread = await h.store.createThread({ participants: [
    { kind: 'codex', sessionId: 'codex-1' }, { kind: 'claude', sessionId: 'claude-1' },
  ] });
  for (const [body, deliveryStatus] of [['failed-old', 'failed'], ['queued-new', 'queued']]) {
    await h.store.createMessage({ threadId: thread.id,
      from: { kind: 'codex', sessionId: 'codex-1' },
      targets: [{ kind: 'claude', sessionId: 'claude-1' }], body, deliveryStatus });
  }

  for (const options of ['deliveryLimit=1', 'includeDeliveries=false']) {
    const response = await h.app.inject({ method: 'GET', url: `/api/agent-bus/state?${options}`, headers: h.authHeaders });
    assert.equal(response.statusCode, 200, response.body);
    const [entry] = response.json().threads.filter((item) => item.thread.id === thread.id);
    assert.equal(entry.thread.health, 'failed');
    assert.equal(entry.thread.metadata.deliveryHealth.failed, 1);
    if (options === 'includeDeliveries=false') assert.equal(entry.deliveries, undefined);
    else assert.equal(entry.deliveries.length, 1);
  }
});
