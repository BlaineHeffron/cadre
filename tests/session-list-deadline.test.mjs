import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

test('session list answers from the last list when tmux capture stalls', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-list-deadline-'));
  const socket = `cadre_list_deadline_${process.pid}_${Date.now()}`;
  const sessionName = 'codex-deadline-session';
  const sessionId = 'codex-deadline';
  const binDir = join(dir, 'bin');
  const stateDir = join(dir, 'state');
  const captureLog = join(dir, 'captures.log');
  const stall = join(dir, 'stall');
  await mkdir(binDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  t.after(async () => {
    await execFileAsync('/usr/bin/tmux', ['-L', socket, 'kill-server']).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  await execFileAsync('/usr/bin/tmux', ['-L', socket, 'new-session', '-d', '-s', sessionName, "printf '› '; exec cat"]);
  await writeFile(join(stateDir, 'codex_sessions.json'), JSON.stringify([{
    id: sessionId, tmuxSession: sessionName, source: 'dashboard', workDir: dir, created: Date.now(),
  }]));
  // A stalled tmux server: capture-pane blocks while the stall file exists.
  await writeFile(join(binDir, 'tmux'), `#!/bin/sh
if [ "$1" = capture-pane ]; then
  printf 'capture\\n' >> '${captureLog}'
  while [ -f '${stall}' ]; do sleep 0.02; done
fi
exec /usr/bin/tmux -L '${socket}' "$@"
`);
  await chmod(join(binDir, 'tmux'), 0o755);

  const fastifyUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const sessionsUrl = pathToFileURL(resolve('modules/sessions/index.mjs')).href;
  const adaptersUrl = pathToFileURL(resolve('modules/agent-bus/adapters.mjs')).href;
  const script = `
    import assert from 'node:assert/strict';
    import Fastify from ${JSON.stringify(fastifyUrl)};
    import { readFile, rm, writeFile } from 'node:fs/promises';

    const { createAgentSessionsProvider } = await import(${JSON.stringify(sessionsUrl)});
    const { createAgentAdapters } = await import(${JSON.stringify(adaptersUrl)});
    const app = Fastify({ logger: false });
    const wsManager = { channels: new Map(), broadcast() {}, onChannel() {} };
    await app.register(createAgentSessionsProvider('codex').plugin, { wsManager });
    await app.register(createAgentSessionsProvider('pi').plugin, { wsManager });
    await app.ready();
    let now = Date.now();
    Date.now = () => now;
    const captures = () => readFile(${JSON.stringify(captureLog)}, 'utf8').then((text) => text.trim().split('\\n').length, () => 0);
    const list = async () => {
      const startedAt = performance.now();
      const response = await app.inject({ method: 'GET', url: '/api/codex/sessions' });
      assert.equal(response.statusCode, 200, response.body);
      return { ...response.json(), elapsedMs: performance.now() - startedAt };
    };

    const empty = await app.inject({ method: 'GET', url: '/api/pi/sessions' });
    assert.deepEqual(empty.json(), { sessions: [] }, 'a finished empty list is not stale');

    const fresh = await list();
    assert.equal(fresh.stale, undefined);
    assert.deepEqual(fresh.sessions.map((s) => s.id), ['${sessionId}']);

    await writeFile(${JSON.stringify(stall)}, '');
    now += 60_000;
    const [stalled, joined] = await Promise.all([list(), list()]);
    for (const response of [stalled, joined]) {
      assert.equal(response.stale, true);
      assert.deepEqual(response.sessions.map((s) => s.id), ['${sessionId}']);
      assert.ok(response.elapsedMs < 3500, 'list answered after ' + response.elapsedMs + 'ms');
    }
    const stalledCaptures = await captures();
    assert.equal((await list()).stale, true);
    assert.equal(await captures(), stalledCaptures, 'stalled lists share one refresh');
    await assert.rejects(createAgentAdapters().codex.listSessions(app), /Session listing failed/);

    await rm(${JSON.stringify(stall)});
    const recovered = await list();
    assert.equal(recovered.stale, undefined);
    assert.deepEqual(recovered.sessions.map((s) => s.id), ['${sessionId}']);

    await app.close();
  `;
  const env = {
    ...process.env,
    HOME: dir,
    DM_STATE_DIR: stateDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    PORT: '43281',
    AGENT_BUS_MCP_HTTP_PORT: '43282',
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
  await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], { cwd: dir, env, timeout: 30_000 });
});
