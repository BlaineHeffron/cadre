import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const configModulePath = resolve(new URL('../config.mjs', import.meta.url).pathname);

async function importConfigWithEnv(overrides) {
  // The child runs in a temp cwd (no .env), so dropping every prefixed var isolates it
  // from ambient DM_/DUENO_/CADRE_ values; cases set CADRE_ names explicitly.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(DM|DUENO|CADRE)_/.test(key)));
  const keys = [
    'HOST',
    'AUTH_TOKEN',
    'INTERNAL_BYPASS_TOKEN',
    'BROWSER_SESSION_SECRET',
    'TLS_ENABLED',
    'AGENT_BUS_MCP_HTTP_HOST',
    'AGENT_BUS_MCP_HTTP_PORT',
    'AGENT_BUS_MCP_HTTP_PATH',
    'AGENT_SESSION_IDEMPOTENCY_TTL_MS',
    'PC_FLAG_AGENT_BUS_DELIVERY_REPLAY_ENABLED',
    'CADRE_COMMAND_CENTER_FLEET_INVESTIGATION_WORKTREE_REAP_ENABLED',
    'CADRE_COMMAND_CENTER_FLEET_INVESTIGATION_WORKTREE_REAP_MIN_AGE_SECS',
    'CADRE_COMMAND_CENTER_FLEET_INVESTIGATION_WORKTREE_REAP_MAX_PER_PASS',
    'CADRE_FLEET_REPO_PATHS_JSON',
    'CADRE_GITHUB_AGENT_POLLER_ENABLED',
    'CADRE_GITHUB_AGENT_POLL_INTERVAL_SECS',
    'CADRE_GITHUB_AGENT_AUTO_REVIEW_ENABLED',
    'CADRE_GITHUB_AGENT_WORKTREE_REAP_ENABLED',
    'CADRE_GITHUB_AGENT_WORKTREE_REAP_MIN_AGE_SECS',
    'CADRE_GITHUB_AGENT_REPO_PATHS_JSON',
    'CADRE_GITHUB_AGENT_WORKDIR',
    'CADRE_GITHUB_AGENT_PROVIDER',
    'CADRE_GITHUB_AGENT_MODEL',
    'CADRE_GITHUB_AGENT_THINKING_LEVEL',
    'CADRE_GITHUB_AGENT_MAX_SPAWNS_PER_POLL',
    'CADRE_GITHUB_AGENT_WORKTREE_REAP_MAX_PER_PASS',
    'CADRE_FLEET_HYGIENE_REPO_PATHS_JSON',
    'CADRE_FLEET_HYGIENE_PROVIDER',
    'CADRE_FLEET_HYGIENE_MODEL',
    'CADRE_DEPENDENCY_WATCH_REPO_PATHS_JSON',
    'CADRE_DEPENDENCY_WATCH_PROVIDER',
    'CADRE_DEPENDENCY_WATCH_MODEL',
    'CADRE_DEPENDENCY_WATCH_INTERVAL_SECONDS',
    'CADRE_SKILLS_UPSTREAM_REPO_PATH',
    'CADRE_SKILLS_UPSTREAM_PROVIDER',
    'CADRE_SKILLS_UPSTREAM_MODEL',
    'CADRE_SKILLS_UPSTREAM_INTERVAL_SECONDS',
    'CADRE_SKILLS_UPSTREAM_WORKTREE_BASE',
    'CADRE_SKILLS_UPSTREAM_MAX_FANOUT',
    'CADRE_REPO_QUALITY_REPO_PATHS_JSON',
    'CADRE_REPO_QUALITY_PROVIDER',
    'CADRE_REPO_QUALITY_MODEL',
    'CADRE_REPO_QUALITY_INTERVAL_SECONDS',
    'CADRE_REPO_QUALITY_MAX_FANOUT',
    'CADRE_REPO_QUALITY_TOP_N',
    'CADRE_REPO_QUALITY_WORKTREE_BASE',
    'CADRE_JOB_OPPORTUNITIES_PROVIDER',
    'CADRE_JOB_OPPORTUNITIES_MODEL',
    'CADRE_JOB_OPPORTUNITIES_SCRAPER_PATH',
    'CADRE_FLEET_DEPLOYMENT_NOTIFY_BUSINESSOS_REPO_PATH',
    'CADRE_MCP_SEODATA_PATH',
    'CADRE_MCP_GOOGLE_LOCAL_URL',
    'CADRE_MCP_SLACK_LOCAL_URL',
    'RESEARCH_WORKBENCH_DEFAULT_WORKDIR',
    'RESEARCH_WORKBENCH_ALLOWED_WORKDIRS',
    'RESEARCH_WORKBENCH_PLUGIN_DIR',
    'RESEARCH_WORKBENCH_ZOTERO_MCP_PATH',
    'RESEARCH_WORKBENCH_NODUS_MCP_PATH',
    'RESEARCH_WORKBENCH_PAPER_SEARCH_PATH',
    'RESEARCH_WORKBENCH_NODUS_TOKEN_FILE',
    'CADRE_PROMPT_PROFILES_FILE',
    'CADRE_PROMPT_PROFILES_JSON',
    'CADRE_TELEGRAM_RELAY_ENABLED',
    'CADRE_TELEGRAM_RELAY_TICK_SECS',
    'CADRE_TELEGRAM_RELAY_CAPTURE_LINES',
  ];
  for (const key of keys) {
    if (Object.hasOwn(overrides, key)) {
      const value = overrides[key];
      if (value === undefined) delete env[key];
      else env[key] = String(value);
    } else {
      delete env[key];
    }
  }

  const script = `
    const mod = await import(${JSON.stringify(configModulePath)});
    process.stdout.write(JSON.stringify(mod.config));
  `;
  const cwd = await mkdtemp(resolve(tmpdir(), 'dueno-monitor-config-test-'));
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { env, cwd }
    );
    return { config: JSON.parse(stdout), stderr };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe('optional private integration defaults', () => {
  it('leaves private integrations unconfigured in an empty environment', async () => {
    const { config } = await importConfigWithEnv({});
    assert.equal(config.researchWorkbench.defaultWorkDir, '');
    assert.equal(config.researchWorkbench.pluginDir, '');
    assert.equal(config.researchWorkbench.zoteroMcpPath, '');
    assert.equal(config.mcpCredentials.seodataPath, '');
    assert.equal(config.mcpCredentials.googleLocalUrl, '');
    assert.equal(config.mcpCredentials.slackLocalUrl, '');
    assert.equal(config.fleet.deploymentNotifyBusinessOsRepoPath, '');
    assert.equal(config.jobOpportunities.scraperPath, '');
  });

  it('uses explicit private integration paths unchanged', async () => {
    const paths = {
      RESEARCH_WORKBENCH_DEFAULT_WORKDIR: '/private/research',
      RESEARCH_WORKBENCH_ALLOWED_WORKDIRS: '/private/research',
      RESEARCH_WORKBENCH_PLUGIN_DIR: '/private/plugin',
      RESEARCH_WORKBENCH_ZOTERO_MCP_PATH: '/private/zotero.js',
      RESEARCH_WORKBENCH_NODUS_MCP_PATH: '/private/nodus.js',
      RESEARCH_WORKBENCH_PAPER_SEARCH_PATH: '/private/paper-search',
      RESEARCH_WORKBENCH_NODUS_TOKEN_FILE: '/private/nodus-token.json',
      CADRE_MCP_SEODATA_PATH: '/private/seodata.js',
      CADRE_MCP_GOOGLE_LOCAL_URL: 'http://127.0.0.1:8000/mcp',
      CADRE_MCP_SLACK_LOCAL_URL: 'http://127.0.0.1:13080/mcp',
      CADRE_FLEET_DEPLOYMENT_NOTIFY_BUSINESSOS_REPO_PATH: '/private/businessos',
      CADRE_JOB_OPPORTUNITIES_SCRAPER_PATH: '/private/scraper',
    };
    const { config } = await importConfigWithEnv(paths);
    assert.equal(config.researchWorkbench.defaultWorkDir, paths.RESEARCH_WORKBENCH_DEFAULT_WORKDIR);
    assert.equal(config.researchWorkbench.allowedWorkDirs, paths.RESEARCH_WORKBENCH_ALLOWED_WORKDIRS);
    assert.equal(config.researchWorkbench.pluginDir, paths.RESEARCH_WORKBENCH_PLUGIN_DIR);
    assert.equal(config.researchWorkbench.zoteroMcpPath, paths.RESEARCH_WORKBENCH_ZOTERO_MCP_PATH);
    assert.equal(config.researchWorkbench.nodusMcpPath, paths.RESEARCH_WORKBENCH_NODUS_MCP_PATH);
    assert.equal(config.researchWorkbench.paperSearchPath, paths.RESEARCH_WORKBENCH_PAPER_SEARCH_PATH);
    assert.equal(config.researchWorkbench.nodusTokenFile, paths.RESEARCH_WORKBENCH_NODUS_TOKEN_FILE);
    assert.equal(config.mcpCredentials.seodataPath, paths.CADRE_MCP_SEODATA_PATH);
    assert.equal(config.mcpCredentials.googleLocalUrl, paths.CADRE_MCP_GOOGLE_LOCAL_URL);
    assert.equal(config.mcpCredentials.slackLocalUrl, paths.CADRE_MCP_SLACK_LOCAL_URL);
    assert.equal(config.fleet.deploymentNotifyBusinessOsRepoPath, paths.CADRE_FLEET_DEPLOYMENT_NOTIFY_BUSINESSOS_REPO_PATH);
    assert.equal(config.jobOpportunities.scraperPath, paths.CADRE_JOB_OPPORTUNITIES_SCRAPER_PATH);
  });
});

