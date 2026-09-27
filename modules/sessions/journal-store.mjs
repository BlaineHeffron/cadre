import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { incrementOpsCounter } from '../ops/observability.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function validateSessionId(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) throw new TypeError('sessionId is required');
  return id;
}

function encodeSessionId(sessionId) {
  return Buffer.from(validateSessionId(sessionId)).toString('base64url');
}

function decodeSessionId(fileName) {
  try {
    return Buffer.from(fileName.replace(/\.wal$/, ''), 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

function checksum(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Provider receipts and committed output must survive until task reconciliation.
const EPHEMERAL_EVENT_TYPES = new Set(['diagnostic.appended']);

export async function assertSessionDeletable(journal, sessionId) {
  const retained = await journal.rebuild(sessionId, (state, event) => {
    if (event.type === 'task.linked') return true;
    if (event.type === 'task.released') return false;
    return state;
  }, false);
  if (retained) throw Object.assign(new Error('Task history is retained for parent consumption'), {
    code: 'task_retained', statusCode: 409,
  });
}

function isEphemeralEvent(event) {
  return EPHEMERAL_EVENT_TYPES.has(String(event?.type || ''));
}

function retainEventsForRebuild(events, retain) {
  const count = Math.max(1, Number(retain) || 1);
  if (!Array.isArray(events) || events.length <= count) return { events: events || [], compacted: false };
  const cutoff = events[events.length - count]?.seq;
  const next = events.filter((event) => !isEphemeralEvent(event) || event.seq >= cutoff);
  return { events: next, compacted: next.length !== events.length };
}

function normalizeEvent(sessionId, seq, input = {}) {
  const eventId = String(input.eventId || randomUUID());
  const idempotencyKey = input.idempotencyKey == null || input.idempotencyKey === ''
    ? null
    : String(input.idempotencyKey);
  const type = String(input.type || '').trim();
  if (!type) throw new TypeError('journal event type is required');
  return Object.freeze({
    ...clone(input),
    sessionId,
    seq,
    eventId,
    idempotencyKey,
    recordedAt: Number(input.recordedAt || Date.now()),
  });
}

function frameFor(event) {
  const payload = JSON.stringify(event);
  return `${JSON.stringify({ length: Buffer.byteLength(payload), checksum: checksum(payload), event })}\n`;
}

function parseFrames(buffer) {
  const events = [];
  let offset = 0;
  let validBytes = 0;
  let recoveredBytes = 0;
  while (offset < buffer.byteLength) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline < 0) {
      recoveredBytes = buffer.byteLength - offset;
      break;
    }
    const line = buffer.subarray(offset, newline);
    const nextOffset = newline + 1;
    if (line.byteLength === 0) {
      validBytes = nextOffset;
      offset = nextOffset;
      continue;
    }
    try {
      const frame = JSON.parse(line.toString('utf8'));
      const payload = JSON.stringify(frame.event);
      if (!frame.event || frame.length !== Buffer.byteLength(payload) || frame.checksum !== checksum(payload)) {
        throw new Error('invalid journal frame');
      }
      events.push(frame.event);
      validBytes = nextOffset;
      offset = nextOffset;
    } catch {
      recoveredBytes = buffer.byteLength - offset;
      break;
    }
  }
  return { events, validBytes, recoveredBytes };
}

export class FileJournalStore {
  constructor({
    rootDir = runtimeStatePath('agent_journal'),
    fsync = 'always',
    maxEventsPerSession = 10_000,
  } = {}) {
    this.rootDir = resolve(rootDir);
    this.fsync = fsync;
    this.maxEventsPerSession = maxEventsPerSession;
    this.locks = new Map();
    this.cache = new Map();
    this.recoveryReports = new Map();
  }

  async init() {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const ids = await this.listSessionIds();
    await Promise.all(ids.map((id) => this.#load(id)));
    return this;
  }

  async append(sessionId, input = {}) {
    const id = validateSessionId(sessionId);
    return this.#withLock(id, async () => {
      const state = await this.#load(id);
      const requestedEventId = input.eventId == null ? '' : String(input.eventId);
      const requestedKey = input.idempotencyKey == null ? '' : String(input.idempotencyKey);
      if (requestedEventId && state.byEventId.has(requestedEventId)) return clone(state.byEventId.get(requestedEventId));
      if (requestedKey && state.byIdempotencyKey.has(requestedKey)) return clone(state.byIdempotencyKey.get(requestedKey));
      const seq = state.nextSeq;
      const event = normalizeEvent(id, seq, input);
      const frame = frameFor(event);
      const handle = await open(this.#file(id), 'a', 0o600);
      try {
        await handle.write(frame);
        if (this.fsync === 'always') await handle.sync();
      } finally {
        await handle.close();
      }
      state.events.push(event);
      state.nextSeq = seq + 1;
      state.byEventId.set(event.eventId, event);
      if (event.idempotencyKey) state.byIdempotencyKey.set(event.idempotencyKey, event);
      incrementOpsCounter('journal_bytes', Buffer.byteLength(frame), { transport: 'journal', provider: 'fleet', outcome: 'written' });
      if (state.events.length > this.maxEventsPerSession) await this.#compactLocked(id, state);
      return clone(event);
    });
  }

  async read(sessionId, { after = 0, limit = 1000 } = {}) {
    const state = await this.#load(validateSessionId(sessionId));
    const cursor = Math.max(0, Number(after) || 0);
    const count = Math.max(1, Math.min(10_000, Number(limit) || 1000));
    const events = state.events.filter((event) => event.seq > cursor).slice(0, count).map(clone);
    return {
      events,
      cursor: events.length ? events.at(-1).seq : cursor,
      hasMore: state.events.some((event) => event.seq > (events.at(-1)?.seq || cursor)),
    };
  }

  async rebuild(sessionId, reducer, initialState) {
    if (typeof reducer !== 'function') throw new TypeError('reducer is required');
    let state = clone(initialState);
    let after = 0;
    for (;;) {
      const page = await this.read(sessionId, { after, limit: 10_000 });
      for (const event of page.events) state = await reducer(state, clone(event));
      if (!page.hasMore) return state;
      after = page.cursor;
    }
  }

  async compact(sessionId, { retain = this.maxEventsPerSession } = {}) {
    const id = validateSessionId(sessionId);
    return this.#withLock(id, async () => this.#compactLocked(id, await this.#load(id), retain));
  }

  async listSessionIds() {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    const files = await readdir(this.rootDir);
    return files.filter((name) => name.endsWith('.wal')).map(decodeSessionId).filter(Boolean).sort();
  }

  async deleteSession(sessionId) {
    const id = validateSessionId(sessionId);
    return this.#withLock(id, async () => {
      await assertSessionDeletable(this, id);
      await rm(this.#file(id), { force: true });
      this.cache.delete(id);
      this.recoveryReports.delete(id);
      return true;
    });
  }

  recoveryReport(sessionId) {
    return clone(this.recoveryReports.get(String(sessionId)) || { recoveredBytes: 0, validBytes: 0 });
  }

  async close() {
    await Promise.all([...this.locks.values()].map((promise) => promise.catch(() => {})));
  }

  #file(sessionId) { return join(this.rootDir, `${encodeSessionId(sessionId)}.wal`); }

  async #load(sessionId) {
    if (this.cache.has(sessionId)) return this.cache.get(sessionId);
    const path = this.#file(sessionId);
    let bytes = Buffer.alloc(0);
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parsed = parseFrames(bytes);
    if (parsed.recoveredBytes > 0) await truncate(path, parsed.validBytes);
    const byEventId = new Map();
    const byIdempotencyKey = new Map();
    let nextSeq = 1;
    for (const event of parsed.events) {
      if (!Number.isInteger(event.seq) || event.seq < nextSeq) break;
      if (byEventId.has(event.eventId)) continue;
      if (event.idempotencyKey && byIdempotencyKey.has(event.idempotencyKey)) continue;
      byEventId.set(event.eventId, event);
      if (event.idempotencyKey) byIdempotencyKey.set(event.idempotencyKey, event);
      nextSeq = Math.max(nextSeq, event.seq + 1);
    }
    const state = { events: [...byEventId.values()].sort((left, right) => left.seq - right.seq), byEventId, byIdempotencyKey, nextSeq };
    this.cache.set(sessionId, state);
    this.recoveryReports.set(sessionId, { recoveredBytes: parsed.recoveredBytes, validBytes: parsed.validBytes });
    return state;
  }

  async #compactLocked(sessionId, state, retain = this.maxEventsPerSession) {
    const count = Math.max(1, Number(retain) || this.maxEventsPerSession);
    const next = retainEventsForRebuild(state.events, count);
    if (!next.compacted) return { compacted: false, retained: state.events.length };
    state.events = next.events;
    state.byEventId = new Map(state.events.map((event) => [event.eventId, event]));
    state.byIdempotencyKey = new Map(state.events.filter((event) => event.idempotencyKey).map((event) => [event.idempotencyKey, event]));
    const payload = state.events.map(frameFor).join('');
    const path = this.#file(sessionId);
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempPath, payload, { mode: 0o600 });
    if (this.fsync === 'always') {
      const handle = await open(tempPath, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }
    await rename(tempPath, path);
    return { compacted: true, retained: state.events.length };
  }

  #withLock(sessionId, operation) {
    const previous = this.locks.get(sessionId) || Promise.resolve();
    const next = previous.then(operation, operation);
    const tracked = next.catch(() => {});
    this.locks.set(sessionId, tracked);
    return next.finally(() => {
      if (this.locks.get(sessionId) === tracked) this.locks.delete(sessionId);
    });
  }
}

