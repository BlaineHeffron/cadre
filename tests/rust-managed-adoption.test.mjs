import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  classifyExecutableArgs,
  classifyProcessTrees,
  collectTmuxProcessTreePids,
  externalSessionIdFromTmuxName,
} from '../modules/agent/tmux-classifier.mjs';
import { tmuxPlugin } from '../modules/platform/tmux.mjs';

const execFileAsync = promisify(execFile);
const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('Rust-managed tmux adoption', () => {
  it('classifies by executable basename, not prompt substrings', () => {
    assert.deepEqual(
      classifyExecutableArgs('claude --prompt "watch codex:agt_corr_123"'),
      { cli: 'claude', provider: 'anthropic', runtime: 'claude' }
    );
    assert.deepEqual(
      classifyExecutableArgs('node /usr/local/bin/codex exec --prompt "hello"'),
      { cli: 'codex', provider: 'openai', runtime: 'codex' }
    );
    assert.deepEqual(
      classifyExecutableArgs('bash /opt/tools/pi --provider openai --model gpt-5.5'),
      { cli: 'pi', provider: '', runtime: 'pi' }
    );
    assert.deepEqual(
      classifyExecutableArgs('node /opt/pi --provider=xai --model grok-4.3'),
      { cli: 'pi', provider: 'xai', runtime: 'pi' }
    );
    assert.deepEqual(
      classifyExecutableArgs('pi --provider opencode-go --model glm-5.2'),
      { cli: 'pi', provider: 'opencode-go', runtime: 'pi' }
    );
    assert.deepEqual(
      classifyExecutableArgs('pi --provider openrouter --model z-ai/glm-5.3-flash'),
      { cli: 'pi', provider: 'openrouter', runtime: 'pi' }
    );
  });

  it('classifies many tmux process trees from one process snapshot', async () => {
    const calls = [];
    const execFn = async (command, args) => {
      calls.push([command, ...args]);
      assert.equal(command, 'ps');
      return {
        code: 0,
        stdout: [
          '100 1 bash',
          '101 100 node /usr/local/bin/codex',
          '200 1 bash',
          '201 200 node /opt/claude',
          '300 1 bash',
        ].join('\n'),
      };
    };

    const classifications = await classifyProcessTrees(execFn, new Map([
      ['codex-session', '100'],
      ['claude-session', '200'],
      ['unrelated-session', '300'],
    ]));

    assert.equal(calls.length, 1);
    assert.deepEqual(classifications.get('codex-session'), { cli: 'codex', provider: 'openai', runtime: 'codex' });
    assert.deepEqual(classifications.get('claude-session'), { cli: 'claude', provider: 'anthropic', runtime: 'claude' });
    assert.deepEqual(classifications.get('unrelated-session'), { cli: '', provider: '', runtime: '' });
  });

  it('collects all tmux descendants from one process snapshot', async () => {
    const calls = [];
    const execFn = async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'tmux') return { code: 0, stdout: '100\n200\n' };
      return {
        code: 0,
        stdout: [
          '100 1 bash',
          '101 100 node /usr/local/bin/codex',
          '102 101 worker',
          '200 1 bash',
          '201 200 node /opt/claude',
          '999 1 unrelated',
        ].join('\n'),
      };
    };

    const pids = await collectTmuxProcessTreePids(execFn);

    assert.deepEqual([...pids].sort(), ['100', '101', '102', '200', '201']);
    assert.equal(calls.filter(([command]) => command === 'ps').length, 1);
    assert.equal(calls.length, 2);
  });

  it('adopts rust-managed Claude sessions as read-only and blocks mutators', async () => {
    const result = await runRustManagedScenario({ kind: 'claude' });

    assert.equal(result.sessions.length, 1);
    assert.equal(result.session.id, externalSessionIdFromTmuxName('dm-agent-claude'));
    assert.equal(result.secondSession.id, result.session.id);
    assert.equal(result.session.name, 'dm-agent-claude');
    assert.equal(result.session.source, 'tmux-external');
    assert.equal(result.session.readOnly, true);
    assert.equal(result.session.externalOwner, 'rust-monitor');
    assert.equal(result.session.interactive, false);
    assert.equal(result.session.displayName, 'rust-managed claude');
    assert.equal(result.session.provider, 'anthropic');
    assert.equal(result.session.runtime, 'claude');
    assert.equal(result.detail.content, 'claude pane text\n');
    assert.equal(result.detail.readOnly, true);
    assert.equal(result.detail.externalOwner, 'rust-monitor');
    assert.equal(result.detail.attachCommand, "tmux -S /tmp/tmux-1000/default attach -t 'dm-agent-claude'");
    assert.equal(result.emptyMetaDetail.readOnly, true);
    assert.equal(result.emptyMetaDetail.externalOwner, 'rust-monitor');
    assert.equal(result.emptyMetaDetail.attachCommand, "tmux -S /tmp/tmux-1000/default attach -t 'dm-agent-claude'");
    assert.equal(result.emptyMetaMutator.statusCode, 403);
    assert.deepEqual(result.mutators.map((entry) => entry.statusCode), Array(result.mutators.length).fill(403));
    assert.equal(result.mutationLog, '');
  });

  it('adopts rust-managed Codex sessions as read-only and blocks mutators without bare duplicates', async () => {
    const result = await runRustManagedScenario({ kind: 'codex' });

    assert.equal(result.sessions.length, 1);
    assert.equal(result.session.id, externalSessionIdFromTmuxName('dm-agent-codex'));
    assert.equal(result.secondSession.id, result.session.id);
    assert.equal(result.session.name, 'dm-agent-codex');
    assert.equal(result.session.source, 'tmux-external');
    assert.equal(result.session.readOnly, true);
    assert.equal(result.session.externalOwner, 'rust-monitor');
    assert.equal(result.session.interactive, false);
    assert.equal(result.session.displayName, 'rust-managed codex');
    assert.equal(result.session.provider, 'openai');
    assert.equal(result.session.runtime, 'codex');
    assert.equal(result.detail.content, 'codex pane text\n');
    assert.equal(result.detail.readOnly, true);
    assert.equal(result.detail.externalOwner, 'rust-monitor');
    assert.equal(result.detail.attachCommand, "tmux -S /tmp/tmux-1000/default attach -t 'dm-agent-codex'");
    assert.equal(result.emptyMetaDetail.readOnly, true);
    assert.equal(result.emptyMetaDetail.externalOwner, 'rust-monitor');
    assert.equal(result.emptyMetaDetail.attachCommand, "tmux -S /tmp/tmux-1000/default attach -t 'dm-agent-codex'");
    assert.equal(result.emptyMetaMutator.statusCode, 403);
    assert.ok(!result.sessions.some((session) => session.source === 'bare-process'));
    assert.deepEqual(result.mutators.map((entry) => entry.statusCode), Array(result.mutators.length).fill(403));
    assert.equal(result.mutationLog, '');
  });

  it('blocks generic tmux input and terminal-open routes for rust-managed targets', async () => {
    const broadcasts = [];
    const handlers = new Map();
    const app = Fastify();
    await app.register(tmuxPlugin, {
      wsManager: {
        broadcast(channel, type, data) { broadcasts.push({ channel, type, data }); },
        onChannel(channel, handler) { handlers.set(channel, handler); },
        channels: new Map(),
      },
    });

    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/api/tmux/pane/dm-agent-claude:0.0/keys', payload: { keys: 'Escape' } }),
      app.inject({ method: 'POST', url: '/api/tmux/pane/dm-agent-claude:0.0/input', payload: { text: 'blocked', enter: true } }),
      app.inject({ method: 'DELETE', url: '/api/tmux/pane/dm-agent-claude:0.0' }),
      app.inject({ method: 'POST', url: '/api/tmux/sessions/dm-agent-claude/open' }),
    ]);

    assert.deepEqual(responses.map((response) => response.statusCode), [403, 403, 403, 403]);
    handlers.get('tmux')?.(null, 'tmux:pane:dm-agent-claude:0.0', { action: 'keys', keys: 'Escape' });
    assert.deepEqual(broadcasts, [{
      channel: 'tmux:pane:dm-agent-claude:0.0',
      type: 'error',
      data: { error: 'Tmux target is rust-managed and read-only', code: 'read_only' },
    }]);
    await app.close();
  });
});

