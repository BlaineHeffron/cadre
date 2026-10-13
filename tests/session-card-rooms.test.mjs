import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';

test('session card lists only the open rooms the session is in', { skip: !process.env.CHROMIUM_BIN }, async (t) => {
  const member = [{ kind: 'codex', sessionId: 'one' }];
  const threads = [
    { id: 'thr_open', title: 'open room', status: 'open', participants: member },
    { id: 'thr_closed', title: 'closed room', status: 'closed', participants: member },
    { id: 'thr_other', title: 'other room', status: 'open', participants: [{ kind: 'codex', sessionId: 'two' }] },
  ];
  const app = Fastify();
  t.after(() => app.close());
  const root = fileURLToPath(new URL('../', import.meta.url));
  await app.register(fastifyStatic, { root: `${root}public`, prefix: '/' });
  await app.register(fastifyStatic, { root: `${root}node_modules`, prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(`${root}public/index.html`, 'utf8');
  app.get('/card-fixture', (_req, reply) => reply.type('text/html').send(index.replace(
    '<script type="module" src="/app/app.mjs"></script>',
    `<script type="module">
      import { h, render } from 'preact';
      import { agentThreads } from '/app/state.mjs';
      import { SessionCard } from '/components/session-card.mjs';
      agentThreads.value = ${JSON.stringify(threads)};
      render(h(SessionCard, { session: { id: 'one', displayName: 'worker' }, provider: 'codex' }), document.getElementById('app'));
    </script>`,
  )));
  app.get('/api/*', () => ({}));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(`${origin}/card-fixture`);
  const card = page.locator('.session-card');
  await card.getByText('open room', { exact: true }).waitFor();
  assert.equal(await card.getByText('closed room', { exact: true }).count(), 0);
  assert.equal(await card.getByText('other room', { exact: true }).count(), 0);
});
