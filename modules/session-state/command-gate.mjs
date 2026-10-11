import { randomBytes } from 'node:crypto';
import { sessionStateTracker } from './tracker.mjs';
import { sendTmuxText } from '../platform/tmux-input.mjs';

const BLOCKING_INTERACTIONS = new Set([
  'permission',
  'confirmation',
  'selection',
  'trust',
  'guardrail',
  'update',
  'unknown_blocking',
]);

const TERMINAL_LIFECYCLES = new Set(['ended', 'missing']);
const DELIVERY_STATES = new Set(['queued', 'sending', 'awaiting_response', 'completed', 'failed']);
// MCP reconnect verifies its own UI result; it must not wait for an agent turn.
const IMMEDIATE_OPERATIONS = new Set(['terminal_keys', 'terminal_text', 'mcp_reconnect']);
const COALESCIBLE_OPERATIONS = new Set(['message', 'terminal_text', 'startup']);
const DEFAULT_POLL_INTERVAL_MS = 50;
// A startup prompt is confirmed only when the agent actually starts working.
// Pane-diff progress is not enough: pasting a large prompt into a composer
// changes the pane without submitting anything, and providers without a
// hook/transcript signal (codex) cannot tell the two apart. Bound each attempt
// so there is budget left to re-send Enter inside the transaction deadline.
const STARTUP_SUBMIT_ATTEMPTS = 3;
const AGENT_BUS_SUBMIT_ATTEMPTS = 2;
const STARTUP_PROGRESS_BOUND_MS = 4_000;
const AGENT_BUS_PROGRESS_BOUND_MS = 2_000;
export const DEFAULT_RESPONSE_PROGRESS_MS = 30_000;
export const DELIVERY_OBSERVATION_TTL_MS = DEFAULT_RESPONSE_PROGRESS_MS;

