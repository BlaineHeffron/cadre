import { lstat, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from '../../lib/exec.mjs';
import { config } from '../../config.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import { tomlQuotedKeySegment } from './runtime-args.mjs';

// Design and verified behaviour: docs/research/nono-integration-design.md.
const CADRE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const NONO_VERSION = '0.79.0';
const AUTH_FILES = { claude: '.claude/.credentials.json', codex: '.codex/auth.json' };
const CONFIG_ENV = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };
let nonoReady = null;

const sandboxError = (message, code, statusCode) => Object.assign(new Error(message), { code, statusCode });

export function nonoProfilePath(provider) {
  return join(CADRE_ROOT, 'config', 'nono', `${provider}.json`);
}

// During rollout a spawn is sandboxed only when it asks for 'nono' and the process switch is on.
// A resumed session that was sandboxed must stay sandboxed.
export function resolveSandbox(requested = 'none', { env = process.env, resume = false } = {}) {
  if (!['nono', 'none'].includes(requested)) throw sandboxError('sandbox must be nono or none', 'sandbox_invalid', 400);
  if (requested === 'none') return 'none';
  if (env.CADRE_SANDBOX === 'nono') return 'nono';
  if (resume) throw sandboxError('Session was launched under nono; set CADRE_SANDBOX=nono to resume it', 'sandbox_required', 409);
  return 'none';
}

export function nonoStatePaths(provider, sessionId) {
  const stateDir = runtimeStatePath(`sandbox/${provider}-${sessionId}`);
  return { stateDir, tokenFile: `${stateDir}.gh-token` };
}

export function buildNonoArgs({ provider, stateDir, gitDir = '', commonDir = '', nodeModules = '', readFiles = [], credential = false, ports = [] }) {
  return [
    'run', '-s', '--no-diagnostics', '--profile', nonoProfilePath(provider), '--allow-cwd', '--allow', stateDir,
    ...(gitDir ? ['--read', commonDir, '--allow', gitDir, ...['objects', 'refs', 'logs'].flatMap((name) => ['--allow', join(commonDir, name)])] : []),
    ...(nodeModules ? ['--read', nodeModules] : []),
    '--read', join(CADRE_ROOT, 'modules'), '--read', join(CADRE_ROOT, 'scripts', 'agent-hooks'),
    ...readFiles.flatMap((file) => ['--read-file', file]),
    // Proxy mode: without landlock + explicit ports the proxy blocks Cadre's localhost services.
    ...(credential ? ['--credential', 'github', '--sandbox-policy', 'landlock', ...ports.flatMap((port) => ['--allow-connect-port', String(port)])] : []),
  ];
}

async function checkNono() {
  const version = await exec('nono', ['--version']);
  if (version.code !== 0 || version.stdout.trim() !== `nono ${NONO_VERSION}`) {
    throw new Error(`nono ${NONO_VERSION} is required: ${(version.stderr || version.stdout).trim()}`);
  }
  for (const provider of Object.keys(AUTH_FILES)) {
    const result = await exec('nono', ['profile', 'validate', nonoProfilePath(provider)]);
    if (result.code !== 0) throw new Error(`nono profile ${provider} is invalid: ${(result.stderr || result.stdout).trim()}`);
  }
}

async function assertNonoReady() {
  nonoReady ||= checkNono().catch((error) => {
    nonoReady = null;
    throw sandboxError(error.message, 'sandbox_unavailable', 500);
  });
  return nonoReady;
}

