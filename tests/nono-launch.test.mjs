import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildNonoArgs, nonoProfilePath, prepareNonoLaunch, resolveSandbox } from '../modules/agent/nono-launch.mjs';
import { createAgentSessionsProvider, renderAgentSessionLaunch } from '../modules/sessions/index.mjs';
import { RESEARCH_PROFILE_ID } from '../modules/integrations/research-profile.mjs';
import { seedClaudeWorkspaceTrust } from '../modules/platform/mcp-seed.mjs';

const run = promisify(execFile);
const git = (cwd, ...args) => run('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args]);
const CADRE_ROOT = resolve('.');

// A fake nono on PATH lets the host-side preparation run without the real binary.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cadre-nono-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'nono'), '#!/bin/sh\n[ "$1" = --version ] && echo "nono ${FAKE_NONO_VERSION:-0.79.0}"\nexit 0\n');
  await chmod(join(bin, 'nono'), 0o755);
  const home = join(root, 'home');
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(join(home, '.claude', '.credentials.json'), '{}');
  await writeFile(join(home, '.codex', 'auth.json'), '{}');
  const saved = { PATH: process.env.PATH, DM_STATE_DIR: process.env.DM_STATE_DIR };
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.DM_STATE_DIR = join(root, 'state');
  t.after(() => Object.assign(process.env, saved));
  const main = join(root, 'main');
  await mkdir(main);
  await git(main, 'init', '-q');
  await git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  await git(main, 'worktree', 'add', '-q', join(root, 'wt'));
  return { root, home, main, wt: join(root, 'wt'), state: join(root, 'state') };
}

test('resolveSandbox only sandboxes opted-in spawns while the switch is on, and resume refuses to drop it', () => {
  const on = { env: { CADRE_SANDBOX: 'nono' } };
  assert.equal(resolveSandbox(undefined, on), 'none');
  assert.equal(resolveSandbox('none', on), 'none');
  assert.equal(resolveSandbox('nono', on), 'nono');
  assert.equal(resolveSandbox('nono', { env: {} }), 'none');
  assert.equal(resolveSandbox('nono', { env: { CADRE_SANDBOX: '1' } }), 'none');
  assert.equal(resolveSandbox(undefined, { env: {}, resume: true }), 'none');
  assert.equal(resolveSandbox('nono', { ...on, resume: true }), 'nono');
  assert.throws(() => resolveSandbox('nono', { env: {}, resume: true }), { code: 'sandbox_required', statusCode: 409 });
  assert.throws(() => resolveSandbox('bwrap', on), { code: 'sandbox_invalid', statusCode: 400 });
});

test('buildNonoArgs grants only modules and hooks from the Cadre checkout and adds network flags only in proxy mode', () => {
  const open = buildNonoArgs({ provider: 'codex', stateDir: '/s', ports: [8765] });
  assert.deepEqual(open, ['run', '-s', '--no-diagnostics', '--profile', join(CADRE_ROOT, 'config/nono/codex.json'), '--allow-cwd',
    '--allow', '/s', '--read', join(CADRE_ROOT, 'modules'), '--read', join(CADRE_ROOT, 'scripts/agent-hooks')]);
  const proxy = buildNonoArgs({ provider: 'claude', stateDir: '/s', credential: true, ports: [8765, '8787'] });
  assert.deepEqual(proxy.slice(-8), ['--credential', 'github', '--sandbox-policy', 'landlock',
    '--allow-connect-port', '8765', '--allow-connect-port', '8787']);
  for (const args of [open, proxy]) {
    const grants = args.filter((_, index) => ['--read', '--allow'].includes(args[index - 1]));
    assert.equal(grants.some((path) => path === CADRE_ROOT || `${CADRE_ROOT}/`.startsWith(`${path}/`)), false);
  }
});

