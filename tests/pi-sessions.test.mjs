import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { piMcpToolName, registerPiMcpTools } from '../modules/integrations/pi-mcp-tool-name.mjs';

const execFileAsync = promisify(execFile);
const tempDirs = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('Pi sessions', () => {
  it('namespaces MCP tools without allowing built-in or cross-server collisions', () => {
    assert.equal(piMcpToolName('dueno', 'read'), 'mcp__dueno__read');
    assert.equal(piMcpToolName('zotero', 'search'), 'mcp__zotero__search');
    assert.equal(piMcpToolName('paper-search', 'find_papers'), 'mcp__paper-search__find_papers');
    assert.notEqual(piMcpToolName('dueno', 'search'), piMcpToolName('zotero', 'search'));
  });

  it('registers and forwards discovered MCP tools through the harness', async () => {
    const registered = [];
    const calls = [];
    registerPiMcpTools({
      pi: { registerTool(tool) { registered.push(tool); } },
      server: 'dueno',
      client: { async callTool(...args) { calls.push(args); return { content: [] }; } },
      tools: [{ name: 'read', description: 'MCP read', inputSchema: { type: 'object' } }],
      typeUnsafe: (schema) => schema,
      registeredNames: new Set(['mcp_servers', 'mcp_discover', 'mcp_call']),
    });

    assert.equal(registered[0].name, 'mcp__dueno__read');
    assert.deepEqual(registered[0].parameters, { type: 'object' });
    const signal = new AbortController().signal;
    assert.deepEqual(await registered[0].execute('call-1', { path: 'x' }, signal), {
      content: [],
      details: { server: 'dueno', tool: 'read' },
    });
    assert.deepEqual(calls, [[
      { name: 'read', arguments: { path: 'x' } },
      undefined,
      { signal, timeout: 60000 },
    ]]);
  });

  it('exports the shared sessions factory wrapper', async () => {
    const mod = await import('../modules/sessions/pi-sessions.mjs');
    assert.equal(typeof mod.createPiSession, 'function');
    assert.equal(typeof mod.piSessionsPlugin, 'function');
  });

  it('appends selected prompt profiles to the Pi launch argv', async () => {
    const result = await runPiScenario({ action: 'create', promptProfile: 'research' });
    assert.equal(result.response.statusCode, 200, JSON.stringify(result));
    assert.match(result.tmuxArgs, /--append-system-prompt/);
    assert.match(result.tmuxArgs, /research agent/);
  });

  it('launches Pi with no MCP servers by default', async () => {
    const result = await runPiScenario({ action: 'create' });

    assert.equal(result.response.statusCode, 200, JSON.stringify(result));
    assert.deepEqual(result.response.body.mcpCapabilities.serverIds, []);
    assert.doesNotMatch(result.tmuxArgs, /--extension/);
    assert.doesNotMatch(result.tmuxArgs, /DUENO_PI_MCP_CONFIG/);
  });

  it('launches GLM 5.3 Flash through OpenRouter', async () => {
    const result = await runPiScenario({ action: 'openrouter' });

    assert.equal(result.response.statusCode, 200, JSON.stringify(result));
    assert.match(result.tmuxArgs, /--provider.*openrouter/);
    assert.match(result.tmuxArgs, /--model.*z-ai\/glm-5\.3-flash/);
  });

  it('resumes legacy Pi with its stored MCP capabilities', async () => {
    const result = await runPiScenario({ action: 'resume' });

    assert.equal(result.response.statusCode, 200, JSON.stringify(result));
    assert.match(result.tmuxArgs, /--extension/);
    assert.match(result.tmuxArgs, /DUENO_PI_MCP_CONFIG/);
  });

  it('still allows Pi with an explicitly empty MCP selection', async () => {
    const result = await runPiScenario({ action: 'empty-mcp' });

    assert.equal(result.response.statusCode, 200, JSON.stringify(result));
    assert.deepEqual(result.response.body.mcpCapabilities.serverIds, []);
    assert.notEqual(result.tmuxArgs, '');
    assert.doesNotMatch(result.tmuxArgs, /--extension|DUENO_PI_MCP_CONFIG/);
  });

  it('loads the Pi MCP extension with its declared dependencies', async () => {
    // The extension runs inside Pi, so a missing dependency only surfaces as a dead pane at
    // launch. Importing it here fails the build instead.
    const extension = await import('../modules/integrations/pi-mcp-extension.mjs');
    assert.equal(typeof extension.default, 'function');
  });

  it('fails the launch when Pi dies on a startup error but the pane survives', async () => {
    const result = await runPiScenario({ action: 'create', piMode: 'extension-crash' });

    assert.equal(result.response.statusCode, 500, JSON.stringify(result));
    assert.match(JSON.stringify(result.response.body), /Failed to load extension/);
    assert.equal(result.sessionAlive, false, 'the surviving pane must be killed');
    const launched = (result.listResponse.body.sessions || [])
      .filter((session) => session.source !== 'bare-process');
    assert.deepEqual(launched, [], JSON.stringify(result.listResponse.body));
  });

  it('returns explicit Pi preflight errors and supports configured BusinessOS', async () => {
    const [missing, oldVersion, missingCredentials, unsupportedMcp] = await Promise.all([
      runPiScenario({ action: 'create', piMode: 'missing' }),
      runPiScenario({ action: 'create', piMode: 'old-version' }),
      runPiScenario({ action: 'create', piMode: 'missing-credentials' }),
      runPiScenario({ action: 'businessos' }),
    ]);

    assert.deepEqual(
      [missing, oldVersion, missingCredentials, unsupportedMcp]
        .map((entry) => [entry.response.statusCode, entry.response.body.code]),
      [
        [503, 'pi_binary_missing'],
        [503, 'pi_version_incompatible'],
        [400, 'pi_credentials_missing'],
        [200, undefined],
      ],
      JSON.stringify([missing, oldVersion, missingCredentials, unsupportedMcp]),
    );
  });
});

