import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ackFleetIncident,
  buildFleetIncidentStore,
  transitionFleetIncident,
} from '../modules/fleet/incidents.mjs';

function poll(overrides = {}) {
  return {
    deploymentId: 'example-client',
    displayName: 'Example Client',
    status: 'degraded',
    markers: ['degraded'],
    reachable: true,
    lastPollMs: 1000,
    error: null,
    debugCounts: {
      total: 1,
      capped: false,
      unavailable: null,
      bySource: { panic: 1 },
      bySeverity: { error: 1 },
      byCategory: { panic: 1 },
      byErrorCode: { panic: 1 },
    },
    ...overrides,
  };
}

function memoryStateStore(initial = null) {
  let state = initial;
  return {
    saved: [],
    loadSync() {
      return state;
    },
    async load() {
      return state;
    },
    async save(next) {
      state = JSON.parse(JSON.stringify(next));
      this.saved.push(state);
    },
    async close() {},
  };
}

describe('fleet incident transitions', () => {
  it('opens one incident with safe evidence for active markers', () => {
    const result = transitionFleetIncident(poll({
      debugCounts: {
        total: 1,
        bySource: { panic: 1 },
        bySeverity: { error: 1 },
        byCategory: { panic: 1 },
        byErrorCode: { secret_raw_message_should_not_copy: 1 },
      },
    }), null, { nowMs: 2000 });

    assert.equal(result.incident.deploymentId, 'example-client');
    assert.equal(result.incident.status, 'open');
    assert.deepEqual(result.incident.markers, ['degraded']);
    assert.equal(result.incident.occurrenceCount, 1);
    assert.deepEqual(result.incident.markerHistory, [
      { marker: 'degraded', firstSeenMs: 2000, lastSeenMs: 2000 },
    ]);
    assert.equal(result.evidence.incidentId, result.incident.id);
    assert.deepEqual(result.evidence.healthSnapshot.markers, ['degraded']);
    assert.equal(result.events[0].type, 'opened');
    assert.equal(JSON.stringify(result).includes('error_message'), false);
  });

  it('updates without duplicating markers or marker history rows', () => {
    const opened = transitionFleetIncident(poll(), null, { nowMs: 1000 }).incident;
    const updated = transitionFleetIncident(poll({
      markers: ['degraded', 'degraded', 'dead_letter_growth'],
      debugCounts: {
        total: 2,
        bySource: { panic: 2 },
      },
    }), opened, { nowMs: 2000 });

    assert.equal(updated.incident.id, opened.id);
    assert.deepEqual(updated.incident.markers, ['dead_letter_growth', 'degraded']);
    assert.equal(updated.incident.occurrenceCount, 2);
    assert.deepEqual(updated.incident.markerHistory, [
      { marker: 'dead_letter_growth', firstSeenMs: 2000, lastSeenMs: 2000 },
      { marker: 'degraded', firstSeenMs: 1000, lastSeenMs: 2000 },
    ]);
    assert.equal(updated.events[0].type, 'updated');
    assert.equal(updated.evidence.debugCounts.total, 2);
  });

  it('keeps incident open after one healthy poll and resolves after the configured count', () => {
    const opened = transitionFleetIncident(poll(), null, { nowMs: 1000 }).incident;
    const oneHealthy = transitionFleetIncident(poll({
      status: 'ok',
      markers: [],
      debugCounts: undefined,
    }), opened, { nowMs: 2000, healthyPollsToResolve: 2 });

    assert.equal(oneHealthy.incident.status, 'open');
    assert.equal(oneHealthy.incident.healthyPollCount, 1);
    assert.equal(oneHealthy.events[0].type, 'healthy_observed');

    const resolved = transitionFleetIncident(poll({
      status: 'ok',
      markers: [],
      debugCounts: undefined,
    }), oneHealthy.incident, { nowMs: 3000, healthyPollsToResolve: 2 });

    assert.equal(resolved.incident.status, 'resolved');
    assert.deepEqual(resolved.incident.markers, []);
    assert.equal(resolved.incident.resolvedAtMs, 3000);
    assert.equal(resolved.events[0].type, 'resolved');
  });

  it('treats resolved incidents as terminal and opens a new incident for new markers', () => {
    const opened = transitionFleetIncident(poll(), null, { nowMs: 1000 }).incident;
    const resolved = transitionFleetIncident(poll({ markers: [], status: 'ok' }), opened, {
      nowMs: 2000,
      healthyPollsToResolve: 1,
    }).incident;
    const nextEpisode = transitionFleetIncident(poll({ markers: ['dead_letter_growth'] }), resolved, {
      nowMs: 3000,
    });

    assert.notEqual(nextEpisode.incident.id, opened.id);
    assert.equal(nextEpisode.incident.status, 'open');
    assert.equal(nextEpisode.incident.openedAtMs, 3000);
    assert.equal(nextEpisode.incident.occurrenceCount, 1);
    assert.deepEqual(nextEpisode.incident.markers, ['dead_letter_growth']);
    assert.equal(nextEpisode.incident.resolvedAtMs, undefined);
    assert.equal(nextEpisode.events[0].type, 'opened');
  });

  it('opens reachability-loss incidents from unreachable poll markers', () => {
    const result = transitionFleetIncident(poll({
      displayName: null,
      status: 'degraded',
      markers: ['unreachable'],
      reachable: false,
      error: 'timeout',
      debugCounts: undefined,
    }), null, { nowMs: 4000 });

    assert.equal(result.incident.status, 'open');
    assert.deepEqual(result.incident.markers, ['unreachable']);
    assert.equal(result.evidence.healthSnapshot.reachable, false);
    assert.equal(result.evidence.healthSnapshot.error, 'timeout');
  });

  it('acks active incidents only through the explicit transition', () => {
    const opened = transitionFleetIncident(poll(), null, { nowMs: 1000 }).incident;
    const acked = ackFleetIncident(opened, { nowMs: 1500, actor: 'dev' });

    assert.equal(acked.status, 'ack');
    assert.equal(acked.ackedAtMs, 1500);
    assert.equal(acked.ackedBy, 'dev');
  });
});

