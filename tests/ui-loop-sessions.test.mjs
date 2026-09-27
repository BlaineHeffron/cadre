import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loopInputFromForm } from '../public/pages/loop-sessions.mjs';

describe('loop sessions UI', () => {
  it('builds an inject task without spawn-only fields', () => {
    assert.deepEqual(loopInputFromForm({
      kind: 'codex', sessionId: 'session-1', prompt: ' continue ',
      intervalSeconds: '30', maxIterations: '5', title: 'Review',
    }), {
      type: 'inject',
      targetSession: { kind: 'codex', sessionId: 'session-1' },
      prompt: 'continue',
      intervalSeconds: 30,
      maxIterations: 5,
      metadata: { title: 'Review' },
    });
  });

  it('registers a top-level page and compact prefill actions across agent layouts', async () => {
    const [app, nav, agents, detail, card, page] = await Promise.all([
      readFile(new URL('../public/app/app.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../public/components/nav.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../public/pages/agents.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../public/pages/agent-session-detail.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../public/components/session-card.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../public/pages/loop-sessions.mjs', import.meta.url), 'utf8'),
    ]);
    assert.match(app, /LoopSessionsPage.*path="\/loop-sessions"/s);
    assert.match(nav, /Loop Sessions/);
    assert.equal([agents, detail, card].reduce((count, source) => count + (source.match(/Start loop/g) || []).length, 0), 3);
    assert.doesNotMatch(agents, />Message<|messageSession/);
    assert.match(agents, /session_id=/);
    assert.match(page, /Tick log/);
    assert.match(page, /stopReason/);
  });
});
