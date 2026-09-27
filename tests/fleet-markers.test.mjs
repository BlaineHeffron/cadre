import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fleetMarkersFromBusinessOsHealth } from '../modules/fleet/markers.mjs';
import { businessOsHealthFixture } from './helpers/fleet-fixtures.mjs';

describe('fleet safe markers', () => {
  it('returns no markers for a healthy BusinessOS health payload', () => {
    assert.deepEqual(fleetMarkersFromBusinessOsHealth(businessOsHealthFixture()), []);
  });

  it('maps BusinessOS health signals to safe marker classes only', () => {
    const health = businessOsHealthFixture({
      status: 'degraded',
      pumps: [
        {
          pump: 'accounting_sync',
          last_outcome: 'error: provider timeout token=secret-raw-text',
        },
      ],
      outbox: {
        pending_jobs: 4,
        terminal_jobs: 2,
        last_terminal_error: 'raw terminal failure password=secret',
      },
      errors_1h: {
        window_ms: 3600000,
        failed_receipts: 3,
        conflict_receipts: 0,
        llm_failures: 4,
        llm_errors: [
          {
            purpose: 'triage',
            error_code: 'llm_timeout_secret',
            count: 4,
          },
        ],
      },
    });

    const markers = fleetMarkersFromBusinessOsHealth(health);
    assert.deepEqual(markers, [
      'degraded',
      'dead_letter_growth',
      'connector_degraded:accounting_sync',
      'error_rate_spike',
      'llm_error_spike',
    ]);
    const serialized = JSON.stringify(markers);
    assert.equal(serialized.includes('provider timeout'), false);
    assert.equal(serialized.includes('secret-raw-text'), false);
    assert.equal(serialized.includes('password=secret'), false);
    assert.equal(serialized.includes('llm_timeout_secret'), false);
  });

  it('does not mark counts below spike thresholds', () => {
    const markers = fleetMarkersFromBusinessOsHealth(businessOsHealthFixture({
      errors_1h: {
        window_ms: 3600000,
        failed_receipts: 2,
        conflict_receipts: 0,
        llm_failures: 2,
        llm_errors: [],
      },
    }));
    assert.deepEqual(markers, []);
  });

  it('sanitizes pump names in connector markers', () => {
    const markers = fleetMarkersFromBusinessOsHealth(businessOsHealthFixture({
      pumps: [
        {
          pump: 'Accounting Sync / token=abc',
          last_outcome: 'error: raw failure',
        },
      ],
    }));
    assert.deepEqual(markers, ['connector_degraded:accounting_sync_token_abc']);
    assert.equal(JSON.stringify(markers).includes('raw failure'), false);
  });
});
