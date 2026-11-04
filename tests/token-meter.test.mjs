import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBusEnvelope } from '../modules/agent-bus/envelope.mjs';
import { meterStatic, meterTranscript, tokens } from '../scripts/token-meter.mjs';

const usage = (input) => ({ input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: input - 1, output_tokens: 5 });

test('meterTranscript attributes the startup prefix and carries coordination traffic over later calls', () => {
  const delivery = `\n\n<pasted_content id="ab12">\n${renderBusEnvelope({
    id: 'msg_1', threadId: 'thr_1', from: { kind: 'codex', sessionId: 'c1' }, body: 'x'.repeat(297), metadata: {},
  })}\n</pasted_content>`;
  const lines = [
    { type: 'api-request-shape', shape: { system: [{ type: 'text', text: 'sys' }], tools: [{ name: 'Bash' }] } },
    { type: 'attachment', attachment: { type: 'deferred_tools_delta', addedNames: ['Monitor', 'mcp__dueno__room_send'] } },
    { type: 'user', message: { content: 'Initial task' } },
    { type: 'assistant', message: { id: 'm1', usage: usage(1000), content: [{ type: 'tool_use', id: 't1', name: 'mcp__dueno__room_context' }] } },
    // A second content block of the same API message repeats its usage; it must count once.
    { type: 'assistant', message: { id: 'm1', usage: usage(1000), content: [] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'y'.repeat(594) }] } },
    { type: 'assistant', message: { id: 'm2', usage: usage(1300), content: [] } },
    { type: 'user', message: { content: delivery } },
    { type: 'user', message: { content: 'operator typed this' } },
    { type: 'assistant', message: { id: 'm3', usage: usage(1500), content: [] } },
  ].map((record) => JSON.stringify(record));

  const result = meterTranscript(lines);
  assert.equal(result.dueno, true);
  assert.equal(result.calls, 3);
  assert.equal(result.firstRequestTokens, 1000);
  assert.equal(result.inputTokens, 3800);
  assert.equal(result.first.initialPrompt, tokens('Initial task'));
  assert.equal(result.first.duenoToolNames, tokens('mcp__dueno__room_send'));
  // room_context result arrived after call 1, so calls 2 and 3 re-read it.
  assert.deepEqual(result.traffic.room_context, { count: 1, tokens: tokens(JSON.stringify('y'.repeat(594))), carried: 2 * tokens(JSON.stringify('y'.repeat(594))) });
  assert.equal(result.traffic['inbound room/DM delivery'].count, 1);
  assert.equal(result.traffic['inbound room/DM delivery'].carried, tokens(delivery));
  assert.equal(Object.keys(result.traffic).length, 2, 'operator text is not coordination traffic');
});

test('meterStatic lists the dueno tools each credential profile can discover', async () => {
  const result = await meterStatic();
  const agent = result.mcp['agent (default)'];
  const busOnly = result.mcp['agent-bus scopes only'];
  assert.ok(agent.tools > busOnly.tools && busOnly.tools > 0);
  assert.ok(agent.schemaTokens > agent.nameTokens * 10);
  assert.ok(result.largestTools.length === 10 && result.largestTools[0].tokens >= result.largestTools[9].tokens);
  assert.ok(result.collabWrapperTokens > 0 && result.launchSkills.count > 0);
});
