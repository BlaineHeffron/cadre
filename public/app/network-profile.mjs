const LOW_DATA_MODE_KEY = 'dueno_low_data_mode';

export function isLowDataModeEnabled() {
  try {
    return localStorage.getItem(LOW_DATA_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setLowDataModeEnabled(enabled) {
  try {
    if (enabled) localStorage.setItem(LOW_DATA_MODE_KEY, '1');
    else localStorage.removeItem(LOW_DATA_MODE_KEY);
  } catch {
    // ignore storage failures
  }
}

export function connectionPrefersLowData() {
  if (typeof navigator === 'undefined') return false;
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!connection) return false;
  if (connection.saveData) return true;
  return connection.effectiveType === 'slow-2g' || connection.effectiveType === '2g';
}

export function shouldReduceNetworkActivity() {
  return isLowDataModeEnabled() || connectionPrefersLowData();
}

export function shouldPauseRealtimeWhenHidden() {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'hidden' && shouldReduceNetworkActivity();
}

export function getAdaptivePollMs({ activeMs, reducedMs, hiddenMs }) {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    return hiddenMs;
  }
  if (shouldReduceNetworkActivity()) {
    return reducedMs;
  }
  return activeMs;
}
