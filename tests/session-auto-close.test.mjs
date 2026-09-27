import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialSnapshot } from '../modules/session-state/contract.mjs';
import { reduce } from '../modules/session-state/reducer.mjs';
import {
  latestFreshPaneExecution,
  nextTranscriptIdleSince,
  shouldAutoCloseSession,
} from '../modules/sessions/auto-close.mjs';

function observation(source, kind, value, {
  observedAt = 100,
  expiresAt = 0,
  fingerprint = `${source}:${kind}`,
} = {}) {
  return { source, kind, value, observedAt, expiresAt, fingerprint };
}

describe('auto-close decision', () => {
  it('does not close a scraped ready session', () => {
    const snapshot = reduce(createInitialSnapshot('scraped-ready'), [
      observation('process', 'lifecycle', { lifecycle: 'running' }),
      observation('pane', 'interaction', { kind: 'free_text', stable: true }, { fingerprint: 'prompt' }),
      observation('pane', 'execution', { execution: 'idle' }),
    ], 100);
    assert.equal(snapshot.status, 'ready');
    assert.equal(snapshot.capabilities.sendMessage, true);
    assert.equal(snapshot.capabilities.autoClose, false);
    assert.equal(snapshot.executionSource, 'pane');
    assert.deepEqual(shouldAutoCloseSession({
      autoCloseMode: 'when_waiting_for_input',
      autoCloseAfterMs: 0,
      now: 100,
      idleSince: 100,
      execution: snapshot.execution,
      executionSource: snapshot.executionSource,
      lifecycle: snapshot.lifecycle,
    }), { close: false, reason: '' });
  });

  it('closes when the process is gone', () => {
    const snapshot = reduce(createInitialSnapshot('gone'), [
      observation('process', 'lifecycle', { lifecycle: 'missing' }),
    ], 100);
    assert.equal(snapshot.capabilities.autoClose, true);
    assert.deepEqual(shouldAutoCloseSession({
      autoCloseMode: 'on_exit',
      now: 100,
      execution: snapshot.execution,
      executionSource: snapshot.executionSource,
      lifecycle: snapshot.lifecycle,
    }), { close: true, reason: 'process_gone' });
  });

  it('closes on a transcript terminal record after the configured dwell', () => {
    assert.deepEqual(shouldAutoCloseSession({
      autoCloseMode: 'when_waiting_for_input',
      autoCloseAfterMs: 50,
      now: 160,
      idleSince: 100,
      execution: 'idle',
      executionSource: 'transcript',
      lifecycle: 'running',
      paneExecution: 'idle',
    }), { close: true, reason: 'transcript_terminal' });
  });

  it('does not kill on transcript terminal while the pane still shows working', () => {
    assert.deepEqual(shouldAutoCloseSession({
      autoCloseMode: 'when_waiting_for_input',
      autoCloseAfterMs: 0,
      now: 160,
      idleSince: 100,
      execution: 'idle',
      executionSource: 'transcript',
      lifecycle: 'running',
      paneExecution: 'working',
    }), { close: false, reason: '' });
  });

  it('does not close on hook or pane idle', () => {
    for (const executionSource of ['hook', 'pane', '']) {
      assert.equal(shouldAutoCloseSession({
        autoCloseMode: 'when_waiting_for_input',
        autoCloseAfterMs: 0,
        now: 100,
        idleSince: 100,
        execution: 'idle',
        executionSource,
        lifecycle: 'running',
      }).close, false, executionSource);
    }
  });

  it('latches the first transcript-idle timestamp and clears when the source changes', () => {
    assert.equal(nextTranscriptIdleSince({
      execution: 'idle',
      executionSource: 'transcript',
      previousIdleSince: 0,
      now: 50,
    }), 50);
    assert.equal(nextTranscriptIdleSince({
      execution: 'idle',
      executionSource: 'transcript',
      previousIdleSince: 50,
      now: 90,
    }), 50);
    assert.equal(nextTranscriptIdleSince({
      execution: 'working',
      executionSource: 'transcript',
      previousIdleSince: 50,
      now: 90,
    }), 0);
    assert.equal(nextTranscriptIdleSince({
      execution: 'idle',
      executionSource: 'pane',
      previousIdleSince: 50,
      now: 90,
    }), 0);
  });

  it('ignores expired pane working when choosing auto-close corroboration', () => {
    assert.equal(latestFreshPaneExecution([
      {
        source: 'pane',
        kind: 'execution',
        value: { execution: 'working' },
        observedAt: 100,
        expiresAt: 150,
      },
      {
        source: 'pane',
        kind: 'screen',
        value: { execution: 'idle' },
        observedAt: 140,
        expiresAt: 0,
      },
    ], 200), 'idle');
    assert.equal(latestFreshPaneExecution([
      {
        source: 'pane',
        kind: 'execution',
        value: { execution: 'working' },
        observedAt: 100,
        expiresAt: 150,
      },
    ], 200), '');
  });
});
