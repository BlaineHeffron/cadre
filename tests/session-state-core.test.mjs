import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createInitialSnapshot,
  normalizeObservation,
  projectCompatibility,
  validateObservation,
  validateSnapshot,
} from '../modules/session-state/contract.mjs';
import { reduce } from '../modules/session-state/reducer.mjs';
import {
  createSessionStateTracker,
  PANE_FRESH_MS,
  PANE_OBSERVER_CADENCE_MS,
  PANE_STABILITY_MATCH_MS,
  PROCESS_LIFECYCLE_FRESH_MS,
} from '../modules/session-state/tracker.mjs';
import { detectClaudeTrust, observeClaudePane } from '../modules/session-state/providers/claude.mjs';
import {
  detectCodexGuardrail,
  detectCodexTrust,
  detectCodexUpdate,
  observeCodexPane,
  parseCodexRuntimeFooter,
} from '../modules/session-state/providers/codex.mjs';
import { observePiPane, parsePiRuntimeFooter } from '../modules/session-state/providers/pi.mjs';
import { detectProviderState } from '../modules/session-state/providers/patterns.mjs';
import { normalizeProviderPane } from '../modules/session-state/providers/pane-view.mjs';
import { deriveHookState } from '../modules/session-state/providers/hook.mjs';
import {
  observeTranscriptContent,
  observeTranscriptFile,
  transcriptExecutionFromActivity,
  TRANSCRIPT_OBSERVER_CADENCE_MS,
  TRANSCRIPT_TERMINAL_FRESHNESS_MS,
  TRANSCRIPT_WORKING_FRESHNESS_MS,
} from '../modules/session-state/providers/transcript.mjs';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'session-state');

async function fixture(name) {
  return readFile(join(fixtureDir, name), 'utf8');
}

function observation(source, kind, value, {
  observedAt = 100,
  expiresAt = 0,
  fingerprint = `${source}:${kind}`,
} = {}) {
  return { source, kind, value, observedAt, expiresAt, fingerprint };
}

function running() {
  return observation('process', 'lifecycle', { lifecycle: 'running' });
}

function freeText(options = {}) {
  return observation('pane', 'interaction', {
    kind: 'free_text', detail: 'Ready', options: [], stable: true,
  }, { fingerprint: 'prompt-a', ...options });
}

function idlePane(options = {}) {
  return observation('pane', 'execution', { execution: 'idle' }, options);
}

describe('session state contract', () => {
  it('creates and validates an immutable canonical snapshot', () => {
    const snapshot = createInitialSnapshot('session-1', 10);
    assert.equal(validateSnapshot(snapshot), true);
    assert.equal(snapshot.status, 'starting');
    assert.equal(snapshot.capabilities.sendMessage, false);
    assert.equal(snapshot.capabilities.canQueueMessage, false);
    assert.equal(snapshot.capabilities.canSendNow, false);
    assert.equal(snapshot.capabilities.canAnswerInteraction, false);
    assert.equal(snapshot.capabilities.canInterrupt, false);
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.interaction), true);
    assert.throws(() => { snapshot.status = 'ready'; }, TypeError);
  });

  it('normalizes observations without retaining mutable caller values', () => {
    const value = { kind: 'permission', options: ['Allow'] };
    const normalized = normalizeObservation(observation('pane', 'interaction', value));
    value.options.push('Deny');
    assert.deepEqual(normalized.value.options, ['Allow']);
    assert.equal(validateObservation(normalized), true);
    assert.equal(Object.isFrozen(normalized.value.options), true);
  });

  it('rejects malformed, stale, and expiring authoritative observations', () => {
    const valid = observation('pane', 'execution', { execution: 'idle' });
    const cases = [
      [null, /observation must be an object/],
      [[], /observation must be an object/],
      [{ ...valid, source: 'unknown' }, /observation.source must be one of/],
      [{ ...valid, kind: ' ' }, /observation.kind is required/],
      [{ ...valid, value: null }, /observation.value must be an object/],
      [{ ...valid, value: [] }, /observation.value must be an object/],
      [{ ...valid, observedAt: -1 }, /observedAt must be a non-negative finite number/],
      [{ ...valid, observedAt: Number.NaN }, /observedAt must be a non-negative finite number/],
      [{ ...valid, expiresAt: -1 }, /expiresAt must be a non-negative finite number/],
      [{ ...valid, expiresAt: Number.POSITIVE_INFINITY }, /expiresAt must be a non-negative finite number/],
      [{ ...valid, observedAt: 100, expiresAt: 99 }, /expiresAt must not precede observedAt/],
      [observation('protocol', 'execution', { execution: 'idle' }, { expiresAt: 101 }), /must not expire/],
      [{ ...valid, fingerprint: 42 }, /fingerprint must be a string/],
    ];

    for (const [candidate, expected] of cases) {
      assert.throws(() => validateObservation(candidate), expected);
    }
    assert.equal(validateObservation(valid), true);
  });

  it('is the sole compatibility projection for canonical ready state', () => {
    const snapshot = reduce(createInitialSnapshot('session-1'), [running(), freeText(), idlePane()], 100);
    const projected = projectCompatibility(snapshot);
    assert.deepEqual({
      state: projected.state,
      needsInput: projected.needsInput,
      inputType: projected.inputType,
      safe: projected.safe_to_message,
      revision: projected.revision,
    }, {
      state: 'waiting_for_input',
      needsInput: true,
      inputType: 'text',
      safe: true,
      revision: snapshot.revision,
    });
    assert.equal(Object.isFrozen(projected.capabilities), true);
  });
});

