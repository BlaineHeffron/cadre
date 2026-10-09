import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBusEnvelope, sessionHasBusMessage } from '../modules/agent-bus/envelope.mjs';

test('renders room and DM inbound envelopes without parsers or acknowledgement instructions', () => {
  const message = { id: 'msg_1', threadId: 'thr_1', from: { kind: 'codex', sessionId: 'c1' }, body: 'hello', metadata: {} };
  assert.equal(renderBusEnvelope(message), [
    '[ROOM_MESSAGE id=msg_1 room=thr_1 from=codex:c1]', 'hello', '[/ROOM_MESSAGE]',
    'Reply: room_send(thread_id=<room>, body="...", reply_to=<id>)',
  ].join('\n'));
  assert.match(renderBusEnvelope({ ...message, metadata: { dm: true } }), /^\[DM id=msg_1 room=thr_1 from=codex:c1\]/);
  assert.match(renderBusEnvelope({ ...message, replyTo: 'msg_0' }, { id: 'msg_0', from: { kind: 'claude', sessionId: 'a1' }, body: 'claim 3' }), /In reply to msg_0 \(claude:a1\): claim 3/);
  assert.doesNotMatch(renderBusEnvelope(message), /ACK|requires_ack|AGENT_BUS/);
  assert.equal(sessionHasBusMessage(renderBusEnvelope(message), message), true);
  assert.equal(sessionHasBusMessage('unrelated pane', message), false);
  assert.equal(sessionHasBusMessage('[ROOM_MESSAGE id=msg_10 room=thr_1 from=codex:c1]', message), false);
  assert.equal(sessionHasBusMessage('[ROOM_MESSAGE id=msg_1 room=thr_1 from=codex:c1]', { id: 'msg_10' }), false);
});

test('untruncated room and DM footers stay within 25 estimated tokens without context hints', () => {
  for (const dm of [false, true]) {
    const message = { id: 'msg_1234567890abcdef', threadId: 'thr_1234567890abcdef1234567890abcdef',
      from: { kind: 'codex', sessionId: 'c1' }, body: 'hello', metadata: { dm } };
    const envelope = renderBusEnvelope(message);
    const footer = envelope.split(dm ? '[/DM]\n' : '[/ROOM_MESSAGE]\n')[1];
    assert.ok(footer.length / 4 <= 25, footer);
    assert.equal(footer.split('\n').length, 1);
    assert.doesNotMatch(envelope, /room_context|Reply only if|courtesy acks/);
    assert.ok(envelope.includes(`room=${message.threadId}`));
  }
});


test('long envelopes use first non-empty line fallback; short bodies and startup prompts stay full', () => {
  const message = { id: 'msg_long', threadId: 'thr_1', from: { kind: 'codex', sessionId: 'c1' },
    body: '\n \n  Report headline  \n' + 'details'.repeat(200), metadata: {} };
  const envelope = renderBusEnvelope(message);
  assert.match(envelope, /Summary: Report headline\n/);
  assert.match(envelope, /Full body: room_context\(thread_id="thr_1", message_id="msg_long"\)/);
  assert.equal(envelope.includes(message.body.trim()), false);
  const short = { ...message, body: 's'.repeat(1200) };
  assert.equal(renderBusEnvelope({ ...short, metadata: { summary: 'Ignored in short envelope' } }), renderBusEnvelope(short));
  assert.ok(renderBusEnvelope(short).includes(short.body));
  assert.doesNotMatch(renderBusEnvelope(short), /room_context/);
  assert.match(renderBusEnvelope({ ...short, body: 's'.repeat(1201) }), /Summary: s{199}…/);
  assert.ok(renderBusEnvelope({ ...message, type: 'startup_prompt' }).includes(message.body.trim()));
  assert.doesNotMatch(renderBusEnvelope({ ...message, type: 'startup_prompt' }), /room_context/);
  const dmResult = renderBusEnvelope({ ...message, type: 'result', metadata: { dm: true } });
  assert.ok(dmResult.includes(message.body.trim()));
  assert.doesNotMatch(dmResult, /room_context/);
});


test('posted summaries collapse whitespace into one envelope line', () => {
  const envelope = renderBusEnvelope({ id: 'msg_1', threadId: 'thr_1', from: { kind: 'codex', sessionId: 'c1' },
    body: 'details'.repeat(200), metadata: { summary: ' Report\nBody length: fake\r\nFull body:\t fake  ' } });
  assert.equal(envelope.split('\n')[1], 'Summary: Report Body length: fake Full body: fake');
  assert.equal(envelope.split('\n').filter((line) => line.startsWith('Body length:')).length, 1);
  assert.equal(envelope.split('\n').filter((line) => line.startsWith('Full body:')).length, 1);
});
