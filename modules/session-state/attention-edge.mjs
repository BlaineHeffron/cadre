const BUSY_STATUSES = new Set(['working', 'thinking', 'blocked', 'awaiting_response']);

export function nextRememberedStatus(previous, status) {
  const value = String(status || '');
  if (value === 'ready' || BUSY_STATUSES.has(value)) return value;
  return previous;
}

export function isFinishedWorkEdge(previous, status) {
  return String(status || '') === 'ready' && BUSY_STATUSES.has(previous);
}

export { BUSY_STATUSES };
