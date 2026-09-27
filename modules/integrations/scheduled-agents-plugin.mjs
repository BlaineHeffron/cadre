import { config as appConfig } from '../../config.mjs';
import { resolveCompatibleProviderModelPair } from '../agent/provider-interface.mjs';
import {
  buildScheduledAgentStore,
  resolveIdleSessionGraceMs,
  resolveMaxConsecutiveSkips,
  SchedulerLoop,
  stepDue,
} from './scheduled-agents.mjs';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { exec } from '../../lib/exec.mjs';
import {
  createAgentSessionWorktree,
  removeAgentSessionWorktree,
  safeWorktreeName,
} from '../fleet/git-worktree.mjs';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import {
  buildSkillsUpstreamIntegrationPrompt,
  buildSkillsUpstreamTaskPrompt,
  DEFAULT_SKILLS_UPSTREAM_INTERVAL_SECONDS,
  DEFAULT_SKILLS_UPSTREAM_MAX_FANOUT,
  DEFAULT_SKILLS_UPSTREAM_WORKTREE_BASE,
  expandUserPath,
  groupChangedByUpstreamPath,
  isLiveFleetCheckout,
  parseUpstreamManifestRepos,
  SKILLS_UPSTREAM_MANIFEST_REL,
  SKILLS_UPSTREAM_TASK_ID,
} from './skills-upstream.mjs';
import {
  buildRepoQualityFixPrompt,
  buildRepoQualityTaskPrompt,
  computeQualityReportDelta,
  normalizeRepoQualityCheckResult,
  normalizeRepoQualitySection,
  parseRepoQualityCheckOutput,
  readPreviousRepoQualityReport,
  writeRepoQualityReportRecord,
  DEFAULT_REPO_QUALITY_INTERVAL_SECONDS,
  DEFAULT_REPO_QUALITY_MAX_FANOUT,
  DEFAULT_REPO_QUALITY_TOP_N,
  REPO_QUALITY_TASK_ID,
  rankRepoQualityFixCandidates,
  repoQualityReportSlug,
  shouldDispatchRepoQualityFix,
} from './repo-quality.mjs';
import { buildDelegatedScheduledAgentInput } from '../agent-bus/coordinator-policy.mjs';

const execFileAsync = promisify(execFile);

const FLEET_HYGIENE_TASK_ID = 'sched_fleet_hygiene_biweekly';
const LEGACY_FLEET_HYGIENE_TASK_ID = 'sched_fleet_hygiene_daily';
const FLEET_HYGIENE_INTERVAL_SECONDS = 1209600;
const DEPENDENCY_WATCH_TASK_ID = 'sched_dependency_watch_15day';
const LEGACY_DEPENDENCY_WATCH_TASK_ID = 'sched_dependency_watch_daily';
const DEFAULT_DEPENDENCY_WATCH_INTERVAL_SECONDS = 1296000;
const JOB_OPPORTUNITIES_TASK_ID = 'sched_job_opportunities_daily';
const DEFAULT_JOB_OPPORTUNITIES_INTERVAL_SECONDS = 86400;

function normalizeText(value) {
  return String(value || '').trim();
}

function resolveWatcherProviderModel(own = {}, fallbacks = [], label = 'scheduledAgents') {
  const ownProvider = normalizeText(own?.provider);
  const ownModel = normalizeText(own?.model);

  if (ownProvider) {
    return resolveCompatibleProviderModelPair({
      provider: ownProvider,
      model: ownModel,
      fallbackProvider: 'codex',
      label,
    });
  }

  if (ownModel) {
    const inheritedProvider = fallbacks.map((block) => normalizeText(block?.provider)).find(Boolean) || '';
    return resolveCompatibleProviderModelPair({
      provider: inheritedProvider,
      model: ownModel,
      fallbackProvider: 'codex',
      label,
    });
  }

  if (fallbacks.length === 0) {
    return resolveCompatibleProviderModelPair({
      provider: '',
      model: '',
      fallbackProvider: 'codex',
      label,
    });
  }

  return resolveWatcherProviderModel(fallbacks[0], fallbacks.slice(1), label);
}

function unique(values = []) {
  return [...new Set(values.map(normalizeText).filter(Boolean))];
}

function repoPathsFromValue(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(repoPathsFromValue);
  if (typeof value === 'object') {
    return [
      value.primary,
      ...(Array.isArray(value.companions) ? value.companions : []),
    ].flatMap(repoPathsFromValue);
  }
  return [];
}

function configuredRepoPaths(config = appConfig) {
  const hygieneRepoPaths = unique(Object.values(config?.fleetHygiene?.repoPaths || {}).flatMap(repoPathsFromValue));
  if (hygieneRepoPaths.length > 0) return hygieneRepoPaths;
  return unique([
    ...Object.values(config?.fleet?.repoPaths || {}).flatMap(repoPathsFromValue),
    ...Object.values(config?.githubAgents?.repoPaths || {}).flatMap(repoPathsFromValue),
  ]);
}

function configuredDependencyWatchRepoPaths(config = appConfig) {
  const dependencyRepoPaths = unique(Object.values(config?.dependencyWatch?.repoPaths || {}).flatMap(repoPathsFromValue));
  return dependencyRepoPaths.length > 0 ? dependencyRepoPaths : configuredRepoPaths(config);
}

function buildFleetHygienePrompt(repoPaths = []) {
  const repos = unique(repoPaths);
  const repoList = repos.length > 0
    ? repos.map((repo) => `- ${repo}`).join('\n')
    : '- current working repository';
  return [
    'Biweekly fleet hygiene audit.',
    '',
    'Scan these active repositories:',
    repoList,
    '',
    'For each repository, inspect the codebase and report architectural conformity issues, code hygiene problems, and drift from established local norms.',
    'Before reporting a finding, fetch and check origin/main for that repository. If the issue is already fixed on origin/main, omit it or explicitly mark it as local-checkout drift instead of an active mainline problem.',
    'Distinguish dirty worktree or stale-branch findings from issues that still exist on origin/main.',
    'Prioritize concrete, fixable issues. Include file paths and short rationale.',
    'For small findings, fix them yourself, commit, and push to main/master as relevant. For larger findings or items requiring product judgment, open issues instead of making changes.',
    'Return a morning-ready report grouped by severity: critical, high, medium, low.',
  ].join('\n');
}

function buildDependencyWatchPrompt(repoPaths = []) {
  const repos = unique(repoPaths);
  const repoList = repos.length > 0
    ? repos.map((repo) => `- ${repo}`).join('\n')
    : '- current working repository';
  return [
    '15-day dependency and API watch.',
    '',
    'Scan these active repositories:',
    repoList,
    '',
    'Inspect package manifests, lockfiles, SDK clients, API integrations, external service references, and framework/runtime versions.',
    'Check current upstream release notes, patch notes, security advisories, deprecations, migration guides, and API changelogs for dependencies and services that matter to these repos.',
    'Report updates that likely require code changes, configuration changes, migrations, test updates, or operational follow-up.',
    'Do not modify files. Return a morning-ready report grouped by urgency with package/API name, current version or integration, relevant upstream change, repo impact, and suggested modification.',
  ].join('\n');
}