test('prepareNonoLaunch grants exact git dirs for a linked worktree, none for a plain repo, and links auth read-only', async (t) => {
  const { home, main, wt, state } = await fixture(t);
  const env = { HOME: home };
  const linked = await prepareNonoLaunch({ provider: 'claude', sessionId: 'aaaa1111', workDir: wt, env,
    mcpLaunch: { claudeConfigPath: '/state/mcp.json' } });
  const common = join(main, '.git');
  const sd = join(state, 'sandbox/claude-aaaa1111');
  assert.deepEqual(linked.args.slice(8, 18), ['--read', common, '--allow', join(common, 'worktrees/wt'),
    '--allow', join(common, 'objects'), '--allow', join(common, 'refs'), '--allow', join(common, 'logs')]);
  assert.deepEqual(linked.args.slice(-4), ['--read-file', '/state/mcp.json', '--read-file', join(home, '.claude/.credentials.json')]);
  assert.equal(linked.args.includes('--credential'), false);
  assert.deepEqual(linked.env, { CLAUDE_CONFIG_DIR: join(sd, 'claude'), CLAUDE_CODE_TMPDIR: join(sd, 'tmp'),
    TMPDIR: join(sd, 'tmp'), GH_CONFIG_DIR: join(sd, 'gh') });
  assert.equal(await readlink(join(sd, 'claude/.credentials.json')), join(home, '.claude/.credentials.json'));
  assert.deepEqual(JSON.parse(await readFile(join(sd, 'claude/.claude.json'), 'utf8')), { hasCompletedOnboarding: true });
  assert.deepEqual(JSON.parse(await readFile(join(sd, 'claude/settings.json'), 'utf8')), { skipDangerousModePermissionPrompt: true });

  const plain = await prepareNonoLaunch({ provider: 'codex', sessionId: 'bbbb2222', workDir: main, env });
  assert.equal(plain.args.some((arg) => arg.includes('.git')), false);
  assert.equal(plain.env.CODEX_HOME, join(state, 'sandbox/codex-bbbb2222/codex'));
  assert.equal(await readlink(join(plain.env.CODEX_HOME, 'auth.json')), join(home, '.codex/auth.json'));
  assert.equal(await readFile(join(plain.env.CODEX_HOME, 'config.toml'), 'utf8'),
    `check_for_update_on_startup = false\n\n[projects."${main}"]\ntrust_level = "trusted"\n`);

  // node_modules is granted only when it resolves to a node_modules dir outside the workdir.
  await mkdir(join(main, 'node_modules'));
  await symlink(join(main, 'node_modules'), join(wt, 'node_modules'));
  const shared = await prepareNonoLaunch({ provider: 'claude', sessionId: 'aaaa1111', workDir: wt, env });
  assert.equal(shared.args[shared.args.indexOf(join(main, 'node_modules')) - 1], '--read');
  assert.equal(shared.grants.nodeModules, join(main, 'node_modules'));
  assert.equal((await prepareNonoLaunch({ provider: 'codex', sessionId: 'bbbb2222', workDir: main, env })).args.includes(join(main, 'node_modules')), false);
  await rm(join(wt, 'node_modules'));
  await symlink(join(home, '.claude'), join(wt, 'node_modules'));
  const hostile = await prepareNonoLaunch({ provider: 'claude', sessionId: 'aaaa1111', workDir: wt, env });
  assert.equal(hostile.args.includes(join(home, '.claude')), false);

  await assert.rejects(prepareNonoLaunch({ provider: 'claude', sessionId: 'cccc3333', workDir: wt, env: { HOME: wt } }), /ENOENT/);
});

test('prepareNonoLaunch writes the reviewer token outside the state dir and opens loopback ports for proxy mode', async (t) => {
  const { home, wt, state } = await fixture(t);
  const launch = await prepareNonoLaunch({ provider: 'codex', sessionId: 'dddd4444', workDir: wt, env: { HOME: home },
    headroom: { env: { OPENAI_BASE_URL: 'http://127.0.0.1:8787/v1' } }, githubToken: 'ghp_secret' });
  assert.equal(launch.tokenFile, join(state, 'sandbox/codex-dddd4444.gh-token'));
  assert.equal(await readFile(launch.tokenFile, 'utf8'), 'ghp_secret');
  assert.deepEqual(launch.args.slice(launch.args.indexOf('--credential')), ['--credential', 'github', '--sandbox-policy', 'landlock',
    '--allow-connect-port', '8765', '--allow-connect-port', '8787']);

  // Resume keeps the credential route from the persisted grants, and fails closed once the token is gone.
  const resumed = await prepareNonoLaunch({ provider: 'codex', sessionId: 'dddd4444', workDir: wt, env: { HOME: home }, grants: launch.grants });
  assert.deepEqual([resumed.tokenFile, resumed.args.includes('--credential')], [launch.tokenFile, true]);
  await rm(launch.tokenFile);
  await assert.rejects(prepareNonoLaunch({ provider: 'codex', sessionId: 'dddd4444', workDir: wt, env: { HOME: home }, grants: launch.grants }),
    { code: 'sandbox_credential_missing' });

  // A scratch dir is not a repo; a worktree whose gitdir is gone must fail instead of losing its git grants.
  const scratch = join(state, 'scratch');
  await mkdir(scratch);
  assert.equal((await prepareNonoLaunch({ provider: 'codex', sessionId: 'dddd5555', workDir: scratch, env: { HOME: home } })).grants.gitDir, '');
  await writeFile(join(scratch, '.git'), `gitdir: ${join(state, 'missing')}\n`);
  await assert.rejects(prepareNonoLaunch({ provider: 'codex', sessionId: 'dddd5555', workDir: scratch, env: { HOME: home } }),
    { code: 'sandbox_git_unresolved' });
});

