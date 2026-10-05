import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, it } from 'node:test';
import { AsyncEventQueue, createBaseCapabilities } from '../modules/agent/agent-transport.mjs';
import { FileJournalStore } from '../modules/sessions/journal-store.mjs';
import { SessionService } from '../modules/sessions/session-service.mjs';
import { buildHookSessionPaths, createHookEventRetention, recordRuntimeHookEvent, registerHookSessionRegistry } from '../modules/agent/hook-events.mjs';
import { buildPostgresJsonStore } from '../modules/ops/postgres-json-store.mjs';
import { createAgentBusObserver } from '../modules/agent-bus/observer.mjs';

const roots = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop(), { recursive: true, force: true });
});

// Stub only the external transport boundary; registry, journal, hooks and cleanup are real.
class FakeTransport {
  queue = new AsyncEventQueue();
  async start(spec) { return { attemptId: spec.attemptId, negotiated: this.capabilities() }; }
  async attach() {}
  async prompt() {}
  async cancel() {}
  async answerInteraction() {}
  events() { return this.queue; }
  snapshot() { return { lifecycle: 'ready' }; }
  capabilities() { return createBaseCapabilities(); }
  async terminate() { this.queue.close(); return { ok: true, status: 'terminated', residual: [] }; }
}

async function fixture({ factory } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cadre-hook-retention-'));
  roots.push(root);
  const workDir = join(root, 'project');
  await mkdir(workDir);
  const service = new SessionService({
    journal: new FileJournalStore({ rootDir: join(root, 'journal') }), transportFactory: factory,
  });
  await service.init();
  return { root, workDir, service };
}

