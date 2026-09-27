import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeReadiness } from '../modules/ops/health-controls.mjs';

describe('health readiness controls', () => {
  it('returns degraded when non-critical components are degraded', () => {
    const readiness = summarizeReadiness({
      storage: { status: 'ok', detail: 'ready' },
      scheduler: { status: 'ok', detail: 'running' },
      googleOAuth: { status: 'degraded', detail: 'not_configured' },
    });
    assert.equal(readiness.status, 'degraded');
    assert.equal(readiness.ready, true);
    assert.equal(readiness.components.googleOAuth.status, 'degraded');
  });

  it('returns failed and not ready when a critical component fails', () => {
    const readiness = summarizeReadiness({
      storage: { status: 'failed', detail: 'db_down' },
      scheduler: { status: 'ok', detail: 'running' },
    });
    assert.equal(readiness.status, 'failed');
    assert.equal(readiness.ready, false);
    assert.equal(readiness.components.storage.detail, 'db_down');
  });
});