async function defaultPoolFactory(databaseUrl) {
  const { Pool } = await import('pg');
  return new Pool({ connectionString: databaseUrl });
}

export class PostgresJournalStore {
  constructor({ databaseUrl = process.env.DATABASE_URL || '', pool = null, poolFactory = defaultPoolFactory } = {}) {
    this.databaseUrl = databaseUrl;
    this.pool = pool;
    this.poolFactory = poolFactory;
    this.ownsPool = !pool;
  }

  async init() {
    if (!this.pool) {
      if (!this.databaseUrl) throw new Error('DATABASE_URL is required for postgres journal storage');
      this.pool = await this.poolFactory(this.databaseUrl);
    }
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS agent_journal_sessions (
        session_id TEXT PRIMARY KEY,
        next_seq BIGINT NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS agent_journal_events (
        session_id TEXT NOT NULL,
        seq BIGINT NOT NULL,
        event_id TEXT NOT NULL,
        idempotency_key TEXT,
        recorded_at BIGINT NOT NULL,
        event JSONB NOT NULL,
        PRIMARY KEY (session_id, seq),
        UNIQUE (session_id, event_id),
        UNIQUE (session_id, idempotency_key)
      );
    `);
    return this;
  }

  async append(sessionId, input = {}) {
    const id = validateSessionId(sessionId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const eventId = String(input.eventId || randomUUID());
      const key = input.idempotencyKey == null || input.idempotencyKey === '' ? null : String(input.idempotencyKey);
      await client.query('INSERT INTO agent_journal_sessions(session_id,next_seq) VALUES($1,1) ON CONFLICT DO NOTHING', [id]);
      const counter = await client.query('SELECT next_seq FROM agent_journal_sessions WHERE session_id=$1 FOR UPDATE', [id]);
      const existing = await client.query(
        `SELECT event FROM agent_journal_events
         WHERE session_id=$1 AND (event_id=$2 OR ($3::text IS NOT NULL AND idempotency_key=$3))
         ORDER BY seq LIMIT 1`,
        [id, eventId, key],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return clone(existing.rows[0].event);
      }
      const seq = Number(counter.rows[0].next_seq);
      const event = normalizeEvent(id, seq, { ...input, eventId, idempotencyKey: key });
      await client.query(
        'INSERT INTO agent_journal_events(session_id,seq,event_id,idempotency_key,recorded_at,event) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
        [id, seq, event.eventId, event.idempotencyKey, event.recordedAt, JSON.stringify(event)],
      );
      await client.query('UPDATE agent_journal_sessions SET next_seq=$2 WHERE session_id=$1', [id, seq + 1]);
      await client.query('COMMIT');
      return clone(event);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async read(sessionId, { after = 0, limit = 1000 } = {}) {
    const id = validateSessionId(sessionId);
    const count = Math.max(1, Math.min(10_000, Number(limit) || 1000));
    const result = await this.pool.query(
      'SELECT event FROM agent_journal_events WHERE session_id=$1 AND seq>$2 ORDER BY seq LIMIT $3',
      [id, Math.max(0, Number(after) || 0), count + 1],
    );
    const events = result.rows.slice(0, count).map((row) => clone(row.event));
    return { events, cursor: events.at(-1)?.seq || Number(after) || 0, hasMore: result.rows.length > count };
  }

  async rebuild(sessionId, reducer, initialState) {
    let state = clone(initialState);
    let after = 0;
    for (;;) {
      const page = await this.read(sessionId, { after, limit: 1000 });
      for (const event of page.events) state = await reducer(state, clone(event));
      if (!page.hasMore) return state;
      after = page.cursor;
    }
  }

  async listSessionIds() {
    const result = await this.pool.query('SELECT session_id FROM agent_journal_sessions ORDER BY session_id');
    return result.rows.map((row) => row.session_id);
  }

  async deleteSession(sessionId) {
    const id = validateSessionId(sessionId);
    await assertSessionDeletable(this, id);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM agent_journal_events WHERE session_id=$1', [id]);
      await client.query('DELETE FROM agent_journal_sessions WHERE session_id=$1', [id]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async compact(sessionId, { retain = 10_000 } = {}) {
    const id = validateSessionId(sessionId);
    const result = await this.pool.query(
      `DELETE FROM agent_journal_events WHERE session_id=$1 AND seq < COALESCE(
        (SELECT seq FROM agent_journal_events WHERE session_id=$1 ORDER BY seq DESC OFFSET $2 LIMIT 1), 0
      ) AND COALESCE(event->>'type','') = ANY($3::text[])`,
      [id, Math.max(0, (Number(retain) || 10_000) - 1), [...EPHEMERAL_EVENT_TYPES]],
    );
    return { compacted: result.rowCount > 0, removed: result.rowCount };
  }

  recoveryReport() { return { recoveredBytes: 0, validBytes: 0 }; }

  async close() {
    if (this.ownsPool) await this.pool?.end?.();
  }
}

export function createJournalStore({
  mode = process.env.AGENT_JOURNAL_STORAGE || process.env.APP_STATE_STORAGE || 'file',
  ...options
} = {}) {
  return String(mode).toLowerCase() === 'postgres'
    ? new PostgresJournalStore(options)
    : new FileJournalStore(options);
}
