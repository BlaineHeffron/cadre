import {
  CAPABILITIES,
  createInitialSnapshot,
  deepFreeze,
  normalizeObservation,
} from './contract.mjs';
import { reduce } from './reducer.mjs';

function observationKey(observation) {
  return `${observation.source}:${observation.kind}`;
}

// Slowest pane producer is the background discover loop (15s). Pane evidence
// stays fresh for 3x that cadence so a missed tick cannot flap a live session.
// Process lifecycle has no dwell requirement and uses a shorter TTL so a
// stopped session loses capability grants without shrinking pane freshness.
export const PANE_OBSERVER_CADENCE_MS = 15_000;
export const PANE_FRESH_MS = PANE_OBSERVER_CADENCE_MS * 3;
export const PROCESS_LIFECYCLE_FRESH_MS = 25_000;
export const MIN_PANE_STABILITY_MS = 20;
export const PANE_STABILITY_MATCH_MS = PANE_FRESH_MS;

function paneFreeTextStable(existing, observation) {
  if (!existing || existing.value?.kind !== 'free_text') return false;
  const fingerprintMatch = existing.fingerprint === observation.fingerprint
    || (
      Boolean(observation.value?.stabilityFingerprint)
      && existing.value?.stabilityFingerprint === observation.value.stabilityFingerprint
    );
  if (!fingerprintMatch) return false;
  const ageMs = observation.observedAt - existing.observedAt;
  if (ageMs < 0 || ageMs > PANE_STABILITY_MATCH_MS) return false;
  return existing.value?.stable === true
    || existing.observedAt + MIN_PANE_STABILITY_MS <= observation.observedAt;
}

function cloneForExplanation(value) {
  return structuredClone(value);
}

