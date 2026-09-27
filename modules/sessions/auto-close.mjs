function text(value) {
  return String(value || '').trim();
}

export function latestFreshPaneExecution(observations = [], now = Date.now()) {
  const timestamp = Number(now);
  const candidates = (Array.isArray(observations) ? observations : [])
    .filter((item) => (
      item
      && item.source === 'pane'
      && (item.kind === 'execution' || item.kind === 'screen')
      && (Number(item.expiresAt) === 0 || Number(item.expiresAt) > timestamp)
      && text(item.value?.execution)
    ))
    .sort((left, right) => (Number(right.observedAt) || 0) - (Number(left.observedAt) || 0));
  return text(candidates[0]?.value?.execution);
}

// Dwell is latched on the first transcript-idle observation and held across
// later idle fingerprints. A new completed turn mid-dwell does not reset the
// timer; when_waiting_for_input means "has been idle long enough", not "this
// specific turn has been idle long enough".
export function nextTranscriptIdleSince({
  execution = '',
  executionSource = '',
  previousIdleSince = 0,
  now = Date.now(),
} = {}) {
  if (text(execution) === 'idle' && text(executionSource) === 'transcript') {
    const prior = Number(previousIdleSince);
    return Number.isFinite(prior) && prior > 0 ? prior : Number(now);
  }
  return 0;
}

export function shouldAutoCloseSession({
  autoCloseMode = 'never',
  autoCloseAfterMs = 0,
  now = Date.now(),
  idleSince = 0,
  execution = '',
  executionSource = '',
  lifecycle = '',
  paneExecution = '',
} = {}) {
  const mode = text(autoCloseMode) || 'never';
  const processGone = lifecycle === 'ended' || lifecycle === 'missing';
  if (processGone && (mode === 'on_exit' || mode === 'when_waiting_for_input')) {
    return Object.freeze({ close: true, reason: 'process_gone' });
  }

  const transcriptTerminal = text(execution) === 'idle' && text(executionSource) === 'transcript';
  const paneBusy = text(paneExecution) === 'working' || text(paneExecution) === 'thinking';
  const delayMs = Number(autoCloseAfterMs);
  const seenAt = Number(idleSince);
  if (
    mode === 'when_waiting_for_input'
    && transcriptTerminal
    && !paneBusy
    && Number.isFinite(delayMs)
    && delayMs >= 0
    && Number.isFinite(seenAt)
    && seenAt > 0
    && Number(now) - seenAt >= delayMs
  ) {
    return Object.freeze({ close: true, reason: 'transcript_terminal' });
  }

  return Object.freeze({ close: false, reason: '' });
}
