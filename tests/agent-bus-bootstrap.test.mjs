import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';
import { renderCollabOnboarding } from '../modules/agent-bus/protocol.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exec } from '../lib/exec.mjs';
import { waitForStartupPane } from '../modules/agent/startup-input.mjs';
import { sendTmuxText } from '../modules/platform/tmux-input.mjs';

async function tmuxFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-startup-pane-'));
  const socket = join(dir, 'tmux');
  const run = (cmd, args, opts) => exec(cmd, ['-S', socket, ...args], opts);
  t.after(async () => { await run('tmux', ['kill-server']); await rm(dir, { recursive: true, force: true }); });
  return { dir, run };
}

test('startup waits for a real delayed pane before sending text', async (t) => {
  const { run } = await tmuxFixture(t);
  let probes = 0;
  const observe = (cmd, args, opts) => { probes++; return run(cmd, args, opts); };
  const pending = waitForStartupPane(observe, 'delayed', '', { attempts: 30, intervalMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const started = await run('tmux', ['new-session', '-d', '-s', 'delayed', 'cat']);
  assert.equal(started.code, 0, started.stderr);
  await pending;
  assert.ok(probes > 1);
  await sendTmuxText(run, { target: 'delayed', text: 'bootstrap received', delayMs: 0 });
  const pane = await run('tmux', ['capture-pane', '-p', '-t', 'delayed']);
  assert.match(pane.stdout, /bootstrap received/);
});

test('failed real launch closes the room, terminates created peers, and preserves attached sessions', async (t) => {
  const { dir, run } = await tmuxFixture(t);
  const log = join(dir, 'launch.log');
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  await run('tmux', ['new-session', '-d', '-s', 'attached', 'cat']);
  h.createResponders.codex = async () => {
    assert.equal((await run('tmux', ['new-session', '-d', '-s', 'created', 'cat'])).code, 0);
  };
  h.createResponders.claude = async () => {
    assert.equal((await run('tmux', ['new-session', '-d', '-s', 'failed', 'sh', '-c', `echo fixture-launch-error > '${log}'; exit 1`])).code, 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    try { await waitForStartupPane(run, 'failed', log, { attempts: 5, intervalMs: 20 }); }
    catch (err) { return { statusCode: 400, body: { error: err.message } }; }
  };
  h.inputResponders.codex = async ({ sessionId, text }) => {
    const target = sessionId === 'codex-1' ? 'attached' : 'created';
    await waitForStartupPane(run, target);
    await sendTmuxText(run, { target, text, delayMs: 0 });
  };
  h.deleteResponders.codex = async () => { await run('tmux', ['kill-session', '-t', 'created']); };
  const response = await h.app.inject({ method: 'POST', url: '/api/agent-bus/bootstrap', headers: h.authHeaders, payload: {
    participants: [{ kind: 'codex', create: true }, { kind: 'codex', sessionId: 'codex-1', create: false }, { kind: 'claude', create: true }],
  } });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().error, /Participant claude:/);
  assert.match(response.json().error, /fixture-launch-error/);
  assert.equal(h.store.listThreads().length, 1);
  assert.equal(h.store.listThreads()[0].status, 'closed');
  assert.equal(h.store.getThread(h.store.listThreads()[0].id).deliveries.some((d) => d.status === 'queued'), false);
  assert.deepEqual(h.deletedSessions.codex, [h.createdSessions.codex[0].sessionId]);
  assert.deepEqual(h.deletedSessions.claude, []);
  assert.notEqual((await run('tmux', ['has-session', '-t', 'created'])).code, 0);
  assert.equal((await run('tmux', ['has-session', '-t', 'attached'])).code, 0);
});

test('onboarding without a room channel omits collab workflow and tools', () => {
  const prompt = renderCollabOnboarding({ self: { kind: 'codex', sessionId: 'solo' }, busAvailable: false });
  assert.match(prompt, /This session has no shared room channel/);
  assert.doesNotMatch(prompt, /Workflow:|Coordinator findings|Unless your task says otherwise|room_send|DIRECTOR REPORT/);
});

test('collab onboarding includes the safe-wait rule on one line', () => {
  const prompt = renderCollabOnboarding({ self: { kind: 'codex', sessionId: 'implementer' } });
  assert.ok(prompt.split('\n').includes('Unless your task says otherwise: do not merge or delete the remote branch; the coordinator or operator merges.'));
  assert.ok(prompt.split('\n').includes('Wait on background jobs by exact PID (`wait <pid>`, `kill -0 <pid>`) or your harness\'s background-task tool; never poll `pgrep -f`/`pkill -f` with a pattern that also appears in your own command line.'));
});

test('bootstrap injects simplified room prompts without loop startup metadata', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  const response = await h.app.inject({ method: 'POST', url: '/api/agent-bus/bootstrap', headers: h.authHeaders, payload: {
    title: 'Collab', initialTask: 'Build it', participants: [
      { kind: 'codex', sessionId: 'codex-1', role: 'implementer' },
      { kind: 'claude', sessionId: 'claude-1', role: 'reviewer' },
    ],
  } });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  assert.equal(body.bootstrapOk, true);
  assert.equal(body.messages.length, 2);
  assert.equal(body.deliveries.every((item) => item.status === 'injected'), true);
  assert.equal('startupMode' in body.thread.metadata, false);
  assert.deepEqual(body.thread.createdBy, { kind: 'operator', sessionId: 'bearer' });
  assert.equal(body.thread.participants.some((item) => item.kind === 'operator'), false);
  const listed = await h.app.inject({
    method: 'GET',
    url: '/api/agent-bus/threads/by-participant?kind=operator&sessionId=bearer&status=all',
    headers: h.authHeaders,
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().threads.some((thread) => thread.id === body.thread.id), true);
  const sent = await h.app.inject({
    method: 'POST', url: '/api/agent-bus/messages', headers: h.authHeaders,
    payload: { threadId: body.thread.id, from: { kind: 'operator', sessionId: 'bearer' }, body: 'coord note' },
  });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.match(h.injected.codex[0], /room_send/);
  assert.match(h.injected.codex[0], /Begin working now/);
  assert.doesNotMatch(h.injected.codex[0], /\back\b|manager.loop|wait for/i);
  for (const prompt of [h.injected.codex[0], h.injected.claude[0]]) {
    assert.match(prompt, /if you are assigned implementer or reviewer, the implementer writes code and tests; the reviewer blocks on correctness or unnecessary code\. Iterate until the reviewer approves/);
    assert.match(prompt, /Coordinator findings go through the reviewer/);
    assert.match(prompt, /implementer acts only on forwarded findings/);
    assert.match(prompt, /Unless your task says otherwise: do not merge or delete the remote branch; the coordinator or operator merges/);
    assert.match(prompt, /type="result".*reviewer starts the body with "DIRECTOR REPORT": PR number, head SHA, changes, test results, and deferred items/);
    assert.match(prompt, /<merged\|ready\|blocked\|needs-decision\|continues> · PR #n · <one line>"; continues means this PR is done and the room keeps working on further PRs\./);
    assert.match(prompt, /any agent may read, post, close or reopen without subscribing/);
    assert.match(prompt, /Action tools return ids and status only/);
  }
  assert.match(h.injected.codex[0], /your assigned role is implementer/);
  assert.match(h.injected.claude[0], /your assigned role is reviewer/);
});

test('bootstrap plans all participants before creating any session', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  const response = await h.app.inject({ method: 'POST', url: '/api/agent-bus/bootstrap', headers: h.authHeaders, payload: {
    title: 'Invalid', participants: [
      { kind: 'codex', create: true },
      { kind: 'missing-provider', create: true },
    ],
  } });
  assert.equal(response.statusCode, 400);
  assert.equal(h.createdSessions.codex.length, 0);
});

test('bootstrap applies Codex plugin selection only to created Codex participants', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  const codexPlugins = { add: ['browser@openai-bundled'] };
  const response = await h.app.inject({ method: 'POST', url: '/api/agent-bus/bootstrap', headers: h.authHeaders, payload: {
    title: 'Browser collab', codexPlugins, participants: [
      { kind: 'codex', create: true }, { kind: 'claude', create: true },
    ],
  } });

  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(h.createdSessions.codex[0].codexPlugins, codexPlugins);
  assert.equal(Object.hasOwn(h.createdSessions.claude[0], 'codexPlugins'), false);
});

test('bootstrap forwards an explicit sandbox only to Claude and Codex participants and omits it by default', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  await h.setProviderPreferences({ claudeEnabled: true, codexEnabled: true, xaiEnabled: true });
  const bootstrap = (payload) => h.app.inject({ method: 'POST', url: '/api/agent-bus/bootstrap', headers: h.authHeaders, payload });
  const pair = [{ kind: 'codex', create: true }, { kind: 'claude', create: true }];

  assert.equal((await bootstrap({ title: 'Default', participants: pair })).statusCode, 200);
  assert.equal(Object.hasOwn(h.createdSessions.codex[0], 'sandbox'), false);
  assert.equal((await bootstrap({ title: 'Sandboxed', sandbox: 'nono', participants: pair })).statusCode, 200);
  assert.deepEqual([h.createdSessions.codex[1].sandbox, h.createdSessions.claude[1].sandbox], ['nono', 'nono']);

  const pi = await bootstrap({ title: 'Pi', sandbox: 'nono', participants: [...pair, { kind: 'xai', model: 'grok-4.3', create: true }] });
  assert.deepEqual([pi.statusCode, pi.json().code], [400, 'sandbox_unsupported']);
  assert.equal(h.createdSessions.codex.length, 2);
});

