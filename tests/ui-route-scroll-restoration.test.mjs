import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installRouteScrollRestoration } from '../public/app/navigation.mjs';

function createFakeWindow() {
  const listeners = new Map();
  const browserWindow = {
    scrollY: 0,
    location: { pathname: '/agents', search: '', hash: '' },
    history: {
      scrollRestoration: 'auto',
      pushState(_state, _title, url) {
        browserWindow.location.pathname = url;
      },
      replaceState(_state, _title, url) {
        browserWindow.location.pathname = url;
      },
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    cancelAnimationFrame() {},
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
    scrollTo({ top }) {
      this.scrollY = top;
    },
    dispatch(type, event = {}) {
      listeners.get(type)?.(event);
    },
  };
  return browserWindow;
}

describe('route scroll restoration', () => {
  it('restores a list position on browser Back while new navigation starts at top', () => {
    const browserWindow = createFakeWindow();
    const restoration = installRouteScrollRestoration(browserWindow);

    restoration.handleRouteChange({ url: '/agents' });
    browserWindow.scrollY = 2106;
    browserWindow.history.pushState({}, '', '/codex/session');
    restoration.handleRouteChange({ url: '/codex/session', previous: '/agents' });
    assert.equal(browserWindow.scrollY, 0);

    browserWindow.location.pathname = '/agents';
    browserWindow.dispatch('popstate', { isTrusted: true });
    restoration.handleRouteChange({ url: '/agents', previous: '/codex/session' });
    assert.equal(browserWindow.scrollY, 2106);
    assert.equal(browserWindow.history.scrollRestoration, 'manual');

    restoration.dispose();
    assert.equal(browserWindow.history.scrollRestoration, 'auto');
  });
});
