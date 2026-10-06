import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { prepareNonoLaunch } from '../modules/agent/nono-launch.mjs';

const run = promisify(execFile);

function realNono() {
  try {
    if (!readFileSync('/sys/kernel/security/lsm', 'utf8').includes('landlock')) return '';
    const path = execFileSync('which', ['nono'], { encoding: 'utf8' }).trim();
    return execFileSync(path, ['--version'], { encoding: 'utf8' }).trim() === 'nono 0.79.0' ? path : '';
  } catch {
    return '';
  }
}
const NONO = realNono();
const skip = NONO ? false : 'nono 0.79.0 with Landlock is not available';

// The base profile grants /tmp, and a read grant under it silently becomes read-write, so fixtures
// live under the real home (not granted once HOME points at the fake one).
async function fixture(t) {
  await mkdir(join(homedir(), '.cache'), { recursive: true });
  const root = await mkdtemp(join(homedir(), '.cache', 'cadre-nono-it-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', '.credentials.json'), '{"token":"auth"}');
  await writeFile(join(home, '.claude', 'settings.json'), '{"secret":true}');
  await writeFile(join(home, '.gitconfig'), '[user]\n\tname = t\n\temail = t@t\n[commit]\n\tgpgsign = false\n');
  const main = join(root, 'main');
  const env = { ...process.env, HOME: home, DM_STATE_DIR: join(root, 'state') };
  await mkdir(main);
  await run('git', ['-C', main, 'init', '-q'], { env });
  await run('git', ['-C', main, 'commit', '-q', '--allow-empty', '-m', 'init'], { env });
  await run('git', ['-C', main, 'worktree', 'add', '-q', join(root, 'wt')], { env });
  const priorStateDir = process.env.DM_STATE_DIR;
  process.env.DM_STATE_DIR = env.DM_STATE_DIR;
  t.after(() => {
    if (priorStateDir === undefined) delete process.env.DM_STATE_DIR;
    else process.env.DM_STATE_DIR = priorStateDir;
  });
  return { root, home, main, wt: join(root, 'wt'), env };
}

