import { randomBytes } from 'node:crypto';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { legacyRootStatePath, runtimeStatePath } from '../ops/runtime-state.mjs';

const DEFAULT_HEALTHY_POLLS_TO_RESOLVE = 2;
const DEFAULT_STORE_FILE = runtimeStatePath('fleet_incidents.json');
const LEGACY_STORE_FILE = legacyRootStatePath('fleet_incidents.json');

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeMarker(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function uniqueMarkers(markers = []) {
  return [...new Set(
    (Array.isArray(markers) ? markers : [])
      .map(normalizeMarker)
      .filter(Boolean)
  )].sort();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function generateId(prefix = 'fleetinc') {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function normalizeDebugCounts(value = {}) {
  const debugGroups = Array.isArray(value.debugGroups)
    ? value.debugGroups.map((group) => ({
      id: normalizeText(group?.id),
      dismissKey: normalizeText(group?.dismissKey || group?.id),
      count: Number(group?.count || 0) || 0,
      source: normalizeText(group?.source || 'unknown') || 'unknown',
      severity: normalizeText(group?.severity || 'unknown') || 'unknown',
      category: normalizeText(group?.category || 'unknown') || 'unknown',
      errorCode: normalizeText(group?.errorCode || 'unknown') || 'unknown',
      messageHash: normalizeText(group?.messageHash || 'none') || 'none',
      bucketMs: Number(group?.bucketMs || 0) || 0,
      firstOccurredAtMs: Number(group?.firstOccurredAtMs || 0) || null,
      lastOccurredAtMs: Number(group?.lastOccurredAtMs || 0) || null,
    })).filter((group) => group.id && group.count > 0)
    : [];
  return {
    total: Number.isFinite(Number(value.total)) ? Number(value.total) : 0,
    capped: value.capped === true,
    unavailable: normalizeText(value.unavailable || '') || null,
    bySource: value.bySource && typeof value.bySource === 'object' ? clone(value.bySource) : {},
    bySeverity: value.bySeverity && typeof value.bySeverity === 'object' ? clone(value.bySeverity) : {},
    byCategory: value.byCategory && typeof value.byCategory === 'object' ? clone(value.byCategory) : {},
    byErrorCode: value.byErrorCode && typeof value.byErrorCode === 'object' ? clone(value.byErrorCode) : {},
    debugGroups,
  };
}

function sanitizePollSnapshot(pollResult = {}) {
  return {
    deploymentId: normalizeText(pollResult.deploymentId),
    displayName: normalizeText(pollResult.displayName || '') || null,
    status: normalizeText(pollResult.status || 'unknown').toLowerCase() || 'unknown',
    markers: uniqueMarkers(pollResult.markers),
    reachable: pollResult.reachable !== false,
    lastPollMs: Number.isFinite(Number(pollResult.lastPollMs)) ? Number(pollResult.lastPollMs) : null,
    error: normalizeText(pollResult.error || '') || null,
  };
}

export function buildFleetEvidencePacket(incident, pollResult = {}, { nowMs = Date.now() } = {}) {
  const snapshot = sanitizePollSnapshot(pollResult);
  return {
    incidentId: incident.id,
    deploymentId: incident.deploymentId,
    capturedAtMs: nowMs,
    healthSnapshot: snapshot,
    debugCounts: normalizeDebugCounts(pollResult.debugCounts),
  };
}

function normalizePriorIncident(priorIncident) {
  if (!priorIncident || typeof priorIncident !== 'object') return null;
  return {
    ...clone(priorIncident),
    markers: uniqueMarkers(priorIncident.markers),
    markerHistory: Array.isArray(priorIncident.markerHistory)
      ? priorIncident.markerHistory
        .map((entry) => ({
          marker: normalizeMarker(entry?.marker),
          firstSeenMs: Number(entry?.firstSeenMs || entry?.firstSeen || 0) || 0,
          lastSeenMs: Number(entry?.lastSeenMs || entry?.lastSeen || 0) || 0,
        }))
        .filter((entry) => entry.marker)
      : [],
    occurrenceCount: Math.max(0, Number(priorIncident.occurrenceCount || 0)),
    healthyPollCount: Math.max(0, Number(priorIncident.healthyPollCount || 0)),
  };
}

function mergeMarkerHistory(existing = [], markers = [], nowMs) {
  const byMarker = new Map();
  for (const entry of existing) {
    byMarker.set(entry.marker, { ...entry });
  }
  for (const marker of markers) {
    const existingEntry = byMarker.get(marker);
    byMarker.set(marker, {
      marker,
      firstSeenMs: existingEntry?.firstSeenMs || nowMs,
      lastSeenMs: nowMs,
    });
  }
  return [...byMarker.values()].sort((a, b) => a.marker.localeCompare(b.marker));
}

function makeIncident(pollResult, markers, nowMs) {
  const deploymentId = normalizeText(pollResult.deploymentId);
  const id = generateId('fleetinc');
  return {
    id,
    deploymentId,
    status: 'open',
    markers,
    markerHistory: mergeMarkerHistory([], markers, nowMs),
    openedAtMs: nowMs,
    updatedAtMs: nowMs,
    occurrenceCount: 1,
    healthyPollCount: 0,
    evidenceRef: `fleet_evidence:${id}`,
  };
}

export function transitionFleetIncident(pollResult = {}, priorIncident = null, {
  nowMs = Date.now(),
  healthyPollsToResolve = DEFAULT_HEALTHY_POLLS_TO_RESOLVE,
} = {}) {
  const markers = uniqueMarkers(pollResult.markers);
  const prior = normalizePriorIncident(priorIncident);
  const events = [];
  const resolveAfter = Math.max(1, Number(healthyPollsToResolve || DEFAULT_HEALTHY_POLLS_TO_RESOLVE));

  if (!prior && markers.length === 0) {
    return { incident: null, evidence: null, events };
  }

  if (!prior) {
    const incident = makeIncident(pollResult, markers, nowMs);
    const evidence = buildFleetEvidencePacket(incident, pollResult, { nowMs });
    events.push({ type: 'opened', incidentId: incident.id, deploymentId: incident.deploymentId });
    return { incident, evidence, events };
  }

  if (markers.length > 0 && prior.status === 'resolved') {
    const incident = makeIncident(pollResult, markers, nowMs);
    const evidence = buildFleetEvidencePacket(incident, pollResult, { nowMs });
    events.push({ type: 'opened', incidentId: incident.id, deploymentId: incident.deploymentId });
    return { incident, evidence, events };
  }

  if (markers.length > 0) {
    const incident = {
      ...prior,
      status: prior.status,
      markers,
      markerHistory: mergeMarkerHistory(prior.markerHistory, markers, nowMs),
      updatedAtMs: nowMs,
      occurrenceCount: prior.occurrenceCount + 1,
      healthyPollCount: 0,
      resolvedAtMs: prior.resolvedAtMs,
      evidenceRef: prior.evidenceRef || `fleet_evidence:${prior.id}`,
    };
    const evidence = buildFleetEvidencePacket(incident, pollResult, { nowMs });
    events.push({
      type: 'updated',
      incidentId: incident.id,
      deploymentId: incident.deploymentId,
    });
    return { incident, evidence, events };
  }

  if (prior.status === 'resolved') {
    return { incident: prior, evidence: null, events };
  }

  const healthyPollCount = prior.healthyPollCount + 1;
  if (healthyPollCount < resolveAfter) {
    const incident = {
      ...prior,
      updatedAtMs: nowMs,
      healthyPollCount,
    };
    events.push({ type: 'healthy_observed', incidentId: incident.id, deploymentId: incident.deploymentId });
    return { incident, evidence: null, events };
  }

  const incident = {
    ...prior,
    status: 'resolved',
    markers: [],
    updatedAtMs: nowMs,
    resolvedAtMs: nowMs,
    healthyPollCount,
  };
  events.push({ type: 'resolved', incidentId: incident.id, deploymentId: incident.deploymentId });
  return { incident, evidence: buildFleetEvidencePacket(incident, pollResult, { nowMs }), events };
}

export function ackFleetIncident(incident, {
  nowMs = Date.now(),
  actor = 'operator',
} = {}) {
  const normalized = normalizePriorIncident(incident);
  if (!normalized || normalized.status === 'resolved') return normalized;
  return {
    ...normalized,
    status: 'ack',
    updatedAtMs: nowMs,
    ackedAtMs: nowMs,
    ackedBy: normalizeText(actor) || 'operator',
  };
}

function normalizeState(raw = {}) {
  return {
    version: 1,
    incidents: raw?.incidents && typeof raw.incidents === 'object' ? clone(raw.incidents) : {},
    evidence: raw?.evidence && typeof raw.evidence === 'object' ? clone(raw.evidence) : {},
  };
}

export function buildFleetIncidentStore({
  storeFile = DEFAULT_STORE_FILE,
  namespace = 'fleet_incidents',
  stateStore,
  env = process.env,
  modeEnvKey = 'APP_STATE_STORAGE',
  now = () => Date.now(),
  healthyPollsToResolve = DEFAULT_HEALTHY_POLLS_TO_RESOLVE,
} = {}) {
  const backingStore = stateStore || buildPostgresJsonStore({
    namespace,
    filePath: storeFile,
    legacyFilePath: storeFile === DEFAULT_STORE_FILE ? LEGACY_STORE_FILE : undefined,
    env,
    modeEnvKey,
  });
  let loaded = false;
  let loadingPromise = null;
  let saveQueue = Promise.resolve();
  let state = normalizeState(backingStore.loadSync?.() || {});

  async function load() {
    if (loaded) return;
    if (!loadingPromise) {
      loadingPromise = (async () => {
        const raw = await backingStore.load().catch(() => null);
        if (raw && typeof raw === 'object') state = normalizeState(raw);
        loaded = true;
      })().finally(() => {
        loadingPromise = null;
      });
    }
    await loadingPromise;
  }

  async function save() {
    const snapshot = clone(state);
    const write = saveQueue.catch(() => {}).then(() => backingStore.save(snapshot));
    saveQueue = write.catch(() => {});
    await write;
  }

  function findActiveIncident(deploymentId) {
    return Object.values(state.incidents)
      .find((incident) => incident.deploymentId === deploymentId && incident.status !== 'resolved') || null;
  }

  async function applyPollResult(pollResult = {}) {
    await load();
    const deploymentId = normalizeText(pollResult.deploymentId);
    const prior = findActiveIncident(deploymentId);
    const result = transitionFleetIncident(pollResult, prior, {
      nowMs: now(),
      healthyPollsToResolve,
    });
    if (result.incident) {
      state.incidents[result.incident.id] = clone(result.incident);
    }
    if (result.evidence) {
      state.evidence[result.incident.evidenceRef] = clone(result.evidence);
    }
    if (result.incident || result.evidence) await save();
    return {
      incident: result.incident ? clone(result.incident) : null,
      evidence: result.evidence ? clone(result.evidence) : null,
      events: clone(result.events),
    };
  }

  async function ackIncident(id, options = {}) {
    await load();
    const incident = state.incidents[normalizeText(id)];
    if (!incident) return null;
    const next = ackFleetIncident(incident, { nowMs: now(), actor: options.actor });
    state.incidents[next.id] = clone(next);
    await save();
    return clone(next);
  }

  async function annotateInvestigation(id, {
    sessionId = '',
    nowMs = now(),
  } = {}) {
    await load();
    const incident = state.incidents[normalizeText(id)];
    const normalizedSessionId = normalizeText(sessionId);
    if (!incident || !normalizedSessionId) return null;
    const investigationSessionIds = Array.isArray(incident.investigationSessionIds)
      ? incident.investigationSessionIds.map(normalizeText).filter(Boolean)
      : [];
    const nextIds = investigationSessionIds.includes(normalizedSessionId)
      ? investigationSessionIds
      : [...investigationSessionIds, normalizedSessionId];
    const next = {
      ...incident,
      lastInvestigationSessionId: normalizedSessionId,
      investigationSessionIds: nextIds,
      updatedAtMs: nowMs,
    };
    state.incidents[next.id] = clone(next);
    await save();
    return clone(next);
  }

  async function listIncidents({ status = '', deploymentId = '' } = {}) {
    await load();
    return Object.values(state.incidents)
      .filter((incident) => !status || incident.status === normalizeText(status))
      .filter((incident) => !deploymentId || incident.deploymentId === normalizeText(deploymentId))
      .sort((a, b) => Number(b.updatedAtMs || 0) - Number(a.updatedAtMs || 0))
      .map(clone);
  }

  async function getIncident(id) {
    await load();
    const incident = state.incidents[normalizeText(id)];
    return incident ? clone(incident) : null;
  }

  async function getEvidence(refOrIncidentId) {
    await load();
    const key = normalizeText(refOrIncidentId);
    const incident = state.incidents[key];
    const evidenceKey = incident?.evidenceRef || key;
    const evidence = state.evidence[evidenceKey];
    return evidence ? clone(evidence) : null;
  }

  async function close() {
    await saveQueue.catch(() => {});
    if (typeof backingStore.close === 'function') await backingStore.close();
  }

  return {
    applyPollResult,
    ackIncident,
    annotateInvestigation,
    listIncidents,
    getIncident,
    getEvidence,
    close,
  };
}

export const FLEET_INCIDENT_DEFAULTS = Object.freeze({
  healthyPollsToResolve: DEFAULT_HEALTHY_POLLS_TO_RESOLVE,
  namespace: 'fleet_incidents',
});