describe('config.promptProfiles file loading', () => {
  it('loads profiles from CADRE_PROMPT_PROFILES_FILE', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'dueno-monitor-prompt-profiles-'));
    try {
      const filePath = resolve(dir, 'prompt-profiles.json');
      await writeFile(filePath, JSON.stringify({
        'command-center': { label: 'Command Center', template: 'From file.' },
      }));
      const { config } = await importConfigWithEnv({ CADRE_PROMPT_PROFILES_FILE: filePath });
      assert.deepEqual(config.promptProfiles.profiles, {
        'command-center': { label: 'Command Center', template: 'From file.' },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('warns and falls back to no file profiles when the file is missing', async () => {
    const { config, stderr } = await importConfigWithEnv({
      CADRE_PROMPT_PROFILES_FILE: resolve(tmpdir(), 'does-not-exist-prompt-profiles.json'),
    });
    assert.deepEqual(config.promptProfiles.profiles, {});
    assert.match(stderr, /DM_PROMPT_PROFILES_FILE ignored/);
  });

  it('warns and falls back to no file profiles when the file is invalid JSON', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'dueno-monitor-prompt-profiles-'));
    try {
      const filePath = resolve(dir, 'prompt-profiles.json');
      await writeFile(filePath, 'not json');
      const { config, stderr } = await importConfigWithEnv({ CADRE_PROMPT_PROFILES_FILE: filePath });
      assert.deepEqual(config.promptProfiles.profiles, {});
      assert.match(stderr, /DM_PROMPT_PROFILES_FILE ignored/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lets CADRE_PROMPT_PROFILES_JSON override a matching id from the file', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'dueno-monitor-prompt-profiles-'));
    try {
      const filePath = resolve(dir, 'prompt-profiles.json');
      await writeFile(filePath, JSON.stringify({
        'command-center': { label: 'From file', template: 'File body.' },
        research: { label: 'File only', template: 'Stays.' },
      }));
      const { config } = await importConfigWithEnv({
        CADRE_PROMPT_PROFILES_FILE: filePath,
        CADRE_PROMPT_PROFILES_JSON: JSON.stringify({
          'command-center': { label: 'From env', template: 'Env body.' },
        }),
      });
      assert.deepEqual(config.promptProfiles.profiles, {
        'command-center': { label: 'From env', template: 'Env body.' },
        research: { label: 'File only', template: 'Stays.' },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('config.agentBusMcpHttp', () => {
  it('inherits the main HOST when AGENT_BUS_MCP_HTTP_HOST is unset', async () => {
    const { config } = await importConfigWithEnv({
      HOST: '100.64.0.10',
      AGENT_BUS_MCP_HTTP_HOST: undefined,
    });

    assert.equal(config.host, '100.64.0.10');
    assert.equal(config.agentBusMcpHttp.host, '100.64.0.10');
  });

  it('keeps an explicit AGENT_BUS_MCP_HTTP_HOST override', async () => {
    const { config } = await importConfigWithEnv({
      HOST: '100.64.0.10',
      AGENT_BUS_MCP_HTTP_HOST: '127.0.0.1',
    });

    assert.equal(config.agentBusMcpHttp.host, '127.0.0.1');
  });
});

describe('config.tlsEnabled', () => {
  it('defaults to false when unset', async () => {
    const { config } = await importConfigWithEnv({
      TLS_ENABLED: undefined,
    });

    assert.equal(config.tlsEnabled, false);
  });

  it('disables TLS when TLS_ENABLED=0', async () => {
    const { config } = await importConfigWithEnv({
      TLS_ENABLED: '0',
    });

    assert.equal(config.tlsEnabled, false);
  });
});

describe('config.productionControls', () => {
  it('enables Agent Bus delivery replay by default', async () => {
    const { config } = await importConfigWithEnv({
      PC_FLAG_AGENT_BUS_DELIVERY_REPLAY_ENABLED: undefined,
    });

    assert.equal(config.productionControls.agentBusDeliveryReplayEnabled, true);
  });

  it('allows Agent Bus delivery replay to be disabled', async () => {
    const { config } = await importConfigWithEnv({
      PC_FLAG_AGENT_BUS_DELIVERY_REPLAY_ENABLED: '0',
    });

    assert.equal(config.productionControls.agentBusDeliveryReplayEnabled, false);
  });
});

describe('config.agentInterface', () => {
  it('defaults and clamps session idempotency TTL', async () => {
    const defaults = await importConfigWithEnv({
      AGENT_SESSION_IDEMPOTENCY_TTL_MS: undefined,
    });
    assert.equal(defaults.config.agentInterface.sessionIdempotencyTtlMs, 3600000);

    const clamped = await importConfigWithEnv({
      AGENT_SESSION_IDEMPOTENCY_TTL_MS: '1',
    });
    assert.equal(clamped.config.agentInterface.sessionIdempotencyTtlMs, 1000);
  });
});

describe('config.fleet.repoPaths', () => {
  it('defaults fleet investigation worktree reap off', async () => {
    const { config } = await importConfigWithEnv({
      CADRE_COMMAND_CENTER_FLEET_INVESTIGATION_WORKTREE_REAP_ENABLED: undefined,
      CADRE_COMMAND_CENTER_FLEET_INVESTIGATION_WORKTREE_REAP_MIN_AGE_SECS: undefined,
      CADRE_COMMAND_CENTER_FLEET_INVESTIGATION_WORKTREE_REAP_MAX_PER_PASS: undefined,
    });

    assert.equal(config.fleet.investigationWorktreeReapEnabled, false);
    assert.equal(config.fleet.investigationWorktreeReapMinAgeSec, 300);
    assert.equal(config.fleet.investigationWorktreeReapMaxPerPass, 20);
  });

  it('parses deployment repo path JSON from env', async () => {
    const { config } = await importConfigWithEnv({
      CADRE_FLEET_REPO_PATHS_JSON: JSON.stringify({
        'example-host': { primary: '/repo/businessos' },
      }),
    });

    assert.deepEqual(config.fleet.repoPaths, {
      'example-host': { primary: '/repo/businessos' },
    });
  });

  it('falls back to empty repo paths for bad JSON', async () => {
    const { config } = await importConfigWithEnv({
      CADRE_FLEET_REPO_PATHS_JSON: '{bad-json',
    });

    assert.deepEqual(config.fleet.repoPaths, {});
  });
});

describe('config.githubAgents', () => {
  it('defaults GitHub agent polling off with auto-review on', async () => {
    const { config } = await importConfigWithEnv({
      CADRE_GITHUB_AGENT_POLLER_ENABLED: undefined,
      CADRE_GITHUB_AGENT_POLL_INTERVAL_SECS: undefined,
      CADRE_GITHUB_AGENT_AUTO_REVIEW_ENABLED: undefined,
      CADRE_GITHUB_AGENT_WORKTREE_REAP_ENABLED: undefined,
      CADRE_GITHUB_AGENT_WORKTREE_REAP_MIN_AGE_SECS: undefined,
      CADRE_GITHUB_AGENT_REPO_PATHS_JSON: undefined,
      CADRE_GITHUB_AGENT_MODEL: undefined,
      CADRE_GITHUB_AGENT_THINKING_LEVEL: undefined,
      CADRE_GITHUB_AGENT_MAX_SPAWNS_PER_POLL: undefined,
      CADRE_GITHUB_AGENT_WORKTREE_REAP_MAX_PER_PASS: undefined,
    });

    assert.equal(config.githubAgents.enabled, false);
    assert.equal(config.githubAgents.pollIntervalSec, 60);
    assert.equal(config.githubAgents.autoReviewEnabled, true);
    assert.equal(config.githubAgents.worktreeReapEnabled, false);
    assert.equal(config.githubAgents.worktreeReapMinAgeSec, 300);
    assert.deepEqual(config.githubAgents.repoPaths, {});
    assert.equal(config.githubAgents.workDir, '~/.dueno-fleet/github-agents');
    assert.equal(config.githubAgents.provider, 'xai');
    assert.equal(config.githubAgents.model, 'grok-4.6');
    assert.equal(config.githubAgents.thinkingLevel, 'low');
    assert.equal(config.githubAgents.maxSpawnsPerPoll, 5);
    assert.equal(config.githubAgents.worktreeReapMaxPerPass, 20);
  });

  it('parses and clamps GitHub agent polling flags from env', async () => {
    const { config } = await importConfigWithEnv({
      CADRE_GITHUB_AGENT_POLLER_ENABLED: '1',
      CADRE_GITHUB_AGENT_POLL_INTERVAL_SECS: '5',
      CADRE_GITHUB_AGENT_AUTO_REVIEW_ENABLED: '0',
      CADRE_GITHUB_AGENT_WORKTREE_REAP_ENABLED: '1',
      CADRE_GITHUB_AGENT_WORKTREE_REAP_MIN_AGE_SECS: '60',
      CADRE_GITHUB_AGENT_REPO_PATHS_JSON: JSON.stringify({ 'octo/demo': '/repo/demo' }),
      CADRE_GITHUB_AGENT_WORKDIR: '/tmp/github-agents',
      CADRE_GITHUB_AGENT_PROVIDER: 'claude',
      CADRE_GITHUB_AGENT_MODEL: 'claude-sonnet-4-6',
      CADRE_GITHUB_AGENT_THINKING_LEVEL: 'high',
      CADRE_GITHUB_AGENT_MAX_SPAWNS_PER_POLL: '99',
      CADRE_GITHUB_AGENT_WORKTREE_REAP_MAX_PER_PASS: '0',
    });

    assert.equal(config.githubAgents.enabled, true);
    assert.equal(config.githubAgents.pollIntervalSec, 15);
    assert.equal(config.githubAgents.autoReviewEnabled, false);
    assert.equal(config.githubAgents.worktreeReapEnabled, true);
    assert.equal(config.githubAgents.worktreeReapMinAgeSec, 60);
    assert.deepEqual(config.githubAgents.repoPaths, { 'octo/demo': '/repo/demo' });
    assert.equal(config.githubAgents.workDir, '/tmp/github-agents');
    assert.equal(config.githubAgents.provider, 'claude');
    assert.equal(config.githubAgents.model, 'claude-sonnet-4-6');
    assert.equal(config.githubAgents.thinkingLevel, 'high');
    assert.equal(config.githubAgents.maxSpawnsPerPoll, 25);
    assert.equal(config.githubAgents.worktreeReapMaxPerPass, 1);
  });

  it('derives the model default from the resolved provider when MODEL is unset', async () => {
    const { config } = await importConfigWithEnv({
      CADRE_GITHUB_AGENT_PROVIDER: 'codex',
      CADRE_GITHUB_AGENT_MODEL: undefined,
    });

    assert.equal(config.githubAgents.provider, 'codex');
    assert.equal(config.githubAgents.model, 'gpt-6.1-sol');
  });

  it('falls back to the provider default when the explicit pair is incompatible', async () => {
    const { config, stderr } = await importConfigWithEnv({
      CADRE_GITHUB_AGENT_PROVIDER: 'codex',
      CADRE_GITHUB_AGENT_MODEL: 'grok-4.6',
    });

    assert.equal(config.githubAgents.provider, 'codex');
    assert.equal(config.githubAgents.model, 'gpt-6.1-sol');
    assert.match(stderr, /githubAgents: incompatible provider\/model pair codex\/grok-4\.6/);
  });

  it('falls back when the model is not on the provider allow-list', async () => {
    const { config, stderr } = await importConfigWithEnv({
      CADRE_GITHUB_AGENT_PROVIDER: 'codex',
      CADRE_GITHUB_AGENT_MODEL: 'gpt-test',
    });

    assert.equal(config.githubAgents.provider, 'codex');
    assert.equal(config.githubAgents.model, 'gpt-6.1-sol');
    assert.match(stderr, /githubAgents: incompatible provider\/model pair codex\/gpt-test/);
  });
});

describe('config.fleetHygiene', () => {
  it('parses dedicated hygiene repo paths and model settings', async () => {
    const { config } = await importConfigWithEnv({
      CADRE_FLEET_HYGIENE_REPO_PATHS_JSON: JSON.stringify({
        BusinessOS: '/repo/businessos',
        SamsQuest: '/repo/samsquest',
      }),
      CADRE_FLEET_HYGIENE_PROVIDER: 'codex',
      CADRE_FLEET_HYGIENE_MODEL: 'gpt-5.5',
    });

    assert.deepEqual(config.fleetHygiene.repoPaths, {
      BusinessOS: '/repo/businessos',
      SamsQuest: '/repo/samsquest',
    });
    assert.equal(config.fleetHygiene.provider, 'codex');
    assert.equal(config.fleetHygiene.model, 'gpt-5.5');
  });

  it('fills the provider default when only the hygiene provider is pinned', async () => {
    const { config } = await importConfigWithEnv({
      CADRE_FLEET_HYGIENE_PROVIDER: 'codex',
      CADRE_FLEET_HYGIENE_MODEL: undefined,
    });

    assert.equal(config.fleetHygiene.provider, 'codex');
    assert.equal(config.fleetHygiene.model, 'gpt-6.1-sol');
  });

  it('falls back when hygiene provider/model are an incompatible pair', async () => {
    const { config, stderr } = await importConfigWithEnv({
      CADRE_FLEET_HYGIENE_PROVIDER: 'codex',
      CADRE_FLEET_HYGIENE_MODEL: 'grok-4.6',
    });

    assert.equal(config.fleetHygiene.provider, 'codex');
    assert.equal(config.fleetHygiene.model, 'gpt-6.1-sol');
    assert.match(stderr, /fleetHygiene: incompatible provider\/model pair codex\/grok-4\.6/);
  });

  it('leaves a model-only hygiene pin incomplete so inheritance can supply the provider', async () => {
    const { config, stderr } = await importConfigWithEnv({
      CADRE_FLEET_HYGIENE_PROVIDER: undefined,
      CADRE_FLEET_HYGIENE_MODEL: 'grok-4.6',
    });

    assert.equal(config.fleetHygiene.provider, '');
    assert.equal(config.fleetHygiene.model, 'grok-4.6');
    assert.equal(stderr.includes('incompatible provider/model pair'), false);
  });
});

describe('config.dependencyWatch', () => {
  it('parses dedicated dependency watch repo paths and model settings', async () => {
    const { config } = await importConfigWithEnv({
      CADRE_DEPENDENCY_WATCH_REPO_PATHS_JSON: JSON.stringify({
        BusinessOS: '/repo/businessos',
        ExampleApp: '/repo/exampleapp',
      }),
      CADRE_DEPENDENCY_WATCH_PROVIDER: 'codex',
      CADRE_DEPENDENCY_WATCH_MODEL: 'gpt-5.5',
      CADRE_DEPENDENCY_WATCH_INTERVAL_SECONDS: '99',
    });

    assert.deepEqual(config.dependencyWatch.repoPaths, {
      BusinessOS: '/repo/businessos',
      ExampleApp: '/repo/exampleapp',
    });
    assert.equal(config.dependencyWatch.provider, 'codex');
    assert.equal(config.dependencyWatch.model, 'gpt-5.5');
    assert.equal(config.dependencyWatch.intervalSeconds, 86400);
  });

  it('falls back when dependency watch provider/model are an incompatible pair', async () => {
    const { config, stderr } = await importConfigWithEnv({
      CADRE_DEPENDENCY_WATCH_PROVIDER: 'xai',
      CADRE_DEPENDENCY_WATCH_MODEL: 'gpt-5.6-sol',
    });

    assert.equal(config.dependencyWatch.provider, 'xai');
    assert.equal(config.dependencyWatch.model, 'grok-4.6');
    assert.match(stderr, /dependencyWatch: incompatible provider\/model pair xai\/gpt-5\.6-sol/);
  });
});

describe('config.skillsUpstream', () => {
  it('defaults to empty repo path, weekly interval, grok-inheritable blanks, and a fan-out cap', async () => {
    const { config } = await importConfigWithEnv({
      CADRE_SKILLS_UPSTREAM_REPO_PATH: undefined,
      CADRE_SKILLS_UPSTREAM_PROVIDER: undefined,
      CADRE_SKILLS_UPSTREAM_MODEL: undefined,
      CADRE_SKILLS_UPSTREAM_INTERVAL_SECONDS: undefined,
      CADRE_SKILLS_UPSTREAM_WORKTREE_BASE: undefined,
      CADRE_SKILLS_UPSTREAM_MAX_FANOUT: undefined,
    });

    assert.equal(config.skillsUpstream.repoPath, '');
    assert.equal(config.skillsUpstream.provider, '');
    assert.equal(config.skillsUpstream.model, '');
    assert.equal(config.skillsUpstream.intervalSeconds, 604800);
    assert.equal(config.skillsUpstream.worktreeBaseDir, '~/.dueno-fleet/agent-worktrees');
    assert.equal(config.skillsUpstream.maxFanout, 3);
  });

  it('parses and clamps skills upstream env overrides', async () => {
    const { config } = await importConfigWithEnv({
      CADRE_SKILLS_UPSTREAM_REPO_PATH: '/repo/fleet',
      CADRE_SKILLS_UPSTREAM_PROVIDER: 'xai',
      CADRE_SKILLS_UPSTREAM_MODEL: 'grok-4.6',
      CADRE_SKILLS_UPSTREAM_INTERVAL_SECONDS: '99',
      CADRE_SKILLS_UPSTREAM_WORKTREE_BASE: '/tmp/skill-wt',
      CADRE_SKILLS_UPSTREAM_MAX_FANOUT: '99',
    });

    assert.equal(config.skillsUpstream.repoPath, '/repo/fleet');
    assert.equal(config.skillsUpstream.provider, 'xai');
    assert.equal(config.skillsUpstream.model, 'grok-4.6');
    assert.equal(config.skillsUpstream.intervalSeconds, 86400);
    assert.equal(config.skillsUpstream.worktreeBaseDir, '/tmp/skill-wt');
    assert.equal(config.skillsUpstream.maxFanout, 10);
  });
});

describe('config.repoQuality', () => {
  it('defaults to empty paths, weekly interval, fan-out 2, top 10, and a codex pair', async () => {
    const { config } = await importConfigWithEnv({
      CADRE_REPO_QUALITY_REPO_PATHS_JSON: undefined,
      CADRE_REPO_QUALITY_PROVIDER: undefined,
      CADRE_REPO_QUALITY_MODEL: undefined,
      CADRE_REPO_QUALITY_INTERVAL_SECONDS: undefined,
      CADRE_REPO_QUALITY_MAX_FANOUT: undefined,
      CADRE_REPO_QUALITY_TOP_N: undefined,
      CADRE_REPO_QUALITY_WORKTREE_BASE: undefined,
    });

    assert.deepEqual(config.repoQuality.repoPaths, {});
    assert.equal(config.repoQuality.provider, 'codex');
    assert.equal(config.repoQuality.model, 'gpt-6.1-sol');
    assert.equal(config.repoQuality.intervalSeconds, 604800);
    assert.equal(config.repoQuality.maxFanout, 2);
    assert.equal(config.repoQuality.topN, 10);
    assert.equal(config.repoQuality.worktreeBaseDir, '~/.dueno-fleet/agent-worktrees');
  });

  it('parses and clamps repo quality env overrides', async () => {
    const { config } = await importConfigWithEnv({
      CADRE_REPO_QUALITY_REPO_PATHS_JSON: JSON.stringify({
        fleet: '/repo/fleet',
        BusinessOS: {
          path: '/repo/businessos',
          sections: ['default', 'rust'],
        },
      }),
      CADRE_REPO_QUALITY_PROVIDER: 'codex',
      CADRE_REPO_QUALITY_MODEL: 'gpt-5.5',
      CADRE_REPO_QUALITY_INTERVAL_SECONDS: '99',
      CADRE_REPO_QUALITY_MAX_FANOUT: '99',
      CADRE_REPO_QUALITY_TOP_N: '0',
      CADRE_REPO_QUALITY_WORKTREE_BASE: '/tmp/quality-wt',
    });

    assert.deepEqual(config.repoQuality.repoPaths, {
      fleet: '/repo/fleet',
      BusinessOS: {
        path: '/repo/businessos',
        sections: ['default', 'rust'],
      },
    });
    assert.equal(config.repoQuality.provider, 'codex');
    assert.equal(config.repoQuality.model, 'gpt-5.5');
    assert.equal(config.repoQuality.intervalSeconds, 86400);
    assert.equal(config.repoQuality.maxFanout, 10);
    assert.equal(config.repoQuality.topN, 1);
    assert.equal(config.repoQuality.worktreeBaseDir, '/tmp/quality-wt');
  });

  it('falls back when repo quality provider/model are an incompatible pair', async () => {
    const { config, stderr } = await importConfigWithEnv({
      CADRE_REPO_QUALITY_PROVIDER: 'codex',
      CADRE_REPO_QUALITY_MODEL: 'grok-4.6',
    });

    assert.equal(config.repoQuality.provider, 'codex');
    assert.equal(config.repoQuality.model, 'gpt-6.1-sol');
    assert.match(stderr, /repoQuality: incompatible provider\/model pair codex\/grok-4\.6/);
  });
});

describe('config.telegramRelay', () => {
  it('defaults disabled with a 5s tick and 120 capture lines', async () => {
    const { config } = await importConfigWithEnv({
      CADRE_TELEGRAM_RELAY_ENABLED: undefined,
      CADRE_TELEGRAM_RELAY_TICK_SECS: undefined,
      CADRE_TELEGRAM_RELAY_CAPTURE_LINES: undefined,
    });

    assert.equal(config.telegramRelay.enabled, false);
    assert.equal(config.telegramRelay.tickIntervalSec, 5);
    assert.equal(config.telegramRelay.captureLines, 120);
  });

  it('parses and clamps Telegram relay env overrides', async () => {
    const { config } = await importConfigWithEnv({
      CADRE_TELEGRAM_RELAY_ENABLED: '1',
      CADRE_TELEGRAM_RELAY_TICK_SECS: '0',
      CADRE_TELEGRAM_RELAY_CAPTURE_LINES: '9999',
    });

    assert.equal(config.telegramRelay.enabled, true);
    assert.equal(config.telegramRelay.tickIntervalSec, 1);
    assert.equal(config.telegramRelay.captureLines, 500);
  });
});

describe('config.auth secrets', () => {
  it('does not default bypass or session secrets to AUTH_TOKEN', async () => {
    const { config } = await importConfigWithEnv({
      AUTH_TOKEN: 'shared-token',
      INTERNAL_BYPASS_TOKEN: undefined,
      BROWSER_SESSION_SECRET: undefined,
    });
    assert.equal(config.auth.token, 'shared-token');
    assert.equal(config.auth.internalBypassToken, '');
    assert.equal(config.auth.browserSessionSecret, '');
  });

  it('fails closed unless the three auth secrets are set and distinct', async () => {
    const script = `
      const { assertDistinctAuthSecrets } = await import(${JSON.stringify(configModulePath)});
      try {
        assertDistinctAuthSecrets();
        process.stdout.write('ok');
      } catch (error) {
        process.stdout.write(String(error.code || '') + ':' + error.message);
        process.exit(2);
      }
    `;
    async function run(overrides) {
      const env = { ...process.env };
      for (const key of ['AUTH_TOKEN', 'INTERNAL_BYPASS_TOKEN', 'BROWSER_SESSION_SECRET']) {
        if (Object.hasOwn(overrides, key)) env[key] = String(overrides[key]);
        else delete env[key];
      }
      const cwd = await mkdtemp(resolve(tmpdir(), 'dueno-monitor-auth-secret-'));
      try {
        return await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { env, cwd });
      } catch (error) {
        return error;
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }

    const ok = await run({
      AUTH_TOKEN: 'token-a',
      INTERNAL_BYPASS_TOKEN: 'token-b',
      BROWSER_SESSION_SECRET: 'token-c',
    });
    assert.equal(ok.stdout, 'ok');

    const empty = await run({});
    assert.equal(empty.stdout, 'ok');

    const missing = await run({ AUTH_TOKEN: 'token-a' });
    assert.match(String(missing.stdout), /auth_secrets_not_distinct/);
    assert.match(String(missing.stdout), /INTERNAL_BYPASS_TOKEN is required/);

    const shared = await run({
      AUTH_TOKEN: 'same',
      INTERNAL_BYPASS_TOKEN: 'same',
      BROWSER_SESSION_SECRET: 'other',
    });
    assert.match(String(shared.stdout), /must differ from AUTH_TOKEN/);
  });
});
