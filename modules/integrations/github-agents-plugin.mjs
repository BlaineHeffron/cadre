import { createAgentAdapters } from '../agent-bus/adapters.mjs';
import { config as appConfig } from '../../config.mjs';
import { createAgentSession, enqueueAgentSessionCommand } from '../sessions/index.mjs';
import { resolveAgentProviderSelection } from '../agent/provider-interface.mjs';
import {
  buildGithubAgentRepoStore,
  GithubAgentPoller,
} from './github-agents.mjs';

function normalizeText(value) {
  return String(value || '').trim();
}

function safeRepo(repo = {}) {
  return {
    id: repo.id,
    owner: repo.owner,
    repo: repo.repo,
    authRef: repo.authRef,
    enabled: repo.enabled,
    prEnabled: repo.prEnabled,
    issueEnabled: repo.issueEnabled,
    autoReviewEnabled: repo.autoReviewEnabled,
    lastSeenPrNumber: repo.lastSeenPrNumber,
    lastSeenIssueNumber: repo.lastSeenIssueNumber,
    lastEvent: repo.lastEvent,
    lastSpawnSessionId: repo.lastSpawnSessionId,
    lastError: repo.lastError,
    lastPollMs: repo.lastPollMs,
  };
}

function safeSpawn(spawn = {}) {
  return {
    kind: normalizeText(spawn.kind),
    number: Number(spawn.number || 0),
    sessionId: normalizeText(spawn.sessionId),
    fallbackReason: normalizeText(spawn.fallbackReason || '') || null,
    metadata: {
      github_repo: normalizeText(spawn.metadata?.github_repo),
      github_kind: normalizeText(spawn.metadata?.github_kind),
      github_number: Number(spawn.metadata?.github_number || 0),
      github_branch: normalizeText(spawn.metadata?.github_branch),
      github_worktree_path: normalizeText(spawn.metadata?.github_worktree_path || '') || null,
      github_source_repo_path: normalizeText(spawn.metadata?.github_source_repo_path || '') || null,
      github_fallback_reason: normalizeText(spawn.metadata?.github_fallback_reason || '') || null,
    },
  };
}

function safePollResult(result = {}) {
  return {
    repoId: normalizeText(result.repoId),
    baselined: result.baselined === true,
    baselinePr: result.baselinePr === true,
    baselineIssue: result.baselineIssue === true,
    skipped: result.skipped === true,
    reason: normalizeText(result.reason || '') || null,
    error: normalizeText(result.error || '') || null,
    lastPollMs: Number(result.lastPollMs || result.updatedRepo?.lastPollMs || 0) || null,
    newPullRequestNumbers: Array.isArray(result.newPullRequests) ? result.newPullRequests.map((item) => Number(item.number || 0)).filter(Boolean) : [],
    newIssueNumbers: Array.isArray(result.newIssues) ? result.newIssues.map((item) => Number(item.number || 0)).filter(Boolean) : [],
    spawned: Array.isArray(result.spawned) ? result.spawned.map(safeSpawn) : [],
    spawnCapped: result.spawnCapped === true,
    deletedSessions: result.deletedSessions || [],
    repo: result.updatedRepo ? safeRepo(result.updatedRepo) : null,
  };
}

export async function defaultSessionLauncher({
  prompt,
  workDir,
  displayName,
  provider,
  model,
  thinkingLevel,
  metadata,
  createSession = createAgentSession,
  enqueueSessionCommand = enqueueAgentSessionCommand,
} = {}) {
  const selection = resolveAgentProviderSelection({
    provider: provider || 'codex',
    model,
    fallbackProvider: 'codex',
  });
  const result = await createSession(selection.backendType, {
    workDir,
    displayName,
    model: selection.model,
    provider: selection.backendProvider,
    runtime: selection.runtime,
    thinkingLevel,
    source: 'github-agent',
    autoCloseMode: 'when_waiting_for_input',
    autoCloseAfterMs: 2 * 60 * 60 * 1000,
    metadata,
  });
  await enqueueSessionCommand(selection.backendType, result.id, {
    source: 'github_agent_startup',
    operation: 'startup',
    text: prompt,
    enter: true,
  });
  return {
    ...result,
    provider: selection.provider,
    backendType: selection.backendType,
    runtime: selection.runtime,
  };
}

