import webpush from 'web-push';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import { readEnv } from './cadre-env.mjs';

// Set by pushPlugin; session alert broadcasts call notifyPush after their 30s throttle.
let notifier = null;
export const notifyPush = (provider, alert) => notifier?.({
  title: `${provider.displayName}: ${alert.sessionName}`,
  body: alert.interaction?.detail || alert.reason || 'Waiting for your next prompt',
  url: alert.route,
  tag: `${provider.id}-${alert.sessionId}`, // same tag as the in-app alert, so they replace each other
});

const sendWebPush = (subscription, payload, vapidDetails) =>
  webpush.sendNotification(subscription, payload, { vapidDetails, TTL: 3600 });

export async function pushPlugin(app, {
  storeFile = runtimeStatePath('web_push.json'),
  send = sendWebPush,
  sendEnabled = true,
  subject = readEnv('DUENO_VAPID_SUBJECT') || 'https://github.com/BlaineHeffron/cadre',
} = {}) {
  const store = buildPostgresJsonStore({ namespace: 'web_push', filePath: storeFile, modeEnvKey: 'WEB_PUSH_STORAGE' });
  const state = { subscriptions: [], ...(await store.load()) };
  if (!state.vapid) {
    state.vapid = webpush.generateVAPIDKeys();
    await store.save(state);
  }
  const dropSubscriptions = (endpoints) => {
    state.subscriptions = state.subscriptions.filter((sub) => !endpoints.includes(sub.endpoint));
    return store.save(state);
  };

  notifier = !sendEnabled ? null : async (message) => {
    const payload = JSON.stringify(message);
    const gone = [];
    await Promise.all(state.subscriptions.map(async (sub) => {
      try {
        await send(sub, payload, { subject, ...state.vapid });
      } catch (err) {
        if (err?.statusCode === 404 || err?.statusCode === 410) gone.push(sub.endpoint);
        else app.log.warn({ err: err?.message, statusCode: err?.statusCode }, 'Web push send failed');
      }
    }));
    if (gone.length) await dropSubscriptions(gone).catch((err) => app.log.warn({ err }, 'Web push prune failed'));
  };

  app.get('/api/push/key', async () => ({ publicKey: state.vapid.publicKey }));

  app.post('/api/push/subscribe', async (req, reply) => {
    const { endpoint, keys } = req.body || {};
    if (!/^https:\/\//.test(String(endpoint)) || typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string') {
      return reply.code(400).send({ error: 'Invalid push subscription' });
    }
    state.subscriptions = [
      ...state.subscriptions.filter((sub) => sub.endpoint !== endpoint),
      { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
    ];
    await store.save(state);
    return reply.code(201).send({ ok: true });
  });

  app.delete('/api/push/subscribe', async (req) => {
    await dropSubscriptions([req.body?.endpoint]);
    return { ok: true };
  });
}
