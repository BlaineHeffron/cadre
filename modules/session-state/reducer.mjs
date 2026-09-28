import {
  createInitialSnapshot,
  deepFreeze,
  normalizeObservation,
  validateSnapshot,
} from './contract.mjs';

const BLOCKING_INTERACTIONS = new Set([
  'permission',
  'confirmation',
  'selection',
  'trust',
  'guardrail',
  'update',
  'unknown_blocking',
]);
const ACTIVE_DELIVERY_STATES = new Set(['queued', 'sending', 'awaiting_response']);
const INTERRUPTIBLE_DELIVERY_STATES = new Set(['sending', 'awaiting_response']);
const ANSWERABLE_INTERACTIONS = new Set([
  'permission',
  'confirmation',
  'selection',
  'unknown_blocking',
]);

function observationsArray(observationSet) {
  if (!observationSet) return [];
  if (Array.isArray(observationSet)) return observationSet;
  if (observationSet instanceof Map) return [...observationSet.values()];
  if (typeof observationSet[Symbol.iterator] === 'function') return [...observationSet];
  return Object.values(observationSet);
}

// Pane observedAt is capture time, not content time. A barely-newer capture
// must not overturn a hook/transcript fact from the same observer tick.
export const EXECUTION_PANE_OVERRIDE_MS = 1_000;

function newest(observations, predicate) {
  return observations
    .filter(predicate)
    .sort((left, right) => right.observedAt - left.observedAt)[0] || null;
}

function factTime(observation) {
  const written = Number(observation?.value?.writtenAt);
  if (Number.isFinite(written) && written > 0) return written;
  return Number(observation?.observedAt) || 0;
}

function pickExecutionObservation(observations) {
  const protocol = newest(observations, (observation) => (
    observation.source === 'protocol' && normalizedExecution(observation)
  ));
  if (protocol) return protocol;
  const hook = newest(observations, (observation) => (
    observation.source === 'hook' && normalizedExecution(observation)
  ));
  const transcript = newest(observations, (observation) => (
    observation.source === 'transcript' && normalizedExecution(observation)
  ));
  const pane = newest(observations, (observation) => (
    observation.source === 'pane' && normalizedExecution(observation)
  ));

  // Hook vs transcript is ordered by fact time, not observation freshness.
  // Transcript terminal stamps observedAt at read time so it stays fresh across
  // the 15s observer; writtenAt is the file mtime (when the record was written).
  // Hook observedAt is the event time. Compare those, or a stale completed turn
  // always outranks a live UserPromptSubmit.
  let ranked = null;
  if (hook && transcript) {
    ranked = factTime(hook) >= factTime(transcript) ? hook : transcript;
  } else {
    ranked = hook || transcript;
  }
  if (!ranked) return pane;
  if (!pane) return ranked;

  // Pane observedAt is capture time. A later pane-only refresh may surface
  // working/thinking for UI, but a same-tick scrape must not overturn a
  // hook/transcript fact — control paths key off executionSource.
  const recency = Number(pane.observedAt) - Number(ranked.observedAt);
  if (recency >= EXECUTION_PANE_OVERRIDE_MS) return pane;
  return ranked;
}

function normalizedLifecycle(observation) {
  const value = observation?.value || {};
  if (['starting', 'running', 'ended', 'missing'].includes(value.lifecycle)) return value.lifecycle;
  if (value.exists === true) return 'running';
  if (value.exists === false) return 'missing';
  return null;
}

function normalizedExecution(observation) {
  const value = observation?.value || {};
  const candidate = value.execution || value.activity || value.state;
  if (['idle', 'working', 'thinking', 'unknown'].includes(candidate)) return candidate;
  if (['prompt_ready', 'ready', 'waiting_for_input', 'terminal'].includes(candidate)) return 'idle';
  if (['tool_running', 'executing', 'active'].includes(candidate)) return 'working';
  return null;
}

function normalizedInteraction(observation) {
  const value = observation?.value || {};
  const kind = value.kind || value.interaction;
  if (![
    'none', 'free_text', 'permission', 'confirmation', 'selection', 'trust', 'guardrail', 'update', 'unknown_blocking',
  ].includes(kind)) return null;
  return {
    kind,
    detail: String(value.detail || ''),
    options: Array.isArray(value.options) ? structuredClone(value.options) : [],
    fingerprint: observation.fingerprint,
    stable: value.stable === true,
  };
}

