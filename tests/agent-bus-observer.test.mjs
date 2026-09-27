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
      adapters: {},
      wsManager,
      observedSessions: new Set(),
      deliveryInFlight: new Set(),
      observerInFlightByRef: new Map(),
      observerIntervalMs: 60_000,
      observerSessionTimeoutMs: 5_000,
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