async function runRustManagedScenario({ kind }) {
  const tempDir = await mkdtemp(join(tmpdir(), `dueno-${kind}-rust-managed-`));
  tempDirs.push(tempDir);
  const binDir = join(tempDir, 'bin');
  const workDir = join(tempDir, 'work');
  const mutationLog = join(tempDir, 'mutations.log');
  await mkdir(binDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFakeTmux(binDir, workDir);
  await writeFakePs(binDir);
  await writeFakePgrep(binDir);

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve(`modules/sessions/${kind}-sessions.mjs`)).href;
  const pluginExport = kind === 'claude' ? 'claudeSessionsPlugin' : 'codexSessionsPlugin';
  const targetName = kind === 'claude' ? 'dm-agent-claude' : 'dm-agent-codex';
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile } from 'node:fs/promises';
    import { externalSessionIdFromTmuxName } from ${JSON.stringify(pathToFileURL(resolve('modules/agent/tmux-classifier.mjs')).href)};
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef[${JSON.stringify(pluginExport)}], {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const stableId = externalSessionIdFromTmuxName(${JSON.stringify(targetName)});
    const emptyMetaDetail = await app.inject({ method: 'GET', url: ${JSON.stringify(`/api/${kind}/sessions/`)} + stableId });
    const emptyMetaMutator = await app.inject({
      method: 'POST',
      url: ${JSON.stringify(`/api/${kind}/sessions/`)} + stableId + '/escape',
      payload: {},
    });
    const list = await app.inject({ method: 'GET', url: ${JSON.stringify(`/api/${kind}/sessions?includeReadOnly=true`)} });
    const sessions = list.json().sessions;
    const session = sessions.find((entry) => entry.name === ${JSON.stringify(targetName)});
    const secondList = await app.inject({ method: 'GET', url: ${JSON.stringify(`/api/${kind}/sessions?includeReadOnly=true`)} });
    const secondSession = secondList.json().sessions.find((entry) => entry.name === ${JSON.stringify(targetName)});
    const detail = await app.inject({ method: 'GET', url: ${JSON.stringify(`/api/${kind}/sessions/`)} + session.id });
    const mutatorSpecs = ${JSON.stringify(mutatorSpecs(kind))};
    const mutators = [];
    for (const spec of mutatorSpecs) {
      const response = await app.inject({
        method: spec.method,
        url: spec.url.replace(':id', session.id),
        payload: spec.payload,
      });
      mutators.push({ label: spec.label, statusCode: response.statusCode });
    }
    const mutationLog = await readFile(${JSON.stringify(mutationLog)}, 'utf8').catch(() => '');
    await app.close();
    console.log(JSON.stringify({
      sessions,
      session,
      secondSession,
      detail: detail.json(),
      emptyMetaDetail: emptyMetaDetail.json(),
      emptyMetaMutator: { statusCode: emptyMetaMutator.statusCode },
      mutators,
      mutationLog,
    }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
      TMUX_TEST_WORKDIR: workDir,
      TMUX_TEST_MUTATION_LOG: mutationLog,
      LOG_LEVEL: 'error',
      APP_STATE_STORAGE: 'file',
      CLAUDE_SESSIONS_STORAGE: 'file',
      CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '',
      TMUX: '/tmp/tmux-1000/dm-agent,1,0',
    },
  });

  return JSON.parse(stdout.trim());
}

