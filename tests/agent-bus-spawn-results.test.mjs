import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildHookSessionPaths, recordHookPayload, registerHookSessionRegistry } from '../modules/agent/hook-events.mjs';
import { spawnerMetadata } from '../modules/agent-bus/coordinator-policy.mjs';
import { buildSessionDeliveryAuditStore } from '../modules/sessions/delivery-audit.mjs';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';

const spawner = { kind: 'codex', sessionId: 'codex-1' };
const settle = async (done) => { for (let i = 0; i < 200 && !done(); i++) await delay(20); return done(); };

async function setup(t, metadata, stateDir = null, sessionDeliveryAuditStore = null) {
  const h = await createAgentBusHarness({ pollMs: 20, stateDir, sessionDeliveryAuditStore });
  // Hook files live under the nearest git root, so pin it to this test's directory.
  await mkdir(join(h.stateDir, '.git'), { recursive: true });
  h.sessionCatalog.claude.add('claude-2');
  const sessions = new Map([['claude-2', { workDir: h.stateDir, metadata }]]);
  const unregister = registerHookSessionRegistry('claude', () => sessions);
  let closed = false;
  t.after(async () => { unregister(); if (!closed) await h.cleanup(); });
  const restart = async () => { closed = true; unregister(); await h.app.close(); return setup(t, metadata, h.stateDir); };
  const hook = (payload, sessionId = 'claude-2') => recordHookPayload({ session_id: sessionId, cwd: h.stateDir, ...payload },
    { provider: 'claude', duenoSessionId: sessionId, workDir: h.stateDir });
  const turn = async (answer) => {
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'work' });
    await hook({ hook_event_name: 'Stop', last_assistant_message: answer });
  };
  const results = () => h.store.listMessages().filter((message) => message.type === 'result');
  const delivered = (text) => h.injected.codex.filter((item) => item.includes(text)).length;
  return { h, hook, turn, results, delivered, restart, sessions };
}

test('a spawned coordinator waits for its owned room result and for renewed room work', async (t) => {
  const { h, turn, results, delivered } = await setup(t, { spawnedBy: spawner });
  const owner = { kind: 'claude', sessionId: 'claude-2' };
  const worker = { kind: 'claude', sessionId: 'claude-1' };
  const room = await h.store.createThread({ title: 'Collaboration', participants: [worker], createdBy: owner });
  for (const round of [1, 2]) {
    if (round === 2) await h.store.createMessage({ threadId: room.id, from: owner, body: 'Please do more work' });
    await h.store.createMessage({ threadId: room.id, from: worker, body: 'Working' });
    await turn(`Waiting for room ${round}`);
    await delay(150);
    assert.equal(delivered(`Waiting for room ${round}`), 0);
    const response = await h.app.inject({ method: 'POST', url: '/api/agent-bus/messages', headers: h.authHeaders,
      payload: { threadId: room.id, from: worker, body: `Room answer ${round}`, type: 'result' } });
    assert.equal(response.statusCode, 200);
    assert.ok(await settle(() => h.injected.claude.some((text) => text.includes(`Room answer ${round}`))));
    // A participant's ordinary message after its result does not renew the owner's work.
    await h.store.createMessage({ threadId: room.id, from: worker, body: 'Worker signing off' });
    await turn(`Coordinator room answer ${round}`);
    assert.ok(await settle(() => delivered(`Coordinator room answer ${round}`) === 1));
  }
  assert.deepEqual(results().filter((message) => message.metadata.dm).map((message) => message.body),
    ['Coordinator room answer 1', 'Coordinator room answer 2']);
});

