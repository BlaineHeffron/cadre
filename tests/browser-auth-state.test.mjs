import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

function makeLocalStorage(calls) {
  const store = new Map();
  return {
    getItem(key) {
      calls.push(['getItem', key]);
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      calls.push(['setItem', key, value]);
      store.set(key, String(value));
    },
    removeItem(key) {
      calls.push(['removeItem', key]);
      store.delete(key);
    },
    clear() {
      calls.push(['clear']);
      store.clear();
    },
  };
}

describe('browser auth state', () => {
  afterEach(() => {
    delete globalThis.window;
    delete globalThis.localStorage;
    delete globalThis.fetch;
  });

  it('redeems a #pair= fragment code for an HttpOnly session and scrubs it from the URL', async () => {
    const localStorageCalls = [];
    const fetchCalls = [];
    const replacedUrls = [];
    globalThis.localStorage = makeLocalStorage(localStorageCalls);
    globalThis.window = {
      location: {
        pathname: '/fleet',
        search: '?view=active',
        hash: '#pair=code_-123',
      },
      history: {
        replaceState(_state, _title, url) {
          replacedUrls.push(url);
        },
      },
    };
    globalThis.fetch = async (url, options = {}) => {
      fetchCalls.push([url, options]);
      return {
        ok: true,
        json: async () => ({ authenticated: true }),
      };
    };

    const state = await import(`../public/app/state.mjs?case=${Date.now()}`);
    await state.initAuth();

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0][0], '/api/auth/login');
    assert.equal(fetchCalls[0][1].method, 'POST');
    assert.equal(fetchCalls[0][1].credentials, 'same-origin');
    assert.deepEqual(JSON.parse(fetchCalls[0][1].body), { pairCode: 'code_-123' });
    assert.deepEqual(replacedUrls, ['/fleet?view=active']);
    assert.equal(state.isAuthenticated.value, true);
    assert.equal(state.authChecked.value, true);
    assert.equal(localStorageCalls.some(([op, key]) => op === 'setItem' && key === 'dueno_token'), false);
  });
  it('keeps an existing session signed in when a spent pairing link is reopened', async () => {
    const fetchCalls = [];
    const replacedUrls = [];
    globalThis.localStorage = makeLocalStorage([]);
    globalThis.window = {
      location: { pathname: '/', search: '', hash: '#pair=spent-code' },
      history: { replaceState(_state, _title, url) { replacedUrls.push(url); } },
    };
    globalThis.fetch = async (url, options = {}) => {
      fetchCalls.push(url);
      if (url === '/api/auth/login') {
        return { ok: false, status: 403, json: async () => ({ error: 'Invalid or expired pairing code' }) };
      }
      return { ok: true, json: async () => ({ authenticated: true }) };
    };

    const state = await import(`../public/app/state.mjs?case=spent-${Date.now()}`);
    await state.initAuth();

    assert.deepEqual(fetchCalls, ['/api/auth/login', '/api/auth/status']);
    assert.deepEqual(replacedUrls, ['/']);
    assert.equal(state.isAuthenticated.value, true);
    assert.equal(state.authChecked.value, true);
    assert.deepEqual(state.toasts.value.map((toast) => toast.message), ['Pairing failed: Invalid or expired pairing code']);
  });
});
