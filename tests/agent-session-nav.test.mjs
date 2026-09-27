import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};

describe('agent session nav', () => {
  it('preserves Codex as a Codex-backed session provider', async () => {
    const { buildUnifiedAgentSessions, normalizeProvider } = await import('../public/app/agent-session-nav.mjs');

    const sessions = buildUnifiedAgentSessions({
      codexSessions: [
        {
          id: 'codex-1',
          provider: 'codex',
          runtime: 'codex',
          source: 'dashboard',
          created: 1,
        },
      ],
    });

    assert.equal(sessions[0]._kind, 'codex');
    assert.equal(sessions[0]._provider, 'codex');
    assert.equal(normalizeProvider('openai'), 'openai');
    assert.equal(normalizeProvider('chatgpt'), 'codex');
  });

  it('keeps Pi session kind separate from its model provider', async () => {
    const { buildUnifiedAgentSessions } = await import('../public/app/agent-session-nav.mjs');
    const sessions = buildUnifiedAgentSessions({
      piSessions: [{
        id: 'pi-1',
        provider: 'openai',
        runtime: 'pi',
        model: 'gpt-5.5',
        source: 'dashboard',
        created: 2,
      }],
    });

    assert.equal(sessions[0]._kind, 'pi');
    assert.equal(sessions[0]._provider, 'openai');
    assert.equal(sessions[0].model, 'gpt-5.5');
  });

  it('omits process-only sessions from the unified agent list', async () => {
    const { buildUnifiedAgentSessions } = await import('../public/app/agent-session-nav.mjs');
    const codexSessions = [
      { id: 'tmux-1', source: 'dashboard', provider: 'codex', created: 3 },
      { id: 'orphan-1', source: 'orphan-process', provider: 'codex', created: 2 },
      { id: 'bare-1', source: 'bare-process', provider: 'codex', created: 1 },
    ];

    assert.deepEqual(
      buildUnifiedAgentSessions({ codexSessions }).map((session) => session.id),
      ['tmux-1'],
    );
  });
});
