import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { findAgyBinarySync, listAgyModels, parseAgyModels } from '../modules/sessions/agy-models.mjs';
import { buildAgentProviderCatalog, inferAgentProviderFromModel } from '../modules/agent/provider-interface.mjs';
import { buildAgentModelCatalog } from '../modules/agent-bus/routes.mjs';
import { detectProviderState } from '../modules/session-state/providers/patterns.mjs';

const execFileAsync = promisify(execFile);
const coverageEnv = process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {};
const tempDirs = [];
const MODELS_OUTPUT = 'Fetching available models...\ngemini-4-neon-medium\tGemini 4 Neon (Medium)\ngemini-4-argon-high\tGemini 4 Argon (High)\n';

afterEach(async () => {
  while (tempDirs.length > 0) await rm(tempDirs.pop(), { recursive: true, force: true });
});

async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'cadre-agy-'));
  tempDirs.push(dir);
  return dir;
}

async function writeScript(path, lines) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, ['#!/bin/sh', ...lines, ''].join('\n'));
  await chmod(path, 0o755);
}

async function writeFakeAgy(path) {
  await writeScript(path, [`[ "$1" = models ] && printf '${MODELS_OUTPUT.replace(/\t/g, '\\t').replace(/\n/g, '\\n')}'`, 'exit 0']);
}

describe('agy provider', () => {
  it('finds agy in ~/.local/bin when it is not on PATH, and nowhere else', async () => {
    const home = await tempDir();
    assert.equal(findAgyBinarySync({ HOME: home, PATH: '/usr/bin:/bin' }), '');
    await writeFakeAgy(join(home, '.local', 'bin', 'agy'));
    assert.equal(findAgyBinarySync({ HOME: home, PATH: '/usr/bin:/bin' }), join(home, '.local', 'bin', 'agy'));
    assert.equal(findAgyBinarySync({ HOME: home, PATH: '', AGY_BIN: join(home, 'missing') }), '');
  });

  it('is disabled unless the binary is found, and never joins collaboration rooms', () => {
    const agy = (agyAvailable) => buildAgentProviderCatalog({}, { agyAvailable }).find((entry) => entry.id === 'agy');
    assert.equal(agy(false).enabled, false);
    assert.equal(agy(true).enabled, true);
    assert.equal(agy(true).supportsCollaboration, false);
    assert.equal(buildAgentProviderCatalog({ agy: false }, { agyAvailable: true }).find((entry) => entry.id === 'agy').enabled, false);
    assert.equal(inferAgentProviderFromModel('gemini-4-neon-medium'), 'agy');
  });

  it('reads `agy models` and falls back to the static list without a binary', async () => {
    assert.deepEqual(parseAgyModels(MODELS_OUTPUT).map((entry) => entry.id), ['gemini-4-neon-medium', 'gemini-4-argon-high']);
    const fallback = await listAgyModels({ binary: '' });
    assert.ok(fallback.some((entry) => entry.id === 'gemini-4-hydrogen-xhigh'));
    assert.equal(fallback.some((entry) => /carbon/.test(entry.id)), false);
    const bin = join(await tempDir(), 'agy');
    await writeFakeAgy(bin);
    assert.deepEqual((await listAgyModels({ binary: bin })).map((entry) => entry.label), ['Gemini 4 Neon (Medium)', 'Gemini 4 Argon (High)']);
  });

  it('feeds the new-session picker with agy models only while agy is enabled', async () => {
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    const { loadModelCatalog, sessionKindForProvider, withDefaultModelChoice } = await import('../public/components/provider-model-picker.mjs');
    const modelCatalog = await buildAgentModelCatalog({
      listCodexModelsImpl: async () => [],
      listProviderModelsImpl: async () => ({ models: [] }),
      listPiModelsImpl: async () => ({}),
      listAgyModelsImpl: async () => parseAgyModels(MODELS_OUTPUT),
    });
    const load = async (agyAvailable) => {
      const responses = {
        '/api/agent-bus/model-catalog': modelCatalog,
        '/api/agents/providers': { providers: buildAgentProviderCatalog({}, { agyAvailable }) },
      };
      globalThis.fetch = async (url) => new Response(JSON.stringify(responses[url]), { headers: { 'content-type': 'application/json' } });
      const state = { value: null };
      await loadModelCatalog(state, { value: false });
      return state.value;
    };
    const enabled = await load(true);
    assert.equal(enabled.providers.find((entry) => entry.id === 'agy').label, 'Antigravity');
    assert.equal(sessionKindForProvider('agy', enabled), 'agy');
    assert.deepEqual(withDefaultModelChoice('agy', enabled.models.agy, enabled).map((entry) => entry.id), ['gemini-4-neon-medium', 'gemini-4-argon-high']);
    assert.equal((await load(false)).providers.some((entry) => entry.id === 'agy'), false);
  });

  it('reads agy busy and idle panes', () => {
    const pane = (footer) => `> Reply with exactly: ok\n  ok\n────────\n>\n────────\n${footer}                 auto · Gemini 4 Neon · medium`;
    assert.equal(detectProviderState('agy', pane('esc to cancel')).state, 'working');
    assert.equal(detectProviderState('agy', pane('? for shortcuts')).state, 'waiting_for_input');
  });
});

