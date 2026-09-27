import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FleetPoller,
  pollFleetDeployment,
  summarizeDebugRows,
} from '../modules/fleet/poller.mjs';
import { businessOsHealthFixture } from './helpers/fleet-fixtures.mjs';

function deployment(overrides = {}) {
  return {
    deploymentId: 'example-client',
    baseUrl: 'https://ops.example.com',
    token: 'test-token',
    pollingIntervalSeconds: 120,
    debugFetchOnDegraded: true,
    ...overrides,
  };
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
  };
}

function routeFetch(routes, calls = []) {
  return async (url, options = {}) => {
    calls.push({ url, options });
    const handler = routes[url];
    if (!handler) return jsonResponse(404, { code: 'route_not_found' });
    if (typeof handler === 'function') return handler(url, options);
    return jsonResponse(handler.status || 200, handler.body);
  };
}

describe('fleet poller', () => {
  it('polls health with bearer auth and does not fetch debug for healthy deployments', async () => {
    const calls = [];
    const result = await pollFleetDeployment(deployment(), {
      now: () => 1000,
      fetchImpl: routeFetch({
        'https://ops.example.com/api/diagnostics/health': {
          body: businessOsHealthFixture(),
        },
      }, calls),
    });

    assert.deepEqual(result, {
      deploymentId: 'example-client',
      displayName: 'Example Client',
      buildSha: 'e53debe0',
      status: 'ok',
      markers: [],
      reachable: true,
      lastPollMs: 1000,
      error: null,
      debugCounts: {
        total: 0,
        capped: false,
        unavailable: null,
        bySource: {},
        bySeverity: {},
        byCategory: {},
        byErrorCode: {},
        debugGroups: [],
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://ops.example.com/api/diagnostics/health');
    assert.equal(calls[0].options.headers.authorization, 'Bearer test-token');
  });

  it('lazily fetches debug on degraded markers and summarizes safe counts only', async () => {
    const calls = [];
    const result = await pollFleetDeployment(deployment(), {
      now: () => 2000,
      fetchImpl: routeFetch({
        'https://ops.example.com/api/diagnostics/health': {
          body: businessOsHealthFixture({
            status: 'degraded',
            pumps: [
              {
                pump: 'drive_sync',
                last_outcome: 'error: token=secret raw provider outage',
              },
            ],
          }),
        },
        'https://ops.example.com/api/debug': {
          body: {
            rows: [
              {
                diagnostic_id: 'panic:abc',
                source: 'panic',
                severity: 'error',
                category: 'panic',
                error_code: 'panic',
                error_message: 'secret backtrace token=abc',
                occurred_at_ms: 1,
              },
              {
                diagnostic_id: 'llm:def',
                source: 'llm',
                severity: 'warning',
                category: 'llm',
                error_code: 'llm_timeout',
                error_message: 'raw llm text',
                occurred_at_ms: 2,
              },
            ],
          },
        },
      }, calls),
    });

    assert.equal(calls.length, 2);
    assert.deepEqual(result.markers, ['degraded', 'connector_degraded:drive_sync']);
    assert.equal(result.debugCounts.total, 2);
    assert.equal(result.debugCounts.capped, false);
    assert.equal(result.debugCounts.unavailable, null);
    assert.deepEqual(result.debugCounts.bySource, { panic: 1, llm: 1 });
    assert.deepEqual(result.debugCounts.bySeverity, { error: 1, warning: 1 });
    assert.deepEqual(result.debugCounts.byCategory, { panic: 1, llm: 1 });
    assert.deepEqual(result.debugCounts.byErrorCode, { panic: 1, llm_timeout: 1 });
    assert.equal(result.debugCounts.debugGroups.length, 2);
    assert.deepEqual(
      result.debugCounts.debugGroups.map((group) => ({
        count: group.count,
        source: group.source,
        severity: group.severity,
        category: group.category,
        errorCode: group.errorCode,
        bucketMs: group.bucketMs,
      })),
      [
        { count: 1, source: 'llm', severity: 'warning', category: 'llm', errorCode: 'llm_timeout', bucketMs: 0 },
        { count: 1, source: 'panic', severity: 'error', category: 'panic', errorCode: 'panic', bucketMs: 0 },
      ]
    );
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('secret backtrace'), false);
    assert.equal(serialized.includes('raw provider outage'), false);
    assert.equal(serialized.includes('token=secret'), false);
  });

  it('tolerates debug 404 as disabled', async () => {
    const result = await pollFleetDeployment(deployment(), {
      now: () => 3000,
      fetchImpl: routeFetch({
        'https://ops.example.com/api/diagnostics/health': {
          body: businessOsHealthFixture({ status: 'degraded' }),
        },
        'https://ops.example.com/api/debug': {
          status: 404,
          body: { code: 'route_not_found' },
        },
      }),
    });

    assert.equal(result.reachable, true);
    assert.deepEqual(result.markers, ['degraded']);
    assert.equal(result.debugCounts.unavailable, 'disabled');
  });

  it('marks a timeout as a sanitized unreachable result', async () => {
    const fetchImpl = async (_url, options = {}) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });

    const result = await pollFleetDeployment(deployment(), {
      now: () => 4000,
      timeoutMs: 5,
      fetchImpl,
    });

    assert.deepEqual(result, {
      deploymentId: 'example-client',
      displayName: null,
      buildSha: null,
      status: 'degraded',
      markers: ['unreachable'],
      reachable: false,
      lastPollMs: 4000,
      error: 'timeout',
      debugCounts: {
        total: 0,
        capped: false,
        unavailable: null,
        bySource: {},
        bySeverity: {},
        byCategory: {},
        byErrorCode: {},
        debugGroups: [],
      },
    });
  });

  it('isolates failures across deployments in pollOnce', async () => {
    const poller = new FleetPoller({
      registry: {
        deployments: [
          deployment(),
          deployment({ deploymentId: 'down', baseUrl: 'https://down.example.com' }),
        ],
      },
      now: () => 5000,
      fetchImpl: routeFetch({
        'https://ops.example.com/api/diagnostics/health': {
          body: businessOsHealthFixture(),
        },
      }),
    });

    const results = await poller.pollOnce();
    assert.equal(results.length, 2);
    assert.equal(results[0].reachable, true);
    assert.equal(results[1].reachable, false);
    assert.equal(results[1].error, 'not_found');
  });

  it('caps debug rows and never stores raw messages in summaries', () => {
    const counts = summarizeDebugRows({
      rows: Array.from({ length: 3 }, (_, index) => ({
        source: 'panic',
        severity: 'error',
        category: 'panic',
        error_code: `panic_${index}`,
        error_message: `raw secret ${index}`,
      })),
    }, { maxRows: 2 });

    assert.equal(counts.total, 2);
    assert.equal(counts.capped, true);
    assert.deepEqual(counts.bySource, { panic: 2 });
    assert.equal(JSON.stringify(counts).includes('raw secret'), false);
  });

  it('collapses repeated debug rows by safe signature and minute bucket', () => {
    const counts = summarizeDebugRows({
      rows: [
        {
          source: 'panic',
          severity: 'error',
          category: 'panic',
          error_code: 'panic',
          error_message: 'same raw secret',
          occurred_at_ms: 61_000,
        },
        {
          source: 'panic',
          severity: 'error',
          category: 'panic',
          error_code: 'panic',
          error_message: 'same raw secret',
          occurred_at_ms: 65_000,
        },
        {
          source: 'panic',
          severity: 'error',
          category: 'panic',
          error_code: 'panic',
          error_message: 'same raw secret',
          occurred_at_ms: 121_000,
        },
      ],
    });

    assert.equal(counts.debugGroups.length, 2);
    assert.equal(counts.debugGroups[0].count, 2);
    assert.equal(counts.debugGroups[0].bucketMs, 60_000);
    assert.equal(counts.debugGroups[0].messageHash.length, 12);
    assert.equal(JSON.stringify(counts).includes('same raw secret'), false);
  });
});
