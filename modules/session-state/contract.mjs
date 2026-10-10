export const LIFECYCLES = Object.freeze(['starting', 'running', 'ended', 'missing']);
export const EXECUTIONS = Object.freeze(['idle', 'working', 'thinking', 'unknown']);
export const INTERACTIONS = Object.freeze([
  'none',
  'free_text',
  'permission',
  'confirmation',
  'selection',
  'trust',
  'guardrail',
  'update',
  'unknown_blocking',
]);
export const STATUSES = Object.freeze([
  'starting',
  'working',
  'thinking',
  'ready',
  'blocked',
  'awaiting_response',
  'ended',
  'unknown',
]);
export const OBSERVATION_SOURCES = Object.freeze([
  'process',
  'hook',
  'pane',
  'transcript',
  'delivery',
  'runtime',
  'protocol',
]);
export const ACTION_CAPABILITIES = Object.freeze([
  'canQueueMessage',
  'canSendNow',
  'canAnswerInteraction',
  'canInterrupt',
]);
export const CAPABILITIES = Object.freeze([
  ...ACTION_CAPABILITIES,
  'sendMessage',
  'clear',
  'interrupt',
  'autoClose',
  'needsAttention',
]);

const LEGACY_BLOCKING_STATE = Object.freeze({
  permission: ['needs_approval', 'approval'],
  confirmation: ['needs_confirmation', 'yes-no'],
  selection: ['parked', 'selection'],
  trust: ['needs_approval', 'trust'],
  guardrail: ['needs_approval', 'guardrail'],
  update: ['needs_approval', 'update'],
  unknown_blocking: ['unknown', 'attention'],
});

function assertEnum(name, value, allowed) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${name} must be one of: ${allowed.join(', ')}`);
  }
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function canonicalSessionStateId(kind, sessionId) {
  return `${String(kind || '').trim().toLowerCase()}:${String(sessionId || '').trim()}`;
}

export function createInitialSnapshot(sessionId, now = 0) {
  if (!String(sessionId || '').trim()) throw new TypeError('sessionId is required');
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : 0;
  return deepFreeze({
    sessionId: String(sessionId),
    revision: 0,
    updatedAt: timestamp,
    lifecycle: 'starting',
    execution: 'unknown',
    executionSource: '',
    completedTurnAt: 0,
    interaction: {
      kind: 'none',
      detail: '',
      options: [],
      fingerprint: '',
    },
    runtime: {
      requestedModel: '',
      requestedThinkingLevel: '',
      effectiveModel: '',
      effectiveThinkingLevel: '',
    },
    capabilities: {
      canQueueMessage: false,
      canSendNow: false,
      canAnswerInteraction: false,
      canInterrupt: false,
      sendMessage: false,
      clear: false,
      interrupt: false,
      autoClose: false,
      needsAttention: false,
    },
    status: 'starting',
    reason: 'Session is starting',
    degradedReasons: [],
  });
}

export function validateObservation(observation) {
  if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
    throw new TypeError('observation must be an object');
  }
  assertEnum('observation.source', observation.source, OBSERVATION_SOURCES);
  if (!String(observation.kind || '').trim()) throw new TypeError('observation.kind is required');
  if (!observation.value || typeof observation.value !== 'object' || Array.isArray(observation.value)) {
    throw new TypeError('observation.value must be an object');
  }
  const observedAt = Number(observation.observedAt);
  const expiresAt = Number(observation.expiresAt);
  if (!Number.isFinite(observedAt) || observedAt < 0) {
    throw new TypeError('observation.observedAt must be a non-negative finite number');
  }
  if (!Number.isFinite(expiresAt) || expiresAt < 0) {
    throw new TypeError('observation.expiresAt must be a non-negative finite number');
  }
  if (expiresAt > 0 && expiresAt < observedAt) {
    throw new TypeError('observation.expiresAt must not precede observedAt');
  }
  if (observation.source === 'protocol' && expiresAt !== 0) {
    throw new TypeError('protocol observations are authoritative and must not expire');
  }
  if (typeof observation.fingerprint !== 'string') {
    throw new TypeError('observation.fingerprint must be a string');
  }
  return true;
}

export function normalizeObservation(observation) {
  const normalized = {
    source: String(observation?.source || ''),
    kind: String(observation?.kind || ''),
    value: clone(observation?.value || {}),
    observedAt: Number(observation?.observedAt),
    expiresAt: Number(observation?.expiresAt),
    fingerprint: String(observation?.fingerprint ?? ''),
  };
  validateObservation(normalized);
  return deepFreeze(normalized);
}

export function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('snapshot must be an object');
  if (!String(snapshot.sessionId || '').trim()) throw new TypeError('snapshot.sessionId is required');
  assertEnum('snapshot.lifecycle', snapshot.lifecycle, LIFECYCLES);
  assertEnum('snapshot.execution', snapshot.execution, EXECUTIONS);
  if (typeof snapshot.executionSource !== 'string') {
    throw new TypeError('snapshot.executionSource must be a string');
  }
  if (snapshot.executionSource && !OBSERVATION_SOURCES.includes(snapshot.executionSource)) {
    throw new TypeError(`snapshot.executionSource must be one of: ${OBSERVATION_SOURCES.join(', ')}`);
  }
  assertEnum('snapshot.interaction.kind', snapshot.interaction?.kind, INTERACTIONS);
  assertEnum('snapshot.status', snapshot.status, STATUSES);
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new TypeError('snapshot.revision must be a non-negative integer');
  }
  for (const capability of CAPABILITIES) {
    if (typeof snapshot.capabilities?.[capability] !== 'boolean') {
      throw new TypeError(`snapshot.capabilities.${capability} must be boolean`);
    }
  }
  return true;
}

export function projectCompatibility(snapshot) {
  validateSnapshot(snapshot);
  const interaction = snapshot.interaction || {};
  let state = snapshot.status;
  let needsInput = false;
  let inputType = null;

  if (snapshot.status === 'ready') {
    state = 'waiting_for_input';
    needsInput = true;
    inputType = 'text';
  } else if (snapshot.status === 'blocked') {
    [state, inputType] = LEGACY_BLOCKING_STATE[interaction.kind] || ['unknown', 'attention'];
    needsInput = true;
  } else if (snapshot.status === 'awaiting_response') {
    state = 'working';
  } else if (snapshot.status === 'ended') {
    state = snapshot.lifecycle === 'missing' ? 'ended' : 'exited';
  } else if (snapshot.status === 'starting') {
    state = 'active';
  }

  return deepFreeze({
    state,
    needsInput,
    inputType,
    detail: interaction.detail || snapshot.reason || null,
    safe_to_message: snapshot.capabilities.canSendNow === true,
    sessionId: snapshot.sessionId,
    updatedAt: snapshot.updatedAt,
    lifecycle: snapshot.lifecycle,
    execution: snapshot.execution,
    executionSource: snapshot.executionSource || '',
    completedTurnAt: snapshot.completedTurnAt || 0,
    interaction: clone(snapshot.interaction),
    runtime: clone(snapshot.runtime),
    status: snapshot.status,
    capabilities: clone(snapshot.capabilities),
    reason: snapshot.reason,
    revision: snapshot.revision,
    degradedReasons: clone(snapshot.degradedReasons),
  });
}
