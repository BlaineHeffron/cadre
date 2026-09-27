import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { wsQueryTokenCompatEnabled } from '../config.mjs';
import {
  BROWSER_SESSION_COOKIE,
  createBrowserSessionCookieValue,
} from '../modules/platform/auth.mjs';
import {
  redactedWebSocketAuthDetail,
  resolveWebSocketAuth,
} from '../modules/platform/ws-manager.mjs';

describe('websocket auth transport', () => {
  it('prefers authorization headers and browser session cookies over query tokens', () => {
    const headerAuth = resolveWebSocketAuth({
      headers: { authorization: 'Bearer header-token' },
      url: '/ws?token=query-token',
    });
    assert.equal(headerAuth.token, 'header-token');
    assert.equal(headerAuth.source, 'authorization');

    process.env.BROWSER_SESSION_SECRET = 'ws-test-secret';
    const session = createBrowserSessionCookieValue();
    const cookieAuth = resolveWebSocketAuth({
      headers: { cookie: `${BROWSER_SESSION_COOKIE}=${encodeURIComponent(session)}` },
      url: '/ws?token=query-token',
    });
    delete process.env.BROWSER_SESSION_SECRET;
    assert.equal(cookieAuth.token, '');
    assert.equal(cookieAuth.source, 'session_cookie');
    assert.equal(cookieAuth.sessionValid, true);
  });

  it('ignores legacy readable cookie values and falls back to query token', () => {
    const auth = resolveWebSocketAuth({
      headers: { cookie: 'dueno_token=%E0%A4%A' },
      url: '/ws?token=query-token',
    }, { allowQueryToken: true });
    assert.equal(auth.token, 'query-token');
    assert.equal(auth.source, 'query');
  });

  it('ignores invalid browser session cookies and falls back to query token when compatibility is enabled', () => {
    const auth = resolveWebSocketAuth({
      headers: { cookie: `${BROWSER_SESSION_COOKIE}=invalid-session` },
      url: '/ws?token=query-token',
    }, { allowQueryToken: true });
    assert.equal(auth.token, 'query-token');
    assert.equal(auth.source, 'query');
  });

  it('marks query-token auth deprecated and rejects it when compatibility is disabled', () => {
    const deprecated = resolveWebSocketAuth({
      headers: {},
      url: '/ws?token=query-token',
    }, { allowQueryToken: true });
    assert.equal(deprecated.token, 'query-token');
    assert.equal(deprecated.deprecated, true);

    const rejected = resolveWebSocketAuth({
      headers: {},
      url: '/ws?token=query-token',
    }, { allowQueryToken: false });
    assert.equal(rejected.token, '');
    assert.equal(rejected.source, 'query');
    assert.equal(rejected.rejected, true);
  });

  it('rejects query-token auth by default', () => {
    const auth = resolveWebSocketAuth({
      headers: {},
      url: '/ws?token=query-token',
    });
    assert.equal(auth.token, '');
    assert.equal(auth.source, 'query');
    assert.equal(auth.deprecated, true);
    assert.equal(auth.rejected, true);
  });

  it('keeps WS query-token compatibility disabled for blank env values', () => {
    assert.equal(wsQueryTokenCompatEnabled({}), false);
    assert.equal(wsQueryTokenCompatEnabled({ WS_QUERY_TOKEN_COMPAT: '' }), false);
    assert.equal(wsQueryTokenCompatEnabled({ WS_QUERY_TOKEN_COMPAT: '   ' }), false);
    assert.equal(wsQueryTokenCompatEnabled({ WS_QUERY_TOKEN_COMPAT: 'true' }), true);
    assert.equal(wsQueryTokenCompatEnabled({ WS_QUERY_TOKEN_COMPAT: '0' }), false);
  });

  it('redacts query-token auth details before persistence', () => {
    const detail = redactedWebSocketAuthDetail({
      url: '/ws?token=secret-token&channel=tmux',
    });
    assert.equal(detail, '/ws?token=%5Bredacted%5D&channel=tmux');
    assert.equal(detail.includes('secret-token'), false);
  });
});