for (const name of ['closed', 'ended', 'already has a result', 'DM', 'owned by someone else', 'created after the Stop']) {
  test(`a room ${name} does not hold a spawned result`, async (t) => {
    const { h, turn, delivered } = await setup(t, { spawnedBy: spawner });
    const owner = { kind: 'claude', sessionId: 'claude-2' };
    const room = await h.store.createThread({ title: 'Irrelevant room', participants: [],
      createdBy: name === 'owned by someone else' ? spawner : owner, metadata: { dm: name === 'DM' } });
    if (name === 'closed') await h.store.closeThread(room.id);
    if (name === 'ended') {
      const response = await h.app.inject({ method: 'POST', url: `/api/agent-bus/threads/${room.id}/end`, headers: h.authHeaders, payload: {} });
      assert.equal(response.statusCode, 200);
    }
    if (name === 'already has a result') await h.store.createMessage({ threadId: room.id, from: spawner, type: 'result', body: 'Done' });
    if (name === 'created after the Stop') {
      t.mock.method(Date, 'now', () => room.createdAt - 1000);
      try { await turn('Coordinator finished'); } finally { Date.now.mock.restore(); }
    } else await turn('Coordinator finished');
    assert.ok(await settle(() => delivered('Coordinator finished') === 1));
  });
}

test('replay does not return an earlier room-waiting Stop after its result arrives', async (t) => {
  const first = await setup(t, { spawnedBy: spawner });
  const room = await first.h.store.createThread({ title: 'Collaboration', participants: [],
    createdBy: { kind: 'claude', sessionId: 'claude-2' } });
  await first.turn('Waiting for room before restart');
  await delay(150);
  assert.equal(first.results().length, 0);
  await first.h.store.createMessage({ threadId: room.id, from: spawner, type: 'result', body: 'Room finished' });
  const second = await first.restart();
  await second.turn('Coordinator finished after room restart');
  assert.ok(await settle(() => second.delivered('Coordinator finished after room restart') === 1));
  assert.deepEqual(second.results().filter((message) => message.metadata.dm).map((message) => message.body),
    ['Coordinator finished after room restart']);
});

test('a spawned coordinator waits for its own worker result, including after a new worker prompt', async (t) => {
  const { h, hook, turn, results, delivered, sessions } = await setup(t, { spawnedBy: spawner });
  h.sessionCatalog.claude.add('worker');
  sessions.set('worker', { workDir: h.stateDir, metadata: { spawnedBy: { kind: 'claude', sessionId: 'claude-2' } } });
  await turn('Waiting before worker hooks exist');
  await delay(150);
  assert.equal(results().length, 0);
  for (const round of [1, 2]) {
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: `work ${round}` }, 'worker');
    await turn(`Waiting for worker ${round}`);
    await delay(150);
    assert.equal(delivered(`Waiting for worker ${round}`), 0);
    assert.equal(results().filter((message) => message.from.sessionId === 'claude-2').length, round - 1);
    await hook({ hook_event_name: 'Stop', last_assistant_message: `Worker answer ${round}` }, 'worker');
    assert.ok(await settle(() => results().some((message) => message.body === `Worker answer ${round}`)));
    await turn(`Coordinator answer ${round}`);
    assert.ok(await settle(() => delivered(`Coordinator answer ${round}`) === 1));
  }
  assert.deepEqual(results().filter((message) => message.from.sessionId === 'claude-2').map((message) => message.body),
    ['Coordinator answer 1', 'Coordinator answer 2']);
});

for (const [name, worker] of [
  ['not opted in', { metadata: {} }],
  ['ended', { endedAt: Date.now() }],
  ['ended lifecycle', { lifecycle: 'ended' }],
  ['created after the Stop', { created: Date.now() + 60_000 }],
  ['created after the Stop with an ISO timestamp', { createdAt: new Date(Date.now() + 60_000).toISOString() }],
  ['spawned by someone else', { metadata: { spawnedBy: spawner } }],
]) {
  test(`a worker ${name} does not hold a coordinator result`, async (t) => {
    const { h, turn, delivered, sessions } = await setup(t, { spawnedBy: spawner });
    h.sessionCatalog.claude.add('worker');
    sessions.set('worker', { workDir: h.stateDir,
      metadata: { spawnedBy: { kind: 'claude', sessionId: 'claude-2' } }, ...worker });
    await turn('Coordinator finished');
    assert.ok(await settle(() => delivered('Coordinator finished') === 1));
  });
}

