import webpush from 'web-push';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import { readEnv } from './cadre-env.mjs';

const MAX_SUBSCRIPTIONS = 20;
// Browser push services: FCM (Chrome/Android; desktop Chrome also issues jmt17.google.com), Firefox, Safari/iOS, Edge.
// Anything else would let an authenticated caller aim alert POSTs at arbitrary hosts.
const PUSH_SERVICE_HOST = /^(fcm\.googleapis\.com|jmt17\.google\.com)$|(^|\.)(push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;

// Set by pushPlugin; session alert broadcasts call notifyPush after their 30s throttle.
let notifier = null;
export const notifyPush = (provider, alert) => notifier?.({
  title: `${provider.displayName}: ${alert.sessionName}`,
  body: alert.interaction?.detail || alert.reason || 'Waiting for your next prompt',
  url: alert.route,
  tag: `${provider.id}-${alert.sessionId}`, // same tag as the in-app alert, so they replace each other
}, alert.status === 'blocked', `${provider.id}:${alert.sessionId}`); // client sessionMuteKey

const sendWebPush = (subscription, payload, vapidDetails) =>
  webpush.sendNotification(subscription, payload, { vapidDetails, TTL: 3600, timeout: 10000 });

function isPushEndpoint(endpoint) {
  const url = typeof endpoint === 'string' && endpoint.length <= 2048 && URL.canParse(endpoint) ? new URL(endpoint) : null;
  return url?.protocol === 'https:' && !url.username && !url.password && PUSH_SERVICE_HOST.test(url.hostname);
}

const isKey = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256;

export async function pushPlugin(app, {
  storeFile = runtimeStatePath('web_push.json'),
  send = sendWebPush,
  sendEnabled = true,
  subject = readEnv('DUENO_VAPID_SUBJECT') || 'https://github.com/BlaineHeffron/cadre',
} = {}) {
  const store = buildPostgresJsonStore({ namespace: 'web_push', filePath: storeFile, modeEnvKey: 'WEB_PUSH_STORAGE' });
  // Atomic read-modify-write (file lock / row lock) so concurrent writers cannot drop subscriptions.
  const update = (change) => store.mutate((current) => {
    const data = change({ subscriptions: [], ...current });
    return { data, result: data };
  });
  const { vapid } = await update((state) => ({ ...state, vapid: state.vapid || webpush.generateVAPIDKeys() }));
  const dropSubscriptions = (endpoints) => update((state) => ({
    ...state, subscriptions: state.subscriptions.filter((sub) => !endpoints.includes(sub.endpoint)),
  }));

  // Fire-and-forget from the alert loop, so it must never reject.
  notifier = !sendEnabled ? null : async (message, blocked, muteKey) => {
    try {
      const { subscriptions = [] } = (await store.load()) || {};
      const gone = [];
      const wanted = subscriptions.filter((sub) => (blocked || !sub.approvalOnly) && !sub.mutedSessions?.includes(muteKey));
      await Promise.all(wanted.map(async (sub) => {
        try {
          await send(sub, JSON.stringify({ ...message, silent: sub.silent === true }), { subject, ...vapid });
        } catch (err) {
          if (err?.statusCode === 404 || err?.statusCode === 410) gone.push(sub.endpoint);
          else app.log.warn({ err: err?.message, statusCode: err?.statusCode }, 'Web push send failed');
        }
      }));
      if (gone.length) await dropSubscriptions(gone);
    } catch (err) {
      app.log.warn({ err: err?.message }, 'Web push notify failed');
    }
  };

  app.get('/api/push/key', async () => ({ publicKey: vapid.publicKey }));

  app.post('/api/push/subscribe', async (req, reply) => {
    const { endpoint, keys, approvalOnly, mutedSessions, silent } = req.body || {};
    if (!isPushEndpoint(endpoint) || !isKey(keys?.p256dh) || !isKey(keys?.auth)) {
      return reply.code(400).send({ error: 'Invalid push subscription' });
    }
    const subscription = {
      endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      approvalOnly: approvalOnly === true,
      silent: silent === true,
      mutedSessions: Array.isArray(mutedSessions) ? mutedSessions.filter(isKey).slice(0, 1000) : [],
    };
    await update((state) => ({
      ...state,
      subscriptions: [...state.subscriptions.filter((sub) => sub.endpoint !== endpoint), subscription].slice(-MAX_SUBSCRIPTIONS),
    }));
    // sending: false on side-effects-disabled servers, so the client keeps its in-app notifications.
    return reply.code(201).send({ ok: true, sending: sendEnabled });
  });

  app.delete('/api/push/subscribe', async (req) => {
    await dropSubscriptions([req.body?.endpoint]);
    return { ok: true };
  });
}
