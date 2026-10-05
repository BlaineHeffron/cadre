import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { buildMonitorMcpServer } from '../modules/platform/monitor-mcp.mjs';
import { scheduledAgentsPlugin } from '../modules/integrations/scheduled-agents-plugin.mjs';
import {
  buildScheduledAgentStore,
  SchedulerLoop,
  stepDue,
} from '../modules/integrations/scheduled-agents.mjs';
import {
  COORDINATOR_POLICY_METADATA_KEY,
  operatorLoopRegistrationPolicy,
} from '../modules/agent-bus/coordinator-policy.mjs';

describe('scheduled agents', () => {
  it('validates inject tasks and preserves them across store reload', async () => {
    let saved = null;
    const stateStore = {
      loadSync: () => saved,
      load: async () => saved,
      save: async (data) => { saved = structuredClone(data); },
    };
    const first = buildScheduledAgentStore({ stateStore, now: () => 1000 });
    const created = await first.register({
      id: 'sched_inject_reload',
      type: 'inject',
      targetSession: { kind: 'codex', sessionId: 'session-1' },
      prompt: 'continue',
      intervalSeconds: 15,
      maxIterations: 3,
    });
    assert.equal(created.workDir, undefined);
    assert.equal(created.provider, undefined);

    const reloaded = buildScheduledAgentStore({ stateStore, now: () => 2000 });
    assert.deepEqual(await reloaded.get(created.id), created);
    await assert.rejects(() => first.register({
      type: 'inject', prompt: 'missing target', intervalSeconds: 15, maxIterations: 1,
    }), { code: 'scheduled_agent_target_required' });
    await assert.rejects(() => first.register({
      type: 'inject', targetSession: { kind: 'codex', sessionId: 'session-1' }, prompt: 'missing cap', intervalSeconds: 15,
    }), { code: 'scheduled_agent_max_iterations_invalid' });
    await assert.rejects(() => first.register({
      type: 'inject', targetSession: { kind: 'tmux', sessionId: 'session-1' }, prompt: 'bad kind', intervalSeconds: 15, maxIterations: 1,
    }), { code: 'scheduled_agent_target_kind_invalid' });
  });

  it('defers a busy inject target and advances nextRun without forcing send', async () => {
    const store = memoryStore({ now: () => 1000 });
    await store.register({
      id: 'sched_inject_busy',
      type: 'inject',
      targetSession: { kind: 'codex', sessionId: 'session-busy' },
      prompt: 'continue',
      intervalSeconds: 15,
      maxIterations: 2,
      nextRunAtEpochMs: 1000,
    });
    const launches = [];
    const deps = {
      store,
      lookupSessionState: async () => ({
        lifecycle: 'running',
        capabilities: { canSendNow: false },
      }),
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: 'ignored-launcher-id' };
      },
      maxConsecutiveSkips: 1,
    };

    assert.equal((await stepDue(1000, deps)).tasks[0].action, 'skipped_busy');
    assert.equal((await stepDue(15999, deps)).tasks.length, 0);
    const result = await stepDue(16000, deps);
    const updated = await store.get('sched_inject_busy');

    assert.equal(result.injected, 0);
    assert.equal(result.tasks[0].action, 'skipped_busy');
    assert.equal(updated.currentIteration, 0);
    assert.equal(updated.nextRunAtEpochMs, 31000);
    assert.deepEqual(updated.tickLog.map((entry) => entry.action), ['skipped_busy', 'skipped_busy']);
    assert.equal(launches.length, 0);
  });

  it('uses the canonical canSendNow capability for an inject target', async () => {
    const store = memoryStore({ now: () => 2000 });
    await store.register({
      id: 'sched_inject_ready', type: 'inject',
      targetSession: { kind: 'claude', sessionId: 'session-ready' },
      prompt: 'continue', intervalSeconds: 15, maxIterations: 1,
      nextRunAtEpochMs: 2000,
    });
    const result = await stepDue(2000, {
      store,
      lookupSessionState: async () => ({
        lifecycle: 'running', execution: 'working',
        capabilities: { canSendNow: true },
      }),
      sessionLauncher: async () => ({ id: 'session-ready' }),
    });
    const updated = await store.get('sched_inject_ready');
    assert.equal(result.injected, 1);
    assert.equal(updated.status, 'completed');
    assert.equal(updated.currentIteration, 1);
  });

  it('completes a confirmed-missing inject target but retries transient lookup failures', async () => {
    const store = memoryStore({ now: () => 3000 });
    const input = {
      type: 'inject', targetSession: { kind: 'codex', sessionId: 'gone' },
      prompt: 'continue', intervalSeconds: 15, maxIterations: 2,
      nextRunAtEpochMs: 3000,
    };
    await store.register({ id: 'sched_inject_transient', ...input });
    const transient = await stepDue(3000, {
      store,
      lookupSessionState: async () => { throw new Error('adapter unavailable'); },
      sessionLauncher: async () => { throw new Error('must not inject'); },
    });
    assert.equal(transient.tasks[0].action, 'failed');
    assert.equal((await store.get('sched_inject_transient')).status, 'active');
    await store.cancel('sched_inject_transient');

    await store.register({ id: 'sched_inject_missing', ...input });
    const missing = await stepDue(3000, {
      store,
      lookupSessionState: async () => ({ lifecycle: 'missing', error: 'gone' }),
      sessionLauncher: async () => { throw new Error('must not inject'); },
    });
    const stopped = await store.get('sched_inject_missing');
    assert.equal(missing.completed, 1);
    assert.equal(stopped.status, 'completed');
    assert.equal(stopped.stopReason, 'target_missing');
    assert.equal(stopped.tickLog.at(-1).error, 'gone');
  });

  it('claims concurrent inject ticks once and bounds their tick log at 50', async () => {
    const store = memoryStore({ now: () => 4000 });
    await store.register({
      id: 'sched_inject_claim', type: 'inject',
      targetSession: { kind: 'codex', sessionId: 'session-claim' },
      prompt: 'continue', intervalSeconds: 15, maxIterations: 100,
      nextRunAtEpochMs: 4000,
    });
    let launches = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const deps = {
      store,
      lookupSessionState: async () => ({ capabilities: { canSendNow: true } }),
      sessionLauncher: async () => { launches += 1; await gate; return { id: 'session-claim' }; },
    };
    const steps = [stepDue(4000, deps), stepDue(4000, deps)];
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await Promise.all(steps);
    assert.equal(launches, 1);

    for (let index = 0; index < 55; index += 1) {
      await store.update('sched_inject_claim', { nextRunAtEpochMs: 5000 });
      await stepDue(5000, {
        store,
        lookupSessionState: async () => ({ capabilities: { canSendNow: false } }),
        sessionLauncher: async () => { throw new Error('must not inject'); },
      });
    }
    const updated = await store.get('sched_inject_claim');
    assert.equal(updated.tickLog.length, 50);
    assert.equal(updated.tickLog.every((entry) => entry.action === 'skipped_busy'), true);
    assert.equal((await store.cancel(updated.id)).status, 'canceled');
  });

  it('spawns a due task once, advances nextRun, and increments iteration', async () => {
    const store = memoryStore({ now: () => 1000 });
    const task = await store.register(baseTask({ id: 'sched_due', intervalSeconds: 15 }));
    const launches = [];

    const result = await stepDue(1000, {
      store,
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: 'sess_1' };
      },
      lookupSessionState: async () => null,
    });

    const updated = await store.get(task.id);
    assert.equal(result.checked, 1);
    assert.equal(result.spawned, 1);
    assert.equal(result.skippedRunning, 0);
    assert.equal(updated.currentIteration, 1);
    assert.equal(updated.lastSessionId, 'sess_1');
    assert.equal(updated.nextRunAtEpochMs, 16000);
    assert.equal(updated.status, 'active');
    assert.deepEqual(launches, [{
      prompt: 'run report',
      workDir: '/tmp/work',
      provider: 'codex',
      model: null,
      displayName: 'Scheduled sched_due #1',
      parentThreadId: null,
      taskId: 'sched_due',
    }]);
  });

  it('marks maxIterations-reached tasks completed without spawning', async () => {
    const store = memoryStore({ now: () => 2000 });
    await store.register(baseTask({
      id: 'sched_done',
      maxIterations: 2,
      currentIteration: 2,
      nextRunAtEpochMs: 2000,
    }));
    const launches = [];

    const result = await stepDue(2000, {
      store,
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: 'sess_unwanted' };
      },
      lookupSessionState: async () => null,
    });

    assert.equal(result.checked, 1);
    assert.equal(result.spawned, 0);
    assert.equal(result.completed, 1);
    assert.equal(launches.length, 0);
    assert.equal((await store.get('sched_done')).status, 'completed');
  });

  it('skips while the last session is non-terminal and still advances nextRun', async () => {
    const store = memoryStore({ now: () => 3000 });
    await store.register(baseTask({
      id: 'sched_running',
      intervalSeconds: 15,
      nextRunAtEpochMs: 3000,
      lastSessionId: 'sess_running',
    }));

    const result = await stepDue(3000, {
      store,
      sessionLauncher: async () => {
        throw new Error('should not spawn');
      },
      lookupSessionState: async () => ({
        status: 'working',
        capabilities: { autoClose: false },
      }),
    });

    const updated = await store.get('sched_running');
    assert.equal(result.spawned, 0);
    assert.equal(result.skippedRunning, 1);
    assert.equal(updated.currentIteration, 0);
    assert.equal(updated.nextRunAtEpochMs, 18000);
    assert.equal(updated.lastSessionId, 'sess_running');
  });

  it('claims a due run before launch so concurrent steps spawn once', async () => {
    const store = memoryStore({ now: () => 3600 });
    await store.register(baseTask({
      id: 'sched_concurrent',
      intervalSeconds: 15,
      nextRunAtEpochMs: 3600,
    }));
    const launches = [];
    let releaseLaunch;
    const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });

    const steps = Array.from({ length: 5 }, () => stepDue(3600, {
      store,
      sessionLauncher: async (input) => {
        launches.push(input);
        await launchGate;
        return { id: `sess_${launches.length}` };
      },
      lookupSessionState: async () => null,
    }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseLaunch();
    const results = await Promise.all(steps);

    const updated = await store.get('sched_concurrent');
    assert.equal(launches.length, 1);
    assert.equal(results.reduce((total, result) => total + result.spawned, 0), 1);
    assert.equal(results.reduce((total, result) => total + result.tasks.filter((task) => task.action === 'claimSkipped').length, 0), 4);
    assert.equal(updated.currentIteration, 1);
    assert.equal(updated.lastSessionId, 'sess_1');
    assert.equal(updated.metadata.runClaim, undefined);
  });

  it('claims a due run once across independent file-backed stores', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-scheduled-agents-'));
    try {
      const storeA = buildScheduledAgentStore({
        storeFile: join(dir, 'scheduled_agents.json'),
        env: { APP_STATE_STORAGE: 'file' },
        now: () => 3800,
      });
      const storeB = buildScheduledAgentStore({
        storeFile: join(dir, 'scheduled_agents.json'),
        env: { APP_STATE_STORAGE: 'file' },
        now: () => 3800,
      });
      await storeA.register(baseTask({
        id: 'sched_file_concurrent',
        intervalSeconds: 15,
        nextRunAtEpochMs: 3800,
      }));
      const launches = [];
      let releaseLaunch;
      const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });

      const steps = [storeA, storeB].map((store) => stepDue(3800, {
        store,
        sessionLauncher: async (input) => {
          launches.push(input);
          await launchGate;
          return { id: `sess_file_${launches.length}` };
        },
        lookupSessionState: async () => null,
      }));
      await new Promise((resolve) => setTimeout(resolve, 10));
      releaseLaunch();
      const results = await Promise.all(steps);

      assert.equal(launches.length, 1);
      assert.equal(results.reduce((total, result) => total + result.spawned, 0), 1);
      assert.equal(results.reduce((total, result) => total + result.tasks.filter((task) => task.action === 'claimSkipped').length, 0), 1);
      assert.equal((await storeA.get('sched_file_concurrent')).metadata.runClaim, undefined);
      await storeA.close();
      await storeB.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('retries a due run after an expired claim lease', async () => {
    const store = memoryStore({ now: () => 3900 });
    await store.register(baseTask({
      id: 'sched_expired_claim',
      intervalSeconds: 15,
      nextRunAtEpochMs: 3900,
    }));
    const claim = await store.claimRun('sched_expired_claim', {
      expectedNextRunAtEpochMs: 3900,
      nowMs: 3900,
      leaseMs: 1000,
    });
    assert.ok(claim);
    assert.equal((await store.get('sched_expired_claim')).nextRunAtEpochMs, 3900);

    const launches = [];
    const result = await stepDue(5000, {
      store,
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: 'sess_after_expired_claim' };
      },
      lookupSessionState: async () => null,
    });

    const updated = await store.get('sched_expired_claim');
    assert.equal(result.spawned, 1);
    assert.equal(launches.length, 1);
    assert.equal(updated.lastSessionId, 'sess_after_expired_claim');
    assert.equal(updated.metadata.runClaim, undefined);
  });

  it('does not run overlapping SchedulerLoop ticks', async () => {
    const store = memoryStore({ now: () => 3700 });
    await store.register(baseTask({
      id: 'sched_loop_overlap',
      intervalSeconds: 15,
      nextRunAtEpochMs: 3700,
    }));
    const launches = [];
    let releaseLaunch;
    const launchGate = new Promise((resolve) => { releaseLaunch = resolve; });
    const loop = new SchedulerLoop({
      config: { enabled: true, tickIntervalSec: 1 },
      store,
      now: () => 3700,
      sessionLauncher: async (input) => {
        launches.push(input);
        await launchGate;
        return { id: 'sess_loop' };
      },
      lookupSessionState: async () => null,
      logger: { warn() {} },
    });

    const first = loop.step();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await loop.step();
    releaseLaunch();
    const firstResult = await first;

    assert.equal(second.skippedOverlap, 1);
    assert.equal(firstResult.spawned, 1);
    assert.equal(launches.length, 1);
  });

  it('launches the next tick when the prior session is idle at a free-text prompt', async () => {
    const store = memoryStore({ now: () => 3000 });
    await store.register(baseTask({
      id: 'sched_idle',
      intervalSeconds: 15,
      nextRunAtEpochMs: 3000,
      lastSessionId: 'sess_idle',
      lastSpawnAtEpochMs: 1000,
    }));

    const result = await stepDue(3000, {
      store,
      sessionLauncher: async () => ({ id: 'sess_next' }),
      idleSessionGraceMs: 1000,
      lookupSessionState: async () => ({
        state: 'waiting_for_input',
        status: 'ready',
        lifecycle: 'running',
        execution: 'idle',
        interaction: { kind: 'free_text' },
        updatedAt: 1500,
        capabilities: { canSendNow: true, autoClose: true },
      }),
    });

    const updated = await store.get('sched_idle');
    assert.equal(result.spawned, 1);
    assert.equal(result.skippedRunning, 0);
    assert.equal(result.tasks[0].launchedOverLiveSession, 'idle');
    assert.equal(updated.currentIteration, 1);
    assert.equal(updated.lastSessionId, 'sess_next');
    assert.equal(updated.lastSpawnAtEpochMs, 3000);
  });

  it("treats an unstable idle prompt (status 'unknown') as a finished tick", async () => {
    // A slow poller never lands two pane captures inside the 5s freshness window, so the
    // canonical snapshot of an idle pane is status 'unknown', not 'ready'.
    const store = memoryStore({ now: () => 300000 });
    await store.register(baseTask({
      id: 'sched_unstable',
      intervalSeconds: 15,
      nextRunAtEpochMs: 300000,
      lastSessionId: 'sess_unstable',
      lastSpawnAtEpochMs: 1000,
    }));

    const result = await stepDue(300000, {
      store,
      sessionLauncher: async () => ({ id: 'sess_next' }),
      lookupSessionState: async () => ({
        state: 'unknown',
        status: 'unknown',
        lifecycle: 'running',
        execution: 'idle',
        interaction: { kind: 'free_text' },
        capabilities: { canSendNow: false },
      }),
    });

    assert.equal(result.spawned, 1);
    assert.equal(result.tasks[0].launchedOverLiveSession, 'idle');
  });

  it('keeps skipping while the prior session is idle inside the grace window', async () => {
    const store = memoryStore({ now: () => 3000 });
    await store.register(baseTask({
      id: 'sched_idle_fresh',
      intervalSeconds: 15,
      nextRunAtEpochMs: 3000,
      lastSessionId: 'sess_idle_fresh',
      lastSpawnAtEpochMs: 2900,
    }));

    const result = await stepDue(3000, {
      store,
      sessionLauncher: async () => {
        throw new Error('should not spawn');
      },
      idleSessionGraceMs: 1000,
      lookupSessionState: async () => ({
        status: 'ready',
        lifecycle: 'running',
        execution: 'idle',
        interaction: { kind: 'free_text' },
        updatedAt: 2950,
        capabilities: { canSendNow: true },
      }),
    });

    assert.equal(result.spawned, 0);
    assert.equal(result.skippedRunning, 1);
    assert.equal((await store.get('sched_idle_fresh')).currentIteration, 0);
  });

  it('still skips while the prior session is blocked on a prompt', async () => {
    const store = memoryStore({ now: () => 3000 });
    await store.register(baseTask({
      id: 'sched_blocked',
      intervalSeconds: 15,
      nextRunAtEpochMs: 3000,
      lastSessionId: 'sess_blocked',
    }));

    const result = await stepDue(3000, {
      store,
      sessionLauncher: async () => {
        throw new Error('should not spawn');
      },
      lookupSessionState: async () => ({
        status: 'blocked',
        lifecycle: 'running',
        execution: 'idle',
        interaction: { kind: 'approval' },
        updatedAt: 100,
        capabilities: { canSendNow: false },
      }),
    });

    assert.equal(result.spawned, 0);
    assert.equal(result.skippedRunning, 1);
    assert.equal((await store.get('sched_blocked')).consecutiveSkips, 1);
  });

  it('spawns anyway once a live session has suppressed the skip cap of ticks', async () => {
    const store = memoryStore({ now: () => 3000 });
    await store.register(baseTask({
      id: 'sched_wedged',
      intervalSeconds: 15,
      nextRunAtEpochMs: 3000,
      lastSessionId: 'sess_wedged',
      consecutiveSkips: 2,
    }));
    const workingState = {
      status: 'working',
      lifecycle: 'running',
      execution: 'working',
      interaction: { kind: 'none' },
      capabilities: { canSendNow: false },
    };

    const skipped = await stepDue(3000, {
      store,
      sessionLauncher: async () => {
        throw new Error('should not spawn');
      },
      maxConsecutiveSkips: 3,
      lookupSessionState: async () => workingState,
    });
    assert.equal(skipped.skippedRunning, 1);
    assert.equal((await store.get('sched_wedged')).consecutiveSkips, 3);

    const forced = await stepDue(18000, {
      store,
      sessionLauncher: async () => ({ id: 'sess_forced' }),
      maxConsecutiveSkips: 3,
      lookupSessionState: async () => workingState,
    });
    const updated = await store.get('sched_wedged');
    assert.equal(forced.spawned, 1);
    assert.equal(forced.tasks[0].launchedOverLiveSession, 'skipCap');
    assert.equal(updated.consecutiveSkips, 0);
    assert.equal(updated.lastSessionId, 'sess_forced');
  });

  it('skips indefinitely when the skip cap is disabled', async () => {
    const store = memoryStore({ now: () => 3000 });
    await store.register(baseTask({
      id: 'sched_uncapped',
      intervalSeconds: 15,
      nextRunAtEpochMs: 3000,
      lastSessionId: 'sess_uncapped',
      consecutiveSkips: 99,
    }));

    const result = await stepDue(3000, {
      store,
      sessionLauncher: async () => {
        throw new Error('should not spawn');
      },
      maxConsecutiveSkips: 0,
      lookupSessionState: async () => ({ status: 'working', lifecycle: 'running', execution: 'working' }),
    });

    assert.equal(result.spawned, 0);
    assert.equal(result.skippedRunning, 1);
  });

  it('launches after the canonical snapshot reports the prior session ended', async () => {
    const store = memoryStore({ now: () => 4000 });
    await store.register(baseTask({
      id: 'sched_ended',
      nextRunAtEpochMs: 4000,
      lastSessionId: 'sess_ended',
    }));

    const result = await stepDue(4000, {
      store,
      sessionLauncher: async () => ({ id: 'sess_next' }),
      lookupSessionState: async () => ({
        status: 'ended',
        capabilities: { autoClose: true },
      }),
    });

    assert.equal(result.spawned, 1);
    assert.equal((await store.get('sched_ended')).lastSessionId, 'sess_next');
  });

  it('ignores not-yet-due tasks', async () => {
    const store = memoryStore({ now: () => 4000 });
    await store.register(baseTask({
      id: 'sched_later',
      nextRunAtEpochMs: 9000,
    }));

    const result = await stepDue(4000, {
      store,
      sessionLauncher: async () => {
        throw new Error('should not spawn');
      },
      lookupSessionState: async () => null,
    });

    assert.equal(result.checked, 0);
    assert.equal(result.spawned, 0);
    assert.equal((await store.get('sched_later')).currentIteration, 0);
  });

  it('cancels tasks and stepDue ignores them', async () => {
    const store = memoryStore({ now: () => 5000 });
    await store.register(baseTask({
      id: 'sched_cancel',
      nextRunAtEpochMs: 5000,
    }));
    await store.cancel('sched_cancel');

    const result = await stepDue(5000, {
      store,
      sessionLauncher: async () => {
        throw new Error('should not spawn');
      },
      lookupSessionState: async () => null,
    });

    assert.equal(result.checked, 0);
    assert.equal((await store.get('sched_cancel')).status, 'canceled');
  });

  it('catches up missed intervals until nextRun is past now', async () => {
    const store = memoryStore({ now: () => 6000 });
    await store.register(baseTask({
      id: 'sched_catchup',
      intervalSeconds: 15,
      nextRunAtEpochMs: 1000,
    }));

    const result = await stepDue(70000, {
      store,
      sessionLauncher: async () => ({ sessionId: 'sess_catchup' }),
      lookupSessionState: async () => null,
    });

    const updated = await store.get('sched_catchup');
    assert.equal(result.spawned, 1);
    assert.equal(updated.nextRunAtEpochMs, 76000);
    assert.equal(updated.nextRunAtEpochMs > 70000, true);
    assert.equal(updated.lastSessionId, 'sess_catchup');
  });

  it('accepts daily scheduled agent intervals', async () => {
    const store = memoryStore({ now: () => 8000 });
    const task = await store.register(baseTask({
      id: 'sched_daily',
      intervalSeconds: 86400,
      startImmediately: false,
    }));

    assert.equal(task.intervalSeconds, 86400);
    assert.equal(task.nextRunAtEpochMs, 86408000);
  });
});

