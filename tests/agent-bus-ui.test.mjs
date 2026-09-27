import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildQuickInsertOptions,
  buildQuickInsertPrompt,
  sessionTitle,
} from '../public/app/agent-bus-ui.mjs';
import { roomLabel } from '../public/pages/agent-collab/format.mjs';

describe('agent bus UI quick insert helpers', () => {
  it('renders broadcast messages without target or ack controls', async () => {
    const source = await readFile(new URL('../public/pages/agent-collab.mjs', import.meta.url), 'utf8');
    assert.match(source, /Messages are broadcast to every other participant/);
    assert.doesNotMatch(source, /requiresAck|Require ack|selectedToKey/);
    assert.match(source, /message\.type !== 'message'/);
  });

  it('renders legacy loop metadata as inert archived history', async () => {
    const source = await readFile(new URL('../public/pages/agent-collab.mjs', import.meta.url), 'utf8');
    assert.match(source, /Legacy loop \(archived\)/);
    assert.match(source, /managerLoop\.lastDecision/);
    assert.doesNotMatch(source, /loopStatusClass|manager-loop\/start|BusLoopPanel/);
  });

  it('renders end skip reports and hides end for DM rooms', async () => {
    const source = await readFile(new URL('../public/pages/agent-collab.mjs', import.meta.url), 'utf8');
    assert.match(source, /Skipped \(active in another room\)/);
    assert.match(source, /data\.skipped/);
    assert.match(source, /!threadState\.value\.metadata\?\.dm/);
    assert.match(source, /End room \+ sessions/);
  });

  it('labels DM rooms with participant display names', () => {
    assert.equal(roomLabel({
      metadata: { dm: true },
      participants: [
        { kind: 'user', sessionId: 'dashboard' },
        { kind: 'codex', sessionId: 'codex-1', display_name: 'Builder' },
      ],
    }), 'DM · you & Builder');
  });

  it('keeps named parent and child identities across room membership and ordering changes', () => {
    const sessions = [
      ['codex', { id: 'parent-1', displayName: 'Reviewer', name: 'codex-parent-1' }],
      ['pi', { id: 'child-1', displayName: 'Builder', name: 'pi-child-1' }],
    ];
    const participants = sessions.map(([kind, session]) => ({ kind, sessionId: session.id }));
    const dm = { title: 'Parent and child DM', metadata: { dm: true }, participants };
    const release = { title: 'Release room', participants };
    const review = { title: 'Review room', participants };
    for (const [kind, session] of sessions) {
      for (const threads of [[], [dm], [release], [dm, release, review], [review, release, dm]]) {
        assert.equal(sessionTitle(session, kind, threads, 'project'), session.displayName);
      }
      assert.equal(sessionTitle(session, kind, [{ ...release, title: 'Renamed room' }]), session.displayName);
      assert.equal(sessionTitle({ ...session, displayName: 'Explicitly renamed' }, kind, [release, review]), 'Explicitly renamed');
    }
  });

  it('preserves unnamed session fallbacks and excludes DM titles', () => {
    const session = { id: 'codex-1', name: 'codex-worker', displayName: '' };
    const room = { title: 'Release room', participants: [{ kind: 'codex', sessionId: session.id }] };
    assert.equal(sessionTitle(session, 'codex', [room], 'project'), 'Release room');
    assert.equal(sessionTitle(session, 'codex', [{ ...room, metadata: { dm: true } }], 'project'), 'project');
    assert.equal(sessionTitle(session, 'codex', [], 'project'), 'project');
    assert.equal(sessionTitle(session, 'codex'), 'codex-worker');
    assert.equal(sessionTitle({ id: session.id }, 'codex'), session.id);
    assert.equal(sessionTitle(session, 'pi', [room]), 'codex-worker');
  });

  it('builds a session prompt from the selected quick insert option', () => {
    const options = buildQuickInsertOptions({
      sessionsByKind: {
        codex: [{ id: 'codex-1', name: 'worker' }],
      },
    });
    const option = options.find((item) => item.key === 'session::codex::codex-1');

    const prompt = buildQuickInsertPrompt({
      option,
      activeThreads: [],
      currentThreadId: 'thread-current',
    });

    assert.match(prompt, /Check on codex:codex-1/);
    assert.match(prompt, /agent_directory\(\)/);
    assert.match(prompt, /agent_dm\(kind="codex", session_id="codex-1"/);
    assert.match(prompt, /thread-current/);
  });

  it('uses an existing linked thread for a session option when present', () => {
    const activeThreads = [
      {
        id: 'thread-linked',
        title: 'Linked Work',
        participants: [{ kind: 'claude', sessionId: 'claude-9' }],
      },
    ];
    const option = {
      type: 'session',
      kind: 'claude',
      sessionId: 'claude-9',
    };

    const prompt = buildQuickInsertPrompt({
      option,
      activeThreads,
      currentThreadId: 'thread-current',
    });

    assert.match(prompt, /Monitor linked thread thread-linked \(Linked Work\)/);
    assert.match(prompt, /claude:claude-9/);
  });
});
