// CHROMIUM_BIN=/path/to/chromium node --test tests/integration/web-push.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from 'playwright-core';

const openPort = () => new Promise((resolvePort) => {
  const server = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});

test('smoke server registers the service worker and shows a delivered push', {
  skip: !process.env.CHROMIUM_BIN, timeout: 60000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-web-push-smoke-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const [port, mcpPort] = [await openPort(), await openPort()];
  const token = 'web-push-smoke-token';
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    stdio: 'ignore',
    env: {
      ...process.env,
      HOME: dir,
      CADRE_STATE_DIR: join(dir, 'state'),
      APP_STATE_STORAGE: 'file',
      DATABASE_URL: '',
      TLS_ENABLED: '0',
      LOG_LEVEL: 'error',
      AUTH_TOKEN: token,
      INTERNAL_BYPASS_TOKEN: `${token}-bypass`,
      BROWSER_SESSION_SECRET: `${token}-session`,
      HOST: '127.0.0.1',
      PORT: String(port),
      AGENT_BUS_MCP_HTTP_HOST: '127.0.0.1',
      AGENT_BUS_MCP_HTTP_PORT: String(mcpPort),
      CADRE_DISABLE_SIDE_EFFECTS: '1',
      CADRE_GITHUB_AGENT_POLLER_ENABLED: '0',
      CADRE_GITHUB_AGENTS_ENABLED: '0',
      CADRE_SCHEDULED_AGENT_PUMP_ENABLED: '0',
      TELEGRAM_BRIDGE: '0',
    },
  });
  t.after(() => server.kill('SIGKILL'));
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    if (await fetch(`${origin}/sw.js`).then((res) => res.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.grantPermissions(['notifications'], { origin });
  assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { token } })).status(), 200);
  const key = await (await context.request.get(`${origin}/api/push/key`)).json();
  assert.equal(Buffer.from(key.publicKey, 'base64url').length, 65);

  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const registrationId = new Promise((resolveId) => cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
    const registration = registrations.find((r) => r.scopeURL === `${origin}/` && !r.isDeleted);
    if (registration) resolveId(registration.registrationId);
  }));
  await cdp.send('ServiceWorker.enable');
  await page.goto(origin);
  assert.equal(await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.active.scriptURL)), `${origin}/sw.js`);

  const deliver = async (message) => cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: await registrationId, data: JSON.stringify(message) });
  const notification = async (tag) => {
    for (let i = 0; i < 50; i += 1) {
      const [worker] = context.serviceWorkers();
      const shown = await worker?.evaluate(async (wanted) => {
        const [n] = await self.registration.getNotifications({ tag: wanted });
        return n ? { title: n.title, body: n.body, tag: n.tag, url: n.data?.url } : null;
      }, tag).catch(() => null);
      if (shown) return shown;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  };

  // Pushes are always shown, even with a Cadre tab open (the in-app path defers to push instead).
  const message = { title: 'Claude: build', body: 'Approve edit?', url: '/claude/s1', tag: 'claude-s1' };
  await deliver(message);
  assert.deepEqual(await notification(message.tag), message);

  // Without a push subscription, in-app alerts still show via the service worker (Android rejects `new Notification`).
  await page.evaluate(() => import('/app/notifications.mjs').then((m) => m.showNotification('Codex: tests', 'Ready', { tag: 'codex-s2', url: '/codex/s2', pushed: true })));
  assert.deepEqual(await notification('codex-s2'), { title: 'Codex: tests', body: 'Ready', tag: 'codex-s2', url: '/codex/s2' });
});