describe('pure session state reducer', () => {
  it('derives distinct queue, immediate-send, answer, and interrupt actions', () => {
    const cases = [
      {
        name: 'ready',
        observations: [running(), freeText(), idlePane()],
        expected: [true, true, false, false],
      },
      {
        name: 'working',
        observations: [running(), observation('pane', 'execution', { execution: 'working' })],
        expected: [true, false, false, true],
      },
      {
        name: 'queued at ready prompt',
        observations: [
          running(),
          freeText(),
          idlePane(),
          observation('delivery', 'command_gate', { state: 'queued', transactionId: 'queued-1' }),
        ],
        expected: [true, true, false, false],
      },
      {
        name: 'permission',
        observations: [
          running(),
          observation('pane', 'interaction', { kind: 'permission', detail: 'Approve?', options: [] }),
        ],
        expected: [true, false, true, false],
      },
      {
        name: 'policy-owned trust',
        observations: [
          running(),
          observation('pane', 'interaction', { kind: 'trust', detail: 'Trust?', options: [] }),
        ],
        expected: [true, false, false, false],
      },
      {
        name: 'ended',
        observations: [observation('process', 'lifecycle', { lifecycle: 'ended' })],
        expected: [false, false, false, false],
      },
    ];

    for (const { name, observations, expected } of cases) {
      const snapshot = reduce(createInitialSnapshot(`actions-${name}`), observations, 100);
      assert.deepEqual([
        snapshot.capabilities.canQueueMessage,
        snapshot.capabilities.canSendNow,
        snapshot.capabilities.canAnswerInteraction,
        snapshot.capabilities.canInterrupt,
      ], expected, name);
      assert.equal(snapshot.capabilities.sendMessage, snapshot.capabilities.canSendNow, name);
      assert.equal(snapshot.capabilities.interrupt, snapshot.capabilities.canInterrupt, name);
      assert.equal(snapshot.capabilities.autoClose, name === 'ended', `${name} autoClose`);
    }
  });

  it('always lets a fresh blocker disable sendMessage despite prompt-ready hook evidence', () => {
    const blockers = ['permission', 'confirmation', 'selection', 'trust', 'guardrail', 'update', 'unknown_blocking'];
    for (const kind of blockers) {
      const snapshot = reduce(createInitialSnapshot(`blocker-${kind}`), [
        running(),
        observation('hook', 'execution', { activity: 'prompt_ready' }),
        observation('pane', 'interaction', { kind, detail: `${kind} visible`, options: [], stable: true }),
      ], 100);
      assert.equal(snapshot.status, 'blocked', kind);
      assert.equal(snapshot.capabilities.sendMessage, false, kind);
      assert.equal(snapshot.capabilities.canQueueMessage, true, kind);
      assert.equal(snapshot.capabilities.canSendNow, false, kind);
      assert.equal(snapshot.capabilities.canAnswerInteraction, !['trust', 'guardrail', 'update'].includes(kind), kind);
      assert.equal(snapshot.capabilities.needsAttention, true, kind);
    }
  });

  it('fails closed as pane readiness expires', () => {
    const observations = [
      running(),
      freeText({ observedAt: 100, expiresAt: 150 }),
      idlePane({ observedAt: 100, expiresAt: 150 }),
    ];
    const ready = reduce(createInitialSnapshot('expiry'), observations, 120);
    const expired = reduce(ready, observations, 150);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.capabilities.sendMessage, true);
    assert.equal(ready.capabilities.canQueueMessage, true);
    assert.equal(ready.capabilities.canSendNow, true);
    assert.equal(expired.status, 'unknown');
    assert.equal(expired.capabilities.sendMessage, false);
    assert.match(expired.degradedReasons.join('\n'), /interaction evidence expired/i);
  });

  it('fails open when an awaiting_response delivery observation expires', () => {
    const observations = [
      running(),
      freeText(),
      idlePane(),
      observation('delivery', 'command_gate', { state: 'awaiting_response', transactionId: 't1' }, {
        observedAt: 100,
        expiresAt: 150,
      }),
    ];
    const pending = reduce(createInitialSnapshot('delivery-ttl'), observations, 120);
    const expired = reduce(pending, observations, 150);
    assert.equal(pending.status, 'awaiting_response');
    assert.equal(pending.capabilities.canSendNow, false);
    assert.equal(expired.status, 'ready');
    assert.equal(expired.capabilities.canSendNow, true);
    assert.notEqual(expired.status, 'awaiting_response');
  });

  it('preserves requested and effective runtime separately and exposes mismatch attention', () => {
    const snapshot = reduce(createInitialSnapshot('runtime'), [
      running(),
      freeText(),
      idlePane(),
      observation('runtime', 'requested_runtime', {
        requestedModel: 'gpt-5.5', requestedThinkingLevel: 'high',
      }),
      observation('pane', 'effective_runtime', {
        effectiveModel: 'gpt-5.4', effectiveThinkingLevel: 'medium',
      }),
    ], 100);
    assert.deepEqual(snapshot.runtime, {
      requestedModel: 'gpt-5.5',
      requestedThinkingLevel: 'high',
      effectiveModel: 'gpt-5.4',
      effectiveThinkingLevel: 'medium',
    });
    assert.equal(snapshot.status, 'ready');
    assert.equal(snapshot.capabilities.needsAttention, true);
    assert.match(snapshot.degradedReasons.join('\n'), /differs from requested/i);
  });

  it('treats a case-only model/thinking difference as the same runtime but a reroute as a mismatch', () => {
    const ready = (requestedModel, effectiveModel) => reduce(createInitialSnapshot('model-case'), [
      running(), freeText(), idlePane(),
      observation('runtime', 'requested_runtime', { requestedModel, requestedThinkingLevel: 'high' }),
      observation('pane', 'effective_runtime', { effectiveModel, effectiveThinkingLevel: 'High' }),
    ], 100);
    const sameModel = ready('gpt-6.1-sol', 'GPT-6.1-Sol');
    assert.deepEqual([sameModel.capabilities.needsAttention, sameModel.degradedReasons, sameModel.reason],
      [false, [], 'Stable free-text prompt visible']);
    assert.equal(sameModel.runtime.effectiveModel, 'GPT-6.1-Sol');
    const rerouted = ready('gpt-6.1-sol', 'GPT-6-Astra');
    assert.deepEqual([rerouted.capabilities.needsAttention, rerouted.reason],
      [true, 'Ready; effective runtime differs from requested runtime']);
  });

  it('keeps clear unavailable when protocol lifecycle evidence says the provider has no clear operation', () => {
    const snapshot = (lifecycle) => reduce(createInitialSnapshot('clear'), [
      observation('protocol', 'lifecycle', lifecycle),
      observation('protocol', 'execution', { execution: 'idle' }),
      freeText(),
    ], 100).capabilities;
    assert.deepEqual([snapshot({ lifecycle: 'running' }).sendMessage, snapshot({ lifecycle: 'running' }).clear], [true, true]);
    assert.deepEqual([snapshot({ lifecycle: 'running', clear: false }).sendMessage, snapshot({ lifecycle: 'running', clear: false }).clear], [true, false]);
  });

  it('preserves protocol model evidence over newer pane model text', () => {
    const snapshot = reduce(createInitialSnapshot('protocol-runtime'), [
      running(), freeText(), idlePane(),
      observation('runtime', 'requested_runtime', { requestedModel: 'gpt-6-astra' }),
      observation('protocol', 'effective_runtime', { effectiveModel: 'gpt-6-astra', effectiveThinkingLevel: 'high' }, { observedAt: 90 }),
      observation('pane', 'effective_runtime', { effectiveModel: 'stale-pane-model' }, { observedAt: 99 }),
    ], 100);
    assert.equal(snapshot.runtime.effectiveModel, 'gpt-6-astra');
    assert.equal(snapshot.runtime.effectiveThinkingLevel, 'high');
    assert.equal(snapshot.runtime.requestedModel, 'gpt-6-astra');
  });

  it('prefers transcript idle over pane working', () => {
    const snapshot = reduce(createInitialSnapshot('transcript-idle'), [
      running(),
      observation('pane', 'execution', { execution: 'working' }, { observedAt: 110 }),
      observation('transcript', 'execution', {
        execution: 'idle',
        activity: 'terminal',
      }, { observedAt: 100 }),
    ], 120);
    assert.equal(snapshot.execution, 'idle');
    assert.equal(snapshot.executionSource, 'transcript');
    assert.equal(snapshot.status, 'unknown');
    assert.equal(snapshot.capabilities.sendMessage, false);
  });

  it('does not mark ready from transcript idle without a stable pane prompt', () => {
    const snapshot = reduce(createInitialSnapshot('no-prompt'), [
      running(),
      observation('transcript', 'execution', { execution: 'idle', activity: 'terminal' }),
    ], 100);
    assert.equal(snapshot.execution, 'idle');
    assert.equal(snapshot.executionSource, 'transcript');
    assert.notEqual(snapshot.status, 'ready');
    assert.equal(snapshot.capabilities.canSendNow, false);
    assert.equal(snapshot.capabilities.sendMessage, false);
  });

  it('bumps revision when executionSource flips with the same execution value', () => {
    const first = reduce(createInitialSnapshot('src-flip'), [
      running(),
      observation('pane', 'execution', { execution: 'idle' }),
    ], 100);
    const second = reduce(first, [
      running(),
      observation('pane', 'execution', { execution: 'idle' }),
      observation('transcript', 'execution', { execution: 'idle', activity: 'terminal' }),
    ], 110);
    assert.equal(first.execution, 'idle');
    assert.equal(first.executionSource, 'pane');
    assert.equal(second.execution, 'idle');
    assert.equal(second.executionSource, 'transcript');
    assert.ok(second.revision > first.revision);
  });

  it('lets an expired transcript idle fall back to pane execution', () => {
    let timestamp = 100;
    const tracker = createSessionStateTracker({ now: () => timestamp });
    tracker.observe('recover', [
      running(),
      observation('pane', 'execution', { execution: 'working' }, { observedAt: 100, expiresAt: 10_000 }),
      observation('transcript', 'execution', {
        execution: 'idle',
        activity: 'terminal',
      }, { observedAt: 100, expiresAt: 200 }),
    ]);
    assert.equal(tracker.get('recover').execution, 'idle');
    assert.equal(tracker.get('recover').executionSource, 'transcript');

    timestamp = 200;
    const recovered = tracker.get('recover');
    assert.equal(recovered.execution, 'working');
    assert.equal(recovered.executionSource, 'pane');
    tracker.remove('recover');
  });

  it('maps a terminal execution alias to idle', () => {
    const snapshot = reduce(createInitialSnapshot('terminal-alias'), [
      running(),
      observation('transcript', 'execution', { execution: 'terminal' }),
    ], 100);
    assert.equal(snapshot.execution, 'idle');
    assert.equal(snapshot.executionSource, 'transcript');
  });

  it('lets a newer transcript write beat a stale hook working event', () => {
    const snapshot = reduce(createInitialSnapshot('hook-vs-transcript'), [
      running(),
      observation('hook', 'execution', { execution: 'working' }, { observedAt: 100 }),
      observation('transcript', 'execution', {
        execution: 'idle',
        activity: 'terminal',
        writtenAt: 140,
      }, { observedAt: 150 }),
    ], 150);
    assert.equal(snapshot.execution, 'idle');
    assert.equal(snapshot.executionSource, 'transcript');
  });

  it('lets a hook event newer than the last transcript write beat a read-time terminal stamp', () => {
    const snapshot = reduce(createInitialSnapshot('hook-newer'), [
      running(),
      observation('transcript', 'execution', {
        execution: 'idle',
        activity: 'terminal',
        writtenAt: 100,
      }, { observedAt: 150 }),
      observation('hook', 'execution', { execution: 'working' }, { observedAt: 140 }),
    ], 150);
    assert.equal(snapshot.execution, 'working');
    assert.equal(snapshot.executionSource, 'hook');
  });

  it('lets a clearly newer pane surface working after a stale transcript idle', () => {
    const snapshot = reduce(createInitialSnapshot('pane-newer'), [
      running(),
      observation('transcript', 'execution', {
        execution: 'idle',
        activity: 'terminal',
        writtenAt: 100,
      }, { observedAt: 100 }),
      observation('pane', 'execution', { execution: 'working' }, { observedAt: 2_200 }),
    ], 2_200);
    assert.equal(snapshot.execution, 'working');
    assert.equal(snapshot.executionSource, 'pane');
    assert.equal(snapshot.status, 'working');
  });

  it('does not flag ready or unknown as needing attention', () => {
    const ready = reduce(createInitialSnapshot('attn-ready'), [
      running(), freeText(), idlePane(),
    ], 100);
    const unknown = reduce(createInitialSnapshot('attn-unknown'), [
      running(),
      observation('pane', 'interaction', {
        kind: 'free_text', detail: 'Ready', options: [], stable: false,
      }),
      idlePane(),
    ], 100);
    const working = reduce(createInitialSnapshot('attn-working'), [
      running(),
      observation('pane', 'execution', { execution: 'working' }),
    ], 100);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.capabilities.needsAttention, false);
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.capabilities.needsAttention, false);
    assert.equal(working.status, 'working');
    assert.equal(working.capabilities.needsAttention, false);
  });

  it('keeps mismatch attention after ready is dropped from the predicate', () => {
    const snapshot = reduce(createInitialSnapshot('attn-mismatch-only'), [
      running(), freeText(), idlePane(),
      observation('runtime', 'requested_runtime', {
        requestedModel: 'gpt-5.5', requestedThinkingLevel: 'high',
      }),
      observation('pane', 'effective_runtime', {
        effectiveModel: 'gpt-5.4', effectiveThinkingLevel: 'medium',
      }),
    ], 100);
    assert.equal(snapshot.status, 'ready');
    assert.equal(snapshot.capabilities.needsAttention, true);
  });

  it('does not flap needsAttention across a late observer tick', async () => {
    const content = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'session-state', 'panes', 'claude-idle-empty-composer.pane'),
      'utf8',
    );
    let timestamp = 1_000_000;
    const tracker = createSessionStateTracker({ now: () => timestamp });
    function capture() {
      return tracker.observe('attn-late', [
        observation('process', 'lifecycle', { lifecycle: 'running' }, {
          observedAt: timestamp,
          expiresAt: timestamp + PROCESS_LIFECYCLE_FRESH_MS,
          fingerprint: 'process:running',
        }),
        ...observeClaudePane(content, {
          observedAt: timestamp,
          expiresAt: timestamp + PANE_FRESH_MS,
          requireRepeat: true,
        }),
      ]);
    }
    capture();
    timestamp += 2_000;
    capture();
    const last = timestamp;
    const flags = [];
    for (const late of [0, 15_000, 25_000, 40_000, 50_000, 120_000]) {
      timestamp = last + late;
      flags.push(tracker.get('attn-late').capabilities.needsAttention);
    }
    assert.deepEqual(flags, [false, false, false, false, false, false]);
    tracker.remove('attn-late');
  });

  it('prefers a newer pane execution over a stale hook execution', () => {
    const snapshot = reduce(createInitialSnapshot('execution'), [
      running(),
      observation('pane', 'execution', { execution: 'idle' }, { observedAt: 3_000 }),
      observation('hook', 'execution', { execution: 'working' }, { observedAt: 100 }),
    ], 4_000);
    assert.equal(snapshot.execution, 'idle');
    assert.equal(snapshot.capabilities.sendMessage, false);
  });

  it('prefers a newer hook execution over an older pane execution', () => {
    const snapshot = reduce(createInitialSnapshot('execution-hook'), [
      running(),
      observation('pane', 'execution', { execution: 'working' }, { observedAt: 100 }),
      observation('hook', 'execution', { execution: 'thinking' }, { observedAt: 110 }),
    ], 120);
    assert.equal(snapshot.execution, 'thinking');
    assert.equal(snapshot.status, 'thinking');
    assert.equal(snapshot.capabilities.sendMessage, false);
  });

  it('does not let a barely-newer pane overturn a hook', () => {
    const hookAt = 10_000;
    const snapshot = reduce(createInitialSnapshot('execution-margin'), [
      running(),
      observation('hook', 'execution', { execution: 'working' }, { observedAt: hookAt }),
      observation('pane', 'execution', { execution: 'idle' }, { observedAt: hookAt + 200 }),
    ], hookAt + 500);
    assert.equal(snapshot.execution, 'working');
    assert.equal(snapshot.status, 'working');
  });

  it('uses source as a tiebreak when hook and pane execution are equally fresh', () => {
    const snapshot = reduce(createInitialSnapshot('execution-tie'), [
      running(),
      observation('pane', 'execution', { execution: 'working' }, { observedAt: 110 }),
      observation('hook', 'execution', { execution: 'thinking' }, { observedAt: 110 }),
    ], 120);
    assert.equal(snapshot.execution, 'thinking');
    assert.equal(snapshot.status, 'thinking');
  });

  it('does not let hook prompt_ready alone produce ready status', () => {
    const snapshot = reduce(createInitialSnapshot('hook-ready'), [
      running(),
      observation('hook', 'execution', { activity: 'prompt_ready' }, { observedAt: 100 }),
    ], 120);
    assert.equal(snapshot.execution, 'idle');
    assert.notEqual(snapshot.status, 'ready');
    assert.equal(snapshot.capabilities.canSendNow, false);
  });

  it('lets a fresh pane beat a stale hook but keeps an equally fresh hook', () => {
    const now = 100_000;
    const hookTtl = 90_000;
    const paneAt = now - 1_000;
    function row(hookAgeMs) {
      const hookAt = now - hookAgeMs;
      return reduce(createInitialSnapshot(`hook-${hookAgeMs}`), [
        observation('process', 'lifecycle', { lifecycle: 'running' }, {
          observedAt: paneAt, expiresAt: paneAt + PANE_FRESH_MS, fingerprint: 'process:running',
        }),
        observation('pane', 'execution', { execution: 'idle' }, {
          observedAt: paneAt, expiresAt: paneAt + PANE_FRESH_MS, fingerprint: 'pane-idle',
        }),
        observation('pane', 'interaction', {
          kind: 'free_text', detail: 'Ready', options: [], stable: true,
        }, { observedAt: paneAt, expiresAt: paneAt + PANE_FRESH_MS, fingerprint: 'prompt-a' }),
        observation('hook', 'execution', { execution: 'working' }, {
          observedAt: hookAt, expiresAt: hookAt + hookTtl, fingerprint: 'hook-working',
        }),
      ], now);
    }
    const tied = row(1_000);
    assert.equal(tied.execution, 'working');
    assert.equal(tied.status, 'working');
    assert.equal(tied.capabilities.canSendNow, false);
    for (const age of [30_000, 89_000]) {
      const snapshot = row(age);
      assert.equal(snapshot.execution, 'idle', age);
      assert.equal(snapshot.status, 'ready', age);
      assert.equal(snapshot.capabilities.canSendNow, true, age);
    }
    const expiredHook = row(91_000);
    assert.equal(expiredHook.execution, 'idle');
    assert.equal(expiredHook.status, 'ready');
    assert.equal(expiredHook.capabilities.canSendNow, true);
  });

  it('keeps the previous lifecycle and degrades when process evidence expires', () => {
    const observations = [
      observation('process', 'lifecycle', { lifecycle: 'running' }, {
        observedAt: 100, expiresAt: 150, fingerprint: 'process:running',
      }),
    ];
    const runningSnap = reduce(createInitialSnapshot('life'), observations, 120);
    const expired = reduce(runningSnap, observations, 150);
    assert.equal(runningSnap.lifecycle, 'running');
    assert.equal(expired.lifecycle, 'running');
    assert.notEqual(expired.status, 'starting');
    assert.match(expired.degradedReasons.join('\n'), /Lifecycle evidence expired/i);
  });

  it('honors an explicit pane exit when tmux still exists', () => {
    const snapshot = reduce(createInitialSnapshot('shell-exit'), [
      running(),
      observation('pane', 'lifecycle', { lifecycle: 'ended' }),
      observation('pane', 'interaction', { kind: 'none', stable: false }),
    ], 100);
    assert.equal(snapshot.lifecycle, 'ended');
    assert.equal(snapshot.status, 'ended');
  });
});

