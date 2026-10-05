import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { claudeSessionsPlugin } from '../modules/sessions/claude-sessions.mjs';
import { recordHookPayload } from '../modules/agent/hook-events.mjs';

const execFileAsync = promisify(execFile);
const coverageEnv = process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {};
const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

async function runClearScenario({ paneContent, deadlineMs = 25 }) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-claude-clear-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  const paneFile = join(tempDir, 'pane.txt');
  const bufferFile = join(tempDir, 'buffer.txt');
  await mkdir(binDir, { recursive: true });
  await writeFile(paneFile, paneContent);
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'cmd="$1"',
    'shift',
    'case "$cmd" in',
    '  capture-pane)',
    '    cat "$TMUX_TEST_PANE"',
    '    exit 0',
    '    ;;',
    '  list-panes)',
    '    echo "$PPID"',
    '    exit 0',
    '    ;;',
    '  load-buffer)',
    '    cat > "$TMUX_TEST_BUFFER"',
    '    exit 0',
    '    ;;',
    '  paste-buffer)',
    '    exit 0',
    '    ;;',
    '  send-keys)',
    '    if [ -f "$TMUX_TEST_BUFFER" ] && grep -qx "/clear" "$TMUX_TEST_BUFFER"; then',
    '      printf "> " > "$TMUX_TEST_PANE"',
    '    fi',
    '    exit 0',
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  await writeFile(join(binDir, 'pgrep'), '#!/bin/sh\nexit 1\n');
  await chmod(join(binDir, 'tmux'), 0o755);
  await chmod(join(binDir, 'pgrep'), 0o755);

  await writeFile(join(tempDir, '.claude_sessions.json'), JSON.stringify([{
    id: 'claude-clear-1',
    tmuxSession: 'claude-clear-session',
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
    provider: 'anthropic',
    runtime: 'claude',
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/claude-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef.claudeSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/claude/sessions/claude-clear-1/clear',
      payload: { deadlineAt: Date.now() + ${deadlineMs} },
    });
    const hookEvents = await readFile(${JSON.stringify(join(tempDir, '.agent_bus', 'hooks', 'claude-claude-clear-1.jsonl'))}, 'utf8').catch(() => '');
    await app.close();
    console.log(JSON.stringify({ statusCode: response.statusCode, body: response.json(), hookEvents }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], {
    cwd: resolve('.'),
    env: {
      ...coverageEnv,
      NODE_TEST_CONTEXT: '1',
      HOME: tempDir,
      CADRE_AGENT_CGROUP_ISOLATION: '0',
      PATH: `${binDir}:/usr/bin:/bin`,
      TMUX_TEST_PANE: paneFile,
      TMUX_TEST_BUFFER: bufferFile,
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CLAUDE_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runStateTransitionScenario({ initialPaneContent, updatedPaneContent }) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-claude-state-hooks-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  const paneFile = join(tempDir, 'pane.txt');
  await mkdir(binDir, { recursive: true });
  await writeFile(paneFile, initialPaneContent);
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'cmd="$1"',
    'shift',
    'case "$cmd" in',
    '  capture-pane)',
    '    cat "$TMUX_TEST_PANE"',
    '    exit 0',
    '    ;;',
    '  list-panes)',
    '    echo "$PPID"',
    '    exit 0',
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  await chmod(join(binDir, 'tmux'), 0o755);

  await writeFile(join(tempDir, '.claude_sessions.json'), JSON.stringify([{
    id: 'claude-hooks-1',
    tmuxSession: 'claude-hooks-session',
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
    provider: 'anthropic',
    runtime: 'claude',
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/claude-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile, writeFile } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef.claudeSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    await app.inject({ method: 'GET', url: '/api/claude/sessions/claude-hooks-1' });
    await writeFile(${JSON.stringify(paneFile)}, ${JSON.stringify(updatedPaneContent)});
    await app.inject({ method: 'GET', url: '/api/claude/sessions/claude-hooks-1' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await app.inject({ method: 'GET', url: '/api/claude/sessions/claude-hooks-1' });
    const hookEvents = await readFile(${JSON.stringify(join(tempDir, '.agent_bus', 'hooks', 'claude-claude-hooks-1.jsonl'))}, 'utf8').catch(() => '');
    await app.close();
    console.log(JSON.stringify({ hookEvents }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], {
    cwd: resolve('.'),
    env: {
      ...coverageEnv,
      NODE_TEST_CONTEXT: '1',
      HOME: tempDir,
      CADRE_AGENT_CGROUP_ISOLATION: '0',
      PATH: `${binDir}:/usr/bin:/bin`,
      TMUX_TEST_PANE: paneFile,
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CLAUDE_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runMissingPaneDetailScenario() {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-claude-ended-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'cmd="$1"',
    'shift',
    'case "$cmd" in',
    '  capture-pane)',
    '    echo "can\\047t find pane: claude-ended-session" >&2',
    '    exit 1',
    '    ;;',
    '  display-message)',
    '    printf "/tmp/tmux-1000/default\\n"',
    '    exit 0',
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  await chmod(join(binDir, 'tmux'), 0o755);

  await writeFile(join(tempDir, '.claude_sessions.json'), JSON.stringify([{
    id: 'claude-ended-1',
    tmuxSession: 'claude-ended-session',
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
    provider: 'anthropic',
    runtime: 'claude',
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/claude-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef.claudeSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/claude/sessions/claude-ended-1' });
    await app.close();
    console.log(JSON.stringify({ statusCode: response.statusCode, body: response.json() }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], {
    cwd: resolve('.'),
    env: {
      ...coverageEnv,
      NODE_TEST_CONTEXT: '1',
      HOME: tempDir,
      CADRE_AGENT_CGROUP_ISOLATION: '0',
      PATH: `${binDir}:/usr/bin:/bin`,
      TMUX: '/tmp/tmux-1000/dm-agent,123,0',
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CLAUDE_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runMissingPaneListScenario() {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-claude-ended-list-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'cmd="$1"',
    'shift',
    'case "$cmd" in',
    '  list-sessions)',
    '    exit 0',
    '    ;;',
    '  capture-pane)',
    '    echo "can\\047t find pane: claude-ended-session" >&2',
    '    exit 1',
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  await writeFile(join(binDir, 'pgrep'), '#!/bin/sh\nexit 1\n');
  await chmod(join(binDir, 'tmux'), 0o755);
  await chmod(join(binDir, 'pgrep'), 0o755);

  await writeFile(join(tempDir, '.claude_sessions.json'), JSON.stringify([{
    id: 'claude-ended-1',
    tmuxSession: 'claude-ended-session',
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
    provider: 'anthropic',
    runtime: 'claude',
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/claude-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef.claudeSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/claude/sessions' });
    await app.close();
    console.log(JSON.stringify({ statusCode: response.statusCode, body: response.json() }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], {
    cwd: resolve('.'),
    env: {
      ...coverageEnv,
      NODE_TEST_CONTEXT: '1',
      HOME: tempDir,
      CADRE_AGENT_CGROUP_ISOLATION: '0',
      PATH: `${binDir}:/usr/bin:/bin`,
      TMUX: '/tmp/tmux-1000/dm-agent,123,0',
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CLAUDE_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runMissingTmuxDeleteScenario({
  id = 'claude-stale-1',
  tmuxSession = 'claude-stale-session',
  stderr = "can't find session: claude-stale-session",
} = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-claude-stale-delete-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  const storeFile = join(tempDir, '.claude_sessions.json');
  const migratedStoreFile = join(tempDir, '.dueno', 'state', 'claude_sessions.json');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'if [ "$1" = "has-session" ]; then',
    `  echo ${JSON.stringify(stderr)} >&2`,
    '  exit 1',
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  await writeFile(join(binDir, 'pgrep'), '#!/bin/sh\nexit 1\n');
  await chmod(join(binDir, 'tmux'), 0o755);
  await chmod(join(binDir, 'pgrep'), 0o755);

  await writeFile(storeFile, JSON.stringify([{
    id,
    tmuxSession,
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
    provider: 'anthropic',
    runtime: 'claude',
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/claude-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef.claudeSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({ method: 'DELETE', url: ${JSON.stringify(`/api/claude/sessions/${id}`)} });
    const stored = JSON.parse(await readFile(${JSON.stringify(migratedStoreFile)}, 'utf8'));
    await app.close();
    console.log(JSON.stringify({ statusCode: response.statusCode, body: response.json(), stored }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], {
    cwd: resolve('.'),
    env: {
      ...coverageEnv,
      NODE_TEST_CONTEXT: '1',
      HOME: tempDir,
      CADRE_AGENT_CGROUP_ISOLATION: '0',
      PATH: `${binDir}:/usr/bin:/bin`,
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CLAUDE_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runNoTmuxServerListScenario() {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-claude-no-tmux-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  const storeFile = join(tempDir, '.claude_sessions.json');
  const migratedStoreFile = join(tempDir, '.dueno', 'state', 'claude_sessions.json');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'if [ "$1" = "list-sessions" ]; then',
    '  echo "no server running on /tmp/tmux-1000/default" >&2',
    '  exit 1',
    'fi',
    'exit 1',
    '',
  ].join('\n'));
  await writeFile(join(binDir, 'pgrep'), '#!/bin/sh\nexit 1\n');
  await chmod(join(binDir, 'tmux'), 0o755);
  await chmod(join(binDir, 'pgrep'), 0o755);

  await writeFile(storeFile, JSON.stringify([{
    id: 'claude-preserve-1',
    tmuxSession: 'claude-preserve-session',
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
    provider: 'anthropic',
    runtime: 'claude',
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/claude-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef.claudeSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/claude/sessions' });
    const stored = JSON.parse(await readFile(${JSON.stringify(migratedStoreFile)}, 'utf8'));
    await app.close();
    console.log(JSON.stringify({ statusCode: response.statusCode, body: response.json(), stored }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], {
    cwd: resolve('.'),
    env: {
      ...coverageEnv,
      NODE_TEST_CONTEXT: '1',
      HOME: tempDir,
      CADRE_AGENT_CGROUP_ISOLATION: '0',
      PATH: `${binDir}:/usr/bin:/bin`,
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CLAUDE_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runHookReconcileScenario({ sessionId = 'claude-hook-1', oldEndedSessionId = '' } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-claude-hook-reconcile-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  const paneFile = join(tempDir, 'pane.txt');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(tempDir, '.agent_bus', 'hooks', 'state'), { recursive: true });
  await writeFile(paneFile, 'Completed pass.\n> ');
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'cmd="$1"',
    'shift',
    'case "$cmd" in',
    '  capture-pane)',
    '    cat "$TMUX_TEST_PANE"',
    '    exit 0',
    '    ;;',
    '  list-panes)',
    '    echo "$PPID"',
    '    exit 0',
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  await chmod(join(binDir, 'tmux'), 0o755);

  if (oldEndedSessionId) {
    await recordHookPayload({
      session_id: 'cli-old-uuid',
      cwd: tempDir,
      hook_event_name: 'SessionEnd',
    }, { provider: 'claude', duenoSessionId: oldEndedSessionId });
  } else {
    await recordHookPayload({
      session_id: 'cli-claude-uuid',
      cwd: tempDir,
      hook_event_name: 'PermissionRequest',
    }, { provider: 'claude', duenoSessionId: sessionId });
  }

  await writeFile(join(tempDir, '.claude_sessions.json'), JSON.stringify([{
    id: sessionId,
    tmuxSession: 'claude-hook-session',
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
    provider: 'anthropic',
    runtime: 'claude',
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/claude-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef.claudeSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    await app.inject({ method: 'GET', url: '/api/claude/sessions/${sessionId}' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const response = await app.inject({ method: 'GET', url: '/api/claude/sessions/${sessionId}' });
    await app.close();
    console.log(JSON.stringify({ statusCode: response.statusCode, body: response.json() }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], {
    cwd: resolve('.'),
    env: {
      ...coverageEnv,
      NODE_TEST_CONTEXT: '1',
      HOME: tempDir,
      CADRE_AGENT_CGROUP_ISOLATION: '0',
      PATH: `${binDir}:/usr/bin:/bin`,
      TMUX_TEST_PANE: paneFile,
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CLAUDE_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runCreateClaudeCommandScenario({ workDir, model = 'claude-sonnet-4-6', promptProfile = '' } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-claude-create-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  const homeDir = join(tempDir, 'home');
  const tmuxArgsFile = join(tempDir, 'tmux-args.txt');
  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(join(binDir, 'claude'), '#!/bin/sh\nexit 0\n');
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'if [ "$1" = "has-session" ]; then',
    '  exit 0',
    'fi',
    'printf "%s\\n" "$@" > "$TMUX_TEST_ARGS"',
    'exit 0',
    '',
  ].join('\n'));
  await chmod(join(binDir, 'claude'), 0o755);
  await chmod(join(binDir, 'tmux'), 0o755);

  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/claude-sessions.mjs')).href;
  const wrapped = `
    process.chdir(${JSON.stringify(tempDir)});
      const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
      await pluginRef.createClaudeSession({
        workDir: ${JSON.stringify(workDir)},
        model: ${JSON.stringify(model)},
        promptProfile: ${JSON.stringify(promptProfile)},
        source: 'test',
      });
  `;

  await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], {
    cwd: resolve('.'),
    env: {
      ...coverageEnv,
      NODE_TEST_CONTEXT: '1',
      HOME: homeDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMUX_TEST_ARGS: tmuxArgsFile,
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CLAUDE_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
      AGENT_BUS_MCP_HTTP_HOST: '127.0.0.1',
      AGENT_BUS_MCP_HTTP_PORT: '9876',
      AGENT_BUS_MCP_HTTP_PATH: '/mcp',
      CADRE_AGENT_CGROUP_ISOLATION: '0',
    },
  });

  return {
    tmuxArgs: await readFile(tmuxArgsFile, 'utf8'),
    homeDir,
  };
}

describe('Claude Sessions module', () => {
  it('should be importable without errors', async () => {
    const mod = await import('../modules/sessions/claude-sessions.mjs');
    assert.equal(typeof mod.claudeSessionsPlugin, 'function');
  });

  it('starts Claude sessions in bypass permission mode', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-claude-workdir-'));
    tempDirs.push(workDir);
    const { tmuxArgs, homeDir } = await runCreateClaudeCommandScenario({ workDir });

    assert.match(tmuxArgs, /--dangerously-skip-permissions/);
    assert.match(tmuxArgs, /export DUENO_SESSION_ID='[a-f0-9]+'/);
    assert.match(tmuxArgs, /export DUENO_PROVIDER='claude'/);
    assert.match(tmuxArgs, /--permission-mode/);
    assert.match(tmuxArgs, /bypassPermissions/);
    assert.match(tmuxArgs, new RegExp(`'--add-dir' '${workDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    assert.match(tmuxArgs, /'--mcp-config' '[^']*mcp_client_configs\/claude-[a-f0-9]+\.json'/);
    assert.match(tmuxArgs, /'--strict-mcp-config'/);
    assert.match(tmuxArgs, /'--plugin-dir' '[^']*scripts\/agent-hooks\/claude-fleet'/);
    await assert.rejects(readFile(join(workDir, '.mcp.json'), 'utf8'), /ENOENT/);
    await assert.rejects(readFile(join(workDir, '.claude', 'settings.local.json'), 'utf8'), /ENOENT/);
    const claudeJson = JSON.parse(await readFile(join(homeDir, '.claude.json'), 'utf8'));
    assert.equal(claudeJson.projects[workDir].hasTrustDialogAccepted, true);
  });

  it('appends selected prompt profiles with the Claude file flag', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-claude-style-'));
    tempDirs.push(workDir);
    const { tmuxArgs } = await runCreateClaudeCommandScenario({ workDir, promptProfile: 'research' });
    assert.match(tmuxArgs, /'--append-system-prompt-file' '[^']*prompt_profiles\/claude-[a-f0-9]+\.txt'/);
  });

  it('passes canonical Claude model ids to the runtime for dotted aliases', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-claude-alias-workdir-'));
    tempDirs.push(workDir);
    const { tmuxArgs } = await runCreateClaudeCommandScenario({ workDir, model: 'opus 4.8' });

    assert.match(tmuxArgs, /'--model' 'claude-opus-4-8'/);
    assert.doesNotMatch(tmuxArgs, /opus 4\.8/);
    assert.match(tmuxArgs, /export DUENO_SESSION_ID='[a-f0-9]+'/);
    assert.match(tmuxArgs, /export DUENO_PROVIDER='claude'/);
  });

  it('builds runtime-specific workdir args through the shared harness layer', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-runtime-args-'));
    tempDirs.push(workDir);
    const { buildAgentRuntimeLaunchArgs } = await import('../modules/agent/runtime-args.mjs');

    assert.deepEqual(
      buildAgentRuntimeLaunchArgs({ runtime: 'claude', workDir, model: 'claude-sonnet-4-6' }).slice(0, 5),
      ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '--add-dir', workDir]
    );
    assert.throws(
      () => buildAgentRuntimeLaunchArgs({ runtime: 'xai', workDir, model: 'grok-4.20-0309-reasoning' }),
      /Unsupported agent runtime harness: xai/,
    );
  });

  it('adds the Claude Remote Control flag only when the setting is on', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-remote-control-'));
    tempDirs.push(workDir);
    const { buildClaudeLaunchArgs, buildAgentRuntimeResumeArgs } = await import('../modules/agent/runtime-args.mjs');

    assert.ok(!buildClaudeLaunchArgs({ workDir }).includes('--remote-control'));
    assert.ok(buildClaudeLaunchArgs({ workDir, remoteControl: true }).includes('--remote-control'));
    assert.ok(buildAgentRuntimeResumeArgs({
      runtime: 'claude', workDir, cliSessionId: randomUUID(), remoteControl: true,
    }).includes('--remote-control'));
  });

  it('returns a 400 from the session API for invalid Claude models', async () => {
    const app = Fastify();
    await app.register(claudeSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {} },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/claude/sessions',
      payload: { model: 'claude-2' },
    });

    assert.equal(response.statusCode, 400);
    const payload = JSON.parse(response.body);
    assert.match(payload.error, /Unsupported Claude model "claude-2"/);
    await app.close();
  });

  it('rejects removed Claude backend providers', async () => {
    const app = Fastify();
    await app.register(claudeSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {} },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/claude/sessions',
      payload: { provider: 'xai', model: 'not-a-grok-model' },
    });

    assert.equal(response.statusCode, 400);
    const payload = JSON.parse(response.body);
    assert.match(payload.error, /provider must be claude/);
    await app.close();
  });

  it('rejects clear requests when the session is not in a safe idle state', async () => {
    const result = await runClearScenario({
      paneContent: [
        'Reviewing repository state.',
        '────────────────────────────────────────',
        '❯',
        '────────────────────────────────────────',
        '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents',
      ].join('\n'),
    });

    assert.equal(result.statusCode, 409);
    assert.equal(result.body.code, 'command_deadline_expired');
    assert.equal(result.body.safeToClear, false);
    assert.equal(result.body.sessionState, 'working');
    assert.match(result.hookEvents, /"eventName":"SessionClearRejected"/);
    assert.match(result.hookEvents, /"eventName":"SessionToolStarted"/);
  });

  it('attach command names the server tmux reports, not inherited $TMUX, when the pane is gone', async () => {
    const result = await runMissingPaneDetailScenario();

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.sessionEnded, true);
    assert.equal(result.body.sessionName, 'claude-ended-session');
    assert.equal(result.body.tmuxSession, 'claude-ended-session');
    assert.equal(result.body.attachCommand, "tmux -S /tmp/tmux-1000/default attach -t 'claude-ended-session'");
    assert.equal(result.body.content, '');
    assert.equal(result.body.state.state, 'ended');
  });

  it('keeps ended persisted sessions in the list view', async () => {
    const result = await runMissingPaneListScenario();

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.sessions.length, 1);
    assert.equal(result.body.sessions[0].id, 'claude-ended-1');
    assert.equal(result.body.sessions[0].sessionEnded, true);
    assert.equal(result.body.sessions[0].resumeBlockedReason, 'cli_session_id_unknown');
  });

  it('cleans up stale Claude metadata when kill finds no tmux session', async () => {
    const result = await runMissingTmuxDeleteScenario();

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.status, 'already_gone');
    assert.deepEqual(result.stored, []);
  });

  it('preserves Claude metadata when kill fails for a non-stale tmux error', async () => {
    const result = await runMissingTmuxDeleteScenario({
      id: 'claude-error-1',
      tmuxSession: 'claude-error-session',
      stderr: 'permission denied opening tmux socket',
    });

    assert.equal(result.statusCode, 409);
    assert.equal(result.body.status, 'failed');
    assert.equal(result.body.reason, 'tmux_lookup_failed');
    assert.match(result.body.error, /permission denied/);
    assert.equal(result.stored.length, 1);
    assert.equal(result.stored[0].id, 'claude-error-1');
  });

  it('preserves Claude metadata when tmux server is temporarily unavailable', async () => {
    const result = await runNoTmuxServerListScenario();

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.sessions.length, 1);
    assert.equal(result.body.sessions[0].id, 'claude-preserve-1');
    assert.equal(result.body.sessions[0].sessionEnded, true);
    assert.equal(result.stored.length, 1);
    assert.equal(result.stored[0].id, 'claude-preserve-1');
  });

  it('emits tool lifecycle hooks when a claude session returns to prompt-ready', async () => {
    const result = await runStateTransitionScenario({
      initialPaneContent: [
        'Reviewing repository state.',
        '────────────────────────────────────────',
        '❯',
        '────────────────────────────────────────',
        '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents',
      ].join('\n'),
      updatedPaneContent: 'Completed pass.\n› ',
    });

    assert.match(result.hookEvents, /"eventName":"SessionToolStarted"/);
    assert.match(result.hookEvents, /"eventName":"SessionToolFinished"/);
    assert.match(result.hookEvents, /"eventName":"SessionPromptReady"/);
  });

  it('fails closed on contradictory fresh Claude hook and pane evidence', async () => {
    const result = await runHookReconcileScenario();

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.state.status, 'unknown');
    assert.equal(result.body.state.capabilities.sendMessage, false);
    assert.equal(result.body.state.interaction.kind, 'free_text');
  });

  it('ignores stale SessionEnd state keyed to an old internal id after relaunch', async () => {
    const result = await runHookReconcileScenario({
      sessionId: 'claude-new-id',
      oldEndedSessionId: 'claude-old-id',
    });

    assert.equal(result.statusCode, 200);
    assert.notEqual(result.body.state.state, 'ended');
    assert.equal(result.body.state.status, 'ready');
    assert.equal(result.body.state.capabilities.sendMessage, true);
  });
});
