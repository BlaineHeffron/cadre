import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { afterEach, describe, it } from 'node:test';
import { cadreEnvName, readEnv, withCadreEnv } from '../modules/platform/cadre-env.mjs';
import { buildLaunchEnvPrefix } from '../modules/agent/launch-env.mjs';
import { ProcessSupervisor } from '../modules/agent/process-supervisor.mjs';
import { shouldSuppressSideEffectLoops } from '../modules/platform/side-effect-loops.mjs';
import { runtimeStateDir } from '../modules/ops/runtime-state.mjs';

const execFileAsync = promisify(execFile);
const configModulePath = resolve(new URL('../config.mjs', import.meta.url).pathname);
const roots = [];
afterEach(async () => {
  while (roots.length) await rm(roots.pop(), { recursive: true, force: true });
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'dueno-cadre-env-'));
  roots.push(root);
  return root;
}

// Ambient DM_/DUENO_/CADRE_ vars (e.g. from a Fleet-launched shell) are dropped so
// each case controls exactly which names are set. `dotenv` is written to the child's cwd.
async function loadConfig(vars, dotenv = '') {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DM|DUENO|CADRE)_/.test(key)));
  const script = `process.stdout.write(JSON.stringify((await import(${JSON.stringify(configModulePath)})).config));`;
  const cwd = await tempRoot();
  await writeFile(join(cwd, '.env'), dotenv);
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, ...vars }, cwd });
  return JSON.parse(stdout);
}

describe('CADRE_ env resolver', () => {
  it('maps both legacy prefixes to CADRE_ and leaves other names alone', () => {
    assert.equal(cadreEnvName('DM_STATE_DIR'), 'CADRE_STATE_DIR');
    assert.equal(cadreEnvName('DUENO_SESSION_ID'), 'CADRE_SESSION_ID');
    assert.equal(cadreEnvName('AUTH_TOKEN'), 'AUTH_TOKEN');
    assert.equal(cadreEnvName('XDM_STATE_DIR'), 'XDM_STATE_DIR');
  });

  it('prefers the CADRE_ name, including an explicit empty value, and falls back to the legacy name', () => {
    assert.equal(readEnv('DM_STATE_DIR', { CADRE_STATE_DIR: '/new', DM_STATE_DIR: '/old' }), '/new');
    assert.equal(readEnv('DM_STATE_DIR', { CADRE_STATE_DIR: '', DM_STATE_DIR: '/old' }), '');
    assert.equal(readEnv('DM_STATE_DIR', { DM_STATE_DIR: '/old' }), '/old');
    assert.equal(readEnv('DM_STATE_DIR', {}), undefined);
    assert.equal(readEnv('GITHUB_TOKEN', { GITHUB_TOKEN: 'gh' }), 'gh');
  });

  it('applies to config helpers for strings, ints, flags, and JSON', async () => {
    const config = await loadConfig({
      CADRE_MCP_GOOGLE_MODE: 'managed', DM_MCP_GOOGLE_MODE: 'local',
      CADRE_TELEGRAM_RELAY_TICK_SECS: '9', DM_TELEGRAM_RELAY_TICK_SECS: '7',
      CADRE_GITHUB_AGENT_AUTO_REVIEW_ENABLED: '0', DM_GITHUB_AGENT_AUTO_REVIEW_ENABLED: '1',
      CADRE_FLEET_REPO_PATHS_JSON: '{"cadre":"/c"}', DM_FLEET_REPO_PATHS_JSON: '{"legacy":"/l"}',
      DM_SCHEDULED_AGENT_TICK_SECS: '11',
    });
    assert.equal(config.mcpCredentials.googleMode, 'managed');
    assert.equal(config.telegramRelay.tickIntervalSec, 9);
    assert.equal(config.githubAgents.autoReviewEnabled, false);
    assert.deepEqual(config.fleet.repoPaths, { cadre: '/c' });
    assert.equal(config.scheduledAgents.tickIntervalSec, 11);
  });

  it('keeps legacy aliases that feed one setting distinct under CADRE_', async () => {
    // DM_GITHUB_AGENTS_ENABLED is the older alias of DM_GITHUB_AGENT_POLLER_ENABLED;
    // they map to different CADRE_ names, so the poller name still takes precedence.
    assert.equal((await loadConfig({ CADRE_GITHUB_AGENTS_ENABLED: '1' })).githubAgents.enabled, true);
    assert.equal((await loadConfig({
      CADRE_GITHUB_AGENT_POLLER_ENABLED: '0', CADRE_GITHUB_AGENTS_ENABLED: '1',
    })).githubAgents.enabled, false);
  });

  it('lets a test-set CADRE_ override beat a checkout .env, where a legacy override would not', async () => {
    // Test isolation must set CADRE_ names: dotenv fills in the .env CADRE_ value
    // around a legacy-only override, and the resolver prefers it.
    const dotenv = 'CADRE_STATE_DIR=/real/state\nDM_STATE_DIR=/legacy/state\n';
    const stateFile = async (vars) => (await loadConfig(vars, dotenv)).mcpCredentials.stateFile;
    assert.equal(await stateFile({ CADRE_STATE_DIR: '/tmp/test-state' }), '/tmp/test-state/mcp_session_servers.json');
    assert.equal(await stateFile({ DM_STATE_DIR: '/tmp/test-state' }), '/real/state/mcp_session_servers.json');
  });

  it('applies to direct reads outside config', () => {
    assert.equal(shouldSuppressSideEffectLoops({ env: { CADRE_DISABLE_SIDE_EFFECTS: '1', PORT: '4310' } }), true);
    assert.equal(shouldSuppressSideEffectLoops({ env: { CADRE_ALLOW_SIDE_EFFECTS: '1', DUENO_DISABLE_SIDE_EFFECTS: '1' } }), false);
    assert.equal(runtimeStateDir({ CADRE_STATE_DIR: '/cadre/state', DM_STATE_DIR: '/legacy/state' }), '/cadre/state');
  });
});