function safeConfig(source = {}, env = process.env) {
  return {
    ...source,
    env,
  };
}

export async function githubAgentsPlugin(app, opts = {}) {
  const sourceConfig = safeConfig(opts.config || appConfig.githubAgents || {}, opts.env || process.env);
  const wsManager = opts.wsManager || null;
  const repoStore = opts.repoStore || buildGithubAgentRepoStore({
    env: opts.env || process.env,
    defaultAutoReviewEnabled: sourceConfig.autoReviewEnabled,
  });
  const sessionLauncher = opts.sessionLauncher || ((input) => defaultSessionLauncher({
    ...input,
    createSession: opts.createSession || createAgentSession,
    enqueueSessionCommand: opts.enqueueSessionCommand || enqueueAgentSessionCommand,
  }));
  const latestResults = opts.latestResults || new Map();

  async function handleResult(result) {
    const safe = safePollResult(result);
    if (safe.repoId) latestResults.set(safe.repoId, safe);
    if (wsManager && typeof wsManager.broadcast === 'function') {
      wsManager.broadcast('github:agents', 'snapshot', safe);
    }
    return safe;
  }

  const poller = opts.poller || new GithubAgentPoller({
    repoStore,
    config: sourceConfig,
    fetchImpl: opts.fetchImpl || globalThis.fetch,
    now: opts.now || (() => Date.now()),
    timeoutMs: opts.timeoutMs,
    sessionLauncher,
    createPrWorktree: opts.createPrWorktree,
    createIssueWorktree: opts.createIssueWorktree,
    resolveScratchWorkDir: opts.resolveScratchWorkDir,
    reapWorktreesImpl: opts.reapWorktreesImpl,
    listExistingSessions: opts.listExistingSessions,
    tmuxSessionExists: opts.tmuxSessionExists,
    deleteSession: opts.deleteSession || ((session) => createAgentAdapters()[session.backendType].deleteSession(app, session.id || session.sessionId)),
    onResult: handleResult,
    log: opts.log || app.log,
  });

  app.decorate('githubAgents', {
    repoStore,
    poller,
    latestResults,
    handleResult,
  });

  if (sourceConfig.enabled) {
    void poller.pollOnce({ suppressSpawn: sourceConfig.spawnOnStartup !== true }).catch((error) => {
      app.log.warn({ code: normalizeText(error?.code || error?.message || 'poll_failed') }, 'GitHub initial poll failed');
    });
    poller.start();
  }

  app.addHook('onClose', async () => {
    if (typeof poller.stop === 'function') poller.stop();
    if (typeof repoStore.close === 'function') await repoStore.close();
  });

  app.get('/api/agents/github', async () => {
    const repos = await repoStore.listRepos();
    return { enabled: sourceConfig.enabled === true, repos: repos.map(safeRepo) };
  });

  app.post('/api/agents/github', async (req, reply) => {
    try {
      const repo = await repoStore.upsertRepo(req.body || {});
      return { repo: safeRepo(repo) };
    } catch (error) {
      return reply.code(400).send({ error: error.message || 'Invalid GitHub repo config', code: error.code || 'github_repo_invalid' });
    }
  });

  app.delete('/api/agents/github/:id', async (req, reply) => {
    const deleted = await repoStore.deleteRepo(req.params.id);
    if (!deleted) return reply.code(404).send({ error: 'GitHub repo not found' });
    return { repo: safeRepo(deleted) };
  });

  app.post('/api/agents/github/poll-now', async (req) => {
    if (!sourceConfig.enabled) {
      return { enabled: false, results: [], skipped: true, reason: 'github_agents_disabled' };
    }
    const id = normalizeText(req.body?.id || req.query?.id || '');
    const results = await poller.pollOnce({ id });
    return { enabled: true, results: results.map(safePollResult) };
  });
}
