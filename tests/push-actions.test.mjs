import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import Fastify from 'fastify';
import { createSessionCommandGate } from '../modules/session-state/command-gate.mjs';
import { createSessionStateTracker } from '../modules/session-state/tracker.mjs';
import { config } from '../config.mjs';
import { authPlugin, BROWSER_SESSION_COOKIE, createBrowserSessionCookieValue } from '../modules/platform/auth.mjs';

test('queue pushes and service-worker actions use the authenticated queue answer path', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-push-actions-'));
  const previousDir = process.env.CADRE_STATE_DIR;
  const previousSecret = config.auth.browserSessionSecret;
  process.env.CADRE_STATE_DIR = dir;
  config.auth.browserSessionSecret = 'push-action-test-secret';
  t.after(async () => {
    if (previousDir === undefined) delete process.env.CADRE_STATE_DIR;
    else process.env.CADRE_STATE_DIR = previousDir;
    config.auth.browserSessionSecret = previousSecret;
    await rm(dir, { recursive: true, force: true });
  });
  const { pushPlugin, notifyPush } = await import('../modules/platform/push.mjs');
  const { commandCenterAIPlugin, answerHumanQueueItem, closeStaleSessionQueueItems } = await import('../modules/integrations/command-center-ai.mjs');
  const app = Fastify();
  t.after(() => app.close());
  let interactionGate;
  const sent = [], commands = [], opened = [], responses = [];
  let pushed;
  let nextPush = new Promise((resolve) => { pushed = resolve; });
  await app.register(authPlugin, { token: 'fixture', internalBypassToken: 'fixture-bypass' });
  await app.register(pushPlugin, {
    storeFile: join(dir, 'push.json'), subject: 'mailto:test@example.com',
    send: async (_sub, payload) => { sent.push(JSON.parse(payload)); pushed(); },
  });
  await app.register(commandCenterAIPlugin, { enqueueSessionCommand: async (kind, sessionId, input) => {
    if (interactionGate) return interactionGate.enqueue(sessionId, input);
    commands.push({ kind, sessionId, ...input });
    return { ok: true };
  } });
  const headers = { cookie: `${BROWSER_SESSION_COOKIE}=${createBrowserSessionCookieValue()}` };
  const request = (method, url, payload) => app.inject({ method, url, payload, headers });
  assert.equal((await request('POST', '/api/push/subscribe', {
    endpoint: 'https://fcm.googleapis.com/fcm/send/fixture', keys: { p256dh: 'fixture', auth: 'fixture' },
  })).statusCode, 201);
  const handlers = {};
  let notification;
  vm.runInNewContext(await readFile(new URL('../public/sw.js', import.meta.url), 'utf8'), {
    self: {
      addEventListener: (name, handler) => { handlers[name] = handler; },
      registration: { showNotification: async (title, options) => { notification = { title, ...options }; } },
      clients: { matchAll: async () => [], openWindow: async (url) => { opened.push(url); } },
    },
    fetch: async (url, options = {}) => {
      const response = await request(options.method || 'GET', url, options.body ? JSON.parse(options.body) : undefined);
      responses.push({ url, status: response.statusCode });
      return { ok: response.statusCode < 400, json: async () => response.json() };
    },
  });
  async function event(name, fields) {
    let finished;
    handlers[name]({ ...fields, waitUntil: (promise) => { finished = promise; } });
    await finished;
  }
  async function show(message) {
    await event('push', { data: { json: () => message } });
  }
  async function click(action = '') {
    await event('notificationclick', { action, notification: { ...notification, close() {} } });
  }
  const created = await request('POST', '/api/command-center/work-queue', {
    question: 'Which plan?', options: ['Continue', 'Stop', 'Later'], passThrough: true, sessionKind: 'codex', sessionId: 'worker',
  });
  assert.equal(created.statusCode, 200);
  const item = created.json();
  await nextPush;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, `/queue?item=${item.id}`);
  assert.deepEqual(sent[0].actions, [{ action: 'option_1', title: 'Continue' }, { action: 'option_2', title: 'Stop' }]);
  await show(sent[0]);
  await click();
  assert.deepEqual(opened, [sent[0].url]);
  await click('option_1');
  assert.equal(commands.length, 1);
  assert.match(commands[0].text, /Continue/);
  const answered = (await request('GET', '/api/command-center/work-queue?status=all')).json().items.find((entry) => entry.id === item.id);
  assert.equal(answered.status, 'routed');
  await click('option_2');
  assert.equal(commands.length, 1, 'already answered action is ignored');
  assert.equal(opened.length, 2, 'stale action opens queue for review');
  assert.equal((await request('POST', `/api/command-center/work-queue/${item.id}/answer`, { optionId: 'option_2' })).statusCode, 409);
  assert.equal(sent.length, 1, 'answer broadcasts do not notify again');

  nextPush = new Promise((resolve) => { pushed = resolve; });
  const alert = { sessionId: 'waiting', sessionName: 'Waiting worker', status: 'blocked', interaction: {
    kind: 'selection', fingerprint: 'original-dialog', detail: 'Choose next step', options: [{ key: '1', label: 'Proceed' }, { key: '2', label: 'Cancel' }],
  } };
  await Promise.all([notifyPush({ id: 'codex', displayName: 'Codex' }, alert), notifyPush({ id: 'codex', displayName: 'Codex' }, alert)]);
  await nextPush;
  assert.equal(sent.length, 2, 'concurrent waiting alerts create one queue push');
  await assert.rejects(answerHumanQueueItem(sent[1].queueItemId, { optionId: '1' }, {
    principal: { type: 'agent', kind: 'codex', sessionId: 'other-agent' },
  }), (error) => error.statusCode === 403);
  const pendingTracker = createSessionStateTracker();
  const pendingAt = Date.now();
  pendingTracker.observe('waiting', [
    { source: 'process', kind: 'lifecycle', value: { lifecycle: 'running' }, observedAt: pendingAt, expiresAt: 0, fingerprint: 'running' },
    { source: 'pane', kind: 'screen', value: { execution: 'idle', kind: 'selection' }, observedAt: pendingAt, expiresAt: 0, fingerprint: 'original-dialog' },
  ]);
  const pending = pendingTracker.get('waiting');
  assert.equal(pending.capabilities.canAnswerInteraction, true);
  await closeStaleSessionQueueItems('codex', 'waiting', pending.capabilities.canAnswerInteraction ? pending.interaction.fingerprint : null);
  assert.equal((await request('GET', '/api/command-center/work-queue')).json().items.find((entry) => entry.id === sent[1].queueItemId).status, 'open');
  await show(sent[1]);
  await click('2');
  assert.deepEqual(commands[1], {
    kind: 'codex', sessionId: 'waiting', source: 'command_center_queue_answer', operation: 'interaction',
    keys: ['Down', 'Enter'], expectedFingerprint: 'original-dialog', expectedInteractionKind: 'selection',
  });
  nextPush = new Promise((resolve) => { pushed = resolve; });
  await notifyPush({ id: 'codex', displayName: 'Codex' }, alert);
  await nextPush;
  assert.equal(sent.length, 3, 're-raised dialog creates a new queue item');
  assert.notEqual(sent[1].queueItemId, sent[2].queueItemId);
  nextPush = new Promise((resolve) => { pushed = resolve; });
  await notifyPush({ id: 'codex', displayName: 'Codex' }, {
    ...alert, interaction: { ...alert.interaction, fingerprint: 'new-dialog' },
  });
  await nextPush;
  await closeStaleSessionQueueItems('codex', 'waiting', 'different-dialog');
  const stale = (await request('GET', '/api/command-center/work-queue?status=all')).json().items.find((entry) => entry.id === sent[3].queueItemId);
  assert.equal(stale.status, 'dismissed');
  assert.equal(commands.length, 2, 'closing stale dialog never sends terminal input');
  await show(sent[3]);
  await click('1');
  assert.equal(commands.length, 2);
  assert.equal((await request('POST', `/api/command-center/work-queue/${stale.id}/answer`, { optionId: '1' })).statusCode, 409);
  // The queue route retains the original identity; the real gate rejects a changed pane.
  const tracker = createSessionStateTracker();
  const now = Date.now();
  tracker.observe('changed', [
    { source: 'process', kind: 'lifecycle', value: { lifecycle: 'running' }, observedAt: now, expiresAt: 0, fingerprint: 'running' },
    { source: 'pane', kind: 'screen', value: { execution: 'idle', kind: 'selection' }, observedAt: now, expiresAt: 0, fingerprint: 'live-dialog' },
  ]);
  interactionGate = createSessionCommandGate({ tracker });
  interactionGate.register('changed', {
    refresh: async () => ({ canonicalState: tracker.get('changed') }),
    execute: async () => { assert.fail('stale interaction must never reach terminal execution'); },
  });
  t.after(() => interactionGate.unregister('changed'));
  nextPush = new Promise((resolve) => { pushed = resolve; });
  await notifyPush({ id: 'codex', displayName: 'Codex' }, { ...alert, sessionId: 'changed' });
  await nextPush;
  await show(sent.at(-1));
  const openedBefore = opened.length;
  await click('1');
  const failed = (await request('GET', '/api/command-center/work-queue?status=all')).json().items.find((entry) => entry.id === sent.at(-1).queueItemId);
  assert.equal(failed.status, 'delivery_failed');
  assert.match(failed.deliveryError, /Interaction changed/);
  assert.equal(opened.length, openedBefore + 1, 'delivery failure opens queue for review');
  assert.ok(responses.some((response) => response.url.endsWith('/answer') && response.status === 200));
});
