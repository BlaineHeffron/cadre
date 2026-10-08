import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  createSessionCommandGate,
  createTmuxCommandExecutor,
} from '../modules/session-state/command-gate.mjs';
import { createSessionStateTracker } from '../modules/session-state/tracker.mjs';
import { allowsActiveQueue } from '../modules/sessions/index.mjs';

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

const activeGates = [];

afterEach(() => {
  while (activeGates.length > 0) {
    const { gate, sessionId } = activeGates.pop();
    gate.unregister(sessionId);
  }
});

function harness({ refresh, progressTimeoutMs } = {}) {
  const sessionId = 'codex-gate-test';
  let clock = 100;
  const tracker = createSessionStateTracker({ now: () => clock });
  const audit = [];
  const executions = [];
  let executeImpl = async () => {};
  let paneContent = 'ready prompt';

  function observe({
    lifecycle = 'running',
    execution = 'idle',
    interaction = 'free_text',
    fingerprint = 'prompt-1',
    stable = interaction === 'free_text',
    detail = '',
    options = [],
    content,
    expiresAt = 0,
  } = {}) {
    if (typeof content === 'string') paneContent = content;
    clock += 1;
    tracker.observe(sessionId, [
      {
        source: 'process',
        kind: 'lifecycle',
        value: { lifecycle },
        observedAt: clock,
        expiresAt,
        fingerprint: `process:${lifecycle}`,
      },
      {
        source: 'pane',
        kind: 'screen',
        value: { execution, kind: interaction, stable, detail, options },
        observedAt: clock,
        expiresAt: 0,
        fingerprint,
      },
    ]);
    return tracker.get(sessionId);
  }

  function observeTranscript(execution = 'working') {
    clock += 1;
    tracker.observe(sessionId, [{
      source: 'transcript',
      kind: 'execution',
      value: { execution, activity: execution === 'idle' ? 'terminal' : execution },
      observedAt: clock,
      expiresAt: 0,
      fingerprint: `transcript:${execution}:${clock}`,
    }]);
    return tracker.get(sessionId);
  }

  observe();
  const gate = createSessionCommandGate({
    tracker,
    now: () => clock,
    sleepFn: immediate,
    pollIntervalMs: 5,
    progressTimeoutMs,
    idFactory: (() => {
      let sequence = 0;
      return () => `command-${++sequence}`;
    })(),
  });
  gate.register(sessionId, {
    refresh: refresh
      ? () => refresh({ observe, tracker, sessionId, executions })
      : () => ({ canonicalState: tracker.get(sessionId), content: paneContent }),
    execute: async (operation) => {
      executions.push(operation);
      return executeImpl(operation);
    },
    audit: async (record) => audit.push(record),
  });
  activeGates.push({ gate, sessionId });

  return {
    sessionId,
    tracker,
    gate,
    audit,
    executions,
    observe,
    observeTranscript,
    advance(ms) {
      clock += Number(ms) || 0;
    },
    setExecute(fn) {
      executeImpl = fn;
    },
  };
}

function statesFor(audit, transactionId) {
  return audit
    .filter((entry) => entry.transactionId === transactionId)
    .map((entry) => entry.state);
}