test('a restart does not return an earlier waiting Stop after the worker result arrives', async (t) => {
  const first = await setup(t, { spawnedBy: spawner });
  const worker = { workDir: first.h.stateDir, metadata: { spawnedBy: { kind: 'claude', sessionId: 'claude-2' } } };
  first.h.sessionCatalog.claude.add('worker');
  first.sessions.set('worker', worker);
  await first.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'work' }, 'worker');
  await first.turn('Waiting before restart');
  await delay(150);
  assert.equal(first.results().length, 0);
  await first.hook({ hook_event_name: 'Stop', last_assistant_message: 'Worker finished' }, 'worker');
  assert.ok(await settle(() => first.results().some((message) => message.body === 'Worker finished')));
  const second = await first.restart();
  second.h.sessionCatalog.claude.add('worker');
  second.sessions.set('worker', worker);
  await second.turn('Coordinator finished after restart');
  assert.ok(await settle(() => second.delivered('Coordinator finished after restart') === 1));
  assert.deepEqual(second.results().map((message) => message.body), ['Worker finished', 'Coordinator finished after restart']);
});

test('a coordinator waits for a follow-up its worker has not started, but not for a failed one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-bus-audit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const audit = buildSessionDeliveryAuditStore({ storeFile: join(dir, 'audit.json') });
  const { h, hook, turn, results, delivered, sessions } = await setup(t, { spawnedBy: spawner }, null, audit);
  h.sessionCatalog.claude.add('worker');
  sessions.set('worker', { workDir: h.stateDir, metadata: { spawnedBy: { kind: 'claude', sessionId: 'claude-2' } } });
  const send = (transactionId, status) => audit.record({ source: 'monitor_send_to_session', kind: 'claude',
    sessionId: 'worker', text: 'Follow up', enter: true, status, metadata: { transactionId, operation: 'message' } });
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'work' }, 'worker');
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'Worker answer 1' }, 'worker');
  assert.ok(await settle(() => results().some((message) => message.body === 'Worker answer 1')));
  for (const status of ['queued', 'sent']) {
    await send('tx-1', status);
    await turn(`Waiting on ${status} follow-up`);
    await delay(150);
    assert.equal(delivered(`Waiting on ${status} follow-up`), 0);
  }
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'Follow up' }, 'worker');
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'Worker answer 2' }, 'worker');
  assert.ok(await settle(() => results().some((message) => message.body === 'Worker answer 2')));
  await turn('Coordinator answer');
  assert.ok(await settle(() => delivered('Coordinator answer') === 1));
  await send('tx-2', 'queued');
  await send('tx-2', 'failed');
  await turn('Coordinator after failed follow-up');
  assert.ok(await settle(() => delivered('Coordinator after failed follow-up') === 1));
  assert.equal(delivered('Waiting on'), 0);
});

test('a stale sent follow-up does not hold the coordinator result', async (t) => {
  const createdAt = new Date(Date.now() - 3 * 60_000).toISOString();
  const entries = [{ id: 'sdel_stale', source: 'monitor_send_to_session', target: { kind: 'claude', sessionId: 'worker' },
    status: 'sent', enter: true, createdAt, completedAt: createdAt, metadata: { transactionId: 'tx-lost', operation: 'message' } }];
  const audit = buildSessionDeliveryAuditStore({ stateStore: { load: async () => ({ entries }), save: async () => {} } });
  await audit.init();
  const { h, hook, turn, delivered, sessions } = await setup(t, { spawnedBy: spawner }, null, audit);
  h.sessionCatalog.claude.add('worker');
  sessions.set('worker', { workDir: h.stateDir, metadata: { spawnedBy: { kind: 'claude', sessionId: 'claude-2' } } });
  // The worker finished its last turn before the follow-up was sent, and never started the follow-up.
  const finishedAt = Date.now() - 4 * 60_000;
  t.mock.method(Date, 'now', () => finishedAt);
  try {
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'work' }, 'worker');
    await hook({ hook_event_name: 'Stop', last_assistant_message: '' }, 'worker');
  } finally { Date.now.mock.restore(); }
  await turn('Coordinator after lost follow-up');
  assert.ok(await settle(() => delivered('Coordinator after lost follow-up') === 1));
});

