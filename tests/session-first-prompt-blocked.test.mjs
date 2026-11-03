import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { buildHookSessionPaths } from '../modules/agent/hook-events.mjs';

const execFileAsync = promisify(execFile);

test('a spawned Claude session blocked on a prompt before its first turn reports it to its spawner, and Codex does not', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-first-prompt-'));
  const socket = `cadre_first_prompt_${process.pid}_${Date.now()}`;
  const binDir = join(dir, 'bin');
  const stateDir = join(dir, 'state');
  await mkdir(binDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  t.after(async () => {
    await execFileAsync('/usr/bin/tmux', ['-L', socket, 'kill-server']).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  const pane = resolve('tests/fixtures/session-state/panes/claude-2-1-317-external-imports.pane');
  const spawner = { kind: 'claude', sessionId: 'parent-1' };
  const sessions = [
    { id: 'blocked', metadata: { spawnedBy: spawner } },
    { id: 'started', metadata: { spawnedBy: spawner } },
    { id: 'unspawned', metadata: {} },
  ];
  for (const session of sessions) {
    session.workDir = join(dir, session.id);
    await mkdir(session.workDir);
    await execFileAsync('/usr/bin/tmux', ['-L', socket, 'new-session', '-d', '-x', '120', '-y', '40',
      '-s', `claude-${session.id}`, `cat '${pane}'; exec cat`]);
  }
  // Codex logs no UserPromptSubmit, so a long-running child's first selection must not read as an unstarted prompt.
  const codexPane = resolve('tests/fixtures/session-state/panes/codex-selection-model-switch.pane');
  await mkdir(join(dir, 'codex-child'));
  await execFileAsync('/usr/bin/tmux', ['-L', socket, 'new-session', '-d', '-x', '120', '-y', '40',
    '-s', 'codex-codex-child', `cat '${codexPane}'; exec cat`]);
  await writeFile(join(stateDir, 'codex_sessions.json'), JSON.stringify([{ id: 'codex-child', tmuxSession: 'codex-codex-child',
    source: 'dashboard', workDir: join(dir, 'codex-child'), created: Date.now(), metadata: { spawnedBy: spawner } }]));
  const { eventsPath } = await buildHookSessionPaths({ workDir: join(dir, 'started'), provider: 'claude', sessionId: 'started' });
  await mkdir(dirname(eventsPath), { recursive: true });
  await writeFile(eventsPath, `${JSON.stringify({ eventName: 'UserPromptSubmit', loggedAt: new Date().toISOString() })}\n`);
  await writeFile(join(stateDir, 'claude_sessions.json'), JSON.stringify(sessions.map(({ id, workDir, metadata }) => ({
    id, tmuxSession: `claude-${id}`, source: 'dashboard', workDir, created: Date.now(), metadata,
  }))));
  await writeFile(join(binDir, 'tmux'), `#!/bin/sh\nexec /usr/bin/tmux -L '${socket}' "$@"\n`, { mode: 0o755 });

  const fastifyUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const sessionsUrl = pathToFileURL(resolve('modules/sessions/index.mjs')).href;
  const script = `
    import Fastify from ${JSON.stringify(fastifyUrl)};
    const { createAgentSessionsProvider } = await import(${JSON.stringify(sessionsUrl)});
    const realSetInterval = setInterval;
    globalThis.setInterval = (fn, ms, ...args) => realSetInterval(fn, ms === 15000 ? 100 : ms, ...args);
    const app = Fastify({ logger: false });
    app.decorate('agentBusLifecycle', {
      directMessage: async (message) => { console.log('DM ' + JSON.stringify(message)); return { statusCode: 200 }; },
    });
    for (const provider of ['claude', 'codex']) {
      await app.register(createAgentSessionsProvider(provider).plugin, {
        wsManager: { channels: new Map(), broadcast() {}, onChannel() {} },
      });
    }
    await app.ready();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await app.close();
  `;
  const env = {
    ...process.env,
    HOME: dir,
    DM_STATE_DIR: stateDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    PORT: '43283',
    AGENT_BUS_MCP_HTTP_PORT: '43284',
    DUENO_ALLOW_SIDE_EFFECTS: '1',
    CADRE_GITHUB_AGENT_POLLER_ENABLED: '0',
    CADRE_GITHUB_AGENTS_ENABLED: '0',
    CADRE_SCHEDULED_AGENT_PUMP_ENABLED: '0',
    TELEGRAM_BRIDGE: '0',
    APP_STATE_STORAGE: 'file',
    CLAUDE_SESSIONS_STORAGE: 'file',
    LOG_LEVEL: 'error',
    DATABASE_URL: '',
  };
  delete env.CADRE_DISABLE_SIDE_EFFECTS;
  delete env.DUENO_DISABLE_SIDE_EFFECTS;
  delete env.DUENO_TEST_SERVER;
  delete env.DUENO_SESSION_WORK_DIR;
  delete env.CADRE_SESSION_WORK_DIR;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], { cwd: dir, env, timeout: 30_000 });

  const dms = stdout.split('\n').filter((line) => line.startsWith('DM ')).map((line) => JSON.parse(line.slice(3)));
  assert.equal(dms.length, 1, stdout);
  assert.deepEqual(dms[0].from, { kind: 'claude', sessionId: 'blocked' });
  assert.deepEqual(dms[0].target, spawner);
  assert.equal(dms[0].type, 'result');
  assert.match(dms[0].body, /blocked has not started your first message yet.*Allow external CLAUDE\.md file imports\?/);
});
