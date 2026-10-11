import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOpsControlEventStore } from '../modules/ops/control-events.mjs';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function makeStore({ maxEvents = 100 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-control-events-'));
  tempDirs.push(dir);
  return buildOpsControlEventStore({
    storeFile: join(dir, 'ops-control-events.json'),
    namespace: `ops_control_events_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    env: { APP_STATE_STORAGE: 'file' },
    now: () => new Date('2026-07-02T12:00:00.000Z'),
    maxEvents,
  });
}

describe('ops control events', () => {
  it('normalizes recorded events and filters by module/severity/outcome', async () => {
    const store = await makeStore();
    await store.recordEvent({
      type: 'production_control_denied',
      severity: 'CRITICAL',
      module: 'agentBus',
      action: 'delivery_replay',
      outcome: 'blocked',
      code: 'PC_FLAG_AGENT_BUS_DELIVERY_REPLAY_ENABLED',
      metadata: { deliveryId: 'del_1' },
    });
    await store.recordEvent({
      severity: 'not-real',
      module: 'ops',
      outcome: 'observed',
    });

    const filtered = await store.listEvents({
      module: 'agentBus',
      severity: 'critical',
      outcome: 'blocked',
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].severity, 'critical');
    assert.equal(filtered[0].metadata.deliveryId, 'del_1');

    const summary = await store.getSummary({ sinceHours: null });
    assert.equal(summary.total, 2);
    assert.equal(summary.bySeverity.critical, 1);
    assert.equal(summary.bySeverity.info, 1);
    assert.equal(summary.byOutcome.blocked, 1);
    await store.close();
  });

  it('keeps newest events first and caps retained event history', async () => {
    const store = await makeStore({ maxEvents: 100 });
    for (let index = 0; index < 105; index += 1) {
      await store.recordEvent({
        module: 'ops',
        action: `event-${index}`,
        createdAt: new Date(Date.UTC(2026, 6, 2, 12, 0, index)).toISOString(),
      });
    }

    const events = await store.listEvents({ limit: 200 });
    assert.equal(events.length, 100);
    assert.equal(events[0].action, 'event-104');
    assert.equal(events.at(-1).action, 'event-5');
    await store.close();
  });

  it('recovers the save queue after a failed write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-control-events-'));
    tempDirs.push(dir);
    let failOnce = true;
    const backing = {
      async load() { return { version: 1, events: [] }; },
      async save() {
        if (failOnce) {
          failOnce = false;
          throw new Error('disk full');
        }
      },
      async close() {},
    };
    const { buildOpsControlEventStore } = await import('../modules/ops/control-events.mjs');
    const store = buildOpsControlEventStore({
      stateStore: backing,
      now: () => new Date('2026-07-02T12:00:00.000Z'),
    });
    await assert.rejects(() => store.recordEvent({ action: 'one' }), /disk full/);
    await store.recordEvent({ action: 'two' });
    const events = await store.listEvents();
    assert.equal(events.some((event) => event.action === 'two'), true);
    await store.close();
  });

  it('persists concurrent events before resolving and reloads isolated metadata', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cadre-events-reload-'));
    tempDirs.push(dir);
    const options = { storeFile: join(dir, 'events.json'), env: { APP_STATE_STORAGE: 'file' } };
    const store = buildOpsControlEventStore(options);
    const metadata = { nested: { value: 1 } };
    const events = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.recordEvent({ action: `concurrent-${index}`, metadata })));
    metadata.nested.value = 2;
    events[0].metadata.nested.value = 3;
    // Reload immediately, without close: recordEvent already promised persistence.
    const reloaded = buildOpsControlEventStore(options);
    const rows = await reloaded.listEvents();
    assert.equal(rows.length, 20);
    assert.deepEqual(new Set(rows.map((row) => row.action)), new Set(events.map((row) => row.action)));
    assert.equal(rows.every((row) => row.metadata.nested.value === 1), true);
    await store.close();
    await reloaded.close();
  });

  it('keeps in-flight snapshots stable and waits for events arriving during a write', async () => {
    let beginWrite;
    const started = new Promise((resolve) => { beginWrite = resolve; });
    let releaseWrite;
    const blocked = new Promise((resolve) => { releaseWrite = resolve; });
    const snapshots = [];
    const store = buildOpsControlEventStore({ maxEvents: 100, stateStore: {
      load: async () => ({ version: 1, events: Array.from({ length: 100 }, (_, i) => ({ id: `old-${i}` })) }),
      save: async (snapshot) => {
        snapshots.push(snapshot);
        if (snapshots.length === 1) { beginWrite(); await blocked; }
      },
    } });
    const first = store.recordEvent({ action: 'first' });
    await started;
    let secondResolved = false;
    const second = store.recordEvent({ action: 'second' }).then(() => { secondResolved = true; });
    await store.listEvents();
    assert.equal(secondResolved, false);
    assert.equal(snapshots[0].events.length, 100);
    assert.equal(snapshots[0].events[0].action, 'first');
    releaseWrite();
    await Promise.all([first, second]);
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[1].events[0].action, 'second');
    await store.close();
  });

  it('rejects every coalesced caller and retries after a failed write', async () => {
    let writes = 0;
    const store = buildOpsControlEventStore({ stateStore: {
      load: async () => null,
      save: async () => { if (++writes === 1) throw new Error('disk full'); },
    } });
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => store.recordEvent()));
    assert.equal(writes, 1);
    assert.equal(results.every((result) => result.status === 'rejected' && /disk full/.test(result.reason.message)), true);
    await store.recordEvent();
    assert.equal(writes, 2);
    await store.close();
  });

  it('refuses writes when event history is corrupt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-control-events-'));
    tempDirs.push(dir);
    const storeFile = join(dir, 'ops-control-events.json');
    await writeFile(storeFile, '{broken');
    const store = await buildOpsControlEventStore({
      storeFile,
      namespace: `ops_control_events_${Date.now()}`,
      env: { APP_STATE_STORAGE: 'file' },
    });
    await assert.rejects(() => store.recordEvent({ action: 'nope' }));
    await store.close();

    await writeFile(storeFile, '[]');
    const shaped = await buildOpsControlEventStore({
      storeFile,
      namespace: `ops_control_events_${Date.now()}_shape`,
      env: { APP_STATE_STORAGE: 'file' },
    });
    await assert.rejects(() => shaped.recordEvent({ action: 'nope' }));
    await shaped.close();
  });
});