function mutatorSpecs(kind) {
  const common = [
    { label: 'put', method: 'PUT', url: `/api/${kind}/sessions/:id`, payload: { displayName: 'blocked' } },
    { label: 'escape', method: 'POST', url: `/api/${kind}/sessions/:id/escape`, payload: {} },
    { label: 'keys', method: 'POST', url: `/api/${kind}/sessions/:id/keys`, payload: { keys: 'Escape' } },
    { label: 'input', method: 'POST', url: `/api/${kind}/sessions/:id/input`, payload: { text: 'blocked', enter: true } },
    { label: 'clear', method: 'POST', url: `/api/${kind}/sessions/:id/clear`, payload: {} },
    { label: 'image', method: 'POST', url: `/api/${kind}/sessions/:id/image`, payload: { imageDataUrl: 'data:image/png;base64,AA==', caption: 'blocked' } },
    { label: 'scheduled-send', method: 'POST', url: `/api/${kind}/sessions/:id/scheduled-send`, payload: { text: 'blocked', delayMs: 1000 } },
    { label: 'scheduled-delete', method: 'DELETE', url: `/api/${kind}/sessions/:id/scheduled-send/ss_blocked`, payload: {} },
    { label: 'enter', method: 'POST', url: `/api/${kind}/sessions/:id/enter`, payload: {} },
    { label: 'delete', method: 'DELETE', url: `/api/${kind}/sessions/:id`, payload: {} },
  ];
  if (kind === 'claude') {
    common.splice(1, 0, { label: 'shift-tab', method: 'POST', url: '/api/claude/sessions/:id/shift-tab', payload: {} });
  }
  return common;
}

