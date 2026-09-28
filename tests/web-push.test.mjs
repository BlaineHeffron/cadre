import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateBackup, restoreStateBackup } from '../modules/ops/backup.mjs';
import { notifyPush, pushPlugin } from '../modules/platform/push.mjs';

const subscription = (id) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, keys: { p256dh: `p256dh-${id}`, auth: `auth-${id}` } });

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

  const keys = subscription('a').keys;
  for (const endpoint of [
    'http://fcm.googleapis.com/fcm/send/a',
    'https://127.0.0.1/push',
    'https://internal.corp/push',
    'https://fcm.googleapis.com.evil.test/a',
    'https://user:pw@fcm.googleapis.com/fcm/send/a',
    `https://fcm.googleapis.com/${'x'.repeat(2048)}`,
    ['https://fcm.googleapis.com/fcm/send/a'],
    'not a url',
  ]) {
    assert.equal((await subscribe(app, { endpoint, keys })).statusCode, 400, String(endpoint).slice(0, 60));
  }
  assert.equal((await subscribe(app, { endpoint: subscription('a').endpoint })).statusCode, 400);
  assert.equal((await subscribe(app, { ...subscription('a'), keys: { ...keys, auth: 'x'.repeat(257) } })).statusCode, 400);
  for (const endpoint of [
    'https://jmt17.google.com/fcm/send/a',
    'https://updates.push.services.mozilla.com/wpush/v2/a',
    'https://web.push.apple.com/a',
    'https://wns2-par02p.notify.windows.com/w/?token=a',
  ]) {
    assert.equal((await subscribe(app, { endpoint, keys })).statusCode, 201, endpoint);
    await app.inject({ method: 'DELETE', url: '/api/push/subscribe', payload: { endpoint } });
  }
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

test('keeps only the newest 20 subscriptions', async (t) => {
  const storeFile = await tempStoreFile(t);
  const { app, sent } = await startPush(t, storeFile);
  for (let i = 0; i < 25; i += 1) assert.equal((await subscribe(app, subscription(`d${i}`))).statusCode, 201);
  await notifyPush({ id: 'codex', displayName: 'Codex' }, { sessionId: 's1', sessionName: 'x', route: '/codex/s1' });
  assert.deepEqual(sent.map((entry) => entry.endpoint).sort(), Array.from({ length: 20 }, (_, i) => subscription(`d${i + 5}`).endpoint).sort());
});

test('approval-only subscriptions get pushes only for blocked sessions', async (t) => {
  const storeFile = await tempStoreFile(t);
  const { app, sent } = await startPush(t, storeFile);
  await subscribe(app, { ...subscription('all') });
  await subscribe(app, { ...subscription('approvals'), approvalOnly: true });
  const codex = { id: 'codex', displayName: 'Codex' };
  await notifyPush(codex, { sessionId: 's1', sessionName: 'x', status: 'ready', route: '/codex/s1' });
  assert.deepEqual(sent.map((entry) => entry.endpoint), [subscription('all').endpoint]);
  sent.length = 0;
  await notifyPush(codex, { sessionId: 's1', sessionName: 'x', status: 'blocked', route: '/codex/s1' });
  assert.deepEqual(sent.map((entry) => entry.endpoint).sort(), [subscription('all').endpoint, subscription('approvals').endpoint].sort());
});

test('default state backup restores the VAPID key and subscriptions', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'cadre-web-push-backup-'));
  const restoreDir = await mkdtemp(join(tmpdir(), 'cadre-web-push-restore-'));
  t.after(() => Promise.all([workspace, restoreDir].map((dir) => rm(dir, { recursive: true, force: true }))));
  const original = await startPush(t, join(workspace, '.dueno/state/web_push.json'));
  await subscribe(original.app, subscription('phone'));
  const key = (await original.app.inject({ method: 'GET', url: '/api/push/key' })).json().publicKey;

  const manifest = await createStateBackup({ workspaceDir: workspace, outputDir: join(workspace, 'backups'), databaseUrl: '', env: {} });
  const restored = await restoreStateBackup({ backupDir: manifest.backupDir, workspaceDir: restoreDir });
  assert.equal(restored.ok, true);

  const { app, sent } = await startPush(t, join(restoreDir, '.dueno/state/web_push.json'));
  assert.equal((await app.inject({ method: 'GET', url: '/api/push/key' })).json().publicKey, key);
  await notifyPush({ id: 'pi', displayName: 'Pi' }, { sessionId: 's1', sessionName: 'x', route: '/pi/s1' });
  assert.deepEqual(sent.map((entry) => entry.endpoint), [subscription('phone').endpoint]);
});
