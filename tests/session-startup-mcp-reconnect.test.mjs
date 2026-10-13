import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

test('startup MCP reconnect types /mcp only into sessions launched with dueno', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-startup-mcp-'));
  const socket = `cadre_startup_mcp_${process.pid}_${Date.now()}`;
  const binDir = join(dir, 'bin');
  const stateDir = join(dir, 'state');
  await mkdir(binDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  t.after(async () => {
    await execFileAsync('/usr/bin/tmux', ['-L', socket, 'kill-server']).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  const idle = "printf 'Claude Code v2.1.296\\n────────────────────\\n❯ \\n────────────────────\\n  ⏵⏵ bypass permissions on\\n'; exec cat";
  const sessions = [
    { id: 'with-dueno', serverIds: ['dueno'] },
    { id: 'no-mcp', serverIds: [] },
  ];
  for (const { id } of sessions) {
    await execFileAsync('/usr/bin/tmux', ['-L', socket, 'new-session', '-d', '-s', `claude-${id}`, idle]);
  }
  await writeFile(join(stateDir, 'claude_sessions.json'), JSON.stringify(sessions.map(({ id, serverIds }) => ({
    id, tmuxSession: `claude-${id}`, source: 'dashboard', workDir: dir, created: Date.now(),
    mcpCapabilities: { profileId: serverIds.length ? 'dueno' : 'default', serverIds },
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
    await app.register(createAgentSessionsProvider('claude').plugin, {
      wsManager: { channels: new Map(), broadcast() {}, onChannel() {} },
    });
    await app.ready();
    const realNow = Date.now;
    const start = realNow();
    Date.now = () => start + 30000 + (realNow() - start) * 10;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await app.close();
  `;
  const env = {
    ...process.env,
    HOME: dir,
    DM_STATE_DIR: stateDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    PORT: '43281',
    AGENT_BUS_MCP_HTTP_PORT: '43282',
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
  await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], { cwd: dir, env, timeout: 30_000 });

  const pane = async (id) => (await execFileAsync('/usr/bin/tmux', ['-L', socket, 'capture-pane', '-p', '-t', `claude-${id}`])).stdout;
  assert.match(await pane('with-dueno'), /\/mcp/);
  assert.doesNotMatch(await pane('no-mcp'), /\/mcp/);
});
