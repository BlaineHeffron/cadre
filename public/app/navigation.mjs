import { route } from 'preact-router';

function isPlainLeftClick(event) {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function isInternalRouteUrl(url) {
  return url.origin === window.location.origin && url.pathname.startsWith('/');
}

export function navigate(path, { replace = false } = {}) {
  if (!path || typeof path !== 'string') return;
  route(path, replace);
}

export function installSpaLinkNavigation() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};

  function handleClick(event) {
    if (!isPlainLeftClick(event) || event.defaultPrevented) return;
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor) return;
    if (anchor.target && anchor.target !== '_self') return;
    if (anchor.hasAttribute('download')) return;

    const href = anchor.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

    const url = new URL(href, window.location.href);
    if (!isInternalRouteUrl(url)) return;

    event.preventDefault();
    navigate(`${url.pathname}${url.search}${url.hash}`);
  }

  document.addEventListener('click', handleClick);
  return () => document.removeEventListener('click', handleClick);
}

export function installRouteScrollRestoration(browserWindow = window) {
  const positions = new Map();
  let historyTraversal = false;
  let restoreFrame;
  let restoreTimers = [];
  const previousScrollRestoration = browserWindow.history.scrollRestoration;
  const originalPushState = browserWindow.history.pushState.bind(browserWindow.history);
  const originalReplaceState = browserWindow.history.replaceState.bind(browserWindow.history);
  const routeKey = () => `${browserWindow.location.pathname || ''}${browserWindow.location.search || ''}`;
  let currentUrl = routeKey();

  browserWindow.history.scrollRestoration = 'manual';

  browserWindow.history.pushState = (...args) => {
    positions.set(currentUrl, browserWindow.scrollY);
    const result = originalPushState(...args);
    currentUrl = routeKey();
    return result;
  };

  browserWindow.history.replaceState = (...args) => {
    const result = originalReplaceState(...args);
    currentUrl = routeKey();
    return result;
  };

  function handlePopState(event) {
    if (event?.isTrusted === false) return;
    positions.set(currentUrl, browserWindow.scrollY);
    currentUrl = routeKey();
    historyTraversal = true;
  }

  function cancelPendingRestore() {
    if (restoreFrame !== undefined) {
      browserWindow.cancelAnimationFrame(restoreFrame);
      restoreFrame = undefined;
    }
    for (const timer of restoreTimers) browserWindow.clearTimeout(timer);
    restoreTimers = [];
  }

  function handleUserScrollIntent() {
    cancelPendingRestore();
  }

  function handleRouteChange({ url = '' } = {}) {
    currentUrl = url || routeKey();
    if (browserWindow.location.hash) {
      historyTraversal = false;
      return;
    }

    const targetTop = historyTraversal ? positions.get(url) || 0 : 0;
    historyTraversal = false;

    cancelPendingRestore();
    const restore = () => {
      if (currentUrl !== url) return;
      restoreFrame = undefined;
      browserWindow.scrollTo({ top: targetTop, left: 0, behavior: 'auto' });
    };
    restoreFrame = browserWindow.requestAnimationFrame(restore);
    if (targetTop > 0) {
      restoreTimers = [50, 200, 600].map((delay) => browserWindow.setTimeout(restore, delay));
    }
  }

  function dispose() {
    browserWindow.removeEventListener('popstate', handlePopState, true);
    for (const eventName of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
      browserWindow.removeEventListener(eventName, handleUserScrollIntent, true);
    }
    cancelPendingRestore();
    browserWindow.history.pushState = originalPushState;
    browserWindow.history.replaceState = originalReplaceState;
    browserWindow.history.scrollRestoration = previousScrollRestoration;
  }

  browserWindow.addEventListener('popstate', handlePopState, true);
  for (const eventName of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    browserWindow.addEventListener(eventName, handleUserScrollIntent, true);
  }
  return { handleRouteChange, dispose };
}
