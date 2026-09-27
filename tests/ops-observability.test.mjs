import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getOpsMetricsRegistry,
  incrementOpsCounter,
  opsObservabilityPlugin,
  recordOpsTiming,
} from '../modules/ops/observability.mjs';
import { buildOpsControlEventStore } from '../modules/ops/control-events.mjs';
import { buildProductionControlRegistry } from '../modules/ops/production-controls.mjs';

const tempDirs = [];

describe('ops observability', () => {
  beforeEach(() => {
    getOpsMetricsRegistry().reset();
  });

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it('captures counters and timings in JSON and Prometheus formats', async () => {
    incrementOpsCounter('agent_bus_delivery_total', 2, { result: 'injected' });
    recordOpsTiming('agent_bus_replay_duration_ms', 120, { result: 'replayed' });

    const app = Fastify();
    await app.register(opsObservabilityPlugin);

    const jsonRes = await app.inject({ method: 'GET', url: '/api/ops/metrics' });
    assert.equal(jsonRes.statusCode, 200);
    const payload = jsonRes.json();
    assert.ok(Array.isArray(payload.counters));
    assert.ok(payload.counters.some((item) => item.name === 'agent_bus_delivery_total' && item.value === 2));
    assert.ok(Array.isArray(payload.timings));
    assert.ok(payload.timings.some((item) => item.name === 'agent_bus_replay_duration_ms' && item.totalMs === 120));

    const textRes = await app.inject({ method: 'GET', url: '/api/ops/metrics?format=prometheus' });
    assert.equal(textRes.statusCode, 200);
    assert.match(textRes.body, /agent_bus_delivery_total\{result="injected"\} 2/);
    assert.match(textRes.body, /agent_bus_replay_duration_ms_total_ms\{result="replayed"\} 120/);

    const statusRes = await app.inject({ method: 'GET', url: '/api/ops/status' });
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.json().controls.status, 'ok');

    await app.close();
  });

  it('persists control events and exposes filtered event queries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-ops-events-'));
    tempDirs.push(dir);
    const controlEventStore = buildOpsControlEventStore({
      storeFile: join(dir, 'ops-control-events.json'),
      namespace: `ops_control_events_${Date.now()}`,
    });
    await controlEventStore.recordEvent({
      type: 'production_control_denied',
      severity: 'warning',
      module: 'agentBus',
      action: 'delivery_replay',
      outcome: 'blocked',
      code: 'production_control_disabled',
      detail: 'delivery_123',
      message: 'Delivery replay was blocked by the kill switch',
    });
    await controlEventStore.recordEvent({
      type: 'delivery_failed',
      severity: 'critical',
      module: 'agentBus',
      action: 'deliver',
      outcome: 'failed',
      code: 'agent_bus.delivery_failed',
      detail: 'delivery_456',
      message: 'Delivery failed',
    });

    const app = Fastify();
    await app.register(opsObservabilityPlugin, { controlEventStore });

    const res = await app.inject({
      method: 'GET',
      url: '/api/ops/events?module=agentBus&severity=critical&limit=5',
    });
    assert.equal(res.statusCode, 200);
    const payload = res.json();
    assert.equal(payload.summary.total, 2);
    assert.equal(payload.summary.bySeverity.critical, 1);
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0].type, 'delivery_failed');
    assert.equal(payload.events[0].detail, 'delivery_456');

    const statusRes = await app.inject({ method: 'GET', url: '/api/ops/status' });
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.json().controlEvents.total, 2);

    await app.close();

    const persistedStore = buildOpsControlEventStore({
      storeFile: join(dir, 'ops-control-events.json'),
      namespace: `ops_control_events_${Date.now() + 1}`,
    });
    const persisted = await persistedStore.listEvents({ limit: 10 });
    assert.equal(persisted.length, 2);
    assert.equal(persisted[0].type, 'delivery_failed');
    await persistedStore.close();
  });

  it('supports operator runtime override APIs with audit history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-ops-controls-'));
    tempDirs.push(dir);
    const productionControls = buildProductionControlRegistry({
      sourceConfig: {
        productionControls: {
          agentBusDeliveryReplayEnabled: true,
        },
      },
      storeFile: join(dir, 'production-controls.json'),
      namespace: `ops_controls_${Date.now()}`,
    });

    const app = Fastify();
    await app.register(opsObservabilityPlugin, { productionControls });

    const setRes = await app.inject({
      method: 'PUT',
      url: '/api/ops/controls/agentBus.deliveryReplay/override',
      payload: {
        enabled: false,
        changedBy: 'ops_panel_test',
        reason: 'freeze replays',
      },
    });
    assert.equal(setRes.statusCode, 200);
    assert.equal(setRes.json().flag.enabled, false);
    assert.deepEqual(setRes.json().controls.modules.agentBus.killSwitchesActive, ['agentBus.deliveryReplay']);

    const auditRes = await app.inject({
      method: 'GET',
      url: '/api/ops/controls/audit?flagKey=agentBus.deliveryReplay&limit=5',
    });
    assert.equal(auditRes.statusCode, 200);
    assert.equal(auditRes.json().entries.length, 1);
    assert.equal(auditRes.json().entries[0].changedBy, 'ops_panel_test');

    const clearRes = await app.inject({
      method: 'DELETE',
      url: '/api/ops/controls/agentBus.deliveryReplay/override',
      payload: {
        changedBy: 'ops_panel_test',
        reason: 'incident closed',
      },
    });
    assert.equal(clearRes.statusCode, 200);
    assert.equal(clearRes.json().flag.enabled, true);

    const invalidRes = await app.inject({
      method: 'PUT',
      url: '/api/ops/controls/not-real/override',
      payload: { enabled: false },
    });
    assert.equal(invalidRes.statusCode, 404);

    await app.close();
  });
});
