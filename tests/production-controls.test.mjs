import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProductionControlRegistry } from '../modules/ops/production-controls.mjs';
import { opsObservabilityPlugin } from '../modules/ops/observability.mjs';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

function makeRegistry(overrides = {}) {
  return buildProductionControlRegistry({
    sourceConfig: {
      productionControls: {
        agentBusDeliveryReplayEnabled: true,
        ...overrides,
      },
    },
  });
}

describe('production controls', () => {
  it('summarizes kill switches by module', () => {
    const registry = makeRegistry({
      agentBusDeliveryReplayEnabled: false,
    });

    const snapshot = registry.snapshot();
    assert.equal(snapshot.status, 'degraded');
    assert.deepEqual(snapshot.killSwitchesActive, ['agentBus.deliveryReplay']);
    assert.equal(snapshot.modules.agentBus.enabled, false);
    assert.deepEqual(snapshot.modules.agentBus.killSwitchesActive, ['agentBus.deliveryReplay']);
  });

  it('records a structured control event when a kill switch blocks an operation', () => {
    const recorded = [];
    const registry = buildProductionControlRegistry({
      sourceConfig: {
        productionControls: {
          agentBusDeliveryReplayEnabled: false,
        },
      },
      controlEventRecorder(event) {
        recorded.push(event);
      },
    });

    assert.throws(
      () => registry.assertEnabled('agentBus.deliveryReplay', {
        operation: 'delivery_replay',
        detail: 'delivery_123',
      }),
      /PC_FLAG_AGENT_BUS_DELIVERY_REPLAY_ENABLED/
    );
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].type, 'production_control_denied');
    assert.equal(recorded[0].module, 'agentBus');
    assert.equal(recorded[0].outcome, 'blocked');
    assert.equal(recorded[0].detail, 'delivery_123');
  });

  it('exposes the shared control snapshot via ops status', async () => {
    const registry = makeRegistry({
      agentBusDeliveryReplayEnabled: false,
    });
    const app = Fastify();
    await app.register(opsObservabilityPlugin, {
      productionControls: registry,
    });

    const res = await app.inject({ method: 'GET', url: '/api/ops/status' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().controls.status, 'degraded');
    assert.deepEqual(res.json().controls.modules.agentBus.killSwitchesActive, ['agentBus.deliveryReplay']);

    await app.close();
  });

  it('persists runtime overrides and exposes audit history', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-production-controls-'));
    tempDirs.push(dir);
    const registry = buildProductionControlRegistry({
      sourceConfig: {
        productionControls: {
          agentBusDeliveryReplayEnabled: true,
        },
      },
      storeFile: join(dir, 'production-controls.json'),
      namespace: `production_controls_${Date.now()}`,
    });

    const overridden = await registry.setOverride('agentBus.deliveryReplay', {
      enabled: false,
      changedBy: 'test_suite',
      reason: 'freeze replays',
    });

    assert.equal(overridden.enabled, false);
    assert.equal(overridden.overrideActive, true);
    assert.equal(registry.isEnabled('agentBus.deliveryReplay'), false);
    assert.deepEqual(registry.snapshot().overridesActive, ['agentBus.deliveryReplay']);

    const audit = registry.getAuditHistory({ flagKey: 'agentBus.deliveryReplay', limit: 5 });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, 'override_set');
    assert.equal(audit[0].changedBy, 'test_suite');

    await registry.close();

    const reloaded = buildProductionControlRegistry({
      sourceConfig: {
        productionControls: {
          agentBusDeliveryReplayEnabled: true,
        },
      },
      storeFile: join(dir, 'production-controls.json'),
      namespace: `production_controls_${Date.now() + 1}`,
    });

    assert.equal(reloaded.isEnabled('agentBus.deliveryReplay'), false);
    assert.equal(reloaded.getAuditSummary({ sinceHours: null }).total, 1);
    await reloaded.close();
  });

  it('refuses overrides when persisted state is corrupt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-production-controls-'));
    tempDirs.push(dir);
    const storeFile = join(dir, 'production-controls.json');
    await writeFile(storeFile, '{broken');
    const registry = buildProductionControlRegistry({
      sourceConfig: { productionControls: { agentBusDeliveryReplayEnabled: true } },
      storeFile,
      namespace: `production_controls_corrupt_${Date.now()}`,
      env: { APP_STATE_STORAGE: 'file' },
    });
    await assert.rejects(() => registry.setOverride('agentBus.deliveryReplay', {
      enabled: false,
      changedBy: 'test',
      reason: 'should not persist',
    }));
    await registry.close();
  });
});