test('prepareNonoLaunch refuses an unpinned nono version and rechecks on the next spawn', async (t) => {
  const { home, wt } = await fixture(t);
  process.env.FAKE_NONO_VERSION = '0.80.0';
  t.after(() => delete process.env.FAKE_NONO_VERSION);
  // The success cache is per process; this file's earlier tests already passed the check.
  const fresh = await import(`../modules/agent/nono-launch.mjs?fresh=${Date.now()}`);
  await assert.rejects(fresh.prepareNonoLaunch({ provider: 'claude', sessionId: 'eeee5555', workDir: wt, env: { HOME: home } }),
    { code: 'sandbox_unavailable', statusCode: 500, message: /nono 0\.79\.0 is required/ });
  delete process.env.FAKE_NONO_VERSION;
  await fresh.prepareNonoLaunch({ provider: 'claude', sessionId: 'eeee5555', workDir: wt, env: { HOME: home } });
});

test('renderAgentSessionLaunch wraps the binary in nono without leaking the GitHub token', async (t) => {
  const { home, wt } = await fixture(t);
  const sandbox = await prepareNonoLaunch({ provider: 'claude', sessionId: 'ffff6666', workDir: wt, env: { HOME: home }, githubToken: 'ghp_secret' });
  const { allArgs, paneCommand } = renderAgentSessionLaunch({ backendType: 'claude', sessionBinary: '/bin/claude',
    sessionId: 'ffff6666', provider: 'anthropic', sandbox, buildOptions: { workDir: wt, initialPromptFile: '/p.txt' } });
  assert.equal(allArgs[0], '--dangerously-skip-permissions');
  assert.equal(paneCommand.includes('ghp_secret'), false);
  assert.match(paneCommand, new RegExp(`export CADRE_SANDBOX_GH_TOKEN="\\$\\(< '${sandbox.tokenFile}'\\)"`));
  for (const [key, value] of Object.entries(sandbox.env)) assert.ok(paneCommand.includes(`export ${key}='${value}'`), key);
  assert.ok(paneCommand.includes(`unset CLAUDECODE; 'nono' 'run' '-s' '--no-diagnostics' '--profile' '${nonoProfilePath('claude')}'`));
  assert.ok(paneCommand.includes(`'--' '/bin/claude' '--dangerously-skip-permissions'`));
  assert.ok(paneCommand.endsWith(`-- "$(< '/p.txt')"`));
});

test('the pane command preserves the unsandboxed launch contract', () => {
  const { paneCommand } = renderAgentSessionLaunch({ backendType: 'codex', sessionBinary: '/bin/codex', launchLogPath: '/state/launch.log',
    sessionId: 'abcd1234', provider: 'openai', buildOptions: { workDir: '/work', initialPromptFile: '/state/prompt.txt',
      mcpLaunch: { codexArgs: ['-c', 'mcp_servers={}'], credentialPath: '/state/cred', credentialEnvVar: 'DUENO_AGENT_BUS_TOKEN' } } });
  assert.equal(paneCommand, "export CADRE_SESSION_ID='abcd1234'; export DUENO_SESSION_ID='abcd1234'; export CADRE_PROVIDER='openai'; export DUENO_PROVIDER='openai'; export CODEX_INTERNAL_ORIGINATOR_OVERRIDE='dueno-abcd1234'; export DUENO_AGENT_BUS_TOKEN=\"$(< '/state/cred')\"; export CADRE_AGENT_BUS_TOKEN=\"$DUENO_AGENT_BUS_TOKEN\"; '/bin/codex' '--dangerously-bypass-approvals-and-sandbox' '--cd' '/work' '-c' 'model_provider=\"openai\"' '-c' 'features.hooks=true' '-c' 'check_for_update_on_startup=false' '-c' 'plugins.\"browser@openai-bundled\".enabled=false' '--no-alt-screen' '-c' 'mcp_servers={}' -- \"$(< '/state/prompt.txt')\" 2> >(tee -a '/state/launch.log' >&2)");
});

test('seedClaudeWorkspaceTrust writes to an explicit config path', async (t) => {
  const { root, wt } = await fixture(t);
  const configPath = join(root, 'private/.claude.json');
  await mkdir(join(root, 'private'));
  await writeFile(configPath, '{"hasCompletedOnboarding":true}');
  await seedClaudeWorkspaceTrust(wt, { configPath });
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), { hasCompletedOnboarding: true, projects: { [wt]: { hasTrustDialogAccepted: true } } });
});

