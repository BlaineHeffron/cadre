import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBusCredentialStore, AGENT_BUS_AGENT_TOOL_SCOPES } from '../modules/agent-bus/mcp-auth.mjs';

test('agent credentials grant only the new room, DM, directory, and spawn scopes', () => {
  for (const name of ['room_send', 'room_context', 'room_list', 'room_close', 'room_end', 'room_transfer', 'agent_dm', 'agent_directory']) {
    assert.ok(AGENT_BUS_AGENT_TOOL_SCOPES.includes(name));
  }
  assert.equal(AGENT_BUS_AGENT_TOOL_SCOPES.some((name) => name.startsWith('agent_bus_')), false);
  assert.equal(AGENT_BUS_AGENT_TOOL_SCOPES.some((name) => name.includes('manager_loop') || name === 'monitor_bootstrap_thread'), false);
});

test('credential lifecycle stores hashes, authenticates, and revokes tokens', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bus-auth-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = new AgentBusCredentialStore({ stateFile: join(stateDir, 'credentials.json') }); await store.init();
  const issued = await store.issue({ principal: { type: 'agent', kind: 'codex', sessionId: 'c1' }, attemptGeneration: 1 });
  assert.equal(JSON.stringify(store.state).includes(issued.token), false);
  assert.equal((await store.authenticate(issued.token)).principal.sessionId, 'c1');
  await store.revoke({ jti: issued.credential.jti });
  assert.equal((await store.authenticate(issued.token)).reason, 'revoked');
  await store.close();
});
