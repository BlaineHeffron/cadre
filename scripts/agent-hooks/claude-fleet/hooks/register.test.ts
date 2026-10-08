import { expect, test } from 'claude-code/testing';

const ran = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false };

// Stands in for the engine beneath the plugin: the classic events, the session, and the reporter runs.
function engine(on: any, runReporter: (e: any) => unknown = () => ran) {
  const runs: any[] = [];
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']) on(`classic.${event}`, () => ({}));
  on('session.id', () => ({ value: 'cli-session-1' }));
  on('session.cwd', () => ({ value: '/work/repo' }));
  on('process.run', async (_$: any, e: any) => {
    runs.push(e);
    return { value: await runReporter(e) };
  });
  return () => runs.map((run) => ({ argv: run.argv, payload: JSON.parse(run.init.stdin) }));
}

test('relays each classic event to the reporter, in order', async ($, on) => {
  const reported = engine(on);
  await $.classic.SessionStart({ source: 'startup' });
  await $.classic.UserPromptSubmit({ prompt: 'hi' });
  await $.classic.Stop({ stop_hook_active: false });
  await $.classic.SessionEnd({ reason: 'other' });
  expect(reported().map((r) => r.payload.hook_event_name)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);
  const [start, prompt] = reported();
  expect(prompt?.payload.prompt).toBe('hi');
  expect(start?.argv[0]).toBe('node');
  expect(start?.argv[1]).toMatch(/\/agent-hooks\/claude-fleet\/\.\.\/log-event\.mjs$/);
  expect(start?.argv.slice(2)).toEqual(['--provider', 'claude']);
});

test('a resumed SessionStart waits for its reporter before the session goes on', async ($, on) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const reported = engine(on, async (e) => {
    if (JSON.parse(e.init.stdin).source === 'resume') await held;
    return ran;
  });
  let resumed = false;
  const resume = $.classic.SessionStart({ source: 'resume' }).then(() => { resumed = true; });
  await $.classic.SessionStart({ source: 'clear' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(resumed).toBe(false);
  release();
  await resume;
  await $.classic.SessionEnd({ reason: 'other' });
  expect(reported().map((r) => r.payload.source ?? r.payload.hook_event_name)).toEqual(['resume', 'clear', 'SessionEnd']);
});

test('fills the classic base fields for PreToolUse', async ($, on) => {
  const reported = engine(on);
  on('tool.call', () => ({ result: { stdout: 'hi', stderr: '', interrupted: false } }));
  await $.tool.call({ tool: 'Bash', command: 'echo hi', cwd: '/elsewhere' } as any);
  await $.classic.SessionEnd({ reason: 'other' });
  expect(reported()[0]?.payload).toMatchObject({
    hook_event_name: 'PreToolUse', session_id: 'cli-session-1', cwd: '/work/repo', tool_name: 'Bash', command: 'echo hi',
  });
});

test('SessionEnd skips the queued backlog so it lands within the exit bound', async ($, on) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const reported = engine(on, async () => {
    calls += 1;
    if (calls === 1) await held;
    return ran;
  });
  await $.classic.UserPromptSubmit({ prompt: 'one' });
  await $.classic.UserPromptSubmit({ prompt: 'two' });
  await $.classic.Stop({ stop_hook_active: false });
  await $.classic.SessionEnd({ reason: 'other' });
  expect(reported().map((r) => r.payload.prompt ?? r.payload.hook_event_name)).toEqual(['one', 'SessionEnd']);
  release();
});

test('a failed reporter run does not stop later events', async ($, on) => {
  let calls = 0;
  const reported = engine(on, () => {
    calls += 1;
    if (calls === 1) throw new Error('node missing');
    return ran;
  });
  await $.classic.Stop({ stop_hook_active: false });
  await $.classic.SessionEnd({ reason: 'other' });
  expect(reported().map((r) => r.payload.hook_event_name)).toEqual(['Stop', 'SessionEnd']);
});

test('a rejected reporter or session lookup still runs each Claude event once', async ($, on) => {
  const engineRuns: string[] = [];
  on('classic.SessionEnd', () => { engineRuns.push('SessionEnd'); return {}; });
  on('session.id', () => { throw new Error('session gone'); });
  on('process.run', async () => { throw new Error('node missing'); });
  on('tool.call', () => { engineRuns.push('Bash'); return { result: { stdout: 'hi', stderr: '', interrupted: false } }; });
  expect(await $.tool.call({ tool: 'Bash', command: 'echo hi' } as any)).toMatchObject({ result: { stdout: 'hi' } });
  expect(await $.classic.SessionEnd({ reason: 'other' })).toEqual({});
  expect(engineRuns).toEqual(['Bash', 'SessionEnd']);
});