test('createSession rejects nono for Pi, the Codex research safe runtime, added plugins and stdio/research MCP before launch', async (t) => {
  process.env.CADRE_SANDBOX = 'nono';
  t.after(() => delete process.env.CADRE_SANDBOX);
  const research = { researchWorkbench: { profileId: RESEARCH_PROFILE_ID } };
  await assert.rejects(createAgentSessionsProvider('codex').createSession({ workDir: tmpdir(), sandbox: 'nono', metadata: research }),
    { code: 'sandbox_unsupported', statusCode: 400 });
  await assert.rejects(createAgentSessionsProvider('pi').createSession({ workDir: tmpdir(), sandbox: 'nono', provider: 'xai', model: 'grok-4.3' }),
    { code: 'sandbox_unsupported', statusCode: 400 });
  await assert.rejects(createAgentSessionsProvider('codex').createSession({ workDir: tmpdir(), sandbox: 'nono',
    codexPlugins: { add: ['browser@openai-bundled'] } }), { code: 'sandbox_unsupported', statusCode: 400 });
  await assert.rejects(createAgentSessionsProvider('claude').createSession({ workDir: tmpdir(), sandbox: 'nono',
    mcpServers: { add: ['playwright'] } }), { code: 'sandbox_unsupported', statusCode: 400 });
});

test('resume reuses create-time grants and refuses state the child could have swapped for host links', async (t) => {
  const { root, home, main, wt, state } = await fixture(t);
  const env = { HOME: home };
  const created = await prepareNonoLaunch({ provider: 'claude', sessionId: 'abab1212', workDir: wt, env,
    promptLaunch: { filePath: '/state/prompt_profiles/claude-abab1212.txt' } });
  assert.deepEqual(created.grants, { gitDir: join(main, '.git/worktrees/wt'), commonDir: join(main, '.git'), nodeModules: '', credential: false });
  assert.equal(created.args[created.args.indexOf('/state/prompt_profiles/claude-abab1212.txt') - 1], '--read-file');

  // The child rewrites the worktree's gitdir pointer; resume keeps the persisted grants.
  const other = join(root, 'other');
  await mkdir(other);
  await git(other, 'init', '-q');
  await writeFile(join(wt, '.git'), `gitdir: ${join(other, '.git')}\n`);
  const resumed = await prepareNonoLaunch({ provider: 'claude', sessionId: 'abab1212', workDir: wt, env, grants: created.grants });
  assert.equal(resumed.args.some((arg) => arg.startsWith(other)), false);
  assert.deepEqual(resumed.args.slice(8, 18), created.args.slice(8, 18));

  // A host-owned stand-in for ~/.claude; the real one is never touched.
  const decoy = join(root, 'decoy');
  await mkdir(decoy);
  await writeFile(join(decoy, '.credentials.json'), 'host');
  await writeFile(join(decoy, 'settings.json'), 'host');
  const sd = join(state, 'sandbox/claude-abab1212');
  const tamper = async (path, make) => { await rm(path, { recursive: true, force: true }); await make(path); };
  for (const [path, make] of [
    [join(sd, 'claude'), (path) => symlink(decoy, path)],
    [join(sd, 'tmp'), (path) => symlink(decoy, path)],
    [join(sd, 'claude/settings.json'), (path) => symlink(join(decoy, 'settings.json'), path)],
    [join(sd, 'claude/.claude.json'), (path) => link(join(decoy, 'settings.json'), path)],
  ]) {
    await tamper(path, make);
    await assert.rejects(prepareNonoLaunch({ provider: 'claude', sessionId: 'abab1212', workDir: wt, env, grants: created.grants }),
      { code: 'sandbox_state_tampered' });
    await rm(path, { recursive: true, force: true });
    await prepareNonoLaunch({ provider: 'claude', sessionId: 'abab1212', workDir: wt, env, grants: created.grants });
  }
  assert.equal(await readFile(join(decoy, '.credentials.json'), 'utf8'), 'host');
  assert.equal(await readFile(join(decoy, 'settings.json'), 'utf8'), 'host');

  const codexState = join(state, 'sandbox/codex-abab1212/codex');
  await prepareNonoLaunch({ provider: 'codex', sessionId: 'abab1212', workDir: wt, env, grants: created.grants });
  await tamper(join(codexState, 'config.toml'), (path) => symlink(join(decoy, 'settings.json'), path));
  await assert.rejects(prepareNonoLaunch({ provider: 'codex', sessionId: 'abab1212', workDir: wt, env, grants: created.grants }),
    { code: 'sandbox_state_tampered' });
  assert.equal(await readFile(join(decoy, 'settings.json'), 'utf8'), 'host');
});
