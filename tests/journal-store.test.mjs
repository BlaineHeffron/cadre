import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { appendFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileJournalStore, PostgresJournalStore } from '../modules/sessions/journal-store.mjs';

const roots = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop(), { recursive: true, force: true });
});

async function store() {
  const rootDir = await mkdtemp(join(tmpdir(), 'dueno-journal-'));
  roots.push(rootDir);
  const journal = new FileJournalStore({ rootDir, fsync: 'always', maxEventsPerSession: 100 });
  await journal.init();
  return { journal, rootDir };
}

class FakePostgresPool {
  constructor() {
    this.events = new Map();
    this.nextSeq = new Map();
    this.queries = [];
    this.releases = 0;
    this.endCalls = 0;
    this.failNextEventInsert = false;
  }

  async connect() {
    return {
      query: (sql, params) => this.#query(sql, params),
      release: () => { this.releases += 1; },
    };
  }

  async query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: normalized, params: structuredClone(params) });
    if (normalized.startsWith('CREATE TABLE')) return { rows: [], rowCount: 0 };
    if (normalized.startsWith('SELECT event FROM agent_journal_events WHERE session_id=$1 AND seq>$2')) {
      const [sessionId, after, limit] = params;
      const rows = (this.events.get(sessionId) || [])
        .filter((event) => event.seq > after)
        .slice(0, limit)
        .map((event) => ({ event: structuredClone(event) }));
      return { rows, rowCount: rows.length };
    }
    throw new Error(`Unexpected pool query: ${normalized}`);
  }

  async end() { this.endCalls += 1; }

  async #query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    this.queries.push({ sql: normalized, params: structuredClone(params) });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized)) return { rows: [], rowCount: 0 };
    if (normalized.startsWith('INSERT INTO agent_journal_sessions')) {
      if (!this.nextSeq.has(params[0])) this.nextSeq.set(params[0], 1);
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT next_seq')) {
      return { rows: [{ next_seq: this.nextSeq.get(params[0]) }], rowCount: 1 };
    }
    if (normalized.startsWith('SELECT event FROM agent_journal_events')) {
      const [sessionId, eventId, key] = params;
      const event = (this.events.get(sessionId) || [])
        .find((item) => item.eventId === eventId || (key != null && item.idempotencyKey === key));
      return { rows: event ? [{ event: structuredClone(event) }] : [], rowCount: event ? 1 : 0 };
    }
    if (normalized.startsWith('INSERT INTO agent_journal_events')) {
      if (this.failNextEventInsert) {
        this.failNextEventInsert = false;
        throw new Error('event insert failed');
      }
      const event = JSON.parse(params[5]);
      const events = this.events.get(params[0]) || [];
      events.push(event);
      this.events.set(params[0], events);
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('UPDATE agent_journal_sessions')) {
      this.nextSeq.set(params[0], params[1]);
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith('DELETE FROM agent_journal_events')) {
      const count = (this.events.get(params[0]) || []).length;
      this.events.delete(params[0]);
      return { rows: [], rowCount: count };
    }
    if (normalized.startsWith('DELETE FROM agent_journal_sessions')) {
      const existed = this.nextSeq.delete(params[0]);
      return { rows: [], rowCount: existed ? 1 : 0 };
    }
    throw new Error(`Unexpected client query: ${normalized}`);
  }
}

