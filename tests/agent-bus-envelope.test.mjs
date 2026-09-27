import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBusEnvelope, sessionHasBusMessage } from '../modules/agent-bus/envelope.mjs';

test('renders room and DM inbound envelopes without parsers or acknowledgement instructions', () => {
  const message = { id: 'msg_1', threadId: 'thr_1', from: { kind: 'codex', sessionId: 'c1' }, body: 'hello', metadata: {} };
  assert.equal(renderBusEnvelope(message), [
    '[ROOM_MESSAGE id=msg_1 room=thr_1 from=codex:c1]', 'hello', '[/ROOM_MESSAGE]',
    'Tool: room_send(thread_id="thr_1", body="...", reply_to="<id if answering a claim>") · Context: room_context(thread_id="thr_1")',
    'Reply only if this is new work. Do not reply to delayed copies or courtesy acks.',
  ].join('\n'));
  assert.match(renderBusEnvelope({ ...message, metadata: { dm: true } }), /^\[DM id=msg_1 from=codex:c1\]/);
  assert.match(renderBusEnvelope({ ...message, replyTo: 'msg_0' }, { id: 'msg_0', from: { kind: 'claude', sessionId: 'a1' }, body: 'claim 3' }), /In reply to msg_0 \(claude:a1\): claim 3/);
  assert.doesNotMatch(renderBusEnvelope(message), /ACK|requires_ack|AGENT_BUS/);
  assert.equal(sessionHasBusMessage(renderBusEnvelope(message), message), true);
  assert.equal(sessionHasBusMessage('unrelated pane', message), false);
  assert.equal(sessionHasBusMessage('[ROOM_MESSAGE id=msg_10 room=thr_1 from=codex:c1]', message), false);
  assert.equal(sessionHasBusMessage('[ROOM_MESSAGE id=msg_1 room=thr_1 from=codex:c1]', { id: 'msg_10' }), false);
});