test('a worker that finishes with an empty answer does not hold the coordinator result', async (t) => {
  const { h, hook, turn, results, delivered, sessions } = await setup(t, { spawnedBy: spawner });
  h.sessionCatalog.claude.add('worker');
  sessions.set('worker', { workDir: h.stateDir, metadata: { spawnedBy: { kind: 'claude', sessionId: 'claude-2' } } });
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'work' }, 'worker');
  await hook({ hook_event_name: 'Stop', last_assistant_message: '' }, 'worker');
  await turn('Coordinator answer without worker result');
  assert.ok(await settle(() => delivered('Coordinator answer without worker result') === 1));
  assert.deepEqual(results().map((message) => message.body), ['Coordinator answer without worker result']);
});

test('a worker Stop with background tasks still holds the coordinator result', async (t) => {
  const { h, hook, turn, results, delivered, sessions } = await setup(t, { spawnedBy: spawner });
  h.sessionCatalog.claude.add('worker');
  sessions.set('worker', { workDir: h.stateDir, metadata: { spawnedBy: { kind: 'claude', sessionId: 'claude-2' } } });
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'work' }, 'worker');
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'Worker waiting',
    background_tasks: [{ task_id: 'task-1', status: 'running' }] }, 'worker');
  await turn('Coordinator waiting on background worker');
  await delay(150);
  assert.equal(results().length, 0);
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'Worker background finished', background_tasks: [] }, 'worker');
  await turn('Coordinator finished after background worker');
  assert.ok(await settle(() => delivered('Coordinator finished after background worker') === 1));
  assert.equal(delivered('Coordinator waiting on background worker'), 0);
});

test('replay after a restart skips Stops older than the replay window', async (t) => {
  const { h, turn, delivered, sessions } = await setup(t, {});
  await turn('Ancient answer');
  const { eventsPath } = await buildHookSessionPaths({ workDir: h.stateDir, provider: 'claude', sessionId: 'claude-2' });
  const old = new Date(Date.now() - 31 * 60_000).toISOString();
  await writeFile(eventsPath, (await readFile(eventsPath, 'utf8')).replace(/"loggedAt":"[^"]+"/g, `"loggedAt":"${old}"`));
  sessions.set('claude-2', { workDir: h.stateDir, metadata: { spawnedBy: spawner } });
  await turn('Fresh answer');
  assert.ok(await settle(() => delivered('Fresh answer') === 1));
  await delay(150);
  assert.equal(delivered('Ancient answer'), 0);
});

test('a spawned child returns each finished turn to its spawner once', async (t) => {
  const { turn, results, delivered } = await setup(t, { spawnedBy: spawner });
  await turn('First answer');
  assert.ok(await settle(() => delivered('First answer') === 1));
  await delay(150);
  assert.equal(results().length, 1);
  assert.deepEqual(results()[0].from, { kind: 'claude', sessionId: 'claude-2' });
  assert.equal(results()[0].metadata.dm, true);

  await turn('Second answer');
  assert.ok(await settle(() => delivered('Second answer') === 1));
  await delay(150);
  assert.equal(results().length, 2);
  assert.equal(delivered('First answer'), 1);

  // A repeated answer is a new turn's result, not a duplicate.
  await turn('Second answer');
  assert.ok(await settle(() => delivered('Second answer') === 2));
  assert.equal(results().length, 3);
});

test('a spawned child returns its result after changing into a nested git repo', async (t) => {
  const { h, hook, results, delivered } = await setup(t, { spawnedBy: spawner });
  const cwd = join(h.stateDir, 'repo');
  await mkdir(join(cwd, '.git'), { recursive: true });
  await hook({ cwd, hook_event_name: 'UserPromptSubmit', prompt: 'work' });
  await hook({ cwd, hook_event_name: 'Stop', last_assistant_message: 'Nested repo answer' });
  assert.ok(await settle(() => delivered('Nested repo answer') === 1));
  assert.deepEqual(results().map((message) => message.body), ['Nested repo answer']);
});

test('the benchmark worker returns only its 25:30 answer after background work finishes', async (t) => {
  // Reconstructed hooks: worker f832e1d3's hook log was deleted on termination.
  // Answers, Stop times and task IDs come from the real 7c1d0fdf-4b62-45c4-adbb-32feb9fe44a0
  // exp2/s4 transcript; background_tasks uses Claude 2.1.294's native in-flight snapshot shape.
  const stops = JSON.parse(await readFile(new URL('./fixtures/agent-bus/spawn-background-stops.json', import.meta.url), 'utf8'));
  const first = await setup(t, { spawnedBy: spawner });
  await first.hook({ hook_event_name: 'UserPromptSubmit', prompt: 'work' });
  for (const stop of stops.slice(0, -1)) {
    await first.hook(stop);
    await delay(150);
    assert.equal(first.results().length, 0);
  }
  // Replay must not return the skipped Stops, either.
  const second = await first.restart();
  await second.hook(stops.at(-1));
  assert.ok(await settle(() => second.delivered('All three tasks are done') === 1));
  await delay(150);
  assert.deepEqual(second.results().map((message) => message.body), [stops.at(-1).last_assistant_message]);
});

test('an empty background snapshot still returns every turn', async (t) => {
  const { hook, results, delivered } = await setup(t, { spawnedBy: spawner });
  for (const answer of ['Empty snapshot one', 'Empty snapshot two']) {
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'work' });
    await hook({ hook_event_name: 'Stop', last_assistant_message: answer, background_tasks: [] });
  }
  assert.ok(await settle(() => delivered('Empty snapshot one') === 1 && delivered('Empty snapshot two') === 1));
  assert.equal(results().length, 2);
});