describe('session state tracker', () => {
  it('owns immutable revisions, suppresses duplicate transitions, and explains evidence', () => {
    let timestamp = 100;
    const tracker = createSessionStateTracker({ now: () => timestamp, historyLimit: 2 });
    const revisions = [];
    tracker.subscribe('tracked', (snapshot) => revisions.push(snapshot.revision));
    tracker.observe('tracked', running());
    tracker.observe('tracked', idlePane());
    const ready = tracker.observe('tracked', freeText());
    const duplicate = tracker.observe('tracked', freeText());

    assert.equal(ready.status, 'ready');
    assert.equal(duplicate.revision, ready.revision);
    assert.deepEqual(revisions, [1, 2, 3]);
    assert.equal(Object.isFrozen(ready), true);
    const explanation = tracker.explain('tracked');
    assert.equal(explanation.observations.length, 3);
    assert.equal(explanation.history.length, 2);
    assert.equal(Object.isFrozen(explanation), true);

    timestamp = 200;
    assert.equal(tracker.remove('tracked'), true);
    assert.equal(tracker.get('tracked').revision, 0);
  });

  it('re-reduces expired observations and resolves capability waits from subscriptions', async () => {
    let timestamp = 100;
    const tracker = createSessionStateTracker({ now: () => timestamp });
    tracker.observe('waited', running());
    tracker.observe('waited', idlePane({ expiresAt: 150 }));
    const waiting = tracker.waitForCapability('waited', 'sendMessage', { timeoutMs: 500 });
    const ready = tracker.observe('waited', freeText({ expiresAt: 150 }));
    assert.equal(await waiting, ready);

    timestamp = 150;
    const expired = tracker.get('waited');
    assert.equal(expired.capabilities.sendMessage, false);
    assert.equal(expired.status, 'unknown');
    tracker.remove('waited');
  });

  it('requires two matching pane observations when repeat stability is requested', () => {
    let timestamp = 100;
    const tracker = createSessionStateTracker({ now: () => timestamp });
    tracker.observe('stable', [running(), idlePane()]);
    const first = tracker.observe('stable', observation('pane', 'interaction', {
      kind: 'free_text', stable: true, requireRepeat: true,
    }, { fingerprint: 'same-prompt', observedAt: timestamp, expiresAt: 200 }));
    assert.equal(first.capabilities.sendMessage, false);

    timestamp = 120;
    const second = tracker.observe('stable', observation('pane', 'interaction', {
      kind: 'free_text', stable: true, requireRepeat: true,
    }, { fingerprint: 'same-prompt', observedAt: timestamp, expiresAt: 200 }));
    assert.equal(second.capabilities.sendMessage, true);
  });

  it('accepts repeated free-text readiness when only volatile pane chrome changes', () => {
    let timestamp = 100;
    const tracker = createSessionStateTracker({ now: () => timestamp });
    tracker.observe('volatile', [running(), idlePane()]);
    const first = observeCodexPane('Completed work\n› \ngpt-5.6-codex low · 80% left', {
      observedAt: timestamp, expiresAt: 200, requireRepeat: true,
    });
    assert.equal(tracker.observe('volatile', first).capabilities.sendMessage, false);

    timestamp = 120;
    const second = observeCodexPane('Completed work\n› \ngpt-5.6-codex low · 79% left', {
      observedAt: timestamp, expiresAt: 200, requireRepeat: true,
    });
    assert.equal(tracker.observe('volatile', second).capabilities.sendMessage, true);
  });

  it('stabilizes captured idle panes across viewport and scrollback reads', async () => {
    const viewport = await fixture('panes/claude-26fb796d-idle-viewport.pane');
    const scrollback = await fixture('panes/claude-26fb796d-idle-scrollback.pane');
    assert.notEqual(viewport, scrollback);
    let timestamp = 1_000;
    const tracker = createSessionStateTracker({ now: () => timestamp });
    for (const [index, content] of [viewport, scrollback, viewport, scrollback].entries()) {
      const snapshot = tracker.observe('capture-depth', [
        running(),
        ...observeClaudePane(content, { observedAt: timestamp, requireRepeat: true }),
      ]);
      assert.equal(snapshot.execution, 'idle');
      assert.equal(snapshot.capabilities.canSendNow, index > 0);
      assert.equal(snapshot.status, index > 0 ? 'ready' : 'unknown');
      timestamp += 2_000;
    }
    // New output in the visible tail must still reset repeat stability.
    const changed = tracker.observe('capture-depth', observeClaudePane(viewport.replace('Sautéed', 'Worked'), {
      observedAt: timestamp, requireRepeat: true,
    }));
    assert.equal(changed.capabilities.canSendNow, false);
    assert.match(changed.reason, /not yet stable/);
    tracker.remove('capture-depth');
  });

  it('keeps captured busy panes unsendable on repeated captures', async () => {
    const cases = [
      ['claude', observeClaudePane, 'claude-working-tool-osmosing.pane'],
      ['claude', observeClaudePane, 'claude-thinking-moseying.pane'],
      ['codex', observeCodexPane, 'codex-e5ea5b75-background-terminal.pane'],
      ['pi', observePiPane, 'pi-5427de06-active.pane'],
    ];
    for (const [provider, observer, file] of cases) {
      let timestamp = 1_000;
      const tracker = createSessionStateTracker({ now: () => timestamp });
      const busy = await fixture(`panes/${file}`);
      for (let index = 0; index < 2; index += 1) {
        const snapshot = tracker.observe(provider, [running(), ...observer(busy, {
          observedAt: timestamp, requireRepeat: true,
        })]);
        assert.ok(['working', 'thinking'].includes(snapshot.execution), file);
        assert.equal(snapshot.capabilities.canSendNow, false, file);
        timestamp += 2_000;
      }
      tracker.remove(provider);
    }
  });

  it('sizes pane freshness and the stability window from the 15s observer cadence', () => {
    assert.equal(PANE_OBSERVER_CADENCE_MS, 15_000);
    assert.equal(PANE_FRESH_MS, 45_000);
    assert.equal(PANE_STABILITY_MATCH_MS, PANE_FRESH_MS);
    assert.equal(PROCESS_LIFECYCLE_FRESH_MS, 25_000);
    assert.ok(PANE_FRESH_MS >= PANE_OBSERVER_CADENCE_MS * 2);
    assert.ok(PROCESS_LIFECYCLE_FRESH_MS < 30_000);
  });

  it('stabilizes a live idle pane across observer cadence, not across an hour gap', async () => {
    const content = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'session-state', 'panes', 'claude-idle-empty-composer.pane'),
      'utf8',
    );
    let timestamp = 1_000_000;
    const tracker = createSessionStateTracker({ now: () => timestamp });

    function capture(expiresAt) {
      return tracker.observe('cadence', [
        running(),
        ...observeClaudePane(content, {
          observedAt: timestamp,
          expiresAt,
          requireRepeat: true,
        }),
      ]);
    }

    const single = capture(timestamp + PANE_FRESH_MS);
    assert.equal(single.status, 'unknown');
    assert.equal(single.capabilities.canSendNow, false);
    assert.match(single.reason, /not yet stable/i);

    timestamp += 2_000;
    const wsCadence = capture(timestamp + PANE_FRESH_MS);
    assert.equal(wsCadence.status, 'ready');
    assert.equal(wsCadence.capabilities.canSendNow, true);

    timestamp = 2_000_000;
    const laterSession = createSessionStateTracker({ now: () => timestamp });
    function laterCapture(expiresAt) {
      return laterSession.observe('cadence-late', [
        running(),
        ...observeClaudePane(content, {
          observedAt: timestamp,
          expiresAt,
          requireRepeat: true,
        }),
      ]);
    }
    laterCapture(timestamp + PANE_FRESH_MS);
    timestamp += PANE_OBSERVER_CADENCE_MS;
    const observerCadence = laterCapture(timestamp + PANE_FRESH_MS);
    assert.equal(observerCadence.status, 'ready');
    assert.equal(observerCadence.capabilities.canSendNow, true);

    timestamp += 3_600_000;
    const hourLater = laterCapture(timestamp + PANE_FRESH_MS);
    assert.equal(hourLater.status, 'unknown');
    assert.equal(hourLater.capabilities.canSendNow, false);
    laterSession.remove('cadence-late');
    tracker.remove('cadence');
  });

  it('does not keep a dead session ready after captures stop', async () => {
    const content = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'session-state', 'panes', 'claude-idle-empty-composer.pane'),
      'utf8',
    );
    let timestamp = 1_000_000;
    const tracker = createSessionStateTracker({ now: () => timestamp });
    function capture() {
      return tracker.observe('dead', [
        observation('process', 'lifecycle', { lifecycle: 'running' }, {
          observedAt: timestamp,
          expiresAt: timestamp + PROCESS_LIFECYCLE_FRESH_MS,
          fingerprint: 'process:running',
        }),
        ...observeClaudePane(content, {
          observedAt: timestamp,
          expiresAt: timestamp + PANE_FRESH_MS,
          requireRepeat: true,
        }),
      ]);
    }
    capture();
    timestamp += 2_000;
    const ready = capture();
    assert.equal(ready.status, 'ready');
    assert.equal(ready.capabilities.canSendNow, true);

    const lastCapture = timestamp;
    timestamp = lastCapture + 30_000;
    const at30s = tracker.get('dead');
    assert.equal(at30s.lifecycle, 'running');
    assert.equal(at30s.capabilities.canSendNow, false);
    assert.notEqual(at30s.status, 'ready');
    assert.notEqual(at30s.status, 'starting');
    assert.match(at30s.degradedReasons.join('\n'), /Lifecycle evidence expired/i);

    timestamp = lastCapture + 3_600_000;
    const hourDead = tracker.get('dead');
    assert.notEqual(hourDead.lifecycle, 'starting');
    assert.notEqual(hourDead.status, 'starting');
    assert.equal(hourDead.capabilities.canSendNow, false);
    assert.match(hourDead.degradedReasons.join('\n'), /Lifecycle evidence expired/i);
    tracker.remove('dead');
  });

  it('does not let a stale hook lifecycle keep a dead session sendable', async () => {
    const content = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'session-state', 'panes', 'claude-idle-empty-composer.pane'),
      'utf8',
    );
    let timestamp = 1_000_000;
    const tracker = createSessionStateTracker({ now: () => timestamp });
    function capture() {
      const hookAt = timestamp - 5_000;
      return tracker.observe('dead-hook', [
        observation('process', 'lifecycle', { lifecycle: 'running' }, {
          observedAt: timestamp,
          expiresAt: timestamp + PROCESS_LIFECYCLE_FRESH_MS,
          fingerprint: 'process:running',
        }),
        observation('hook', 'lifecycle', { lifecycle: 'running' }, {
          observedAt: hookAt,
          expiresAt: hookAt + 90_000,
          fingerprint: 'hook-life',
        }),
        observation('hook', 'execution', { execution: 'idle' }, {
          observedAt: hookAt,
          expiresAt: hookAt + 90_000,
          fingerprint: 'hook-exec',
        }),
        ...observeClaudePane(content, {
          observedAt: timestamp,
          expiresAt: timestamp + PANE_FRESH_MS,
          requireRepeat: true,
        }),
      ]);
    }
    capture();
    timestamp += 2_000;
    const ready = capture();
    assert.equal(ready.status, 'ready');
    assert.equal(ready.capabilities.canSendNow, true);

    const lastCapture = timestamp;
    timestamp = lastCapture + 30_000;
    const at30s = tracker.get('dead-hook');
    assert.equal(at30s.capabilities.canSendNow, false);
    assert.notEqual(at30s.status, 'ready');
    assert.notEqual(at30s.status, 'starting');
    assert.match(at30s.degradedReasons.join('\n'), /Lifecycle evidence expired/i);
    tracker.remove('dead-hook');
  });

  it('does not require the prior pane observation to still be unexpired to dwell', () => {
    let timestamp = 1_000;
    const tracker = createSessionStateTracker({ now: () => timestamp });
    tracker.observe('expired-prior', [running(), idlePane()]);
    tracker.observe('expired-prior', observation('pane', 'interaction', {
      kind: 'free_text',
      stable: true,
      requireRepeat: true,
      stabilityFingerprint: 'idle-prompt',
    }, { fingerprint: 'prompt-a', observedAt: timestamp, expiresAt: timestamp + 5_000 }));

    timestamp += PANE_OBSERVER_CADENCE_MS;
    const second = tracker.observe('expired-prior', observation('pane', 'interaction', {
      kind: 'free_text',
      stable: true,
      requireRepeat: true,
      stabilityFingerprint: 'idle-prompt',
    }, { fingerprint: 'prompt-a', observedAt: timestamp, expiresAt: timestamp + PANE_FRESH_MS }));
    assert.equal(second.status, 'ready');
    assert.equal(second.capabilities.canSendNow, true);
    tracker.remove('expired-prior');
  });
});