describe('scheduled agents MCP tools', () => {
  it('creates loop sessions and enforces iteration caps at the MCP boundary', async () => {
    const bodies = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        assert.equal(path, '/api/agents/scheduled');
        bodies.push(opts.body);
        return { id: 'sched_loop_mcp', ...opts.body };
      },
    });
    const created = await server.handleToolCall('spawn_loop_session', {
      kind: 'codex', session_id: 'session-1', prompt: 'continue',
      interval_seconds: 15, max_iterations: 100, title: 'Review loop',
    });
    assert.equal(created.id, 'sched_loop_mcp');
    assert.equal(created.prompt, undefined);
    assert.deepEqual(bodies[0].targetSession, { kind: 'codex', sessionId: 'session-1' });
    await assert.rejects(() => server.handleToolCall('spawn_loop_session', {
      kind: 'codex', session_id: 'session-1', prompt: 'continue', interval_seconds: 15,
    }), /max_iterations/);
    await assert.rejects(() => server.handleToolCall('spawn_loop_session', {
      kind: 'codex', session_id: 'session-1', prompt: 'continue',
      interval_seconds: 15, max_iterations: 101,
    }), /max_iterations/);
    assert.equal(bodies.length, 1);
  });

  it('registers, lists, and cancels scheduled agents through monitor MCP', async () => {
    const requests = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        requests.push({ path, opts });
        if (path === '/api/agents/scheduled' && opts.method === 'POST') {
          return {
            id: 'sched_mcp',
            workDir: opts.body.workDir,
            prompt: opts.body.prompt,
            provider: opts.body.provider || 'codex',
            model: null,
            intervalSeconds: opts.body.intervalSeconds,
            maxIterations: opts.body.maxIterations,
            parentThreadId: null,
            status: 'active',
            currentIteration: 0,
            nextRunAtEpochMs: 1000,
            lastSessionId: null,
            createdAt: 1000,
            updatedAt: 1000,
          };
        }
        if (path === '/api/agents/scheduled' && !opts.method) {
          return { taskCount: 1, tasks: [{ id: 'sched_mcp', status: 'active' }] };
        }
        if (path === '/api/agents/scheduled/sched_mcp/cancel' && opts.method === 'POST') {
          return { id: 'sched_mcp', status: 'canceled' };
        }
        throw new Error(`Unexpected request: ${path}`);
      },
    });

    const registered = await server.handleToolCall('register_scheduled_agent', {
      workDir: '/tmp/work',
      prompt: 'run',
      intervalSeconds: 30,
      maxIterations: 2,
    });
    const listed = await server.handleToolCall('list_scheduled_agents', {});
    const canceled = await server.handleToolCall('cancel_scheduled_agent', { id: 'sched_mcp' });

    assert.equal(registered.id, 'sched_mcp');
    assert.equal(registered.workDir, undefined);
    assert.equal(listed.total, 1);
    assert.equal(canceled.status, 'canceled');
    assert.deepEqual(requests.map((entry) => [entry.path, entry.opts.method || 'GET']), [
      ['/api/agents/scheduled', 'POST'],
      ['/api/agents/scheduled', 'GET'],
      ['/api/agents/scheduled/sched_mcp/cancel', 'POST'],
    ]);
  });

  it('accepts snake_case and camelCase scheduled-agent inputs', async () => {
    const bodies = [];
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        if (path !== '/api/agents/scheduled' || opts.method !== 'POST') throw new Error('unexpected request');
        bodies.push(opts.body);
        return {
          id: `sched_${bodies.length}`,
          workDir: opts.body.workDir || opts.body.work_dir,
          prompt: opts.body.prompt,
          provider: 'codex',
          model: null,
          intervalSeconds: opts.body.intervalSeconds ?? opts.body.interval_seconds,
          maxIterations: opts.body.maxIterations ?? opts.body.max_iterations,
          parentThreadId: opts.body.parentThreadId ?? opts.body.parent_thread_id ?? null,
          status: 'active',
          currentIteration: 0,
          nextRunAtEpochMs: 1000,
          lastSessionId: null,
          createdAt: 1000,
          updatedAt: 1000,
        };
      },
    });

    const camel = await server.handleToolCall('register_scheduled_agent', {
      workDir: '/tmp/camel',
      prompt: 'camel',
      intervalSeconds: 60,
      parentThreadId: 'thr_camel',
    });
    const snake = await server.handleToolCall('register_scheduled_agent', {
      work_dir: '/tmp/snake',
      prompt: 'snake',
      interval_seconds: 45,
      parent_thread_id: 'thr_snake',
    });

    assert.equal(bodies[0].intervalSeconds, 60);
    assert.equal(bodies[0].parentThreadId, 'thr_camel');
    assert.equal(bodies[1].interval_seconds, 45);
    assert.equal(bodies[1].parent_thread_id, 'thr_snake');
    assert.equal(bodies[0].workDir, '/tmp/camel');
    assert.equal(bodies[1].work_dir, '/tmp/snake');
  });

  it('steps scheduled agents through MCP and returns summary keys', async () => {
    const server = buildMonitorMcpServer({
      async requestImpl(path, opts = {}) {
        assert.equal(path, '/api/agents/scheduled/step-now');
        assert.equal(opts.method, 'POST');
        return { checked: 1, spawned: 1, skippedRunning: 0, completed: 0, tasks: [{ id: 'sched_step', action: 'spawned' }] };
      },
    });

    const result = await server.handleToolCall('monitor_step_scheduled_agents', {});
    assert.deepEqual(result, { results: [{ id: 'sched_step', session_id: undefined, status: 'spawned' }] });
  });
});

