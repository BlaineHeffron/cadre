import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createInitialSnapshot } from '../modules/session-state/contract.mjs';
import { reduce } from '../modules/session-state/reducer.mjs';
import { observeClaudePane } from '../modules/session-state/providers/claude.mjs';
import { observeCodexPane } from '../modules/session-state/providers/codex.mjs';

const providers = {
  claude: observeClaudePane,
  codex: observeCodexPane,
  protocol(content, { observedAt, expiresAt }) {
    let execution = 'idle';
    let kind = 'free_text';
    if (/Working/.test(content)) { execution = 'working'; kind = 'none'; }
    else if (/allow this command/i.test(content)) { execution = 'unknown'; kind = 'permission'; }
    else if (/Choose how to continue/.test(content)) { kind = 'selection'; }
    else if (/Unrecognized full-screen state/.test(content)) { execution = 'unknown'; kind = 'unknown_blocking'; }
    const fingerprint = `protocol:${kind}`;
    return [
      { source: 'protocol', kind: 'lifecycle', value: { lifecycle: 'running' }, observedAt, expiresAt, fingerprint: 'protocol:running' },
      { source: 'protocol', kind: 'execution', value: { execution }, observedAt, expiresAt, fingerprint: `protocol:${execution}` },
      {
        source: 'protocol', kind: 'interaction',
        value: { kind, stable: kind === 'free_text', detail: kind === 'permission' ? 'Permission required' : '', options: kind === 'permission' ? [{ optionId: 'allow_once' }] : [] },
        observedAt, expiresAt, fingerprint,
      },
    ];
  },
};

function running() {
  return {
    source: 'process',
    kind: 'lifecycle',
    value: { lifecycle: 'running' },
    observedAt: 100,
    expiresAt: 0,
    fingerprint: 'process:running',
  };
}

function pane(provider, content) {
  return providers[provider](content, { observedAt: 100, expiresAt: 0 });
}

function state(provider, name, content) {
  return reduce(createInitialSnapshot(`${provider}-${name}`), [running(), ...pane(provider, content)], 100);
}

describe('provider session-state invariant matrix', () => {
  for (const provider of Object.keys(providers)) {
    it(`${provider} derives the same action contract`, () => {
      const prompt = provider === 'claude' ? '❯ ' : '› ';
      const footer = provider === 'claude'
        ? [
            '────────────────────────',
            '⏵⏵ bypass permissions on (shift+tab to cycle)',
            'new task? /clear to save 435.8k tokens',
          ]
        : [
            '────────────────────────',
            'gpt-5.4 medium · 72% left · ~/project',
          ];
      const cases = [
        {
          name: 'ready-minimal',
          content: `Work complete\n${prompt}`,
          expected: ['idle', 'free_text', 'ready', true, true, false, false],
        },
        {
          name: 'ready-expanded-footer',
          content: ['Work complete', prompt, ...footer, ...footer].join('\n'),
          expected: ['idle', 'free_text', 'ready', true, true, false, false],
        },
        {
          name: 'working',
          content: `tab to queue message\n• Working (14s • esc to interrupt)\n${prompt}`,
          expected: ['working', 'none', 'working', true, false, false, true],
        },
        {
          name: 'permission',
          content: 'Tool wants to run Bash\nDo you want to allow this command?\nAllow once',
          expected: ['unknown', 'permission', 'blocked', true, false, true, false],
        },
        {
          name: 'selection',
          content: 'Choose how to continue\n❯ 1. Update\n  2. Continue\n  3. Exit',
          expected: ['idle', 'selection', 'blocked', true, false, true, false],
        },
        {
          name: 'unknown',
          content: 'Unrecognized full-screen state',
          expected: ['unknown', 'unknown_blocking', 'blocked', true, false, true, false],
        },
      ];

      for (const row of cases) {
        const snapshot = state(provider, row.name, row.content);
        assert.deepEqual([
          snapshot.execution,
          snapshot.interaction.kind,
          snapshot.status,
          snapshot.capabilities.canQueueMessage,
          snapshot.capabilities.canSendNow,
          snapshot.capabilities.canAnswerInteraction,
          snapshot.capabilities.canInterrupt,
        ], row.expected, row.name);
      }
    });
  }

  it('ignores volatile Claude footer changes when stabilizing the same prompt', () => {
    const first = pane('claude', [
      'Finished.',
      '❯ ',
      '────────────────────────',
      'new task? /clear to save 435.8k tokens',
    ].join('\n')).find((item) => item.kind === 'interaction');
    const second = pane('claude', [
      'Finished.',
      '❯ ',
      '────────────────────────',
      'new task? /clear to save 12.4k tokens',
    ].join('\n')).find((item) => item.kind === 'interaction');
    assert.equal(first.value.stabilityFingerprint, second.value.stabilityFingerprint);
  });

  it('does not treat content-line tool verbs as work', () => {
    const content = [
      'How can I help?',
      ...Array.from({ length: 20 }, (_, index) => `old output ${index}`),
      'Reading src/index.mjs',
      'tool output line 1',
      'tool output line 2',
    ].join('\n');
    const snapshot = state('claude', 'stale-prompt-during-work', content);
    assert.notEqual(snapshot.execution, 'working');
    assert.notEqual(snapshot.status, 'working');
  });

  it('keeps a live Claude spinner plus interrupt footer off the send path', () => {
    const snapshot = state('claude', 'live-spinner', [
      '● Bash(git fetch)',
      '· Osmosing… (22s · ↓ 1.1k tokens)',
      '❯ ',
      '────────────────────────',
      '⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt',
    ].join('\n'));
    assert.equal(snapshot.execution, 'thinking');
    assert.equal(snapshot.status, 'thinking');
    assert.equal(snapshot.capabilities.canSendNow, false);
  });
});