describe('FileJournalStore WAL', () => {
  it('allocates monotonic sequence numbers under lock and deduplicates ids', { timeout: 15000 }, async () => {
    const { journal } = await store();
    const events = await Promise.all(Array.from({ length: 25 }, (_, index) => journal.append('s1', {
      type: 'test.event', eventId: `event-${index}`, idempotencyKey: `key-${index}`, data: { index },
    })));
    assert.deepEqual(events.map((event) => event.seq).sort((a, b) => a - b), Array.from({ length: 25 }, (_, index) => index + 1));
    const duplicate = await journal.append('s1', { type: 'different', eventId: 'other', idempotencyKey: 'key-4' });
    assert.equal(duplicate.eventId, 'event-4');
    const page = await journal.read('s1', { after: 10, limit: 5 });
    assert.deepEqual(page.events.map((event) => event.seq), [11, 12, 13, 14, 15]);
    assert.equal(page.cursor, 15);
    assert.equal(page.hasMore, true);
    await journal.close();
  });

  it('truncates a partial tail and rebuilds a projection', { timeout: 15000 }, async () => {
    const { journal, rootDir } = await store();
    await journal.append('partial', { type: 'counted', data: { amount: 2 } });
    await journal.append('partial', { type: 'counted', data: { amount: 3 } });
    await journal.close();
    const [wal] = (await readdir(rootDir)).filter((name) => name.endsWith('.wal'));
    await appendFile(join(rootDir, wal), '{"length":99,"event":');

    const recovered = new FileJournalStore({ rootDir, fsync: 'always' });
    await recovered.init();
    assert.ok(recovered.recoveryReport('partial').recoveredBytes > 0);
    const projection = await recovered.rebuild('partial', (total, event) => total + event.data.amount, 0);
    assert.equal(projection, 5);
    const appended = await recovered.append('partial', { type: 'counted', data: { amount: 4 } });
    assert.equal(appended.seq, 3);
    await recovered.close();
  });

  it('compacts retained frames without resetting the sequence cursor', { timeout: 15000 }, async () => {
    const { journal } = await store();
    for (let index = 0; index < 8; index += 1) await journal.append('compact', { type: 'item', data: { index } });
    const result = await journal.compact('compact', { retain: 3 });
    assert.equal(result.compacted, false);
    const page = await journal.read('compact');
    assert.deepEqual(page.events.map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
    const next = await journal.append('compact', { type: 'item', data: { index: 8 } });
    assert.equal(next.seq, 9);
    await journal.close();
  });

  it('drops only ephemeral tail events and keeps rebuild anchors', { timeout: 15000 }, async () => {
    const { journal } = await store();
    await journal.append('s', { type: 'session.created', data: { provider: 'deepseek' } });
    await journal.append('s', { type: 'attempt.created', data: { attemptId: 'a1' } });
    for (let index = 0; index < 6; index += 1) {
      await journal.append('s', { type: 'diagnostic.appended', data: { index } });
    }
    const result = await journal.compact('s', { retain: 2 });
    assert.equal(result.compacted, true);
    const page = await journal.read('s');
    assert.deepEqual(page.events.map((event) => event.type), [
      'session.created', 'attempt.created', 'diagnostic.appended', 'diagnostic.appended',
    ]);
    assert.deepEqual(page.events.map((event) => event.seq), [1, 2, 7, 8]);
    const next = await journal.append('s', { type: 'session.lifecycle', data: { lifecycle: 'ready' } });
    assert.equal(next.seq, 9);
    await journal.close();
  });

  it('deletes a session WAL and clears its cached projection', async () => {
    const { journal, rootDir } = await store();
    await journal.append('delete-me', { type: 'session.created' });
    assert.deepEqual(await journal.listSessionIds(), ['delete-me']);
    await journal.deleteSession('delete-me');
    assert.deepEqual(await journal.listSessionIds(), []);
    assert.deepEqual(await readdir(rootDir), []);
    assert.deepEqual((await journal.read('delete-me')).events, []);
    await journal.close();
  });
});

describe('PostgresJournalStore', () => {
  it('initializes through the supplied pool factory and owns its resulting pool', async () => {
    const pool = new FakePostgresPool();
    const factoryCalls = [];
    const journal = new PostgresJournalStore({
      databaseUrl: 'postgres://journal.test/db',
      poolFactory: async (databaseUrl) => {
        factoryCalls.push(databaseUrl);
        return pool;
      },
    });

    assert.equal(await journal.init(), journal);
    assert.deepEqual(factoryCalls, ['postgres://journal.test/db']);
    assert.match(pool.queries[0].sql, /CREATE TABLE IF NOT EXISTS agent_journal_sessions/);
    await journal.close();
    assert.equal(pool.endCalls, 1);

    const missingUrl = new PostgresJournalStore({ databaseUrl: '' });
    await assert.rejects(() => missingUrl.init(), /DATABASE_URL is required/);
  });

  it('commits exact-once appends and returns bounded cursor pages', async () => {
    const pool = new FakePostgresPool();
    const journal = new PostgresJournalStore({ pool });
    await journal.init();

    const first = await journal.append('postgres-session', {
      type: 'turn.created', eventId: 'event-1', idempotencyKey: 'turn-1', recordedAt: 10,
      data: { turnId: 'turn-1' },
    });
    const duplicateByKey = await journal.append('postgres-session', {
      type: 'ignored', eventId: 'event-other', idempotencyKey: 'turn-1', recordedAt: 20,
    });
    const second = await journal.append('postgres-session', {
      type: 'turn.updated', eventId: 'event-2', recordedAt: 30,
      data: { turnId: 'turn-1', patch: { status: 'settled' } },
    });

    assert.equal(first.seq, 1);
    assert.deepEqual(duplicateByKey, first);
    assert.equal(second.seq, 2);
    assert.deepEqual(pool.events.get('postgres-session').map((event) => event.eventId), ['event-1', 'event-2']);
    const firstPage = await journal.read('postgres-session', { after: -4, limit: 1 });
    assert.deepEqual(firstPage.events, [first]);
    assert.equal(firstPage.cursor, 1);
    assert.equal(firstPage.hasMore, true);
    const secondPage = await journal.read('postgres-session', { after: firstPage.cursor, limit: 1 });
    assert.deepEqual(secondPage.events, [second]);
    assert.equal(secondPage.cursor, 2);
    assert.equal(secondPage.hasMore, false);

    await journal.close();
    assert.equal(pool.endCalls, 0, 'an injected pool remains caller-owned');
  });

  it('rolls back a failed append and always releases the client', async () => {
    const pool = new FakePostgresPool();
    const journal = new PostgresJournalStore({ pool });
    await journal.init();
    pool.failNextEventInsert = true;

    await assert.rejects(
      () => journal.append('postgres-session', { type: 'turn.created', eventId: 'event-failed' }),
      /event insert failed/,
    );
    assert.equal(pool.queries.some(({ sql }) => sql === 'ROLLBACK'), true);
    assert.equal(pool.queries.some(({ sql }) => sql === 'COMMIT'), false);
    assert.equal(pool.releases, 1);
    assert.deepEqual(pool.events.get('postgres-session') || [], []);
  });

  it('deletes postgres events and their session counter transactionally', async () => {
    const pool = new FakePostgresPool();
    const journal = new PostgresJournalStore({ pool });
    await journal.init();
    await journal.append('delete-me', { type: 'session.created' });
    await journal.deleteSession('delete-me');
    assert.equal(pool.events.has('delete-me'), false);
    assert.equal(pool.nextSeq.has('delete-me'), false);
    assert.equal(pool.queries.filter(({ sql }) => sql === 'COMMIT').length, 2);
    assert.equal(pool.releases, 2);
  });
});
