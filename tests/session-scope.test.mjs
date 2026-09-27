import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { exec } from '../lib/exec.mjs';
import {
  agentScopeUnitName,
  buildAgentScopeLaunch,
  stopAgentScope,
} from '../modules/agent/session-scope.mjs';

describe('agent session scopes', () => {
  it('wraps a pane command in a bounded transient user scope', () => {
    const result = buildAgentScopeLaunch("printf '%s' hello", {
      kind: 'codex',
      sessionId: 'abc12345',
      platform: 'linux',
      env: {
        DUENO_AGENT_SCOPE_TASKS_MAX: '256',
        DUENO_AGENT_SCOPE_MEMORY_HIGH: '2G',
        DUENO_AGENT_SCOPE_MEMORY_MAX: '3G',
      },
    });

    assert.equal(result.unit, 'dueno-agent-codex-abc12345.scope');
    assert.match(result.command, /^exec systemd-run --user --scope /u);
    assert.match(result.command, /--slice=dueno-agents\.slice/u);
    assert.match(result.command, /--property=TasksMax=256/u);
    assert.match(result.command, /--property=MemoryMax=3G/u);
    assert.match(result.command, /bash -lc/u);
  });

  it('disables scope wrapping off Linux or by explicit switch', () => {
    const command = 'sleep 1';
    assert.equal(buildAgentScopeLaunch(command, {
      kind: 'codex', sessionId: 'abc12345', platform: 'darwin', env: {},
    }).command, command);
    assert.equal(buildAgentScopeLaunch(command, {
      kind: 'codex', sessionId: 'abc12345', platform: 'linux', env: { DUENO_AGENT_CGROUP_ISOLATION: '0' },
    }).command, command);
  });

  it('fails closed for an untrusted unit identity', async () => {
    const result = await stopAgentScope('dueno-fleet.service', {
      execImpl: async () => assert.fail('systemctl must not run for an invalid scope'),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invalid_agent_scope');
  });

  it('stops a real transient scope and its complete process group when available', async (t) => {
    if (process.platform !== 'linux') return t.skip('systemd scopes require Linux');
    const available = await exec('systemctl', ['--user', 'show-environment']);
    if (available.code !== 0) return t.skip('systemd user manager unavailable');

    const id = randomBytes(4).toString('hex');
    const unit = agentScopeUnitName('codex', id);
    const child = spawn('systemd-run', [
      '--user', '--scope', '--quiet', '--collect',
      `--unit=${unit.slice(0, -'.scope'.length)}`,
      '--slice=dueno-agents.slice',
      '--property=TimeoutStopSec=1s',
      '--property=KillMode=control-group',
      'bash', '-lc', "trap '' TERM; sleep 30 & wait",
    ], { stdio: 'ignore' });

    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const active = await exec('systemctl', ['--user', 'is-active', unit]);
      assert.equal(active.stdout.trim(), 'active');
      const stopped = await stopAgentScope(unit);
      assert.equal(stopped.ok, true);
      const final = await exec('systemctl', ['--user', 'is-active', unit]);
      assert.notEqual(final.stdout.trim(), 'active');
    } finally {
      await exec('systemctl', ['--user', 'stop', unit]).catch(() => {});
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});
