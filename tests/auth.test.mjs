import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

describe('Auth middleware', () => {
  let app;
  const TEST_TOKEN = 'test-secret-token-12345';
  const TEST_BYPASS = 'test-bypass-token-67890';
  const TEST_SESSION = 'test-session-secret-abcde';
  let evaluateInternalBypass;
  let buildInternalBypassHeaders;
  let createBrowserSessionCookieValue;
  let trustProxyHop;
  let BROWSER_SESSION_COOKIE;
  let port;
  const handlerHits = { protected: 0, wild: 0, secret: 0 };

  before(async () => {
    process.env.AUTH_TOKEN = TEST_TOKEN;
    process.env.INTERNAL_BYPASS_TOKEN = TEST_BYPASS;
    process.env.BROWSER_SESSION_SECRET = TEST_SESSION;

    const { default: Fastify } = await import('fastify');
    const authModule = await import('../modules/platform/auth.mjs');
    const { authPlugin } = authModule;
    evaluateInternalBypass = authModule.evaluateInternalBypass;
    buildInternalBypassHeaders = authModule.buildInternalBypassHeaders;
    createBrowserSessionCookieValue = authModule.createBrowserSessionCookieValue;
    trustProxyHop = authModule.trustProxyHop;
    BROWSER_SESSION_COOKIE = authModule.BROWSER_SESSION_COOKIE;

    app = Fastify({ trustProxy: trustProxyHop });

    await app.register(authPlugin);

    await app.after();

    app.get('/api/health', async () => ({ status: 'ok' }));
    app.get('/api/health/live', async () => ({ status: 'ok' }));
    app.get('/api/health/ready', async () => ({ status: 'ok' }));
    app.get('/api/protected', async () => {
      handlerHits.protected += 1;
      return { secret: 'data' };
    });
    app.get('/secret', async () => {
      handlerHits.secret += 1;
      return { leaked: true };
    });
    app.get('/api/*', async () => {
      handlerHits.wild += 1;
      return { wild: true };
    });

    await app.listen({ host: '127.0.0.1', port: 0 });
    port = app.server.address().port;
  });

  after(async () => {
    await app.close();
    delete process.env.AUTH_TOKEN;
    delete process.env.INTERNAL_BYPASS_TOKEN;
    delete process.env.BROWSER_SESSION_SECRET;
  });

  it('allows health endpoint without auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
  });

  it('allows live and ready health endpoints without auth', async () => {
    const liveRes = await app.inject({ method: 'GET', url: '/api/health/live' });
    const readyRes = await app.inject({ method: 'GET', url: '/api/health/ready' });
    assert.equal(liveRes.statusCode, 200);
    assert.equal(readyRes.statusCode, 200);
  });

  it('rejects protected route without token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/protected' });
    assert.equal(res.statusCode, 401);
  });

  it('does not lock out after repeated missing-token requests', async () => {
    for (let i = 0; i < 12; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/api/protected' });
      assert.equal(res.statusCode, 401);
    }

    const okRes = await app.inject({
      method: 'GET',
      url: '/api/protected',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(okRes.statusCode, 200);
  });

  it('rejects protected route with wrong token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/protected',
      headers: { authorization: 'Bearer wrong-token' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('allows protected route with correct token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/protected',
      headers: { authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(res.statusCode, 200);
  });

  it('sets an HttpOnly browser session cookie on login without storing the raw token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: TEST_TOKEN },
    });
    assert.equal(res.statusCode, 200);
    const setCookie = res.headers['set-cookie'];
    assert.ok(Array.isArray(setCookie));
    const sessionCookie = setCookie.find((entry) => entry.startsWith(`${BROWSER_SESSION_COOKIE}=`));
    assert.ok(sessionCookie);
    assert.match(sessionCookie, /HttpOnly/);
    assert.match(sessionCookie, /SameSite=Lax/);
    assert.equal(sessionCookie.includes(TEST_TOKEN), false);
  });

  it('rejects bad browser login without setting a session cookie', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: 'wrong-token' },
    });
    assert.equal(res.statusCode, 403);
    const setCookie = res.headers['set-cookie'];
    assert.equal(Boolean(setCookie), false);
  });

  it('allows protected routes with a valid browser session cookie', async () => {
    const session = createBrowserSessionCookieValue();
    const res = await app.inject({
      method: 'GET',
      url: '/api/protected',
      headers: { cookie: `${BROWSER_SESSION_COOKIE}=${encodeURIComponent(session)}` },
    });
    assert.equal(res.statusCode, 200);
  });

  it('expires browser and legacy readable cookies on logout', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
    });
    assert.equal(res.statusCode, 200);
    const setCookie = res.headers['set-cookie'];
    assert.ok(Array.isArray(setCookie));
    assert.ok(setCookie.some((entry) => entry.startsWith(`${BROWSER_SESSION_COOKIE}=`) && entry.includes('Max-Age=0')));
    assert.ok(setCookie.some((entry) => entry.startsWith('dueno_token=') && entry.includes('Max-Age=0')));
  });

  it('allows internal bypass only for trusted loopback callers with a fresh timestamp', () => {
    const result = evaluateInternalBypass({
      ip: '127.0.0.1',
      headers: buildInternalBypassHeaders(),
    });
    assert.equal(result.allowed, true);
  });

  it('rejects internal bypass from untrusted callers', () => {
    const result = evaluateInternalBypass({
      ip: '203.0.113.10',
      headers: buildInternalBypassHeaders(),
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'untrusted_ip');
  });

  it('rejects bypass when the bypass token matches AUTH_TOKEN', () => {
    const result = evaluateInternalBypass({
      ip: '127.0.0.1',
      headers: buildInternalBypassHeaders({
        authToken: TEST_TOKEN,
        bypassToken: TEST_TOKEN,
      }),
    }, { authToken: TEST_TOKEN, bypassToken: TEST_TOKEN });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'shared_secret');
  });

  it('rejects bypass on forwarded requests even from loopback', () => {
    const result = evaluateInternalBypass({
      ip: '127.0.0.1',
      headers: {
        ...buildInternalBypassHeaders(),
        'x-forwarded-for': '203.0.113.10',
      },
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'forwarded_request');
  });

  async function rawGet(path, headers = {}) {
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
  }

  it('rejects percent-encoded and dot-segment /api paths without running handlers', async () => {
    handlerHits.protected = 0;
    handlerHits.wild = 0;
    handlerHits.secret = 0;

    const encoded = await rawGet('/%61pi/protected');
    assert.equal(encoded.status, 401);
    assert.equal(handlerHits.protected, 0);

    const dotted = await rawGet('/api/../protected');
    assert.equal(dotted.status, 401);
    assert.equal(handlerHits.protected, 0);
    assert.equal(handlerHits.wild, 0);

    const encodedDots = await rawGet('/api/%2e%2e/protected');
    assert.equal(encodedDots.status, 401);
    assert.equal(handlerHits.wild, 0);

    const fakeHealth = await rawGet('/api/%2e%2e/health');
    assert.equal(fakeHealth.status, 401);
    assert.equal(handlerHits.wild, 0);

    const traversal = await rawGet('/api/%2e%2e/secret');
    assert.equal(traversal.status, 401);
    assert.equal(handlerHits.secret, 0);
    assert.equal(traversal.body.includes('leaked'), false);
  });

  it('allows percent-encoded /api paths with a valid token', async () => {
    handlerHits.protected = 0;
    const res = await rawGet('/%61pi/protected', { authorization: `Bearer ${TEST_TOKEN}` });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).secret, 'data');
    assert.equal(handlerHits.protected, 1);
  });

  it('keys lockout off the forwarded client and denies forwarded bypass', async () => {
    const attacker = { 'x-forwarded-for': '203.0.113.10' };
    for (let i = 0; i < 10; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/protected',
        remoteAddress: '127.0.0.1',
        headers: { ...attacker, authorization: 'Bearer wrong-token' },
      });
      assert.equal(res.statusCode, 403);
    }
    const locked = await app.inject({
      method: 'GET',
      url: '/api/protected',
      remoteAddress: '127.0.0.1',
      headers: { ...attacker, authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(locked.statusCode, 429);

    const otherClient = await app.inject({
      method: 'GET',
      url: '/api/protected',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.11', authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(otherClient.statusCode, 200);

    const bypassHeaders = {
      'x-dueno-internal': TEST_BYPASS,
      'x-dueno-internal-ts': new Date().toISOString(),
    };
    const proxiedBypass = await app.inject({
      method: 'GET',
      url: '/api/protected',
      remoteAddress: '127.0.0.1',
      headers: { ...bypassHeaders, 'x-forwarded-for': '203.0.113.12' },
    });
    assert.equal(proxiedBypass.statusCode, 401);

    const spoofedLoopback = await app.inject({
      method: 'GET',
      url: '/api/protected',
      remoteAddress: '198.51.100.10',
      headers: { ...bypassHeaders, 'x-forwarded-for': '127.0.0.1' },
    });
    assert.equal(spoofedLoopback.statusCode, 401);

    const spoofedLeftmost = await app.inject({
      method: 'GET',
      url: '/api/protected',
      remoteAddress: '127.0.0.1',
      headers: { ...bypassHeaders, 'x-forwarded-for': '127.0.0.1, 198.51.100.99' },
    });
    assert.equal(spoofedLeftmost.statusCode, 401);

    const directBypass = await app.inject({
      method: 'GET',
      url: '/api/protected',
      remoteAddress: '127.0.0.1',
      headers: bypassHeaders,
    });
    assert.equal(directBypass.statusCode, 200);
  });

  it('rejects caller-asserted MCP principals and in-process context handles', async () => {
    const asserted = await app.inject({
      method: 'GET', url: '/api/protected',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'x-dueno-mcp-principal': 'agent:codex:forged' },
    });
    assert.equal(asserted.statusCode, 400);

    const externalHandle = await app.inject({
      method: 'GET', url: '/api/protected',
      headers: { authorization: `Bearer ${TEST_TOKEN}`, 'x-dueno-inprocess-mcp-context': 'forged' },
    });
    assert.equal(externalHandle.statusCode, 403);

    const forgedInternalHandle = await app.inject({
      method: 'GET', url: '/api/protected',
      headers: { ...buildInternalBypassHeaders(), 'x-dueno-inprocess-mcp-context': 'forged' },
    });
    assert.equal(forgedInternalHandle.statusCode, 403);
  });
});
