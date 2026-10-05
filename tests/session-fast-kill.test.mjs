import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const moduleUrl = (path) => pathToFileURL(resolve(path)).href;

async function runKill(t, { scoped = false, scopeStopFails = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cadre-fast-kill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import { mkdir, writeFile, stat, readFile } from 'node:fs/promises';
    import { execFile, spawn } from 'node:child_process';
    import { promisify } from 'node:util';
    import { join } from 'node:path';
    import Fastify from ${JSON.stringify(moduleUrl('node_modules/fastify/fastify.js'))};
    await (async () => {
    process.chdir(${JSON.stringify(root)});
    const { codexSessionsPlugin } = await import(${JSON.stringify(moduleUrl('modules/sessions/codex-sessions.mjs'))});
    const { AgentBusCredentialStore } = await import(${JSON.stringify(moduleUrl('modules/agent-bus/mcp-auth.mjs'))});
    const { readProcIdentity } = await import(${JSON.stringify(moduleUrl('modules/agent/process-termination.mjs'))});
    const exec = promisify(execFile);
    const scoped = ${scoped};
    const scopeStopFails = ${scopeStopFails};
    const id = 'fast-kill-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
    const scopeUnit = 'dueno-agent-codex-' + id + '.scope';
    const runtimeDir = '/run/user/' + process.getuid();
    const sessionName = 'codex-' + id;
    const repo = join(process.cwd(), 'repo');
    const worktree = join(process.cwd(), 'worktrees', 'pr-26-test', 'repo');
    const branch = 'dueno-fleet/' + id;
    await mkdir(repo);
    await exec('git', ['-C', repo, 'init', '-b', 'main']);
    await exec('git', ['-C', repo, 'config', 'user.email', 'test@example.invalid']);
    await exec('git', ['-C', repo, 'config', 'user.name', 'Test']);
    await writeFile(join(repo, 'README'), 'test');
    await exec('git', ['-C', repo, 'add', '.']);
    await exec('git', ['-C', repo, 'commit', '-m', 'initial']);
    await exec('git', ['-C', repo, 'worktree', 'add', '-b', branch, worktree]);
    await mkdir(join(worktree, 'large'));
    for (let i = 0; i < 7000; i++) await writeFile(join(worktree, 'large', String(i)), 'test');
    const launchLogPath = join(process.cwd(), 'log-is-a-directory');
    const warningsPath = join(process.cwd(), 'warnings.log');
    await mkdir(launchLogPath);
    await writeFile('.codex_sessions.json', JSON.stringify([{ id, tmuxSession: sessionName,
      source: 'dashboard', workDir: worktree, launchLogPath, managedWorktree: true, worktreePath: worktree,
      worktreeRepoPath: repo, worktreeBranch: branch, ...(scoped ? { agentScopeUnit: scopeUnit } : {}), created: Date.now() }]));
    let credentialState;
    const credentialStore = new AgentBusCredentialStore({ mode: 'issue_only', store: {
      mode: 'memory', async load() { return credentialState; }, async save(next) { credentialState = structuredClone(next); },
    } });
    const issued = await credentialStore.issue({ principal: { type: 'agent', kind: 'codex', sessionId: id }, attemptGeneration: 1 });
    const escaped = spawn('sleep', ['120'], { env: { ...process.env, DUENO_SESSION_ID: id }, stdio: 'ignore' });
    let app;
    let scopeProcess;
    try {
      if (scoped) {
        scopeProcess = spawn('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--unit=' + scopeUnit,
          '--property=KillMode=control-group', '--property=TimeoutStopSec=3s', 'sleep', '120'],
          { env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir }, stdio: 'ignore' });
        for (let i = 0; i < 200; i++) {
          const state = await exec('systemctl', ['--user', 'show', scopeUnit, '--property=ActiveState'], { env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir } });
          if (state.stdout.trim() === 'ActiveState=active') break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal((await exec('systemctl', ['--user', 'show', scopeUnit, '--property=ActiveState'], { env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir } })).stdout.trim(), 'ActiveState=active');
        process.env.XDG_RUNTIME_DIR = scopeStopFails ? join(process.cwd(), 'missing-bus') : runtimeDir;
        delete process.env.DBUS_SESSION_BUS_ADDRESS;
      }
      await exec('tmux', ['new-session', '-d', '-s', sessionName, 'env DUENO_SESSION_ID=' + id + ' sleep 120']);
      app = Fastify({ logger: { level: 'warn', file: warningsPath } });
      await app.register(codexSessionsPlugin, { credentialStore, wsManager: { broadcast() {}, onChannel() {}, channels: new Map() } });
      await app.ready();
      const response = await app.inject({ method: 'DELETE', url: '/api/codex/sessions/' + id });
      if (scopeStopFails) {
        assert.equal(response.statusCode, 409, response.body);
        assert.equal(response.json().reason, 'agent_scope_lookup_failed');
        const residual = await readProcIdentity(escaped.pid);
        assert.ok(!residual || residual.state === 'Z', 'failed scope stop still runs process verification');
        await assert.rejects(exec('tmux', ['has-session', '-t', sessionName]));
        return;
      }
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().status, 'terminated');
      const auth = await credentialStore.authenticate(issued.token);
      assert.equal(auth.ok, false);
      assert.equal(auth.reason, 'revoked');
      await assert.rejects(exec('tmux', ['has-session', '-t', sessionName]));
      const residual = await readProcIdentity(escaped.pid);
      if (scoped) {
        // This test-owned stamped process is deliberately outside the scope. Its survival proves
        // the successful scope path skips the environment scan and extra terminate passes.
        assert.ok(residual && residual.state !== 'Z');
        assert.notEqual((await exec('systemctl', ['--user', 'show', scopeUnit, '--property=ActiveState'])).stdout.trim(), 'ActiveState=active');
      } else {
        assert.ok(!residual || residual.state === 'Z');
      }
      // Ordering assertion: the response arrives while bulk worktree cleanup remains outstanding.
      await stat(worktree);
      for (let i = 0; i < 200; i++) {
        if (!(await stat(worktree).then(() => true, () => false))) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await assert.rejects(stat(worktree), { code: 'ENOENT' });
      // Wait for branch cleanup too so no background operation outlives the fixture.
      for (let i = 0; i < 200; i++) {
        if (!(await exec('git', ['-C', repo, 'branch', '--list', branch])).stdout.trim()) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal((await exec('git', ['-C', repo, 'branch', '--list', branch])).stdout.trim(), '');
      for (let i = 0; i < 200; i++) {
        if ((await readFile(warningsPath, 'utf8').catch(() => '')).includes('Session artifact cleanup failed')) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const warnings = (await readFile(warningsPath, 'utf8')).trim().split('\\n').map((line) => JSON.parse(line));
      assert.ok(warnings.some((entry) => entry.level === 40 && entry.id === id && entry.path === launchLogPath
        && entry.msg === 'Session artifact cleanup failed'), 'background cleanup errors include session and path at warn');
    } finally {
      await exec('tmux', ['kill-session', '-t', sessionName]).catch(() => {});
      if (escaped.exitCode === null && escaped.signalCode === null) escaped.kill('SIGKILL');
      if (scopeProcess) {
        await exec('systemctl', ['--user', 'stop', scopeUnit], { env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: 'unix:path=' + runtimeDir + '/bus' } }).catch(() => {});
      }
      await app?.close();
    }
    })();
  `;
  await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: root,
    env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8', APP_STATE_STORAGE: 'file', CODEX_SESSIONS_STORAGE: 'file',
      DATABASE_URL: '', CODEX_APP_SERVER_ENABLED: '0', CADRE_STRUCTURED_AUTOMATED_SPAWNS: '0',
      CADRE_DISABLE_SIDE_EFFECTS: '1', CADRE_GITHUB_AGENT_POLLER_ENABLED: '0', CADRE_GITHUB_AGENTS_ENABLED: '0',
      CADRE_SCHEDULED_AGENT_PUMP_ENABLED: '0', TELEGRAM_BRIDGE: '0' },
  });
}


test('DELETE kills real tmux and stamped processes, revokes credentials, then removes a large real worktree', { timeout: 30000 }, (t) => runKill(t));

test('successful real scope stop skips extra process scans', { timeout: 30000 }, async (t) => {
  const bus = await execFileAsync('systemctl', ['--user', 'show', '--property=Version'], {
    env: { ...process.env, XDG_RUNTIME_DIR: '/run/user/' + process.getuid() },
  }).then(() => true, () => false);
  if (!bus) return t.skip('User systemd bus unavailable');
  await runKill(t, { scoped: true });
});

test('failed real scope stop keeps full process verification', { timeout: 30000 }, async (t) => {
  const bus = await execFileAsync('systemctl', ['--user', 'show', '--property=Version'], {
    env: { ...process.env, XDG_RUNTIME_DIR: '/run/user/' + process.getuid() },
  }).then(() => true, () => false);
  if (!bus) return t.skip('User systemd bus unavailable');
  await runKill(t, { scoped: true, scopeStopFails: true });
});
