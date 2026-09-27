import { h } from 'preact';
import { useRef, useEffect, useLayoutEffect } from 'preact/hooks';
import { ansiToHtml } from '../lib/ansi-to-html.mjs';

export function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function escapeHtml(text = '') {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(escapedUrl) {
  try {
    const href = escapedUrl.replace(/&amp;/g, '&');
    const parsed = new URL(href);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return escapeHtml(parsed.href);
  } catch {
    return '';
  }
}

function linkifyHtml(text = '') {
  return text.replace(
    /\bhttps?:\/\/[^\s<>"']+/g,
    (url) => {
      const href = safeHref(url);
      return href ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>` : url;
    }
  );
}

export function Terminal({
  content,
  maxHeight = '500px',
  fullHeight = false,
  ansiColors = false,
  captureKeyboard = false,
  onTerminalKeyDown = null,
  autoFocusKeyboard = false,
  onLoadMore = null,
  hasMore = false,
  loadingMore = false,
  resetKey = '',
}) {
  const ref = useRef(null);
  const userScrollIntent = useRef(false);
  const suppressLoadMoreUntil = useRef(0);
  const pendingPrepend = useRef(false);
  const previousResetKey = useRef(resetKey);
  const scrollSnapshot = useRef({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    distanceFromBottom: 0,
    atBottom: true,
  });

  function readScrollSnapshot(el) {
    const distanceFromBottom = Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      distanceFromBottom,
      atBottom: distanceFromBottom < 40,
    };
  }

  function rememberScrollPosition(el = ref.current) {
    if (!el) return scrollSnapshot.current;
    scrollSnapshot.current = readScrollSnapshot(el);
    return scrollSnapshot.current;
  }

  function setScrollTop(el, top) {
    const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.max(0, Math.min(maxTop, top));
    rememberScrollPosition(el);
  }

  function scrollToBottomWithRetries() {
    if (!ref.current) return undefined;
    const el = ref.current;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    suppressLoadMoreUntil.current = now + 250;
    setScrollTop(el, el.scrollHeight);
    const requestFrame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (callback) => setTimeout(callback, 0);
    const cancelFrame = typeof cancelAnimationFrame === 'function'
      ? cancelAnimationFrame
      : clearTimeout;
    const frame = requestFrame(() => { setScrollTop(el, el.scrollHeight); });
    const timer = setTimeout(() => { setScrollTop(el, el.scrollHeight); }, 80);
    return () => {
      cancelFrame(frame);
      clearTimeout(timer);
    };
  }

  useLayoutEffect(() => {
    if (!ref.current) return undefined;
    const el = ref.current;
    const snapshot = scrollSnapshot.current;
    const resetChanged = previousResetKey.current !== resetKey;
    previousResetKey.current = resetKey;

    if (resetChanged) {
      pendingPrepend.current = false;
      userScrollIntent.current = false;
      return scrollToBottomWithRetries();
    }

    if (snapshot.atBottom) {
      pendingPrepend.current = false;
      return scrollToBottomWithRetries();
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    suppressLoadMoreUntil.current = now + 250;
    if (pendingPrepend.current) {
      setScrollTop(el, snapshot.scrollTop + (el.scrollHeight - snapshot.scrollHeight));
      pendingPrepend.current = false;
    } else {
      // New output is appended below the viewport. Keep the same visible rows;
      // anchoring to the old bottom distance makes the viewport drift downward.
      setScrollTop(el, snapshot.scrollTop);
    }
    return undefined;
  }, [content, resetKey]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== 'function') return undefined;

    let frame;
    const keepBottomPinned = () => {
      if (!scrollSnapshot.current.atBottom) return;
      if (frame !== undefined && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frame);
      }
      const requestFrame = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 0);
      frame = requestFrame(() => {
        frame = undefined;
        if (scrollSnapshot.current.atBottom && ref.current) {
          setScrollTop(ref.current, ref.current.scrollHeight);
        }
      });
    };
    const observer = new ResizeObserver(keepBottomPinned);
    observer.observe(el);
    const body = el.querySelector('.terminal-body');
    if (body) observer.observe(body);

    return () => {
      observer.disconnect();
      if (frame !== undefined) {
        const cancelFrame = typeof cancelAnimationFrame === 'function'
          ? cancelAnimationFrame
          : clearTimeout;
        cancelFrame(frame);
      }
    };
  }, [resetKey]);

  function handleScroll() {
    if (!ref.current) return;
    const el = ref.current;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const snapshot = rememberScrollPosition(el);
    if (snapshot.atBottom) {
      userScrollIntent.current = false;
    }

    if (
      hasMore &&
      onLoadMore &&
      !loadingMore &&
      userScrollIntent.current &&
      now >= suppressLoadMoreUntil.current &&
      el.scrollTop < 60
    ) {
      pendingPrepend.current = true;
      onLoadMore();
    }
  }

  function markUserScrollIntent() {
    userScrollIntent.current = true;
  }

  useEffect(() => {
    if (captureKeyboard && autoFocusKeyboard && ref.current) {
      ref.current.focus({ preventScroll: true });
    }
  }, [captureKeyboard, autoFocusKeyboard]);

  function focusTerminal() {
    if (captureKeyboard && ref.current) {
      ref.current.focus();
    }
  }

  function handlePointerDown() {
    markUserScrollIntent();
    // Focus before the click completes so the next arrow/key event stays
    // attached to the terminal across live pane redraws.
    focusTerminal();
  }

  function loadMoreFromClick() {
    pendingPrepend.current = true;
    rememberScrollPosition();
    onLoadMore?.();
  }

  const style = fullHeight
    ? 'flex:1; min-height:0; overflow:auto; overflow-anchor:none'
    : `max-height:${maxHeight}; min-height:200px; overflow-anchor:none`;

  const normalizedContent = typeof content === 'string' ? content.replace(/\r/g, '') : '';
  const trimmedContent = normalizedContent
    ? normalizedContent.split('\n').map((line) => line.replace(/[ \t]+$/g, '')).join('\n')
    : '';
  const plainContent = stripAnsi(trimmedContent || '');
  const htmlBody = ansiColors
    ? linkifyHtml(ansiToHtml(trimmedContent || ''))
    : linkifyHtml(escapeHtml(plainContent));

  const children = [];
  if (hasMore && onLoadMore) {
    children.push(h('div', {
      class: 'terminal-load-more',
      style: 'text-align:center; padding:6px; color:var(--text-muted); font-size:12px; cursor:pointer; user-select:none',
      onClick: !loadingMore ? loadMoreFromClick : undefined,
    }, loadingMore ? 'Loading...' : 'Scroll up or tap to load more history'));
  }
  children.push(h('div', { class: 'terminal-body', dangerouslySetInnerHTML: { __html: htmlBody } }));

  return h(
    'div',
    {
      ref,
      class: `terminal ${fullHeight ? 'terminal-fullheight' : ''} ${captureKeyboard ? 'terminal-interactive' : ''}`,
      style,
      tabIndex: captureKeyboard ? 0 : undefined,
      onClick: focusTerminal,
      onPointerDown: handlePointerDown,
      onWheel: markUserScrollIntent,
      onTouchStart: markUserScrollIntent,
      onScroll: handleScroll,
      onKeyDown: captureKeyboard ? onTerminalKeyDown : undefined,
      title: captureKeyboard ? 'Click terminal and type to send keys' : undefined,
    },
    ...children,
  );
}
