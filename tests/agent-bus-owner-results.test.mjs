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
  const ownerDelivery = (id) => h.store.getThread(thread.id).deliveries.find((d) => d.messageId === id && d.target.kind === owner.kind);
  const send = async (from, summary, body) => {
    const before = ownerInjections();
    const id = (await request('messages', { threadId: thread.id, from, summary, body, type: 'result' })).json().message.id;
    return { id, delivered: ownerInjections() - before };
  };
  return { h, thread, request, send, ownerInjections, ownerDelivery };
}

test('the owner gets one result per outcome: repeats skip, changed verdicts and heads deliver', async (t) => {
  const { h, thread, send } = await setup(t);
  const delivered = async (...args) => (await send(...args)).delivered;
  assert.equal(await delivered(reviewer, 'ready · PR #45 · approved', 'DIRECTOR REPORT: PR #45\nHead: 070ef5702feae88fbaed58242302aef5b3bce94a'), 1);
  assert.equal(await delivered(implementer, 'Ready · PR #45 · done', 'Base 1234abc. Approved at head `070ef57`.'), 0);
  assert.equal(await delivered(implementer, 'ready · PR #45 · unlabeled', 'Approved at 070ef57.'), 1);
  assert.equal(await delivered(reviewer, 'ready · PR #45 · base first', 'Base: abc1234\nHead: 111aaaa'), 1);
  assert.equal(await delivered(implementer, 'ready · PR #45 · new head', 'Base: abc1234\nHead: 222bbbb'), 1);
  assert.equal(await delivered(reviewer, 'ready · PR #45 · digits', 'Head: 1234567'), 1);
  assert.equal(await delivered(implementer, 'ready · PR #45 · digits', 'Head SHA 1234567890'), 0);
  assert.equal(await delivered(reviewer, 'ready · PR #45 · two heads', 'Old head 1234567, new head abcdefa'), 1);
  assert.equal(await delivered(implementer, 'needs-decision · PR #45 · scope', 'Head: abcdefa'), 1);
  assert.equal(await delivered(reviewer, 'ready · PR #45 · back to ready', 'Head: abcdefa'), 1);
  const latest = h.store.getThread(thread.id).deliveries.findLast((d) => d.target.kind === owner.kind);
  await h.store.updateDelivery(latest.id, { status: 'failed' });
  assert.equal(await delivered(implementer, 'ready · PR #45 · retry after failure', 'Head: abcdefa'), 1);
  await h.store.addThreadParticipant(thread.id, owner);
  assert.equal(await delivered(reviewer, 'ready · PR #45 · owner subscribed', 'Head: abcdefa'), 0);
  assert.equal(await delivered(reviewer, 'blocked · PR #45 · owner subscribed', 'Head: abcdefa'), 1);
});

test('a room with no reviewer delivers its result to the owner', async (t) => {
  const { send } = await setup(t, [implementer]);
  assert.equal((await send(implementer, 'ready · PR #45 · done', 'Head: 070ef57')).delivered, 1);
});

test('a busy owner and a lost acknowledgement still get one injection per outcome', async (t) => {
  const { h, request, send, ownerInjections, ownerDelivery } = await setup(t);
  h.sessionStates.pi.set(owner.sessionId, { state: 'working', needsInput: false });
  const queued = await send(reviewer, 'ready · PR #45 · approved', 'Head: 070ef57');
  assert.equal(ownerDelivery(queued.id).status, 'queued');
  assert.equal(ownerDelivery((await send(implementer, 'ready · PR #45 · done', 'Head: 070ef5702feae88f')).id), undefined);
  h.sessionStates.pi.set(owner.sessionId, { state: 'waiting_for_input', needsInput: true });
  await settle(() => ownerDelivery(queued.id).status !== 'queued');
  assert.equal(ownerInjections(), 1);
  let lostAcks = 0;
  // The owner accepts the envelope but the acknowledgement is lost, so the harness does not record it as injected.
  h.inputResponders.pi = async ({ text }) => { lostAcks++; return { content: text, statusCode: 502, payload: { error: 'acknowledgement lost' } }; };
  const lost = await send(reviewer, 'needs-decision · PR #45 · scope', 'Head: 070ef57');
  await settle(() => ownerDelivery(lost.id).status === 'failed');
  h.inputResponders.pi = null;
  assert.equal((await request(`deliveries/${ownerDelivery(lost.id).id}/replay`, {})).statusCode, 200);
  assert.equal(ownerDelivery(lost.id).resolution, 'already_present');
  assert.equal((await send(implementer, 'needs-decision · PR #45 · same', 'Head: 070ef57')).delivered, 0);
  assert.equal(lostAcks, 1);
  assert.equal(ownerInjections(), 1);
});
