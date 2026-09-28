import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

globalThis.localStorage = makeLocalStorage();

const state = await import('../public/app/state.mjs');
const attention = await import('../public/app/attention.mjs');

function canonicalState(status, {
  kind = status === 'ready' ? 'free_text' : status === 'blocked' ? 'permission' : 'none',
  options = [],
  fingerprint = `${status}-fixture`,
  revision = 1,
  detail = '',
} = {}) {
  return {
    status,
    revision,
    reason: detail || status,
    capabilities: {
      canQueueMessage: status !== 'ended',
      canSendNow: status === 'ready',
      canAnswerInteraction: status === 'blocked' && !['guardrail', 'trust'].includes(kind),
      canInterrupt: ['working', 'thinking', 'awaiting_response'].includes(status),
      sendMessage: status === 'ready',
      needsAttention: status === 'blocked',
    },
    interaction: { kind, options, fingerprint, detail },
  };
}

describe('attention triage state', () => {
  beforeEach(() => {
    localStorage.clear();
    state.claudeSessions.value = [];
    state.codexSessions.value = [];
    state.deepseekSessions.value = [];
    state.agentThreads.value = [];
    state.agentBusAlerts.value = [];
    attention.updateNotificationPrefs({ sound: true, approvalOnly: false, mutedSessions: [] });
    attention.clearDismissedAttentionItems();
  });

  it('includes approval rows but ignores blocked bus rooms and idle ready sessions', () => {
    state.codexSessions.value = [{
      id: 'codex-1',
      name: 'codex prompt',
      state: canonicalState('ready'),
      created: 20,
    }];
    state.claudeSessions.value = [{
      id: 'claude-1',
      name: 'claude approval',
      state: canonicalState('blocked'),
      created: 30,
    }];
    state.agentThreads.value = [{
      id: 'thread-1',
      title: 'blocked thread',
      status: 'blocked',
      updatedAt: 10_000,
      participants: [],
    }];

    assert.deepEqual(attention.attentionItems.value.map((item) => `${item.type}:${item.sessionId}`), [
      'session:claude-1',
    ]);
  });

  it('queues DeepSeek sessions and labels a ready runtime mismatch with its reason', () => {
    const mismatch = { ...canonicalState('ready', { detail: 'Ready; effective runtime differs from requested runtime' }) };
    mismatch.capabilities = { ...mismatch.capabilities, needsAttention: true };
    state.deepseekSessions.value = [
      { id: 'ds-1', state: canonicalState('blocked', { detail: 'Run tests' }), created: 10 },
      { id: 'ds-2', state: mismatch, created: 20 },
    ];
    assert.deepEqual(attention.attentionItems.value.map(({ kind, route, statusLabel }) => [kind, route, statusLabel]), [
      ['deepseek', '/deepseek/ds-1', 'needs approval'],
      ['deepseek', '/deepseek/ds-2', 'Ready; effective runtime differs from requested runtime'],
    ]);
  });

  it('ignores legacy loop state and includes failed deliveries as the only bus attention', () => {
    state.agentThreads.value = [{
      id: 'thread-1',
      title: 'archived loop',
      status: 'open',
      metadata: { managerLoop: { status: 'blocked', error: 'old failure' } },
    }];

    assert.deepEqual(attention.attentionItems.value, []);

    state.agentBusAlerts.value = [{
      id: 'delivery_failed:del-1',
      type: 'delivery_failed',
      threadId: 'thread-1',
      deliveryId: 'del-1',
      error: 'session unavailable',
      createdAt: 12_000,
    }];

    assert.equal(attention.attentionItems.value.length, 1);
    assert.equal(attention.attentionItems.value[0].type, 'delivery');
    assert.equal(attention.attentionItems.value[0].snippet, 'session unavailable');
  });

  it('keeps approval and confirmation rows in approval-only mode', () => {
    state.claudeSessions.value = [{
      id: 'claude-1',
      state: canonicalState('blocked', { kind: 'permission' }),
    }, {
      id: 'claude-2',
      state: canonicalState('blocked', { kind: 'confirmation' }),
    }, {
      id: 'claude-3',
      state: canonicalState('ready'),
    }];

    assert.equal(attention.attentionBadgeCount.value, 2);
    attention.setApprovalOnlyEnabled(true);
    assert.equal(attention.attentionBadgeCount.value, 2);
    attention.setSessionMuted('claude', 'claude-1', true);
    assert.equal(attention.attentionBadgeCount.value, 1);
  });

  it('dismisses one attention generation without hiding the next one for the same session', () => {
    state.codexSessions.value = [{
      id: 'codex-1',
      state: canonicalState('blocked', { fingerprint: 'approval-a' }),
      attention: { key: 'approval-a', active: true },
    }];

    assert.equal(attention.attentionBadgeCount.value, 1);
    attention.dismissAttentionItem(attention.attentionItems.value[0].id);
    assert.equal(attention.visibleAttentionItems.value.length, 0);
    assert.equal(attention.attentionBadgeCount.value, 0);

    state.codexSessions.value = [{
      id: 'codex-1',
      state: canonicalState('blocked', { fingerprint: 'approval-b', revision: 2 }),
      attention: { key: 'approval-b', active: true },
    }];

    assert.equal(attention.visibleAttentionItems.value.length, 1);
    assert.equal(attention.attentionBadgeCount.value, 1);
  });

  it('uses only canonical interaction options and preserves transaction guards', () => {
    state.codexSessions.value = [{
      id: 'codex-1',
      state: canonicalState('blocked', {
        kind: 'permission',
        revision: 42,
        fingerprint: 'approval-a',
        detail: 'Approve command?',
        options: [
          { key: '1', label: 'Allow command' },
          { key: '2', label: 'Deny' },
        ],
      }),
      attention: {
        key: 'approval-a',
        active: true,
      },
    }];

    const item = attention.attentionItems.value[0];
    assert.deepEqual(item.answerOptions, [
      { key: '1', label: 'Allow command' },
      { key: '2', label: 'Deny' },
    ]);
    assert.equal(item.revision, 42);
    assert.equal(item.interactionFingerprint, 'approval-a');
  });
});
