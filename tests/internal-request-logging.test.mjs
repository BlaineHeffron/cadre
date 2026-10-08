import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';

describe('Internal bypass request logging', () => {
  let app;
  let buildInternalBypassHeaders;
  const lines = [];

  before(async () => {
    process.env.AUTH_TOKEN = 'test-secret-token-12345';
    process.env.INTERNAL_BYPASS_TOKEN = 'test-bypass-token-67890';
    process.env.BROWSER_SESSION_SECRET = 'test-session-secret-abcde';

    const { default: Fastify } = await import('fastify');
    const auth = await import('../modules/platform/auth.mjs');
    buildInternalBypassHeaders = auth.buildInternalBypassHeaders;

    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(JSON.parse(chunk.toString()));
        cb();
      },
    });
    app = Fastify({
      logger: { level: 'info', stream },
      logController: new auth.InternalQuietLogController(),
    });
    await app.register(auth.authPlugin);
    await app.after();
    app.get('/api/health', async () => ({ status: 'ok' }));
    app.get('/api/boom', async () => { throw new Error('boom'); });
    app.get('/api/claude/sessions/abc', async () => ({ ok: true }));
  });

  after(async () => {
    await app.close();
    delete process.env.AUTH_TOKEN;
    delete process.env.INTERNAL_BYPASS_TOKEN;
    delete process.env.BROWSER_SESSION_SECRET;
  });

  const msgs = () => lines.map((l) => l.msg);

  it('logs no info lines for a valid internal bypass inject', async () => {
    lines.length = 0;
    const res = await app.inject({
      method: 'GET',
      url: '/api/claude/sessions/abc',
      headers: buildInternalBypassHeaders(),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(msgs(), []);
  });

  it('still logs errors from internal bypass requests', async () => {
    lines.length = 0;
    const res = await app.inject({ method: 'GET', url: '/api/boom', headers: buildInternalBypassHeaders() });
    assert.equal(res.statusCode, 500);
    assert.ok(lines.some((l) => l.level >= 50));
    assert.ok(!lines.some((l) => l.level === 30));
  });

  it('still logs external requests', async () => {
    lines.length = 0;
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(msgs(), ['incoming request', 'request completed']);
  });

  it('still logs a spoofed bypass header and its rejection', async () => {
    lines.length = 0;
    const res = await app.inject({
      method: 'GET',
      url: '/api/claude/sessions/abc',
      headers: { 'x-dueno-internal': 'wrong', 'x-dueno-internal-ts': new Date().toISOString() },
    });
    assert.equal(res.statusCode, 401);
    assert.ok(msgs().includes('incoming request'));
    assert.ok(msgs().includes('request completed'));
  });
});
