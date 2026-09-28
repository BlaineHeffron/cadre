import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { notifyPush, pushPlugin } from '../modules/platform/push.mjs';

const subscription = (id) => ({ endpoint: `https://push.example/${id}`, keys: { p256dh: `p256dh-${id}`, auth: `auth-${id}` } });

async function tempStoreFile(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-web-push-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'web_push.json');
}

async function startPush(t, storeFile, { failures = {}, ...opts } = {}) {
  const sent = [];
  const app = Fastify();
  t.after(() => app.close());
  await app.register(pushPlugin, {
    storeFile,
    subject: 'mailto:ops@example.com',
    async send(sub, payload, vapid) {
      sent.push({ endpoint: sub.endpoint, keys: sub.keys, message: JSON.parse(payload), vapid });
      if (failures[sub.endpoint]) throw Object.assign(new Error('push service error'), { statusCode: failures[sub.endpoint] });
    },
    ...opts,
  });
  return { app, sent };
}

const subscribe = (app, payload) => app.inject({ method: 'POST', url: '/api/push/subscribe', payload });

test('serves a persistent P-256 VAPID public key', async (t) => {
  const storeFile = await tempStoreFile(t);
  const first = await startPush(t, storeFile);
  const key = (await first.app.inject({ method: 'GET', url: '/api/push/key' })).json().publicKey;
  const raw = Buffer.from(key, 'base64url');
  assert.equal(raw.length, 65);
  assert.equal(raw[0], 4, 'uncompressed EC point');

  const restarted = await startPush(t, storeFile);
  assert.equal((await restarted.app.inject({ method: 'GET', url: '/api/push/key' })).json().publicKey, key);
});

test('subscribe validates, dedupes, persists, and unsubscribe removes', async (t) => {
  const storeFile = await tempStoreFile(t);
  const { app, sent } = await startPush(t, storeFile);

  assert.equal((await subscribe(app, { endpoint: 'http://push.example/a', keys: subscription('a').keys })).statusCode, 400);
  assert.equal((await subscribe(app, { endpoint: subscription('a').endpoint })).statusCode, 400);
  assert.equal((await subscribe(app, subscription('a'))).statusCode, 201);
  assert.equal((await subscribe(app, { ...subscription('a'), keys: subscription('a2').keys })).statusCode, 201);
  assert.equal((await subscribe(app, subscription('b'))).statusCode, 201);

  const del = await app.inject({ method: 'DELETE', url: '/api/push/subscribe', payload: { endpoint: subscription('b').endpoint } });
  assert.equal(del.statusCode, 200);

  const restarted = await startPush(t, storeFile);
  await notifyPush({ id: 'codex', displayName: 'Codex' }, { sessionId: 's1', sessionName: 'x', route: '/codex/s1' });
  assert.equal(sent.length, 0, 'the restarted plugin owns sending');
  assert.deepEqual(restarted.sent.map(({ endpoint, keys }) => ({ endpoint, keys })), [
    { endpoint: subscription('a').endpoint, keys: subscription('a2').keys },
  ]);
});

test('alerts are sent to every subscription and 404/410 subscriptions are pruned', async (t) => {
  const storeFile = await tempStoreFile(t);
  const gone = subscription('gone').endpoint;
  const missing = subscription('missing').endpoint;
  const flaky = subscription('flaky').endpoint;
  const { app, sent } = await startPush(t, storeFile, { failures: { [gone]: 410, [missing]: 404, [flaky]: 500 } });
  for (const id of ['ok', 'gone', 'missing', 'flaky']) await subscribe(app, subscription(id));
  const publicKey = (await app.inject({ method: 'GET', url: '/api/push/key' })).json().publicKey;

  const claude = { id: 'claude', displayName: 'Claude' };
  const alert = { sessionId: 's1', sessionName: 'build', reason: 'Needs input', interaction: { detail: 'Approve edit?' }, route: '/claude/s1' };
  const message = { title: 'Claude: build', body: 'Approve edit?', url: '/claude/s1', tag: 'claude-s1' };
  await notifyPush(claude, alert);
  assert.equal(sent.length, 4);
  for (const entry of sent) {
    assert.deepEqual(entry.message, message);
    assert.equal(entry.vapid.subject, 'mailto:ops@example.com');
    assert.equal(entry.vapid.publicKey, publicKey);
    assert.ok(entry.vapid.privateKey);
  }

  sent.length = 0;
  await notifyPush({ id: 'pi', displayName: 'Pi' }, { sessionId: 's2', sessionName: 'docs', route: '/pi/s2' });
  assert.deepEqual(sent[0].message, { title: 'Pi: docs', body: 'Waiting for your next prompt', url: '/pi/s2', tag: 'pi-s2' });
  assert.deepEqual(sent.map((entry) => entry.endpoint).sort(), [flaky, subscription('ok').endpoint].sort());
  const persisted = JSON.parse(await readFile(storeFile, 'utf8'));
  assert.deepEqual(persisted.subscriptions.map((sub) => sub.endpoint).sort(), [flaky, subscription('ok').endpoint].sort());
});

test('side-effects-disabled servers never send', async (t) => {
  const storeFile = await tempStoreFile(t);
  const { app, sent } = await startPush(t, storeFile, { sendEnabled: false });
  assert.equal((await subscribe(app, subscription('a'))).statusCode, 201);
  await notifyPush({ id: 'codex', displayName: 'Codex' }, { sessionId: 's1', sessionName: 'x', route: '/codex/s1' });
  assert.deepEqual(sent, []);
});
