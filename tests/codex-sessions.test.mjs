import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { recordHookPayload } from '../modules/agent/hook-events.mjs';
import { isTmuxMissingNamedSessionError, isTmuxMissingSessionError } from '../modules/sessions/index.mjs';
import { resolveMcpCapabilities } from '../modules/integrations/mcp-capability-resolver.mjs';
import { buildMcpCapabilityCatalog } from '../modules/integrations/mcp-server-catalog.mjs';
import { sanitizedMcpSnapshot } from '../modules/integrations/mcp-launch-preflight.mjs';
import { exec } from '../lib/exec.mjs';

const execFileAsync = promisify(execFile);
const coverageEnv = process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {};
const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

it('startup-input reports the launch log when a real tmux agent exits', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-startup-route-'));
  const socket = join(dir, 'socket'), log = join(dir, 'launch.log');
  const tmux = (args) => exec('tmux', ['-S', socket, ...args]);
  t.after(async () => { await tmux(['kill-server']); await rm(dir, { recursive: true, force: true }); });
  // Keep the isolated server alive while the failed agent pane disappears.
  assert.equal((await tmux(['new-session', '-d', '-s', 'keeper', 'cat'])).code, 0);
  assert.equal((await tmux(['new-session', '-d', '-s', 'codex-exited', 'sh', '-c', `echo route-launch-error > '${log}'; exit 1`])).code, 0);
  await mkdir(join(dir, 'bin'));
  const binary = (await exec('which', ['tmux'])).stdout.trim();
  await writeFile(join(dir, 'bin/tmux'), `#!/bin/sh\nexec '${binary}' -S '${socket}' "$@"\n`);
  await chmod(join(dir, 'bin/tmux'), 0o755);
  await writeFile(join(dir, '.codex_sessions.json'), JSON.stringify([{
    id: 'exited', tmuxSession: 'codex-exited', source: 'dashboard', workDir: dir, launchLogPath: log, created: Date.now(),
  }]));
  const fastifyUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const script = `
    import Fastify from ${JSON.stringify(fastifyUrl)};
    const { codexSessionsPlugin } = await import(${JSON.stringify(pluginUrl)});
    const app = Fastify();
    await app.register(codexSessionsPlugin, { appServerEnabled: false,
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() } });
    await app.ready();
    const response = await app.inject({ method: 'POST', url: '/api/codex/sessions/exited/startup-input',
      payload: { text: 'Start work', enter: true } });
    console.log(JSON.stringify({ statusCode: response.statusCode, body: response.json() }));
    await app.close();
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: dir, timeout: 15000,
    env: { ...coverageEnv, NODE_TEST_CONTEXT: '1', HOME: dir, PATH: `${dir}/bin:/usr/bin:/bin`,
      CADRE_DISABLE_SIDE_EFFECTS: '1', CADRE_GITHUB_AGENT_POLLER_ENABLED: '0', CADRE_GITHUB_AGENTS_ENABLED: '0',
      CADRE_SCHEDULED_AGENT_PUMP_ENABLED: '0', TELEGRAM_BRIDGE: '0', CADRE_AGENT_CGROUP_ISOLATION: '0',
      APP_STATE_STORAGE: 'file', CODEX_SESSIONS_STORAGE: 'file', LOG_LEVEL: 'error', DATABASE_URL: '' },
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, 'startup_pane_unavailable');
  assert.match(result.body.error, /route-launch-error/);
});

async function runClearScenario({ paneContent, deadlineMs = 5000 }) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-clear-'));
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
    '      printf "› " > "$TMUX_TEST_PANE"',
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

  await writeFile(join(tempDir, '.codex_sessions.json'), JSON.stringify([{
    id: 'codex-clear-1',
    tmuxSession: 'codex-clear-session',
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef.codexSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/codex/sessions/codex-clear-1/clear',
      payload: { deadlineAt: Date.now() + ${deadlineMs} },
    });
    const hookEvents = await readFile(${JSON.stringify(join(tempDir, '.agent_bus', 'hooks', 'codex-codex-clear-1.jsonl'))}, 'utf8').catch(() => '');
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
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runStateTransitionScenario({ initialPaneContent, updatedPaneContent }) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-state-hooks-'));
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

  await writeFile(join(tempDir, '.codex_sessions.json'), JSON.stringify([{
    id: 'codex-hooks-1',
    tmuxSession: 'codex-hooks-session',
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile, writeFile } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef.codexSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    await app.inject({ method: 'GET', url: '/api/codex/sessions/codex-hooks-1' });
    await writeFile(${JSON.stringify(paneFile)}, ${JSON.stringify(updatedPaneContent)});
    await app.inject({ method: 'GET', url: '/api/codex/sessions/codex-hooks-1' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await app.inject({ method: 'GET', url: '/api/codex/sessions/codex-hooks-1' });
    const hookEvents = await readFile(${JSON.stringify(join(tempDir, '.agent_bus', 'hooks', 'codex-codex-hooks-1.jsonl'))}, 'utf8').catch(() => '');
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
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runInputPendingListScenario({
  afterSendPaneContent = null,
  promptText = 'Proceed',
  deadlineAt = null,
  waitForState = null,
} = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-pending-input-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  const paneFile = join(tempDir, 'pane.txt');
  const bufferFile = join(tempDir, 'buffer.txt');
  await mkdir(binDir, { recursive: true });
  await writeFile(paneFile, [
    'Previous work complete.',
    '────────────────────────────────────────────────────────────────────────────────',
    '› ',
    'gpt-5.4 medium · 72% left · ~/project',
  ].join('\n'));
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'cmd="$1"',
    'shift',
    'case "$cmd" in',
    '  list-sessions)',
    '    printf "codex-pending-1\\t123\\t0\\n"',
    '    exit 0',
    '    ;;',
    '  display-message)',
    '    printf "%s\\n" "$TMUX_TEST_WORKDIR"',
    '    exit 0',
    '    ;;',
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
    '    exit 0',
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  await writeFile(join(binDir, 'pgrep'), '#!/bin/sh\nexit 1\n');
  await chmod(join(binDir, 'tmux'), 0o755);
  await chmod(join(binDir, 'pgrep'), 0o755);

  await writeFile(join(tempDir, '.codex_sessions.json'), JSON.stringify([{
    id: 'pending-1',
    tmuxSession: 'codex-pending-1',
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile, writeFile, rename } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const broadcasts = [];
    const app = Fastify();
    await app.register(pluginRef.codexSessionsPlugin, {
      wsManager: { broadcast(channel, type, data) { broadcasts.push({ channel, type, data }); }, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const before = await app.inject({ method: 'GET', url: '/api/codex/sessions' });
    const send = await app.inject({ method: 'POST', url: '/api/codex/sessions/pending-1/input', payload: { text: ${JSON.stringify(promptText)}, enter: true, deadlineAt: ${JSON.stringify(deadlineAt)} } });
    if (${JSON.stringify(afterSendPaneContent)} !== null) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const buffered = await readFile(${JSON.stringify(bufferFile)}, 'utf8').catch(() => '');
        if (buffered === ${JSON.stringify(promptText)}) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
      // Publish a complete pane snapshot while the command gate polls fake tmux.
      await writeFile(${JSON.stringify(paneFile + '.tmp')}, ${JSON.stringify(afterSendPaneContent)});
      await rename(${JSON.stringify(paneFile + '.tmp')}, ${JSON.stringify(paneFile)});
      await app.inject({ method: 'GET', url: '/api/codex/sessions/pending-1' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await app.inject({ method: 'GET', url: '/api/codex/sessions/pending-1' });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    let after = null;
    let waitMatched = ${JSON.stringify(waitForState)} === null;
    if (${JSON.stringify(waitForState)} !== null) {
      // Full c8 runs instrument the child process too; retain the exact state
      // assertion while allowing enough polling headroom for that overhead.
      for (let attempt = 0; attempt < 160; attempt += 1) {
        after = await app.inject({ method: 'GET', url: '/api/codex/sessions' });
        if (after.statusCode === 200 && after.json().sessions[0]?.state?.state === ${JSON.stringify(waitForState)}) {
          waitMatched = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } else {
      after = await app.inject({ method: 'GET', url: '/api/codex/sessions' });
    }
    await app.close();
    console.log(JSON.stringify({
      before: before.json(),
      send: { statusCode: send.statusCode, body: send.json() },
      after: after.json(),
      waitMatched,
      broadcasts,
    }));
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
      TMUX_TEST_WORKDIR: tempDir,
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runMissingPaneDetailScenario() {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-ended-'));
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
    '    echo "can\\047t find pane: codex-ended-session" >&2',
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

  await writeFile(join(tempDir, '.codex_sessions.json'), JSON.stringify([{
    id: 'codex-ended-1',
    tmuxSession: 'codex-ended-session',
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef.codexSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/codex/sessions/codex-ended-1' });
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
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runMissingPaneListScenario() {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-ended-list-'));
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
    '    echo "can\\047t find pane: codex-ended-session" >&2',
    '    exit 1',
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  await writeFile(join(binDir, 'pgrep'), '#!/bin/sh\nexit 1\n');
  await chmod(join(binDir, 'tmux'), 0o755);
  await chmod(join(binDir, 'pgrep'), 0o755);

  await writeFile(join(tempDir, '.codex_sessions.json'), JSON.stringify([{
    id: 'codex-ended-1',
    tmuxSession: 'codex-ended-session',
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef.codexSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/codex/sessions' });
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
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runMissingTmuxDeleteScenario({
  id = 'codex-stale-1',
  tmuxSession = 'codex-stale-session',
  stderr = "can't find session: codex-stale-session",
} = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-stale-delete-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  const storeFile = join(tempDir, '.codex_sessions.json');
  const migratedStoreFile = join(tempDir, '.dueno', 'state', 'codex_sessions.json');
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
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const credentialModuleUrl = pathToFileURL(resolve('modules/agent-bus/mcp-auth.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const { AgentBusCredentialStore } = await import(${JSON.stringify(credentialModuleUrl)});
    let credentialState = null;
    const credentialStore = new AgentBusCredentialStore({
      mode: 'issue_only',
      store: {
        mode: 'memory',
        async load() { return credentialState; },
        async save(next) { credentialState = structuredClone(next); },
      },
    });
    const issued = await credentialStore.issue({
      principal: { type: 'agent', kind: 'codex', sessionId: ${JSON.stringify(id)} },
      attemptGeneration: 1,
    });
    const app = Fastify();
    await app.register(pluginRef.codexSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
      credentialStore,
    });
    await app.ready();
    const response = await app.inject({ method: 'DELETE', url: ${JSON.stringify(`/api/codex/sessions/${id}`)} });
    const stored = JSON.parse(await readFile(${JSON.stringify(migratedStoreFile)}, 'utf8'));
    const credentialAuth = await credentialStore.authenticate(issued.token);
    await app.close();
    console.log(JSON.stringify({
      statusCode: response.statusCode,
      body: response.json(),
      stored,
      credentialReason: credentialAuth.reason || null,
      credentialActive: credentialAuth.ok === true,
    }));
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
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runDeadPaneDeleteScenario() {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-dead-pane-delete-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  const storeFile = join(tempDir, '.codex_sessions.json');
  const killedFile = join(tempDir, 'killed');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'case "$1" in',
    '  list-sessions) printf "codex-dead-pane-1\\t1\\t0\\t99999999\\t/tmp\\n" ;;',
    '  list-panes) printf "99999999\\t1\\n" ;;',
    '  kill-session) : > "$TMUX_KILLED_FILE" ;;',
    '  has-session)',
    '    if [ -f "$TMUX_KILLED_FILE" ]; then echo "session not found: codex-dead-pane-1" >&2; exit 1; fi',
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  await writeFile(join(binDir, 'pgrep'), '#!/bin/sh\nexit 1\n');
  await chmod(join(binDir, 'tmux'), 0o755);
  await chmod(join(binDir, 'pgrep'), 0o755);
  await writeFile(storeFile, JSON.stringify([{
    id: 'dead-pane-1',
    tmuxSession: 'codex-dead-pane-1',
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef.codexSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({ method: 'DELETE', url: '/api/codex/sessions/dead-pane-1' });
    const killed = await readFile(${JSON.stringify(killedFile)}, 'utf8').then(() => true, () => false);
    await app.close();
    console.log(JSON.stringify({ statusCode: response.statusCode, body: response.json(), killed }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], {
    cwd: resolve('.'),
    env: {
      ...coverageEnv,
      NODE_TEST_CONTEXT: '1',
      HOME: tempDir,
      CADRE_AGENT_CGROUP_ISOLATION: '0',
      PATH: `${binDir}:/usr/bin:/bin`,
      TMUX_KILLED_FILE: killedFile,
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runNoTmuxServerListScenario() {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-no-tmux-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  const storeFile = join(tempDir, '.codex_sessions.json');
  const migratedStoreFile = join(tempDir, '.dueno', 'state', 'codex_sessions.json');
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
    id: 'codex-preserve-1',
    tmuxSession: 'codex-preserve-session',
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef.codexSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/codex/sessions' });
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
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runOrphanMetadataRecoveryScenario({ liveTmux = true } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-orphan-recovery-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  const migratedStoreFile = join(tempDir, '.dueno', 'state', 'codex_sessions.json');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'case "$1" in',
    liveTmux
      ? '  list-sessions) printf "codex-recover-1\\t1\\t0\\t123\\t/tmp\\n" ;;'
      : '  list-sessions) exit 0 ;;',
    '  capture-pane) printf "Recovered pane.\\n› " ;;',
    '  list-panes) printf "123\\t0\\n" ;;',
    '  has-session) exit 1 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  await chmod(join(binDir, 'tmux'), 0o755);
  await writeFile(join(tempDir, '.codex_sessions.json'), JSON.stringify([{
    id: 'recover-1',
    tmuxSession: 'codex-recover-1',
    source: 'orphan-process',
    workDir: tempDir,
    created: Date.now(),
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef.codexSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/codex/sessions' });
    const stored = JSON.parse(await readFile(${JSON.stringify(migratedStoreFile)}, 'utf8'));
    await app.close();
    console.log(JSON.stringify({
      statusCode: response.statusCode,
      body: response.json(),
      stored,
    }));
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
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runPruneHasSessionListScenario({
  id = 'codex-prune-1',
  tmuxSession = 'codex-prune-session',
  source = 'dashboard',
  hasSessionCode = 1,
  hasSessionStderr = "can't find session: codex-prune-session",
} = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-prune-has-session-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  const storeFile = join(tempDir, '.codex_sessions.json');
  const migratedStoreFile = join(tempDir, '.dueno', 'state', 'codex_sessions.json');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'if [ "$1" = "list-sessions" ]; then exit 0; fi',
    'if [ "$1" = "has-session" ]; then',
    `  echo ${JSON.stringify(hasSessionStderr)} >&2`,
    `  exit ${Number(hasSessionCode)}`,
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
    source,
    workDir: tempDir,
    created: Date.now(),
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const credentialModuleUrl = pathToFileURL(resolve('modules/agent-bus/mcp-auth.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const { AgentBusCredentialStore } = await import(${JSON.stringify(credentialModuleUrl)});
    let credentialState = null;
    const credentialStore = new AgentBusCredentialStore({
      mode: 'issue_only',
      store: {
        mode: 'memory',
        async load() { return credentialState; },
        async save(next) { credentialState = structuredClone(next); },
      },
    });
    const issued = await credentialStore.issue({
      principal: { type: 'agent', kind: 'codex', sessionId: ${JSON.stringify(id)} },
      attemptGeneration: 1,
    });
    const app = Fastify();
    await app.register(pluginRef.codexSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
      credentialStore,
    });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/codex/sessions' });
    const stored = JSON.parse(await readFile(${JSON.stringify(migratedStoreFile)}, 'utf8'));
    const credentialAuth = await credentialStore.authenticate(issued.token);
    await app.close();
    console.log(JSON.stringify({
      statusCode: response.statusCode,
      body: response.json(),
      stored,
      credentialReason: credentialAuth.reason || null,
      credentialActive: credentialAuth.ok === true,
    }));
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
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runLifecycleCleanupScenario({ failWorktreeRemove = false, scratch = null } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-lifecycle-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const scratchRoot = join(tempDir, 'github', 'scratch');
  const scratchParent = join(scratchRoot, 'octo-demo');
  const scratchPath = join(scratchParent, 'issue-14-10000');
  const outside = join(tempDir, 'outside', 'octo-demo', 'issue-14-10000');
  const workDir = scratch === 'escape' ? join(tempDir, 'github', 'issue-14-10000')
    : scratch === 'invalid-name' ? join(scratchParent, 'issue-14-bad')
    : scratch ? (scratch === 'outside' ? outside : scratchPath) : join(tempDir, 'worktree');
  await mkdir(outside, { recursive: true });
  if (scratch === 'parent-symlink') {
    await mkdir(scratchRoot, { recursive: true });
    await symlink(join(tempDir, 'outside', 'octo-demo'), scratchParent);
  } else {
    await mkdir(scratchParent, { recursive: true });
    if (scratch === 'symlink') await symlink(outside, scratchPath);
    else await mkdir(scratchPath);
  }
  await writeFile(join(outside, 'keep'), 'keep');
  if (scratch === 'nonempty') await writeFile(join(scratchParent, 'keep'), 'keep');
  if (['invalid-name', 'escape'].includes(scratch)) await mkdir(workDir);

  const binDir = join(tempDir, 'bin');
  const launchLog = join(tempDir, 'agent.log');
  const gitLog = join(tempDir, 'git.log');
  const tmuxLog = join(tempDir, 'tmux.log');
  const scheduledStoreFile = join(tempDir, '.dueno', 'state', 'codex_scheduled_sends.json');
  const sessionsStoreFile = join(tempDir, '.codex_sessions.json');
  await mkdir(binDir, { recursive: true });
  await writeFile(launchLog, 'startup failed once');
  const initialPromptFile = join(tempDir, '.dueno', 'state', 'initial_prompts', 'codex-codex-clean-1.txt');
  await mkdir(join(initialPromptFile, '..'), { recursive: true });
  await writeFile(initialPromptFile, 'Starting task');
  const { paths: hookPaths } = await recordHookPayload({ session_id: 'native-clean-1', cwd: workDir, hook_event_name: 'Stop' }, { provider: 'codex', duenoSessionId: 'codex-clean-1' });
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    `printf "%s\\n" "$*" >> ${JSON.stringify(tmuxLog)}`,
    'if [ "$1" = "has-session" ]; then echo "session not found: codex-clean-session" >&2; exit 1; fi',
    'exit 0',
    '',
  ].join('\n'));
  await writeFile(join(binDir, 'pgrep'), '#!/bin/sh\nexit 1\n');
  await writeFile(join(binDir, 'git'), [
    '#!/bin/sh',
    `printf "%s\\n" "$*" >> ${JSON.stringify(gitLog)}`,
    'if [ "$3" = "rev-parse" ] && [ "$4" = "--show-toplevel" ]; then echo "/repo/source"; exit 0; fi',
    failWorktreeRemove ? 'if [ "$3" = "worktree" ] && [ "$4" = "remove" ]; then echo "worktree remove failed" >&2; exit 1; fi' : '',
    'exit 0',
    '',
  ].join('\n'));
  await chmod(join(binDir, 'tmux'), 0o755);
  await chmod(join(binDir, 'pgrep'), 0o755);
  await chmod(join(binDir, 'git'), 0o755);
  await writeFile(sessionsStoreFile, JSON.stringify([{
    id: 'codex-clean-1',
    tmuxSession: 'codex-clean-session',
    source: 'dashboard',
    workDir,
    metadata: scratch ? { github_repo: scratch === 'escape' ? '..' : 'octo/demo', github_kind: 'issue', github_number: 14 } : {},
    created: Date.now(),
    launchLogPath: launchLog,
    managedWorktree: !scratch,
    worktreeRepoPath: '/repo/source',
    worktreePath: join(tempDir, 'worktree'),
    worktreeBranch: 'dueno-fleet/agent/cleanup-test',
  }], null, 2));
  await mkdir(join(tempDir, '.dueno', 'state'), { recursive: true });
  await writeFile(scheduledStoreFile, JSON.stringify([{
    sendId: 'ss_cleanup',
    sessionId: 'codex-clean-1',
    text: 'later',
    sendAt: new Date(Date.now() + 60000).toISOString(),
    createdAt: new Date().toISOString(),
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile, stat, lstat } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify({ logger: false });
    await app.register(pluginRef.codexSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({ method: 'DELETE', url: '/api/codex/sessions/codex-clean-1' });
    for (let i = 0; i < 100; i++) {
      const log = await readFile(${JSON.stringify(gitLog)}, 'utf8').catch(() => '');
      const logGone = await readFile(${JSON.stringify(launchLog)}, 'utf8').then(() => false, () => true);
      const hookGone = await readFile(${JSON.stringify(hookPaths.statePath)}, 'utf8').then(() => false, () => true);
      const artifactsDone = ${JSON.stringify(scratch)}
        ? ${JSON.stringify(scratch === 'valid' || scratch === 'nonempty')}
          ? !(await lstat(${JSON.stringify(scratchPath)}).then(() => true, () => false)) : i > 10
        : log.includes(${JSON.stringify(failWorktreeRemove ? 'worktree remove' : 'worktree prune')});
      if (logGone && hookGone && artifactsDone) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const initialPromptGone = await readFile(${JSON.stringify(initialPromptFile)}, 'utf8').then(() => false, () => true);
    const launchLogGone = await readFile(${JSON.stringify(launchLog)}, 'utf8').then(() => false, () => true);
    const gitCommands = await readFile(${JSON.stringify(gitLog)}, 'utf8').catch(() => '');
    const tmuxCommands = await readFile(${JSON.stringify(tmuxLog)}, 'utf8').catch(() => '');
    const scheduled = JSON.parse(await readFile(${JSON.stringify(scheduledStoreFile)}, 'utf8'));
    const stored = JSON.parse(await readFile(${JSON.stringify(join(tempDir, '.dueno', 'state', 'codex_sessions.json'))}, 'utf8').catch(() => '[]'));
    await app.close();
    const hooksGone = await Promise.all([${JSON.stringify(hookPaths.eventsPath)}, ${JSON.stringify(hookPaths.statePath)}].map((path) => readFile(path, 'utf8').then(() => false, () => true)));
    const scratchExists = await lstat(${JSON.stringify(scratchPath)}).then(() => true, () => false);
    const parentExists = await lstat(${JSON.stringify(scratchParent)}).then(() => true, () => false);
    const outsideKept = await readFile(${JSON.stringify(join(outside, 'keep'))}, 'utf8');
    const workDirExists = await lstat(${JSON.stringify(workDir)}).then(() => true, () => false);
    console.log(JSON.stringify({ scratchExists, parentExists, outsideKept, workDirExists, statusCode: response.statusCode, body: response.json(), initialPromptGone, launchLogGone, hooksGone, gitCommands, tmuxCommands, scheduled, stored }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], {
    cwd: resolve('.'),
    env: {
      ...coverageEnv,
      NODE_TEST_CONTEXT: '1',
      HOME: tempDir,
      CADRE_AGENT_CGROUP_ISOLATION: '0',
      PATH: `${binDir}:/usr/bin:/bin`,
      DM_GITHUB_AGENT_WORKDIR: join(tempDir, 'github'),
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runStartupFailureLaunchLogScenario() {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-startup-log-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'if [ "$1" = "new-session" ]; then echo "spawn failed" >&2; exit 1; fi',
    'exit 0',
    '',
  ].join('\n'));
  await chmod(join(binDir, 'tmux'), 0o755);

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readdir } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify({ logger: false });
    await app.register(pluginRef.codexSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/codex/sessions',
      payload: { workDir: ${JSON.stringify(tempDir)} },
    });
    const launchLogs = await readdir(${JSON.stringify(join(tempDir, '.dueno', 'state', 'agent_launch_logs'))}).catch(() => []);
    await app.close();
    console.log(JSON.stringify({ statusCode: response.statusCode, body: response.json(), launchLogs }));
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
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runEmptyCreateAuditScenario(payload = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-empty-create-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const eventsFile = join(tempDir, '.dueno', 'state', 'ops_control_events.json');
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify({ logger: false });
    await app.register(pluginRef.codexSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/codex/sessions',
      payload: ${JSON.stringify(payload)},
      headers: { 'user-agent': 'empty-create-test' },
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    const events = JSON.parse(await readFile(${JSON.stringify(eventsFile)}, 'utf8'));
    await app.close();
    console.log(JSON.stringify({ statusCode: response.statusCode, body: response.json(), events }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], {
    cwd: resolve('.'),
    env: {
      ...coverageEnv,
      NODE_TEST_CONTEXT: '1',
      HOME: tempDir,
      CADRE_AGENT_CGROUP_ISOLATION: '0',
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runScheduledSendPersistenceScenario() {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-scheduled-persist-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  const scheduledStoreFile = join(tempDir, '.dueno', 'state', 'codex_scheduled_sends.json');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'tmux'), '#!/bin/sh\nexit 0\n');
  await chmod(join(binDir, 'tmux'), 0o755);
  await writeFile(join(tempDir, '.codex_sessions.json'), JSON.stringify([{
    id: 'codex-sched-1',
    tmuxSession: 'codex-sched-session',
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
  }], null, 2));
  await mkdir(join(tempDir, '.dueno', 'state'), { recursive: true });
  await writeFile(scheduledStoreFile, JSON.stringify([{
    sendId: 'ss_persisted',
    sessionId: 'codex-sched-1',
    text: 'persisted send',
    sendAt: new Date(Date.now() + 60000).toISOString(),
    createdAt: new Date().toISOString(),
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify({ logger: false });
    await app.register(pluginRef.codexSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/codex/sessions/codex-sched-1/scheduled-sends' });
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
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runBareProcessPruneScenario() {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-bare-prune-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  const migratedStoreFile = join(tempDir, '.dueno', 'state', 'codex_sessions.json');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'if [ "$1" = "list-sessions" ]; then exit 0; fi',
    'exit 0',
    '',
  ].join('\n'));
  await writeFile(join(binDir, 'pgrep'), '#!/bin/sh\nexit 1\n');
  await chmod(join(binDir, 'tmux'), 0o755);
  await chmod(join(binDir, 'pgrep'), 0o755);
  await writeFile(join(tempDir, '.codex_sessions.json'), JSON.stringify([{
    id: 'bare-dead',
    pid: '999999',
    source: 'bare-process',
    workDir: tempDir,
    created: Date.now(),
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify({ logger: false });
    await app.register(pluginRef.codexSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/codex/sessions?includeReadOnly=true' });
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
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runHookReconcileScenario({
  paneContent = 'Completed pass.\n› ',
  hook = null,
  genuineHookEventName = '',
  captureFails = false,
} = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-hook-reconcile-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  const paneFile = join(tempDir, 'pane.txt');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(tempDir, '.agent_bus', 'hooks', 'state'), { recursive: true });
  await writeFile(paneFile, paneContent);
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'cmd="$1"',
    'shift',
    'case "$cmd" in',
    '  capture-pane)',
    captureFails
      ? '    echo "can\\047t find pane: codex-hook-session" >&2; exit 1'
      : '    cat "$TMUX_TEST_PANE"; exit 0',
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

  if (hook) {
    await writeFile(join(tempDir, '.agent_bus', 'hooks', 'state', 'codex-codex-hook-1.json'), JSON.stringify({ hook }, null, 2));
  }
  if (genuineHookEventName) {
    await recordHookPayload({
      session_id: 'cli-codex-uuid',
      cwd: tempDir,
      hook_event_name: genuineHookEventName,
    }, { provider: 'codex', duenoSessionId: 'codex-hook-1' });
  }

  await writeFile(join(tempDir, '.codex_sessions.json'), JSON.stringify([{
    id: 'codex-hook-1',
    tmuxSession: 'codex-hook-session',
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
    provider: 'codex',
    runtime: 'codex',
  }], null, 2));

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef.codexSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({ method: 'GET', url: '/api/codex/sessions/codex-hook-1' });
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
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
    },
  });
  return JSON.parse(stdout.trim());
}

async function runCreateCommandScenario({
  workDir,
  provider = 'codex',
  model = '',
  promptProfile = '',
  codexPlugins,
  scopeIsolation = false,
  staleTmuxSocket = false,
} = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-create-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  const tmuxArgsFile = join(tempDir, 'tmux-args.txt');
  await mkdir(binDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n');
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'if [ -n "$TMUX_MUST_BE_UNSET" ] && [ -n "$TMUX" ]; then echo "stale inherited tmux socket" >&2; exit 17; fi',
    'if [ "$1" = "has-session" ]; then',
    '  exit 0',
    'fi',
    'printf "%s\\n" "$@" > "$TMUX_TEST_ARGS"',
    'exit 0',
    '',
  ].join('\n'));
  await chmod(join(binDir, 'codex'), 0o755);
  await chmod(join(binDir, 'tmux'), 0o755);

  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const wrapped = `
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    await pluginRef.createCodexSession({
      workDir: ${JSON.stringify(workDir)},
      args: ['Initial prompt text'],
      provider: ${JSON.stringify(provider)},
      model: ${JSON.stringify(model)},
      promptProfile: ${JSON.stringify(promptProfile)},
      codexPlugins: ${JSON.stringify(codexPlugins)},
      source: 'test',
    });
  `;

  await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], {
    cwd: resolve('.'),
    env: {
      ...coverageEnv,
      NODE_TEST_CONTEXT: '1',
      HOME: tempDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMUX_TEST_ARGS: tmuxArgsFile,
      ...(staleTmuxSocket ? {
        TMUX: `${join(tempDir, 'missing-tmux-socket')},123,0`,
        TMUX_PANE: '%1',
        TMUX_MUST_BE_UNSET: '1',
      } : {}),
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
      AGENT_BUS_MCP_HTTP_HOST: '127.0.0.1',
      AGENT_BUS_MCP_HTTP_PORT: '9876',
      AGENT_BUS_MCP_HTTP_PATH: '/mcp',
      CADRE_AGENT_CGROUP_ISOLATION: scopeIsolation ? '1' : '0',
    },
  });

  return readFile(tmuxArgsFile, 'utf8');
}

async function runResumeScenario({
  cliSessionId = '11111111-2222-3333-4444-555555555555',
  businessOsMcp = false,
  researchWorkbench = false,
  storedMcpCapabilities = null,
  mcpCredentialProfile = 'agent',
  codexPlugins,
} = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-codex-resume-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  const tmuxArgsFile = join(tempDir, 'tmux-resume-args.txt');
  const sessionMarker = join(tempDir, 'tmux-session-created');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'codex'), '#!/bin/sh\nexit 0\n');
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'cmd="$1"',
    'shift',
    'case "$cmd" in',
    '  has-session)',
    '    [ -f "$TMUX_SESSION_MARKER" ] && exit 0',
    '    exit 1',
    '    ;;',
    '  new-session)',
    '    printf "%s\\n" "$@" > "$TMUX_TEST_ARGS"',
    '    touch "$TMUX_SESSION_MARKER"',
    '    exit 0',
    '    ;;',
    '  list-sessions)',
    '    [ -f "$TMUX_SESSION_MARKER" ] && printf "codex-resume-session\\t1\\t0\\t123\\t%s\\n" "$PWD"',
    '    exit 0',
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  await chmod(join(binDir, 'codex'), 0o755);
  await chmod(join(binDir, 'tmux'), 0o755);

  await writeFile(join(tempDir, '.codex_sessions.json'), JSON.stringify([{
    id: 'codex-resume-1',
    tmuxSession: 'codex-resume-session',
    source: 'dashboard',
    workDir: tempDir,
    created: Date.now(),
    endedAt: Date.now() - 1000,
    provider: 'codex',
    runtime: 'codex',
    model: 'gpt-5.5',
    thinkingLevel: 'high',
    cliSessionId,
    mcpCredentialProfile,
    ...(codexPlugins ? { codexPlugins } : {}),
    ...(storedMcpCapabilities ? { mcpCapabilities: storedMcpCapabilities } : {}),
    selectedMcpServers: businessOsMcp ? ['businessos'] : [],
    businessOsMcp: businessOsMcp ? {
      serverName: 'businessos',
      type: 'http',
      url: 'http://127.0.0.1:9876/businessos-test/old-capability',
    } : null,
    metadata: researchWorkbench ? {
      researchWorkbench: { profileId: 'research-workbench-v1' },
    } : {},
  }], null, 2));

  const { paths: hookPaths } = await recordHookPayload({ session_id: cliSessionId, cwd: tempDir, hook_event_name: 'Stop' }, { provider: 'codex', duenoSessionId: 'codex-resume-1' });
  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/codex-sessions.mjs')).href;
  const authModuleUrl = pathToFileURL(resolve('modules/agent-bus/mcp-auth.mjs')).href;
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const { AgentBusCredentialStore } = await import(${JSON.stringify(authModuleUrl)});
    let credentialState = null;
    const credentialStore = new AgentBusCredentialStore({
      mode: 'issue_only',
      store: {
        mode: 'memory',
        async load() { return credentialState; },
        async save(next) { credentialState = structuredClone(next); },
        async close() {},
      },
    });
    const credentialPrincipal = ${JSON.stringify(mcpCredentialProfile)} === 'fleet-supervisor'
      ? { type: 'service', kind: 'fleet-supervisor', sessionId: 'codex-resume-1' }
      : { type: 'agent', kind: 'codex', sessionId: 'codex-resume-1' };
    const oldIssued = await credentialStore.issue({
      principal: credentialPrincipal,
      attemptGeneration: 1,
    });
    const app = Fastify();
    await app.register(pluginRef.codexSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
      credentialStore,
    });
    await app.ready();
    const response = await app.inject({ method: 'POST', url: '/api/codex/sessions/codex-resume-1/resume' });
    const { createHookEventRetention } = await import(${JSON.stringify(pathToFileURL(resolve('modules/agent/hook-events.mjs')).href)});
    const { buildPostgresJsonStore } = await import(${JSON.stringify(pathToFileURL(resolve('modules/ops/postgres-json-store.mjs')).href)});
    const retention = createHookEventRetention({ retentionDays: 0, store: buildPostgresJsonStore({ namespace: 'hook_roots', filePath: ${JSON.stringify(join(tempDir, 'hook-roots.json'))} }) });
    await retention.sweep();
    await retention.close();
    const hooksKept = await Promise.all([${JSON.stringify(hookPaths.eventsPath)}, ${JSON.stringify(hookPaths.statePath)}].map((path) => readFile(path, 'utf8').then(() => true, () => false)));
    const tmuxArgs = await readFile(${JSON.stringify(tmuxArgsFile)}, 'utf8').catch(() => '');
    const stored = JSON.parse(await readFile(${JSON.stringify(join(tempDir, '.dueno', 'state', 'codex_sessions.json'))}, 'utf8'));
    const newToken = await readFile(${JSON.stringify(join(tempDir, '.dueno', 'state', 'mcp_client_configs', 'codex-codex-resume-1.token'))}, 'utf8').catch(() => '');
    const oldAuth = await credentialStore.authenticate(oldIssued.token);
    const newAuth = newToken.trim() ? await credentialStore.authenticate(newToken.trim()) : null;
    const activeCredential = credentialStore.credentialFor(credentialPrincipal);
    await app.close();
    console.log(JSON.stringify({
      statusCode: response.statusCode,
      body: response.json(),
      tmuxArgs,
      hooksKept,
      stored: stored[0],
      newCredential: newAuth ? {
        principal: newAuth.principal,
        threadAllowlist: newAuth.threadAllowlist,
        toolScopes: newAuth.toolScopes,
      } : null,
      credentialRotation: {
        oldReason: oldAuth.reason,
        newAuthenticated: newAuth ? newAuth.ok === true : null,
        oldJtiChanged: activeCredential?.jti !== oldIssued.credential.jti,
        generation: activeCredential?.attemptGeneration || null,
      },
    }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], {
    cwd: resolve('.'),
    env: {
      ...coverageEnv,
      NODE_TEST_CONTEXT: '1',
      HOME: tempDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMUX_TEST_ARGS: tmuxArgsFile,
      TMUX_SESSION_MARKER: sessionMarker,
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
      BUSINESSOS_MCP_URL: 'https://businessos.example.test/api/agent-mcp',
      BUSINESSOS_MCP_OPERATOR_TOKEN: 'bos-test-token',
      BUSINESSOS_MCP_PROXY_PATH_PREFIX: '/businessos-test',
      BUSINESSOS_MCP_STATE_FILE: join(tempDir, 'businessos-mcp-state.json'),
      AGENT_BUS_MCP_HTTP_HOST: '127.0.0.1',
      AGENT_BUS_MCP_HTTP_PORT: '9876',
      CADRE_AGENT_CGROUP_ISOLATION: '0',
      ...(researchWorkbench ? {
        RESEARCH_WORKBENCH_PLUGIN_REF: 'research-workbench@personal',
        RESEARCH_WORKBENCH_ZOTERO_MCP_PATH: process.execPath,
        RESEARCH_WORKBENCH_NODUS_MCP_PATH: process.execPath,
        RESEARCH_WORKBENCH_PAPER_SEARCH_PATH: process.execPath,
        RESEARCH_WORKBENCH_NODUS_TOKEN_FILE: process.execPath,
      } : {}),
    },
  });
  return JSON.parse(stdout.trim());
}

describe('Codex Sessions module', () => {
  it('does not classify a visible prompt as waiting when the tail still shows active work', async () => {
    const { detectState } = await import('../modules/sessions/codex-state-detector.mjs');
    const state = detectState([
      'tab to queue message                                        99% context left',
      '• Working (14s • esc to interrupt)',
      '› ',
    ].join('\n'));

    assert.equal(state.state, 'working');
    assert.equal(state.needsInput, false);
  });

  it('should be importable without errors', async () => {
    const mod = await import('../modules/sessions/codex-sessions.mjs');
    assert.equal(typeof mod.codexSessionsPlugin, 'function');
  });

  it('passes route-supplied metadata into persisted session creation', async () => {
    const source = await readFile(resolve('modules/sessions/index.mjs'), 'utf8');
    assert.match(source, /const \{ workDir, args, model, provider, runtime, thinkingLevel, displayName, initialPrompt, metadata, mcpProfile, mcpServers, codexPlugins, promptProfile, skills \} = body/);
    assert.match(source, /displayName,\n\s+metadata: trustedMetadata,\n\s+coordinatorPolicy: scheduledCoordinatorLaunch \? requestCoordinatorPolicy : null,\n\s+loopRegistrationPolicy,\n\s+mcpProfile,\n\s+mcpServers,\n\s+codexPlugins,\n\s+promptProfile,\n\s+skills/);
    assert.match(source, /resumeSession\(id, \{\n\s+loopRegistrationPolicy: operatorResumeLoopRegistrationPolicy\(/);
    assert.match(source, /operatorResumeLoopRegistrationPolicy/);
    assert.doesNotMatch(source, /loopRegistrationPolicy: operatorLoopRegistrationPolicy\(req\.duenoAuth\?\.principal\)/);
  });

  it('rejects caller-supplied MCP launch overrides, including whitespace variants', async () => {
    const source = await readFile(resolve('modules/sessions/index.mjs'), 'utf8');
    assert.match(source, /mcp_servers\(\?:\\s\|\\\.\|=\|\$\)/);
    assert.match(source, /--\(\?:strict-\)\?mcp-config/);
    assert.match(source, /assertNoCallerPromptOverrides/);
    assert.match(source, /prompt_launch_override_forbidden/);
  });

  it('marks spawned Codex workspaces trusted before passing the prompt', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-codex-workdir-'));
    tempDirs.push(workDir);
    const tmuxArgs = await runCreateCommandScenario({ workDir });

    assert.match(tmuxArgs, /--dangerously-bypass-approvals-and-sandbox/);
    assert.match(tmuxArgs, /export DUENO_SESSION_ID='[a-f0-9]+'/);
    assert.match(tmuxArgs, /export DUENO_PROVIDER='codex'/);
    assert.match(tmuxArgs, new RegExp(`'--cd' '${workDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    assert.match(tmuxArgs, new RegExp(`projects\\."${workDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\.trust_level="trusted"`));
    assert.match(tmuxArgs, /Initial prompt text/);
    assert.match(tmuxArgs, /'mcp_servers=\{\}'/);
    assert.match(tmuxArgs, /plugins\."browser@openai-bundled"\.enabled=false/);
    assert.doesNotMatch(tmuxArgs, /mcp_servers\.dueno/);
    assert.doesNotMatch(tmuxArgs, /developer_instructions=/);
    await assert.rejects(readFile(join(workDir, '.codex', 'config.toml'), 'utf8'), /ENOENT/);
  });

  it('lets a Codex session opt back into the default-excluded browser plugin', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-codex-browser-plugin-'));
    tempDirs.push(workDir);
    const tmuxArgs = await runCreateCommandScenario({
      workDir,
      codexPlugins: { add: ['browser@openai-bundled'] },
    });

    assert.match(tmuxArgs, /plugins\."browser@openai-bundled"\.enabled=true/);
    assert.match(tmuxArgs, /'mcp_servers=\{\}'/);
    assert.match(tmuxArgs, /Initial prompt text/);
  });

  it('launches Codex sessions through a dedicated systemd scope', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-codex-scoped-'));
    tempDirs.push(workDir);
    const tmuxArgs = await runCreateCommandScenario({ workDir, scopeIsolation: true });

    assert.match(tmuxArgs, /exec systemd-run --user --scope --quiet --collect/);
    assert.match(tmuxArgs, /--unit=dueno-agent-codex-[a-f0-9]+/);
    assert.match(tmuxArgs, /--slice=dueno-agents\.slice/);
    assert.match(tmuxArgs, /--property=KillMode=control-group/);
  });

  it('starts a session when the service inherited a vanished tmux socket', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-codex-stale-tmux-workdir-'));
    tempDirs.push(workDir);
    const tmuxArgs = await runCreateCommandScenario({ workDir, staleTmuxSocket: true });

    assert.match(tmuxArgs, /^new-session/m);
  });

  it('passes selected prompt profiles as Codex developer instructions', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-codex-style-'));
    tempDirs.push(workDir);
    const tmuxArgs = await runCreateCommandScenario({ workDir, promptProfile: 'research' });
    assert.match(tmuxArgs, /developer_instructions=/);
    assert.match(tmuxArgs, /research agent/);
  });

  it('builds Codex trust config from the shared agent runtime harness layer', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-codex-runtime-'));
    tempDirs.push(workDir);
    const {
      buildAgentRuntimeLaunchArgs,
      buildClaudeLaunchArgs,
      buildCodexLaunchArgs,
      buildCodexPluginConfigArgs,
      trustedCodexProjectConfig,
    } = await import('../modules/agent/runtime-args.mjs');

    const launchArgs = buildCodexLaunchArgs({
      workDir,
      model: 'gpt-5.4',
      thinkingLevel: 'high',
      args: ['Initial prompt text'],
    });

    assert.ok(launchArgs.includes(trustedCodexProjectConfig(workDir)));
    assert.deepEqual(launchArgs.slice(0, 3), ['--dangerously-bypass-approvals-and-sandbox', '--cd', workDir]);
    assert.ok(launchArgs.includes('gpt-5.4'));
    assert.ok(launchArgs.includes('model_reasoning_effort="high"'));
    assert.ok(launchArgs.includes('plugins."browser@openai-bundled".enabled=false'));
    assert.equal(launchArgs.at(-1), 'Initial prompt text');
    assert.deepEqual(launchArgs, buildAgentRuntimeLaunchArgs({
      runtime: 'codex',
      workDir,
      model: 'gpt-5.4',
      thinkingLevel: 'high',
      args: ['Initial prompt text'],
    }));
    assert.deepEqual(buildCodexPluginConfigArgs({
      add: ['browser@openai-bundled'],
      remove: ['browser@openai-bundled', 'sites.ui@openai-bundled'],
    }), [
      '-c',
      'plugins."browser@openai-bundled".enabled=true',
      '-c',
      'plugins."sites.ui@openai-bundled".enabled=false',
    ]);
    assert.deepEqual(buildCodexPluginConfigArgs(undefined), [
      '-c',
      'plugins."browser@openai-bundled".enabled=false',
    ]);
    assert.throws(
      () => buildCodexPluginConfigArgs({ remove: ['browser'] }),
      (error) => error.code === 'codex_plugin_selection_invalid' && error.statusCode === 400,
    );
    assert.throws(
      () => buildCodexPluginConfigArgs({ add: 'browser@openai-bundled' }),
      (error) => error.code === 'codex_plugin_selection_invalid' && error.statusCode === 400,
    );
    assert.throws(
      () => buildCodexPluginConfigArgs({ enabled: ['browser@openai-bundled'] }),
      (error) => error.code === 'codex_plugin_selection_invalid' && error.statusCode === 400,
    );
    assert.throws(
      () => buildCodexPluginConfigArgs({ remove: ['browser@openai-bundled\"={enabled=true}'] }),
      (error) => error.code === 'codex_plugin_selection_invalid' && error.statusCode === 400,
    );
    for (const args of [
      ['-c', 'plugins."browser@openai-bundled".enabled=true'],
      ['--config=plugins["browser@openai-bundled"].enabled=true'],
      ['-c="plugins".browser.enabled=true'],
    ]) {
      assert.throws(
        () => buildCodexLaunchArgs({ workDir, args }),
        (error) => error.code === 'codex_plugin_launch_override_forbidden' && error.statusCode === 400,
      );
    }
    const unrelatedConfigArgs = ['-c', 'features.responses_websockets=true', '--config=model_verbosity="low"'];
    assert.deepEqual(buildCodexLaunchArgs({ workDir, args: unrelatedConfigArgs }).slice(-3), unrelatedConfigArgs);
    assert.equal(buildClaudeLaunchArgs({
      workDir,
      codexPlugins: { remove: ['browser@openai-bundled'] },
    }).some((arg) => String(arg).startsWith('plugins=')), false);
  });

  it('builds provider-specific resume args from the shared runtime harness layer', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-runtime-resume-'));
    tempDirs.push(workDir);
    const { buildCodexResumeArgs, buildClaudeResumeArgs } = await import('../modules/agent/runtime-args.mjs');

    assert.deepEqual(buildCodexResumeArgs({
      workDir,
      model: 'gpt-5.5',
      thinkingLevel: 'high',
      cliSessionId: 'codex-cli-uuid',
    }).slice(-2), ['resume', 'codex-cli-uuid']);

    assert.deepEqual(buildClaudeResumeArgs({
      workDir,
      model: 'claude-opus-4-8',
      thinkingLevel: 'max',
      cliSessionId: 'claude-cli-uuid',
    }).slice(-2), ['--resume', 'claude-cli-uuid']);
  });

  it('uses read-only sandboxing and untrusted approvals for server-owned research launches', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-runtime-research-safe-'));
    tempDirs.push(workDir);
    const { buildCodexLaunchArgs } = await import('../modules/agent/runtime-args.mjs');
    const args = buildCodexLaunchArgs({ workDir, safeRuntime: true });
    assert.deepEqual(args.slice(0, 4), ['--sandbox', 'read-only', '--ask-for-approval', 'untrusted']);
    assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  });

  it('relaunches an ended Codex session with codex resume and the saved CLI session id', async () => {
    const result = await runResumeScenario();

    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(result.body.id, 'codex-resume-1');
    assert.equal(result.body.resumed, true);
    assert.ok(result.stored.resumedAt > result.stored.endedAt);
    assert.deepEqual(result.hooksKept, [true, true]);
    assert.match(result.tmuxArgs, /export DUENO_SESSION_ID='codex-resume-1'/);
    assert.match(result.tmuxArgs, /'resume' '11111111-2222-3333-4444-555555555555'/);
    assert.match(result.tmuxArgs, /'--cd'/);
    assert.equal(result.credentialRotation.oldReason, 'revoked');
    assert.equal(result.credentialRotation.oldJtiChanged, true);
    assert.equal(result.credentialRotation.generation, 2);
  });

  it('persists a Codex plugin opt-in across resume', async () => {
    const codexPlugins = { add: ['browser@openai-bundled'], remove: [] };
    const result = await runResumeScenario({ codexPlugins });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.stored.codexPlugins, codexPlugins);
    assert.match(result.tmuxArgs, /plugins\."browser@openai-bundled"\.enabled=true/);
  });

  it('resumes a Dueno-only snapshot after unrelated BusinessOS availability changes', async () => {
    const resolved = resolveMcpCapabilities({
      request: { mcpProfile: 'dueno' },
      provider: 'codex',
      runtime: 'codex',
      catalog: buildMcpCapabilityCatalog({
        sourceConfig: { mcpCapabilities: {} },
        availabilityById: { dueno: true, businessos: false },
      }),
    });
    const result = await runResumeScenario({
      storedMcpCapabilities: sanitizedMcpSnapshot(resolved, { dueno: { state: 'ready' } }),
    });

    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.deepEqual(result.stored.mcpCapabilities.serverIds, ['dueno']);
    assert.deepEqual(result.credentialRotation, {
      oldReason: 'revoked',
      newAuthenticated: true,
      oldJtiChanged: true,
      generation: 2,
    });
  });

  it('preserves the private Fleet Supervisor credential profile across resume rotation', async () => {
    const resolved = resolveMcpCapabilities({
      request: { mcpProfile: 'dueno' },
      provider: 'codex',
      runtime: 'codex',
      catalog: buildMcpCapabilityCatalog({
        sourceConfig: { mcpCapabilities: {} },
        availabilityById: { dueno: true },
      }),
    });
    const result = await runResumeScenario({
      mcpCredentialProfile: 'fleet-supervisor',
      storedMcpCapabilities: sanitizedMcpSnapshot(resolved, { dueno: { state: 'ready' } }),
    });

    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(result.stored.mcpCredentialProfile, 'fleet-supervisor');
    assert.deepEqual(result.newCredential.principal, {
      type: 'service', kind: 'fleet-supervisor', sessionId: 'codex-resume-1',
    });
    assert.deepEqual(result.newCredential.threadAllowlist, ['*']);
    assert.equal(result.newCredential.toolScopes.includes('monitor_send_to_session'), true);
    assert.equal(result.newCredential.toolScopes.includes('monitor_terminate_session'), true);
  });

  it('rebuilds selected BusinessOS MCP config when resuming Codex', async () => {
    const result = await runResumeScenario({ businessOsMcp: true });

    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.match(result.tmuxArgs, /mcp_servers\.businessos\.type="http"/);
    assert.match(result.tmuxArgs, /mcp_servers\.businessos\.enabled=true/);
    assert.match(result.tmuxArgs, /mcp_servers\.businessos\.url="http:\/\/127\.0\.0\.1:9876\/businessos-test\/[a-f0-9]{64}"/);
    assert.doesNotMatch(result.tmuxArgs, /old-capability/);
    assert.doesNotMatch(result.tmuxArgs, /bos-test-token/);
    assert.deepEqual(result.stored.mcpCapabilities.serverIds, ['businessos']);
    assert.equal(Object.hasOwn(result.stored, 'businessOsMcp'), false);
    assert.equal(Object.hasOwn(result.stored, 'selectedMcpServers'), false);
    assert.equal(/businessos\.example|old-capability|bos-test-token/.test(JSON.stringify(result.stored.mcpCapabilities)), false);
  });

  it('reapplies the server-owned Research Workbench MCP profile when resuming Codex', async () => {
    const result = await runResumeScenario({ researchWorkbench: true });

    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.match(result.tmuxArgs, /plugins\."research-workbench@personal"\.enabled=true/);
    assert.match(result.tmuxArgs, /mcp_servers\.zotero\.command="node"/);
    assert.match(result.tmuxArgs, /mcp_servers\.zotero\.default_tools_approval_mode="writes"/);
    assert.match(result.tmuxArgs, /mcp_servers\.nodus\.command="node"/);
    assert.match(result.tmuxArgs, /mcp_servers\.nodus\.default_tools_approval_mode="writes"/);
    assert.match(result.tmuxArgs, /mcp_servers\.paper-search\.command=/);
    assert.match(result.tmuxArgs, /mcp_servers\.paper-search\.default_tools_approval_mode="writes"/);
    assert.match(result.tmuxArgs, /mcp_servers\.paper-search\.tools\.list_sources\.approval_mode="approve"/);
    assert.match(result.tmuxArgs, /mcp_servers\.paper-search\.tools\.get_pdf_url\.approval_mode="approve"/);
    assert.doesNotMatch(result.tmuxArgs, /mcp_servers\.paper-search\.tools\.index_(paper|from_query)\.approval_mode/);
    assert.match(result.tmuxArgs, /'--sandbox' 'read-only'/);
    assert.match(result.tmuxArgs, /'--ask-for-approval' 'untrusted'/);
    assert.doesNotMatch(result.tmuxArgs, /dangerously-bypass-approvals-and-sandbox/);
    assert.doesNotMatch(result.tmuxArgs, /RESEARCH_WORKBENCH_FLEET_TOKEN/);
  });

  it('stripCodexIndent removes the uniform two-space gutter while preserving real indent', async () => {
    const { stripCodexIndent } = await import('../modules/sessions/codex-sessions.mjs');
    const input = [
      '  top-level line',
      '    still indented',
      '  ',
      '  • bullet line',
    ].join('\n');
    const expected = [
      'top-level line',
      '  still indented',
      '',
      '• bullet line',
    ].join('\n');
    assert.equal(stripCodexIndent(input), expected);
  });

  it('stripCodexIndent leaves content unchanged when no prefixed spaces exist', async () => {
    const { stripCodexIndent } = await import('../modules/sessions/codex-sessions.mjs');
    const input = ['foo', 'bar', ''].join('\n');
    assert.equal(stripCodexIndent(input), input);
  });

  it('confirms a clear request through the dedicated clear endpoint', async () => {
    const result = await runClearScenario({
      paneContent: 'Completed pass.\n› ',
    });

    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.equal(result.body.ok, true);
    assert.equal(result.body.clearConfirmed, true);
    assert.equal(result.body.sessionState, 'waiting_for_input');
    assert.equal(result.body.confirmedContentLength, 2);
    assert.match(result.hookEvents, /"eventName":"SessionClearConfirmed"/);
    assert.match(result.hookEvents, /"eventName":"SessionPromptReadyAfterClear"/);
  });

  it('returns socket-aware attach command when the tmux pane is gone', async () => {
    const result = await runMissingPaneDetailScenario();

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.sessionEnded, true);
    assert.equal(result.body.sessionName, 'codex-ended-session');
    assert.equal(result.body.tmuxSession, 'codex-ended-session');
    assert.equal(result.body.attachCommand, "tmux -S /tmp/tmux-1000/default attach -t 'codex-ended-session'");
    assert.equal(result.body.content, '');
    assert.equal(result.body.state.state, 'ended');
  });

  it('keeps ended persisted sessions in the list view', async () => {
    const result = await runMissingPaneListScenario();

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.sessions.length, 1);
    assert.equal(result.body.sessions[0].id, 'codex-ended-1');
    assert.equal(result.body.sessions[0].sessionEnded, true);
    assert.equal(result.body.sessions[0].resumeBlockedReason, 'cli_session_id_unknown');
  });

  it('cleans up stale Codex metadata when kill finds no tmux session', async () => {
    const result = await runMissingTmuxDeleteScenario();

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.status, 'already_gone');
    assert.deepEqual(result.stored, []);
    assert.equal(result.credentialReason, 'revoked');
  });

  it('cleans up orphan metadata when the tmux socket no longer exists', async () => {
    const result = await runMissingTmuxDeleteScenario({
      stderr: 'error connecting to /tmp/tmux-1000/default (No such file or directory)',
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.status, 'already_gone');
    assert.deepEqual(result.stored, []);
  });

  it('cleans up orphan metadata when tmux reports no server running', async () => {
    const result = await runMissingTmuxDeleteScenario({
      stderr: 'no server running on /tmp/tmux-1000/dm-agent',
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.status, 'already_gone');
    assert.deepEqual(result.stored, []);
  });

  it('mops up a remain-on-exit tmux session whose pane processes are already dead', async () => {
    const result = await runDeadPaneDeleteScenario();

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.status, 'terminated');
    assert.equal(result.killed, true);
  });

  it('preserves Codex metadata when kill fails for a non-stale tmux error', async () => {
    const result = await runMissingTmuxDeleteScenario({
      id: 'codex-error-1',
      tmuxSession: 'codex-error-session',
      stderr: 'permission denied opening tmux socket',
    });

    assert.equal(result.statusCode, 409);
    assert.equal(result.body.status, 'failed');
    assert.equal(result.body.reason, 'tmux_lookup_failed');
    assert.match(result.body.error, /permission denied/);
    assert.equal(result.stored.length, 1);
    assert.equal(result.stored[0].id, 'codex-error-1');
    assert.equal(result.credentialActive, true);
  });

  it('preserves Codex metadata when tmux server is temporarily unavailable', async () => {
    const result = await runNoTmuxServerListScenario();

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.sessions.length, 1);
    assert.equal(result.body.sessions[0].id, 'codex-preserve-1');
    assert.equal(result.body.sessions[0].sessionEnded, true);
    assert.equal(result.stored.length, 1);
    assert.equal(result.stored[0].id, 'codex-preserve-1');
  });

  it('restores orphan metadata when the named tmux session is live', async () => {
    const result = await runOrphanMetadataRecoveryScenario();

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.sessions[0].id, 'recover-1');
    assert.equal(result.body.sessions[0].source, 'dashboard');
    assert.equal(result.stored[0].source, 'dashboard');
  });

  it('drops stored process-only rows when no tmux session exists', async () => {
    const result = await runOrphanMetadataRecoveryScenario({ liveTmux: false });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.sessions, []);
    assert.deepEqual(result.stored, []);
  });

  it('does not revoke credentials when list-sessions omits a still-live tmux session', async () => {
    const result = await runPruneHasSessionListScenario({
      hasSessionCode: 0,
      hasSessionStderr: '',
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.stored.length, 1);
    assert.equal(result.stored[0].id, 'codex-prune-1');
    assert.equal(Boolean(result.stored[0].endedAt), false);
    assert.equal(result.credentialActive, true);
  });

  it('does not revoke credentials when has-session lookup fails after an empty list-sessions', async () => {
    const result = await runPruneHasSessionListScenario({
      hasSessionStderr: 'permission denied opening tmux socket',
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.stored.length, 1);
    assert.equal(result.stored[0].id, 'codex-prune-1');
    assert.equal(Boolean(result.stored[0].endedAt), false);
    assert.equal(result.credentialActive, true);
  });

  it('revokes credentials only after has-session confirms a missing tmux session', async () => {
    const result = await runPruneHasSessionListScenario();

    assert.equal(result.statusCode, 200);
    assert.equal(result.stored.length, 1);
    assert.equal(result.stored[0].id, 'codex-prune-1');
    assert.equal(Boolean(result.stored[0].endedAt), true);
    assert.equal(result.credentialReason, 'revoked');
  });

  it('removes a confirmed-dead external tmux session from the list and store', async () => {
    const result = await runPruneHasSessionListScenario({
      id: 'external-bos-llm-packet-1',
      tmuxSession: 'bos-llm-packet-1',
      source: 'tmux-external',
    });

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.sessions, []);
    assert.deepEqual(result.stored, []);
  });

  it('marks a sent prompt as pending instead of listing stale prompt-ready attention', async () => {
    const result = await runInputPendingListScenario();

    assert.equal(result.before.sessions[0].state.status, 'unknown');
    assert.equal(result.before.sessions[0].state.needsInput, false);
    assert.equal(result.send.statusCode, 202);
    assert.equal(result.send.body.accepted, true);
    assert.match(result.send.body.transactionId, /^cmd_/);
    assert.equal(result.send.body.state, 'queued');

    const session = result.after.sessions[0];
    assert.equal(session.id, 'pending-1');
    assert.equal(session.state.state, 'working');
    assert.equal(session.state.status, 'awaiting_response');
    assert.equal(session.state.needsInput, false);
    assert.equal(session.state.pendingResponse, true);
    assert.equal(typeof session.pendingResponse.sentAt, 'number');
    assert.equal(session.attention, null);
    assert.equal(
      result.broadcasts.some((entry) => entry.channel === 'codex:sessions' && entry.type === 'sessions'),
      true
    );
  });

  it('rejects input whose command-gate deadline already expired', async () => {
    const result = await runInputPendingListScenario({ deadlineAt: Date.now() - 1000 });

    assert.equal(result.send.statusCode, 409);
    assert.equal(result.send.body.code, 'command_deadline_expired');
  });

  it('keeps pending send state when pane only advances with submitted prompt echo', async () => {
    const result = await runInputPendingListScenario({
      afterSendPaneContent: [
        'Previous work complete.',
        '────────────────────────────────────────────────────────────────────────────────',
        '› Proceed',
        '────────────────────────────────────────────────────────────────────────────────',
        '› ',
        'gpt-5.4 medium · 72% left · ~/project',
      ].join('\n'),
    });

    assert.equal(result.send.statusCode, 202);
    const session = result.after.sessions[0];
    assert.equal(session.state.state, 'working');
    assert.equal(session.state.status, 'awaiting_response');
    assert.equal(session.state.needsInput, false);
    assert.equal(session.state.pendingResponse, true);
    assert.equal(typeof session.pendingResponse.sentAt, 'number');
    assert.equal(session.attention, null);
  });

  it('keeps pending send state when long submitted prompt echo wraps across captured lines', async () => {
    const promptText = 'Proceed with the detailed release readiness audit and report whether every acceptance check still passes before taking any additional action';
    const result = await runInputPendingListScenario({
      promptText,
      afterSendPaneContent: [
        'Previous work complete.',
        '────────────────────────────────────────────────────────────────────────────────',
        '› Proceed with the detailed release readiness audit and report',
        'whether every acceptance check still passes before taking any',
        'additional action',
        '────────────────────────────────────────────────────────────────────────────────',
        '› ',
        'gpt-5.4 medium · 72% left · ~/project',
      ].join('\n'),
    });

    assert.equal(result.send.statusCode, 202);
    const session = result.after.sessions[0];
    assert.equal(session.state.state, 'working');
    assert.equal(session.state.status, 'awaiting_response');
    assert.equal(session.state.needsInput, false);
    assert.equal(session.state.pendingResponse, true);
    assert.equal(typeof session.pendingResponse.sentAt, 'number');
    assert.equal(session.attention, null);
  });

  it('clears pending send state when the next observed pane is a newer prompt-ready transcript', async () => {
    const result = await runInputPendingListScenario({
      waitForState: 'waiting_for_input',
      afterSendPaneContent: [
        'Previous work complete.',
        '› Proceed',
        'Ran the requested follow-up.',
        'Ready for another prompt.',
        '────────────────────────────────────────────────────────────────────────────────',
        '› ',
        'gpt-5.4 medium · 71% left · ~/project',
      ].join('\n'),
    });

    assert.equal(result.send.statusCode, 202);
    assert.equal(result.waitMatched, true);
    const session = result.after.sessions[0];
    assert.equal(session.state.state, 'waiting_for_input');
    assert.equal(session.state.needsInput, true);
    assert.equal(session.state.pendingResponse, false);
    assert.equal(session.pendingResponse, null);
    assert.equal(session.attention.active, true);
    assert.equal(session.attention.kind, 'prompt_ready');
  });

  it('cleans up managed worktrees, launch logs, and scheduled sends when deleting a session', async () => {
    const result = await runLifecycleCleanupScenario();
    assert.equal(result.initialPromptGone, true);

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.launchLogGone, true);
    assert.deepEqual(result.hooksGone, [true, true]);
    assert.match(result.gitCommands, /worktree remove --force/);
    assert.match(result.gitCommands, /branch -D dueno-fleet\/agent\/cleanup-test/);
    assert.match(result.tmuxCommands, /^has-session -t codex-clean-session/);
    assert.deepEqual(result.scheduled, []);
  });

  it('cleans up only exact GitHub scratch directories without following symlinks', async () => {
    for (const scratch of ['valid', 'nonempty', 'outside', 'symlink', 'parent-symlink', 'invalid-name', 'escape']) {
      const result = await runLifecycleCleanupScenario({ scratch });
      assert.equal(result.statusCode, 200, scratch);
      assert.equal(result.outsideKept, 'keep', scratch);
      assert.equal(result.scratchExists, !['valid', 'nonempty'].includes(scratch), scratch);
      assert.equal(result.parentExists, scratch !== 'valid', scratch);
      assert.equal(result.workDirExists, !['valid', 'nonempty'].includes(scratch), scratch);
    }
  });

  it('removes session metadata when managed worktree cleanup fails', async () => {
    const result = await runLifecycleCleanupScenario({ failWorktreeRemove: true });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.status, 'already_gone');
    assert.equal(result.launchLogGone, true);
    assert.deepEqual(result.stored, []);
  });

  it('removes launch logs when session startup fails', async () => {
    const result = await runStartupFailureLaunchLogScenario();

    assert.equal(result.statusCode, 500);
    assert.match(result.body.error, /Failed to create session/);
    assert.deepEqual(result.launchLogs, []);
  });

  it('rejects empty Codex creates and records a session-create audit event', async () => {
    const result = await runEmptyCreateAuditScenario();

    assert.equal(result.statusCode, 400);
    assert.match(result.body.error, /Session create requires/);
    const emptyFailure = result.events.events.find(event => event.code === 'session.create.empty_request');
    assert.equal(emptyFailure.module, 'sessions');
    assert.equal(emptyFailure.action, 'create_session');
    assert.equal(emptyFailure.outcome, 'failed');
    assert.equal(emptyFailure.metadata.backend, 'codex');
    assert.equal(emptyFailure.metadata.hasWorkDir, false);
    assert.equal(emptyFailure.metadata.hasInitialPrompt, false);
    assert.equal(emptyFailure.metadata.userAgent, 'empty-create-test');
  });

  it('validates malformed codexPlugins when it is the only create input', async () => {
    const result = await runEmptyCreateAuditScenario({ codexPlugins: { add: 'browser@openai-bundled' } });

    assert.equal(result.statusCode, 400);
    assert.equal(result.body.code, 'codex_plugin_selection_invalid');
    assert.match(result.body.error, /codexPlugins\.add must be an array/);
  });

  it('reloads persisted scheduled sends on plugin startup', async () => {
    const result = await runScheduledSendPersistenceScenario();

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.sends.length, 1);
    assert.equal(result.body.sends[0].sendId, 'ss_persisted');
    assert.equal(result.body.sends[0].text, 'persisted send');
  });

  it('prunes dead bare-process session entries during discovery', async () => {
    const result = await runBareProcessPruneScenario();

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.sessions.length, 0);
    assert.deepEqual(result.stored, []);
  });

  it('emits tool lifecycle hooks when a codex session returns to prompt-ready', async () => {
    const result = await runStateTransitionScenario({
      initialPaneContent: 'Reviewing repository state.\n• Working (14s • esc to interrupt)\n› ',
      updatedPaneContent: 'Completed pass.\n› ',
    });

    assert.match(result.hookEvents, /"eventName":"SessionToolStarted"/);
    assert.match(result.hookEvents, /"eventName":"SessionToolFinished"/);
    assert.match(result.hookEvents, /"eventName":"SessionPromptReady"/);
  });

  it('uses a fresh codex hook state ahead of scrape state', async () => {
    const result = await runHookReconcileScenario({
      paneContent: 'Completed pass.\n› ',
      hook: {
        lifecycle: 'running',
        activity: 'tool_running',
        last_hook_event_at: Date.now(),
        last_event_name: 'PreToolUse',
        source: 'hook',
      },
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.state.state, 'working');
    assert.equal(result.body.state.status, 'working');
    assert.equal(result.body.state.execution, 'working');
    assert.equal(result.body.state.needsInput, false);
  });

  it('uses bound genuine codex hook state ahead of scrape state', async () => {
    const result = await runHookReconcileScenario({
      paneContent: 'Completed pass.\n› ',
      genuineHookEventName: 'PreToolUse',
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.state.state, 'working');
    assert.equal(result.body.state.status, 'working');
    assert.equal(result.body.state.execution, 'working');
  });

  it('falls back to scrape state when codex hook state is stale', async () => {
    const result = await runHookReconcileScenario({
      paneContent: 'Reviewing repository state.\n• Working (14s • esc to interrupt)\n› ',
      hook: {
        lifecycle: 'running',
        activity: 'prompt_ready',
        last_hook_event_at: Date.now() - 120000,
        last_event_name: 'Stop',
        source: 'hook',
      },
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.state.state, 'working');
    assert.equal(result.body.state.status, 'working');
    assert.equal(result.body.state.execution, 'working');
  });

  it('keeps capture failure ended despite fresh codex hook state', async () => {
    const result = await runHookReconcileScenario({
      captureFails: true,
      genuineHookEventName: 'UserPromptSubmit',
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.sessionEnded, true);
    assert.equal(result.body.state.state, 'ended');
    assert.equal(result.body.state.status, 'ended');
    assert.equal(result.body.state.lifecycle, 'missing');
  });

  it('distinguishes missing panes from transient tmux transport failures', () => {
    assert.equal(isTmuxMissingSessionError("can't find pane: codex-hook-session"), true);
    assert.equal(isTmuxMissingSessionError('error connecting to /tmp/tmux-1000/dm-agent (No such file or directory)'), true);
    assert.equal(isTmuxMissingSessionError('no server running on /tmp/tmux-1000/dm-agent'), true);
    assert.equal(isTmuxMissingSessionError('failed to connect to server'), false);
    assert.equal(isTmuxMissingSessionError('connection refused'), false);
    assert.equal(isTmuxMissingNamedSessionError("can't find session: codex-hook-session"), true);
    assert.equal(isTmuxMissingNamedSessionError("can't find pane: codex-hook-session"), false);
    assert.equal(isTmuxMissingNamedSessionError('permission denied opening tmux socket'), false);
  });
});
