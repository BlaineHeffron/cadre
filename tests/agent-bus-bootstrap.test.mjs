import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';
import { renderCollabOnboarding } from '../modules/agent-bus/protocol.mjs';

test('onboarding without a room channel omits collab workflow and tools', () => {
  const prompt = renderCollabOnboarding({ self: { kind: 'codex', sessionId: 'solo' }, busAvailable: false });
  assert.match(prompt, /This session has no shared room channel/);
  assert.doesNotMatch(prompt, /Workflow:|Coordinator findings|Unless your task says otherwise|room_send|DIRECTOR REPORT/);
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
  assert.doesNotMatch(h.injected.codex[0], /ack|manager.loop|wait for/i);
  for (const prompt of [h.injected.codex[0], h.injected.claude[0]]) {
    assert.match(prompt, /if you are assigned implementer or reviewer, the implementer writes code and tests; the reviewer blocks on correctness or unnecessary code\. Iterate until the reviewer approves/);
    assert.match(prompt, /Coordinator findings go through the reviewer/);
    assert.match(prompt, /implementer acts only on forwarded findings/);
    assert.match(prompt, /Unless your task says otherwise: do not merge or delete the remote branch; the coordinator or operator merges/);
    assert.match(prompt, /type="result".*reviewer starts the body with "DIRECTOR REPORT": PR number, head SHA, changes, test results, and deferred items/);
    assert.match(prompt, /<merged\|ready\|blocked\|needs-decision> · PR #n · <one line>/);
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

test('bootstrap failure cleans sessions created by the request', async (t) => {
  const h = await createAgentBusHarness(); t.after(() => h.cleanup());
  h.createResponders.claude = () => { throw new Error('create failed'); };
  const response = await h.app.inject({ method: 'POST', url: '/api/agent-bus/bootstrap', headers: h.authHeaders, payload: {
    title: 'Cleanup', participants: [
      { kind: 'codex', create: true }, { kind: 'claude', create: true },
    ],
  } });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(h.deletedSessions.codex, ['codex-new-1']);
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