describe('pane observation providers', () => {
  it('reuses shared Claude detector semantics', () => {
    const observations = observeClaudePane([
      'Claude wants to run Bash',
      'Do you want to allow this command?',
      'Allow once',
    ].join('\n'), { observedAt: 100, expiresAt: 200 });
    const interaction = observations.find((item) => item.kind === 'interaction');
    assert.equal(interaction.value.kind, 'permission');
  });

  it('extracts selected Claude menu options into the canonical interaction', () => {
    const observations = observeClaudePane([
      'Choose deployment target',
      '❯ 1. Staging',
      '  2. Production',
      '  3. Cancel',
    ].join('\n'), { observedAt: 100, expiresAt: 200 });
    const interaction = observations.find((item) => item.kind === 'interaction');
    assert.equal(interaction.value.kind, 'selection');
    assert.equal(interaction.value.detail, 'Choose deployment target');
    assert.deepEqual(interaction.value.options, [
      { key: '1', label: 'Staging' },
      { key: '2', label: 'Production' },
      { key: '3', label: 'Cancel' },
    ]);
  });

  it('does not treat a numbered assistant list as a live selection prompt', () => {
    const observations = observeCodexPane([
      'Summary of completed work',
      '› 1. Added recursive summaries',
      '  2. Connected citation descendants',
      '  3. Added arbitrary-depth expansion',
      '',
      '• Working (2m 4s • esc to interrupt)',
    ].join('\n'), { observedAt: 100, expiresAt: 200 });
    const interaction = observations.find((item) => item.kind === 'interaction');

    assert.notEqual(interaction.value.kind, 'selection');
  });

  it('uses the visible Codex composer to distinguish numbered output from a menu', () => {
    const observations = observeCodexPane([
      'Choose three completed features',
      '› 1. Added recursive summaries',
      '  2. Connected citation descendants',
      '  3. Added arbitrary-depth expansion',
      '',
      '────────────────────────────────────────────────────────',
      '› Find and fix a bug in @filename',
      'gpt-5.6-sol medium · 72% left · ~/project',
    ].join('\n'), { observedAt: 100, expiresAt: 200 });
    const interaction = observations.find((item) => item.kind === 'interaction');

    assert.notEqual(interaction.value.kind, 'selection');
  });

  it('uses the visible Pi input footer to distinguish numbered output from a menu', () => {
    const observations = observePiPane([
      'Choose three completed features',
      '› 1. Added recursive summaries',
      '  2. Connected citation descendants',
      '  3. Added arbitrary-depth expansion',
      '',
      '/home/dev/projects/fleet',
      '0.0%/272k (auto)                 (openai) gpt-5.5 • high',
    ].join('\n'), { observedAt: 100, expiresAt: 200 });
    const interaction = observations.find((item) => item.kind === 'interaction');

    assert.notEqual(interaction.value.kind, 'selection');
  });

  it('does not stitch separated numbered output into a selection menu', () => {
    const observations = observeClaudePane([
      'Choose implementation detail',
      '❯ 1. First result',
      'Explanation between results',
      '  2. Second result',
    ].join('\n'), { observedAt: 100, expiresAt: 200 });
    const interaction = observations.find((item) => item.kind === 'interaction');

    assert.notEqual(interaction.value.kind, 'selection');
  });

  it('keeps a selection fingerprint stable across unrelated pane changes', () => {
    const first = observeCodexPane([
      'Earlier output at 10:01',
      'Choose deployment target',
      '❯ 1. Staging',
      '  2. Production',
    ].join('\n'), { observedAt: 100, expiresAt: 200 })
      .find((item) => item.kind === 'interaction');
    const second = observeCodexPane([
      'Different earlier output at 10:02',
      'Choose deployment target',
      '❯ 1. Staging',
      '  2. Production',
      'gpt-5.6-codex high · 79% left',
    ].join('\n'), { observedAt: 120, expiresAt: 220 })
      .find((item) => item.kind === 'interaction');
    const replaced = observeCodexPane([
      'Choose deployment target',
      '❯ 1. Staging',
      '  2. Cancel',
    ].join('\n'), { observedAt: 140, expiresAt: 240 })
      .find((item) => item.kind === 'interaction');

    assert.equal(first.fingerprint, second.fingerprint);
    assert.notEqual(first.fingerprint, replaced.fingerprint);
  });

  it('ignores numbered option text from the submitted prompt above the live menu', () => {
    const interaction = observeCodexPane([
      '› Options in exact order: 1) Red — first panel option,',
      '  2) Green — second panel option, 3) Blue — third panel option.',
      '',
      'Question 1/1 (1 unanswered)',
      'Which Agents-panel test option do you choose?',
      '',
      '› 1. Red                first panel option',
      '  2. Green              second panel option',
      '  3. Blue               third panel option',
      '  4. None of the above  Optionally, add details in notes (tab).',
    ].join('\n'), { observedAt: 100, expiresAt: 200 })
      .find((item) => item.kind === 'interaction');

    assert.equal(interaction.value.detail, 'Which Agents-panel test option do you choose?');
    assert.deepEqual(interaction.value.options, [
      { key: '1', label: 'Red                first panel option' },
      { key: '2', label: 'Green              second panel option' },
      { key: '3', label: 'Blue               third panel option' },
      { key: '4', label: 'None of the above  Optionally, add details in notes (tab).' },
    ]);
  });

  it('detects a Claude prompt above the expanded idle footer', () => {
    const observations = observeClaudePane([
      'Finished reviewing.',
      '────────────────────────────────────────────────────────────────',
      '❯ keep going, ping me when it passes review',
      '────────────────────────────────────────────────────────────────',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
      'new task? /clear to save 435.8k tokens',
    ].join('\n'), { observedAt: 100, expiresAt: 200 });
    const snapshot = reduce(createInitialSnapshot('claude-expanded-footer'), [
      running(),
      ...observations,
    ], 100);

    assert.equal(snapshot.status, 'ready');
    assert.equal(snapshot.interaction.kind, 'free_text');
    assert.equal(snapshot.capabilities.sendMessage, true);
  });

  it('structurally detects Codex option-2 guardrail as blocking', async () => {
    const content = await fixture('codex-guardrail.txt');
    const guardrail = detectCodexGuardrail(content);
    assert.equal(guardrail.kind, 'guardrail');
    assert.equal(guardrail.policyOption, 2);
    assert.match(guardrail.policyLabel, /^wait for verification$/i);

    const pane = observeCodexPane(content, { observedAt: 100, expiresAt: 200 });
    const snapshot = reduce(createInitialSnapshot('guardrail'), [running(), ...pane], 100);
    assert.equal(snapshot.interaction.kind, 'guardrail');
    assert.equal(snapshot.status, 'blocked');
    assert.equal(snapshot.capabilities.sendMessage, false);
  });

  it('does not classify incidental verification text as the guardrail', () => {
    assert.equal(detectCodexGuardrail('I will wait for verification before reporting back.\n› '), null);
    assert.equal(detectCodexGuardrail([
      'Suggested choices:',
      '1. Continue without verification',
      '2. Wait for verification',
      '› ',
    ].join('\n')), null);
  });

  it('detects Codex workspace trust structurally', async () => {
    const content = await fixture('codex-trust.txt');
    const trust = detectCodexTrust(content);
    assert.equal(trust.kind, 'trust');
    assert.deepEqual(trust.options.map((option) => option.index), [1, 2]);
    const interaction = observeCodexPane(content, { observedAt: 100, expiresAt: 200 })
      .find((item) => item.kind === 'interaction');
    assert.equal(interaction.value.kind, 'trust');
  });

  it('does not classify trust prose without a selected dialog as workspace trust', () => {
    assert.equal(detectCodexTrust('I asked: do you trust the authors?\n› '), null);
    assert.equal(detectClaudeTrust('I asked: do you trust the authors?\n› '), null);
  });

  it('detects Claude folder-trust confirm without a numbered Codex dialog', () => {
    const content = 'Do you trust this folder?\n\n/media/dev/SharedDrive/disk-offload/example-sim/local/example-conference';
    assert.equal(detectClaudeTrust(content).kind, 'trust');
    const interaction = observeClaudePane(content, { observedAt: 100, expiresAt: 200 })
      .find((item) => item.kind === 'interaction');
    assert.equal(interaction.value.kind, 'trust');
  });

  it('structurally detects the Codex update prompt as policy-owned', async () => {
    const content = await fixture('codex-update.txt');
    const update = detectCodexUpdate(content);
    assert.equal(update.kind, 'update');
    const snapshot = reduce(createInitialSnapshot('update'), [
      running(),
      ...observeCodexPane(content, { observedAt: 100, expiresAt: 200 }),
    ], 100);
    assert.equal(snapshot.interaction.kind, 'update');
    assert.equal(snapshot.capabilities.canAnswerInteraction, false);
  });

  it('does not classify ordinary update prose as the Codex update prompt', () => {
    assert.equal(detectCodexUpdate('I will update the files now.\n› '), null);
  });

  it('parses effective Codex model and thinking footer without changing requested values', async () => {
    const content = await fixture('codex-ready-footer.txt');
    assert.deepEqual(parseCodexRuntimeFooter(content), {
      effectiveModel: 'gpt-5.4',
      effectiveThinkingLevel: 'medium',
    });
    const observations = observeCodexPane(content, { observedAt: 100, expiresAt: 200 });
    const runtime = observations.find((item) => item.kind === 'effective_runtime');
    assert.deepEqual(runtime.value, {
      effectiveModel: 'gpt-5.4',
      effectiveThinkingLevel: 'medium',
    });
  });

  it('covers sanitized Claude normal and blocking panes', async () => {
    const readyPane = observeClaudePane(await fixture('claude-ready.txt'), { observedAt: 100, expiresAt: 200 });
    const ready = reduce(createInitialSnapshot('claude-ready'), [running(), ...readyPane], 100);
    assert.equal(ready.status, 'ready');
    assert.equal(ready.capabilities.sendMessage, true);

    const blockedPane = observeClaudePane(await fixture('claude-permission.txt'), { observedAt: 100, expiresAt: 200 });
    const blocked = reduce(createInitialSnapshot('claude-blocked'), [running(), ...blockedPane], 100);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.interaction.kind, 'permission');
    assert.equal(blocked.capabilities.sendMessage, false);
  });

  it('detects Pi idle and working panes from Pi-specific TUI markers', () => {
    const footer = [
      '────────────────────────────────────────────────────────',
      '',
      '────────────────────────────────────────────────────────',
      '/home/dev/projects/fleet',
      '0.0%/272k (auto)                 (openai) gpt-5.5 • high',
    ].join('\n');
    const idle = reduce(createInitialSnapshot('pi-idle'), [
      running(),
      ...observePiPane(footer, { observedAt: 100, expiresAt: 200 }),
    ], 100);
    const working = reduce(createInitialSnapshot('pi-working'), [
      running(),
      ...observePiPane(`${footer}\n⠋ Working... (escape to interrupt)`, { observedAt: 100, expiresAt: 200 }),
    ], 100);

    assert.equal(idle.status, 'ready');
    assert.equal(idle.capabilities.sendMessage, true);
    assert.deepEqual(idle.runtime, {
      requestedModel: '',
      requestedThinkingLevel: '',
      effectiveModel: 'gpt-5.5',
      effectiveThinkingLevel: 'high',
    });
    assert.equal(working.status, 'working');
    assert.equal(working.capabilities.sendMessage, false);
  });

  it('detects Pi bordered composer Working spinner versus a plain idle border', () => {
    const idleFooter = [
      '────────────────────────────────────────────────────────────────────────────────',
      '~/projects/dueno-fleet-task-workflow (feat/durable-task-workflow)',
      '↑459k ↓22k R2.8M CH97.2% $2.440 (sub) 25.8%/500k (auto)    (xai) grok-4.6 • high',
    ].join('\n');
    const workingFooter = [
      '── ⠴ Working ───────────────────────────────────────────────────────────────────',
      '',
      '────────────────────────────────────────────────────────────────────────────────',
      '~/projects/dueno-fleet-task-workflow (feat/durable-task-workflow)',
      '↑459k ↓22k R2.8M CH97.2% $2.440 (sub) 25.8%/500k (auto)    (xai) grok-4.6 • high',
    ].join('\n');
    assert.equal(detectProviderState('pi', idleFooter).state, 'waiting_for_input');
    assert.equal(detectProviderState('pi', workingFooter).state, 'working');
    assert.equal(detectProviderState('pi', 'Working on the report').state, 'unknown');
    assert.notEqual(detectProviderState('pi', '── Working directory: /tmp ──').state, 'working');
    assert.notEqual(detectProviderState('pi', '| Working |\n---').state, 'working');
    assert.notEqual(detectProviderState('claude', '── Working directory: /tmp ──').state, 'working');
    assert.notEqual(detectProviderState('codex', '── Working directory: /tmp ──').state, 'working');
  });

  it('parses Pi thinking-off footer state', () => {
    assert.deepEqual(parsePiRuntimeFooter(
      '0.0%/128k (auto)  local-model • thinking off',
    ), {
      effectiveModel: 'local-model',
      effectiveThinkingLevel: 'off',
    });
  });

  it('does not treat approval prose above an idle Pi footer as a permission prompt', () => {
    const content = [
      'Do you want to proceed?',
      'Allow once',
      '(Y)es (N)o (A)lways',
      '────────────────────────────────────────────────────────',
      '/home/dev/projects/fleet',
      '13.0%/500k (auto)  (xai) grok-4.6 • high',
    ].join('\n');
    const legacy = detectProviderState('pi', content);
    const interaction = observePiPane(content, { observedAt: 100, expiresAt: 200 })
      .find((item) => item.kind === 'interaction');
    assert.equal(legacy.state, 'waiting_for_input');
    assert.equal(interaction.value.kind, 'free_text');
  });

  it('does not treat a quoted Codex Working line as Claude busy', () => {
    const content = [
      '• Working (12s)',
      '────────────────────────────────────────────────────────',
      '❯ ',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');
    assert.equal(detectProviderState('claude', content).state, 'waiting_for_input');
  });

  it('classifies Codex max-effort status lines as footer chrome', () => {
    const content = [
      'Done.',
      '› Explain this codebase',
      'gpt-5.6-sol max · ~/projects/example-research',
    ].join('\n');
    const view = normalizeProviderPane('codex', content);
    assert.equal(view.promptVisible, true);
    assert.ok(view.footerLines.some((line) => /gpt-5\.6-sol max/.test(line)));
    assert.deepEqual(parseCodexRuntimeFooter(content), {
      effectiveModel: 'gpt-5.6-sol',
      effectiveThinkingLevel: 'max',
    });
    assert.equal(detectProviderState('codex', content).state, 'waiting_for_input');
  });
});

