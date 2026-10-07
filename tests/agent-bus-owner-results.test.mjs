import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentBusHarness } from './helpers/agent-bus-test-harness.mjs';

const owner = { kind: 'pi', sessionId: 'pi-1' };
const [implementer, reviewer] = [{ kind: 'claude', sessionId: 'claude-1' }, { kind: 'codex', sessionId: 'codex-1' }];
const settle = async (done) => { for (let i = 0; i < 200 && !done(); i++) await delay(20); };

async function setup(t, participants = [implementer, reviewer]) {
  const h = await createAgentBusHarness({ pollMs: 20 }); t.after(() => h.cleanup());
  const thread = await h.store.createThread({ title: 'PR room', participants, createdBy: owner });
  const request = (path, payload) => h.app.inject({ method: 'POST', url: `/api/agent-bus/${path}`, headers: h.authHeaders, payload });
  const ownerInjections = () => h.injected.pi.filter((text) => text.includes(thread.id)).length;
  const send = async (from, summary, body) => {
    const before = ownerInjections();
    const id = (await request('messages', { threadId: thread.id, from, summary, body, type: 'result' })).json().message.id;
    // The observer may claim the delivery first; wait for it to land before counting.
    await settle(() => h.store.getThread(thread.id).deliveries.every((d) => d.messageId !== id || d.status !== 'queued'));
    return { id, delivered: ownerInjections() - before };
  };
  return { h, thread, send };
}

test('the owner gets the reviewer\'s result after the implementer posted the same outcome', async (t) => {
  const { h, thread, send } = await setup(t);
  assert.equal((await send(implementer, 'ready · PR #45 · done', 'Head: 070ef57')).delivered, 1);
  assert.equal((await send(reviewer, 'ready · PR #45 · approved', 'DIRECTOR REPORT: PR #45\nHead: 070ef5702feae88f')).delivered, 1);
  // A subscribed owner gets each result once, as a participant.
  await h.store.addThreadParticipant(thread.id, owner);
  assert.equal((await send(reviewer, 'merged · PR #45 · landed', 'Head: 070ef57')).delivered, 1);
});

test('an exact repeat of the latest result is deduped, but posts again once the verdict has changed', async (t) => {
  const { send } = await setup(t);
  const ready = ['ready · PR #45 · approved', 'Head: 070ef57'];
  const first = await send(reviewer, ...ready);
  assert.equal(first.delivered, 1);
  assert.equal((await send(reviewer, ...ready)).id, first.id);
  assert.equal((await send(reviewer, 'needs-decision · PR #45 · scope', 'Head: 070ef57')).delivered, 1);
  const flipped = await send(reviewer, ...ready);
  assert.notEqual(flipped.id, first.id);
  assert.equal(flipped.delivered, 1);
});

test('a room with no reviewer delivers its result to the owner', async (t) => {
  const { send } = await setup(t, [implementer]);
  assert.equal((await send(implementer, 'ready · PR #45 · done', 'Head: 070ef57')).delivered, 1);
});