function laneForOperation(operation = 'message') {
  return ['interaction', 'dialog_policy'].includes(operation) ? 'control' : 'payload';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function text(value) {
  return String(value || '').trim();
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function makeId() {
  return `cmd_${randomBytes(8).toString('hex')}`;
}

function paneFingerprint(snapshot = {}) {
  return text(snapshot?.interaction?.fingerprint);
}

function normalizedPaneText(value = '') {
  return String(value || '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u00a0/g, ' ');
}

function compactEchoText(value = '') {
  return normalizedPaneText(value)
    .trim()
    .replace(/^([>❯›]|You:)\s*/i, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function isPaneChrome(line = '') {
  const value = String(line || '').trim();
  return !value
    || /^[-─_=]{6,}$/.test(value)
    || /^([>❯›]|You:)\s*$/i.test(value)
    || /^⏵⏵\s+/i.test(value)
    || /^gpt-[^·]+·/i.test(value)
    || /\b% left\b/i.test(value)
    || /\bshift\+tab\b/i.test(value);
}

function paneDelta(before = '', after = '') {
  const baseline = normalizedPaneText(before);
  const current = normalizedPaneText(after);
  if (baseline === current) return '';
  const index = baseline ? current.lastIndexOf(baseline) : -1;
  if (index >= 0) return current.slice(index + baseline.length);

  let commonPrefix = 0;
  const limit = Math.min(baseline.length, current.length);
  while (commonPrefix < limit && baseline[commonPrefix] === current[commonPrefix]) commonPrefix += 1;
  return current.slice(commonPrefix);
}

function hasNonEchoPaneProgress(before = '', after = '', submittedText = '') {
  const delta = paneDelta(before, after);
  if (!delta) return false;
  const submitted = compactEchoText(submittedText);
  let echoed = '';
  for (const rawLine of delta.split('\n')) {
    const line = rawLine.trim();
    if (isPaneChrome(line)) continue;
    const candidate = compactEchoText(line);
    if (!candidate) continue;
    const combined = `${echoed}${candidate}`;
    if (submitted && submitted.startsWith(combined)) {
      echoed = combined;
      continue;
    }
    return true;
  }
  return false;
}

function isStableFreeText(snapshot = {}) {
  return snapshot.lifecycle === 'running'
    && snapshot.interaction?.kind === 'free_text'
    && paneFingerprint(snapshot);
}

function isDeterministicallyBusy(snapshot = {}) {
  const source = text(snapshot.executionSource);
  return (source === 'transcript' || source === 'hook')
    && (snapshot.execution === 'working' || snapshot.execution === 'thinking');
}

function startupFailOpen(transaction = {}, snapshot = {}) {
  return transaction.operation === 'startup'
    && snapshot?.lifecycle === 'running'
    && !BLOCKING_INTERACTIONS.has(snapshot?.interaction?.kind)
    && !TERMINAL_LIFECYCLES.has(snapshot?.lifecycle);
}

function canAttemptSend(snapshot, capability, transaction = {}) {
  if (!snapshot || TERMINAL_LIFECYCLES.has(snapshot.lifecycle)) return false;
  if (transaction.operation === 'mcp_reconnect') {
    return snapshot.execution === 'idle'
      && snapshot.interaction?.kind === 'free_text'
      && snapshot.capabilities?.canQueueMessage === true;
  }
  if (BLOCKING_INTERACTIONS.has(snapshot.interaction?.kind)) return false;
  const activeQueue = transaction.allowActiveQueue
    && transaction.operation === 'message'
    && snapshot.capabilities?.canQueueMessage === true;
  // Codex and Claude room messages steer or queue into the running turn, even when hook/transcript say working.
  if (activeQueue && transaction.source === 'agent_bus') return true;
  if (isDeterministicallyBusy(snapshot)) return false;
  if (activeQueue) return true;
  // lifecycle can stay 'running' after process evidence expires. Send only
  // while a fresh process observation still grants canQueueMessage.
  if (snapshot.lifecycle === 'running' && snapshot.capabilities?.canQueueMessage === true) return true;
  return snapshot.capabilities?.[capability] === true;
}

function capabilityFor(operation = 'message') {
  if (operation === 'clear') return 'clear';
  if (operation === 'interrupt') return 'canInterrupt';
  return 'canSendNow';
}

function normalizedDeadline(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function transactionInput(input = {}, idFactory = makeId) {
  const operation = text(input.operation || input.type) || 'message';
  return {
    id: text(input.id) || idFactory(),
    source: text(input.source) || 'api',
    operation,
    lane: laneForOperation(operation),
    text: typeof input.text === 'string' ? input.text : '',
    keys: Array.isArray(input.keys) ? input.keys.map(text).filter(Boolean) : [],
    enter: input.enter !== false,
    resolveOnAwaiting: input.resolveOnAwaiting === true,
    allowActiveQueue: input.allowActiveQueue === true,
    expectedRevision: Number.isInteger(input.expectedRevision) ? input.expectedRevision : null,
    expectedFingerprint: text(input.expectedFingerprint),
    expectedInteractionKind: text(input.expectedInteractionKind),
    deadlineAt: normalizedDeadline(input.deadlineAt || input.deadline),
    metadata: input.metadata && typeof input.metadata === 'object' ? clone(input.metadata) : {},
  };
}

function deadlineError(transaction) {
  const error = new Error(`Command gate deadline expired: ${transaction.id}`);
  error.code = 'command_deadline_expired';
  return error;
}

function endedError(sessionId, snapshot) {
  const error = new Error(`Session is not running: ${sessionId}`);
  error.code = snapshot?.lifecycle === 'missing' ? 'session_missing' : 'session_ended';
  return error;
}

/**
 * One serializer per session for every automated terminal operation.
 *
 * `refresh` updates provider observations and may return the resulting snapshot.
 * `execute` performs one already-authorized typed operation.
 * `audit` persists transition records.
 */
export function createSessionCommandGate({
  tracker,
  now = () => Date.now(),
  sleepFn = sleep,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  progressTimeoutMs = DEFAULT_RESPONSE_PROGRESS_MS,
  idFactory = makeId,
} = {}) {
  if (!tracker || typeof tracker.observe !== 'function' || typeof tracker.get !== 'function') {
    throw new TypeError('tracker with observe() and get() is required');
  }

  const sessions = new Map();

  function requireRegistration(sessionId) {
    const id = text(sessionId);
    const registration = sessions.get(id);
    if (!registration) throw new Error(`Command gate session is not registered: ${id || '<empty>'}`);
    return registration;
  }

  function register(sessionId, { refresh, execute, audit = async () => {} } = {}) {
    const id = text(sessionId);
    if (!id) throw new TypeError('sessionId is required');
    if (typeof refresh !== 'function') throw new TypeError('refresh must be a function');
    if (typeof execute !== 'function') throw new TypeError('execute must be a function');
    if (typeof audit !== 'function') throw new TypeError('audit must be a function');

    const existing = sessions.get(id);
    if (existing) {
      existing.closed = false;
      existing.refresh = refresh;
      existing.execute = execute;
      existing.audit = audit;
      return gate;
    }

    sessions.set(id, {
      sessionId: id,
      refresh,
      execute,
      audit,
      queue: [],
      draining: false,
      active: null,
      closed: false,
      canonicalDelivery: null,
      transitionTail: Promise.resolve(),
      handledDialogs: new Map(),
      lastContent: '',
    });
    return gate;
  }

  function unregister(sessionId) {
    const registration = sessions.get(text(sessionId));
    if (!registration) return false;
    registration.closed = true;
    const error = new Error(`Command gate session was unregistered: ${registration.sessionId}`);
    error.code = 'command_gate_unregistered';
    for (const queued of registration.queue.splice(0)) queued.rejectOnce(error);
    sessions.delete(registration.sessionId);
    return true;
  }

  async function refreshSnapshot(registration) {
    if (registration.closed) {
      const error = new Error(`Command gate session was unregistered: ${registration.sessionId}`);
      error.code = 'command_gate_unregistered';
      throw error;
    }
    const refreshed = await registration.refresh(registration.sessionId);
    if (typeof refreshed?.content === 'string') registration.lastContent = refreshed.content;
    if (refreshed?.snapshot) return refreshed.snapshot;
    if (refreshed?.canonicalState) return refreshed.canonicalState;
    if (refreshed?.sessionId && refreshed?.capabilities) return refreshed;
    return tracker.get(registration.sessionId);
  }

  function isTransientRefreshError(error) {
    return error?.transient === true
      || ['session_observation_unavailable', 'tmux_unavailable', 'capture_failed'].includes(error?.code);
  }

  async function refreshForTransaction(registration, transaction) {
    while (true) {
      if (expired(transaction)) {
        const snapshot = tracker.get(registration.sessionId);
        if (startupFailOpen(transaction, snapshot)) return snapshot;
        throw deadlineError(transaction);
      }
      try {
        return await refreshSnapshot(registration);
      } catch (error) {
        if (!isTransientRefreshError(error)) throw error;
        await shortCapabilityWait(registration.sessionId, capabilityFor(transaction.operation));
      }
    }
  }

  async function writeTransition(registration, transaction, state, extra = {}) {
    if (!DELIVERY_STATES.has(state)) throw new TypeError(`Unsupported delivery state: ${state}`);
    const at = Number(now());
    const record = {
      transactionId: transaction.id,
      sessionId: registration.sessionId,
      source: transaction.source,
      operation: transaction.operation,
      text: transaction.text,
      enter: transaction.enter,
      state,
      at,
      metadata: clone(transaction.metadata),
      ...extra,
    };
    await tracker.observe(registration.sessionId, {
      source: 'delivery',
      kind: 'command_gate',
      value: {
        state,
        transactionId: transaction.id,
        source: transaction.source,
        operation: transaction.operation,
        queuedCount: registration.queue.length,
        ...extra,
      },
      observedAt: at,
      expiresAt: at + DELIVERY_OBSERVATION_TTL_MS,
      fingerprint: `${transaction.id}:${state}:${at}`,
    });
    const priorCanonicalDelivery = registration.canonicalDelivery;
    if (
      state === 'queued'
      && priorCanonicalDelivery
      && priorCanonicalDelivery.transaction.id !== transaction.id
    ) {
      const active = priorCanonicalDelivery.transaction;
      await tracker.observe(registration.sessionId, {
        source: 'delivery',
        kind: 'command_gate',
        value: {
          state: priorCanonicalDelivery.state,
          transactionId: active.id,
          source: active.source,
          operation: active.operation,
          queuedCount: registration.queue.length,
          queuedTransactionId: transaction.id,
        },
        observedAt: at,
        expiresAt: at + DELIVERY_OBSERVATION_TTL_MS,
        fingerprint: `${active.id}:${priorCanonicalDelivery.state}:${at}:restore`,
      });
    }
    if (state === 'sending' || state === 'awaiting_response') {
      registration.canonicalDelivery = { transaction, state };
    } else if (
      (state === 'queued' || state === 'completed' || state === 'failed')
      && registration.canonicalDelivery?.transaction?.id === transaction.id
    ) {
      registration.canonicalDelivery = null;
    }
    await registration.audit(record);
    return record;
  }

  function recordTransition(registration, transaction, state, extra = {}) {
    const pending = registration.transitionTail.then(() => writeTransition(
      registration,
      transaction,
      state,
      extra,
    ));
    registration.transitionTail = pending.catch(() => {});
    return pending;
  }

  function expired(transaction) {
    return transaction.deadlineAt > 0 && Number(now()) >= transaction.deadlineAt;
  }

  async function shortCapabilityWait(sessionId, capability) {
    if (typeof tracker.waitForCapability !== 'function') {
      await sleepFn(pollIntervalMs);
      return;
    }
    try {
      await tracker.waitForCapability(sessionId, capability, { timeoutMs: pollIntervalMs });
    } catch {
      // Timeout means refresh provider evidence and check again. Unsafe state is held.
    }
  }

  function dialogPolicy(snapshot = {}) {
    const kind = snapshot.interaction?.kind;
    const fingerprint = paneFingerprint(snapshot);
    if (!fingerprint) return null;
    if (kind === 'guardrail') {
      return {
        kind,
        fingerprint,
        option: 2,
        keys: ['Down', 'Enter'],
        detail: 'Wait for verification',
      };
    }
    if (kind === 'trust') {
      return {
        kind,
        fingerprint,
        option: 1,
        keys: ['Enter'],
        detail: 'Trust directory',
      };
    }
    if (kind === 'update') {
      return {
        kind,
        fingerprint,
        keys: ['Enter'],
        detail: 'Install Codex update',
      };
    }
    return null;
  }

  async function waitForDialogClear(registration, policy, transaction) {
    while (true) {
      if (expired(transaction)) throw deadlineError(transaction);
      const snapshot = await refreshForTransaction(registration, transaction);
      if (TERMINAL_LIFECYCLES.has(snapshot?.lifecycle)) {
        if (policy.kind === 'update') return snapshot;
        throw endedError(registration.sessionId, snapshot);
      }
      if (paneFingerprint(snapshot) !== policy.fingerprint) return snapshot;
      await shortCapabilityWait(registration.sessionId, 'canSendNow');
    }
  }

  async function applyDialogPolicy(registration, snapshot, parentTransaction) {
    const policy = dialogPolicy(snapshot);
    if (!policy) {
      if (parentTransaction.operation === 'dialog_policy') {
        await recordTransition(registration, parentTransaction, 'completed', { skipped: true });
      }
      return { handled: false, skipped: true, snapshot };
    }

    const prior = registration.handledDialogs.get(policy.fingerprint);
    if (prior) {
      await waitForDialogClear(registration, policy, parentTransaction);
      return { handled: true, reused: true, policy };
    }

    const transaction = parentTransaction.operation === 'dialog_policy'
      ? {
          ...parentTransaction,
          operation: policy.kind,
          metadata: {
            ...parentTransaction.metadata,
            interactionFingerprint: policy.fingerprint,
            option: policy.option,
          },
        }
      : transactionInput({
          id: `dialog_${policy.fingerprint}`,
          source: 'dialog_policy',
          operation: policy.kind,
          deadlineAt: parentTransaction.deadlineAt,
          metadata: { interactionFingerprint: policy.fingerprint, option: policy.option },
        }, idFactory);
    registration.handledDialogs.set(policy.fingerprint, transaction.id);
    if (registration.handledDialogs.size > 256) {
      registration.handledDialogs.delete(registration.handledDialogs.keys().next().value);
    }

    try {
      if (parentTransaction.operation !== 'dialog_policy') {
        await recordTransition(registration, transaction, 'queued', { interactionFingerprint: policy.fingerprint });
      }
      const before = await refreshForTransaction(registration, transaction);
      if (before?.interaction?.kind !== policy.kind || paneFingerprint(before) !== policy.fingerprint) {
        await recordTransition(registration, transaction, 'completed', {
          interactionFingerprint: policy.fingerprint,
          skipped: true,
        });
        return { handled: true, skipped: true, policy };
      }

      await recordTransition(registration, transaction, 'sending', { interactionFingerprint: policy.fingerprint });
      const sendingSnapshot = tracker.get(registration.sessionId);
      const immediate = await refreshForTransaction(registration, transaction);
      if (
        immediate.revision !== sendingSnapshot.revision
        || immediate.interaction?.kind !== policy.kind
        || paneFingerprint(immediate) !== policy.fingerprint
      ) {
        registration.handledDialogs.delete(policy.fingerprint);
        await recordTransition(registration, transaction, 'completed', {
          interactionFingerprint: policy.fingerprint,
          deferred: 'interaction_changed',
          skipped: true,
        });
        return { handled: true, deferred: true, policy };
      }

      if (expired(transaction)) throw deadlineError(transaction);
      await registration.execute({
        transactionId: transaction.id,
        sessionId: registration.sessionId,
        type: 'dialog',
        operation: policy.kind,
        interactionKind: policy.kind,
        option: policy.option,
        keys: [...policy.keys],
        expectedRevision: immediate.revision,
        expectedFingerprint: policy.fingerprint,
        source: transaction.source,
        metadata: clone(transaction.metadata),
      });
      await recordTransition(registration, transaction, 'awaiting_response', {
        interactionFingerprint: policy.fingerprint,
      });
      await waitForDialogClear(registration, policy, transaction);
      await recordTransition(registration, transaction, 'completed', {
        interactionFingerprint: policy.fingerprint,
      });
      return { handled: true, policy };
    } catch (error) {
      registration.handledDialogs.delete(policy.fingerprint);
      await recordTransition(registration, transaction, 'failed', {
        interactionFingerprint: policy.fingerprint,
        error: error.message,
        code: error.code || '',
      });
      throw error;
    }
  }

  async function waitForSafeSnapshot(registration, transaction) {
    const capability = capabilityFor(transaction.operation);
    while (true) {
      let snapshot = await refreshForTransaction(registration, transaction);
      if (expired(transaction) && startupFailOpen(transaction, snapshot)) return snapshot;
      if (expired(transaction)) throw deadlineError(transaction);
      if (TERMINAL_LIFECYCLES.has(snapshot?.lifecycle)) throw endedError(registration.sessionId, snapshot);

      const policy = transaction.operation === 'mcp_reconnect' ? null : dialogPolicy(snapshot);
      if (policy) {
        await applyDialogPolicy(registration, snapshot, transaction);
        continue;
      }

      const interactionEntry = registration.queue.find((entry, index) => (
        index > 0
        && entry.ready
        && !entry.preempting
        && entry.transaction.lane === 'control'
        && entry.transaction.operation === 'interaction'
        && entry.transaction.expectedFingerprint === paneFingerprint(snapshot)
        && (
          !entry.transaction.expectedInteractionKind
          || entry.transaction.expectedInteractionKind === snapshot.interaction?.kind
        )
      ));
      if (interactionEntry) {
        interactionEntry.preempting = true;
        await processEntry(registration, interactionEntry);
        const index = registration.queue.indexOf(interactionEntry);
        if (index >= 0) registration.queue.splice(index, 1);
        continue;
      }

      // canSendNow is advisory. Injection is cheap; verify after acting.
      if (canAttemptSend(snapshot, capability, transaction)) return snapshot;
      await shortCapabilityWait(registration.sessionId, capability);
    }
  }

  function responseProgressed(snapshot, sentSnapshot, {
    baselineContent = '', currentContent = '', submittedText = '', operation = 'message',
    source = '',
  } = {}) {
    if (!snapshot) return false;
    if (TERMINAL_LIFECYCLES.has(snapshot.lifecycle)) return true;
    if (
      (snapshot.execution === 'working' || snapshot.execution === 'thinking')
      && sentSnapshot?.execution !== 'working'
      && sentSnapshot?.execution !== 'thinking'
    ) return true;
    if (BLOCKING_INTERACTIONS.has(snapshot.interaction?.kind)) return true;
    // Startup and agent-bus injects stop here. Pane deltas from a paste alone
    // used to report unsubmitted prompts as delivered.
    if (operation === 'startup' || source === 'agent_bus') return false;
    if (
      paneFingerprint(snapshot)
      && paneFingerprint(snapshot) !== paneFingerprint(sentSnapshot)
      && snapshot.interaction?.kind !== 'free_text'
    ) return true;
    if (
      operation === 'clear'
      && isStableFreeText(snapshot)
      && paneFingerprint(snapshot) !== paneFingerprint(sentSnapshot)
    ) return true;
    if (
      isStableFreeText(snapshot)
      && paneFingerprint(snapshot) !== paneFingerprint(sentSnapshot)
      && hasNonEchoPaneProgress(baselineContent, currentContent, submittedText)
    ) return true;
    return false;
  }

  function startupBoundMs() {
    const configured = Math.max(1, Number(progressTimeoutMs) || DEFAULT_RESPONSE_PROGRESS_MS);
    return Math.min(STARTUP_PROGRESS_BOUND_MS, configured);
  }

  function confirmBoundMs(transaction) {
    if (transaction?.operation === 'startup') return startupBoundMs();
    const configured = Math.max(1, Number(progressTimeoutMs) || DEFAULT_RESPONSE_PROGRESS_MS);
    return Math.min(AGENT_BUS_PROGRESS_BOUND_MS, configured);
  }

  function confirmAttempts(transaction) {
    return transaction?.operation === 'startup' ? STARTUP_SUBMIT_ATTEMPTS : AGENT_BUS_SUBMIT_ATTEMPTS;
  }

  async function waitForResponseProgress(registration, transaction, sentSnapshot, baselineContent, boundOverrideMs = 0) {
    const startedAt = Number(now());
    const boundMs = boundOverrideMs > 0
      ? boundOverrideMs
      : Math.max(1, Number(progressTimeoutMs) || DEFAULT_RESPONSE_PROGRESS_MS);
    const boundAt = transaction.deadlineAt > 0
      ? Math.min(transaction.deadlineAt, startedAt + boundMs)
      : startedAt + boundMs;
    const maxWaits = Math.max(1, Math.ceil(boundMs / Math.max(1, pollIntervalMs)));
    let waits = 0;

    async function currentSnapshot() {
      try {
        return await refreshSnapshot(registration);
      } catch (error) {
        if (!isTransientRefreshError(error)) throw error;
        return tracker.get(registration.sessionId);
      }
    }

    while (true) {
      // After execute() the send already happened. Missing echo/ack must not
      // fail closed or hold the per-session FIFO.
      if (Number(now()) >= boundAt || waits >= maxWaits) {
        return { snapshot: await currentSnapshot(), progressed: false };
      }
      let snapshot;
      try {
        snapshot = await refreshSnapshot(registration);
      } catch (error) {
        if (!isTransientRefreshError(error)) throw error;
        await shortCapabilityWait(registration.sessionId, 'canSendNow');
        waits += 1;
        continue;
      }
      if (responseProgressed(snapshot, sentSnapshot, {
        baselineContent,
        currentContent: registration.lastContent,
        submittedText: transaction.text,
        operation: transaction.operation,
        source: transaction.source,
      })) return { snapshot, progressed: true };
      await shortCapabilityWait(registration.sessionId, 'canSendNow');
      waits += 1;
    }
  }

  async function executeNormal(registration, transaction, onAwaiting = () => {}) {
    while (true) {
      const ready = await waitForSafeSnapshot(registration, transaction);
      const immediate = await refreshForTransaction(registration, transaction);
      const capability = capabilityFor(transaction.operation);
      const failOpenStartup = expired(transaction) && startupFailOpen(transaction, immediate);
      if (
        !failOpenStartup
        && (
          immediate.revision !== ready.revision
          || paneFingerprint(immediate) !== paneFingerprint(ready)
          || !canAttemptSend(immediate, capability, transaction)
        )
      ) {
        continue;
      }

      await recordTransition(registration, transaction, 'sending', {
        expectedRevision: immediate.revision,
        expectedFingerprint: paneFingerprint(immediate),
      });
      const sendingSnapshot = tracker.get(registration.sessionId);
      const finalSnapshot = await refreshForTransaction(registration, transaction);
      if (
        !failOpenStartup
        && (
          finalSnapshot.revision !== sendingSnapshot.revision
          || paneFingerprint(finalSnapshot) !== paneFingerprint(immediate)
          || !canAttemptSend(finalSnapshot, capability, transaction)
        )
      ) {
        await recordTransition(registration, transaction, 'queued', {
          deferred: 'snapshot_changed',
          expectedFingerprint: paneFingerprint(immediate),
          observedFingerprint: paneFingerprint(finalSnapshot),
        });
        continue;
      }

      const baselineContent = registration.lastContent;
      if (expired(transaction) && !startupFailOpen(transaction, finalSnapshot)) {
        throw deadlineError(transaction);
      }
      const executionResult = await registration.execute({
        transactionId: transaction.id,
        sessionId: registration.sessionId,
        type: transaction.keys.length ? 'dialog' : transaction.operation,
        operation: transaction.operation,
        text: transaction.text,
        keys: [...transaction.keys],
        enter: transaction.enter,
        expectedRevision: finalSnapshot.revision,
        expectedFingerprint: paneFingerprint(finalSnapshot),
        source: transaction.source,
        metadata: clone(transaction.metadata),
      });
      if (IMMEDIATE_OPERATIONS.has(transaction.operation)) {
        const completedSnapshot = await refreshForTransaction(registration, transaction);
        await recordTransition(registration, transaction, 'completed', {
          completedRevision: completedSnapshot.revision,
          completedFingerprint: paneFingerprint(completedSnapshot),
        });
        return {
          ok: true,
          transactionId: transaction.id,
          state: 'completed',
          snapshot: completedSnapshot,
          result: executionResult,
        };
      }
      const isStartup = transaction.operation === 'startup' && transaction.enter !== false;
      const needsSubmitConfirm = isStartup || (transaction.source === 'agent_bus' && transaction.enter !== false);
      await recordTransition(registration, transaction, 'awaiting_response', {
        expectedFingerprint: paneFingerprint(finalSnapshot),
        confirmation: needsSubmitConfirm ? 'pending' : 'submitted',
      });
      if (transaction.resolveOnAwaiting) {
        onAwaiting({
          ok: true,
          transactionId: transaction.id,
          state: 'awaiting_response',
          snapshot: tracker.get(registration.sessionId),
        });
      }
      let { snapshot: completedSnapshot, progressed } = await waitForResponseProgress(
        registration,
        transaction,
        finalSnapshot,
        baselineContent,
        needsSubmitConfirm ? confirmBoundMs(transaction) : 0,
      );
      // The prompt can land in the composer without being submitted: the TUI may
      // still be booting, or it may absorb the Enter into the paste burst. Re-send
      // Enter alone — never the text — so this cannot duplicate the prompt. Enter
      // on an already-submitted (empty) composer is a no-op.
      for (
        let attempt = 1;
        needsSubmitConfirm && !progressed && attempt < confirmAttempts(transaction) && !expired(transaction);
        attempt += 1
      ) {
        // Re-check immediately before every retry. A permission prompt or agent
        // activity can appear after the preceding bounded wait; an unguarded
        // Enter in that window could accept a dialog or queue unintended input.
        const retryReady = await refreshForTransaction(registration, transaction);
        if (responseProgressed(retryReady, finalSnapshot, {
          baselineContent,
          currentContent: registration.lastContent,
          submittedText: transaction.text,
          operation: transaction.operation,
          source: transaction.source,
        })) {
          completedSnapshot = retryReady;
          progressed = true;
          break;
        }
        if (
          retryReady.lifecycle !== 'running'
          || retryReady.execution === 'working'
          || retryReady.execution === 'thinking'
          || retryReady.interaction?.kind !== 'free_text'
          || !canAttemptSend(retryReady, 'canSendNow', transaction)
        ) break;
        const retryFingerprint = paneFingerprint(retryReady);
        const retrySnapshot = await refreshForTransaction(registration, transaction);
        if (
          retrySnapshot.revision !== retryReady.revision
          || paneFingerprint(retrySnapshot) !== retryFingerprint
          || retrySnapshot.interaction?.kind !== 'free_text'
          || !canAttemptSend(retrySnapshot, 'canSendNow', transaction)
        ) {
          completedSnapshot = retrySnapshot;
          continue;
        }
        await registration.execute({
          transactionId: transaction.id,
          sessionId: registration.sessionId,
          type: 'startup',
          operation: 'startup',
          text: '',
          keys: [],
          enter: true,
          expectedRevision: retrySnapshot.revision,
          expectedFingerprint: retryFingerprint,
          source: transaction.source,
          metadata: clone(transaction.metadata),
        });
        ({ snapshot: completedSnapshot, progressed } = await waitForResponseProgress(
          registration,
          transaction,
          completedSnapshot,
          baselineContent,
          confirmBoundMs(transaction),
        ));
      }
      await recordTransition(registration, transaction, 'completed', {
        completedRevision: completedSnapshot.revision,
        completedFingerprint: paneFingerprint(completedSnapshot),
        // Startup only: say whether submission was actually observed. Reporting an
        // unverified guess as delivered is what hid the codex injection failure.
        ...(needsSubmitConfirm ? { confirmation: progressed ? 'submitted' : 'unconfirmed' } : {}),
      });
      return {
        ok: true,
        transactionId: transaction.id,
        state: 'completed',
        snapshot: completedSnapshot,
        ...(needsSubmitConfirm ? { submissionConfirmed: progressed } : {}),
      };
    }
  }

  async function executeInteraction(registration, transaction) {
    if (!transaction.expectedFingerprint) {
      const error = new Error('Typed interaction requires an expected pane fingerprint');
      error.code = 'interaction_fingerprint_required';
      throw error;
    }

    const before = await refreshForTransaction(registration, transaction);
    if (TERMINAL_LIFECYCLES.has(before?.lifecycle)) throw endedError(registration.sessionId, before);
    if (['guardrail', 'trust', 'update'].includes(before?.interaction?.kind)) {
      const error = new Error(`${before.interaction.kind} interactions are controlled by the dialog policy`);
      error.code = 'policy_controlled_interaction';
      throw error;
    }
    if (
      paneFingerprint(before) !== transaction.expectedFingerprint
      || (transaction.expectedInteractionKind && before.interaction?.kind !== transaction.expectedInteractionKind)
      || before.capabilities?.canAnswerInteraction !== true
      || !BLOCKING_INTERACTIONS.has(before.interaction?.kind)
    ) {
      const error = new Error('Interaction changed before the typed answer could be sent');
      error.code = 'interaction_changed';
      throw error;
    }

    const immediate = await refreshForTransaction(registration, transaction);
    if (
      paneFingerprint(immediate) !== transaction.expectedFingerprint
      || (transaction.expectedInteractionKind && immediate.interaction?.kind !== transaction.expectedInteractionKind)
      || immediate.capabilities?.canAnswerInteraction !== true
    ) {
      const error = new Error('Interaction changed before the typed answer could be sent');
      error.code = 'interaction_changed';
      throw error;
    }

    await recordTransition(registration, transaction, 'sending', {
      expectedRevision: immediate.revision,
      expectedFingerprint: transaction.expectedFingerprint,
    });
    const finalSnapshot = await refreshForTransaction(registration, transaction);
    if (
      paneFingerprint(finalSnapshot) !== transaction.expectedFingerprint
      || (transaction.expectedInteractionKind && finalSnapshot.interaction?.kind !== transaction.expectedInteractionKind)
      || finalSnapshot.capabilities?.canAnswerInteraction !== true
    ) {
      const error = new Error('Interaction changed before the typed answer could be sent');
      error.code = 'interaction_changed';
      throw error;
    }

    if (expired(transaction)) throw deadlineError(transaction);
    await registration.execute({
      transactionId: transaction.id,
      sessionId: registration.sessionId,
      type: transaction.keys.length ? 'dialog' : 'dialog_answer',
      operation: 'interaction',
      text: transaction.text,
      keys: [...transaction.keys],
      enter: transaction.enter,
      expectedRevision: finalSnapshot.revision,
      expectedFingerprint: transaction.expectedFingerprint,
      source: transaction.source,
      metadata: clone(transaction.metadata),
    });
    // Unknown screens (Claude /config, provider menus) carry a constant
    // fingerprint and often stay open after Enter (toggles, sub-menus).
    // Waiting for them to clear held this serial queue for as long as the
    // menu stayed up, so every later Escape sat behind the first Enter.
    const submitsDialog = before.interaction?.kind !== 'unknown_blocking' && (
      transaction.text.length > 0
        ? transaction.enter
        : transaction.keys.includes('Enter')
    );
    if (!submitsDialog) {
      const completedSnapshot = await refreshForTransaction(registration, transaction);
      await recordTransition(registration, transaction, 'completed', {
        completedRevision: completedSnapshot.revision,
        completedFingerprint: paneFingerprint(completedSnapshot),
        navigation: true,
      });
      return { ok: true, transactionId: transaction.id, state: 'completed', snapshot: completedSnapshot };
    }
    await recordTransition(registration, transaction, 'awaiting_response', {
      expectedFingerprint: transaction.expectedFingerprint,
    });
    const completedSnapshot = await waitForDialogClear(registration, {
      fingerprint: transaction.expectedFingerprint,
      kind: transaction.expectedInteractionKind || before.interaction?.kind,
    }, transaction);
    await recordTransition(registration, transaction, 'completed', {
      completedRevision: completedSnapshot.revision,
      completedFingerprint: paneFingerprint(completedSnapshot),
    });
    return { ok: true, transactionId: transaction.id, state: 'completed', snapshot: completedSnapshot };
  }

  async function processEntry(registration, entry) {
    const { transaction } = entry;
    const priorActive = registration.active;
    registration.active = transaction;
    try {
      if (transaction.operation === 'dialog_policy') {
        const snapshot = await refreshForTransaction(registration, transaction);
        const result = await applyDialogPolicy(registration, snapshot, transaction);
        entry.resolveOnce({ ok: true, transactionId: transaction.id, ...result });
      } else if (transaction.operation === 'interaction') {
        entry.resolveOnce(await executeInteraction(registration, transaction));
      } else {
        entry.resolveOnce(await executeNormal(registration, transaction, entry.resolveOnce));
      }
    } catch (error) {
      if (transaction.operation !== 'dialog_policy') {
        await recordTransition(registration, transaction, 'failed', {
          error: error.message,
          code: error.code || '',
        }).catch(() => {});
      }
      entry.rejectOnce(error);
    } finally {
      registration.active = priorActive;
    }
  }

  async function drain(registration) {
    if (registration.draining) return;
    registration.draining = true;
    try {
      while (registration.queue.length > 0) {
        const entry = registration.queue[0];
        await processEntry(registration, entry);
        registration.queue.shift();
      }
    } finally {
      registration.draining = false;
      if (registration.queue.length > 0) void drain(registration);
    }
  }

  function submit(sessionId, input = {}) {
    const registration = requireRegistration(sessionId);
    const operation = text(input.operation || input.type) || 'message';
    const inputText = typeof input.text === 'string' ? input.text : '';
    const enter = input.enter !== false;
    if (COALESCIBLE_OPERATIONS.has(operation) && inputText) {
      const existing = registration.queue.find((entry) => (
        entry.transaction.operation === operation
        && entry.transaction.text === inputText
        && entry.transaction.enter === enter
      ));
      if (existing) {
        return {
          transactionId: existing.transaction.id,
          accepted: existing.accepted,
          completion: existing.promise,
        };
      }
    }
    const transaction = transactionInput(input, idFactory);
    if (expired(transaction)) throw deadlineError(transaction);
    let resolvePromise;
    let rejectPromise;
    let resolveAccepted;
    let rejectAccepted;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const accepted = new Promise((resolve, reject) => {
      resolveAccepted = resolve;
      rejectAccepted = reject;
    });
    let settled = false;
    const resolveOnce = (value) => {
      if (settled) return;
      settled = true;
      resolvePromise(value);
    };
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const entry = {
      transaction,
      promise,
      accepted,
      resolveOnce,
      rejectOnce,
      ready: false,
      preempting: false,
    };
    registration.queue.push(entry);
    void recordTransition(registration, transaction, 'queued')
      .then(() => {
        entry.ready = true;
        resolveAccepted({
          ok: true,
          accepted: true,
          transactionId: transaction.id,
          state: 'queued',
        });
        return drain(registration);
      })
      .catch((error) => {
        const index = registration.queue.findIndex((entry) => entry.transaction.id === transaction.id);
        if (index >= 0) registration.queue.splice(index, 1);
        rejectAccepted(error);
        rejectOnce(error);
      });
    return { transactionId: transaction.id, accepted, completion: promise };
  }

  function enqueue(sessionId, input = {}) {
    const ticket = submit(sessionId, input);
    void ticket.accepted.catch(() => {});
    return ticket.completion;
  }

  function ensureDialogPolicy(sessionId, options = {}) {
    return enqueue(sessionId, {
      ...options,
      operation: 'dialog_policy',
      source: text(options.source) || 'dialog_policy',
    });
  }

  function inspect(sessionId) {
    const registration = requireRegistration(sessionId);
    return {
      sessionId: registration.sessionId,
      active: registration.active ? clone(registration.active) : null,
      queued: registration.queue.map((entry) => clone(entry.transaction)),
      handledDialogFingerprints: [...registration.handledDialogs.keys()],
    };
  }

  const gate = Object.freeze({
    register,
    unregister,
    submit,
    enqueue,
    ensureDialogPolicy,
    inspect,
  });
  return gate;
}

export const buildSessionCommandGate = createSessionCommandGate;
export const sessionCommandGate = createSessionCommandGate({ tracker: sessionStateTracker });

export function createTmuxCommandExecutor({
  execFn,
  capturePane,
  target,
  delayMs = 300,
  startupDelayMs = delayMs,
  dialogKeyDelayMs = 75,
  sleepFn = sleep,
  bufferPrefix = 'dueno-command-gate',
} = {}) {
  if (typeof execFn !== 'function') throw new TypeError('execFn is required');
  const tmuxTarget = text(target);
  if (!tmuxTarget) throw new TypeError('target is required');

  return async function executeTmuxCommand(operation = {}) {
    if (operation.operation === 'mcp_reconnect') {
      const capture = async (raw = false) => {
        const result = await capturePane();
        if (result?.code !== 0) throw new Error(result?.stderr || 'Failed to inspect MCP screen');
        return raw ? result.stdout : normalizedPaneText(result.stdout);
      };
      const key = (value) => executeTmuxCommand({ type: 'dialog', keys: [value] });
      const composer = (pane) => {
        const rows = pane.split('\n');
        const separators = rows.map((row, index) => /^\s*─{10,}\s*$/.test(normalizedPaneText(row)) ? index : -1).filter((index) => index >= 0);
        if (separators.length < 2) return undefined;
        return rows.slice(separators.at(-2) + 1, separators.at(-1)).join('\n');
      };
      const menu = (pane, header) => {
        const index = pane.lastIndexOf(header);
        return index < 0 || composer(pane) !== undefined ? '' : pane.slice(index);
      };
      const screen = async (matches) => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const pane = await capture();
          if (matches(pane)) return pane;
          await sleepFn(100);
        }
        throw new Error('Unexpected MCP screen');
      };
      const pane = await capture(true);
      // Claude's empty composer placeholder is dim; actual draft text is not.
      const draft = normalizedPaneText((composer(pane) || '').replace(/\x1b\[2m[^\x1b]*\x1b\[(?:0|22)m/g, ''));
      // Do not submit a user's draft or interrupt an active turn.
      if (/esc to interrupt/i.test(pane) || !/^[❯>]\s*$/.test(draft)) throw new Error('Claude composer is not empty and idle');
      try {
        await sendTmuxText(execFn, { target: tmuxTarget, text: '/mcp', delayMs, sleepFn, bufferPrefix });
        let list = menu(await screen((pane) => menu(pane, 'Manage MCP servers')), 'Manage MCP servers');
        if (!/✘\s+dueno(?:\s|$)/i.test(list)) {
          return { ok: true, pending: /^\s*[❯>]?\s*[^✔✘\s]\s+dueno(?:\s|$)/im.test(list) };
        }
        // Move only from an identified selected server row, checking every step.
        for (let step = 0; step < 30; step += 1) {
          const rows = list.split('\n');
          const selected = rows.findIndex((row) => /^\s*[❯>]\s+/.test(row));
          const dueno = rows.findIndex((row) => /✘\s+dueno(?:\s|$)/i.test(row));
          if (selected < 0 || dueno < 0) throw new Error('Unrecognized MCP server selection');
          if (selected === dueno) break;
          if (step === 29) throw new Error('MCP server selection did not advance');
          await key(selected < dueno ? 'Down' : 'Up');
          await sleepFn(100);
          list = menu(await screen((pane) => menu(pane, 'Manage MCP servers')), 'Manage MCP servers');
        }
        await key('Enter');
        let detail = menu(await screen((pane) => menu(pane, 'Dueno MCP Server')), 'Dueno MCP Server');
        for (let step = 0; step < 10; step += 1) {
          const rows = detail.split('\n');
          const selected = rows.findIndex((row) => /^\s*[❯>]\s+\d+\./.test(row));
          const reconnect = rows.findIndex((row) => /^\s*[❯>]?\s*\d+\.\s+Reconnect\s*$/i.test(row));
          if (selected < 0 || reconnect < 0) throw new Error('Unrecognized MCP reconnect selection');
          if (selected === reconnect) break;
          if (step === 9) throw new Error('MCP reconnect selection did not advance');
          await key(selected < reconnect ? 'Down' : 'Up');
          await sleepFn(100);
          detail = menu(await screen((pane) => menu(pane, 'Dueno MCP Server')), 'Dueno MCP Server');
        }
        const before = await capture();
        const count = (content, phrase) => content.split(phrase).length;
        await key('Enter');
        await screen((content) => {
          if (count(content, 'Failed to reconnect to dueno') > count(before, 'Failed to reconnect to dueno')) {
            throw new Error('Failed to reconnect to dueno');
          }
          return count(content, 'Reconnected to dueno.') > count(before, 'Reconnected to dueno.');
        });
        return { ok: true };
      } finally {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (composer(await capture()) !== undefined) break;
          await key('Escape');
          await sleepFn(100);
        }
        if (composer(await capture()) === undefined) throw new Error('MCP menu did not close');
      }
    }
    if (operation.type === 'dialog') {
      const keys = Array.isArray(operation.keys) ? operation.keys.map(text).filter(Boolean) : [];
      if (!keys.length) throw new TypeError('dialog operation keys are required');
      for (let index = 0; index < keys.length; index += 1) {
        const result = await execFn('tmux', ['send-keys', '-t', tmuxTarget, '--', keys[index]]);
        if (result?.code !== 0) throw new Error(result?.stderr || 'Failed to send dialog keys');
        if (index < keys.length - 1 && dialogKeyDelayMs > 0) {
          await sleepFn(dialogKeyDelayMs);
        }
      }
      return { ok: true };
    }

    return sendTmuxText(execFn, {
      target: tmuxTarget,
      text: typeof operation.text === 'string' ? operation.text : '',
      enter: operation.enter !== false,
      delayMs: operation.operation === 'startup' ? startupDelayMs : delayMs,
      sleepFn,
      bufferPrefix,
    });
  };
}