function runtimeFrom(observations, previousRuntime) {
  const runtime = { ...previousRuntime };
  const protocolRuntime = newest(observations, (item) => item.source === 'protocol' && item.kind === 'effective_runtime');
  for (const observation of [...observations].sort((a, b) => a.observedAt - b.observedAt)) {
    const value = observation.value || {};
    if (observation.source === 'runtime' || observation.kind === 'requested_runtime') {
      if (typeof value.requestedModel === 'string') runtime.requestedModel = value.requestedModel;
      if (typeof value.requestedThinkingLevel === 'string') runtime.requestedThinkingLevel = value.requestedThinkingLevel;
    }
    if ((observation.source === 'runtime' || observation.kind === 'effective_runtime')
      && (!protocolRuntime || observation === protocolRuntime)) {
      if (typeof value.effectiveModel === 'string') runtime.effectiveModel = value.effectiveModel;
      if (typeof value.effectiveThinkingLevel === 'string') runtime.effectiveThinkingLevel = value.effectiveThinkingLevel;
    }
  }
  return runtime;
}

// Providers report display casing (GPT-6-Sol for gpt-6-sol); compare identities,
// while the snapshot keeps the original strings for diagnostics.
function differs(requested, effective) {
  return Boolean(requested && effective && requested.trim().toLowerCase() !== effective.trim().toLowerCase());
}

function runtimeMismatch(runtime) {
  return differs(runtime.requestedModel, runtime.effectiveModel)
    || differs(runtime.requestedThinkingLevel, runtime.effectiveThinkingLevel);
}

function reasonFor({ lifecycle, execution, interaction, deliveryState, mismatch }) {
  if (lifecycle === 'missing') return 'Session process is missing';
  if (lifecycle === 'ended') return 'Session ended';
  if (BLOCKING_INTERACTIONS.has(interaction.kind)) {
    return interaction.detail || `Visible ${interaction.kind.replace('_', ' ')} interaction blocks automated input`;
  }
  if (deliveryState === 'sending') return 'Automated delivery is sending';
  if (deliveryState === 'queued') return 'Automated delivery is queued';
  if (deliveryState === 'awaiting_response') return 'Awaiting post-send progress';
  if (execution === 'thinking') return 'Provider reports thinking';
  if (execution === 'working') return 'Provider reports working';
  if (interaction.kind === 'free_text' && interaction.stable) {
    return mismatch ? 'Ready; effective runtime differs from requested runtime' : 'Stable free-text prompt visible';
  }
  if (interaction.kind === 'free_text') return 'Free-text prompt is not yet stable';
  if (lifecycle === 'starting') return 'Session is starting';
  return 'Insufficient fresh evidence';
}

function comparable(snapshot) {
  const { revision: _revision, updatedAt: _updatedAt, ...rest } = snapshot;
  return rest;
}

