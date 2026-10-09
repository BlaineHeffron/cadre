import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildHookSessionPaths, recordHookPayload, recordRuntimeHookEvent, readHookEventsSince } from '../modules/agent/hook-events.mjs';
import { deriveHookState, readHookDerivedState } from '../modules/agent/hook-state.mjs';
import { buildLaunchEnvPrefix } from '../modules/agent/launch-env.mjs';

const tempDirs = [];

async function makeRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'hook-events-'));
  tempDirs.push(dir);
  await writeFile(join(dir, '.git'), 'gitdir: test\n');
  return dir;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    await rm(dir, { recursive: true, force: true });
  }
});

describe('agent hook events', () => {
  it('builds escaped launch env exports for hook identity binding', () => {
    const prefix = buildLaunchEnvPrefix("internal ' 1", "co dex'");
    assert.match(prefix, /export DUENO_SESSION_ID='internal '"'"' 1'/);
    assert.match(prefix, /export DUENO_PROVIDER='co dex'"'"''/);
  });

  it('writes hooks from a nested repo to the launch workDir and keeps the real cwd', async () => {
    const workDir = await mkdtemp(join(tmpdir(), "hook-launch-'"));
    tempDirs.push(workDir);
    await mkdir(join(workDir, '.git'));
    const cwd = join(workDir, 'repo');
    await mkdir(join(cwd, '.git'), { recursive: true });
    const payload = { session_id: 'cli-1', cwd, hook_event_name: 'Stop', last_assistant_message: 'Done' };
    const command = `${buildLaunchEnvPrefix('launch-1', 'claude', workDir)}; exec "$NODE_BINARY" "$HOOK_SCRIPT"`;
    execFileSync('bash', ['-c', command], {
      cwd, input: JSON.stringify(payload),
      env: { PATH: process.env.PATH, NODE_BINARY: process.execPath, HOOK_SCRIPT: resolve('scripts/agent-hooks/log-event.mjs') },
    });
    const read = await readHookEventsSince({ workDir, provider: 'claude', sessionId: 'launch-1' });
    assert.equal(read.path, join(workDir, '.agent_bus', 'hooks', 'claude-launch-1.jsonl'));
    assert.equal(read.events.length, 1);
    assert.equal(read.events[0].eventName, 'Stop');
    assert.equal(read.events[0].cwd, cwd);
    assert.equal(await exists(join(cwd, '.agent_bus')), false);
    const state = JSON.parse(await readFile(join(workDir, '.agent_bus', 'hooks', 'state', 'claude-launch-1.json'), 'utf8'));
    assert.equal(state.session.cwd, cwd);

    // Hooks outside Cadre still use the payload cwd.
    const fallback = await recordHookPayload(payload, { provider: 'claude' });
    assert.equal(fallback.paths.rootDir, cwd);
  });

  it('maps codex hook events to activity states', () => {
    const expected = new Map([
      ['SessionStart', 'starting'],
      ['UserPromptSubmit', 'working'],
      ['PreToolUse', 'tool_running'],
      ['PostToolUse', 'working'],
      ['PermissionRequest', 'needs_permission'],
      ['PreCompact', 'compacting'],
      ['PostCompact', 'working'],
      ['SubagentStart', 'working'],
      ['SubagentStop', 'working'],
      ['Stop', 'prompt_ready'],
    ]);

    for (const [eventName, activity] of expected) {
      const derived = deriveHookState({ provider: 'codex', eventName, at: 1000 });
      assert.equal(derived.activity, activity, eventName);
      assert.equal(derived.lifecycle, 'running', eventName);
    }
  });

  it('maps claude-only hook events without treating SessionEnd as activity', () => {
    const permission = deriveHookState({
      provider: 'claude',
      eventName: 'Notification',
      payload: { subtype: 'permission_prompt' },
      at: 1000,
    });
    assert.equal(permission.activity, 'needs_permission');
    assert.equal(permission.lifecycle, 'running');

    const idle = deriveHookState({
      provider: 'claude',
      eventName: 'Notification',
      payload: { subtype: 'idle_prompt' },
      at: 1000,
    });
    assert.equal(idle.activity, 'prompt_ready');
    assert.equal(idle.lifecycle, 'running');

    const ended = deriveHookState({ provider: 'claude', eventName: 'SessionEnd', at: 1000 });
    assert.equal(ended.lifecycle, 'ended');
    assert.equal(ended.activity, 'unknown');
  });

  it('records runtime hook events alongside stop-hook entries', async () => {
    const repoDir = await makeRepo();

    const recorded = await recordRuntimeHookEvent({
      workDir: repoDir,
      provider: 'codex',
      sessionId: 'codex-9',
      eventName: 'SessionClearConfirmed',
      data: {
        sessionState: 'waiting_for_input',
        confirmedContentLength: 0,
      },
    });

    assert.equal(recorded.event.source, 'runtime');
    assert.equal(recorded.event.eventName, 'SessionClearConfirmed');

    const events = await readHookEventsSince({
      workDir: repoDir,
      provider: 'codex',
      sessionId: 'codex-9',
      cursor: 0,
    });
    assert.equal(events.events.length, 1);
    assert.equal(events.events[0].source, 'runtime');
    assert.equal(events.events[0].data.sessionState, 'waiting_for_input');

    const derived = await readHookDerivedState({
      workDir: repoDir,
      provider: 'codex',
      sessionId: 'codex-9',
    });
    assert.equal(derived.source, '');
    assert.equal(derived.activity, '');

    const state = JSON.parse(await readFile(recorded.paths.statePath, 'utf8'));
    assert.equal(state.runtime.source, 'runtime');
    assert.equal(state.runtime.activity, 'prompt_ready');
  });

  it('leaves a partly written line for the next incremental read', async () => {
    const workDir = await makeRepo();
    const target = { workDir, provider: 'claude', sessionId: 'torn-1' };
    await recordHookPayload({ session_id: 'cli', cwd: workDir, hook_event_name: 'UserPromptSubmit', prompt: 'go' },
      { provider: 'claude', duenoSessionId: 'torn-1' });
    const { eventsPath } = await buildHookSessionPaths(target);
    const line = JSON.stringify({ eventName: 'Stop', lastAssistantMessage: 'whole answer' });
    await appendFile(eventsPath, line.slice(0, 20));
    const first = await readHookEventsSince(target);
    assert.deepEqual(first.events.map((event) => event.eventName), ['UserPromptSubmit']);
    await appendFile(eventsPath, `${line.slice(20)}\n`);
    const second = await readHookEventsSince({ ...target, cursor: first.cursor });
    assert.deepEqual(second.events.map((event) => event.lastAssistantMessage), ['whole answer']);
  });

  it('persists derived hook state under a hook namespace', async () => {
    const repoDir = await makeRepo();

    const first = await recordHookPayload({
      session_id: 'codex-3',
      cwd: repoDir,
      hook_event_name: 'PostCompact',
    }, { provider: 'codex' });

    const stateAfterCompact = JSON.parse(await readFile(first.paths.statePath, 'utf8'));
    assert.equal(stateAfterCompact.hook.activity, 'working');
    assert.equal(stateAfterCompact.hook.lifecycle, 'running');
    assert.equal(stateAfterCompact.hook.source, 'hook');
    assert.equal(typeof stateAfterCompact.hook.last_hook_event_at, 'number');
    assert.equal(stateAfterCompact.state, undefined);

    await recordHookPayload({
      session_id: 'codex-3',
      cwd: repoDir,
      hook_event_name: 'Stop',
      last_assistant_message: 'Done with turn.',
    }, { provider: 'codex' });

    const derived = await readHookDerivedState({
      workDir: repoDir,
      provider: 'codex',
      sessionId: 'codex-3',
      now: Date.now(),
    });
    assert.equal(derived.activity, 'prompt_ready');
    assert.equal(derived.lifecycle, 'running');
    assert.equal(derived.last_event_name, 'Stop');
    assert.ok(Number.isFinite(derived.ageMs));
  });

  it('records a resumed Claude transcript size as its start offset, and nothing for Codex', async () => {
    const repoDir = await makeRepo();
    const transcriptPath = join(repoDir, 'resumed.jsonl');
    await writeFile(transcriptPath, 'old history\n');
    const startOffset = async (provider, source, eventPath = transcriptPath, eventName = 'SessionStart') => {
      const { paths } = await recordHookPayload({
        session_id: 'cli-r', cwd: repoDir, hook_event_name: eventName, source, transcript_path: eventPath,
      }, { provider, duenoSessionId: `${provider}-1` });
      return JSON.parse(await readFile(paths.statePath, 'utf8')).session.transcriptStartOffset;
    };

    assert.equal(await startOffset('claude', 'resume'), 12);
    await writeFile(transcriptPath, 'old history\nnew output\n');
    assert.equal(await startOffset('claude', undefined, transcriptPath, 'UserPromptSubmit'), 12, 'later hooks keep the boundary');
    assert.equal(await startOffset('claude', 'clear', join(repoDir, 'fresh.jsonl')), 0);
    assert.equal(await startOffset('codex', 'resume'), 0);
  });

  it('keys genuine hook state by duenoSessionId when bound', async () => {
    const repoDir = await makeRepo();
    const result = await recordHookPayload({
      session_id: 'cli-uuid',
      cwd: repoDir,
      hook_event_name: 'Stop',
    }, { provider: 'codex', duenoSessionId: 'internal-1' });

    const internalPaths = await buildHookSessionPaths({ workDir: repoDir, provider: 'codex', sessionId: 'internal-1' });
    const cliPaths = await buildHookSessionPaths({ workDir: repoDir, provider: 'codex', sessionId: 'cli-uuid' });
    assert.equal(result.paths.statePath, internalPaths.statePath);
    assert.equal(await exists(internalPaths.statePath), true);
    assert.equal(await exists(internalPaths.eventsPath), true);
    assert.equal(await exists(cliPaths.statePath), false);
    assert.equal(await exists(cliPaths.eventsPath), false);

    const event = JSON.parse((await readFile(internalPaths.eventsPath, 'utf8')).trim());
    assert.equal(event.sessionId, 'cli-uuid');
    assert.equal(event.duenoSessionId, 'internal-1');

    const state = JSON.parse(await readFile(internalPaths.statePath, 'utf8'));
    assert.equal(state.session.cliSessionId, 'cli-uuid');
    assert.equal(state.session.duenoSessionId, 'internal-1');
    assert.equal(state.session.cwd, repoDir);
  });

  it('falls back to payload session_id for unbound genuine hooks', async () => {
    const repoDir = await makeRepo();
    const result = await recordHookPayload({
      session_id: 'cli-uuid',
      cwd: repoDir,
      hook_event_name: 'Stop',
    }, { provider: 'codex' });

    const cliPaths = await buildHookSessionPaths({ workDir: repoDir, provider: 'codex', sessionId: 'cli-uuid' });
    assert.equal(result.paths.statePath, cliPaths.statePath);
    assert.equal(await exists(cliPaths.statePath), true);
  });

  it('sanitizes duenoSessionId through the same path builder token rules', async () => {
    const repoDir = await makeRepo();
    const result = await recordHookPayload({
      session_id: 'cli-uuid',
      cwd: repoDir,
      hook_event_name: 'Stop',
    }, { provider: 'codex', duenoSessionId: 'internal/one:two' });

    const paths = await buildHookSessionPaths({ workDir: repoDir, provider: 'codex', sessionId: 'internal/one:two' });
    assert.equal(result.paths.statePath, paths.statePath);
    assert.match(result.paths.statePath, /codex-internal_one_two\.json$/);
  });

  it('preserves hook and runtime slots when writes happen in either order', async () => {
    const repoDir = await makeRepo();

    const firstHook = await recordHookPayload({
      session_id: 'cli-uuid',
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
    }, { provider: 'codex', duenoSessionId: 'internal-1' });
    await recordRuntimeHookEvent({
      workDir: repoDir,
      provider: 'codex',
      sessionId: 'internal-1',
      eventName: 'SessionStateChanged',
      data: { sessionState: 'waiting_for_input' },
    });
    const hookThenRuntime = JSON.parse(await readFile(firstHook.paths.statePath, 'utf8'));
    assert.equal(hookThenRuntime.hook.source, 'hook');
    assert.equal(hookThenRuntime.hook.activity, 'tool_running');
    assert.equal(hookThenRuntime.runtime.source, 'runtime');
    assert.equal(hookThenRuntime.runtime.activity, 'prompt_ready');

    const runtimeFirst = await recordRuntimeHookEvent({
      workDir: repoDir,
      provider: 'codex',
      sessionId: 'internal-2',
      eventName: 'SessionStateChanged',
      data: { sessionState: 'working' },
    });
    await recordHookPayload({
      session_id: 'cli-uuid-2',
      cwd: repoDir,
      hook_event_name: 'Stop',
    }, { provider: 'codex', duenoSessionId: 'internal-2' });
    const runtimeThenHook = JSON.parse(await readFile(runtimeFirst.paths.statePath, 'utf8'));
    assert.equal(runtimeThenHook.hook.source, 'hook');
    assert.equal(runtimeThenHook.hook.activity, 'prompt_ready');
    assert.equal(runtimeThenHook.runtime.source, 'runtime');
    assert.equal(runtimeThenHook.runtime.activity, 'working');
  });

  it('preserves hook and runtime slots during concurrent writes', async () => {
    const repoDir = await makeRepo();

    await Promise.all(Array.from({ length: 12 }, (_, index) => {
      if (index % 2 === 0) {
        return recordHookPayload({
          session_id: `cli-uuid-${index}`,
          cwd: repoDir,
          hook_event_name: index === 10 ? 'PreToolUse' : 'PostToolUse',
        }, { provider: 'codex', duenoSessionId: 'internal-concurrent' });
      }
      return recordRuntimeHookEvent({
        workDir: repoDir,
        provider: 'codex',
        sessionId: 'internal-concurrent',
        eventName: 'SessionStateChanged',
        data: { sessionState: 'working' },
      });
    }));

    const paths = await buildHookSessionPaths({ workDir: repoDir, provider: 'codex', sessionId: 'internal-concurrent' });
    const state = JSON.parse(await readFile(paths.statePath, 'utf8'));
    assert.equal(state.hook.source, 'hook');
    assert.equal(state.runtime.source, 'runtime');
  });

  it('maps runtime permission-needed events to needs_permission activity', async () => {
    const repoDir = await makeRepo();

    const recorded = await recordRuntimeHookEvent({
      workDir: repoDir,
      provider: 'codex',
      sessionId: 'internal-permission',
      eventName: 'SessionPermissionNeeded',
      data: { sessionState: 'needs_approval' },
    });

    const state = JSON.parse(await readFile(recorded.paths.statePath, 'utf8'));
    assert.equal(state.runtime.source, 'runtime');
    assert.equal(state.runtime.activity, 'needs_permission');
  });

  it('isolates readHookDerivedState to genuine hook slot and leaves no tmp state files', async () => {
    const repoDir = await makeRepo();
    const runtime = await recordRuntimeHookEvent({
      workDir: repoDir,
      provider: 'codex',
      sessionId: 'internal-3',
      eventName: 'SessionStateChanged',
      data: { sessionState: 'waiting_for_input' },
    });

    let derived = await readHookDerivedState({
      workDir: repoDir,
      provider: 'codex',
      sessionId: 'internal-3',
    });
    assert.equal(derived.source, '');
    assert.equal(derived.activity, '');

    await recordHookPayload({
      session_id: 'cli-uuid-3',
      cwd: repoDir,
      hook_event_name: 'PreToolUse',
    }, { provider: 'codex', duenoSessionId: 'internal-3' });
    derived = await readHookDerivedState({
      workDir: repoDir,
      provider: 'codex',
      sessionId: 'internal-3',
    });
    assert.equal(derived.source, 'hook');
    assert.equal(derived.activity, 'tool_running');

    const state = JSON.parse(await readFile(runtime.paths.statePath, 'utf8'));
    assert.equal(state.hook.source, 'hook');
    assert.equal(state.runtime.source, 'runtime');
    const leftovers = (await readdir(runtime.paths.stateDir)).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  });
});