test('a Stop followed at once by a new prompt still returns', async (t) => {
  const { hook, turn, results, delivered } = await setup(t, { spawnedBy: spawner });
  await turn('Answer before next prompt');
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'more' });
  await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  assert.ok(await settle(() => delivered('Answer before next prompt') === 1));
  await delay(150);
  assert.equal(results().length, 1);
});

test('two turns finished between observer passes both return', async (t) => {
  const { turn, delivered } = await setup(t, { spawnedBy: spawner });
  await turn('Turn one');
  await turn('Turn two');
  assert.ok(await settle(() => delivered('Turn one') === 1 && delivered('Turn two') === 1));
});

test('turns recorded within one clock millisecond each return once', async (t) => {
  const { turn, results, delivered } = await setup(t, { spawnedBy: spawner });
  const now = Date.now();
  const sameClock = async (fn) => { t.mock.method(Date, 'now', () => now); try { await fn(); } finally { Date.now.mock.restore(); } };
  await sameClock(async () => { await turn('Same clock one'); await turn('Same clock two'); });
  assert.ok(await settle(() => delivered('Same clock one') === 1 && delivered('Same clock two') === 1));
  // A later turn stamped with the same millisecond still counts as new hook output.
  await sameClock(() => turn('Same clock three'));
  assert.ok(await settle(() => delivered('Same clock three') === 1));
  await delay(150);
  assert.equal(results().length, 3);
});

test('a result waits while the spawner is unreachable and returns once it is back', async (t) => {
  const { h, turn, results, delivered } = await setup(t, { spawnedBy: spawner });
  h.sessionCatalog.codex.delete('codex-1');
  await turn('Held answer');
  await delay(300);
  assert.equal(results().length, 0);
  h.sessionCatalog.codex.add('codex-1');
  assert.ok(await settle(() => delivered('Held answer') === 1));
  await delay(150);
  assert.equal(results().length, 1);
});