function equalSnapshotContent(left, right) {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

export function reduce(previousSnapshot, observationSet, now = Date.now()) {
  const timestamp = Number(now);
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new TypeError('now must be a non-negative finite number');
  const previous = previousSnapshot || createInitialSnapshot('unknown', timestamp);
  validateSnapshot(previous);

  const all = observationsArray(observationSet).map(normalizeObservation);
  const fresh = all.filter((observation) => observation.expiresAt === 0 || observation.expiresAt > timestamp);
  const expired = all.filter((observation) => observation.expiresAt > 0 && observation.expiresAt <= timestamp);
  const degradedReasons = [];

  const processLifecycleObservation = newest(fresh, (observation) => (
    observation.source === 'process' && normalizedLifecycle(observation)
  ));
  const protocolLifecycleObservation = newest(fresh, (observation) => (
    observation.source === 'protocol' && normalizedLifecycle(observation)
  ));
  const hookLifecycleObservation = newest(fresh, (observation) => (
    observation.source === 'hook' && normalizedLifecycle(observation)
  ));
  const paneEndedObservation = newest(fresh, (observation) => (
    observation.source === 'pane' && normalizedLifecycle(observation) === 'ended'
  ));
  const processTerminal = ['ended', 'missing'].includes(normalizedLifecycle(processLifecycleObservation));
  const lifecycleObservation = protocolLifecycleObservation || (processTerminal
    ? processLifecycleObservation
    : paneEndedObservation || processLifecycleObservation || hookLifecycleObservation);
  let lifecycle = normalizedLifecycle(lifecycleObservation) || previous.lifecycle;
  if (!lifecycleObservation && previous.revision === 0) lifecycle = 'starting';
  const processLifecycleExpired = Boolean(
    !processLifecycleObservation
    && expired.some((observation) => observation.source === 'process' && normalizedLifecycle(observation)),
  );
  if (processLifecycleExpired || (expired.some((observation) => normalizedLifecycle(observation)) && !lifecycleObservation)) {
    degradedReasons.push('Lifecycle evidence expired');
    if (!lifecycleObservation && previous.revision === 0) lifecycle = 'starting';
  }

  const executionObservation = pickExecutionObservation(fresh);
  const execution = normalizedExecution(executionObservation) || 'unknown';
  const executionSource = executionObservation?.source || '';
  if (!executionObservation && expired.some(normalizedExecution)) {
    degradedReasons.push('Execution evidence expired');
  }

  const paneInteractionObservation = newest(fresh, (observation) => (
    observation.source === 'pane' && normalizedInteraction(observation)
  ));
  const protocolInteractionObservation = newest(fresh, (observation) => (
    observation.source === 'protocol' && normalizedInteraction(observation)
  ));
  const hookInteractionObservation = newest(fresh, (observation) => (
    observation.source === 'hook' && normalizedInteraction(observation)
  ));
  const interactionObservation = protocolInteractionObservation || paneInteractionObservation || hookInteractionObservation;
  const interaction = normalizedInteraction(interactionObservation) || {
    kind: 'none', detail: '', options: [], fingerprint: '', stable: false,
  };
  if (!interactionObservation && expired.some((observation) => normalizedInteraction(observation))) {
    degradedReasons.push('Pane interaction evidence expired');
  }

  const deliveryObservation = newest(fresh, (observation) => observation.source === 'delivery');
  const deliveryState = String(deliveryObservation?.value?.state || '');
  const runtime = runtimeFrom(fresh, previous.runtime);
  const mismatch = runtimeMismatch(runtime);
  if (mismatch) degradedReasons.push('Effective runtime differs from requested runtime');

  // Hook lifecycle is not a liveness check. Capability grants require a fresh
  // process observation so a 90s-old Stop/prompt_ready hook cannot keep a
  // dead Claude/Codex session sendable after PROCESS_LIFECYCLE_FRESH_MS.
  const running = lifecycle === 'running' && Boolean(protocolLifecycleObservation || processLifecycleObservation);
  const blocked = BLOCKING_INTERACTIONS.has(interaction.kind);
  const deliveryPending = ACTIVE_DELIVERY_STATES.has(deliveryState);
  const deliveryBlocksSend = INTERRUPTIBLE_DELIVERY_STATES.has(deliveryState);
  const promptReady = interaction.kind === 'free_text' && interaction.stable;
  const executionIdle = execution === 'idle';
  const sendMessage = running && promptReady && executionIdle && !blocked && !deliveryBlocksSend;
  const canQueueMessage = running;
  const canAnswerInteraction = running
    && ANSWERABLE_INTERACTIONS.has(interaction.kind)
    && Boolean(interaction.fingerprint);
  const canInterrupt = running && (
    INTERRUPTIBLE_DELIVERY_STATES.has(deliveryState)
    || execution === 'working'
    || execution === 'thinking'
  );

  let status = 'unknown';
  if (lifecycle === 'ended' || lifecycle === 'missing') status = 'ended';
  else if (blocked) status = 'blocked';
  else if (deliveryPending) status = 'awaiting_response';
  else if (execution === 'thinking') status = 'thinking';
  else if (execution === 'working') status = 'working';
  else if (sendMessage) status = 'ready';
  else if (lifecycle === 'starting') status = 'starting';

  const nextBase = {
    sessionId: previous.sessionId,
    revision: previous.revision,
    updatedAt: previous.updatedAt,
    lifecycle,
    execution,
    executionSource,
    interaction: {
      kind: interaction.kind,
      detail: interaction.detail,
      options: interaction.options,
      fingerprint: interaction.fingerprint,
    },
    runtime,
    capabilities: {
      canQueueMessage,
      canSendNow: sendMessage,
      canAnswerInteraction,
      canInterrupt,
      // Compatibility aliases. New consumers must use the action-specific names.
      sendMessage,
      // Protocol sessions declare whether their provider has a clear operation.
      clear: sendMessage && lifecycleObservation?.value?.clear !== false,
      interrupt: canInterrupt,
      // Process death only. Idle auto-close is decided by the consumer from a
      // transcript terminal record (executionSource === 'transcript'), never
      // from sendMessage / scraped ready.
      autoClose: lifecycle === 'ended' || lifecycle === 'missing',
      // Ready is the normal idle rest state. Unknown is "no confident read"
      // (not yet stable, or evidence expired), not a human action. Blocked
      // interactions and runtime mismatch still need the user.
      needsAttention: blocked || mismatch,
    },
    status,
    reason: reasonFor({ lifecycle, execution, interaction, deliveryState, mismatch }),
    degradedReasons,
  };

  const changed = !equalSnapshotContent(previous, nextBase);
  const next = {
    ...nextBase,
    revision: changed ? previous.revision + 1 : previous.revision,
    updatedAt: changed ? timestamp : previous.updatedAt,
  };
  validateSnapshot(next);
  return deepFreeze(next);
}

export { BLOCKING_INTERACTIONS };
