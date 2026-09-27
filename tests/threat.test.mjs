import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { threatPlugin } from '../modules/platform/threat.mjs';

function buildMonitorStarters(calls, cleanupCalls = []) {
  const starter = (name) => () => {
    calls.push(name);
    return () => cleanupCalls.push(name);
  };

  return {
    startAuthWatcher: starter('auth'),
    startConnectionMonitor: starter('connection'),
    startProcessMonitor: starter('process'),
    startIntegrityMonitor: starter('integrity'),
  };
}

describe('Threat module', () => {
  it('should be importable without errors', async () => {
    const mod = await import('../modules/platform/threat.mjs');
    assert.equal(typeof mod.threatPlugin, 'function');
  });

  it('does not start background monitors when side effects are suppressed', async () => {
    const app = Fastify();
    const calls = [];

    await app.register(threatPlugin, {
      wsManager: { broadcast() {} },
      sideEffectLoopsSuppressed: true,
      monitorStarters: buildMonitorStarters(calls),
    });
    await app.ready();

    assert.deepEqual(calls, []);
    assert.equal((await app.inject('/api/threats/alerts')).statusCode, 200);
    assert.equal((await app.inject('/api/threats/overview')).statusCode, 200);
    await app.close();
  });

  it('fails closed when suppression state is omitted', async () => {
    const app = Fastify();
    const calls = [];

    await app.register(threatPlugin, {
      wsManager: { broadcast() {} },
      monitorStarters: buildMonitorStarters(calls),
    });
    await app.ready();

    assert.deepEqual(calls, []);
    await app.close();
  });

  it('starts all background monitors when side effects are allowed', async () => {
    const app = Fastify();
    const calls = [];

    await app.register(threatPlugin, {
      wsManager: { broadcast() {} },
      sideEffectLoopsSuppressed: false,
      monitorStarters: buildMonitorStarters(calls),
    });
    await app.ready();

    assert.deepEqual(calls, ['auth', 'connection', 'process', 'integrity']);
    await app.close();
  });

  it('does not let a suppressed plugin instance clean up another instance monitors', async () => {
    const activeApp = Fastify();
    const suppressedApp = Fastify();
    const starts = [];
    const cleanups = [];
    const monitorStarters = buildMonitorStarters(starts, cleanups);

    await activeApp.register(threatPlugin, {
      wsManager: { broadcast() {} },
      sideEffectLoopsSuppressed: false,
      monitorStarters,
    });
    await suppressedApp.register(threatPlugin, {
      wsManager: { broadcast() {} },
      sideEffectLoopsSuppressed: true,
      monitorStarters,
    });
    await Promise.all([activeApp.ready(), suppressedApp.ready()]);

    await suppressedApp.close();
    assert.deepEqual(starts, ['auth', 'connection', 'process', 'integrity']);
    assert.deepEqual(cleanups, []);

    await activeApp.close();
    assert.deepEqual(cleanups, ['integrity', 'process', 'connection', 'auth']);
  });

  it('runs every injected disposer when its owning plugin instance closes', async () => {
    const app = Fastify();
    const starts = [];
    const cleanups = [];

    await app.register(threatPlugin, {
      wsManager: { broadcast() {} },
      sideEffectLoopsSuppressed: false,
      monitorStarters: buildMonitorStarters(starts, cleanups),
    });
    await app.ready();
    await app.close();

    assert.deepEqual(starts, ['auth', 'connection', 'process', 'integrity']);
    assert.deepEqual(cleanups, ['integrity', 'process', 'connection', 'auth']);
  });
});

describe('FileTailer', () => {
  it('should be importable without errors', async () => {
    const { FileTailer } = await import('../lib/tail.mjs');
    assert.equal(typeof FileTailer, 'function');
  });
});