async function runPiScenario({ action, piMode = 'ready', promptProfile = '' } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'dueno-pi-sessions-'));
  tempDirs.push(tempDir);
  const binDir = join(tempDir, 'bin');
  const workDir = join(tempDir, 'work');
  const tmuxArgsFile = join(tempDir, 'tmux-args.txt');
  const sessionMarker = join(tempDir, 'tmux-session-created');
  const piBin = join(binDir, 'pi');
  await mkdir(binDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await writeFakeTmux(binDir);
  if (piMode !== 'missing') await writeFakePi(piBin, piMode);

  if (action === 'resume') {
    await writeFile(join(tempDir, '.pi_sessions.json'), JSON.stringify([{
      id: 'pi-resume-1',
      tmuxSession: 'pi-resume-session',
      source: 'dashboard',
      workDir,
      created: Date.now(),
      provider: 'xai',
      runtime: 'pi',
      model: 'grok-4.3',
      thinkingLevel: 'high',
      cliSessionId: '11111111-2222-4333-8444-555555555555',
      selectedMcpServers: ['businessos'],
      businessOsMcp: { serverName: 'businessos', url: 'http://stale.invalid/mcp' },
    }], null, 2));
  }

  const fastifyModuleUrl = pathToFileURL(resolve('node_modules/fastify/fastify.js')).href;
  const pluginModuleUrl = pathToFileURL(resolve('modules/sessions/pi-sessions.mjs')).href;
  const payload = action === 'businessos'
    ? { workDir, provider: 'xai', runtime: 'pi', model: 'grok-4.3', mcpServers: { add: ['businessos'] } }
    : action === 'empty-mcp'
      ? { workDir, provider: 'xai', runtime: 'pi', model: 'grok-4.3', mcpServers: { remove: ['dueno'] } }
      : action === 'openrouter'
        ? { workDir, provider: 'openrouter', runtime: 'pi', model: 'z-ai/glm-5.3-flash' }
        : {
        workDir,
        provider: 'xai',
        runtime: 'pi',
        model: 'grok-4.3',
        thinkingLevel: 'high',
        ...(promptProfile ? { promptProfile } : {}),
      };
  const url = action === 'resume' ? '/api/pi/sessions/pi-resume-1/resume' : '/api/pi/sessions';
  const wrapped = `
    import Fastify from ${JSON.stringify(fastifyModuleUrl)};
    import { readFile } from 'node:fs/promises';
    process.chdir(${JSON.stringify(tempDir)});
    const pluginRef = await import(${JSON.stringify(pluginModuleUrl)});
    const app = Fastify();
    await app.register(pluginRef.piSessionsPlugin, {
      wsManager: { broadcast() {}, onChannel() {}, channels: new Map() },
    });
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: ${JSON.stringify(url)},
      payload: ${JSON.stringify(payload)},
    });
    const listResponse = await app.inject({
      method: 'GET',
      url: '/api/pi/sessions?includeReadOnly=true',
    });
    const state = await readFile(${JSON.stringify(join(tempDir, '.dueno', 'state', 'pi_sessions.json'))}, 'utf8')
      .then(JSON.parse)
      .catch(() => []);
    const tmuxArgs = await readFile(${JSON.stringify(tmuxArgsFile)}, 'utf8').catch(() => '');
    await app.close();
    console.log(JSON.stringify({
      response: { statusCode: response.statusCode, body: response.json() },
      listResponse: { statusCode: listResponse.statusCode, body: listResponse.json() },
      persisted: state[0] || null,
      tmuxArgs,
    }));
  `;

  const systemPath = `/usr/bin:/bin:${dirname(process.execPath)}`;
  const env = {
    ...process.env,
    HOME: tempDir,
    PATH: `${binDir}:${systemPath}`,
    LOG_LEVEL: 'error',
    APP_STATE_STORAGE: 'file',
    PI_SESSIONS_STORAGE: 'file',
    PI_MODEL_CATALOG_STORAGE: 'file',
    PI_MODEL_CATALOG_CACHE_FILE: join(tempDir, 'pi-model-cache.json'),
    DATABASE_URL: '',
    TMUX_TEST_ARGS: tmuxArgsFile,
    TMUX_SESSION_MARKER: sessionMarker,
  };
  if (piMode !== 'missing') env.PI_BIN = piBin;
  else delete env.PI_BIN;
  if (piMode === 'extension-crash') env.TMUX_RUN_LAUNCH_COMMAND = '1';

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], {
    cwd: resolve('.'),
    env,
  });
  const sessionAlive = await stat(sessionMarker).then(() => true).catch(() => false);
  return { ...JSON.parse(stdout.trim()), sessionAlive };
}

