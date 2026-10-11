import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

test('session detail polling backs off and returns to normal after pane, input, hook, and view activity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-adaptive-polling-'));
  const socket = `cadre_adaptive_${process.pid}_${Date.now()}`;
  const sessionName = 'codex-adaptive-session';
  const sessionId = 'codex-adaptive';
  const binDir = join(dir, 'bin');
  const stateDir = join(dir, 'state');
  const captureLog = join(dir, 'captures.log');
  const pauseCapture = join(dir, 'pause-capture');
  const captureStarted = join(dir, 'capture-started');
  const resumeCapture = join(dir, 'resume-capture');
  await mkdir(binDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  t.after(async () => {
    await execFileAsync('/usr/bin/tmux', ['-L', socket, 'kill-server']).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  await execFileAsync('/usr/bin/tmux', ['-L', socket, 'new-session', '-d', '-s', sessionName, "printf 'Completed pass.\\n› '; exec cat"]);
  await writeFile(join(stateDir, 'codex_sessions.json'), JSON.stringify([{
    id: sessionId, tmuxSession: sessionName, source: 'dashboard', workDir: dir, created: Date.now(),
  }]));
  await writeFile(join(binDir, 'tmux'), `#!/bin/sh
if [ "$1" = capture-pane ]; then
  printf 'capture\\n' >> '${captureLog}'
  if [ -f '${pauseCapture}' ]; then
    rm -f '${pauseCapture}'
    /usr/bin/tmux -L '${socket}' "$@" > '${dir}/paused-pane'
    code=$?
    touch '${captureStarted}'
    while [ ! -f '${resumeCapture}' ]; do sleep 0.01; done
    cat '${dir}/paused-pane'
    rm -f '${captureStarted}' '${resumeCapture}' '${dir}/paused-pane'
    exit "$code"
  fi
fi
exec /usr/bin/tmux -L '${socket}' "$@"
`);
  await chmod(join(binDir, 'tmux'), 0o755);

  const fastifyUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const sessionsUrl = pathToFileURL(resolve('modules/sessions/index.mjs')).href;
  const hookEventsUrl = pathToFileURL(resolve('modules/agent/hook-events.mjs')).href;
  const script = `
    import assert from 'node:assert/strict';
    import Fastify from ${JSON.stringify(fastifyUrl)};
    import { execFileSync } from 'node:child_process';
    const { createAgentSessionsProvider } = await import(${JSON.stringify(sessionsUrl)});
    const { recordHookPayload } = await import(${JSON.stringify(hookEventsUrl)});
    const provider = createAgentSessionsProvider('codex');
    const handlers = new Map();
    let broadcastCount = 0;
    let nextBroadcast;
    const wsManager = { channels: new Map(), broadcast(channel) {
      if (channel === 'codex:sessions') { broadcastCount++; nextBroadcast?.(); }
    }, onChannel(name, handler) { handlers.set(name, handler); } };
    const app = Fastify({ logger: false });
    await app.register(provider.plugin, { wsManager });
    await app.ready();
    let now = Date.now();
    Date.now = () => now;
    const url = '/api/codex/sessions/${sessionId}';
    const readCaptureCount = async () => (await import('node:fs/promises')).readFile(${JSON.stringify(captureLog)}, 'utf8').then((value) => value.trim().split('\\n').filter(Boolean).length, () => 0);
    const detail = async (query = '') => {
      const response = await app.inject({ method: 'GET', url: url + query });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const first = await detail();
    const firstCount = await readCaptureCount();
    now += 5001;
    await detail();
    const secondCount = await readCaptureCount();
    now += 5000;
    await detail();
    const backedOffCount = await readCaptureCount();
    assert.equal(secondCount, firstCount + 1, 'the first unchanged pane poll uses the normal five second interval');
    assert.equal(backedOffCount, secondCount, 'the unchanged pane then waits ten seconds');

    execFileSync('/usr/bin/tmux', ['-L', '${socket}', 'send-keys', '-l', '-t', '${sessionName}', 'pane-change']);
    now += 5000;
    const changed = await detail();
    const changedCount = await readCaptureCount();
    assert.equal(changedCount, backedOffCount + 1, 'a pane change is captured at the backoff deadline');
    assert.match(changed.content, /pane-change/);

    now += 5001;
    await detail();
    const beforeInput = await readCaptureCount();
    const input = await app.inject({ method: 'POST', url: url + '/input', payload: { text: 'input-reset', enter: false, source: 'ui' } });
    assert.ok([200, 202].includes(input.statusCode), input.body);
    await detail();
    const afterInput = await readCaptureCount();
    assert.ok(afterInput > beforeInput, 'input resets the adaptive cache');

    now += 5001;
    await detail();
    now += 5001;
    await detail();
    const beforeHook = await readCaptureCount();
    now += 1;
    await recordHookPayload({ session_id: '${sessionId}', cwd: ${JSON.stringify(dir)}, hook_event_name: 'UserPromptSubmit' }, {
      provider: 'codex', duenoSessionId: '${sessionId}', workDir: ${JSON.stringify(dir)},
    });
    await detail();
    const afterHook = await readCaptureCount();
    assert.ok(afterHook > beforeHook, 'a new hook timestamp resets the adaptive cache');

    now += 5001;
    await detail();
    now += 5001;
    await detail();
    const beforeView = await readCaptureCount();
    handlers.get('codex')({}, 'codex:session:${sessionId}', { action: 'subscribe' });
    await detail();
    const afterView = await readCaptureCount();
    assert.ok(afterView > beforeView, 'view subscription resets the adaptive cache');
    assert.equal(first.id, '${sessionId}');

    handlers.get('codex')({}, 'codex:session:${sessionId}', { action: 'unsubscribe' });
    const beforeMixedLines = await readCaptureCount();
    for (const lines of [75, 125]) await detail('?lines=' + lines);
    const afterMixedLineCaptures = await readCaptureCount();
    assert.equal(afterMixedLineCaptures, beforeMixedLines + 2, 'each line count gets its own pane capture');
    for (const lines of [75, 125]) await detail('?lines=' + lines);
    assert.equal(await readCaptureCount(), afterMixedLineCaptures, 'interleaved line counts retain independent cache hits');

    const sessions = async () => {
      const response = await app.inject({ method: 'GET', url: '/api/codex/sessions' });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    await sessions();
    now += 5001;
    await sessions();
    now += 10001;
    await import('node:fs/promises').then(({ writeFile }) => writeFile(${JSON.stringify(pauseCapture)}, 'pause'));
    const pendingList = sessions();
    const waitForFile = async (path) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        try { await (await import('node:fs/promises')).access(path); return; } catch {}
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('Timed out waiting for ' + path);
    };
    await waitForFile(${JSON.stringify(captureStarted)});
    const beforeInputBroadcast = broadcastCount;
    const broadcasted = new Promise((resolve) => { nextBroadcast = resolve; });
    const racedInput = await app.inject({ method: 'POST', url: url + '/input', payload: { text: 'race-reset', enter: false, source: 'ui' } });
    assert.ok([200, 202].includes(racedInput.statusCode), racedInput.body);
    await broadcasted;
    nextBroadcast = null;
    assert.ok(broadcastCount > beforeInputBroadcast);
    const capturesAfterInput = await readCaptureCount();
    await (await import('node:fs/promises')).writeFile(${JSON.stringify(resumeCapture)}, 'resume');
    await pendingList;
    await sessions();
    assert.equal(await readCaptureCount(), capturesAfterInput + 1,
      'a list capture started before input cannot supply the post-input cache');
    await sessions();
    assert.equal(await readCaptureCount(), capturesAfterInput + 1, 'the post-input capture is cached');
    await app.close();
    console.log(JSON.stringify({ firstCount, secondCount, backedOffCount, changedCount, afterInput, afterHook, afterView }));
  `;
  const env = {
    ...process.env,
    HOME: dir,
    DM_STATE_DIR: stateDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    PORT: '43271',
    AGENT_BUS_MCP_HTTP_PORT: '43272',
    CADRE_DISABLE_SIDE_EFFECTS: '1',
    CADRE_GITHUB_AGENT_POLLER_ENABLED: '0',
    CADRE_GITHUB_AGENTS_ENABLED: '0',
    CADRE_SCHEDULED_AGENT_PUMP_ENABLED: '0',
    TELEGRAM_BRIDGE: '0',
    APP_STATE_STORAGE: 'file',
    CODEX_SESSIONS_STORAGE: 'file',
    LOG_LEVEL: 'error',
    DATABASE_URL: '',
  };
  delete env.DUENO_SESSION_WORK_DIR;
  delete env.CADRE_SESSION_WORK_DIR;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: dir, env, timeout: 30_000,
  });
  const result = JSON.parse(stdout.trim());
  assert.ok(result.afterView > result.afterHook);
});