describe('session command gate', () => {
  // Regression: a pasted-but-unsubmitted startup prompt used to be reported as
  // delivered. The paste alone changes the pane, and providers without a
  // hook/transcript signal (codex) look identical whether or not Enter landed.
  it('does not confirm a startup prompt when only the pane changed', async () => {
    const test = harness({ progressTimeoutMs: 200 });
    const ticket = test.gate.submit(test.sessionId, {
      id: 'startup-echo-only',
      operation: 'startup',
      source: 'codex_initial_prompt',
      text: 'a long pasted prompt',
      enter: true,
    });
    await immediate();
    // Composer now renders the pasted text: pane fingerprint moves, agent stays
    // idle. Pre-fix this counted as progress and the prompt was called delivered.
    test.observe({ execution: 'idle', interaction: 'free_text', fingerprint: 'pasted-text' });
    const result = await ticket.completion;

    assert.equal(result.state, 'completed');
    assert.equal(result.submissionConfirmed, false, 'unsubmitted prompt must not report confirmed');
    const completed = test.audit.find(
      (entry) => entry.transactionId === 'startup-echo-only' && entry.state === 'completed',
    );
    assert.equal(completed.confirmation, 'unconfirmed');
    // Enter is re-sent, and only Enter — re-pasting the text would duplicate the prompt.
    const retries = test.executions.filter((op) => op.operation === 'startup' && op.text === '');
    assert.ok(retries.length >= 1, 'expected at least one Enter-only retry');
    assert.ok(retries.every((op) => op.enter === true));
  });

  it('confirms a startup prompt once the agent actually starts working', async () => {
    const test = harness({ progressTimeoutMs: 20 });
    const ticket = test.gate.submit(test.sessionId, {
      id: 'startup-real-submit',
      operation: 'startup',
      source: 'codex_initial_prompt',
      text: 'a long pasted prompt',
      enter: true,
    });
    await immediate();
    test.observe({ execution: 'working', interaction: 'none', fingerprint: 'working-1' });
    await immediate();
    const result = await ticket.completion;

    assert.equal(result.submissionConfirmed, true);
    const completed = test.audit.find(
      (entry) => entry.transactionId === 'startup-real-submit' && entry.state === 'completed',
    );
    assert.equal(completed.confirmation, 'submitted');
    assert.equal(
      test.executions.filter((op) => op.operation === 'startup' && op.text === '').length,
      0,
      'must not re-send Enter when submission was observed',
    );
  });

  it('does not retry Enter when a blocking interaction races the retry', async () => {
    let postSendRefreshes = 0;
    const test = harness({
      progressTimeoutMs: 5,
      refresh: ({ observe, tracker, sessionId, executions }) => {
        if (executions.length === 1) {
          postSendRefreshes += 1;
          if (postSendRefreshes === 3) {
            observe({ interaction: 'permission', fingerprint: 'permission-race' });
          }
        }
        return { canonicalState: tracker.get(sessionId), content: 'startup prompt' };
      },
    });
    const result = await test.gate.enqueue(test.sessionId, {
      id: 'startup-permission-race',
      operation: 'startup',
      source: 'codex_initial_prompt',
      text: 'begin work',
      enter: true,
    });

    assert.equal(result.submissionConfirmed, true);
    assert.equal(test.executions.length, 1, 'must not send Enter into the permission prompt');
    assert.equal(test.audit.at(-1).confirmation, 'submitted');
  });

  it('keeps startup confirmation pending while awaiting observed progress', async () => {
    const test = harness({ progressTimeoutMs: 20 });
    test.setExecute(async () => {
      test.observe({ fingerprint: 'pasted-only' });
    });
    const ticket = test.gate.submit(test.sessionId, {
      id: 'startup-pending-confirmation',
      operation: 'startup',
      text: 'begin work',
      enter: true,
    });
    await immediate();

    const awaiting = test.audit.find(
      (entry) => entry.transactionId === 'startup-pending-confirmation'
        && entry.state === 'awaiting_response',
    );
    assert.equal(awaiting.confirmation, 'pending');
    await ticket.completion;
  });

  it('does not treat pane paste as progress for agent-bus messages', async () => {
    const test = harness({ progressTimeoutMs: 20 });
    test.setExecute(async () => {
      test.observe({ fingerprint: 'pasted-only' });
    });
    const result = await test.gate.enqueue(test.sessionId, {
      id: 'bus-pending-confirmation',
      source: 'agent_bus',
      operation: 'message',
      text: 'room ping',
      enter: true,
    });
    assert.equal(result.submissionConfirmed, false);
    assert.equal(test.audit.at(-1).confirmation, 'unconfirmed');
  });

  it('fails open a startup send when the deadline expires while running', async () => {
    const test = harness();
    test.observeTranscript('working');
    const ticket = test.gate.submit(test.sessionId, {
      id: 'startup-deadline',
      operation: 'startup',
      text: 'hello',
      deadlineAt: 103,
      resolveOnAwaiting: true,
    });
    assert.equal((await ticket.accepted).state, 'queued');
    assert.equal(test.executions.length, 0);
    test.observeTranscript('working');
    const result = await ticket.completion;
    assert.equal(result.state, 'awaiting_response');
    assert.equal(test.executions.length, 1);
    assert.equal(test.executions[0].operation, 'startup');
  });

  it('fails open on scraped working and verifies after send', async () => {
    const test = harness();
    test.observe({ execution: 'working', interaction: 'none', fingerprint: 'pane-working' });
    const result = await test.gate.enqueue(test.sessionId, {
      id: 'pane-working-send',
      operation: 'message',
      text: 'send anyway',
      resolveOnAwaiting: true,
    });
    assert.equal(result.state, 'awaiting_response');
    assert.equal(test.executions.length, 1);
  });

  it('waits while a transcript reports working', async () => {
    const test = harness();
    test.observeTranscript('working');
    test.setExecute(async () => {
      test.observe({ execution: 'working', interaction: 'none', fingerprint: 'working-after-send' });
    });
    const ticket = test.gate.submit(test.sessionId, {
      id: 'transcript-busy',
      operation: 'message',
      text: 'wait for terminal',
    });
    assert.equal((await ticket.accepted).state, 'queued');
    await immediate();
    assert.equal(test.executions.length, 0);

    test.observeTranscript('idle');
    await ticket.completion;
    assert.equal(test.executions.length, 1);
  });

  it('lets an explicitly allowed message use the provider active-input queue', async () => {
    const test = harness();
    test.observe({ execution: 'working', interaction: 'none', fingerprint: 'working-composer' });
    test.setExecute(async () => {});

    const result = await test.gate.enqueue(test.sessionId, {
      id: 'provider-queued-message',
      operation: 'message',
      text: 'send while active',
      allowActiveQueue: true,
      resolveOnAwaiting: true,
    });

    assert.equal(result.state, 'awaiting_response');
    assert.deepEqual(test.executions.map((entry) => entry.text), ['send while active']);
    assert.deepEqual(statesFor(test.audit, 'provider-queued-message'), ['queued', 'sending', 'awaiting_response']);
  });

  it('lets an allowed active-queue message through while a transcript reports working', async () => {
    const test = harness();
    test.observe({ execution: 'working', interaction: 'none', fingerprint: 'working-composer' });
    test.observeTranscript('working');

    const result = await test.gate.enqueue(test.sessionId, {
      id: 'steer-mid-turn',
      source: 'agent_bus',
      operation: 'message',
      text: 'room message',
      allowActiveQueue: true,
      resolveOnAwaiting: true,
    });

    assert.equal(result.state, 'awaiting_response');
    assert.deepEqual(test.executions.map((entry) => entry.text), ['room message']);
  });

  it('sends Codex and Claude room messages into a working turn; Pi waits for idle', async () => {
    for (const [provider, sent] of [['codex', true], ['claude', true], ['pi', false]]) {
      const test = harness();
      test.observe({ execution: 'working', interaction: 'none', fingerprint: 'working-composer' });
      test.observeTranscript('working');
      const ticket = test.gate.submit(test.sessionId, {
        id: `${provider}-room`,
        source: 'agent_bus',
        operation: 'message',
        text: 'room message',
        allowActiveQueue: allowsActiveQueue('agent_bus', provider),
        resolveOnAwaiting: true,
      });
      await ticket.accepted;
      await immediate();
      assert.equal(test.executions.length, sent ? 1 : 0, provider);
      test.observeTranscript('idle');
      await ticket.completion;
      assert.deepEqual(test.executions.map((entry) => entry.text), ['room message'], provider);
    }
  });

  it('holds an allowed Telegram answer while a transcript reports working', async () => {
    const test = harness();
    test.observe({ execution: 'working', interaction: 'none', fingerprint: 'working-composer' });
    test.observeTranscript('working');
    const ticket = test.gate.submit(test.sessionId, {
      id: 'telegram-mid-turn',
      source: 'telegram_answer',
      operation: 'message',
      text: 'operator answer',
      allowActiveQueue: true,
    });
    assert.equal((await ticket.accepted).state, 'queued');
    await immediate();
    assert.equal(test.executions.length, 0);

    test.observeTranscript('idle');
    await ticket.completion;
    assert.deepEqual(test.executions.map((entry) => entry.text), ['operator answer']);
  });

  it('does not execute when the deadline expires during the final pre-send refresh', async () => {
    let refreshCount = 0;
    const test = harness({
      refresh({ observe, tracker, sessionId }) {
        refreshCount += 1;
        if (refreshCount === 3) return observe();
        return tracker.get(sessionId);
      },
    });

    await assert.rejects(
      test.gate.enqueue(test.sessionId, {
        id: 'expired-before-execute',
        source: 'agent_bus',
        text: 'stale input',
        deadlineAt: 102,
      }),
      (error) => error?.code === 'command_deadline_expired',
    );

    assert.equal(test.executions.length, 0);
    assert.deepEqual(statesFor(test.audit, 'expired-before-execute'), ['queued', 'sending', 'failed']);
  });

  it('serializes concurrent senders FIFO and records one transition trail each', async () => {
    const test = harness();
    test.setExecute(async (operation) => {
      test.observe({ execution: 'working', interaction: 'none', fingerprint: `working-${operation.text}` });
      if (operation.text === 'one') {
        setImmediate(() => test.observe({ fingerprint: 'prompt-2' }));
      }
    });

    const first = test.gate.enqueue(test.sessionId, {
      id: 'first', source: 'agent_bus', text: 'one', operation: 'message',
    });
    const second = test.gate.enqueue(test.sessionId, {
      id: 'second', source: 'telegram', text: 'two', operation: 'message',
    });

    const results = await Promise.all([first, second]);
    assert.deepEqual(test.executions.map((entry) => entry.text), ['one', 'two']);
    assert.deepEqual(results.map((entry) => entry.transactionId), ['first', 'second']);
    assert.deepEqual(statesFor(test.audit, 'first'), ['queued', 'sending', 'awaiting_response', 'completed']);
    assert.deepEqual(statesFor(test.audit, 'second'), ['queued', 'sending', 'awaiting_response', 'completed']);
    assert.equal(test.audit.find((entry) => entry.transactionId === 'first').text, 'one');
    assert.equal(test.audit.find((entry) => entry.transactionId === 'first').enter, true);
  });

  it('coalesces identical queued text while the session is unsafe', async () => {
    const test = harness();
    test.observe({ interaction: 'unknown_blocking', fingerprint: 'unsafe' });
    test.setExecute(async () => {
      test.observe({ execution: 'working', interaction: 'none', fingerprint: 'working' });
    });

    const first = test.gate.enqueue(test.sessionId, { text: 'retry me' });
    const second = test.gate.enqueue(test.sessionId, { text: 'retry me' });
    await immediate();
    assert.equal(test.executions.length, 0);
    assert.equal(test.gate.inspect(test.sessionId).queued.length, 1);

    test.observe({ fingerprint: 'safe' });
    const results = await Promise.all([first, second]);
    assert.equal(results[0].transactionId, results[1].transactionId);
    assert.equal(test.executions.length, 1);
  });

  it('keeps different queued text as separate FIFO transactions', async () => {
    const test = harness();
    test.observe({ interaction: 'unknown_blocking', fingerprint: 'unsafe' });
    test.setExecute(async (operation) => {
      test.observe({ execution: 'working', interaction: 'none', fingerprint: `working-${operation.text}` });
      setImmediate(() => test.observe({ fingerprint: `safe-after-${operation.text}` }));
    });

    const first = test.gate.enqueue(test.sessionId, { text: 'one' });
    const second = test.gate.enqueue(test.sessionId, { text: 'two' });
    assert.equal(test.gate.inspect(test.sessionId).queued.length, 2);

    test.observe({ fingerprint: 'safe' });
    const results = await Promise.all([first, second]);
    assert.notEqual(results[0].transactionId, results[1].transactionId);
    assert.deepEqual(test.executions.map((entry) => entry.text), ['one', 'two']);
  });

  it('allows identical text again after the matching entry completes', async () => {
    const test = harness();
    test.setExecute(async (operation) => {
      test.observe({ execution: 'working', interaction: 'none', fingerprint: `working-${operation.transactionId}` });
    });

    const first = await test.gate.enqueue(test.sessionId, { text: 'repeat later' });
    await immediate();
    test.observe({ fingerprint: 'safe-again' });
    const second = await test.gate.enqueue(test.sessionId, { text: 'repeat later' });

    assert.notEqual(first.transactionId, second.transactionId);
    assert.equal(test.executions.length, 2);
  });

  it('rejects all coalesced callers when the session unregisters', async () => {
    const test = harness();
    test.observe({ interaction: 'unknown_blocking', fingerprint: 'unsafe' });

    const first = test.gate.enqueue(test.sessionId, { text: 'shared failure' });
    const second = test.gate.enqueue(test.sessionId, { text: 'shared failure' });
    await immediate();
    test.gate.unregister(test.sessionId);

    await assert.rejects(first, { code: 'command_gate_unregistered' });
    await assert.rejects(second, { code: 'command_gate_unregistered' });
    assert.equal(test.executions.length, 0);
  });

  it('never coalesces identical key or dialog policy operations', async () => {
    const test = harness();
    test.observe({ interaction: 'unknown_blocking', fingerprint: 'unsafe' });

    const firstKey = test.gate.enqueue(test.sessionId, {
      operation: 'terminal_keys', text: 'same payload', keys: ['BTab'],
    });
    const secondKey = test.gate.enqueue(test.sessionId, {
      operation: 'terminal_keys', text: 'same payload', keys: ['BTab'],
    });
    const firstDialog = test.gate.ensureDialogPolicy(test.sessionId, { text: 'same payload' });
    const secondDialog = test.gate.ensureDialogPolicy(test.sessionId, { text: 'same payload' });
    assert.equal(test.gate.inspect(test.sessionId).queued.length, 4);

    test.observe({ fingerprint: 'safe' });
    const results = await Promise.all([firstKey, secondKey, firstDialog, secondDialog]);
    assert.equal(new Set(results.map((result) => result.transactionId)).size, 4);
    assert.equal(test.executions.length, 2);
  });

  it('rechecks revision and fingerprint, resolves a raced guardrail with option 2, then sends', async () => {
    let refreshCount = 0;
    const test = harness({
      refresh({ observe, tracker, sessionId }) {
        refreshCount += 1;
        if (refreshCount === 2) {
          return observe({
            interaction: 'guardrail',
            fingerprint: 'guardrail-risky-1',
            detail: 'Risky prompt',
            options: [
              { key: '1', label: 'Downgrade model and continue' },
              { key: '2', label: 'Wait for verification' },
            ],
          });
        }
        return tracker.get(sessionId);
      },
    });
    test.setExecute(async (operation) => {
      if (operation.type === 'dialog') {
        assert.equal(operation.interactionKind, 'guardrail');
        assert.equal(operation.option, 2);
        assert.deepEqual(operation.keys, ['Down', 'Enter']);
        test.observe({ fingerprint: 'prompt-after-verification' });
        return;
      }
      test.observe({ execution: 'working', interaction: 'none', fingerprint: 'working-normal' });
    });

    await test.gate.enqueue(test.sessionId, { id: 'normal', source: 'monitor', text: 'do work' });

    assert.deepEqual(test.executions.map((entry) => entry.type), ['dialog', 'message']);
    assert.equal(test.executions[1].expectedFingerprint, 'prompt-after-verification');
    assert.deepEqual(
      statesFor(test.audit, 'dialog_guardrail-risky-1'),
      ['queued', 'sending', 'awaiting_response', 'completed'],
    );
    assert.deepEqual(
      statesFor(test.audit, 'normal'),
      ['queued', 'sending', 'awaiting_response', 'completed'],
    );
  });

  it('applies a guardrail fingerprint once while concurrent policy checks wait for it to clear', async () => {
    const test = harness();
    test.observe({ interaction: 'guardrail', fingerprint: 'guardrail-once' });
    let dialogExecutions = 0;
    let markDialogExecuted;
    let releaseDialog;
    const dialogExecuted = new Promise((resolve) => { markDialogExecuted = resolve; });
    const dialogReleased = new Promise((resolve) => { releaseDialog = resolve; });
    test.setExecute(async (operation) => {
      assert.equal(operation.type, 'dialog');
      dialogExecutions += 1;
      markDialogExecuted();
      await dialogReleased;
    });

    const first = test.gate.ensureDialogPolicy(test.sessionId, { id: 'policy-one' });
    const second = test.gate.ensureDialogPolicy(test.sessionId, { id: 'policy-two' });
    await dialogExecuted;
    test.observe({ fingerprint: 'prompt-cleared' });
    releaseDialog();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(dialogExecutions, 1);
    assert.equal(firstResult.handled, true);
    assert.equal(secondResult.skipped, true);
    assert.deepEqual(statesFor(test.audit, 'policy-one'), ['queued', 'sending', 'awaiting_response', 'completed']);
    assert.deepEqual(statesFor(test.audit, 'policy-two'), ['queued', 'completed']);
  });

  it('selects trust option 1 with Enter and waits for the fingerprint to clear', async () => {
    const test = harness();
    test.observe({ interaction: 'trust', fingerprint: 'trust-workdir-1' });
    test.setExecute(async (operation) => {
      assert.equal(operation.interactionKind, 'trust');
      assert.equal(operation.option, 1);
      assert.deepEqual(operation.keys, ['Enter']);
      test.observe({ fingerprint: 'trusted-prompt' });
    });

    const result = await test.gate.ensureDialogPolicy(test.sessionId, { id: 'trust-policy' });
    assert.equal(result.handled, true);
    assert.deepEqual(statesFor(test.audit, 'trust-policy'), ['queued', 'sending', 'awaiting_response', 'completed']);
  });

  it('presses Enter for a Codex update and waits for the update prompt to clear', async () => {
    const test = harness();
    test.observe({ interaction: 'update', fingerprint: 'codex-update-1' });
    test.setExecute(async (operation) => {
      assert.equal(operation.interactionKind, 'update');
      assert.deepEqual(operation.keys, ['Enter']);
      test.observe({ lifecycle: 'missing', interaction: 'none', fingerprint: '' });
    });

    const result = await test.gate.ensureDialogPolicy(test.sessionId, { id: 'update-policy' });

    assert.equal(result.handled, true);
    assert.deepEqual(statesFor(test.audit, 'update-policy'), ['queued', 'sending', 'awaiting_response', 'completed']);
  });

  it('holds unknown blockers without typing and resumes when canonical capability becomes safe', async () => {
    const test = harness();
    test.observe({ interaction: 'unknown_blocking', fingerprint: 'unknown-screen' });
    test.setExecute(async () => {
      test.observe({ execution: 'working', interaction: 'none', fingerprint: 'working-after-hold' });
    });

    const pending = test.gate.enqueue(test.sessionId, { id: 'held', text: 'safe later' });
    await immediate();
    await immediate();
    assert.equal(test.executions.length, 0);

    test.observe({ fingerprint: 'safe-prompt' });
    await pending;
    assert.equal(test.executions.length, 1);
    assert.deepEqual(statesFor(test.audit, 'held'), ['queued', 'sending', 'awaiting_response', 'completed']);
  });

  it('audits execute failure and continues draining the same session queue', async () => {
    const test = harness();
    test.setExecute(async (operation) => {
      if (operation.text === 'fail') throw Object.assign(new Error('paste failed'), { code: 'paste_failed' });
      test.observe({ execution: 'working', interaction: 'none', fingerprint: 'working-after-retry' });
    });

    const failed = test.gate.enqueue(test.sessionId, { id: 'bad', text: 'fail' });
    const succeeding = test.gate.enqueue(test.sessionId, { id: 'good', text: 'continue' });
    await assert.rejects(failed, /paste failed/);
    await succeeding;

    assert.deepEqual(test.executions.map((entry) => entry.text), ['fail', 'continue']);
    assert.deepEqual(statesFor(test.audit, 'bad'), ['queued', 'sending', 'failed']);
    assert.deepEqual(statesFor(test.audit, 'good'), ['queued', 'sending', 'awaiting_response', 'completed']);
  });

  it('binds typed text and dialog key operations to one tmux target', async () => {
    const calls = [];
    const execFn = async (command, args, opts) => {
      calls.push({ command, args, opts });
      return { code: 0, stdout: '', stderr: '' };
    };
    const execute = createTmuxCommandExecutor({
      execFn,
      target: 'codex-command-gate',
      delayMs: 0,
      dialogKeyDelayMs: 0,
      bufferPrefix: 'test-gate',
    });

    await execute({ type: 'message', text: 'literal $() text', enter: true });
    await execute({ type: 'dialog', keys: ['Down', 'Enter'] });

    assert.deepEqual(calls.map((call) => call.args[0]), [
      'load-buffer',
      'paste-buffer',
      'send-keys',
      'send-keys',
      'send-keys',
    ]);
    assert.equal(calls[0].opts.input, 'literal $() text');
    assert.deepEqual(calls[3].args, ['send-keys', '-t', 'codex-command-gate', '--', 'Down']);
    assert.deepEqual(calls[4].args, ['send-keys', '-t', 'codex-command-gate', '--', 'Enter']);
  });

  it('uses the longer submit delay for startup prompts', async () => {
    const delays = [];
    const execute = createTmuxCommandExecutor({
      execFn: async () => ({ code: 0, stdout: '', stderr: '' }),
      target: 'codex-startup-delay',
      delayMs: 180,
      startupDelayMs: 500,
      sleepFn: async (ms) => { delays.push(ms); },
    });

    await execute({ operation: 'startup', text: 'Start now', enter: true });

    assert.deepEqual(delays, [500]);
  });

  it('answers only the exact typed blocking interaction fingerprint and kind', async () => {
    const test = harness();
    const blocked = test.observe({ interaction: 'permission', fingerprint: 'permission-1' });
    test.setExecute(async () => test.observe({ fingerprint: 'prompt-after-answer' }));

    const result = await test.gate.enqueue(test.sessionId, {
      id: 'answer',
      operation: 'interaction',
      text: 'yes',
      expectedRevision: blocked.revision,
      expectedFingerprint: blocked.interaction.fingerprint,
      expectedInteractionKind: 'permission',
    });

    assert.equal(result.state, 'completed');
    assert.equal(test.executions[0].type, 'dialog_answer');
    assert.deepEqual(statesFor(test.audit, 'answer'), ['queued', 'sending', 'awaiting_response', 'completed']);

    await assert.rejects(test.gate.enqueue(test.sessionId, {
      id: 'stale-answer',
      operation: 'interaction',
      text: 'yes',
      expectedRevision: blocked.revision,
      expectedFingerprint: blocked.interaction.fingerprint,
      expectedInteractionKind: 'permission',
    }), { code: 'interaction_changed' });
    assert.equal(test.executions.length, 1);
  });

  it('does not hold the queue waiting for an unknown screen to clear after Enter', async () => {
    const test = harness();
    const menu = test.observe({
      interaction: 'unknown_blocking',
      fingerprint: 'interaction:unknown-menu',
      stable: true,
      detail: 'Unknown session screen',
    });
    const guards = {
      expectedRevision: menu.revision,
      expectedFingerprint: menu.interaction.fingerprint,
      expectedInteractionKind: 'unknown_blocking',
    };

    // Enter toggles a value; the menu and its constant fingerprint stay put.
    const toggled = await test.gate.enqueue(test.sessionId, { id: 'toggle', operation: 'interaction', keys: ['Enter'], ...guards });
    assert.equal(toggled.state, 'completed');
    assert.deepEqual(statesFor(test.audit, 'toggle'), ['queued', 'sending', 'completed']);

    test.setExecute(async () => test.observe({ fingerprint: 'prompt-after-escape' }));
    const escaped = await test.gate.enqueue(test.sessionId, { id: 'escape', operation: 'interaction', keys: ['Escape'], ...guards });
    assert.equal(escaped.state, 'completed');
    assert.deepEqual(test.executions.map((operation) => operation.keys), [['Enter'], ['Escape']]);
    assert.equal(test.tracker.get(test.sessionId).interaction.kind, 'free_text');
  });

  it('answers when unrelated canonical state revisions change but the interaction stays exact', async () => {
    let refreshCount = 0;
    const test = harness({
      refresh: ({ observe, executions }) => {
        refreshCount += 1;
        if (executions.length > 0) {
          return { canonicalState: observe({ fingerprint: 'prompt-after-answer' }) };
        }
        return {
          canonicalState: observe({
            interaction: 'selection',
            fingerprint: 'same-selection',
            execution: refreshCount % 2 ? 'idle' : 'unknown',
          }),
        };
      },
    });
    const blocked = test.observe({ interaction: 'selection', fingerprint: 'same-selection' });
    test.setExecute(async () => {});

    const result = await test.gate.enqueue(test.sessionId, {
      id: 'answer-after-unrelated-revision',
      operation: 'interaction',
      keys: ['2'],
      expectedRevision: blocked.revision,
      expectedFingerprint: blocked.interaction.fingerprint,
      expectedInteractionKind: 'selection',
    });

    assert.equal(result.state, 'completed');
    assert.equal(test.executions.length, 1);
  });

  it('lets a matching typed interaction preempt a command waiting on that blocker', async () => {
    const test = harness();
    const blocked = test.observe({
      interaction: 'selection',
      fingerprint: 'codex-update-choice',
      options: [
        { key: '1', label: 'Update' },
        { key: '2', label: 'Continue' },
        { key: '3', label: 'Exit' },
      ],
    });
    test.setExecute(async (operation) => {
      if (operation.operation === 'interaction') {
        return;
      }
      test.observe({ execution: 'working', interaction: 'none', fingerprint: 'working-after-startup' });
    });

    const startup = test.gate.enqueue(test.sessionId, {
      id: 'startup', operation: 'startup', text: 'begin work',
    });
    await immediate();
    assert.equal(test.executions.length, 0);
    assert.equal(test.gate.inspect(test.sessionId).queued[0].lane, 'payload');

    const choice = test.gate.enqueue(test.sessionId, {
      id: 'choice',
      operation: 'interaction',
      keys: ['2'],
      expectedRevision: blocked.revision,
      expectedFingerprint: blocked.interaction.fingerprint,
      expectedInteractionKind: 'selection',
    });
    assert.equal(test.gate.inspect(test.sessionId).queued[1].lane, 'control');
    const choiceResult = await choice;
    test.observe({ fingerprint: 'prompt-after-choice' });
    const startupResult = await startup;

    assert.deepEqual(test.executions.map((entry) => entry.transactionId), ['choice', 'startup']);
    assert.equal(choiceResult.transactionId, 'choice');
    assert.equal(startupResult.transactionId, 'startup');
    assert.deepEqual(statesFor(test.audit, 'choice'), ['queued', 'sending', 'completed']);
  });

  it('sends dialog navigation immediately without waiting for the dialog to clear', async () => {
    const test = harness();
    const blocked = test.observe({ interaction: 'selection', fingerprint: 'selection-nav' });
    test.setExecute(async () => test.observe({ interaction: 'selection', fingerprint: 'selection-nav' }));

    const result = await test.gate.enqueue(test.sessionId, {
      id: 'navigate-selection',
      operation: 'interaction',
      keys: ['Down'],
      expectedRevision: blocked.revision,
      expectedFingerprint: blocked.interaction.fingerprint,
      expectedInteractionKind: 'selection',
    });

    assert.equal(result.state, 'completed');
    assert.deepEqual(test.executions[0].keys, ['Down']);
    assert.deepEqual(statesFor(test.audit, 'navigate-selection'), ['queued', 'sending', 'completed']);
  });

  it('completes an answer when the next dialog has the same kind but a new fingerprint', async () => {
    const test = harness();
    const blocked = test.observe({ interaction: 'selection', fingerprint: 'selection-step-1' });
    test.setExecute(async () => test.observe({ interaction: 'selection', fingerprint: 'selection-step-2' }));

    const result = await test.gate.enqueue(test.sessionId, {
      id: 'advance-selection-wizard',
      operation: 'interaction',
      keys: ['Enter'],
      expectedRevision: blocked.revision,
      expectedFingerprint: blocked.interaction.fingerprint,
      expectedInteractionKind: 'selection',
    });

    assert.equal(result.state, 'completed');
    assert.equal(result.snapshot.interaction.fingerprint, 'selection-step-2');
    assert.deepEqual(statesFor(test.audit, 'advance-selection-wizard'), [
      'queued', 'sending', 'awaiting_response', 'completed',
    ]);
  });

  it('rejects numeric guardrail answers so only option-2 arrow policy can act', async () => {
    const test = harness();
    const blocked = test.observe({ interaction: 'guardrail', fingerprint: 'guardrail-typed' });

    await assert.rejects(test.gate.enqueue(test.sessionId, {
      id: 'numeric-guardrail',
      operation: 'interaction',
      text: '2',
      expectedRevision: blocked.revision,
      expectedFingerprint: blocked.interaction.fingerprint,
      expectedInteractionKind: 'guardrail',
    }), { code: 'policy_controlled_interaction' });
    assert.equal(test.executions.length, 0);
  });

  it('acknowledges submission while holding the FIFO until pane progress', async () => {
    const test = harness();
    test.setExecute(async () => {
      test.observe({
        fingerprint: 'echo-only',
        content: 'ready prompt\n› Proceed\n› ',
      });
    });

    const result = await test.gate.enqueue(test.sessionId, {
      id: 'echo', text: 'Proceed', resolveOnAwaiting: true,
    });
    assert.equal(result.state, 'awaiting_response');
    assert.deepEqual(statesFor(test.audit, 'echo'), ['queued', 'sending', 'awaiting_response']);
    assert.equal(test.audit.at(-1).confirmation, 'submitted');

    const second = test.gate.enqueue(test.sessionId, {
      id: 'second', text: 'Later', resolveOnAwaiting: true,
    });
    await immediate();
    assert.deepEqual(test.executions.map((entry) => entry.text), ['Proceed']);

    test.observe({ execution: 'working', interaction: 'none', fingerprint: 'working' });
    while (statesFor(test.audit, 'echo').at(-1) !== 'completed') await immediate();
    test.observe({ fingerprint: 'ready-next' });
    await second;
    assert.deepEqual(test.executions.map((entry) => entry.text), ['Proceed', 'Later']);
  });

  it('completes non-submit terminal text and key operations without holding the FIFO', async () => {
    const test = harness();
    const typed = await test.gate.enqueue(test.sessionId, {
      id: 'typed', operation: 'terminal_text', text: 'x', enter: false,
    });
    const keyed = await test.gate.enqueue(test.sessionId, {
      id: 'keyed', operation: 'terminal_keys', keys: ['BTab'],
    });

    assert.equal(typed.state, 'completed');
    assert.equal(keyed.state, 'completed');
    assert.deepEqual(statesFor(test.audit, 'typed'), ['queued', 'sending', 'completed']);
    assert.deepEqual(statesFor(test.audit, 'keyed'), ['queued', 'sending', 'completed']);
    assert.deepEqual(test.executions.map((entry) => entry.type), ['terminal_text', 'dialog']);
  });

  it('retains a queued command across transient observation failure', async () => {
    let failedOnce = false;
    const test = harness({
      refresh({ tracker, sessionId }) {
        if (!failedOnce) {
          failedOnce = true;
          throw Object.assign(new Error('tmux socket busy'), {
            code: 'session_observation_unavailable', transient: true,
          });
        }
        return tracker.get(sessionId);
      },
    });
    test.setExecute(async () => test.observe({ execution: 'working', interaction: 'none', fingerprint: 'working' }));

    await test.gate.enqueue(test.sessionId, { id: 'transient', text: 'safe' });
    assert.equal(test.executions.length, 1);
    assert.deepEqual(statesFor(test.audit, 'transient'), ['queued', 'sending', 'awaiting_response', 'completed']);
  });

  it('fails without typing when the observed session is terminal', async () => {
    const test = harness({
      refresh() {
        throw Object.assign(new Error('session missing'), { code: 'session_missing' });
      },
    });

    await assert.rejects(test.gate.enqueue(test.sessionId, { id: 'missing', text: 'unsafe' }), {
      code: 'session_missing',
    });
    assert.equal(test.executions.length, 0);
    assert.deepEqual(statesFor(test.audit, 'missing'), ['queued', 'failed']);
  });

  it('fails open waitForResponseProgress when deadlineAt is missing', async () => {
    const test = harness({ progressTimeoutMs: 15 });
    test.setExecute(async () => {
      test.observe({
        fingerprint: 'echo-only',
        content: 'ready prompt\n› Proceed\n› ',
      });
    });

    const first = await test.gate.enqueue(test.sessionId, {
      id: 'no-deadline', text: 'Proceed', resolveOnAwaiting: true,
    });
    assert.equal(first.state, 'awaiting_response');
    const second = await test.gate.enqueue(test.sessionId, {
      id: 'next', text: 'Later', resolveOnAwaiting: true,
    });
    assert.equal(second.state, 'awaiting_response');
    assert.deepEqual(test.executions.map((entry) => entry.text), ['Proceed', 'Later']);
    while (!statesFor(test.audit, 'no-deadline').includes('completed')) await immediate();
    assert.ok(!statesFor(test.audit, 'no-deadline').includes('failed'));
  });

  it('does not fail a submitted send when post-send progress never arrives', async () => {
    const test = harness({ progressTimeoutMs: 15 });
    test.setExecute(async () => {});

    const result = await test.gate.enqueue(test.sessionId, {
      id: 'sent-unacked',
      text: 'hello',
      deadlineAt: 10_000,
      resolveOnAwaiting: true,
    });
    assert.equal(result.state, 'awaiting_response');
    assert.equal(test.executions.length, 1);
    while (!statesFor(test.audit, 'sent-unacked').includes('completed')) await immediate();
    assert.ok(!statesFor(test.audit, 'sent-unacked').includes('failed'));
  });

  it('does not send on stale process running after lifecycle evidence expires', async () => {
    let ticks = 0;
    const test = harness({
      refresh({ tracker, sessionId }) {
        ticks += 1;
        if (ticks > 1) test.advance(40);
        return tracker.get(sessionId);
      },
    });
    test.observe({ expiresAt: 130 });
    test.advance(20);

    await assert.rejects(
      test.gate.enqueue(test.sessionId, {
        id: 'stale-running',
        text: 'too late',
        deadlineAt: 200,
      }),
      (error) => error?.code === 'command_deadline_expired',
    );
    assert.equal(test.executions.length, 0);
  });

  it('clears an expired awaiting_response observation so the next enqueue can send', async () => {
    const test = harness();
    test.tracker.observe(test.sessionId, [{
      source: 'delivery',
      kind: 'command_gate',
      value: { state: 'awaiting_response', transactionId: 'old' },
      observedAt: 100,
      expiresAt: 110,
      fingerprint: 'delivery:old',
    }]);
    test.advance(20);
    assert.notEqual(test.tracker.get(test.sessionId).status, 'awaiting_response');

    const result = await test.gate.enqueue(test.sessionId, {
      id: 'after-ttl', text: 'next', resolveOnAwaiting: true,
    });
    assert.equal(result.state, 'awaiting_response');
    assert.equal(test.executions.length, 1);
  });
});
