// Restart: the session's CLI is killed and resumed in place through the Resume path, with fake
// tmux and claude binaries at the process boundary, so no real session is touched.
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolveMcpCapabilities } from '../modules/integrations/mcp-capability-resolver.mjs';
import { buildMcpCapabilityCatalog } from '../modules/integrations/mcp-server-catalog.mjs';
import { sanitizedMcpSnapshot } from '../modules/integrations/mcp-launch-preflight.mjs';

const execFileAsync = promisify(execFile);
const coverageEnv = process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {};
const tempDirs = [];
afterEach(async () => { while (tempDirs.length) await rm(tempDirs.pop(), { recursive: true, force: true }); });

async function restart({ cliSessionId = 'cli-uuid-1234', requests = 1, meta = {}, route = 'restart' } = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), 'cadre-restart-'));
  tempDirs.push(tempDir);
  await mkdir(join(tempDir, '.git'));
  const binDir = join(tempDir, 'bin');
  await mkdir(binDir);
  const id = `restart-${process.pid}-${Date.now()}`;
  // The pane's process has exited (pane_dead=1), so nothing real is signalled; tmux logs each call.
  await writeFile(join(binDir, 'tmux'), `#!/bin/sh
echo "$1" >> "$TMUX_LOG"
case "$1" in
  has-session) [ -f "$TMUX_MARKER" ] && exit 0; echo "can't find session: x" >&2; exit 1 ;;
  list-panes) [ -f "$TMUX_MARKER" ] && printf '999999999\\t1\\n'; exit 0 ;;
  kill-session) rm -f "$TMUX_MARKER"; exit 0 ;;
  new-session) shift; printf '%s\\n' "$@" > "$TMUX_ARGS"; touch "$TMUX_MARKER"; exit 0 ;;
  list-sessions) [ -f "$TMUX_MARKER" ] && printf 'claude-restart\\t1\\t0\\t123\\t%s\\n' "$PWD"; exit 0 ;;
esac
exit 0
`);
  await writeFile(join(binDir, 'claude'), '#!/bin/sh\nexit 0\n');
  await chmod(join(binDir, 'tmux'), 0o755);
  await chmod(join(binDir, 'claude'), 0o755);
  // Restart finds the session running; Resume finds it ended.
  if (route === 'restart') await writeFile(join(tempDir, 'tmux-session'), '');
  await writeFile(join(tempDir, '.claude_sessions.json'), JSON.stringify([{
    id, tmuxSession: 'claude-restart', source: 'dashboard', workDir: tempDir, created: Date.now(),
    provider: 'anthropic', runtime: 'claude', model: 'claude-opus-5-5', thinkingLevel: 'high', cliSessionId, ...meta,
  }]));
  const script = `
    import Fastify from ${JSON.stringify(pathToFileURL(resolve('node_modules/fastify/fastify.js')).href)};
    process.chdir(${JSON.stringify(tempDir)});
    const { getAgentSessionsProvider } = await import(${JSON.stringify(pathToFileURL(resolve('modules/sessions/index.mjs')).href)});
    const { AgentBusCredentialStore } = await import(${JSON.stringify(pathToFileURL(resolve('modules/agent-bus/mcp-auth.mjs')).href)});
    let saved = null;
    const credentialStore = new AgentBusCredentialStore({ mode: 'issue_only', store: { mode: 'memory', async load() { return saved; }, async save(next) { saved = structuredClone(next); }, async close() {} } });
    const app = Fastify();
    await app.register(getAgentSessionsProvider('claude').plugin, { wsManager: { broadcast() {}, onChannel() {}, channels: new Map() }, credentialStore });
    await app.ready();
    const responses = await Promise.all(Array.from({ length: ${requests} }, () => app.inject({ method: 'POST', url: '/api/claude/sessions/${id}/${route}' })));
    await app.close();
    console.log(JSON.stringify(responses.map((response) => ({ statusCode: response.statusCode, body: response.json() }))));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: resolve('.'),
    env: {
      ...coverageEnv, NODE_TEST_CONTEXT: '1', HOME: tempDir, PATH: `${binDir}:/usr/bin:/bin`,
      TMUX_LOG: join(tempDir, 'tmux.log'), TMUX_ARGS: join(tempDir, 'tmux-args'), TMUX_MARKER: join(tempDir, 'tmux-session'),
      LOG_LEVEL: 'error', APP_STATE_STORAGE: 'file', CLAUDE_SESSIONS_STORAGE: 'file', DATABASE_URL: '',
      CADRE_AGENT_CGROUP_ISOLATION: '0', CADRE_DISABLE_SIDE_EFFECTS: '1',
      // No agent bus listens here, so the launch check settles on the local credential store.
      AGENT_BUS_MCP_HTTP_HOST: '127.0.0.1', AGENT_BUS_MCP_HTTP_PORT: '1', AGENT_BUS_MCP_HTTP_PATH: '/mcp',
    },
  });
  const read = (name) => readFile(join(tempDir, name), 'utf8').catch(() => '');
  const responses = JSON.parse(stdout.trim().split('\n').at(-1));
  const json = (path) => readFile(join(tempDir, '.dueno', 'state', path), 'utf8').then(JSON.parse, () => null);
  const stored = (await json('claude_sessions.json'))?.find?.((entry) => entry.id === id) || null;
  const mcpConfig = await json(`mcp_client_configs/claude-${id}.json`);
  return { id, tempDir, ...responses[0], responses, stored, mcpConfig, calls: (await read('tmux.log')).split('\n').filter(Boolean), args: await read('tmux-args') };
}

it('restart kills the session and resumes the same conversation in the same tmux session, workdir and model', async () => {
  const result = await restart();
  assert.equal(result.statusCode, 200, JSON.stringify(result.body));
  assert.equal(result.body.id, result.id);
  // Killed first, then started again.
  const calls = result.calls.filter((call) => ['kill-session', 'new-session'].includes(call));
  assert.deepEqual(calls, ['kill-session', 'new-session']);
  const args = result.args.split('\n');
  assert.equal(args[args.indexOf('-s') + 1], 'claude-restart');
  assert.equal(args[args.indexOf('-c') + 1], result.tempDir);
  assert.match(result.args, /'--resume' 'cli-uuid-1234'/);
  assert.match(result.args, /'--model' 'claude-opus-5-5' '--effort' 'high'/);
});

it('restart refuses before killing anything when the conversation cannot be resumed', async () => {
  const result = await restart({ cliSessionId: '' });
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, 'cli_session_id_unknown');
  assert.ok(!result.calls.includes('kill-session'), result.calls.join(','));
  assert.equal(result.args, '');
});

it('a second restart while one runs is refused, so only one kill and one launch happen', async () => {
  const result = await restart({ requests: 2 });
  assert.deepEqual(result.responses.map((response) => [response.statusCode, response.body.code ?? null]), [[200, null], [409, 'restart_in_progress']]);
  assert.deepEqual(result.calls.filter((call) => ['kill-session', 'new-session'].includes(call)), ['kill-session', 'new-session']);
});

it('a resume check that fails (stored MCP capabilities it cannot use) refuses before the kill', async () => {
  const result = await restart({ meta: { mcpCapabilities: { catalogVersion: 'stale', configurationDigest: 'stale' } } });
  assert.deepEqual([result.statusCode, result.body.code, result.body.stopped], [400, 'mcp_inherited_selection_invalid', false]);
  assert.ok(!result.calls.includes('kill-session'), result.calls.join(','));
});

// A session recorded under catalog A: the dueno server as it was before it gained the antigravity
// provider (Oct 29). The catalog is now B, so the recorded digest no longer matches.
function launchedUnderCatalogA() {
  const now = buildMcpCapabilityCatalog();
  const before = { ...now, servers: now.servers.map((server) => (server.id === 'dueno' ? { ...server, providers: server.providers.filter((p) => p !== 'antigravity') } : server)) };
  const recorded = sanitizedMcpSnapshot(resolveMcpCapabilities({ inherited: { serverIds: ['dueno'], profileId: 'dueno' }, provider: 'claude', runtime: 'claude', catalog: before }));
  const current = resolveMcpCapabilities({ inherited: { serverIds: ['dueno'], profileId: 'dueno' }, provider: 'claude', runtime: 'claude', catalog: now });
  assert.notEqual(recorded.configurationDigest, current.configurationDigest, 'the catalog change moves the digest');
  return recorded;
}

for (const route of ['restart', 'resume']) {
  it(`${route} of a session launched before a catalog change relaunches with its recorded MCP servers, no more`, async () => {
    const result = await restart({ route, meta: { mcpCapabilities: launchedUnderCatalogA() } });
    assert.equal(result.statusCode, 200, JSON.stringify(result.body));
    assert.match(result.args, /'--resume' 'cli-uuid-1234'/);
    assert.deepEqual(result.stored.mcpCapabilities.serverIds, ['dueno']);
    assert.deepEqual(Object.keys(result.mcpConfig.mcpServers), ['dueno']);
  });
}

it('a recorded MCP server that no longer exists is refused before the kill, saying why and what to do', async () => {
  const result = await restart({ meta: { mcpCapabilities: { ...launchedUnderCatalogA(), serverIds: ['dueno', 'retired-server'] } } });
  assert.equal(result.body.code, 'mcp_server_unknown');
  assert.equal(result.body.stopped, false);
  assert.match(result.body.error, /can't be reused: Unknown MCP server: retired-server\. Start a fresh session/);
  assert.ok(!result.calls.includes('kill-session'), result.calls.join(','));
});