describe('scheduled agents routes', () => {
  it('starts no pump timer when disabled while manual step-now still injects', async () => {
    const app = Fastify({ logger: false });
    const store = memoryStore({ now: () => 1000 });
    let injections = 0;
    const lookupSessionState = async () => ({ capabilities: { canSendNow: true } });
    const sessionLauncher = async () => { injections += 1; return { id: 'target-disabled' }; };
    const loop = new SchedulerLoop({
      config: { enabled: false, tickIntervalSec: 1 }, store, now: () => 1000,
      lookupSessionState, sessionLauncher,
    });
    await app.register(scheduledAgentsPlugin, {
      store,
      loop,
      config: { enabled: false, tickIntervalSec: 1 },
      rootConfig: {
        dependencyWatch: { repoPaths: {} }, fleet: { repoPaths: {} }, githubAgents: { repoPaths: {} },
      },
      now: () => 1000,
      lookupSessionState,
      sessionLauncher,
    });
    assert.equal(loop.timer, null);
    await store.register({
      id: 'sched_disabled_manual', type: 'inject',
      targetSession: { kind: 'codex', sessionId: 'target-disabled' },
      prompt: 'manual tick', intervalSeconds: 15, maxIterations: 1,
      nextRunAtEpochMs: 1000,
    });
    const step = await app.inject({ method: 'POST', url: '/api/agents/scheduled/step-now' });
    assert.equal(step.statusCode, 200);
    assert.equal(step.json().injected, 1);
    assert.equal(injections, 1);
    assert.equal(loop.timer, null);
    await app.close();
  });

  it('allows an authenticated agent to register an inject loop with stamped authority', async () => {
    const store = memoryStore({ now: () => 1000 });
    const app = await buildScheduledRoutesApp({
      store,
      authContext: {
        authenticated: true,
        principal: { type: 'agent', kind: 'codex', sessionId: 'loop-owner' },
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/scheduled',
      payload: {
        type: 'inject',
        targetSession: { kind: 'claude', sessionId: 'target-1' },
        prompt: 'continue', intervalSeconds: 15, maxIterations: 4,
        metadata: { title: 'Loop title', forged: true },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().type, 'inject');
    assert.deepEqual(response.json().targetSession, { kind: 'claude', sessionId: 'target-1' });
    assert.equal(response.json().metadata.title, 'Loop title');
    assert.equal(response.json().metadata.forged, undefined);
    assert.equal(response.json().metadata.loopRegistration.parentSessionId, 'loop-owner');
    assert.deepEqual(response.json().tickLog, []);
    await app.close();
  });

  it('registers an ordinary Dueno child loop only inside the parent work directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-child-loop-'));
    const workDir = join(root, 'worktree');
    const outside = await mkdtemp(join(tmpdir(), 'dueno-child-loop-outside-'));
    await mkdir(workDir);
    const store = memoryStore({ now: () => 1000 });
    const app = await buildScheduledRoutesApp({
      store,
      authContext: {
        authenticated: true,
        legacyUntrusted: false,
        principal: { type: 'agent', kind: 'codex', sessionId: 'ordinary-dueno' },
      },
    });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/agents/scheduled',
        payload: {
          workDir,
          prompt: 'bounded child loop',
          mcpProfile: 'dueno',
          mcpServers: { add: ['seodata', 'fetch'], remove: [] },
        },
      });
      assert.equal(created.statusCode, 200, created.body);
      assert.equal(created.json().workDir, workDir);
      assert.equal(created.json().metadata.loopRegistration.issuedBy, 'fleet-session-launch');
      assert.equal((await store.get(created.json().id)).mcpProfile, 'dueno');
      assert.deepEqual((await store.get(created.json().id)).mcpServers, {
        add: ['seodata', 'fetch'],
        remove: [],
      });

      const other = await app.inject({
        method: 'POST',
        url: '/api/agents/scheduled',
        payload: { workDir: outside, prompt: 'escape' },
      });
      assert.equal(other.statusCode, 200, other.body);
    } finally {
      await app.close();
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  it('server-stamps a fenced coordinator profile for an operator-delegated agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-delegated-loop-'));
    const workDir = join(root, 'worktree');
    await mkdir(workDir);
    const authContext = {
      authenticated: true,
      legacyUntrusted: false,
      principal: { type: 'agent', kind: 'codex', sessionId: 'operator-directed' },
      loopRegistrationPolicy: operatorLoopRegistrationPolicy({
        type: 'ui', kind: 'dashboard', sessionId: 'browser',
      }),
    };
    const launches = [];
    const app = await buildScheduledRoutesApp({
      authContext,
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: 'sess_delegated' };
      },
    });
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/api/agents/scheduled',
        payload: {
          workDir,
          prompt: 'coordinate',
          intervalSeconds: 30,
          controlProfile: 'coordinator-v1',
          coordinator: {
            policyId: 'protocol-first-v1',
            repositories: ['octocat/dueno-fleet', 'octocat/BusinessOS'],
            projectRoots: [root],
            protectedSessionIds: ['e0275de9'],
          },
          id: 'sched_forged',
          status: 'paused',
          currentIteration: 9,
          lastSessionId: 'sess_hijack',
          metadata: { coordinatorControlPolicy: { policyId: 'forged' } },
        },
      });
      assert.equal(created.statusCode, 200, created.body);
      const task = created.json();
      assert.equal(task.metadata[COORDINATOR_POLICY_METADATA_KEY].policyId, 'protocol-first-v1');
      assert.deepEqual(task.metadata[COORDINATOR_POLICY_METADATA_KEY].repositories, [
        'octocat/dueno-fleet', 'octocat/businessos',
      ]);
      assert.equal(task.metadata.loopRegistration.issuedBy, 'authenticated-operator');
      assert.equal(task.id.startsWith('sched_'), true);
      assert.notEqual(task.id, 'sched_forged');
      assert.equal(task.status, 'active');
      assert.equal(task.currentIteration, 0);
      assert.equal(task.lastSessionId, null);

      const step = await app.inject({ method: 'POST', url: '/api/agents/scheduled/step-now' });
      assert.equal(step.statusCode, 200);
      assert.equal(launches.length, 1);
      assert.deepEqual(
        launches[0].trustedCoordinatorMetadata[COORDINATOR_POLICY_METADATA_KEY],
        task.metadata[COORDINATOR_POLICY_METADATA_KEY],
      );
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects scheduled-loop registration from an agent without operator delegation', async () => {
    const app = await buildScheduledRoutesApp({
      authContext: {
        authenticated: true,
        principal: { type: 'agent', kind: 'codex', sessionId: 'ordinary' },
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/api/agents/scheduled',
      payload: { ...baseTask(), controlProfile: 'coordinator-v1' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().reason, 'loop_registration_delegation_missing');
    await app.close();
  });

  it('registers, lists, cancels, and steps scheduled agents with injected deps', async () => {
    const launches = [];
    const app = await buildScheduledRoutesApp({
      now: () => 1000,
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: 'sess_route' };
      },
      lookupSessionState: async () => null,
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/agents/scheduled',
      payload: {
        work_dir: '/tmp/route',
        prompt: 'route prompt',
        interval_seconds: 15,
        max_iterations: 1,
      },
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().workDir, '/tmp/route');

    const list = await app.inject({ method: 'GET', url: '/api/agents/scheduled' });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().taskCount, 1);

    const step = await app.inject({ method: 'POST', url: '/api/agents/scheduled/step-now' });
    assert.equal(step.statusCode, 200);
    assert.equal(step.json().spawned, 1);
    assert.equal(step.json().completed, 1);
    assert.equal(launches[0].prompt, 'route prompt');

    const canceled = await app.inject({
      method: 'POST',
      url: `/api/agents/scheduled/${created.json().id}/cancel`,
    });
    assert.equal(canceled.statusCode, 200);
    assert.equal(canceled.json().status, 'canceled');
    await app.close();
  });

  it('returns 404 for missing scheduled-agent cancel ids', async () => {
    const app = await buildScheduledRoutesApp();
    const res = await app.inject({ method: 'POST', url: '/api/agents/scheduled/missing/cancel' });

    assert.equal(res.statusCode, 404);
    assert.equal(res.json().code, 'scheduled_agent_not_found');
    await app.close();
  });

  it('sets up and runs the fleet hygiene audit scheduled agent', async () => {
    const launches = [];
    let nowMs = 10_000;
    const app = await buildScheduledRoutesApp({
      now: () => nowMs,
      rootConfig: {
        fleet: {
          repoPaths: {
            app: { primary: '/repo/app', companions: ['/repo/shared'] },
          },
        },
        githubAgents: {
          repoPaths: { 'octo/demo': '/repo/github-demo' },
          provider: 'codex',
          model: 'gpt-5.5',
        },
      },
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: 'sess_hygiene' };
      },
      lookupSessionState: async () => null,
    });

    const initial = await app.inject({ method: 'GET', url: '/api/fleet/hygiene-audit' });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().configured, false);
    assert.equal(initial.json().repoCount, 3);

    const setup = await app.inject({ method: 'POST', url: '/api/fleet/hygiene-audit/setup' });
    assert.equal(setup.statusCode, 200);
    assert.equal(setup.json().configured, true);
    assert.equal(setup.json().task.id, 'sched_fleet_hygiene_biweekly');
    assert.equal(setup.json().task.intervalSeconds, 1209600);
    assert.equal(setup.json().task.workDir, '/repo/app');
    assert.match(setup.json().task.prompt, /\/repo\/shared/);

    nowMs = 20_000;
    const run = await app.inject({ method: 'POST', url: '/api/fleet/hygiene-audit/run-now' });
    assert.equal(run.statusCode, 200);
    assert.equal(run.json().step.spawned, 1);
    assert.equal(run.json().task.lastSessionId, 'sess_hygiene');
    assert.equal(launches[0].workDir, '/repo/app');
    assert.equal(launches[0].model, 'gpt-5.5');
    assert.match(launches[0].prompt, /Biweekly fleet hygiene audit/);
    assert.match(launches[0].prompt, /fetch and check origin\/main/);
    assert.match(launches[0].prompt, /local-checkout drift/);
    assert.match(launches[0].prompt, /For small findings, fix them yourself, commit, and push to main\/master as relevant/);
    await app.close();
  });

  it('does not inherit an incompatible githubAgents model onto a hygiene provider override', async () => {
    const launches = [];
    const app = await buildScheduledRoutesApp({
      now: () => 10_000,
      rootConfig: {
        fleet: { repoPaths: { app: '/repo/app' } },
        fleetHygiene: { provider: 'codex' },
        githubAgents: {
          repoPaths: {},
          provider: 'xai',
          model: 'grok-4.6',
        },
      },
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: 'sess_hygiene_pair' };
      },
      lookupSessionState: async () => null,
    });

    const setup = await app.inject({ method: 'POST', url: '/api/fleet/hygiene-audit/setup' });
    assert.equal(setup.statusCode, 200);
    assert.equal(setup.json().task.provider, 'codex');
    assert.equal(setup.json().task.model, 'gpt-6.1-sol');

    const run = await app.inject({ method: 'POST', url: '/api/fleet/hygiene-audit/run-now' });
    assert.equal(run.statusCode, 200);
    assert.equal(launches[0].provider, 'codex');
    assert.equal(launches[0].model, 'gpt-6.1-sol');
    await app.close();
  });

  it('inherits githubAgents.provider onto a hygiene model-only override', async () => {
    const launches = [];
    const app = await buildScheduledRoutesApp({
      now: () => 10_000,
      rootConfig: {
        fleet: { repoPaths: { app: '/repo/app' } },
        fleetHygiene: { model: 'grok-4.6' },
        githubAgents: {
          repoPaths: {},
          provider: 'xai',
          model: 'grok-4.3',
        },
      },
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: 'sess_hygiene_model_only' };
      },
      lookupSessionState: async () => null,
    });

    const setup = await app.inject({ method: 'POST', url: '/api/fleet/hygiene-audit/setup' });
    assert.equal(setup.statusCode, 200);
    assert.equal(setup.json().task.provider, 'xai');
    assert.equal(setup.json().task.model, 'grok-4.6');

    const run = await app.inject({ method: 'POST', url: '/api/fleet/hygiene-audit/run-now' });
    assert.equal(run.statusCode, 200);
    assert.equal(launches[0].provider, 'xai');
    assert.equal(launches[0].model, 'grok-4.6');
    await app.close();
  });

  it('migrates legacy daily fleet hygiene state to the biweekly task', async () => {
    const nowMs = 50_000;
    const store = memoryStore({ now: () => nowMs });
    await store.register(baseTask({
      id: 'sched_fleet_hygiene_daily',
      intervalSeconds: 86400,
      currentIteration: 7,
      nextRunAtEpochMs: 123_456,
      lastSessionId: 'sess_legacy_hygiene',
      metadata: { branchHeads: { '/repo/app#origin/main': 'abc123' } },
    }));
    const app = await buildScheduledRoutesApp({
      now: () => nowMs,
      store,
      rootConfig: {
        fleet: { repoPaths: { app: '/repo/app' } },
        githubAgents: { repoPaths: {} },
      },
    });

    const before = await app.inject({ method: 'GET', url: '/api/fleet/hygiene-audit' });
    assert.equal(before.json().task.id, 'sched_fleet_hygiene_daily');

    const setup = await app.inject({ method: 'POST', url: '/api/fleet/hygiene-audit/setup' });
    assert.equal(setup.json().task.id, 'sched_fleet_hygiene_biweekly');
    assert.equal(setup.json().task.intervalSeconds, 1209600);
    assert.equal(setup.json().task.currentIteration, 7);
    assert.equal(setup.json().task.nextRunAtEpochMs, 123_456);
    assert.equal(setup.json().task.lastSessionId, 'sess_legacy_hygiene');
    assert.deepEqual(setup.json().task.metadata.branchHeads, { '/repo/app#origin/main': 'abc123' });
    assert.equal((await store.get('sched_fleet_hygiene_daily')).status, 'canceled');
    await app.close();
  });

  it('skips the fleet hygiene audit when origin main and master heads are unchanged', async () => {
    const launches = [];
    let nowMs = 10_000;
    const gitCalls = [];
    const app = await buildScheduledRoutesApp({
      now: () => nowMs,
      rootConfig: {
        fleet: { repoPaths: { app: '/repo/app' } },
        githubAgents: { repoPaths: {} },
      },
      gitRunner: async (cwd, args) => {
        gitCalls.push([cwd, args]);
        if (args.join(' ') === 'rev-parse --show-toplevel') return '/repo/app';
        if (args.join(' ') === 'fetch --quiet origin') return '';
        if (args.join(' ') === 'rev-parse --verify refs/remotes/origin/main') return 'abc123';
        if (args.join(' ') === 'rev-parse --verify refs/remotes/origin/master') return '';
        return '';
      },
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: `sess_hygiene_${launches.length}` };
      },
      lookupSessionState: async () => null,
    });

    await app.inject({ method: 'POST', url: '/api/fleet/hygiene-audit/setup' });
    const first = await app.inject({ method: 'POST', url: '/api/fleet/hygiene-audit/run-now' });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().step.spawned, 1);
    assert.equal(launches.length, 1);
    assert.equal(first.json().task.metadata.branchHeads['/repo/app#origin/main'], 'abc123');

    nowMs = 20_000;
    const second = await app.inject({ method: 'POST', url: '/api/fleet/hygiene-audit/run-now' });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().step.spawned, 0);
    assert.equal(second.json().step.tasks[0].action, 'skippedNoMainChanges');
    assert.equal(launches.length, 1);
    assert.equal(gitCalls.some(([, args]) => args.join(' ') === 'fetch --quiet origin'), true);
    await app.close();
  });

  it('sets up and runs the dependency watch scheduled agent', async () => {
    const launches = [];
    const app = await buildScheduledRoutesApp({
      now: () => 30_000,
      rootConfig: {
        dependencyWatch: {
          repoPaths: {
            BusinessOS: '/repo/businessos',
            'example-app': '/repo/example-app',
          },
          provider: 'codex',
          model: 'gpt-5.5',
          intervalSeconds: 1296000,
        },
        fleet: { repoPaths: {} },
        githubAgents: { repoPaths: {} },
      },
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: 'sess_deps' };
      },
      lookupSessionState: async () => null,
    });

    const initial = await app.inject({ method: 'GET', url: '/api/fleet/dependency-watch' });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().configured, false);
    assert.equal(initial.json().repoCount, 2);

    const setup = await app.inject({ method: 'POST', url: '/api/fleet/dependency-watch/setup' });
    assert.equal(setup.statusCode, 200);
    assert.equal(setup.json().configured, true);
    assert.equal(setup.json().task.workDir, '/repo/businessos');
    assert.equal(setup.json().task.model, 'gpt-5.5');
    assert.equal(setup.json().task.intervalSeconds, 1296000);
    assert.match(setup.json().task.prompt, /patch notes/);
    assert.match(setup.json().task.prompt, /API changelogs/);

    const run = await app.inject({ method: 'POST', url: '/api/fleet/dependency-watch/run-now' });
    assert.equal(run.statusCode, 200);
    assert.equal(run.json().step.spawned, 1);
    assert.equal(run.json().task.lastSessionId, 'sess_deps');
    assert.equal(launches[0].workDir, '/repo/businessos');
    assert.match(launches[0].prompt, /15-day dependency and API watch/);
    await app.close();
  });

  it('inherits a hygiene provider override as a pair instead of mixing in githubAgents.model', async () => {
    const app = await buildScheduledRoutesApp({
      now: () => 30_000,
      rootConfig: {
        dependencyWatch: {
          repoPaths: { BusinessOS: '/repo/businessos' },
        },
        fleetHygiene: { provider: 'codex' },
        fleet: { repoPaths: {} },
        githubAgents: {
          repoPaths: {},
          provider: 'xai',
          model: 'grok-4.6',
        },
      },
    });

    const setup = await app.inject({ method: 'POST', url: '/api/fleet/dependency-watch/setup' });
    assert.equal(setup.statusCode, 200);
    assert.equal(setup.json().task.provider, 'codex');
    assert.equal(setup.json().task.model, 'gpt-6.1-sol');
    await app.close();
  });

  it('sets up and runs the daily job opportunities scheduled agent', async () => {
    const launches = [];
    const app = await buildScheduledRoutesApp({
      now: () => 40_000,
      rootConfig: {
        jobOpportunities: {
          scraperPath: '/repo/startup-scraper',
          scraperConfigPath: '/repo/fleet/config/jobs.yaml',
          profilePath: '/repo/fleet/config/profile.md',
          outputDir: '/repo/fleet/.dueno/job-opportunities',
          provider: 'codex',
          model: 'gpt-5.5',
          intervalSeconds: 86400,
        },
        dependencyWatch: { repoPaths: {} },
        fleet: { repoPaths: {} },
        githubAgents: { repoPaths: {} },
      },
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: 'sess_jobs' };
      },
      lookupSessionState: async () => null,
    });

    const initial = await app.inject({ method: 'GET', url: '/api/fleet/job-opportunities' });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().configured, false);
    assert.equal(initial.json().scraperPath, '/repo/startup-scraper');

    const setup = await app.inject({ method: 'POST', url: '/api/fleet/job-opportunities/setup' });
    assert.equal(setup.statusCode, 200);
    assert.equal(setup.json().configured, true);
    assert.equal(setup.json().task.workDir, '/repo/startup-scraper');
    assert.equal(setup.json().task.model, 'gpt-5.5');
    assert.equal(setup.json().task.intervalSeconds, 86400);
    assert.match(setup.json().task.prompt, /Daily interesting job opportunities check/);
    assert.match(setup.json().task.prompt, /\/repo\/fleet\/config\/profile\.md/);
    assert.match(setup.json().task.prompt, /\/repo\/fleet\/config\/jobs\.yaml/);
    assert.match(setup.json().task.prompt, /temporary copy of the StartupScraper config/);
    assert.match(setup.json().task.prompt, /set output\.markdown_dir to \/repo\/fleet\/\.dueno\/job-opportunities\/startup-scraper-output/);
    assert.match(setup.json().task.prompt, /interests and qualifications in the configured profile/);

    const run = await app.inject({ method: 'POST', url: '/api/fleet/job-opportunities/run-now' });
    assert.equal(run.statusCode, 200);
    assert.equal(run.json().step.spawned, 1);
    assert.equal(run.json().task.lastSessionId, 'sess_jobs');
    assert.equal(launches[0].workDir, '/repo/startup-scraper');
    assert.match(launches[0].prompt, /StartupScraper repo/);
    await app.close();
  });

  it('explains missing job scraper configuration before registering a task', async () => {
    const app = await buildScheduledRoutesApp({ rootConfig: { jobOpportunities: { scraperPath: '' } } });
    const result = await app.inject({ method: 'POST', url: '/api/fleet/job-opportunities/setup' });
    assert.equal(result.statusCode, 400);
    assert.match(result.json().message, /DM_JOB_OPPORTUNITIES_SCRAPER_PATH/);
    await app.close();
  });

  it('sets up and runs the skills upstream watch, launching isolated agents per upstream path', async () => {
    const launches = [];
    const worktrees = [];
    let nowMs = 10_000;
    const manifest = [
      '# header',
      'grilling\tmattpocock/skills\tskills/productivity/grilling/SKILL.md\t885e2ca',
      'debug\tobra/superpowers\tskills/systematic-debugging/SKILL.md\tb36e082',
    ].join('\n');
    const app = await buildScheduledRoutesApp({
      now: () => nowMs,
      rootConfig: {
        skillsUpstream: { repoPath: '/repo/fleet', provider: 'xai', model: 'grok-4.6', intervalSeconds: 604800 },
        fleet: { repoPaths: {} },
        githubAgents: { repoPaths: {} },
      },
      lsRemoteRunner: async (repo) => (repo === 'mattpocock/skills' ? 'sha_matt_1' : 'sha_super_1'),
      readUpstreamManifest: async () => manifest,
      detectSkillsUpstream: async () => ({
        changed: [
          { local: 'grilling', repo: 'mattpocock/skills', path: 'skills/productivity/grilling/SKILL.md', headSha: 'aaa' },
          { local: 'debug', repo: 'obra/superpowers', path: 'skills/systematic-debugging/SKILL.md', headSha: 'bbb' },
        ],
      }),
      createSkillsUpstreamWorktree: async (input) => {
        worktrees.push(input);
        return { worktreePath: `/wt/${input.displayName}` };
      },
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: `sess_skills_${launches.length}` };
      },
      lookupSessionState: async () => null,
    });

    const initial = await app.inject({ method: 'GET', url: '/api/fleet/skills-upstream' });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().configured, false);
    assert.equal(initial.json().usable, true);
    assert.equal(initial.json().repoPath, '/repo/fleet');

    const setup = await app.inject({ method: 'POST', url: '/api/fleet/skills-upstream/setup' });
    assert.equal(setup.statusCode, 200);
    assert.equal(setup.json().configured, true);
    assert.equal(setup.json().task.id, 'sched_skills_upstream_watch');
    assert.equal(setup.json().task.intervalSeconds, 604800);
    assert.equal(setup.json().task.workDir, '/repo/fleet');
    assert.equal(setup.json().task.prompt.includes('fans out one isolated worktree'), true);

    nowMs = 20_000;
    const run = await app.inject({ method: 'POST', url: '/api/fleet/skills-upstream/run-now' });
    assert.equal(run.statusCode, 200);
    assert.equal(run.json().step.spawned, 1);
    assert.equal(run.json().task.lastSessionId, 'sess_skills_1');
    assert.equal(launches.length, 2);
    assert.equal(launches[0].workDir, '/wt/skill-sync-grilling');
    assert.equal(launches[0].model, 'grok-4.6');
    assert.equal(launches[0].provider, 'xai');
    assert.equal(launches[0].mcpProfile, undefined);
    assert.match(launches[0].prompt, /Integrate upstream changes for fleet skill\(s\): grilling/);
    assert.match(launches[0].prompt, /docs\/skills-upstream-integration\.md/);
    assert.match(launches[0].prompt, /Work only in this worktree/);
    assert.match(launches[1].prompt, /Integrate upstream changes for fleet skill\(s\): debug/);
    assert.equal(worktrees.length, 2);
    assert.deepEqual(run.json().task.metadata.upstreamHeads, {
      'mattpocock/skills': 'sha_matt_1',
      'obra/superpowers': 'sha_super_1',
    });
    await app.close();
  });

  it('skips the skills upstream watch when no upstream head changed, relaunches when one does', async () => {
    const launches = [];
    let nowMs = 10_000;
    let superSha = 'sha_super_1';
    const manifest = [
      'grilling\tmattpocock/skills\tskills/productivity/grilling/SKILL.md\t885e2ca',
      'debug\tobra/superpowers\tskills/systematic-debugging/SKILL.md\tb36e082',
    ].join('\n');
    const app = await buildScheduledRoutesApp({
      now: () => nowMs,
      rootConfig: {
        skillsUpstream: { repoPath: '/repo/fleet' },
        fleet: { repoPaths: {} },
        githubAgents: { repoPaths: {} },
      },
      lsRemoteRunner: async (repo) => (repo === 'mattpocock/skills' ? 'sha_matt_1' : superSha),
      readUpstreamManifest: async () => manifest,
      detectSkillsUpstream: async () => ({
        changed: [
          { local: 'debug', repo: 'obra/superpowers', path: 'skills/systematic-debugging/SKILL.md', headSha: superSha },
        ],
      }),
      createSkillsUpstreamWorktree: async () => ({ worktreePath: '/wt/debug' }),
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: `sess_skills_${launches.length}` };
      },
      lookupSessionState: async () => null,
    });

    await app.inject({ method: 'POST', url: '/api/fleet/skills-upstream/setup' });
    const first = await app.inject({ method: 'POST', url: '/api/fleet/skills-upstream/run-now' });
    assert.equal(first.json().step.spawned, 1);
    assert.equal(launches.length, 1);

    nowMs = 20_000;
    const second = await app.inject({ method: 'POST', url: '/api/fleet/skills-upstream/run-now' });
    assert.equal(second.json().step.spawned, 0);
    assert.equal(second.json().step.tasks[0].action, 'skippedNoUpstreamChanges');
    assert.equal(launches.length, 1);

    superSha = 'sha_super_2';
    nowMs = 30_000;
    const third = await app.inject({ method: 'POST', url: '/api/fleet/skills-upstream/run-now' });
    assert.equal(third.json().step.spawned, 1);
    assert.equal(launches.length, 2);
    assert.equal(third.json().task.metadata.upstreamHeads['obra/superpowers'], 'sha_super_2');
    await app.close();
  });

  it('groups shared upstream paths, caps fan-out, and refuses the live checkout', async () => {
    const launches = [];
    const changed = [
      { local: 'technote', repo: 'hameefy/claude-latex-skill', path: 'SKILL.md', headSha: 'c1' },
      { local: 'latex-math', repo: 'hameefy/claude-latex-skill', path: 'SKILL.md', headSha: 'c1' },
      { local: 'grilling', repo: 'mattpocock/skills', path: 'skills/productivity/grilling/SKILL.md', headSha: 'c2' },
      { local: 'tdd', repo: 'mattpocock/skills', path: 'skills/engineering/tdd/SKILL.md', headSha: 'c3' },
      { local: 'debug', repo: 'obra/superpowers', path: 'skills/systematic-debugging/SKILL.md', headSha: 'c4' },
    ];
    const app = await buildScheduledRoutesApp({
      now: () => 20_000,
      rootConfig: {
        skillsUpstream: { repoPath: '/repo/fleet', maxFanout: 3 },
        fleet: { repoPaths: {} },
        githubAgents: { repoPaths: {} },
      },
      lsRemoteRunner: async () => 'sha_1',
      readUpstreamManifest: async () => 'grilling\tmattpocock/skills\tskills/productivity/grilling/SKILL.md\t885e2ca',
      detectSkillsUpstream: async () => ({ changed }),
      createSkillsUpstreamWorktree: async (input) => ({ worktreePath: `/wt/${input.displayName}` }),
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: `sess_${launches.length}` };
      },
      lookupSessionState: async () => null,
    });

    await app.inject({ method: 'POST', url: '/api/fleet/skills-upstream/setup' });
    const run = await app.inject({ method: 'POST', url: '/api/fleet/skills-upstream/run-now' });
    assert.equal(run.statusCode, 200);
    assert.equal(launches.length, 3);
    assert.match(launches[0].prompt, /technote, latex-math/);
    assert.match(launches[0].prompt, /1 additional upstream path/);
    assert.match(launches[1].prompt, /grilling/);
    assert.doesNotMatch(launches[1].prompt, /additional upstream path/);
    await app.close();

    const live = await buildScheduledRoutesApp({
      rootConfig: {
        skillsUpstream: { repoPath: '/home/dev/projects/dueno-fleet-live' },
        fleet: { repoPaths: {} },
        githubAgents: { repoPaths: {} },
      },
    });
    const refused = await live.inject({ method: 'POST', url: '/api/fleet/skills-upstream/setup' });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().error.code, 'skills_upstream_live_checkout');
    await live.close();

    const fallback = await buildScheduledRoutesApp({
      rootConfig: {
        skillsUpstream: { repoPath: '' },
        fleet: { repoPaths: {} },
        githubAgents: { repoPaths: { 'octo/fleet': '/repo/from-github' } },
      },
    });
    const status = await fallback.inject({ method: 'GET', url: '/api/fleet/skills-upstream' });
    assert.equal(status.json().repoPath, '/repo/from-github');
    assert.equal(status.json().usable, true);
    await fallback.close();
  });

  it('does not self-register repo quality watch and reports unconfigured status', async () => {
    const store = memoryStore({ now: () => 10_000 });
    const app = await buildScheduledRoutesApp({
      now: () => 10_000,
      store,
      rootConfig: {
        repoQuality: {
          repoPaths: { fleet: '/repo/fleet' },
          provider: 'codex',
          model: 'gpt-5.5',
          intervalSeconds: 604800,
          maxFanout: 2,
          topN: 10,
        },
        fleet: { repoPaths: {} },
        githubAgents: { repoPaths: {} },
      },
    });

    const listed = await app.inject({ method: 'GET', url: '/api/agents/scheduled' });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().tasks.some((task) => task.id === 'sched_repo_quality_watch'), false);

    const initial = await app.inject({ method: 'GET', url: '/api/fleet/repo-quality' });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().configured, false);
    assert.equal(initial.json().task, null);
    assert.equal(initial.json().intervalSeconds, 604800);
    assert.equal(initial.json().maxFanout, 2);
    assert.equal(initial.json().topN, 10);
    assert.deepEqual(initial.json().repoPaths, ['/repo/fleet']);
    await app.close();
  });

  it('reports legacy repo paths and named section targets without duplicating physical repos', async () => {
    const app = await buildScheduledRoutesApp({
      rootConfig: {
        repoQuality: {
          repoPaths: {
            fleet: '/repo/fleet',
            BusinessOS: {
              path: '/repo/businessos',
              sections: ['Default', 'default', ' rust ', 'rust'],
            },
          },
        },
        fleet: { repoPaths: {} },
        githubAgents: { repoPaths: {} },
      },
    });

    const status = await app.inject({ method: 'GET', url: '/api/fleet/repo-quality' });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().repoCount, 2);
    assert.equal(status.json().targetCount, 3);
    assert.deepEqual(status.json().repoPaths, ['/repo/fleet', '/repo/businessos']);
    assert.deepEqual(status.json().targets, [
      { repoName: 'fleet', repoPath: '/repo/fleet', section: 'default' },
      { repoName: 'BusinessOS', repoPath: '/repo/businessos', section: 'default' },
      { repoName: 'BusinessOS', repoPath: '/repo/businessos', section: 'rust' },
    ]);
    await app.close();
  });

  it('keeps legacy primary and companion repo quality entries as default targets', async () => {
    const app = await buildScheduledRoutesApp({
      rootConfig: {
        repoQuality: {
          repoPaths: {
            portfolio: {
              primary: '/repo/primary',
              companions: ['/repo/companion'],
            },
          },
        },
        fleet: { repoPaths: {} },
        githubAgents: { repoPaths: {} },
      },
    });

    const status = await app.inject({ method: 'GET', url: '/api/fleet/repo-quality' });
    assert.equal(status.statusCode, 200);
    assert.deepEqual(status.json().repoPaths, ['/repo/primary', '/repo/companion']);
    assert.deepEqual(status.json().targets.map(({ repoPath, section }) => ({ repoPath, section })), [
      { repoPath: '/repo/primary', section: 'default' },
      { repoPath: '/repo/companion', section: 'default' },
    ]);
    await app.close();
  });

  it('sets up the repo quality watch without launching until run-now', async () => {
    const launches = [];
    const app = await buildScheduledRoutesApp({
      now: () => 10_000,
      rootConfig: {
        repoQuality: {
          repoPaths: { fleet: '/repo/fleet', 'example-app': '/repo/example-app' },
          provider: 'codex',
          model: 'gpt-5.5',
          intervalSeconds: 604800,
          maxFanout: 2,
          topN: 10,
        },
        fleet: { repoPaths: {} },
        githubAgents: { repoPaths: {} },
      },
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: 'sess_quality' };
      },
      lookupSessionState: async () => null,
    });

    const setup = await app.inject({ method: 'POST', url: '/api/fleet/repo-quality/setup' });
    assert.equal(setup.statusCode, 200);
    assert.equal(setup.json().configured, true);
    assert.equal(setup.json().task.id, 'sched_repo_quality_watch');
    assert.equal(setup.json().task.intervalSeconds, 604800);
    assert.equal(setup.json().task.provider, 'codex');
    assert.equal(setup.json().task.model, 'gpt-5.5');
    assert.equal(setup.json().task.workDir, '/repo/fleet');
    assert.equal(setup.json().maxFanout, 2);
    assert.equal(setup.json().topN, 10);
    assert.equal(launches.length, 0);
    await app.close();
  });

  it('refuses repo quality watch setup against the live fleet checkout', async () => {
    const live = await buildScheduledRoutesApp({
      rootConfig: {
        repoQuality: {
          repoPaths: { fleet: '/home/dev/projects/dueno-fleet-live' },
        },
        fleet: { repoPaths: {} },
        githubAgents: { repoPaths: {} },
      },
    });
    const refused = await live.inject({ method: 'POST', url: '/api/fleet/repo-quality/setup' });
    assert.equal(refused.statusCode, 400);
    assert.equal(refused.json().error.code, 'repo_quality_live_checkout');
    await live.close();
  });

  it('runs repo quality in isolated worktrees and fans out at most maxFanout fix agents', async () => {
    const launches = [];
    const worktrees = [];
    const removed = [];
    const checks = [];
    const saved = [];
    const reports = {
      '/wt/quality-fleet': {
        code: 1,
        report: {
          repo: 'fleet',
          sha: 'sha_fleet_1',
          totals: { crapFail: 30, crapAboveFail: 2, crapSumAboveFail: 90 },
          functions: [
            { file: 'hot.mjs', line: 4, name: 'explode', crap: 50, cc: 10, coverage: 0 },
            { file: 'warm.mjs', line: 8, name: 'simmer', crap: 40, cc: 8, coverage: 0.2 },
          ],
          mutation: {
            survivors: [{ file: 'hot.mjs', line: 5, mutator: 'BooleanLiteral', replacement: 'false' }],
          },
        },
      },
      '/wt/quality-example-app': {
        code: 1,
        report: {
          repo: 'example-app',
          sha: 'sha_inv_1',
          totals: { crapFail: 30, crapAboveFail: 1, crapSumAboveFail: 35 },
          functions: [
            { file: 'x.ts', line: 9, name: 'messy', crap: 35, cc: 9, coverage: 0 },
          ],
        },
      },
      '/wt/quality-businessos': {
        code: 1,
        report: {
          repo: 'businessos',
          sha: 'sha_bos_1',
          totals: { crapFail: 30, crapAboveFail: 9, crapSumAboveFail: 400 },
          functions: [
            { file: 'debt.ts', line: 1, name: 'worst', crap: 90, cc: 12, coverage: 0 },
          ],
        },
      },
    };
    const app = await buildScheduledRoutesApp({
      now: () => 20_000,
      rootConfig: {
        repoQuality: {
          repoPaths: {
            fleet: '/repo/fleet',
            'example-app': '/repo/example-app',
            businessos: '/repo/businessos',
          },
          provider: 'codex',
          model: 'gpt-5.5',
          intervalSeconds: 604800,
          maxFanout: 2,
          topN: 10,
          worktreeBaseDir: '/wt-base',
        },
        fleet: { repoPaths: {} },
        githubAgents: { repoPaths: {} },
      },
      gitRunner: async (cwd, args) => {
        if (args.join(' ') === 'rev-parse --show-toplevel') return cwd;
        if (args.join(' ') === 'fetch --quiet origin') return '';
        if (args.join(' ') === 'rev-parse --verify refs/remotes/origin/main') return `main-${cwd}`;
        return '';
      },
      createRepoQualityWorktree: async (input) => {
        worktrees.push(input);
        return { worktreePath: `/wt/${input.displayName}`, branch: `dueno-fleet/quality/${input.displayName}` };
      },
      removeRepoQualityWorktree: async (input) => {
        removed.push(input);
        return { removed: true };
      },
      runRepoQualityCheck: async (worktreePath) => {
        checks.push(worktreePath);
        return reports[worktreePath];
      },
      saveRepoQualityReport: async (record) => {
        saved.push(record);
      },
      loadPreviousRepoQualityReport: async (repoPath) => {
        if (repoPath !== '/repo/fleet') return null;
        return {
          sha: 'sha_fleet_0',
          totals: { crapFail: 30, crapAboveFail: 1, crapSumAboveFail: 50 },
          mutation: { totals: { survived: 0 } },
        };
      },
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: `sess_quality_${launches.length}` };
      },
      lookupSessionState: async () => null,
    });

    await app.inject({ method: 'POST', url: '/api/fleet/repo-quality/setup' });
    const run = await app.inject({ method: 'POST', url: '/api/fleet/repo-quality/run-now' });
    assert.equal(run.statusCode, 200);
    assert.equal(run.json().step.spawned, 1);
    assert.equal(run.json().task.lastSessionId, 'sess_quality_1');
    assert.equal(launches.length, 2);
    assert.deepEqual(worktrees.map((item) => item.branchPrefix), ['dueno-fleet/quality', 'dueno-fleet/quality', 'dueno-fleet/quality']);
    assert.deepEqual(worktrees.map((item) => item.baseDir), ['/wt-base', '/wt-base', '/wt-base']);
    assert.deepEqual(worktrees.map((item) => item.repoPath), ['/repo/fleet', '/repo/example-app', '/repo/businessos']);
    assert.deepEqual(checks, ['/wt/quality-fleet', '/wt/quality-example-app', '/wt/quality-businessos']);
    assert.equal(checks.includes('/repo/fleet'), false);
    assert.equal(launches[0].workDir, '/wt/quality-businessos');
    assert.equal(launches[0].provider, 'codex');
    assert.equal(launches[0].model, 'gpt-5.5');
    assert.match(launches[0].prompt, /debt\.ts:1/);
    assert.match(launches[0].prompt, /Never weaken a test/);
    assert.match(launches[0].prompt, /do not merge/i);
    assert.equal(launches[1].workDir, '/wt/quality-fleet');
    assert.match(launches[1].prompt, /hot\.mjs:4/);
    assert.match(launches[1].prompt, /hot\.mjs:5/);
    assert.deepEqual(removed.map((item) => item.workDir || item.worktreePath), ['/wt/quality-example-app']);
    assert.equal(saved.length, 3);
    assert.notEqual(saved[0].slug, saved[1].slug);
    assert.deepEqual(saved[0].delta, {
      previousSha: 'sha_fleet_0',
      currentSha: 'sha_fleet_1',
      crapAboveFail: { previous: 1, current: 2, delta: 1 },
      crapSumAboveFail: { previous: 50, current: 90, delta: 40 },
      survivors: { previous: 0, current: 1, delta: 1 },
    });
    await app.close();
  });

  it('isolates repo sections while ranking and limiting fanout globally', async () => {
    const worktrees = [];
    const checks = [];
    const loaded = [];
    const saved = [];
    const removed = [];
    const launches = [];
    const reports = {
      '/wt/quality-fleet': {
        code: 1,
        report: {
          repo: 'fleet', sha: 'sha_fleet',
          totals: { crapFail: 30, crapAboveFail: 5, crapSumAboveFail: 200 },
          functions: [{ file: 'fleet.mjs', line: 4, name: 'fleetDebt', crap: 80 }],
        },
      },
      '/wt/quality-businessos': {
        code: 1,
        report: {
          repo: 'businessos', sha: 'sha_businessos',
          totals: { crapFail: 30, crapAboveFail: 1, crapSumAboveFail: 35 },
          functions: [{ file: 'frontend.ts', line: 8, name: 'frontendDebt', crap: 35 }],
        },
      },
      '/wt/quality-businessos-rust': {
        code: 1,
        report: {
          repo: 'businessos', sha: 'sha_businessos',
          totals: { crapFail: 30, crapAboveFail: 9, crapSumAboveFail: 500 },
          functions: [{ file: 'rust.rs', line: 12, name: 'rustDebt', crap: 100 }],
        },
      },
    };
    const app = await buildScheduledRoutesApp({
      now: () => 40_000,
      rootConfig: {
        repoQuality: {
          repoPaths: {
            fleet: '/repo/fleet',
            BusinessOS: {
              path: '/repo/businessos',
              sections: ['default', 'rust'],
            },
          },
          provider: 'codex',
          model: 'gpt-5.5',
          maxFanout: 2,
          topN: 10,
          worktreeBaseDir: '/wt-base',
        },
        fleet: { repoPaths: {} },
        githubAgents: { repoPaths: {} },
      },
      gitRunner: async (cwd, args) => {
        if (args.join(' ') === 'rev-parse --show-toplevel') return cwd;
        if (args.join(' ') === 'fetch --quiet origin') return '';
        if (args.join(' ') === 'rev-parse --verify refs/remotes/origin/main') return `main-${cwd}`;
        return '';
      },
      createRepoQualityWorktree: async (input) => {
        worktrees.push(input);
        return {
          worktreePath: `/wt/${input.displayName}`,
          branch: `dueno-fleet/quality/${input.displayName}`,
        };
      },
      runRepoQualityCheck: async (worktreePath, target) => {
        checks.push({ worktreePath, target });
        return reports[worktreePath];
      },
      loadPreviousRepoQualityReport: async (repoPath, section) => {
        loaded.push({ repoPath, section });
        return {
          sha: `previous_${section}`,
          totals: {
            crapFail: 30,
            crapAboveFail: section === 'rust' ? 8 : 0,
            crapSumAboveFail: section === 'rust' ? 450 : 0,
          },
        };
      },
      saveRepoQualityReport: async (record) => {
        saved.push(record);
      },
      removeRepoQualityWorktree: async (input) => {
        removed.push(input);
        return { removed: true };
      },
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: `sess_quality_${launches.length}` };
      },
      lookupSessionState: async () => null,
    });

    await app.inject({ method: 'POST', url: '/api/fleet/repo-quality/setup' });
    const run = await app.inject({ method: 'POST', url: '/api/fleet/repo-quality/run-now' });

    assert.equal(run.statusCode, 200);
    assert.equal(launches.length, 2);
    assert.deepEqual(worktrees.map(({ repoPath, displayName }) => ({ repoPath, displayName })), [
      { repoPath: '/repo/fleet', displayName: 'quality-fleet' },
      { repoPath: '/repo/businessos', displayName: 'quality-businessos' },
      { repoPath: '/repo/businessos', displayName: 'quality-businessos-rust' },
    ]);
    assert.deepEqual(checks.map(({ worktreePath, target }) => ({
      worktreePath,
      repoName: target.repoName,
      section: target.section,
    })), [
      { worktreePath: '/wt/quality-fleet', repoName: 'fleet', section: 'default' },
      { worktreePath: '/wt/quality-businessos', repoName: 'BusinessOS', section: 'default' },
      { worktreePath: '/wt/quality-businessos-rust', repoName: 'BusinessOS', section: 'rust' },
    ]);
    assert.deepEqual(loaded, [
      { repoPath: '/repo/fleet', section: 'default' },
      { repoPath: '/repo/businessos', section: 'default' },
      { repoPath: '/repo/businessos', section: 'rust' },
    ]);
    assert.deepEqual(saved.map(({ repoPath, section }) => ({ repoPath, section })), loaded);
    assert.notEqual(saved[1].slug, saved[2].slug);
    assert.deepEqual(launches.map(({ workDir }) => workDir), [
      '/wt/quality-businessos-rust',
      '/wt/quality-fleet',
    ]);
    assert.match(launches[0].prompt, /Section: rust/);
    assert.match(launches[0].prompt, /rust\.rs:12/);
    assert.deepEqual(removed.map(({ worktreePath }) => worktreePath), [
      '/wt/quality-businessos',
    ]);
    await app.close();
  });

  it('skips repo quality watch when origin/main did not move and does not dispatch on CLI exit 2', async () => {
    const launches = [];
    const saved = [];
    let nowMs = 10_000;
    let checkCode = 2;
    const app = await buildScheduledRoutesApp({
      now: () => nowMs,
      rootConfig: {
        repoQuality: {
          repoPaths: { fleet: '/repo/fleet' },
          provider: 'codex',
          model: 'gpt-5.5',
          worktreeBaseDir: '/wt-base',
        },
        fleet: { repoPaths: {} },
        githubAgents: { repoPaths: {} },
      },
      gitRunner: async (cwd, args) => {
        if (args.join(' ') === 'rev-parse --show-toplevel') return '/repo/fleet';
        if (args.join(' ') === 'fetch --quiet origin') return '';
        if (args.join(' ') === 'rev-parse --verify refs/remotes/origin/main') return 'abc123';
        return '';
      },
      createRepoQualityWorktree: async () => ({ worktreePath: '/wt/quality-fleet' }),
      runRepoQualityCheck: async () => {
        if (checkCode === 2) return { code: 2, report: null, error: 'missing config' };
        return {
          code: 1,
          report: {
            repo: 'fleet',
            sha: 'sha_2',
            totals: { crapFail: 30, crapAboveFail: 1, crapSumAboveFail: 40 },
            functions: [{ file: 'hot.mjs', line: 4, name: 'explode', crap: 40, cc: 8, coverage: 0 }],
          },
        };
      },
      saveRepoQualityReport: async (record) => {
        saved.push(record);
      },
      loadPreviousRepoQualityReport: async () => null,
      sessionLauncher: async (input) => {
        launches.push(input);
        return { id: `sess_quality_${launches.length}` };
      },
      lookupSessionState: async () => null,
    });

    await app.inject({ method: 'POST', url: '/api/fleet/repo-quality/setup' });
    const failed = await app.inject({ method: 'POST', url: '/api/fleet/repo-quality/run-now' });
    assert.equal(failed.statusCode, 200);
    assert.equal(failed.json().step.spawned, 0);
    assert.equal(failed.json().step.tasks[0].action, 'checkFailed');
    assert.equal(launches.length, 0);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].code, 2);
    assert.equal(saved[0].error, 'missing config');
    assert.equal(saved[0].report, null);

    nowMs = 20_000;
    checkCode = 1;
    const retried = await app.inject({ method: 'POST', url: '/api/fleet/repo-quality/run-now' });
    assert.equal(retried.json().step.spawned, 1);
    assert.equal(launches.length, 1);

    nowMs = 30_000;
    const skipped = await app.inject({ method: 'POST', url: '/api/fleet/repo-quality/run-now' });
    assert.equal(skipped.json().step.spawned, 0);
    assert.equal(skipped.json().step.tasks[0].action, 'skippedNoMainChanges');
    assert.equal(launches.length, 1);
    await app.close();
  });
});