async function writeFakeTmux(binDir, workDir) {
  await writeFile(join(binDir, 'tmux'), [
    '#!/bin/sh',
    'cmd="$1"',
    'shift',
    'target=""',
    'prev=""',
    'for arg in "$@"; do',
    '  if [ "$prev" = "-t" ]; then target="$arg"; fi',
    '  prev="$arg"',
    'done',
    'case "$cmd" in',
    '  list-sessions)',
    '    printf "dm-agent-claude\\t1000\\t0\\n"',
    '    printf "dm-agent-codex\\t1001\\t0\\n"',
    '    exit 0',
    '    ;;',
    '  list-panes)',
    '    for arg in "$@"; do',
    '      if [ "$arg" = "-a" ]; then printf "100\\n200\\n"; exit 0; fi',
    '    done',
    '    case "$target" in',
    '      dm-agent-claude) echo 100 ;;',
    '      dm-agent-codex) echo 200 ;;',
    '      *) exit 1 ;;',
    '    esac',
    '    exit 0',
    '    ;;',
    '  display-message)',
    '    case "$*" in',
    '      *socket_path*) printf "/tmp/tmux-1000/default\\n" ;;',
    '      *) printf "%s\\n" "$TMUX_TEST_WORKDIR" ;;',
    '    esac',
    '    exit 0',
    '    ;;',
    '  capture-pane)',
    '    case "$target" in',
    '      dm-agent-claude) printf "claude pane text\\n" ;;',
    '      dm-agent-codex) printf "codex pane text\\n" ;;',
    '      *) exit 1 ;;',
    '    esac',
    '    exit 0',
    '    ;;',
    '  send-keys|kill-session|kill-pane|load-buffer|paste-buffer)',
    '    printf "%s %s\\n" "$cmd" "$*" >> "$TMUX_TEST_MUTATION_LOG"',
    '    exit 0',
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  await chmod(join(binDir, 'tmux'), 0o755);
}

async function writeFakePs(binDir) {
  await writeFile(join(binDir, 'ps'), [
    '#!/bin/sh',
    'if [ "$1" = "-p" ]; then',
    '  case "$2" in',
    '    100) echo "claude --prompt watch codex:agt_corr_fake" ;;',
    '    200) echo "node /usr/local/bin/codex exec --prompt hello" ;;',
    '    201) echo "/usr/local/bin/codex exec --prompt hello" ;;',
    '  esac',
    '  exit 0',
    'fi',
    'if [ "$1" = "--ppid" ]; then',
    '  case "$2" in',
    '    200) echo "201 /usr/local/bin/codex exec --prompt hello" ;;',
    '  esac',
    '  exit 0',
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  await chmod(join(binDir, 'ps'), 0o755);
}

async function writeFakePgrep(binDir) {
  await writeFile(join(binDir, 'pgrep'), [
    '#!/bin/sh',
    'case "$2" in',
    '  claude) echo "100 claude --prompt codex:agt_corr_fake"; exit 0 ;;',
    '  codex) echo "201 /usr/local/bin/codex exec --prompt hello"; exit 0 ;;',
    '  opencode) exit 1 ;;',
    'esac',
    'exit 1',
    '',
  ].join('\n'));
  await chmod(join(binDir, 'pgrep'), 0o755);
}
