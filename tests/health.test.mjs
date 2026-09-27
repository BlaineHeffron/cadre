import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('Health endpoint', () => {
  let app;

  before(async () => {
    // Dynamic import so the server doesn't start listening on the test port
    const { default: Fastify } = await import('fastify');
    const { summarizeReadiness } = await import('../modules/ops/health-controls.mjs');
    app = Fastify();
    app.get('/api/health/live', async () => ({ status: 'ok', uptime: process.uptime() }));
    app.get('/api/health/ready', async (_req, reply) => {
      const readiness = summarizeReadiness({
        storage: { status: 'ok', detail: 'ready' },
        scheduler: { status: 'ok', detail: 'running' },
      });
      if (!readiness.ready) reply.code(503);
      return readiness;
    });
    app.get('/api/health', async () => ({ status: 'ok', uptime: process.uptime() }));
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('returns ok status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptime, 'number');
  });

  it('exposes separate live and ready endpoints', async () => {
    const liveRes = await app.inject({ method: 'GET', url: '/api/health/live' });
    const readyRes = await app.inject({ method: 'GET', url: '/api/health/ready' });
    assert.equal(liveRes.statusCode, 200);
    assert.equal(readyRes.statusCode, 200);
    assert.equal(readyRes.json().status, 'ok');
    assert.equal(readyRes.json().components.scheduler.status, 'ok');
  });

  it('keeps unrelated providers ready when Pi health is degraded', async () => {
    const { summarizeReadiness } = await import('../modules/ops/health-controls.mjs');
    const readiness = summarizeReadiness({
      storage: { status: 'ok', detail: 'ready' },
      piProvider: {
        status: 'degraded',
        detail: 'pi_node_version_incompatible',
        data: { error: 'Pi requires Node.js 22.19.0 or newer' },
      },
    });

    assert.equal(readiness.ready, true);
    assert.equal(readiness.status, 'degraded');
    assert.equal(readiness.components.piProvider.detail, 'pi_node_version_incompatible');
  });
});
