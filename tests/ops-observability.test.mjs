import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getOpsMetricsRegistry,
  incrementOpsCounter,
  opsLogMethod,
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

  it('captures coded warnings through real root and child loggers, escalating once per day', async (t) => {
    let now = Date.parse('2026-10-08T12:00:00Z');
    t.mock.method(Date, 'now', () => now);
    const logs = [];
    const app = Fastify({ logger: { level: 'debug', hooks: { logMethod: opsLogMethod }, stream: { write: (line) => logs.push(JSON.parse(line)) } } });
    t.after(() => app.close());
    const registry = getOpsMetricsRegistry();
    const child = app.log.child({ component: 'test' });
    const count = (name, code) => registry.snapshot().counters.find((item) => item.name === name && item.labels.code === code)?.value || 0;
    for (let i = 0; i < 100; i++) child.warn({ code: 'spawn_failed' }, 'Spawn failed');
    assert.equal(registry.warningHealth().status, 'ok');
    assert.equal(count('warning_escalation_total', 'spawn_failed'), 0);
    app.log.warn({ code: 'spawn_failed' }, 'Spawn failed');
    assert.deepEqual(registry.warningHealth(), { status: 'degraded', detail: 'repeated_warnings', data: { codes: ['spawn_failed'] } });
    for (let i = 0; i < 100; i++) child.warn({ err: Object.assign(new Error('Spawn failed'), { code: 'spawn_failed' }) }, 'Spawn failed');
    assert.equal(count('warning_total', 'spawn_failed'), 201);
    assert.equal(count('warning_escalation_total', 'spawn_failed'), 1);
    assert.equal(logs.length, 201);
    assert.equal(logs[0].msg, 'Spawn failed');
    assert.equal(logs[0].level, 40);
    assert.equal(logs.at(-1).err.code, 'spawn_failed');
    now += 600_000;
    assert.equal(registry.warningHealth().status, 'ok');
    for (let i = 0; i < 101; i++) child.warn({ code: 'spawn_failed' }, 'Spawn failed');
    assert.equal(count('warning_escalation_total', 'spawn_failed'), 1);
    now += 86_400_000;
    for (let i = 0; i < 101; i++) child.warn({ code: 'spawn_failed' }, 'Spawn failed');
    assert.equal(count('warning_escalation_total', 'spawn_failed'), 2);
    for (let i = 0; i < 101; i++) child.warn({ code: 'different' }, 'Another warning');
    assert.equal(count('warning_escalation_total', 'different'), 1);
    app.log.info({ code: 'ignored' }, 'Info');
    app.log.error({ code: 'ignored' }, 'Error');
    app.log.warn('Warning without a code');
    assert.equal(count('warning_total', 'ignored'), 0);
  });

  it('uses a rolling window rather than lifetime counts or fixed buckets', async (t) => {
    let now = Date.parse('2026-10-08T12:00:00Z');
    t.mock.method(Date, 'now', () => now);
    const app = Fastify({ logger: { hooks: { logMethod: opsLogMethod }, stream: { write() {} } } });
    t.after(() => app.close());
    const registry = getOpsMetricsRegistry();
    for (let i = 0; i < 60; i++) app.log.warn({ code: 'rolling' });
    now += 599_999;
    for (let i = 0; i < 41; i++) app.log.warn({ code: 'rolling' });
    assert.equal(registry.warningHealth().status, 'degraded');
    now += 1;
    assert.equal(registry.warningHealth().status, 'ok');
    now += 600_000;
    for (let i = 0; i < 100; i++) app.log.warn({ code: 'rolling' });
    assert.equal(registry.warningHealth().status, 'ok');
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
