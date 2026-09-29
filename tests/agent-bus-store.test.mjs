import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBusStore } from '../modules/agent-bus/store.mjs';
import { runtimeStatePath } from '../modules/ops/runtime-state.mjs';

const tempDirs = [];
const originalCwd = process.cwd();
const originalStateDir = process.env.CADRE_STATE_DIR;

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalStateDir === undefined) delete process.env.CADRE_STATE_DIR;
  else process.env.CADRE_STATE_DIR = originalStateDir;
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-agent-bus-store-'));
  tempDirs.push(dir);
  return dir;
}

describe('AgentBusStore runtime state', () => {
  it('loads legacy .agent_bus state and mirrors it to runtime state', async () => {
    const dir = await makeTempDir();
    process.chdir(dir);
    process.env.CADRE_STATE_DIR = join(dir, '.dueno', 'state');
    await mkdir('.agent_bus', { recursive: true });
    await writeFile('.agent_bus/state.json', `${JSON.stringify({
      threads: [{ id: 'thr_legacy', status: 'open', updatedAt: 1 }],
      messages: [],
      deliveries: [],
      events: [],
    }, null, 2)}\n`);

    const store = new AgentBusStore({ stateDir: runtimeStatePath('agent_bus', process.env) });
    await store.init();

    assert.equal(store.listThreads()[0].id, 'thr_legacy');
    assert.equal(
      JSON.parse(await readFile(join('.dueno', 'state', 'agent_bus', 'state.json'), 'utf8')).threads[0].id,
      'thr_legacy',
    );

    await store.close();
  });

  it('does not overwrite existing state when init load fails', async () => {
    const dir = await makeTempDir();
    const stateDir = join(dir, 'agent_bus');
    await mkdir(stateDir, { recursive: true });
    const badState = '{ "threads": [';
    await writeFile(join(stateDir, 'state.json'), badState);
    const warnings = [];
    const store = new AgentBusStore({
      stateDir,
      logger: {
        warn: (entry, message) => warnings.push({ entry, message }),
        debug: () => {},
      },
    });

    await assert.rejects(() => store.init(), SyntaxError);
    assert.equal(await readFile(join(stateDir, 'state.json'), 'utf8'), badState);
    assert.equal(warnings.length, 1);
  });

  it('coalesces pending persists and omits events from state snapshots', async () => {
    const dir = await makeTempDir();
    const store = new AgentBusStore({ stateDir: join(dir, 'agent_bus'), persistDebounceMs: 20 });
    await store.init();
    let saveCount = 0;
    let savedState = null;
    store.state.threads.push({ id: 'thr_test', status: 'open', updatedAt: 1 });
    store.state.events.push({ id: 'evt_test', type: 'test', createdAt: 1, data: {} });
    store.stateStore.save = async (state) => {
      saveCount += 1;
      savedState = JSON.parse(JSON.stringify(state));
    };

    const first = store.persist();
    const second = store.persist();
    assert.equal(saveCount, 0);
    await Promise.all([first, second]);

    assert.equal(saveCount, 1);
    assert.deepEqual(savedState, {
      threads: [{ id: 'thr_test', status: 'open', updatedAt: 1 }],
      messages: [],
      deliveries: [],
    });

    await store.close();
  });

  it('mirrors messages to an append-only jsonl file', async () => {
    const dir = await makeTempDir();
    const project = join(dir, 'project');
    await mkdir(project, { recursive: true });
    const store = new AgentBusStore({ stateDir: join(dir, 'agent_bus') });
    await store.init();
    const thread = await store.createThread({
      title: 'room', projectKey: project,
      participants: [{ kind: 'codex', sessionId: 'c1' }, { kind: 'claude', sessionId: 'a1' }],
      createdBy: { kind: 'claude', sessionId: 'coord' },
    });
    assert.deepEqual(thread.createdBy, { kind: 'claude', sessionId: 'coord' });
    await store.createMessage({
      threadId: thread.id, from: { kind: 'codex', sessionId: 'c1' },
      targets: [{ kind: 'claude', sessionId: 'a1' }], body: 'hello',
    });
    const line = await readFile(join(dir, 'agent_bus', 'rooms', thread.id, 'messages.jsonl'), 'utf8');
    assert.match(line, /"body":"hello"/);
    await store.close();
  });

  it('removes a thread participant without dropping the room', async () => {
    const dir = await makeTempDir();
    const store = new AgentBusStore({ stateDir: join(dir, 'agent_bus') });
    await store.init();
    const thread = await store.createThread({
      title: 'room',
      participants: [{ kind: 'codex', sessionId: 'c1' }, { kind: 'claude', sessionId: 'a1' }],
    });
    const updated = await store.removeThreadParticipant(thread.id, { kind: 'claude', sessionId: 'a1' });
    assert.deepEqual(updated.participants, [{ kind: 'codex', sessionId: 'c1' }]);
    assert.equal(updated.status, 'open');
    await store.close();
  });

  it('prunes only stale closed threads and keeps task records and task parents', async () => {
    const dir = await makeTempDir();
    const stateDir = join(dir, 'agent_bus');
    const now = Date.now();
    const old = now - 40 * 86_400_000;
    const task = (extra = {}) => ({ task: { recordType: 'dueno.durable-task.v1', ...extra } });
    await mkdir(join(stateDir, 'rooms', 'old_closed'), { recursive: true });
    await writeFile(join(stateDir, 'state.json'), JSON.stringify({
      threads: [
        { id: 'old_closed', status: 'closed', updatedAt: old },
        { id: 'recent_closed', status: 'closed', updatedAt: now },
        { id: 'old_open', status: 'open', updatedAt: old },
        { id: 'old_task', status: 'closed', updatedAt: old, metadata: task({ tombstone: true }) },
        { id: 'old_parent', status: 'closed', updatedAt: old },
        { id: 'child', status: 'open', updatedAt: now, metadata: task({ parentThreadId: 'old_parent' }) },
      ],
      messages: ['old_closed', 'recent_closed'].map((threadId) => ({ id: `m_${threadId}`, threadId })),
      deliveries: [{ id: 'd_old_closed', threadId: 'old_closed' }],
    }));

    const store = new AgentBusStore({ stateDir, closedThreadRetentionDays: 30 });
    await store.init();

    assert.deepEqual(store.listThreads().map((thread) => thread.id).sort(), ['child', 'old_open', 'old_parent', 'old_task', 'recent_closed']);
    assert.deepEqual(store.state.messages.map((message) => message.id), ['m_recent_closed']);
    assert.deepEqual(store.state.deliveries, []);
    await assert.rejects(access(join(stateDir, 'rooms', 'old_closed')), { code: 'ENOENT' });
    assert.equal(await store.pruneClosedThreads({ retentionDays: 0 }), 1);
    await store.close();
  });

});