async function writeFakePi(piBin, mode) {
  const version = mode === 'old-version' ? '0.80.6' : '0.80.7';
  const modelOutput = mode === 'missing-credentials'
    ? ['echo "No models available. Use /login to authenticate."', 'exit 0']
    : [
        'printf "provider  model  name\\n"',
        'printf "openai  gpt-5.5  GPT-5.5\\n"',
        'printf "xai  grok-4.3  Grok 4.3\\n"',
        'printf "google  gemini-3.5-flash  Gemini 3.5 Flash\\n"',
        'printf "openrouter  z-ai/glm-5.3-flash  Z.ai GLM 5.3 Flash\\n"',
        'exit 0',
      ];
  await writeFile(piBin, [
    '#!/bin/sh',
    'case "$1" in',
    '  --version)',
    `    echo "pi ${version}"`,
    '    exit 0',
    '    ;;',
    '  --list-models)',
    ...modelOutput.map((line) => `    ${line}`),
    '    ;;',
    'esac',
    ...(mode === 'extension-crash'
      ? [
        // Pi loads extensions after the pane opens: it prints to stderr and exits non-zero.
        'echo "Error: Failed to load extension \\"pi-mcp-extension.mjs\\": Cannot find module \'@modelcontextprotocol/sdk/client\'" >&2',
        'exit 1',
      ]
      : []),
    'exit 0',
    '',
  ].join('\n'));
  await chmod(piBin, 0o755);
}

async function writeFakeTmux(binDir) {
  const tmuxBin = join(binDir, 'tmux');
  await writeFile(tmuxBin, [
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
    // A harness that dies with its stderr still piped through `tee` leaves the pane alive, so
    // the marker deliberately survives the launch command failing.
    '    if [ -n "$TMUX_RUN_LAUNCH_COMMAND" ]; then',
    '      for arg in "$@"; do launch="$arg"; done',
    '      bash -c "$launch" >/dev/null 2>&1 || true',
    '    fi',
    '    exit 0',
    '    ;;',
    '  kill-session)',
    '    rm -f "$TMUX_SESSION_MARKER"',
    '    exit 0',
    '    ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  await chmod(tmuxBin, 0o755);
}
