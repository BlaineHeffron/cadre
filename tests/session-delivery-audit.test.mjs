import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSessionDeliveryAuditStore,
  sessionDeliveryAuditPlugin,
} from '../modules/sessions/delivery-audit.mjs';

const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('session delivery audit', () => {
  it('persists visible monitor_send_to_session delivery records', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dueno-session-delivery-audit-'));
    tempDirs.push(dir);
    const storeFile = join(dir, 'audit.json');

    const store = buildSessionDeliveryAuditStore({ storeFile });
    const sent = await store.record({
      source: 'monitor_send_to_session',
      kind: 'codex',
      sessionId: 'codex_1',
      text: 'Investigate the failing test.\nReport back.',
      enter: true,
      status: 'sent',
    });
    await store.record({
      source: 'api',
      kind: 'claude',
      sessionId: 'claude_1',
      text: 'Other send',
      status: 'failed',
      error: 'tmux failed',
    });
    await store.close();

    assert.match(sent.id, /^sdel_/);
    assert.equal(sent.status, 'sent');
    assert.equal(sent.source, 'monitor_send_to_session');
    assert.equal(sent.target.kind, 'codex');
    assert.equal(sent.target.sessionId, 'codex_1');
    assert.equal(sent.enter, true);
    assert.equal(sent.textLength, 42);
    assert.equal(sent.textPreview, 'Investigate the failing test. Report back.');

    const reloaded = buildSessionDeliveryAuditStore({ storeFile });
    await reloaded.init();
    const filtered = reloaded.list({
      kind: 'codex',
      sessionId: 'codex_1',
      source: 'monitor_send_to_session',
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, sent.id);
    await reloaded.close();
  });

  it('exposes delivery records through the session-deliveries API', async () => {
    const store = buildSessionDeliveryAuditStore({
      stateStore: {
        state: null,
        async load() { return this.state; },
        async save(next) { this.state = JSON.parse(JSON.stringify(next)); },
        async close() {},
      },
    });
    await store.record({
      source: 'monitor_send_to_session',
      kind: 'claude',
      sessionId: 'claude_visible',
      text: 'Visible audit trail',
      status: 'sent',
      metadata: { transactionId: 'tx-visible' },
    });

    const app = Fastify();
    await app.register(sessionDeliveryAuditPlugin, { store });

    const res = await app.inject({
      method: 'GET',
      url: '/api/session-deliveries?kind=claude&sessionId=claude_visible&source=monitor_send_to_session',
    });
    assert.equal(res.statusCode, 200);
    const payload = res.json();
    assert.equal(payload.deliveries.length, 1);
    assert.equal(payload.deliveries[0].target.sessionId, 'claude_visible');
    assert.equal(payload.deliveries[0].source, 'monitor_send_to_session');

    const transactionRes = await app.inject({
      method: 'GET',
      url: '/api/session-deliveries?transactionId=tx-visible',
    });
    assert.equal(transactionRes.statusCode, 200);
    assert.equal(transactionRes.json().deliveries.length, 1);

    await app.close();
  });

  it('returns queued age and failed reason on the session-deliveries API', async () => {
    const store = buildSessionDeliveryAuditStore({
      stateStore: {
        state: null,
        async load() { return this.state; },
        async save(next) { this.state = JSON.parse(JSON.stringify(next)); },
        async close() {},
      },
    });
    await store.record({
      source: 'monitor_send_to_session',
      kind: 'codex',
      sessionId: 'codex_queued',
      text: 'queued send',
      status: 'queued',
      metadata: { transactionId: 'tx-queued' },
    });
    await store.record({
      source: 'monitor_send_to_session',
      kind: 'codex',
      sessionId: 'codex_failed',
      text: 'failed send',
      status: 'failed',
      error: 'tmux paste failed',
      metadata: { transactionId: 'tx-failed' },
    });

    const app = Fastify();
    await app.register(sessionDeliveryAuditPlugin, { store });

    const queuedRes = await app.inject({
      method: 'GET',
      url: '/api/session-deliveries?status=queued&transactionId=tx-queued',
    });
    assert.equal(queuedRes.statusCode, 200);
    const queued = queuedRes.json().deliveries[0];
    assert.equal(queued.status, 'queued');
    assert.ok(queued.createdAt);
    assert.equal(typeof queued.ageMs, 'number');
    assert.ok(queued.ageMs >= 0);
    assert.ok(queued.ageMs < 60_000);

    const failedRes = await app.inject({
      method: 'GET',
      url: '/api/session-deliveries?status=failed&transactionId=tx-failed',
    });
    assert.equal(failedRes.statusCode, 200);
    const failed = failedRes.json().deliveries[0];
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'tmux paste failed');
    assert.equal(typeof failed.ageMs, 'number');

    await app.close();
  });
});
