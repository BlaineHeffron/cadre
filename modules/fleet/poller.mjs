import { fleetMarkersFromBusinessOsHealth } from './markers.mjs';
import { createHash } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_SECONDS = 120;
const MAX_DEBUG_ROWS = 50;

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeStatus(value) {
  const status = normalizeText(value).toLowerCase();
  if (status === 'ok') return 'ok';
  if (status === 'degraded') return 'degraded';
  return status || 'unknown';
}

function safeKey(value, fallback = 'unknown') {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96) || fallback;
}

function safeMessageHash(value) {
  const text = normalizeText(value).toLowerCase().replace(/\s+/g, ' ').slice(0, 2000);
  if (!text) return 'none';
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function timeBucketMs(row = {}) {
  const value = Number(row.occurred_at_ms || row.occurredAtMs || row.created_at_ms || row.createdAtMs || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value / 60_000) * 60_000;
}

function increment(map, key) {
  const safe = safeKey(key);
  map[safe] = (map[safe] || 0) + 1;
}

function makeDebugCounts() {
  return {
    total: 0,
    capped: false,
    unavailable: null,
    bySource: {},
    bySeverity: {},
    byCategory: {},
    byErrorCode: {},
    debugGroups: [],
  };
}

export function summarizeDebugRows(debugResponse = {}, { maxRows = MAX_DEBUG_ROWS } = {}) {
  const counts = makeDebugCounts();
  const rows = Array.isArray(debugResponse.rows) ? debugResponse.rows.slice(0, maxRows) : [];
  counts.total = rows.length;
  counts.capped = Array.isArray(debugResponse.rows) && debugResponse.rows.length > rows.length;
  const groups = new Map();
  for (const row of rows) {
    increment(counts.bySource, row?.source);
    increment(counts.bySeverity, row?.severity);
    increment(counts.byCategory, row?.category);
    increment(counts.byErrorCode, row?.error_code);
    const source = safeKey(row?.source);
    const severity = safeKey(row?.severity);
    const category = safeKey(row?.category);
    const errorCode = safeKey(row?.error_code);
    const messageHash = safeMessageHash(row?.error_message || row?.message || row?.detail);
    const bucketMs = timeBucketMs(row);
    const dismissKey = [source, severity, category, errorCode, messageHash].join('|');
    const key = [dismissKey, bucketMs].join('|');
    const occurredAtMs = Number(row?.occurred_at_ms || row?.occurredAtMs || row?.created_at_ms || row?.createdAtMs || 0) || null;
    const existing = groups.get(key) || {
      id: `debuggrp_${createHash('sha256').update(key).digest('hex').slice(0, 12)}`,
      dismissKey: `debugsig_${createHash('sha256').update(dismissKey).digest('hex').slice(0, 12)}`,
      count: 0,
      source,
      severity,
      category,
      errorCode,
      messageHash,
      bucketMs,
      firstOccurredAtMs: occurredAtMs,
      lastOccurredAtMs: occurredAtMs,
    };
    existing.count += 1;
    if (occurredAtMs) {
      existing.firstOccurredAtMs = existing.firstOccurredAtMs ? Math.min(existing.firstOccurredAtMs, occurredAtMs) : occurredAtMs;
      existing.lastOccurredAtMs = existing.lastOccurredAtMs ? Math.max(existing.lastOccurredAtMs, occurredAtMs) : occurredAtMs;
    }
    groups.set(key, existing);
  }
  counts.debugGroups = [...groups.values()].sort((a, b) =>
    (b.count - a.count) || ((b.lastOccurredAtMs || 0) - (a.lastOccurredAtMs || 0))
  );
  return counts;
}

function sanitizedError(error) {
  if (error?.name === 'AbortError') return 'timeout';
  const code = normalizeText(error?.code).toLowerCase();
  if (code.includes('timeout')) return 'timeout';
  if (code.includes('auth') || code.includes('unauthorized') || code.includes('forbidden')) return 'unauthorized';
  if (code.includes('json') || code.includes('parse')) return 'malformed_response';
  if (code.includes('http_401') || code.includes('http_403')) return 'unauthorized';
  if (code.includes('http_404')) return 'not_found';
  if (code.includes('http_5')) return 'server_error';
  if (error instanceof TypeError) return 'unreachable';
  return 'poll_failed';
}

async function fetchJsonWithTimeout(fetchImpl, url, {
  token = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (!response || typeof response.status !== 'number') {
      const error = new Error('invalid fetch response');
      error.code = 'malformed_response';
      throw error;
    }
    if (response.status === 404) {
      const error = new Error('not found');
      error.code = 'http_404';
      throw error;
    }
    if (response.status === 401 || response.status === 403) {
      const error = new Error('unauthorized');
      error.code = `http_${response.status}`;
      throw error;
    }
    if (!response.ok) {
      const error = new Error('http error');
      error.code = `http_${response.status}`;
      throw error;
    }
    try {
      return await response.json();
    } catch {
      const error = new Error('invalid json');
      error.code = 'json_parse_failed';
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

function healthUrl(deployment) {
  return `${normalizeText(deployment.baseUrl).replace(/\/+$/g, '')}/api/diagnostics/health`;
}

function debugUrl(deployment) {
  return `${normalizeText(deployment.baseUrl).replace(/\/+$/g, '')}/api/debug`;
}

function safeDeploymentResult(deployment, nowMs, overrides = {}) {
  return {
    deploymentId: deployment.deploymentId,
    displayName: null,
    buildSha: null,
    status: 'unknown',
    markers: [],
    reachable: false,
    lastPollMs: nowMs,
    error: null,
    debugCounts: makeDebugCounts(),
    ...overrides,
  };
}

export async function pollFleetDeployment(deployment, {
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxDebugRows = MAX_DEBUG_ROWS,
} = {}) {
  const nowMs = now();
  if (typeof fetchImpl !== 'function') {
    return safeDeploymentResult(deployment, nowMs, { error: 'fetch_unavailable' });
  }
  if (!deployment?.baseUrl) {
    return safeDeploymentResult(deployment, nowMs, { error: 'missing_base_url' });
  }
  try {
    const health = await fetchJsonWithTimeout(fetchImpl, healthUrl(deployment), {
      token: deployment.token,
      timeoutMs,
    });
    const markers = fleetMarkersFromBusinessOsHealth(health);
    const status = markers.length > 0 ? 'degraded' : normalizeStatus(health.status);
    const result = safeDeploymentResult(deployment, nowMs, {
      displayName: normalizeText(health.display_name) || null,
      buildSha: normalizeText(health.build_sha) || null,
      status,
      markers,
      reachable: true,
      error: null,
    });

    if (markers.length === 0 || deployment.debugFetchOnDegraded === false) {
      return result;
    }

    try {
      const debug = await fetchJsonWithTimeout(fetchImpl, debugUrl(deployment), {
        token: deployment.token,
        timeoutMs,
      });
      result.debugCounts = summarizeDebugRows(debug, { maxRows: maxDebugRows });
    } catch (error) {
      const reason = sanitizedError(error);
      result.debugCounts = {
        ...makeDebugCounts(),
        unavailable: reason === 'not_found' ? 'disabled' : reason,
      };
    }
    return result;
  } catch (error) {
    return safeDeploymentResult(deployment, nowMs, {
      status: 'degraded',
      markers: ['unreachable'],
      reachable: false,
      error: sanitizedError(error),
    });
  }
}

export class FleetPoller {
  constructor({
    registry,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onSnapshot = () => {},
    beforePoll = () => {},
  } = {}) {
    this.registry = registry || { deployments: [] };
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.onSnapshot = onSnapshot;
    this.beforePoll = beforePoll;
    this.timers = new Map();
  }

  async pollDeployment(deployment) {
    return pollFleetDeployment(deployment, {
      fetchImpl: this.fetchImpl,
      now: this.now,
      timeoutMs: this.timeoutMs,
    });
  }

  async pollOnce() {
    await this.beforePoll();
    const results = [];
    for (const deployment of this.registry.deployments || []) {
      const result = await this.pollDeployment(deployment);
      results.push(result);
      await this.onSnapshot(result);
    }
    return results;
  }

  start() {
    this.stop();
    for (const deployment of this.registry.deployments || []) {
      const intervalMs = Math.max(
        1,
        Number(deployment.pollingIntervalSeconds || DEFAULT_INTERVAL_SECONDS)
      ) * 1000;
      const run = async () => {
        await this.beforePoll();
        const result = await this.pollDeployment(deployment);
        await this.onSnapshot(result);
      };
      const timer = setInterval(run, intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.timers.set(deployment.deploymentId, timer);
    }
  }

  stop() {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }
}

export const FLEET_POLLER_DEFAULTS = Object.freeze({
  timeoutMs: DEFAULT_TIMEOUT_MS,
  intervalSeconds: DEFAULT_INTERVAL_SECONDS,
  maxDebugRows: MAX_DEBUG_ROWS,
});