describe('dual injection into spawned sessions', () => {
  it('writes each injected var under both names', () => {
    assert.deepEqual(withCadreEnv({ DUENO_SESSION_ID: 's1', PATH: '/bin' }),
      { CADRE_SESSION_ID: 's1', DUENO_SESSION_ID: 's1', PATH: '/bin' });
  });

  it('exports both names from the tmux launch prefix, replacing inherited values', async () => {
    const prefix = buildLaunchEnvPrefix("s'1", 'claude');
    const { stdout } = await execFileAsync('bash', ['-c',
      `${prefix}; printf '%s|%s|%s|%s' "$CADRE_SESSION_ID" "$DUENO_SESSION_ID" "$CADRE_PROVIDER" "$DUENO_PROVIDER"`],
    { env: { PATH: process.env.PATH, CADRE_SESSION_ID: 'stale-parent', DUENO_SESSION_ID: 'stale-parent' } });
    assert.equal(stdout, "s'1|s'1|claude|claude");
  });

  it('passes the CADRE_ twin of allowlisted keys and marks the child under both names', { timeout: 15000 }, async () => {
    const root = await tempRoot();
    const work = join(root, 'work');
    await mkdir(work);
    let childEnv;
    const supervisor = new ProcessSupervisor({
      ledgerPath: join(root, 'ledger.json'),
      spawnImpl(command, args, options) {
        childEnv = options.env;
        return spawn(command, args, options);
      },
    });
    const runtime = await supervisor.spawn({
      instanceId: 'cadre-runtime', driver: 'test-structured', command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'], cwd: work,
      env: { ...withCadreEnv({ DUENO_SESSION_ID: 's1' }), CADRE_UNLISTED: 'secret' },
      allowedEnvKeys: ['DUENO_SESSION_ID'],
    });
    try {
      assert.deepEqual(childEnv, {
        CADRE_SESSION_ID: 's1', DUENO_SESSION_ID: 's1',
        CADRE_RUNTIME_INSTANCE_ID: 'cadre-runtime', DUENO_RUNTIME_INSTANCE_ID: 'cadre-runtime',
      });
    } finally {
      assert.equal((await supervisor.terminate('cadre-runtime', { graceMs: 100 })).ok, true, `pid ${runtime.pid}`);
    }
  });
});
