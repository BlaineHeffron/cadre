import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentBusMcpServer } from '../modules/agent-bus/mcp.mjs';
import { renderCollabStartupPrompt } from '../modules/agent-bus/protocol.mjs';

test('collab startup prompt keeps workflow rules and leaves tool how-to to tool descriptions', () => {
  const self = { kind: 'claude', sessionId: 'a1', role: 'reviewer' };
  const prompt = renderCollabStartupPrompt({ self, participants: [self, { kind: 'codex', sessionId: 'c1' }], threadId: 'thr_1', title: 'T' });
  assert.match(prompt, /Context: room_context\(thread_id="thr_1"\)/);
  assert.match(prompt, /Only the reviewer posts type="result"/);
  assert.match(prompt, /its tool descriptions cover rooms, DMs, paging and ownership/);
  assert.doesNotMatch(prompt, /Directory: agent_directory|Direct message: agent_dm|body_offset/);

  // The removed how-to lines are still discoverable from tools/list.
  const tools = Object.fromEntries(buildAgentBusMcpServer({ requestImpl: async () => ({}) }).tools.map((tool) => [tool.name, tool.description]));
  assert.match(tools.room_context, /body_offset=nextOffset/);
  assert.match(tools.room_send, /without subscribing; DMs require membership/);
  assert.match(tools.room_list, /scope=all/);
  assert.match(tools.room_transfer, /claim it for yourself/);
  assert.ok(tools.agent_dm && tools.agent_directory && tools.room_end && tools.room_close);
});