describe('hook and transcript observation providers', () => {
  for (const provider of ['claude', 'codex']) {
    it(`maps sanitized ${provider} hook execution`, async () => {
      const hook = JSON.parse(await fixture(`${provider}-hook-working.json`));
      const derived = deriveHookState(hook);
      assert.equal(derived.lifecycle, 'running');
      assert.ok(['working', 'tool_running'].includes(derived.activity));
    });

    it(`maps sanitized ${provider} transcript activity conservatively`, async () => {
      const observations = observeTranscriptContent(
        await fixture(`${provider}-transcript-working.jsonl`),
        { provider, observedAt: 100, expiresAt: 200 },
      );
      assert.equal(observations.length, 1);
      assert.equal(observations[0].source, 'transcript');
      assert.equal(observations[0].value.execution, 'working');
      assert.equal(observations[0].value.activity, 'working');
    });
  }

  it('emits idle for a completed Claude assistant turn', () => {
    const observations = observeTranscriptContent(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      }),
      { provider: 'claude', observedAt: 100, expiresAt: 200 },
    );
    assert.equal(observations.length, 1);
    assert.equal(observations[0].source, 'transcript');
    assert.equal(observations[0].value.execution, 'idle');
    assert.equal(observations[0].value.activity, 'terminal');
  });

  it('emits idle for a completed transcript record instead of discarding it', () => {
    const observations = observeTranscriptContent(
      '{"type":"event_msg","payload":{"type":"task_complete"}}\n',
      { provider: 'codex', observedAt: 100, expiresAt: 200 },
    );
    assert.equal(observations.length, 1);
    assert.equal(observations[0].source, 'transcript');
    assert.equal(observations[0].value.execution, 'idle');
    assert.equal(observations[0].value.activity, 'terminal');
  });

  it('classifies Pi tool calls, results, and explicit assistant stop reasons', () => {
    const toolCall = { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'sleep 60' } };
    const text = { type: 'text', text: 'Still processing.' };
    const cases = [
      [{ role: 'user', content: 'Run the tool' }, 'working'],
      ...[false, true].map((isError) => [{
        role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [text], isError,
      }, 'working']),
      ...[undefined, 'toolUse', 'stop', 'length'].map((stopReason) => [{
        role: 'assistant', content: [text, toolCall], stopReason,
      }, 'working']),
      ...[undefined, 'toolUse', 'pending', 'deferred', 'unrecognized'].map((stopReason) => [{
        role: 'assistant', content: [text], stopReason,
      }, 'working']),
      [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'Considering options' }] }, 'working'],
      ...['stop', 'length', 'error', 'aborted'].map((stopReason) => [{
        role: 'assistant', content: [text], stopReason,
      }, 'terminal']),
      ...['error', 'aborted'].map((stopReason) => [{
        role: 'assistant', content: [toolCall], stopReason, errorMessage: 'Interrupted response',
      }, 'terminal']),
    ];
    for (const [message, activity] of cases) {
      for (const record of [message, { type: 'message', message }]) {
        const observations = observeTranscriptContent([
          JSON.stringify({ type: 'message', message: { role: 'assistant', content: [], stopReason: 'stop' } }),
          JSON.stringify(record),
          '{"type":"model_change","modelId":"grok-4.6"}',
          '{"type":"message",', // Partial writes cannot erase the last complete message.
        ].join('\n'), { provider: 'pi', observedAt: 100 });
        assert.equal(observations.length, 1);
        assert.equal(observations[0].value.activity, activity, JSON.stringify(record));
        assert.equal(observations[0].value.execution, activity === 'terminal' ? 'idle' : 'working');
      }
    }
    assert.deepEqual(observeTranscriptContent('{"type":"session","version":3}', { provider: 'pi' }), []);
  });

  it('keeps Pi tools interruptible and queueable across same-tick and long-tool pane captures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-transcript-working-'));
    const filePath = join(dir, 'session.jsonl');
    const writtenAt = 1_767_225_600_000;
    let timestamp = writtenAt;
    const tracker = createSessionStateTracker({ now: () => timestamp });
    const pane = await fixture('panes/pi-working.pane');
    try {
      await writeFile(filePath, JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant', stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'sleep 60' } }],
        },
      }) + '\n');
      await utimes(filePath, new Date(writtenAt), new Date(writtenAt));
      for (const elapsed of [0, TRANSCRIPT_WORKING_FRESHNESS_MS, 15_000, 60_000]) {
        timestamp = writtenAt + elapsed;
        const transcript = await observeTranscriptFile(filePath, { provider: 'pi', now: timestamp });
        assert.equal(transcript.length, elapsed === 0 ? 1 : 0);
        const state = tracker.observe('pi-long-tool', [
          observation('process', 'lifecycle', { lifecycle: 'running' }, {
            observedAt: timestamp, expiresAt: timestamp + PROCESS_LIFECYCLE_FRESH_MS,
          }),
          ...observePiPane(pane, { observedAt: timestamp }),
          ...transcript,
        ]);
        assert.equal(state.execution, 'working', `elapsed ${elapsed}`);
        assert.equal(state.executionSource, elapsed === 0 ? 'transcript' : 'pane');
        assert.equal(state.status, 'working');
        assert.equal(state.interaction.kind, 'none');
        assert.equal(state.capabilities.canInterrupt, true);
        assert.equal(state.capabilities.canQueueMessage, true);
        assert.equal(state.capabilities.canSendNow, false);
      }
    } finally {
      tracker.remove('pi-long-tool');
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('latches Pi final, error, and abort records but requires a stable prompt to send', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-transcript-terminal-'));
    const filePath = join(dir, 'session.jsonl');
    const writtenAt = 1_767_225_600_000;
    const workingPane = await fixture('panes/pi-working.pane');
    const idlePane = await fixture('panes/pi-idle-after-compaction.pane');
    try {
      for (const stopReason of ['stop', 'length', 'error', 'aborted']) {
        await writeFile(filePath, JSON.stringify({
          type: 'message', message: { role: 'assistant', content: [], stopReason },
        }) + '\n');
        await utimes(filePath, new Date(writtenAt), new Date(writtenAt));
        for (const elapsed of [0, 15_000, 60_000]) {
          const now = writtenAt + elapsed;
          const transcript = await observeTranscriptFile(filePath, { provider: 'pi', now });
          assert.equal(transcript[0].value.execution, 'idle', stopReason);
          assert.equal(transcript[0].observedAt, now);
          assert.equal(transcript[0].value.writtenAt, writtenAt);
          assert.equal(transcript[0].expiresAt, now + TRANSCRIPT_TERMINAL_FRESHNESS_MS);
          for (const [pane, stable, ready] of [[workingPane, true, false], [idlePane, false, false], [idlePane, true, true]]) {
            const state = reduce(null, [
              running(), ...transcript, ...observePiPane(pane, { observedAt: now, stable }),
            ], now);
            assert.equal(state.lifecycle, 'running');
            assert.equal(state.execution, 'idle');
            assert.equal(state.executionSource, 'transcript');
            assert.equal(state.status, ready ? 'ready' : 'unknown');
            assert.equal(state.capabilities.canSendNow, ready);
            assert.equal(state.capabilities.canInterrupt, false);
          }
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps terminal freshness longer than the observer cadence and working freshness tight', () => {
    assert.equal(TRANSCRIPT_OBSERVER_CADENCE_MS, 15_000);
    assert.equal(TRANSCRIPT_TERMINAL_FRESHNESS_MS, TRANSCRIPT_OBSERVER_CADENCE_MS * 3);
    assert.ok(TRANSCRIPT_TERMINAL_FRESHNESS_MS >= 30_000);
    assert.equal(TRANSCRIPT_WORKING_FRESHNESS_MS, 5_000);
    assert.ok(TRANSCRIPT_WORKING_FRESHNESS_MS < TRANSCRIPT_OBSERVER_CADENCE_MS);
  });

  it('still emits idle across a 15s observer cadence long after the file mtime', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'transcript-idle-'));
    const filePath = join(dir, 'session.jsonl');
    try {
      await writeFile(filePath, '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}\n');
      const stale = new Date(1_577_836_800_000); // 2020-01-01
      await utimes(filePath, stale, stale);
      const start = 1_767_225_600_000; // 2026-01-01, years after mtime
      for (let tick = 0; tick < 4; tick += 1) {
        const now = start + (tick * TRANSCRIPT_OBSERVER_CADENCE_MS);
        const observations = await observeTranscriptFile(filePath, {
          provider: 'claude',
          now,
        });
        assert.equal(observations.length, 1, `tick ${tick}`);
        assert.equal(observations[0].value.execution, 'idle', `tick ${tick}`);
        assert.equal(observations[0].value.writtenAt, stale.getTime(), `tick ${tick}`);
        assert.equal(observations[0].observedAt, now, `tick ${tick}`);
        assert.equal(observations[0].expiresAt, now + TRANSCRIPT_TERMINAL_FRESHNESS_MS, `tick ${tick}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not emit a working record whose mtime is 10s old', async () => {
    assert.ok(TRANSCRIPT_WORKING_FRESHNESS_MS < 10_000);
    const dir = await mkdtemp(join(tmpdir(), 'transcript-working-10s-'));
    const filePath = join(dir, 'session.jsonl');
    try {
      await writeFile(filePath, await fixture('claude-transcript-working.jsonl'));
      const now = 1_767_225_600_000;
      const stale = new Date(now - 10_000);
      await utimes(filePath, stale, stale);
      const observations = await observeTranscriptFile(filePath, {
        provider: 'claude',
        now,
      });
      assert.deepEqual(observations, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lets a later terminal observation replace a future-mtime working record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'transcript-future-mtime-'));
    const filePath = join(dir, 'session.jsonl');
    const now = 1_767_225_600_000;
    let timestamp = now;
    const tracker = createSessionStateTracker({ now: () => timestamp });
    try {
      await writeFile(filePath, await fixture('claude-transcript-working.jsonl'));
      await utimes(filePath, new Date(now + 120_000), new Date(now + 120_000));
      const working = await observeTranscriptFile(filePath, { provider: 'claude', now });
      assert.equal(working[0].value.execution, 'working');
      assert.equal(working[0].observedAt, now);
      tracker.observe('pinned', [running(), ...working]);
      assert.equal(tracker.get('pinned').execution, 'working');

      await writeFile(filePath, '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}\n');
      timestamp = now + 10;
      const idle = await observeTranscriptFile(filePath, { provider: 'claude', now: timestamp });
      assert.equal(idle[0].value.execution, 'idle');
      tracker.observe('pinned', idle);
      assert.equal(tracker.get('pinned').execution, 'idle');
      assert.equal(tracker.get('pinned').executionSource, 'transcript');
    } finally {
      tracker.remove('pinned');
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not treat an unrecognized transcript activity as idle', () => {
    assert.equal(transcriptExecutionFromActivity('working'), 'working');
    assert.equal(transcriptExecutionFromActivity('terminal'), 'idle');
    assert.equal(transcriptExecutionFromActivity('thinking'), '');
    assert.equal(transcriptExecutionFromActivity('compacting'), '');
    assert.equal(transcriptExecutionFromActivity(''), '');
    const observations = observeTranscriptContent(
      '{"type":"system","message":{"role":"system","content":"compaction summary"}}\n',
      { provider: 'claude', observedAt: 100, expiresAt: 200 },
    );
    assert.deepEqual(observations, []);
  });
});
