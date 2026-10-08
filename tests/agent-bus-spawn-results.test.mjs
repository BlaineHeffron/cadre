import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { recordHookPayload, registerHookSessionRegistry } from '../modules/agent/hook-events.mjs';
import { spawnerMetadata } from '../modules/agent-bus/coordinator-policy.mjs';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';

const spawner = { kind: 'codex', sessionId: 'codex-1' };
const settle = async (done) => { for (let i = 0; i < 200 && !done(); i++) await delay(20); return done(); };

async function setup(t, metadata) {
  const h = await createAgentBusHarness({ pollMs: 20 });
  // Hook files live under the nearest git root, so pin it to this test's directory.
  await mkdir(join(h.stateDir, '.git'));
  h.sessionCatalog.claude.add('claude-2');
  const sessions = new Map([['claude-2', { workDir: h.stateDir, metadata }]]);
  const unregister = registerHookSessionRegistry('claude', () => sessions);
  t.after(async () => { unregister(); await h.cleanup(); });
  const hook = (payload) => recordHookPayload({ session_id: 'cli-2', cwd: h.stateDir, ...payload },
    { provider: 'claude', duenoSessionId: 'claude-2' });
  const turn = async (answer) => {
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'work' });
    await hook({ hook_event_name: 'Stop', last_assistant_message: answer });
  };
  const results = () => h.store.listMessages().filter((message) => message.type === 'result');
  const delivered = (text) => h.injected.codex.filter((item) => item.includes(text)).length;
  return { h, hook, turn, results, delivered };
}

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
