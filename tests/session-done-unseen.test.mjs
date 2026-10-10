import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';
import { createSessionStateTracker } from '../modules/session-state/tracker.mjs';
import { projectCompatibility } from '../modules/session-state/contract.mjs';
import { observeTranscriptContent } from '../modules/session-state/providers/transcript.mjs';

function fixture() {
  let now = 1_000;
  const tracker = createSessionStateTracker({ now: () => now });
  const observe = (execution) => tracker.observe('codex:one', [
    { source: 'protocol', kind: 'lifecycle', value: { lifecycle: 'running' }, observedAt: now, expiresAt: 0, fingerprint: 'process' },
    { source: 'protocol', kind: 'execution', value: { execution }, observedAt: now, expiresAt: 0, fingerprint: execution },
    { source: 'protocol', kind: 'interaction', value: { kind: 'free_text', stable: true }, observedAt: now, expiresAt: 0, fingerprint: 'prompt' },
  ]);
  return { tracker, observe, advance: () => { now += 1_000; } };
}

function completedSession() {
  const f = fixture();
  f.observe('working');
  f.advance();
  return { id: 'one', state: projectCompatibility(f.observe('idle')) };
}

test('tracker records completed turns without changing capabilities or inventing turns on refresh', () => {
  const f = fixture();
  assert.equal(f.observe('idle').completedTurnAt, 0);
  f.advance();
  f.observe('working');
  f.advance();
  const finished = f.observe('idle');
  assert.equal(finished.status, 'ready');
  assert.equal(finished.completedTurnAt, 3_000);
  assert.equal(finished.capabilities.canSendNow, true);
  f.advance();
  assert.equal(f.observe('idle').completedTurnAt, finished.completedTurnAt);
  assert.equal(f.tracker.get('codex:one').completedTurnAt, finished.completedTurnAt);
  f.observe('thinking');
  f.advance();
  assert.equal(f.observe('idle').completedTurnAt, 5_000);
});

test('historical terminal evidence uses fact time rather than capture time', () => {
  let now = 10_000;
  const tracker = createSessionStateTracker({ now: () => now });
  const transcript = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Finished' }] } });
  const read = () => tracker.observe('codex:history', observeTranscriptContent(transcript, { provider: 'codex', observedAt: now, writtenAt: 2_000 }));
  assert.equal(read().completedTurnAt, 2_000);
  now = 20_000;
  assert.equal(read().completedTurnAt, 2_000);
  now = 100_000;
  assert.equal(tracker.get('codex:history').completedTurnAt, 2_000);
});

test('viewing a completed turn persists only on that client; another turn becomes unseen', async (t) => {
  const original = globalThis.localStorage;
  t.after(() => { if (original === undefined) delete globalThis.localStorage; else globalThis.localStorage = original; });
  const device = () => {
    const values = new Map();
    return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  };
  const firstStorage = device();
  globalThis.localStorage = firstStorage;
  const first = await import('../public/app/state.mjs?done-client=first');
  globalThis.localStorage = device();
  const second = await import('../public/app/state.mjs?done-client=second');
  const session = completedSession();
  first.setCodexSessions([session]);
  second.setCodexSessions([session]);
  assert.equal(first.sessionDisplayStatus('codex', session), 'done');
  assert.equal(second.unseenDoneCount.value, 1);
  globalThis.localStorage = firstStorage;
  first.markSessionTurnSeen('codex', session);
  assert.equal(first.sessionDisplayStatus('codex', session), 'ready');
  assert.equal(first.unseenDoneCount.value, 0);
  assert.equal(second.sessionDisplayStatus('codex', session), 'done');
  const reloaded = await import('../public/app/state.mjs?done-client=reloaded');
  assert.equal(reloaded.sessionDisplayStatus('codex', session), 'ready');
  assert.equal(first.sessionDisplayStatus('claude', session), 'done');
  const next = { ...session, state: { ...session.state, completedTurnAt: session.state.completedTurnAt + 1 } };
  assert.equal(first.sessionDisplayStatus('codex', next), 'done');
});

test('real session view clears the Done card and badge on only one browser device', { skip: !process.env.CHROMIUM_BIN }, async (t) => {
  const session = completedSession();
  const app = Fastify();
  t.after(() => app.close());
  const root = fileURLToPath(new URL('../', import.meta.url));
  await app.register(fastifyStatic, { root: `${root}public`, prefix: '/' });
  await app.register(fastifyStatic, { root: `${root}node_modules`, prefix: '/vendor/npm/', decorateReply: false });
  const index = await readFile(`${root}public/index.html`, 'utf8');
  app.get('/done-fixture', (_req, reply) => reply.type('text/html').send(index.replace(
    '<script type="module" src="/app/app.mjs"></script>',
    `<script type="module">
      import { h, render } from 'preact';
      import { useState } from 'preact/hooks';
      import { setCodexSessions } from '/app/state.mjs';
      import { Nav } from '/components/nav.mjs';
      import { SessionCard } from '/components/session-card.mjs';
      import { AgentSessionDetailPage } from '/pages/agent-session-detail.mjs';
      const session = ${JSON.stringify(session)};
      setCodexSessions([session]);
      function App() {
        const [view, setView] = useState(false);
        return h('div', {}, h(Nav), h(SessionCard, { session, provider: 'codex' }),
          h('button', { onClick: () => setView(true) }, 'View session'),
          view && h(AgentSessionDetailPage, { id: 'one', provider: 'codex', embedded: true }));
      }
      render(h(App), document.getElementById('app'));
    </script>`,
  )));
  app.get('/api/codex/sessions/one', () => ({ ...session, content: 'Finished turn', readOnly: true, externalOwner: 'rust-monitor' }));
  app.get('/api/*', () => ({}));
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN, headless: true, args: ['--no-sandbox'] });
  t.after(() => browser.close());
  const first = await (await browser.newContext()).newPage();
  const second = await (await browser.newContext()).newPage();
  first.setDefaultTimeout(5000);
  await Promise.all([first.goto(`${origin}/done-fixture`), second.goto(`${origin}/done-fixture`)]);
  await first.locator('.session-card').getByText('Done', { exact: true }).waitFor();
  await first.locator('.nav-link-primary').getByText('1 done', { exact: true }).waitFor();
  await first.getByRole('button', { name: 'View session', exact: true }).click();
  await first.locator('.session-card').getByText('Done', { exact: true }).waitFor({ state: 'detached' });
  assert.equal(await first.getByText('1 done', { exact: true }).count(), 0);
  await second.locator('.session-card').getByText('Done', { exact: true }).waitFor();
  await first.reload();
  await first.locator('.session-card').waitFor();
  assert.equal(await first.locator('.session-card').getByText('Done', { exact: true }).count(), 0);
});