describe('hook event retention through the session registry', () => {
  it('keeps live and recent files, prunes ended old pairs, and cleans deleted sessions', async () => {
    const harness = await fixture({ factory: () => new FakeTransport() });
    await mkdir(join(harness.workDir, '.git'));
    const store = buildPostgresJsonStore({ namespace: 'hook_roots', filePath: join(harness.root, 'roots.json'), env: { APP_STATE_STORAGE: 'file' } });
    const retention = createHookEventRetention({ store });
    try {
      const live = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
      const ended = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
      const recent = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
      const paths = [];
      for (const session of [live, ended, recent]) {
        const recorded = await recordRuntimeHookEvent({ workDir: harness.workDir, provider: 'deepseek', sessionId: session.id, eventName: 'test' });
        paths.push(recorded.paths);
      }
      const old = new Date(Date.now() - 8 * 86_400_000);
      for (const path of paths.slice(0, 2)) await utimes(path.eventsPath, old, old);
      await harness.service.terminate(ended.id);
      await harness.service.terminate(recent.id);
      const unrelated = ['notes.jsonl', 'other-session.jsonl', 'deepseek-x.jsonl.tmp-1', 'deepseek-x.json', 'deepseek-.jsonl'];
      for (const name of unrelated) {
        const path = join(paths[0].hooksDir, name);
        await writeFile(path, 'keep');
        await utimes(path, old, old);
      }
      const unpaired = join(paths[0].stateDir, 'deepseek-unpaired.json');
      await writeFile(unpaired, '{}');
      await retention.sweep();
      for (const path of [paths[0].eventsPath, paths[0].statePath, paths[2].eventsPath, paths[2].statePath, unpaired]) assert.ok(await stat(path));
      for (const path of [paths[1].eventsPath, paths[1].statePath]) await assert.rejects(stat(path), { code: 'ENOENT' });
      for (const name of unrelated) assert.ok(await stat(join(paths[0].hooksDir, name)));
      // Aging the events file, rather than state-file mtime, controls eligibility.
      await utimes(paths[2].eventsPath, old, old);
      await retention.sweep();
      for (const path of [paths[2].eventsPath, paths[2].statePath]) await assert.rejects(stat(path), { code: 'ENOENT' });
      assert.equal((await harness.service.delete(live.id)).status, 'deleted');
      for (let i = 0; i < 100 && await stat(paths[0].statePath).then(() => true, () => false); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      for (const path of [paths[0].eventsPath, paths[0].statePath]) await assert.rejects(stat(path), { code: 'ENOENT' });
    } finally { await retention.close(); await harness.service.close(); }
  });

  it('bounds directory entries, progresses across sweeps, and remembers roots after registry removal', async () => {
    const harness = await fixture({ factory: () => new FakeTransport() });
    await mkdir(join(harness.workDir, '.git'));
    const store = buildPostgresJsonStore({ namespace: 'hook_roots', filePath: join(harness.root, 'roots.json'), env: { APP_STATE_STORAGE: 'file' } });
    let retention = createHookEventRetention({ store, retentionDays: 0 });
    try {
      const session = await harness.service.start({ workDir: harness.workDir, permissionMode: 'workspace-write' });
      const paths = await buildHookSessionPaths({ workDir: harness.workDir, provider: 'deepseek', sessionId: session.id });
      await mkdir(paths.hooksDir, { recursive: true });
      for (let i = 0; i < 300; i++) await writeFile(join(paths.hooksDir, `deepseek-gone-${i}.jsonl`), '{}');
      await retention.sweep();
      const remaining = (await readdir(paths.hooksDir)).length;
      assert.ok(remaining >= 172 && remaining < 300, `remaining: ${remaining}`);
      assert.deepEqual(await store.load(), [harness.workDir]);
      await retention.close();
      await harness.service.delete(session.id);
      await harness.service.close();
      // A fresh sweeper has no session roots; only the durable record supplies it.
      retention = createHookEventRetention({ store, retentionDays: 0 });
      await retention.sweep();
      await retention.sweep();
      assert.deepEqual(await readdir(paths.hooksDir), []);
      await rm(paths.hooksDir, { recursive: true });
      await retention.sweep();
      assert.deepEqual(await store.load(), []);
    } finally { await retention.close(); await harness.service.close(); }
  });
});


it('fails closed when a registered backend cannot report its sessions', async () => {
  const harness = await fixture({ factory: () => new FakeTransport() });
  await mkdir(join(harness.workDir, '.git'));
  const recorded = await recordRuntimeHookEvent({ workDir: harness.workDir, provider: 'deepseek', sessionId: 'gone', eventName: 'test' });
  const store = buildPostgresJsonStore({ namespace: 'roots', filePath: join(harness.root, 'roots.json'), env: { APP_STATE_STORAGE: 'file' } });
  await store.save([harness.workDir]);
  const retention = createHookEventRetention({ store, retentionDays: 0 });
  const unregister = registerHookSessionRegistry('claude', () => { throw new Error('registry unavailable'); });
  try {
    await assert.rejects(retention.sweep(), /registry unavailable/);
    assert.ok(await stat(recorded.paths.eventsPath));
    assert.ok(await stat(recorded.paths.statePath));
  } finally { unregister(); await retention.close(); await harness.service.close(); }
});

it('observer delays the first sweep and honors side-effect suppression', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cadre-hook-observer-'));
  roots.push(root);
  const workDir = join(root, 'project');
  await mkdir(join(workDir, '.git'), { recursive: true });
  const { paths } = await recordRuntimeHookEvent({ workDir, provider: 'claude', sessionId: 'gone', eventName: 'test' });
  const old = new Date(Date.now() - 8 * 86_400_000);
  await utimes(paths.eventsPath, old, old);
  const priorEnv = { ...process.env };
  process.env.CADRE_STATE_DIR = join(root, 'state');
  process.env.CADRE_DISABLE_SIDE_EFFECTS = '0';
  process.env.CADRE_ALLOW_SIDE_EFFECTS = '1';
  delete process.env.DUENO_ALLOW_SIDE_EFFECTS;
  const store = buildPostgresJsonStore({ namespace: 'hook_event_roots', filePath: join(root, 'state', 'hook_event_roots.json'), env: { APP_STATE_STORAGE: 'file' } });
  await store.save([workDir]);
  let close;
  let ticks = 0;
  const warnings = [];
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  createAgentBusObserver({
    app: { addHook(_name, fn) { close = fn; }, log: { warn(fields) { warnings.push(fields); } } },
    store: { listMessages() { ticks++; return []; }, listDeliveries() { return []; } },
    adapters: {}, observedSessions: new Set(), deliveryInFlight: new Set(), observerInFlightByRef: new Map(),
    observerIntervalMs: 1000, observerSessionTimeoutMs: 5000,
    broadcastAlert() {},
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  try {
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(ticks, 1);
    assert.ok(await stat(paths.eventsPath));
    process.env.CADRE_DISABLE_SIDE_EFFECTS = '1';
    delete process.env.CADRE_ALLOW_SIDE_EFFECTS;
    t.mock.timers.tick(3_600_000);
    await flush();
    assert.ok(await stat(paths.eventsPath));
    process.env.CADRE_DISABLE_SIDE_EFFECTS = '0';
    process.env.CADRE_ALLOW_SIDE_EFFECTS = '1';
    t.mock.timers.tick(1000);
    // Use real filesystem completion as evidence, not timer-callback shape assertions.
    for (let i = 0; i < 100 && await stat(paths.eventsPath).then(() => true, () => false); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(stat(paths.eventsPath), { code: 'ENOENT' });
    await close();
    assert.deepEqual(warnings, []);
  } finally {
    await close();
    t.mock.timers.reset();
    for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
    Object.assign(process.env, priorEnv);
  }
});