function buildJobOpportunitiesPrompt(sourceConfig = appConfig) {
  const settings = configuredJobOpportunitySettings(sourceConfig);
  return [
    'Daily interesting job opportunities check.',
    '',
    'Goal:',
    'Find opportunities that fit the interests and qualifications in the configured profile.',
    '',
    'Profile seed:',
    `- Read and use ${settings.profilePath}`,
    '- Treat that file as the source of truth for background, strengths, publications, technical skills, and personal-interest weighting.',
    '',
    'Scraper:',
    `- StartupScraper repo: ${settings.scraperPath}`,
    `- StartupScraper config: ${settings.scraperConfigPath}`,
    `- Output directory: ${settings.outputDir}`,
    `- Before running, create a temporary copy of the StartupScraper config and set output.markdown_dir to ${settings.outputDir}/startup-scraper-output. Run the scraper with that temporary config so dedupe/output stays under the fleet output directory for this checkout.`,
    '- If dependencies or build artifacts are missing, run the minimal install/build needed inside the scraper repo.',
    '- Run StartupScraper with markdown output. Prefer: npm install when needed, npm run build when needed, docker compose up -d, node dist/index.js --config <runtime-config> --markdown, then docker compose down.',
    '- Do not use npm run scrape with extra --config args; that package script does not forward CLI args to the scraper correctly.',
    '- If Docker/SearXNG is unavailable, report the blocker clearly and still do a web search pass using the same intent and search terms.',
    '',
    'Ranking:',
    '- De-duplicate against prior digests in the output directory when possible.',
    '- Rank roles using the strengths, interests, and constraints in the configured profile.',
    '',
    'Return a morning-ready report with top ranked roles, why each fits the profile, risk/gap notes, source links, and suggested search/config tweaks for the next run. Do not apply to jobs or contact anyone.',
  ].join('\n');
}