export function createSessionStateTracker({
  now = () => Date.now(),
  historyLimit = 32,
} = {}) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (!Number.isInteger(historyLimit) || historyLimit < 1) {
    throw new TypeError('historyLimit must be a positive integer');
  }

  const sessions = new Map();

  function currentTime() {
    const value = Number(now());
    if (!Number.isFinite(value) || value < 0) throw new TypeError('now() must return a non-negative finite number');
    return value;
  }

  function ensure(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) throw new TypeError('sessionId is required');
    if (!sessions.has(id)) {
      sessions.set(id, {
        snapshot: createInitialSnapshot(id, currentTime()),
        observations: new Map(),
        listeners: new Set(),
        history: [],
        expiryTimer: null,
      });
    }
    return sessions.get(id);
  }

  function notify(record, snapshot) {
    for (const listener of [...record.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Listener failures must not corrupt canonical state or block peers.
      }
    }
  }

  function scheduleExpiry(sessionId, record, timestamp) {
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    record.expiryTimer = null;
    const expiries = [...record.observations.values()]
      .map((observation) => observation.expiresAt)
      .filter((expiresAt) => expiresAt > timestamp)
      .sort((left, right) => left - right);
    if (!expiries.length) return;
    const delay = Math.max(0, Math.min(2_147_483_647, expiries[0] - timestamp));
    record.expiryTimer = setTimeout(() => {
      record.expiryTimer = null;
      refresh(sessionId, record);
    }, delay);
    record.expiryTimer.unref?.();
  }

  function refresh(sessionId, record = ensure(sessionId)) {
    const timestamp = currentTime();
    const previous = record.snapshot;
    const snapshot = reduce(previous, record.observations, timestamp);
    record.snapshot = snapshot;
    if (snapshot.revision !== previous.revision) {
      record.history.push(deepFreeze({
        revision: snapshot.revision,
        updatedAt: snapshot.updatedAt,
        status: snapshot.status,
        reason: snapshot.reason,
      }));
      if (record.history.length > historyLimit) record.history.splice(0, record.history.length - historyLimit);
      notify(record, snapshot);
    }
    scheduleExpiry(sessionId, record, timestamp);
    return snapshot;
  }

  function observe(sessionId, observationOrList) {
    const record = ensure(sessionId);
    const observations = Array.isArray(observationOrList) ? observationOrList : [observationOrList];
    if (!observations.length) return refresh(sessionId, record);

    for (const raw of observations) {
      let observation = normalizeObservation(raw);
      const key = observationKey(observation);
      const existing = record.observations.get(key);
      if (
        observation.source === 'pane'
        && observation.kind === 'interaction'
        && observation.value?.kind === 'free_text'
        && observation.value?.requireRepeat === true
      ) {
        observation = normalizeObservation({
          ...observation,
          value: {
            ...observation.value,
            stable: paneFreeTextStable(existing, observation),
          },
        });
      }
      if (existing && observation.observedAt < existing.observedAt) continue;
      if (
        existing
        && observation.observedAt === existing.observedAt
        && observation.fingerprint === existing.fingerprint
        && observation.expiresAt === existing.expiresAt
        && JSON.stringify(observation.value) === JSON.stringify(existing.value)
      ) continue;
      record.observations.set(key, observation);
    }
    return refresh(sessionId, record);
  }

  function get(sessionId) {
    return refresh(sessionId, ensure(sessionId));
  }

  function subscribe(sessionId, callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    const record = ensure(sessionId);
    record.listeners.add(callback);
    return () => record.listeners.delete(callback);
  }

  function waitForCapability(sessionId, capability, {
    timeoutMs = 30_000,
    signal,
    expectedRevision,
    expectedFingerprint,
  } = {}) {
    const capabilityName = String(capability || '');
    if (!CAPABILITIES.includes(capabilityName)) {
      return Promise.reject(new TypeError(`Unknown capability: ${capabilityName}`));
    }
    if (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) < 0) {
      return Promise.reject(new TypeError('timeoutMs must be a non-negative finite number'));
    }

    return new Promise((resolve, reject) => {
      let timer = null;
      let unsubscribe = () => {};

      function cleanup() {
        if (timer) clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
      }

      function onAbort() {
        cleanup();
        reject(signal.reason || new Error('Capability wait aborted'));
      }

      function check(snapshot) {
        if (snapshot.capabilities[capabilityName] !== true) return false;
        if (expectedRevision !== undefined && snapshot.revision !== expectedRevision) return false;
        if (expectedFingerprint !== undefined && snapshot.interaction.fingerprint !== expectedFingerprint) return false;
        cleanup();
        resolve(snapshot);
        return true;
      }

      if (signal?.aborted) {
        onAbort();
        return;
      }
      unsubscribe = subscribe(sessionId, check);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (check(get(sessionId))) return;
      timer = setTimeout(() => {
        cleanup();
        const error = new Error(`Timed out waiting for ${capabilityName} capability`);
        error.code = 'CAPABILITY_TIMEOUT';
        reject(error);
      }, Number(timeoutMs));
    });
  }

  function explain(sessionId) {
    const record = ensure(sessionId);
    const snapshot = refresh(sessionId, record);
    const timestamp = currentTime();
    return deepFreeze({
      snapshot,
      observations: [...record.observations.values()]
        .sort((left, right) => left.source.localeCompare(right.source) || left.kind.localeCompare(right.kind))
        .map((observation) => ({
          ...cloneForExplanation(observation),
          ageMs: Math.max(0, timestamp - observation.observedAt),
          expired: observation.expiresAt > 0 && observation.expiresAt <= timestamp,
        })),
      history: record.history.map(cloneForExplanation),
    });
  }

  function remove(sessionId) {
    const id = String(sessionId || '').trim();
    const record = sessions.get(id);
    if (!record) return false;
    if (record.expiryTimer) clearTimeout(record.expiryTimer);
    record.listeners.clear();
    return sessions.delete(id);
  }

  return Object.freeze({ observe, get, subscribe, waitForCapability, explain, remove });
}

export const sessionStateTracker = createSessionStateTracker();

export const observe = sessionStateTracker.observe;
export const get = sessionStateTracker.get;
export const subscribe = sessionStateTracker.subscribe;
export const waitForCapability = sessionStateTracker.waitForCapability;
export const explain = sessionStateTracker.explain;
export const remove = sessionStateTracker.remove;