describe('fleet incident store', () => {
  it('persists incidents and latest evidence in the fleet_incidents namespace shape', async () => {
    const storeBacking = memoryStateStore();
    let currentNow = 1000;
    const store = buildFleetIncidentStore({
      stateStore: storeBacking,
      now: () => currentNow,
      healthyPollsToResolve: 2,
    });

    const opened = await store.applyPollResult(poll({ markers: ['degraded'] }));
    assert.equal(opened.events[0].type, 'opened');
    assert.equal(storeBacking.saved[0].version, 1);
    assert.ok(storeBacking.saved[0].incidents[opened.incident.id]);
    assert.ok(storeBacking.saved[0].evidence[opened.incident.evidenceRef]);

    currentNow = 2000;
    const updated = await store.applyPollResult(poll({ markers: ['degraded', 'dead_letter_growth'] }));
    assert.equal(updated.incident.id, opened.incident.id);
    assert.equal(updated.incident.occurrenceCount, 2);

    const listed = await store.listIncidents({ status: 'open' });
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0].markers, ['dead_letter_growth', 'degraded']);

    const evidence = await store.getEvidence(opened.incident.id);
    assert.equal(evidence.incidentId, opened.incident.id);
    assert.deepEqual(evidence.healthSnapshot.markers, ['dead_letter_growth', 'degraded']);

    const acked = await store.ackIncident(opened.incident.id, { actor: 'ops' });
    assert.equal(acked.status, 'ack');
    await store.close();
  });

  it('does not reuse a resolved incident id for a later degraded episode', async () => {
    const storeBacking = memoryStateStore();
    let currentNow = 1000;
    const store = buildFleetIncidentStore({
      stateStore: storeBacking,
      now: () => currentNow,
      healthyPollsToResolve: 1,
    });

    const opened = await store.applyPollResult(poll({ markers: ['degraded'] }));
    currentNow = 2000;
    const resolved = await store.applyPollResult(poll({ markers: [], status: 'ok' }));
    currentNow = 3000;
    const nextEpisode = await store.applyPollResult(poll({ markers: ['dead_letter_growth'] }));

    assert.equal(resolved.incident.id, opened.incident.id);
    assert.equal(resolved.incident.status, 'resolved');
    assert.notEqual(nextEpisode.incident.id, opened.incident.id);
    assert.equal(nextEpisode.incident.openedAtMs, 3000);
    assert.equal(nextEpisode.incident.occurrenceCount, 1);
    assert.equal(nextEpisode.events[0].type, 'opened');

    const listed = await store.listIncidents({ deploymentId: 'example-client' });
    assert.equal(listed.length, 2);
    await store.close();
  });
});
