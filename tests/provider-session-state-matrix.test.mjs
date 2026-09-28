import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AsyncEventQueue, createBaseCapabilities, createTransportEvent } from '../modules/agent/agent-transport.mjs';
import { createAgentAdapters } from '../modules/agent-bus/adapters.mjs';
import { canonicalSessionStateId, createInitialSnapshot } from '../modules/session-state/contract.mjs';
import { reduce } from '../modules/session-state/reducer.mjs';
import { sessionStateTracker } from '../modules/session-state/tracker.mjs';
import { projectClaudeStreamJsonSession } from '../modules/sessions/claude-stream-json-sessions.mjs';
import { projectCodexAppServerSession } from '../modules/sessions/codex-app-server-sessions.mjs';
import { FileJournalStore } from '../modules/sessions/journal-store.mjs';
import { registerProtocolSessionProvider } from '../modules/sessions/protocol-session-registry.mjs';
import { SessionService } from '../modules/sessions/session-service.mjs';
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

// Scripted structured transport: the test pushes normalized events itself.
class ScriptedTransport {
  queue = new AsyncEventQueue();
  constructor(provider) { this.provider = provider; }
  emit(type, payload = {}) { this.queue.push(createTransportEvent(type, payload, { attemptId: this.attemptId, provider: this.provider })); }
  async start({ attemptId }) { this.attemptId = attemptId; return { protocolSessionId: 'p-1', negotiated: this.capabilities() }; }
  async attach() { throw new Error('unsupported'); }
  prompt({ turnId }) { this.turnId = turnId; this.emit('turn.started', { turnId, evidence: { accepted: true } }); return new Promise(() => {}); }
  async cancel() { return { mode: 'best_effort' }; }
  async answerInteraction({ interactionId, optionId }) { this.emit('interaction.answered', { interactionId, optionId }); return { ok: true }; }
  events() { return this.queue; }
  snapshot() { return {}; }
  capabilities() { return createBaseCapabilities(); }
  async terminate() { this.queue.close(); return { ok: true, status: 'terminated', residual: [] }; }
}

describe('structured provider sessions read the canonical tracker', () => {
  const structured = {
    claude: projectClaudeStreamJsonSession,
    'codex-app-server': projectCodexAppServerSession,
  };

  it('drives both providers through one lifecycle and projects identical canonical state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cadre-structured-state-'));
    const runs = [];
    const unregister = [];
    try {
      for (const [provider, project] of Object.entries(structured)) {
        let transport;
        const service = new SessionService({ provider, journal: new FileJournalStore({ rootDir: join(root, provider) }),
          transportFactory: () => (transport = new ScriptedTransport(provider)) });
        await service.init();
        unregister.push(registerProtocolSessionProvider(provider, { service, project }));
        const { id } = await service.start({ workDir: root, permissionMode: 'workspace-write' });
        runs.push({ provider, project, service, id, transport: () => transport, rows: [] });
      }
      const until = async (run, lifecycle) => {
        for (let i = 0; i < 200 && run.service.get(run.id).lifecycle !== lifecycle; i++) await new Promise((r) => setTimeout(r, 5));
        assert.equal(run.service.get(run.id).lifecycle, lifecycle, run.provider);
      };
      const record = async (run) => {
        const projected = run.project(run.service.get(run.id));
        // The tracker is keyed like tmux sessions, so every consumer reads one snapshot.
        assert.deepEqual(projected.canonicalState, sessionStateTracker.get(canonicalSessionStateId(run.provider, run.id)));
        if (run.provider === 'codex-app-server') {
          // Agent-bus delivery gating reads the same projection; ended sessions are not deliverable.
          const read = createAgentAdapters()['codex-app-server'].getSession({}, run.id);
          if (projected.state.status === 'ended') await assert.rejects(read, { code: 'session_not_found' });
          else assert.deepEqual((await read).state, projected.state);
        }
        const { state } = projected;
        run.rows.push([state.status, state.state, state.execution, state.interaction.kind, state.interaction.options.map((o) => o.label),
          state.capabilities.sendMessage, state.capabilities.clear, state.capabilities.canAnswerInteraction, state.capabilities.needsAttention, Boolean(projected.pendingResponse)]);
      };
      const steps = [
        ['ready', () => {}],
        ['working', (run) => run.service.prompt(run.id, { blocks: [{ type: 'text', text: 'go' }], idempotencyKey: 'go' })],
        ['blocked', (run) => run.transport().emit('interaction.requested', { interactionId: 'i-1', turnId: run.transport().turnId,
          kind: 'permission', toolCall: { title: 'Run tests' }, options: [{ optionId: 'allow_once', name: 'Allow once' }] })],
        ['working', (run) => run.service.answerInteraction(run.id, { interactionId: 'i-1', optionId: 'allow_once',
          authority: { decision: 'allowed', principalType: 'ui', actor: 'operator' } })],
        ['ready', (run) => run.transport().emit('turn.settled', { turnId: run.transport().turnId, stopReason: 'end_turn',
          evidence: { accepted: true, settled: true, quiescent: true } })],
        ['interrupted', (run) => run.transport().emit('attempt.exited', { code: 1 })],
      ];
      for (const [lifecycle, act] of steps) {
        for (const run of runs) { await act(run); await until(run, lifecycle); await record(run); }
      }
      const [claude, codex] = runs;
      assert.deepEqual(claude.rows, [
        ['ready', 'waiting_for_input', 'idle', 'free_text', [], true, false, false, false, false],
        ['working', 'working', 'working', 'none', [], false, false, false, false, true],
        ['blocked', 'needs_approval', 'working', 'permission', ['Allow once'], false, false, true, true, true],
        ['working', 'working', 'working', 'none', [], false, false, false, false, true],
        ['ready', 'waiting_for_input', 'idle', 'free_text', [], true, false, false, false, false],
        ['ended', 'exited', 'unknown', 'none', [], false, false, false, false, false],
      ]);
      assert.deepEqual(codex.rows, claude.rows);
    } finally {
      unregister.forEach((fn) => fn());
      for (const run of runs) await run.service.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
