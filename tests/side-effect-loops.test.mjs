import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldEnableTelegramBridge,
  shouldStartAgentBusMcpHttp,
  shouldSuppressSideEffectLoops,
} from '../modules/platform/side-effect-loops.mjs';

describe('side-effect loop suppression', () => {
  it('allows loops on the canonical service port', () => {
    assert.equal(shouldSuppressSideEffectLoops({ env: { PORT: '4310' } }), false);
  });

  it('suppresses loops away from the canonical service port', () => {
    assert.equal(shouldSuppressSideEffectLoops({ env: { PORT: '4510' } }), true);
  });

  it('suppresses loops for explicit test and disable flags', () => {
    assert.equal(shouldSuppressSideEffectLoops({ env: { PORT: '4310', DUENO_TEST_SERVER: '1' } }), true);
    assert.equal(shouldSuppressSideEffectLoops({ env: { PORT: '4310', DUENO_DISABLE_SIDE_EFFECTS: 'true' } }), true);
  });

  it('allows explicit side-effect override', () => {
    assert.equal(
      shouldSuppressSideEffectLoops({
        env: { PORT: '4510', DUENO_DISABLE_SIDE_EFFECTS: '1', DUENO_ALLOW_SIDE_EFFECTS: '1' },
      }),
      false
    );
  });
});

describe('Telegram bridge side-effect guard', () => {
  it('keeps the bridge disabled while side-effect loops are suppressed', () => {
    assert.equal(
      shouldEnableTelegramBridge({
        env: { TELEGRAM_BRIDGE: '1' },
        sideEffectLoopsSuppressed: true,
      }),
      false
    );
  });

  it('honors TELEGRAM_BRIDGE=0 when side-effect loops are allowed', () => {
    assert.equal(
      shouldEnableTelegramBridge({
        env: { TELEGRAM_BRIDGE: '0' },
        sideEffectLoopsSuppressed: false,
      }),
      false
    );
  });

  it('enables the bridge by default only when side-effect loops are allowed', () => {
    assert.equal(
      shouldEnableTelegramBridge({
        env: {},
        sideEffectLoopsSuppressed: false,
      }),
      true
    );
  });
});

describe('Agent Bus MCP HTTP side-effect guard', () => {
  it('keeps the MCP HTTP listener disabled while side-effect loops are suppressed', () => {
    assert.equal(
      shouldStartAgentBusMcpHttp({
        sideEffectLoopsSuppressed: true,
      }),
      false
    );
  });

  it('enables the MCP HTTP listener when side-effect loops are allowed', () => {
    assert.equal(
      shouldStartAgentBusMcpHttp({
        sideEffectLoopsSuppressed: false,
      }),
      true
    );
  });

  it('keeps the MCP HTTP listener disabled when suppression state is omitted', () => {
    assert.equal(shouldStartAgentBusMcpHttp(), false);
  });
});