test('a restarted agent bus replays hook history without returning a turn twice', async (t) => {
  const first = await setup(t, { spawnedBy: spawner });
  // Two turns, so replaying the first is not caught by the latest-result content dedupe.
  await first.turn('Before restart');
  await first.turn('Also before restart');
  assert.ok(await settle(() => first.delivered('Also before restart') === 1));
  const second = await first.restart();
  await second.turn('After restart');
  assert.ok(await settle(() => second.delivered('After restart') === 1));
  await delay(150);
  assert.equal(second.delivered('Before restart'), 0);
  assert.deepEqual(second.results().map((message) => message.body), ['Before restart', 'Also before restart', 'After restart']);
});

test('a long returned result arrives whole', async (t) => {
  const { turn, delivered, h } = await setup(t, { spawnedBy: spawner });
  await turn(`START ${'x'.repeat(1500)}`);
  assert.ok(await settle(() => delivered('START') === 1));
  assert.doesNotMatch(h.injected.codex.find((item) => item.includes('START')), /Body length:/);
});

test('a manual DM during the turn replaces that turn\'s result but not later ones', async (t) => {
  const { h, hook, turn, results, delivered } = await setup(t, { spawnedBy: spawner });
  await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'work' });
  const dm = await h.app.inject({ method: 'POST', url: '/api/agent-bus/dm', headers: h.authHeaders,
    payload: { from: { kind: 'claude', sessionId: 'claude-2' }, target: spawner, body: 'Manual report' } });
  assert.equal(dm.statusCode, 200);
  await hook({ hook_event_name: 'Stop', last_assistant_message: 'Done, reported by DM' });
  await delay(200);
  assert.equal(delivered('Done, reported by DM'), 0);
  assert.equal(results().length, 0);

  await turn('Follow-up answer');
  assert.ok(await settle(() => delivered('Follow-up answer') === 1));
});

test('sessions without a spawner return nothing', async (t) => {
  const { turn, results, h } = await setup(t, {});
  await turn('Human session answer');
  await delay(200);
  assert.equal(results().length, 0);
  assert.equal(h.store.listThreads().length, 0);
});

test('only an authenticated agent that opts in becomes the spawner', () => {
  const agent = { type: 'agent', kind: 'claude', sessionId: 'parent-1' };
  assert.deepEqual(spawnerMetadata(agent, { returnToSpawner: true }), { spawnedBy: { kind: 'claude', sessionId: 'parent-1' } });
  assert.equal(spawnerMetadata(agent, {}).spawnedBy, undefined);
  assert.equal(spawnerMetadata({ type: 'ui', kind: 'dashboard', sessionId: 'browser' }, { returnToSpawner: true }).spawnedBy, undefined);
  // A caller cannot name its own spawner.
  assert.equal({ spawnedBy: { kind: 'claude', sessionId: 'victim' }, ...spawnerMetadata(null, {}) }.spawnedBy, undefined);
});

for (const [name, args, count] of [['omitted', {}, 0], ['false', { returnResults: false }, 0], ['true', { returnResults: true }, 2]]) {
  test(`spawn_session with returnResults ${name} returns ${count} results`, async (t) => {
    let body;
    // Imported late: a static import changes the harness's auth setup for the earlier tests.
    const { buildMonitorMcpServer } = await import('../modules/platform/monitor-mcp.mjs');
    const mcp = buildMonitorMcpServer({ async requestImpl(path, opts) { body = opts.body; return { id: 'claude-2', provider: 'claude', backendType: 'claude' }; } });
    await mcp.handleToolCall('spawn_session', { provider: 'claude', workDir: '/tmp/project', ...args });
    const metadata = spawnerMetadata({ type: 'agent', kind: 'codex', sessionId: 'codex-1' }, body.metadata);
    assert.equal(Boolean(metadata.spawnedBy), count > 0);
    const { turn, results, delivered } = await setup(t, metadata);
    await turn('first');
    await turn('second');
    if (count) assert.equal(await settle(() => results().length === 2 && delivered('first') === 1 && delivered('second') === 1), true);
    await delay(200);
    assert.equal(results().length, count);
    assert.equal(delivered('first') + delivered('second'), count);
  });
}