// The child can write <sd>. Before the host writes there again (resume), refuse anything it could have swapped
// for a link to host state.
async function assertOwnedEntry(path, directory) {
  const info = await lstat(path).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
  if (info && (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) {
    throw sandboxError(`Sandbox state is not a plain ${directory ? 'directory' : 'file'}: ${path}`, 'sandbox_state_tampered', 409);
  }
}

// Workdir content (.git pointers, node_modules links) is agent- or PR-controlled, so callers pass the grants
// derived at create time back in on resume instead of re-deriving them.
async function deriveGrants(root) {
  const git = await exec('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']);
  // Scratch dirs are not repos; a broken worktree must not silently lose its git grants.
  if (git.code !== 0 && await lstat(join(root, '.git')).then(() => true, () => false)) {
    throw sandboxError(`git rev-parse failed in ${root}: ${git.stderr.trim()}`, 'sandbox_git_unresolved', 500);
  }
  const [gitDir = '', commonDir = ''] = git.code === 0 ? git.stdout.trim().split('\n') : [];
  const nodeModules = await realpath(join(root, 'node_modules')).catch(() => '');
  return {
    ...(gitDir && gitDir !== commonDir ? { gitDir, commonDir } : { gitDir: '', commonDir: '' }),
    nodeModules: basename(nodeModules) === 'node_modules' && !nodeModules.startsWith(`${root}${sep}`) ? nodeModules : '',
  };
}

export async function prepareNonoLaunch({ provider, sessionId, workDir, grants, mcpLaunch = {}, promptLaunch = {}, headroom = { env: {} }, githubToken = '', env = process.env }) {
  await assertNonoReady();
  const { stateDir, tokenFile } = nonoStatePaths(provider, sessionId);
  const configDir = join(stateDir, provider);
  const configFiles = provider === 'claude' ? ['.claude.json', 'settings.json'] : ['config.toml'];
  for (const dir of [stateDir, configDir, join(stateDir, 'tmp'), join(stateDir, 'gh')]) await assertOwnedEntry(dir, true);
  for (const file of configFiles) await assertOwnedEntry(join(configDir, file), false);
  for (const dir of [configDir, join(stateDir, 'tmp'), join(stateDir, 'gh')]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const authFile = await realpath(join(env.HOME || homedir(), AUTH_FILES[provider]));
  const authLink = join(configDir, AUTH_FILES[provider].split('/').pop());
  await rm(authLink, { force: true });
  await symlink(authFile, authLink);

  const root = await realpath(workDir);
  // A fresh config dir otherwise stops the TUI at onboarding, permission, trust or update prompts.
  if (provider === 'claude') {
    await writeFile(join(configDir, '.claude.json'), '{"hasCompletedOnboarding":true}\n', { flag: 'wx' })
      .catch((error) => { if (error.code !== 'EEXIST') throw error; });
    await writeFile(join(configDir, 'settings.json'), '{"skipDangerousModePermissionPrompt":true}\n');
  } else {
    // Codex ignores the `-c projects.<dir>.trust_level` launch flag; only config.toml trust counts.
    await writeFile(join(configDir, 'config.toml'),
      `check_for_update_on_startup = false\n\n[projects.${tomlQuotedKeySegment(root)}]\ntrust_level = "trusted"\n`);
  }
  // Resume has no token of its own: a session created with the credential route keeps it or fails.
  const credential = Boolean(githubToken || grants?.credential);
  const resolvedGrants = { ...(grants || await deriveGrants(root)), credential };
  if (resolvedGrants.gitDir) {
    for (const name of ['objects', 'refs', 'logs']) await mkdir(join(resolvedGrants.commonDir, name), { recursive: true });
  }

  if (githubToken) await writeFile(tokenFile, githubToken, { mode: 0o600 });
  else if (credential && !await lstat(tokenFile).then((info) => info.isFile(), () => false)) {
    throw sandboxError('Sandboxed session has no GitHub token to resume with', 'sandbox_credential_missing', 409);
  }
  const ports = [config.agentBusMcpHttp.port, ...['ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL']
    .filter((key) => headroom.env?.[key]).map((key) => new URL(headroom.env[key]).port)];
  return {
    stateDir,
    tokenFile: credential ? tokenFile : '',
    grants: resolvedGrants,
    env: {
      [CONFIG_ENV[provider]]: configDir,
      ...(provider === 'claude' ? { CLAUDE_CODE_TMPDIR: join(stateDir, 'tmp') } : {}),
      TMPDIR: join(stateDir, 'tmp'),
      GH_CONFIG_DIR: join(stateDir, 'gh'),
    },
    args: buildNonoArgs({
      provider,
      stateDir,
      ...resolvedGrants,
      readFiles: [mcpLaunch.claudeConfigPath, promptLaunch.filePath, authFile].filter(Boolean),
      ports,
    }),
  };
}