function repoQualityTargetsFromEntry(repoName, value) {
  if (typeof value === 'string') {
    const repoPath = normalizeText(value);
    return repoPath ? [{ repoName, repoPath, section: 'default' }] : [];
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  if (!normalizeText(value.path)) {
    return unique(repoPathsFromValue(value)).map((repoPath, index) => ({
      repoName: index === 0 ? repoName : `${repoName}-${safeWorktreeName(repoPath)}`,
      repoPath,
      section: 'default',
    }));
  }
  const repoPath = normalizeText(value.path);
  if (!repoPath) return [];
  const configuredSections = Array.isArray(value.sections)
    ? unique(value.sections.map((section) => normalizeRepoQualitySection(section)))
    : [];
  const sections = configuredSections.length > 0 ? configuredSections : ['default'];
  return sections.map((section) => ({ repoName, repoPath, section }));
}

function configuredRepoQualityTargets(config = appConfig) {
  const value = config?.repoQuality?.repoPaths;
  const targets = Array.isArray(value) || typeof value === 'string'
    ? unique(repoPathsFromValue(value)).map((repoPath) => ({
      repoName: safeWorktreeName(repoPath),
      repoPath,
      section: 'default',
    }))
    : Object.entries(value || {}).flatMap(([repoName, entry]) => (
      repoQualityTargetsFromEntry(repoName, entry)
    ));
  const uniqueTargets = new Map();
  for (const target of targets) {
    const section = normalizeRepoQualitySection(target.section);
    const key = `${resolve(target.repoPath)}\0${section}`;
    if (!uniqueTargets.has(key)) uniqueTargets.set(key, { ...target, section });
  }
  return [...uniqueTargets.values()];
}

function configuredRepoQualityRepoPaths(config = appConfig) {
  return unique(configuredRepoQualityTargets(config).map((target) => target.repoPath));
}

function configuredRepoQualityMaxFanout(config = appConfig) {
  const number = Number(config?.repoQuality?.maxFanout);
  if (Number.isInteger(number) && number >= 1 && number <= 10) return number;
  return DEFAULT_REPO_QUALITY_MAX_FANOUT;
}

function configuredRepoQualityTopN(config = appConfig) {
  const number = Number(config?.repoQuality?.topN);
  if (Number.isInteger(number) && number >= 1 && number <= 50) return number;
  return DEFAULT_REPO_QUALITY_TOP_N;
}

function repoQualityRepoProblem(repoPaths = []) {
  const paths = unique(repoPaths);
  if (paths.length === 0) {
    return {
      code: 'repo_quality_repo_required',
      message: 'Set DM_REPO_QUALITY_REPO_PATHS_JSON to one or more non-live repository paths',
    };
  }
  if (paths.some((path) => isLiveFleetCheckout(path))) {
    return {
      code: 'repo_quality_live_checkout',
      message: 'Refusing the live deploy checkout; omit dueno-fleet-live from DM_REPO_QUALITY_REPO_PATHS_JSON',
    };
  }
  return null;
}

function buildRepoQualityTaskInput(sourceConfig = appConfig, { nowMs = Date.now() } = {}) {
  const repoPaths = configuredRepoQualityRepoPaths(sourceConfig);
  const intervalSeconds = normalizeIntervalSeconds(
    sourceConfig?.repoQuality?.intervalSeconds,
    DEFAULT_REPO_QUALITY_INTERVAL_SECONDS,
  );
  const pair = resolveWatcherProviderModel(
    sourceConfig?.repoQuality,
    [],
    'repoQuality',
  );
  return {
    id: REPO_QUALITY_TASK_ID,
    workDir: repoPaths[0] || process.cwd(),
    prompt: buildRepoQualityTaskPrompt(),
    provider: pair.provider,
    model: pair.model,
    intervalSeconds,
    maxIterations: 0,
    startImmediately: false,
    nextRunAtEpochMs: nowMs + intervalSeconds * 1000,
    metadata: {
      kind: 'repo_quality_watch',
      branchHeads: {},
    },
  };
}

function safeRepoQualityStatus(task, sourceConfig = appConfig) {
  const targets = configuredRepoQualityTargets(sourceConfig);
  const repoPaths = configuredRepoQualityRepoPaths(sourceConfig);
  const problem = repoQualityRepoProblem(repoPaths);
  const intervalSeconds = normalizeIntervalSeconds(
    sourceConfig?.repoQuality?.intervalSeconds,
    DEFAULT_REPO_QUALITY_INTERVAL_SECONDS,
  );
  return {
    configured: Boolean(task && task.status === 'active'),
    usable: !problem,
    repoCount: repoPaths.length,
    targetCount: targets.length,
    repoPaths,
    targets,
    error: problem ? { code: problem.code, message: problem.message } : null,
    task: task ? safeTask(task) : null,
    intervalSeconds,
    maxFanout: configuredRepoQualityMaxFanout(sourceConfig),
    topN: configuredRepoQualityTopN(sourceConfig),
  };
}

function configuredRepoQualityWorktreeBase(config = appConfig) {
  return expandUserPath(
    normalizeText(config?.repoQuality?.worktreeBaseDir)
    || normalizeText(config?.agentInterface?.worktreeBaseDir)
    || DEFAULT_SKILLS_UPSTREAM_WORKTREE_BASE,
  );
}

function configuredSkillsUpstreamRepoPath(config = appConfig) {
  const explicit = normalizeText(config?.skillsUpstream?.repoPath);
  if (explicit) return explicit;
  return configuredRepoPaths(config)[0] || '';
}

function skillsUpstreamRepoProblem(repoPath = '') {
  const path = normalizeText(repoPath);
  if (!path) {
    return {
      code: 'skills_upstream_repo_required',
      message: 'Set DM_SKILLS_UPSTREAM_REPO_PATH or a fleet/githubAgents repo path',
    };
  }
  if (isLiveFleetCheckout(path)) {
    return {
      code: 'skills_upstream_live_checkout',
      message: 'Refusing the live deploy checkout; set DM_SKILLS_UPSTREAM_REPO_PATH to a non-live clone',
    };
  }
  return null;
}

function configuredSkillsUpstreamWorktreeBase(config = appConfig) {
  return expandUserPath(
    normalizeText(config?.skillsUpstream?.worktreeBaseDir) || DEFAULT_SKILLS_UPSTREAM_WORKTREE_BASE,
  );
}

function configuredSkillsUpstreamMaxFanout(config = appConfig) {
  const number = Number(config?.skillsUpstream?.maxFanout);
  if (Number.isInteger(number) && number >= 1 && number <= 10) return number;
  return DEFAULT_SKILLS_UPSTREAM_MAX_FANOUT;
}

function buildSkillsUpstreamTaskInput(sourceConfig = appConfig, { nowMs = Date.now() } = {}) {
  const repoPath = configuredSkillsUpstreamRepoPath(sourceConfig);
  const intervalSeconds = normalizeIntervalSeconds(
    sourceConfig?.skillsUpstream?.intervalSeconds,
    DEFAULT_SKILLS_UPSTREAM_INTERVAL_SECONDS,
  );
  const pair = resolveWatcherProviderModel(
    sourceConfig?.skillsUpstream,
    [sourceConfig?.githubAgents],
    'skillsUpstream',
  );
  return {
    id: SKILLS_UPSTREAM_TASK_ID,
    workDir: repoPath,
    prompt: buildSkillsUpstreamTaskPrompt(),
    provider: pair.provider,
    model: pair.model,
    intervalSeconds,
    maxIterations: 0,
    startImmediately: false,
    nextRunAtEpochMs: nowMs + intervalSeconds * 1000,
    metadata: {
      kind: 'skills_upstream_watch',
      upstreamHeads: {},
    },
  };
}

function safeSkillsUpstreamStatus(task, sourceConfig = appConfig) {
  const repoPath = configuredSkillsUpstreamRepoPath(sourceConfig);
  const problem = skillsUpstreamRepoProblem(repoPath);
  const intervalSeconds = normalizeIntervalSeconds(
    sourceConfig?.skillsUpstream?.intervalSeconds,
    DEFAULT_SKILLS_UPSTREAM_INTERVAL_SECONDS,
  );
  return {
    configured: Boolean(task && task.status === 'active'),
    usable: !problem,
    repoPath,
    error: problem ? { code: problem.code, message: problem.message } : null,
    task: task ? safeTask(task) : null,
    intervalSeconds,
    maxFanout: configuredSkillsUpstreamMaxFanout(sourceConfig),
  };
}

function buildFleetHygieneTaskInput(sourceConfig = appConfig, { nowMs = Date.now() } = {}) {
  const repoPaths = configuredRepoPaths(sourceConfig);
  const pair = resolveWatcherProviderModel(
    sourceConfig?.fleetHygiene,
    [sourceConfig?.githubAgents],
    'fleetHygiene',
  );
  return {
    id: FLEET_HYGIENE_TASK_ID,
    workDir: repoPaths[0] || process.cwd(),
    prompt: buildFleetHygienePrompt(repoPaths),
    provider: pair.provider,
    model: pair.model,
    intervalSeconds: FLEET_HYGIENE_INTERVAL_SECONDS,
    maxIterations: 0,
    startImmediately: false,
    nextRunAtEpochMs: nowMs + FLEET_HYGIENE_INTERVAL_SECONDS * 1000,
    metadata: {
      kind: 'fleet_hygiene_audit',
      branchHeads: {},
    },
  };
}

async function setupFleetHygieneTask(store, sourceConfig, nowMs) {
  const input = buildFleetHygieneTaskInput(sourceConfig, { nowMs });
  const existing = await store.get(FLEET_HYGIENE_TASK_ID);
  const legacy = await store.get(LEGACY_FLEET_HYGIENE_TASK_ID);
  const prior = existing || legacy;
  const preserved = prior ? {
    currentIteration: prior.currentIteration,
    lastSessionId: prior.lastSessionId,
    createdAt: prior.createdAt,
    nextRunAtEpochMs: prior.nextRunAtEpochMs || input.nextRunAtEpochMs,
    metadata: {
      ...(prior.metadata || {}),
      ...input.metadata,
      branchHeads: prior.metadata?.branchHeads || input.metadata.branchHeads,
    },
  } : {};
  const task = existing
    ? await store.update(FLEET_HYGIENE_TASK_ID, { ...input, ...preserved, status: 'active' })
    : await store.register({ ...input, ...preserved, status: 'active' });
  if (legacy?.status === 'active') await store.cancel(LEGACY_FLEET_HYGIENE_TASK_ID);
  return task;
}

function buildDependencyWatchTaskInput(sourceConfig = appConfig, { nowMs = Date.now() } = {}) {
  const repoPaths = configuredDependencyWatchRepoPaths(sourceConfig);
  const intervalSeconds = normalizeIntervalSeconds(
    sourceConfig?.dependencyWatch?.intervalSeconds,
    DEFAULT_DEPENDENCY_WATCH_INTERVAL_SECONDS,
  );
  return {
    id: DEPENDENCY_WATCH_TASK_ID,
    workDir: repoPaths[0] || process.cwd(),
    prompt: buildDependencyWatchPrompt(repoPaths),
    ...resolveWatcherProviderModel(
      sourceConfig?.dependencyWatch,
      [sourceConfig?.fleetHygiene, sourceConfig?.githubAgents],
      'dependencyWatch',
    ),
    intervalSeconds,
    maxIterations: 0,
    startImmediately: false,
    nextRunAtEpochMs: nowMs + intervalSeconds * 1000,
    metadata: {
      kind: 'dependency_watch',
    },
  };
}

function buildJobOpportunitiesTaskInput(sourceConfig = appConfig, { nowMs = Date.now() } = {}) {
  const settings = configuredJobOpportunitySettings(sourceConfig);
  if (!settings.scraperPath) {
    const error = new Error('Job opportunities requires DM_JOB_OPPORTUNITIES_SCRAPER_PATH');
    error.statusCode = 400;
    throw error;
  }
  const intervalSeconds = normalizeIntervalSeconds(
    sourceConfig?.jobOpportunities?.intervalSeconds,
    DEFAULT_JOB_OPPORTUNITIES_INTERVAL_SECONDS,
  );
  return {
    id: JOB_OPPORTUNITIES_TASK_ID,
    workDir: settings.scraperPath,
    prompt: buildJobOpportunitiesPrompt(sourceConfig),
    ...resolveWatcherProviderModel(
      sourceConfig?.jobOpportunities,
      [sourceConfig?.fleetHygiene, sourceConfig?.githubAgents],
      'jobOpportunities',
    ),
    intervalSeconds,
    maxIterations: 0,
    startImmediately: false,
    nextRunAtEpochMs: nowMs + intervalSeconds * 1000,
    metadata: {
      kind: 'job_opportunities',
      scraperPath: settings.scraperPath,
      scraperConfigPath: settings.scraperConfigPath,
      profilePath: settings.profilePath,
      outputDir: settings.outputDir,
    },
  };
}

function safeFleetHygieneStatus(task, sourceConfig = appConfig) {
  const repoPaths = configuredRepoPaths(sourceConfig);
  return {
    configured: Boolean(task && task.status === 'active'),
    repoCount: repoPaths.length,
    repoPaths,
    task: task ? safeTask(task) : null,
    intervalSeconds: FLEET_HYGIENE_INTERVAL_SECONDS,
  };
}

function safeDependencyWatchStatus(task, sourceConfig = appConfig) {
  const repoPaths = configuredDependencyWatchRepoPaths(sourceConfig);
  const intervalSeconds = normalizeIntervalSeconds(
    sourceConfig?.dependencyWatch?.intervalSeconds,
    DEFAULT_DEPENDENCY_WATCH_INTERVAL_SECONDS,
  );
  return {
    configured: Boolean(task && task.status === 'active'),
    repoCount: repoPaths.length,
    repoPaths,
    task: task ? safeTask(task) : null,
    intervalSeconds,
  };
}

function safeJobOpportunitiesStatus(task, sourceConfig = appConfig) {
  const settings = configuredJobOpportunitySettings(sourceConfig);
  const intervalSeconds = normalizeIntervalSeconds(
    sourceConfig?.jobOpportunities?.intervalSeconds,
    DEFAULT_JOB_OPPORTUNITIES_INTERVAL_SECONDS,
  );
  return {
    configured: Boolean(task && task.status === 'active'),
    scraperPath: settings.scraperPath,
    scraperConfigPath: settings.scraperConfigPath,
    profilePath: settings.profilePath,
    outputDir: settings.outputDir,
    task: task ? safeTask(task) : null,
    intervalSeconds,
  };
}

function configuredJobOpportunitySettings(config = appConfig) {
  return {
    scraperPath: normalizeText(config?.jobOpportunities?.scraperPath),
    scraperConfigPath: normalizeText(config?.jobOpportunities?.scraperConfigPath) || 'config/job-opportunities-startup-scraper.yaml',
    profilePath: normalizeText(config?.jobOpportunities?.profilePath) || 'config/job-opportunity-profile.md',
    outputDir: normalizeText(config?.jobOpportunities?.outputDir) || '.dueno/job-opportunities',
  };
}

function normalizeIntervalSeconds(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 86400 && number <= DEFAULT_DEPENDENCY_WATCH_INTERVAL_SECONDS
    ? number
    : fallback;
}

function safeTask(task = {}) {
  return {
    id: task.id,
    type: task.type || 'spawn',
    ...(task.type === 'inject' ? {
      targetSession: task.targetSession,
      tickLog: Array.isArray(task.tickLog) ? task.tickLog.slice(-50) : [],
      stopReason: task.stopReason ?? null,
    } : {}),
    workDir: task.workDir,
    prompt: task.prompt,
    provider: task.provider,
    model: task.model ?? null,
    intervalSeconds: task.intervalSeconds,
    maxIterations: task.maxIterations,
    parentThreadId: task.parentThreadId ?? null,
    status: task.status,
    currentIteration: task.currentIteration,
    nextRunAtEpochMs: task.nextRunAtEpochMs,
    lastSessionId: task.lastSessionId ?? null,
    metadata: task.metadata && typeof task.metadata === 'object' ? task.metadata : {},
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function safeStepSummary(summary = {}) {
  return {
    checked: Number(summary.checked || 0),
    spawned: Number(summary.spawned || 0),
    injected: Number(summary.injected || 0),
    skippedRunning: Number(summary.skippedRunning || 0),
    completed: Number(summary.completed || 0),
    tasks: Array.isArray(summary.tasks) ? summary.tasks.map((entry) => ({
      id: normalizeText(entry.id),
      action: normalizeText(entry.action),
      sessionId: normalizeText(entry.sessionId || '') || null,
      task: entry.task ? safeTask(entry.task) : null,
    })) : [],
  };
}

async function shouldLaunchFleetHygieneTask(task = {}, {
  rootConfig = appConfig,
  nowMs = Date.now(),
  gitRunner = runGit,
  logger = null,
} = {}) {
  if (task.id !== FLEET_HYGIENE_TASK_ID) return { launch: true };
  const repoPaths = configuredRepoPaths(rootConfig);
  if (repoPaths.length === 0) return { launch: true };

  const snapshot = await snapshotPrimaryBranchHeads(repoPaths, { gitRunner, logger });
  if (Object.keys(snapshot.branchHeads).length === 0) {
    return { launch: true };
  }

  const priorHeads = task.metadata?.branchHeads && typeof task.metadata.branchHeads === 'object'
    ? task.metadata.branchHeads
    : {};
  const metadata = {
    ...(task.metadata && typeof task.metadata === 'object' ? task.metadata : {}),
    kind: 'fleet_hygiene_audit',
    branchHeads: snapshot.branchHeads,
    branchHeadErrors: snapshot.errors,
    lastBranchHeadCheckAt: nowMs,
  };
  const hasPrior = Object.keys(priorHeads).length > 0;
  const changed = Object.entries(snapshot.branchHeads).some(([key, sha]) => priorHeads[key] !== sha);
  if (!hasPrior || changed) return { launch: true, metadata };

  return {
    launch: false,
    action: 'skippedNoMainChanges',
    metadata,
  };
}

async function shouldLaunchRepoQualityTask(task = {}, {
  rootConfig = appConfig,
  nowMs = Date.now(),
  gitRunner = runGit,
  logger = null,
} = {}) {
  if (task.id !== REPO_QUALITY_TASK_ID) return { launch: true };
  const repoPaths = configuredRepoQualityRepoPaths(rootConfig);
  if (repoPaths.length === 0) {
    return { launch: false, action: 'skippedNoRepos' };
  }

  const snapshot = await snapshotPrimaryBranchHeads(repoPaths, { gitRunner, logger });
  if (Object.keys(snapshot.branchHeads).length === 0) {
    return { launch: true };
  }

  const priorHeads = task.metadata?.branchHeads && typeof task.metadata.branchHeads === 'object'
    ? task.metadata.branchHeads
    : {};
  const metadata = {
    ...(task.metadata && typeof task.metadata === 'object' ? task.metadata : {}),
    kind: 'repo_quality_watch',
    branchHeads: snapshot.branchHeads,
    branchHeadErrors: snapshot.errors,
    lastBranchHeadCheckAt: nowMs,
  };
  const hasPrior = Object.keys(priorHeads).length > 0;
  const changed = Object.entries(snapshot.branchHeads).some(([key, sha]) => priorHeads[key] !== sha);
  if (task.metadata?.lastTickOk === false || !hasPrior || changed) {
    return { launch: true, metadata };
  }

  return {
    launch: false,
    action: 'skippedNoMainChanges',
    metadata,
  };
}

async function snapshotPrimaryBranchHeads(repoPaths = [], {
  gitRunner = runGit,
  logger = null,
} = {}) {
  const branchHeads = {};
  const errors = [];
  const seenRoots = new Set();

  for (const repoPath of unique(repoPaths)) {
    try {
      const root = await gitRunner(repoPath, ['rev-parse', '--show-toplevel']);
      if (!root || seenRoots.has(root)) continue;
      seenRoots.add(root);
      await gitRunner(root, ['fetch', '--quiet', 'origin']).catch((error) => {
        errors.push({ repoPath: root, code: normalizeText(error?.code || error?.message || 'git_fetch_failed') });
      });

      for (const branch of ['main', 'master']) {
        const sha = await gitRunner(root, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`]).catch(() => '');
        if (sha) branchHeads[`${root}#origin/${branch}`] = sha;
      }
    } catch (error) {
      const item = { repoPath, code: normalizeText(error?.code || error?.message || 'git_branch_head_snapshot_failed') };
      errors.push(item);
      if (logger?.warn) logger.warn(item, 'Fleet hygiene branch snapshot failed');
    }
  }

  return { branchHeads, errors };
}

async function runGit(cwd, args = []) {
  const result = await exec('git', ['-C', cwd, ...args], { timeout: 120000 });
  if (result.code !== 0) {
    const error = new Error('git_command_failed');
    error.code = 'git_command_failed';
    error.stderr = result.stderr;
    throw error;
  }
  return normalizeText(result.stdout);
}

async function defaultLsRemoteRunner(repo) {
  const url = `https://github.com/${repo}.git`;
  const result = await exec('git', ['ls-remote', url, 'HEAD'], { timeout: 120000 });
  if (result.code !== 0) {
    const error = new Error('git_ls_remote_failed');
    error.code = 'git_ls_remote_failed';
    error.stderr = result.stderr;
    throw error;
  }
  return normalizeText(String(result.stdout || '').split(/\s+/)[0]);
}

async function snapshotUpstreamHeads(repos = [], { lsRemoteRunner = defaultLsRemoteRunner, logger = null } = {}) {
  const upstreamHeads = {};
  const errors = [];
  for (const repo of unique(repos)) {
    try {
      const sha = normalizeText(await lsRemoteRunner(repo));
      if (sha) upstreamHeads[repo] = sha;
    } catch (error) {
      const item = { repo, code: normalizeText(error?.code || error?.message || 'git_ls_remote_failed') };
      errors.push(item);
      if (logger?.warn) logger.warn(item, 'Skills upstream head snapshot failed');
    }
  }
  return { upstreamHeads, errors };
}

async function shouldLaunchSkillsUpstreamTask(task = {}, {
  nowMs = Date.now(),
  lsRemoteRunner = defaultLsRemoteRunner,
  readManifest = defaultReadUpstreamManifest,
  logger = null,
} = {}) {
  if (task.id !== SKILLS_UPSTREAM_TASK_ID) return { launch: true };
  const manifestText = await readManifest(task.workDir).catch(() => '');
  const repos = parseUpstreamManifestRepos(manifestText);
  if (repos.length === 0) return { launch: true };

  const snapshot = await snapshotUpstreamHeads(repos, { lsRemoteRunner, logger });
  if (Object.keys(snapshot.upstreamHeads).length === 0) return { launch: true };

  const priorHeads = task.metadata?.upstreamHeads && typeof task.metadata.upstreamHeads === 'object'
    ? task.metadata.upstreamHeads
    : {};
  const metadata = {
    ...(task.metadata && typeof task.metadata === 'object' ? task.metadata : {}),
    kind: 'skills_upstream_watch',
    upstreamHeads: snapshot.upstreamHeads,
    upstreamHeadErrors: snapshot.errors,
    lastUpstreamHeadCheckAt: nowMs,
  };
  const hasPrior = Object.keys(priorHeads).length > 0;
  const changed = Object.entries(snapshot.upstreamHeads).some(([repo, sha]) => priorHeads[repo] !== sha);
  if (!hasPrior || changed) return { launch: true, metadata };

  return {
    launch: false,
    action: 'skippedNoUpstreamChanges',
    metadata,
  };
}

async function defaultReadUpstreamManifest(workDir) {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  return readFile(join(normalizeText(workDir) || process.cwd(), SKILLS_UPSTREAM_MANIFEST_REL), 'utf8');
}

function buildShouldLaunchDispatcher({ rootConfig, gitRunner, lsRemoteRunner, readManifest, logger } = {}) {
  return async (task, context = {}) => {
    if (task?.id === SKILLS_UPSTREAM_TASK_ID) {
      return shouldLaunchSkillsUpstreamTask(task, {
        ...context,
        lsRemoteRunner: lsRemoteRunner || context.lsRemoteRunner,
        readManifest: readManifest || context.readManifest,
        logger,
      });
    }
    if (task?.id === REPO_QUALITY_TASK_ID) {
      return shouldLaunchRepoQualityTask(task, {
        ...context,
        rootConfig,
        gitRunner,
        logger,
      });
    }
    return shouldLaunchFleetHygieneTask(task, {
      ...context,
      rootConfig,
      gitRunner,
      logger,
    });
  };
}

async function defaultDetectSkillsUpstream(workDir) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const repo = normalizeText(workDir);
  const script = joinPath(repo, 'scripts/skills-upstream-check.mjs');
  const { stdout } = await execFileAsync('node', [script, '--json', '--repo', repo], {
    cwd: repo || undefined,
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(String(stdout || '{}'));
}

function joinPath(root, rel) {
  const prefix = normalizeText(root);
  if (!prefix) return rel;
  return `${prefix.replace(/\/+$/, '')}/${rel}`;
}

async function defaultCreateSkillsUpstreamWorktree({ repoPath, baseDir, displayName, nowMs } = {}) {
  return createAgentSessionWorktree({
    repoPath,
    baseDir,
    displayName,
    branchPrefix: 'dueno-fleet/skill-sync',
    nowMs,
  });
}

function buildSkillsUpstreamLauncher({
  inner,
  detectSkillsUpstream,
  createWorktree,
  worktreeBaseDir,
  maxFanout,
  now,
  logger,
} = {}) {
  return async (input = {}) => {
    if (!inner) {
      const error = new Error('scheduled agent sessionLauncher is required');
      error.code = 'scheduled_agent_launcher_required';
      throw error;
    }
    if (input.taskId !== SKILLS_UPSTREAM_TASK_ID) return inner(input);

    const detect = detectSkillsUpstream || defaultDetectSkillsUpstream;
    let report;
    try {
      report = await detect(input.workDir);
    } catch (error) {
      if (logger?.warn) logger.warn({ err: error }, 'Skills upstream detect failed');
      return { id: null };
    }
    const groups = groupChangedByUpstreamPath(report?.changed || []);
    if (groups.length === 0) return { id: null };

    const selected = groups.slice(0, maxFanout);
    const deferredCount = Math.max(0, groups.length - selected.length);
    const create = createWorktree || defaultCreateSkillsUpstreamWorktree;
    let first = null;
    for (let i = 0; i < selected.length; i += 1) {
      const group = selected[i];
      let workDir = input.workDir;
      try {
        const worktree = await create({
          repoPath: input.workDir,
          baseDir: worktreeBaseDir,
          displayName: `skill-sync-${group.locals[0] || 'skill'}`,
          nowMs: (typeof now === 'function' ? now() : Date.now()) + i,
        });
        workDir = normalizeText(worktree?.worktreePath) || workDir;
      } catch (error) {
        if (logger?.warn) logger.warn({ err: error, locals: group.locals }, 'Skills upstream worktree create failed');
        continue;
      }
      const session = await inner({
        prompt: buildSkillsUpstreamIntegrationPrompt(group, { deferredCount: i === 0 ? deferredCount : 0 }),
        workDir,
        provider: input.provider,
        model: input.model,
        displayName: `skill-sync ${group.locals.join('+')}`,
        parentThreadId: input.parentThreadId || null,
      });
      if (!first) first = session;
    }
    return first || { id: null };
  };
}

async function defaultCreateRepoQualityWorktree({
  repoPath,
  baseDir,
  displayName,
  nowMs,
} = {}) {
  return createAgentSessionWorktree({
    repoPath,
    baseDir,
    displayName,
    branchPrefix: 'dueno-fleet/quality',
    nowMs,
  });
}

function repoQualitySectionArgs(section) {
  const normalizedSection = normalizeRepoQualitySection(section);
  return normalizedSection === 'default' ? [] : ['--section', normalizedSection];
}

async function defaultRunRepoQualityCheck(worktreePath, { section = 'default' } = {}) {
  const script = fileURLToPath(new URL('../../scripts/repo-quality-check.mjs', import.meta.url));
  const args = [script, '--repo', worktreePath, '--json', ...repoQualitySectionArgs(section)];
  try {
    const { stdout } = await execFileAsync('node', args, {
      cwd: worktreePath,
      maxBuffer: 32 * 1024 * 1024,
    });
    return parseRepoQualityCheckOutput({ code: 0, stdout });
  } catch (error) {
    return parseRepoQualityCheckOutput({
      code: error?.code,
      stdout: error.stdout,
      stderr: error.stderr,
      errorMessage: error.message,
    });
  }
}

async function defaultRemoveRepoQualityWorktree(worktree = {}) {
  return removeAgentSessionWorktree({
    repoPath: worktree.repoPath,
    worktreePath: worktree.worktreePath || worktree.workDir,
    branch: worktree.branch,
  });
}

function repoQualityStateDir() {
  return runtimeStatePath('repo-quality');
}

async function defaultSaveRepoQualityReport(record = {}) {
  await writeRepoQualityReportRecord(repoQualityStateDir(), record);
}

async function defaultLoadPreviousRepoQualityReport(repoPath, section = 'default') {
  return readPreviousRepoQualityReport(repoQualityStateDir(), repoPath, section);
}

function buildRepoQualityLauncher({
  inner,
  runRepoQualityCheck,
  createWorktree,
  removeWorktree,
  saveReport,
  loadPreviousReport,
  worktreeBaseDir,
  maxFanout,
  topN,
  repoTargets,
  repoPaths,
  now,
  logger,
} = {}) {
  return async (input = {}) => {
    if (!inner) {
      const error = new Error('scheduled agent sessionLauncher is required');
      error.code = 'scheduled_agent_launcher_required';
      throw error;
    }
    if (input.taskId !== REPO_QUALITY_TASK_ID) return inner(input);

    const targets = (Array.isArray(repoTargets) && repoTargets.length > 0
      ? repoTargets
      : unique(repoPaths).map((repoPath) => ({
        repoName: safeWorktreeName(repoPath),
        repoPath,
        section: 'default',
      })))
      .filter((target) => !isLiveFleetCheckout(target.repoPath));
    if (targets.length === 0) {
      return { skip: true, action: 'skippedNoRepos', metadata: { lastTickOk: false } };
    }
    const create = createWorktree || defaultCreateRepoQualityWorktree;
    const runCheck = runRepoQualityCheck || defaultRunRepoQualityCheck;
    const remove = removeWorktree || defaultRemoveRepoQualityWorktree;
    const save = saveReport || defaultSaveRepoQualityReport;
    const loadPrev = loadPreviousReport || defaultLoadPreviousRepoQualityReport;
    const created = [];
    const candidates = [];
    const tickCodes = [];

    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i];
      const { repoName, repoPath, section } = target;
      const sectionSuffix = section === 'default' ? '' : `-${safeWorktreeName(section)}`;
      const displayName = `quality-${safeWorktreeName(repoPath)}${sectionSuffix}`;
      let workDir = null;
      let branch = '';
      try {
        const worktree = await create({
          repoPath,
          baseDir: worktreeBaseDir,
          displayName,
          branchPrefix: 'dueno-fleet/quality',
          nowMs: (typeof now === 'function' ? now() : Date.now()) + i,
          repoName,
          section,
        });
        workDir = normalizeText(worktree?.worktreePath);
        branch = normalizeText(worktree?.branch);
        if (workDir) created.push({ repoName, repoPath, section, workDir, branch });
      } catch (error) {
        if (logger?.warn) logger.warn({ err: error, repoPath }, 'Repo quality worktree create failed');
        tickCodes.push(2);
        await save({
          repoPath,
          repoName,
          section,
          slug: repoQualityReportSlug(repoPath, section),
          code: 2,
          error: error.message || 'worktree_create_failed',
          report: null,
          delta: null,
        });
        continue;
      }
      if (!workDir) {
        tickCodes.push(2);
        await save({
          repoPath,
          repoName,
          section,
          slug: repoQualityReportSlug(repoPath, section),
          code: 2,
          error: 'worktree_path_required',
          report: null,
          delta: null,
        });
        continue;
      }

      let result;
      try {
        result = normalizeRepoQualityCheckResult(await runCheck(workDir, target));
      } catch (error) {
        result = normalizeRepoQualityCheckResult({
          code: 2,
          report: null,
          error: error.message || 'repo_quality_check_failed',
        });
      }
      const { code, report, error } = result;
      tickCodes.push(code);
      const previous = await loadPrev(repoPath, section).catch(() => null);
      const delta = report ? computeQualityReportDelta(report, previous) : null;
      await save({
        repoPath,
        repoName,
        section,
        worktreePath: workDir,
        slug: repoQualityReportSlug(repoPath, section),
        sha: report?.sha || null,
        code,
        error: code === 2 ? (error || 'repo_quality_check_failed') : null,
        report,
        delta,
      });
      if (shouldDispatchRepoQualityFix(result, previous)) {
        candidates.push({ repoName, repoPath, section, workDir, branch, report, delta });
      }
    }

    const selected = rankRepoQualityFixCandidates(candidates).slice(0, maxFanout);
    const selectedDirs = new Set(selected.map((item) => item.workDir));
    for (const item of created) {
      if (selectedDirs.has(item.workDir)) continue;
      try {
        await remove({
          repoPath: item.repoPath,
          worktreePath: item.workDir,
          workDir: item.workDir,
          branch: item.branch,
        });
      } catch (error) {
        if (logger?.warn) logger.warn({ err: error, repoPath: item.repoPath }, 'Repo quality worktree remove failed');
      }
    }

    const lastTickOk = tickCodes.length === targets.length && tickCodes.every((code) => code === 0 || code === 1);
    const metadata = { lastTickOk };
    let first = null;
    for (const item of selected) {
      const session = await inner({
        prompt: buildRepoQualityFixPrompt({
          repoPath: item.repoPath,
          repoName: item.repoName,
          section: item.section,
          worktreePath: item.workDir,
          topN,
          report: item.report,
          delta: item.delta,
        }),
        workDir: item.workDir,
        provider: input.provider,
        model: input.model,
        displayName: `quality-fix ${safeWorktreeName(item.repoPath)}${item.section === 'default' ? '' : ` ${safeWorktreeName(item.section)}`}`,
        parentThreadId: input.parentThreadId || null,
      });
      if (!first) first = session;
    }
    if (!first) {
      return {
        skip: true,
        action: lastTickOk ? 'measuredNoDispatch' : 'checkFailed',
        metadata,
      };
    }
    return { ...first, metadata };
  };
}

export async function scheduledAgentsPlugin(app, opts = {}) {
  const sourceConfig = opts.config || appConfig.scheduledAgents || {};
  const rootConfig = opts.rootConfig || appConfig;
  const store = opts.store || buildScheduledAgentStore({ env: opts.env || process.env });
  const now = opts.now || (() => Date.now());
  const sessionLauncher = buildRepoQualityLauncher({
    inner: buildSkillsUpstreamLauncher({
      inner: opts.sessionLauncher,
      detectSkillsUpstream: opts.detectSkillsUpstream,
      createWorktree: opts.createSkillsUpstreamWorktree,
      worktreeBaseDir: configuredSkillsUpstreamWorktreeBase(rootConfig),
      maxFanout: configuredSkillsUpstreamMaxFanout(rootConfig),
      now,
      logger: opts.log || app.log,
    }),
    runRepoQualityCheck: opts.runRepoQualityCheck,
    createWorktree: opts.createRepoQualityWorktree,
    removeWorktree: opts.removeRepoQualityWorktree,
    saveReport: opts.saveRepoQualityReport,
    loadPreviousReport: opts.loadPreviousRepoQualityReport,
    worktreeBaseDir: configuredRepoQualityWorktreeBase(rootConfig),
    maxFanout: configuredRepoQualityMaxFanout(rootConfig),
    topN: configuredRepoQualityTopN(rootConfig),
    repoTargets: configuredRepoQualityTargets(rootConfig),
    repoPaths: configuredRepoQualityRepoPaths(rootConfig),
    now,
    logger: opts.log || app.log,
  });
  const stepDeps = {
    store,
    sessionLauncher,
    lookupSessionState: opts.lookupSessionState,
    shouldLaunchTask: opts.shouldLaunchTask || buildShouldLaunchDispatcher({
      rootConfig,
      gitRunner: opts.gitRunner,
      lsRemoteRunner: opts.lsRemoteRunner,
      readManifest: opts.readUpstreamManifest,
      logger: opts.log || app.log,
    }),
    idleSessionGraceMs: resolveIdleSessionGraceMs(sourceConfig),
    maxConsecutiveSkips: resolveMaxConsecutiveSkips(sourceConfig),
    logger: opts.log || app.log,
  };
  const loop = opts.loop || new SchedulerLoop({
    config: sourceConfig,
    store,
    sessionLauncher,
    lookupSessionState: opts.lookupSessionState,
    shouldLaunchTask: stepDeps.shouldLaunchTask,
    now,
    logger: opts.log || app.log,
  });

  app.decorate('scheduledAgents', {
    store,
    loop,
    stepNow: (at = now()) => stepDue(at, stepDeps),
  });

  await store.list();
  loop.start();

  app.addHook('onClose', async () => {
    if (typeof loop.stop === 'function') loop.stop();
    if (typeof store.close === 'function') await store.close();
  });

  app.get('/api/agents/scheduled', async () => {
    const tasks = await store.list();
    return { taskCount: tasks.length, tasks: tasks.map(safeTask) };
  });

  app.post('/api/agents/scheduled', async (req, reply) => {
    try {
      const principal = req.duenoAuth?.principal || null;
      const input = principal?.type === 'agent'
        ? await buildDelegatedScheduledAgentInput(req.body || {}, req.duenoAuth)
        : (req.body || {});
      const task = await store.register(input);
      return safeTask(task);
    } catch (error) {
      return reply.code(error.statusCode || 400).send({
        error: error.message || 'Invalid scheduled agent task',
        code: error.code || 'scheduled_agent_invalid',
        ...(error.reason ? { reason: error.reason } : {}),
      });
    }
  });

  app.post('/api/agents/scheduled/:id/cancel', async (req, reply) => {
    const task = await store.cancel(req.params.id);
    if (!task) {
      return reply.code(404).send({ error: 'Scheduled agent task not found', code: 'scheduled_agent_not_found' });
    }
    return safeTask(task);
  });

  app.post('/api/agents/scheduled/step-now', async () => {
    const summary = await stepDue(now(), stepDeps);
    return safeStepSummary(summary);
  });

  app.get('/api/fleet/hygiene-audit', async () => {
    const task = await store.get(FLEET_HYGIENE_TASK_ID) || await store.get(LEGACY_FLEET_HYGIENE_TASK_ID);
    return safeFleetHygieneStatus(task, rootConfig);
  });

  app.post('/api/fleet/hygiene-audit/setup', async () => {
    const task = await setupFleetHygieneTask(store, rootConfig, now());
    return safeFleetHygieneStatus(task, rootConfig);
  });

  app.post('/api/fleet/hygiene-audit/run-now', async () => {
    await setupFleetHygieneTask(store, rootConfig, now());
    await store.update(FLEET_HYGIENE_TASK_ID, { nextRunAtEpochMs: now(), updatedAt: now() });
    const summary = await stepDue(now(), stepDeps);
    const updatedTask = await store.get(FLEET_HYGIENE_TASK_ID);
    return {
      ...safeFleetHygieneStatus(updatedTask, rootConfig),
      step: safeStepSummary(summary),
    };
  });

  app.get('/api/fleet/dependency-watch', async () => {
    const task = await store.get(DEPENDENCY_WATCH_TASK_ID) || await store.get(LEGACY_DEPENDENCY_WATCH_TASK_ID);
    return safeDependencyWatchStatus(task, rootConfig);
  });

  app.post('/api/fleet/dependency-watch/setup', async () => {
    const input = buildDependencyWatchTaskInput(rootConfig, { nowMs: now() });
    const existing = await store.get(DEPENDENCY_WATCH_TASK_ID);
    const task = existing
      ? await store.update(DEPENDENCY_WATCH_TASK_ID, {
        ...input,
        status: 'active',
        nextRunAtEpochMs: existing.nextRunAtEpochMs || input.nextRunAtEpochMs,
      })
      : await store.register(input);
    const legacy = await store.get(LEGACY_DEPENDENCY_WATCH_TASK_ID);
    if (legacy?.status === 'active') await store.cancel(LEGACY_DEPENDENCY_WATCH_TASK_ID);
    return safeDependencyWatchStatus(task, rootConfig);
  });

  app.post('/api/fleet/dependency-watch/run-now', async () => {
    let task = await store.get(DEPENDENCY_WATCH_TASK_ID);
    if (!task) {
      task = await store.register(buildDependencyWatchTaskInput(rootConfig, { nowMs: now() }));
    }
    const legacy = await store.get(LEGACY_DEPENDENCY_WATCH_TASK_ID);
    if (legacy?.status === 'active') await store.cancel(LEGACY_DEPENDENCY_WATCH_TASK_ID);
    await store.update(DEPENDENCY_WATCH_TASK_ID, { nextRunAtEpochMs: now(), updatedAt: now() });
    const summary = await stepDue(now(), stepDeps);
    const updatedTask = await store.get(DEPENDENCY_WATCH_TASK_ID);
    return {
      ...safeDependencyWatchStatus(updatedTask, rootConfig),
      step: safeStepSummary(summary),
    };
  });

  app.get('/api/fleet/skills-upstream', async () => {
    const task = await store.get(SKILLS_UPSTREAM_TASK_ID);
    return safeSkillsUpstreamStatus(task, rootConfig);
  });

  app.post('/api/fleet/skills-upstream/setup', async (_req, reply) => {
    const problem = skillsUpstreamRepoProblem(configuredSkillsUpstreamRepoPath(rootConfig));
    if (problem) {
      return reply.code(400).send({
        ...safeSkillsUpstreamStatus(await store.get(SKILLS_UPSTREAM_TASK_ID), rootConfig),
        error: { code: problem.code, message: problem.message },
      });
    }
    const input = buildSkillsUpstreamTaskInput(rootConfig, { nowMs: now() });
    const existing = await store.get(SKILLS_UPSTREAM_TASK_ID);
    const task = existing
      ? await store.update(SKILLS_UPSTREAM_TASK_ID, {
        ...input,
        status: 'active',
        nextRunAtEpochMs: existing.nextRunAtEpochMs || input.nextRunAtEpochMs,
        metadata: {
          ...input.metadata,
          upstreamHeads: existing.metadata?.upstreamHeads || input.metadata.upstreamHeads,
        },
      })
      : await store.register(input);
    return safeSkillsUpstreamStatus(task, rootConfig);
  });

  app.post('/api/fleet/skills-upstream/run-now', async (_req, reply) => {
    const problem = skillsUpstreamRepoProblem(configuredSkillsUpstreamRepoPath(rootConfig));
    if (problem) {
      return reply.code(400).send({
        ...safeSkillsUpstreamStatus(await store.get(SKILLS_UPSTREAM_TASK_ID), rootConfig),
        error: { code: problem.code, message: problem.message },
      });
    }
    let task = await store.get(SKILLS_UPSTREAM_TASK_ID);
    if (!task) {
      task = await store.register(buildSkillsUpstreamTaskInput(rootConfig, { nowMs: now() }));
    }
    await store.update(SKILLS_UPSTREAM_TASK_ID, { nextRunAtEpochMs: now(), updatedAt: now() });
    const summary = await stepDue(now(), stepDeps);
    const updatedTask = await store.get(SKILLS_UPSTREAM_TASK_ID);
    return {
      ...safeSkillsUpstreamStatus(updatedTask, rootConfig),
      step: safeStepSummary(summary),
    };
  });

  app.get('/api/fleet/job-opportunities', async () => {
    const task = await store.get(JOB_OPPORTUNITIES_TASK_ID);
    return safeJobOpportunitiesStatus(task, rootConfig);
  });

  app.post('/api/fleet/job-opportunities/setup', async () => {
    const input = buildJobOpportunitiesTaskInput(rootConfig, { nowMs: now() });
    const existing = await store.get(JOB_OPPORTUNITIES_TASK_ID);
    const task = existing
      ? await store.update(JOB_OPPORTUNITIES_TASK_ID, {
        ...input,
        status: 'active',
        nextRunAtEpochMs: existing.nextRunAtEpochMs || input.nextRunAtEpochMs,
      })
      : await store.register(input);
    return safeJobOpportunitiesStatus(task, rootConfig);
  });

  app.post('/api/fleet/job-opportunities/run-now', async () => {
    let task = await store.get(JOB_OPPORTUNITIES_TASK_ID);
    if (!task) {
      task = await store.register(buildJobOpportunitiesTaskInput(rootConfig, { nowMs: now() }));
    }
    await store.update(JOB_OPPORTUNITIES_TASK_ID, { nextRunAtEpochMs: now(), updatedAt: now() });
    const summary = await stepDue(now(), stepDeps);
    const updatedTask = await store.get(JOB_OPPORTUNITIES_TASK_ID);
    return {
      ...safeJobOpportunitiesStatus(updatedTask, rootConfig),
      step: safeStepSummary(summary),
    };
  });

  app.get('/api/fleet/repo-quality', async () => {
    const task = await store.get(REPO_QUALITY_TASK_ID);
    return safeRepoQualityStatus(task, rootConfig);
  });

  app.post('/api/fleet/repo-quality/setup', async (_req, reply) => {
    const problem = repoQualityRepoProblem(configuredRepoQualityRepoPaths(rootConfig));
    if (problem) {
      return reply.code(400).send({
        ...safeRepoQualityStatus(await store.get(REPO_QUALITY_TASK_ID), rootConfig),
        error: { code: problem.code, message: problem.message },
      });
    }
    const input = buildRepoQualityTaskInput(rootConfig, { nowMs: now() });
    const existing = await store.get(REPO_QUALITY_TASK_ID);
    const task = existing
      ? await store.update(REPO_QUALITY_TASK_ID, {
        ...input,
        status: 'active',
        nextRunAtEpochMs: existing.nextRunAtEpochMs || input.nextRunAtEpochMs,
        metadata: {
          ...input.metadata,
          branchHeads: existing.metadata?.branchHeads || input.metadata.branchHeads,
        },
      })
      : await store.register(input);
    return safeRepoQualityStatus(task, rootConfig);
  });

  app.post('/api/fleet/repo-quality/run-now', async (_req, reply) => {
    const problem = repoQualityRepoProblem(configuredRepoQualityRepoPaths(rootConfig));
    if (problem) {
      return reply.code(400).send({
        ...safeRepoQualityStatus(await store.get(REPO_QUALITY_TASK_ID), rootConfig),
        error: { code: problem.code, message: problem.message },
      });
    }
    let task = await store.get(REPO_QUALITY_TASK_ID);
    if (!task) {
      task = await store.register(buildRepoQualityTaskInput(rootConfig, { nowMs: now() }));
    }
    await store.update(REPO_QUALITY_TASK_ID, { nextRunAtEpochMs: now(), updatedAt: now() });
    const summary = await stepDue(now(), stepDeps);
    const updatedTask = await store.get(REPO_QUALITY_TASK_ID);
    return {
      ...safeRepoQualityStatus(updatedTask, rootConfig),
      step: safeStepSummary(summary),
    };
  });
}