function baseTask(overrides = {}) {
  return {
    id: 'sched_test',
    workDir: '/tmp/work',
    prompt: 'run report',
    provider: 'codex',
    intervalSeconds: 15,
    startImmediately: true,
    ...overrides,
  };
}

function memoryStore({ now }) {
  let saved = null;
  return buildScheduledAgentStore({
    now,
    stateStore: {
      loadSync: () => null,
      load: async () => saved,
      save: async (data) => { saved = data; },
      close: async () => {},
    },
  });
}

async function buildScheduledRoutesApp({
  now = () => 1000,
  store = memoryStore({ now }),
  sessionLauncher = async () => ({ id: 'sess_test' }),
  lookupSessionState = async () => null,
  gitRunner,
  lsRemoteRunner,
  readUpstreamManifest,
  detectSkillsUpstream,
  createSkillsUpstreamWorktree,
  createRepoQualityWorktree,
  removeRepoQualityWorktree,
  runRepoQualityCheck,
  saveRepoQualityReport,
  loadPreviousRepoQualityReport,
  rootConfig = {
    dependencyWatch: { repoPaths: {} },
    fleet: { repoPaths: {} },
    githubAgents: { repoPaths: {} },
  },
  authContext = null,
} = {}) {
  const app = Fastify({ logger: false });
  if (authContext) {
    app.addHook('onRequest', async (request) => {
      request.duenoAuth = structuredClone(authContext);
    });
  }
  await app.register(scheduledAgentsPlugin, {
    store,
    config: { enabled: false, tickIntervalSec: 1 },
    now,
    rootConfig,
    gitRunner,
    lsRemoteRunner,
    readUpstreamManifest,
    detectSkillsUpstream,
    createSkillsUpstreamWorktree,
    createRepoQualityWorktree,
    removeRepoQualityWorktree,
    runRepoQualityCheck,
    saveRepoQualityReport,
    loadPreviousRepoQualityReport,
    sessionLauncher,
    lookupSessionState,
    loop: {
      start() {},
      stop() {},
    },
  });
  return app;
}