describe('agy sessions', () => {
  it('launches agy in tmux with the model, session-only trust and a private dueno MCP workspace', async () => {
    const result = await runScenario({ action: 'create' });
    assert.equal(result.response.statusCode, 200, JSON.stringify(result.response.body));
    const args = result.tmuxArgs;
    assert.equal(args[args.indexOf('-c') + 1], result.workDir);
    const pane = args.at(-1);
    assert.match(pane, new RegExp(`export CADRE_SESSION_ID='?${result.response.body.id}'?; .*export CADRE_PROVIDER='?agy'?`));
    assert.match(pane, /\/agy' '--dangerously-skip-permissions' '--settings'/);
    assert.match(pane, /'--model' 'gemini-4-neon-medium'/);
    assert.doesNotMatch(pane, /--effort/);
    const addDir = pane.match(/'--add-dir' '([^']+)'/)[1];
    assert.equal(addDir, join(result.stateDir, 'mcp_client_configs', `agy-${result.response.body.id}`));
    assert.ok(pane.includes(JSON.stringify({ trustedWorkspaces: [result.workDir, addDir] })));
    const mcpConfig = JSON.parse(result.mcpConfig);
    assert.match(mcpConfig.mcpServers.dueno.serverUrl, /\/mcp$/);
    assert.match(mcpConfig.mcpServers.dueno.headers.Authorization, /^Bearer \S+/);
    // agy loads AGENTS.md from every workspace, so the hint reaches the model without touching the prompt.
    assert.match(result.rule, /call_mcp_tool` on server `dueno`/);
    // Interactive agy has no MCP tools on a conversation's first turn: the launch spends that turn on
    // `-i cadre:connect`, which the workspace hook ends before any model call.
    assert.match(pane, new RegExp(`'--add-dir' '${addDir}' '-i' 'cadre:connect'`));
    const runHook = (lastUserInput) => execFileAsync('sh', ['-c', `printf '%s' '${JSON.stringify({ hookEventName: 'PreInvocation', lastUserInput })}' | ${JSON.parse(result.hooks).cadre.PreInvocation[0].command}`]).then(({ stdout }) => JSON.parse(stdout));
    assert.deepEqual(await runHook('cadre:connect'), {
      injectSteps: [{ errorMessage: { userMessage: 'Cadre tools connected' } }], terminationBehavior: 'terminate',
    });
    assert.deepEqual(await runHook('fix the failing test'), {});
    assert.deepEqual(await runHook('cadre:connect, then fix the test'), {});
    assert.equal(result.persisted.model, 'gemini-4-neon-medium');
    assert.deepEqual(result.response.body.warnings || [], []);
  });

  it('resumes the workDir conversation with --continue when no conversation id is known', async () => {
    const result = await runScenario({ action: 'resume' });
    assert.equal(result.response.statusCode, 200, JSON.stringify(result.response.body));
    assert.match(result.tmuxArgs.at(-1), /'--model' 'gemini-4-argon-high' '--continue'/);
    // Resume rebuilds the private workspace, hint and connect turn included.
    assert.match(result.rule, /call_mcp_tool` on server `dueno`/);
    assert.match(result.tmuxArgs.at(-1), /'-i' 'cadre:connect'/);
    assert.ok(JSON.parse(result.hooks).cadre.PreInvocation);
  });

  it('applies a prompt profile as an AGENTS.md rule in its own trusted --add-dir workspace', async () => {
    const result = await runScenario({ action: 'create', extra: { promptProfile: 'caveman' } });
    assert.equal(result.response.statusCode, 200, JSON.stringify(result.response.body));
    assert.deepEqual(result.response.body.warnings, undefined);
    assert.equal(result.persisted.promptProfile.attached, true);
    const profileDir = join(result.stateDir, 'prompt_profiles', `agy-${result.response.body.id}`);
    const pane = result.tmuxArgs.at(-1);
    assert.ok(pane.includes(`'--add-dir' '${profileDir}'`));
    assert.ok(JSON.parse(pane.match(/'--settings' '([^']+)'/)[1]).trustedWorkspaces.includes(profileDir));
    assert.match(result.profileRule, /caveman/i);
  });

  it('reapplies the prompt profile workspace on resume', async () => {
    const result = await runScenario({ action: 'resume', stored: { promptProfile: { profileId: 'caveman', placement: 'append' } } });
    assert.equal(result.response.statusCode, 200, JSON.stringify(result.response.body));
    const profileDir = join(result.stateDir, 'prompt_profiles', 'agy-agyresume1');
    const pane = result.tmuxArgs.at(-1);
    assert.ok(pane.includes(`'--add-dir' '${profileDir}'`));
    assert.ok(JSON.parse(pane.match(/'--settings' '([^']+)'/)[1]).trustedWorkspaces.includes(profileDir));
    assert.match(result.profileRule, /caveman/i);
  });

  it('rejects models agy does not list and reports a missing binary', async () => {
    const unknown = await runScenario({ action: 'create', model: 'gemini-4-carbon' });
    assert.deepEqual([unknown.response.statusCode, unknown.response.body.code], [400, 'agy_model_unsupported']);
    const missing = await runScenario({ action: 'create', agyMode: 'missing' });
    assert.deepEqual([missing.response.statusCode, missing.response.body.code], [503, 'agy_binary_missing']);
  });
});

async function runScenario({ action, model = 'gemini-4-neon-medium', agyMode = 'ready', extra = {}, stored = {} } = {}) {
  const root = await tempDir();
  const binDir = join(root, 'bin');
  const workDir = join(root, 'work');
  const stateDir = join(root, '.dueno', 'state');
  const tmuxArgsFile = join(root, 'tmux-args.txt');
  const sessionMarker = join(root, 'tmux-session-created');
  await mkdir(join(workDir, '.git'), { recursive: true });
  await writeScript(join(binDir, 'tmux'), [
    'cmd="$1"; shift',
    'case "$cmd" in',
    '  has-session) [ -f "$TMUX_SESSION_MARKER" ] && exit 0; exit 1 ;;',
    '  new-session) printf "%s\\n" "$@" > "$TMUX_TEST_ARGS"; touch "$TMUX_SESSION_MARKER"; exit 0 ;;',
    '  kill-session) rm -f "$TMUX_SESSION_MARKER"; exit 0 ;;',
    'esac',
    'exit 0',
  ]);
  if (agyMode !== 'missing') await writeFakeAgy(join(binDir, 'agy'));
  if (action === 'resume') {
    await writeFile(join(root, '.agy_sessions.json'), JSON.stringify([{
      id: 'agyresume1', tmuxSession: 'agy-agyresume1', source: 'dashboard', workDir, created: Date.now(),
      provider: 'agy', runtime: 'agy', model: 'gemini-4-argon-high',
      mcpCapabilities: { profileId: 'default', serverIds: ['dueno'], catalogVersion: 1, provider: 'agy', runtime: 'agy' },
      ...stored,
    }]));
  }
  const url = action === 'resume' ? '/api/agy/sessions/agyresume1/resume' : '/api/agy/sessions';
  const payload = action === 'resume' ? {} : { workDir, provider: 'agy', model, mcpServers: { add: ['dueno'] }, ...extra };
  const wrapped = `
    import Fastify from ${JSON.stringify(pathToFileURL(resolve('node_modules/fastify/fastify.js')).href)};
    import { readFile, readdir } from 'node:fs/promises';
    process.chdir(${JSON.stringify(root)});
    const { agySessionsPlugin } = await import(${JSON.stringify(pathToFileURL(resolve('modules/sessions/agy-sessions.mjs')).href)});
    const app = Fastify();
    await app.register(agySessionsPlugin, { wsManager: { broadcast() {}, onChannel() {}, channels: new Map() } });
    await app.ready();
    const response = await app.inject({ method: 'POST', url: ${JSON.stringify(url)}, payload: ${JSON.stringify(payload)} });
    const state = await readFile(${JSON.stringify(join(stateDir, 'agy_sessions.json'))}, 'utf8').then(JSON.parse).catch(() => []);
    const id = response.json().id;
    const workspace = ${JSON.stringify(join(stateDir, 'mcp_client_configs'))} + '/agy-' + (id || 'agyresume1');
    const mcpConfig = await readFile(workspace + '/.agents/mcp_config.json', 'utf8').catch(() => '');
    const rule = await readFile(workspace + '/AGENTS.md', 'utf8').catch(() => '');
    const hooks = await readFile(workspace + '/.agents/hooks.json', 'utf8').catch(() => '{}');
    const profileRule = await readFile(${JSON.stringify(join(stateDir, 'prompt_profiles'))} + '/agy-' + id + '/AGENTS.md', 'utf8').catch(() => '');
    const tmuxArgs = await readFile(${JSON.stringify(tmuxArgsFile)}, 'utf8').catch(() => '');
    await app.close();
    console.log(JSON.stringify({ response: { statusCode: response.statusCode, body: response.json() }, persisted: state[0] || null, mcpConfig, rule, hooks, profileRule, tmuxArgs }));
  `;
  const env = {
    ...coverageEnv,
    NODE_TEST_CONTEXT: '1',
    CADRE_AGENT_CGROUP_ISOLATION: '0',
    HOME: root,
    PATH: `${binDir}:/usr/bin:/bin:${dirname(process.execPath)}`,
    LOG_LEVEL: 'error',
    APP_STATE_STORAGE: 'file',
    AGY_SESSIONS_STORAGE: 'file',
    // Unreachable on purpose: the launch must not dial a live local MCP endpoint.
    AGENT_BUS_MCP_HTTP_PORT: '1',
    DATABASE_URL: '',
    TMUX_TEST_ARGS: tmuxArgsFile,
    TMUX_SESSION_MARKER: sessionMarker,
  };
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', wrapped], { cwd: resolve('.'), env });
  const parsed = JSON.parse(stdout.trim().split('\n').at(-1));
  return { ...parsed, tmuxArgs: parsed.tmuxArgs.split('\n').filter(Boolean), workDir, stateDir };
}
