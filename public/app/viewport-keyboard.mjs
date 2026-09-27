export function installViewportKeyboardInset() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const root = document.documentElement;

  function update() {
    const viewport = window.visualViewport;
    const inset = viewport
      ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
      : 0;
    root.style.setProperty('--keyboard-inset', `${Math.round(inset)}px`);
  }

  update();
  window.visualViewport?.addEventListener('resize', update);
  window.visualViewport?.addEventListener('scroll', update);
  window.addEventListener('orientationchange', update);
}
