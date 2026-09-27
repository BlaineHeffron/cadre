const FAILED_RECEIPTS_1H_SPIKE = 3;
const LLM_FAILURES_1H_SPIKE = 3;

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeStatus(value) {
  return normalizeText(value).toLowerCase();
}

function safeToken(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}

function numberValue(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function pushUnique(markers, marker) {
  if (!markers.includes(marker)) markers.push(marker);
}

export function fleetMarkersFromBusinessOsHealth(health = {}) {
  const markers = [];
  if (normalizeStatus(health.status) === 'degraded') {
    pushUnique(markers, 'degraded');
  }

  if (numberValue(health?.outbox?.terminal_jobs) > 0) {
    pushUnique(markers, 'dead_letter_growth');
  }

  for (const pump of Array.isArray(health.pumps) ? health.pumps : []) {
    const lastOutcome = normalizeText(pump?.last_outcome).toLowerCase();
    if (lastOutcome.startsWith('error')) {
      pushUnique(markers, `connector_degraded:${safeToken(pump?.pump)}`);
    }
  }

  if (numberValue(health?.errors_1h?.failed_receipts) >= FAILED_RECEIPTS_1H_SPIKE) {
    pushUnique(markers, 'error_rate_spike');
  }

  if (numberValue(health?.errors_1h?.llm_failures) >= LLM_FAILURES_1H_SPIKE) {
    pushUnique(markers, 'llm_error_spike');
  }

  return markers;
}

export const FLEET_MARKER_THRESHOLDS = Object.freeze({
  failedReceipts1hSpike: FAILED_RECEIPTS_1H_SPIKE,
  llmFailures1hSpike: LLM_FAILURES_1H_SPIKE,
});
