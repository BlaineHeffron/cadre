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