async function sandboxed({ home, wt, env }, script, extra = {}) {
  const launch = await prepareNonoLaunch({ provider: 'claude', sessionId: 'abcd1234', workDir: wt, env: { HOME: home }, ...extra });
  const result = await run(NONO, [...launch.args, '--', 'bash', '-c', script], {
    cwd: wt,
    env: { ...env, ...launch.env, CADRE_TEST_SECRET: 'leak', ...(extra.githubToken ? { CADRE_SANDBOX_GH_TOKEN: extra.githubToken } : {}) },
  }).catch((error) => error);
  return { launch, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

test('linked worktree commits under nono while git config and hooks stay read-only', { skip }, async (t) => {
  const fx = await fixture(t);
  const common = join(fx.main, '.git');
  const { stdout } = await sandboxed(fx, [
    'git commit -q --allow-empty -m sandboxed && echo COMMIT_OK',
    `echo x >> ${common}/config && echo CONFIG_WRITTEN`,
    `echo x > ${common}/hooks/pre-commit && echo HOOK_WRITTEN`,
  ].join('; '));
  assert.match(stdout, /COMMIT_OK/);
  assert.doesNotMatch(stdout, /CONFIG_WRITTEN|HOOK_WRITTEN/);
  assert.equal((await run('git', ['-C', fx.wt, 'log', '-1', '--format=%s'])).stdout.trim(), 'sandboxed');
});

test('a private tmux server is unreachable from inside nono', { skip }, async (t) => {
  const fx = await fixture(t);
  const socket = `cadre-nono-it-${process.pid}`;
  await run('tmux', ['-L', socket, 'new-session', '-d', '-s', 'probe', 'sleep 60'], { env: fx.env });
  t.after(() => run('tmux', ['-L', socket, 'kill-server']).catch(() => {}));
  const { stdout } = await sandboxed(fx, `tmux -L ${socket} ls && echo TMUX_REACHED; echo done`);
  assert.equal(stdout.trim(), 'done');
  assert.match((await run('tmux', ['-L', socket, 'ls'])).stdout, /^probe:/);
});

test('nono hides host config, /tmp and secret env but keeps auth readable', { skip }, async (t) => {
  const fx = await fixture(t);
  const probe = `/tmp/cadre-nono-it-${process.pid}`;
  t.after(() => rm(probe, { force: true }));
  const { stdout } = await sandboxed(fx, [
    `cat ${fx.home}/.claude/settings.json && echo SETTINGS_READ`,
    `echo x > ${probe} && echo TMP_WRITTEN`,
    'echo "secret=${CADRE_TEST_SECRET:-absent} source=${CADRE_SANDBOX_GH_TOKEN:-absent} gh=${GH_TOKEN:+set}"',
    'cat "$CLAUDE_CONFIG_DIR/.credentials.json" && echo',
    'echo x >> "$CLAUDE_CONFIG_DIR/.credentials.json" && echo AUTH_WRITTEN',
    'echo x > "$TMPDIR/ok" && echo TMPDIR_OK',
  ].join('; '), { githubToken: 'ghp_realsecret' });
  assert.doesNotMatch(stdout, /SETTINGS_READ|TMP_WRITTEN|AUTH_WRITTEN|"secret":true|ghp_realsecret/);
  assert.match(stdout, /secret=absent source=absent gh=set/);
  assert.match(stdout, /\{"token":"auth"\}/);
  assert.match(stdout, /TMPDIR_OK/);
});

test('createSession fails loudly on a bad nono profile and leaves no tmux session', { skip }, async (t) => {
  const fx = await fixture(t);
  const bin = join(fx.root, 'bin');
  const socket = `cadre-nono-create-${process.pid}`;
  await mkdir(bin);
  // Real nono; only `run` gets a missing profile. tmux is pinned to a private server.
  await writeFile(join(bin, 'nono'), `#!/bin/bash\nargs=(); prev=\nfor a in "$@"; do [ "$prev" = --profile ] && a=/nonexistent/cadre-bad.json; args+=("$a"); prev=$a; done\nexec ${NONO} "\${args[@]}"\n`);
  await writeFile(join(bin, 'tmux'), `#!/bin/sh\nexec ${execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()} -L ${socket} "$@"\n`);
  await writeFile(join(bin, 'claude'), '#!/bin/sh\nsleep 60\n');
  for (const name of ['nono', 'tmux', 'claude']) await chmod(join(bin, name), 0o755);
  t.after(() => run(join(bin, 'tmux'), ['kill-server']).catch(() => {}));
  const sessionsUrl = pathToFileURL(resolve('modules/sessions/index.mjs')).href;
  const script = `
    process.chdir(${JSON.stringify(fx.root)});
    const { createAgentSessionsProvider } = await import(${JSON.stringify(sessionsUrl)});
    const claude = createAgentSessionsProvider('claude');
    const options = { workDir: ${JSON.stringify(fx.wt)}, mcpProfile: 'default', sandbox: 'nono' };
    let error = null;
    await claude.createSession({ ...options, sessionId: 'aaaa1111' }).catch((err) => { error = err; });
    delete process.env.CADRE_SANDBOX;
    const off = await claude.createSession({ ...options, sessionId: 'bbbb2222' });
    console.log(JSON.stringify({ message: error?.message, off }));
  `;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...fx.env, PATH: `${bin}:${process.env.PATH}`, CADRE_SANDBOX: 'nono', CADRE_DISABLE_SIDE_EFFECTS: '1',
      CADRE_AGENT_CGROUP_ISOLATION: '0', CLAUDE_SESSIONS_STORAGE: 'file' },
    timeout: 30000,
  });
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  // nono exits at once, so the pane is gone and the launch log tail carries nono's own error line.
  assert.match(result.message, /^Agent process exited during startup:\nnono: Profile read error at \/nonexistent\/cadre-bad\.json/);
  const sessions = (await run(join(bin, 'tmux'), ['ls', '-F', '#{session_name}'])).stdout.trim().split('\n');
  assert.deepEqual(sessions, ['claude-bbbb2222']);
  await assert.rejects(readFile(join(fx.root, 'state/sandbox/claude-aaaa1111/claude/.credentials.json')), /ENOENT/);
  // With the switch off, an opted-in spawn launches exactly as before: no nono in the pane.
  const pane = (await run(join(bin, 'tmux'), ['display', '-p', '-t', 'claude-bbbb2222', '#{pane_start_command}'])).stdout;
  assert.doesNotMatch(pane, /'nono'|CLAUDE_CONFIG_DIR/);
  assert.match(pane, /unset CLAUDECODE; '[^']*\/bin\/claude' '--dangerously-skip-permissions'/);
});