test('bootstrap failure cleans sessions created by the request', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  h.createResponders.claude = () => { throw new Error('create failed'); };
  const response = await h.app.inject({ method: 'POST', url: '/api/agent-bus/bootstrap', headers: h.authHeaders, payload: {
    title: 'Cleanup', participants: [
      { kind: 'codex', create: true }, { kind: 'claude', create: true },
    ],
  } });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(h.deletedSessions.codex, [h.createdSessions.codex[0].sessionId]);
  assert.equal(h.store.listThreads().length, 1);
  assert.equal(h.store.listThreads()[0].status, 'closed');
});

test('bootstrap forwards the automated structured-runtime request to created sessions only', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  const response = await h.app.inject({ method: 'POST', url: '/api/agent-bus/bootstrap', headers: h.authHeaders, payload: {
    title: 'Structured collab', structured: true, participants: [{ kind: 'codex', create: true }, { kind: 'claude', create: true }],
  } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual([h.createdSessions.codex[0].structured, h.createdSessions.claude[0].structured], [true, true]);
  const plain = await h.app.inject({ method: 'POST', url: '/api/agent-bus/bootstrap', headers: h.authHeaders, payload: {
    title: 'Plain collab', participants: [{ kind: 'codex', create: true }, { kind: 'claude', create: true }],
  } });
  assert.equal(plain.statusCode, 200, plain.body);
  assert.equal(Object.hasOwn(h.createdSessions.codex[1], 'structured'), false);
});


test('bootstrap rolls back a backend that ignores its reserved session identity', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  h.createResponders.claude = (body) => { body.sessionId = 'deadbeef'; };
  const response = await h.app.inject({ method: 'POST', url: '/api/agent-bus/bootstrap', headers: h.authHeaders,
    payload: { participants: [{ kind: 'codex', create: true }, { kind: 'claude', create: true }] } });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.json().error, /Participant claude: create ignored reserved sessionId/);
  assert.deepEqual(h.deletedSessions.codex, [h.createdSessions.codex[0].sessionId]);
  assert.deepEqual(h.deletedSessions.claude, ['deadbeef']);
  assert.equal(h.store.listThreads()[0].status, 'closed');
  assert.equal(h.store.getThread(h.store.listThreads()[0].id).deliveries.some((delivery) => delivery.status === 'queued'), false);
});
