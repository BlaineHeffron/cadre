import { mkdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { exec } from '../../lib/exec.mjs';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { createGithubIssueWorktree, createGithubPullRequestWorktree, reapWorktrees, removeAgentSessionWorktree } from '../fleet/git-worktree.mjs';
import { legacyRootStatePath, runtimeStatePath } from '../ops/runtime-state.mjs';

const DEFAULT_STORE_FILE = runtimeStatePath('github_agent_repos.json');
const LEGACY_STORE_FILE = legacyRootStatePath('github_agent_repos.json');
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SPAWNS_PER_POLL = 5;
const MAX_SPAWNED_ITEM_KEYS = 500;
const SPAWN_BACKOFF_BASE_MS = 60_000;
const SPAWN_BACKOFF_MAX_MS = 30 * 60_000;
const USER_AGENT = 'dueno-fleet';
// Public repos accept issues and PRs from anyone; only these authors spawn agents.
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_ACCEPT = 'application/vnd.github+json';

function normalizeText(value) {
  return String(value || '').trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const text = normalizeText(value).toLowerCase();
  if (!text) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function normalizeRepoSlug(value, field = 'repo') {
  const text = normalizeText(value);
  if (!/^[A-Za-z0-9_.-]+$/.test(text) || text.startsWith('.') || text.endsWith('.')) {
    const error = new Error(`invalid GitHub ${field}`);
    error.code = 'github_repo_invalid';
    throw error;
  }
  return text;
}

function normalizeSpawnedItemKeys(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const keys = [];
  for (const entry of value) {
    const key = normalizeText(entry);
    if (!/^(pr|issue):\d+$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys.slice(-MAX_SPAWNED_ITEM_KEYS);
}

function githubItemSpawnKey(kind, item = {}) {
  const normalizedKind = normalizeText(kind).toLowerCase();
  const number = Number(item.number || 0);
  if ((normalizedKind !== 'pr' && normalizedKind !== 'issue') || !Number.isInteger(number) || number <= 0) return '';
  return `${normalizedKind}:${number}`;
}

function withSpawnedItemKey(repo = {}, key = '') {
  const normalizedKey = normalizeText(key);
  if (!normalizedKey) return repo;
  const keys = normalizeSpawnedItemKeys(repo.spawnedItemKeys);
  if (!keys.includes(normalizedKey)) keys.push(normalizedKey);
  return {
    ...repo,
    spawnedItemKeys: keys.slice(-MAX_SPAWNED_ITEM_KEYS),
  };
}

function githubSpawnBackoffKey(repoId, kind, item = {}) {
  const itemKey = githubItemSpawnKey(kind, item);
  const id = normalizeText(repoId);
  if (!id || !itemKey) return '';
  return `${id}:${itemKey}`;
}

function shouldSkipGithubSpawnBackoff(spawnBackoff, repoId, kind, item, nowMs) {
  if (!spawnBackoff || typeof spawnBackoff.get !== 'function') return false;
  const key = githubSpawnBackoffKey(repoId, kind, item);
  if (!key) return false;
  const nextRetryMs = Number(spawnBackoff.get(key)?.nextRetryMs || 0);
  return Number.isFinite(nextRetryMs) && nextRetryMs > Number(nowMs || 0);
}

function recordGithubSpawnBackoff(spawnBackoff, repoId, kind, item, nowMs) {
  if (!spawnBackoff || typeof spawnBackoff.get !== 'function' || typeof spawnBackoff.set !== 'function') return;
  const key = githubSpawnBackoffKey(repoId, kind, item);
  if (!key) return;
  const count = Math.min(Math.max(Number(spawnBackoff.get(key)?.count || 0) + 1, 1), 8);
  const delayMs = Math.min(SPAWN_BACKOFF_MAX_MS, SPAWN_BACKOFF_BASE_MS * (2 ** Math.min(count - 1, 5)));
  spawnBackoff.set(key, { count, nextRetryMs: Number(nowMs || 0) + delayMs });
}

function clearGithubSpawnBackoff(spawnBackoff, repoId, kind, item) {
  if (!spawnBackoff || typeof spawnBackoff.delete !== 'function') return;
  const key = githubSpawnBackoffKey(repoId, kind, item);
  if (key) spawnBackoff.delete(key);
}

function lastSeenCursorsForUnprocessed(advancedRepo = {}, unprocessed = []) {
  let lastSeenPrNumber = advancedRepo.lastSeenPrNumber;
  let lastSeenIssueNumber = advancedRepo.lastSeenIssueNumber;
  for (const entry of unprocessed) {
    const kind = normalizeText(entry.kind).toLowerCase();
    const number = Number(entry.item?.number || 0);
    if (!Number.isInteger(number) || number <= 0) continue;
    const next = number - 1;
    if (kind === 'pr') {
      lastSeenPrNumber = lastSeenPrNumber == null || lastSeenPrNumber === ''
        ? next
        : Math.min(Number(lastSeenPrNumber), next);
    } else if (kind === 'issue') {
      lastSeenIssueNumber = lastSeenIssueNumber == null || lastSeenIssueNumber === ''
        ? next
        : Math.min(Number(lastSeenIssueNumber), next);
    }
  }
  return { lastSeenPrNumber, lastSeenIssueNumber };
}

async function cleanupSpawnedGithubWorktree({
  removeWorktree,
  repoContext = {},
  log = null,
} = {}) {
  if (typeof removeWorktree !== 'function') return { removed: false };
  const worktreePath = normalizeText(repoContext.worktreePath);
  const repoPath = normalizeText(repoContext.repoPath);
  if (!worktreePath || !repoPath) return { removed: false };
  try {
    return await removeWorktree({
      repoPath,
      worktreePath,
      branch: normalizeText(repoContext.branch),
      force: true,
    }) || { removed: true, path: worktreePath };
  } catch (error) {
    if (log?.warn) {
      log.warn({
        worktreePath,
        repoPath,
        code: normalizeText(error?.code || error?.message || 'worktree_remove_failed'),
      }, 'Failed to remove GitHub agent worktree after spawn error');
    }
    return { removed: false };
  }
}

function githubRepoWorktreeKey(repo = {}) {
  return normalizeText(repo.id || `${repo.owner || ''}/${repo.repo || ''}`).replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function githubAgentWorktreeItemPrefix(kind, item = {}) {
  const key = githubItemSpawnKey(kind, item);
  if (!key) return '';
  return `${key.replace(':', '-')}-`;
}

function sessionMatchesGithubItem(session = {}, repo = {}, kind = '', item = {}, config = {}) {
  const normalizedKind = normalizeText(kind).toLowerCase();
  const number = Number(item.number || 0);
  if (!normalizedKind || !Number.isInteger(number) || number <= 0) return false;

  const metadata = session.metadata && typeof session.metadata === 'object' ? session.metadata : {};
  const metadataRepo = normalizeText(metadata.github_repo);
  const metadataKind = normalizeText(metadata.github_kind).toLowerCase();
  const metadataNumber = Number(metadata.github_number || 0);
  if (metadataRepo === repo.id && metadataKind === normalizedKind && metadataNumber === number) return true;

  const workDir = normalizeText(session.workDir || metadata.github_worktree_path);
  if (!workDir) return false;
  let relativeWorktree = '';
  try {
    const baseDir = expandHomePath(config.workDir || '~/.dueno-fleet/github-agents');
    const worktreeRoot = resolve(baseDir, 'worktrees', githubRepoWorktreeKey(repo));
    relativeWorktree = relative(worktreeRoot, resolve(workDir));
  } catch {
    return false;
  }
  if (!relativeWorktree || relativeWorktree.startsWith('..') || relativeWorktree.startsWith('/')) return false;
  const firstSegment = relativeWorktree.split(/[\\/]+/).filter(Boolean)[0] || '';
  return firstSegment.startsWith(githubAgentWorktreeItemPrefix(normalizedKind, item));
}

async function readSessionRegistry(filePath, legacyFilePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    if (!legacyFilePath) return [];
  }
  try {
    const parsed = JSON.parse(await readFile(legacyFilePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function tmuxSessionExists(sessionName = '') {
  const normalized = normalizeText(sessionName);
  if (!normalized) return false;
  try {
    const { code } = await exec('tmux', ['has-session', '-t', normalized]);
    return code === 0;
  } catch {
    return false;
  }
}

function sessionRegistrySources(config = {}) {
  return [
    { backendType: 'codex', explicitFile: config.codexSessionsFile, fileName: 'codex_sessions.json' },
    { backendType: 'claude', explicitFile: config.claudeSessionsFile, fileName: 'claude_sessions.json' },
    { backendType: 'pi', explicitFile: config.piSessionsFile, fileName: 'pi_sessions.json' },
  ];
}

async function listRegisteredGithubSessions(config = {}) {
  const sessions = [];
  for (const source of sessionRegistrySources(config)) {
    const entries = await readSessionRegistry(
      source.explicitFile || runtimeStatePath(source.fileName),
      source.explicitFile ? undefined : legacyRootStatePath(source.fileName),
    );
    for (const entry of entries) sessions.push({ ...entry, backendType: source.backendType });
  }
  return sessions;
}

async function findExistingGithubItemSession(repo = {}, kind = '', item = {}, {
  config = {},
  listExistingSessions = null,
  tmuxSessionExists: tmuxSessionExistsImpl = null,
} = {}) {
  const sessions = typeof listExistingSessions === 'function'
    ? await listExistingSessions()
    : await listRegisteredGithubSessions(config);
  const sessionIsLive = typeof tmuxSessionExistsImpl === 'function'
    ? tmuxSessionExistsImpl
    : tmuxSessionExists;

  for (const session of sessions) {
    if (!sessionMatchesGithubItem(session, repo, kind, item, config)) continue;
    if (session.tmuxSession && !(await sessionIsLive(session.tmuxSession))) continue;
    return session;
  }
  return null;
}

function isUpperRef(value) {
  return /^[A-Z0-9_]+$/.test(normalizeText(value));
}

export function validateGithubAuthRef(value) {
  const ref = normalizeText(value);
  if (!ref) {
    const error = new Error('github authRef is required');
    error.code = 'github_auth_ref_missing';
    throw error;
  }
  const lower = ref.toLowerCase();
  if (
    !isUpperRef(ref)
    || ref.includes('://')
    || lower.startsWith('ghp_')
    || lower.startsWith('github_pat_')
    || lower.startsWith('gho_')
    || lower.startsWith('ghu_')
    || lower.startsWith('ghs_')
    || lower.includes('bearer')
    || lower.includes('token=')
    || lower.includes('authorization')
  ) {
    const error = new Error('github authRef must be an env-style ref, not inline token material');
    error.code = 'github_auth_ref_invalid';
    throw error;
  }
  return ref;
}

export function normalizeGithubAgentRepo(input = {}, {
  defaultAutoReviewEnabled = true,
  nowMs = Date.now(),
} = {}) {
  const owner = normalizeRepoSlug(input.owner, 'owner');
  const repo = normalizeRepoSlug(input.repo, 'repo');
  const id = `${owner}/${repo}`;
  return {
    id,
    owner,
    repo,
    authRef: validateGithubAuthRef(input.authRef || input.auth_ref || ''),
    prEnabled: normalizeBoolean(input.prEnabled ?? input.pr_enabled, true),
    issueEnabled: normalizeBoolean(input.issueEnabled ?? input.issue_enabled, true),
    autoReviewEnabled: normalizeBoolean(
      input.autoReviewEnabled ?? input.auto_review_enabled,
      defaultAutoReviewEnabled,
    ),
    lastSeenPrNumber: normalizeCursor(input.lastSeenPrNumber ?? input.last_seen_pr_number),
    lastSeenIssueNumber: normalizeCursor(input.lastSeenIssueNumber ?? input.last_seen_issue_number),
    lastPollMs: normalizeMs(input.lastPollMs ?? input.last_poll_ms),
    lastEvent: normalizeText(input.lastEvent ?? input.last_event),
    lastSpawnSessionId: normalizeText(input.lastSpawnSessionId ?? input.last_spawn_session_id),
    watches: Array.isArray(input.watches) ? clone(input.watches) : [],
    spawnedItemKeys: normalizeSpawnedItemKeys(input.spawnedItemKeys ?? input.spawned_item_keys),
    lastError: normalizeText(input.lastError ?? input.last_error),
    enabled: normalizeBoolean(input.enabled, true),
    createdAtMs: normalizeMs(input.createdAtMs ?? input.created_at_ms) || nowMs,
    updatedAtMs: normalizeMs(input.updatedAtMs ?? input.updated_at_ms) || nowMs,
  };
}

export function buildGithubAgentRepoStore({
  storeFile = DEFAULT_STORE_FILE,
  namespace = 'github_agent_repos',
  stateStore,
  env = process.env,
  modeEnvKey = 'APP_STATE_STORAGE',
  now = () => Date.now(),
  defaultAutoReviewEnabled = true,
} = {}) {
  const backingStore = stateStore || buildPostgresJsonStore({
    namespace,
    filePath: storeFile,
    legacyFilePath: storeFile === DEFAULT_STORE_FILE ? LEGACY_STORE_FILE : undefined,
    env,
    modeEnvKey,
  });
  let loaded = false;
  let loadingPromise = null;
  let saveQueue = Promise.resolve();
  let state = normalizeStoreState(backingStore.loadSync?.() || {});

  async function load() {
    if (loaded) return;
    if (!loadingPromise) {
      loadingPromise = (async () => {
        const raw = await backingStore.load().catch(() => null);
        if (raw && typeof raw === 'object') state = normalizeStoreState(raw);
        loaded = true;
      })().finally(() => {
        loadingPromise = null;
      });
    }
    await loadingPromise;
  }

  async function save() {
    const snapshot = clone(state);
    const write = saveQueue.catch(() => {}).then(() => backingStore.save(snapshot));
    saveQueue = write.catch(() => {});
    await write;
  }

  async function upsertRepo(input = {}) {
    await load();
    const repo = normalizeGithubAgentRepo(input, {
      defaultAutoReviewEnabled,
      nowMs: now(),
    });
    const prior = state.repos[repo.id];
    for (const [key, alias] of [
      ['lastSeenPrNumber', 'last_seen_pr_number'],
      ['lastSeenIssueNumber', 'last_seen_issue_number'],
      ['spawnedItemKeys', 'spawned_item_keys'],
    ]) {
      if (prior && !Object.hasOwn(input, key) && !Object.hasOwn(input, alias)) repo[key] = prior[key];
    }
    state.repos[repo.id] = {
      ...repo,
      watches: prior?.watches || [],
      createdAtMs: prior?.createdAtMs || repo.createdAtMs,
      updatedAtMs: now(),
    };
    await save();
    return clone(state.repos[repo.id]);
  }

  async function updateRepo(repoId, patch = {}) {
    await load();
    const id = normalizeText(repoId);
    const prior = state.repos[id];
    if (!prior) return null;
    const next = normalizeGithubAgentRepo({ ...prior, ...patch, id }, {
      defaultAutoReviewEnabled,
      nowMs: now(),
    });
    state.repos[id] = {
      ...next,
      watches: prior.watches,
      createdAtMs: prior.createdAtMs || next.createdAtMs,
      updatedAtMs: now(),
    };
    await save();
    return clone(state.repos[id]);
  }

  async function listRepos() {
    await load();
    return Object.values(state.repos)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(clone);
  }

  async function getRepo(id) {
    await load();
    const repo = state.repos[normalizeText(id)];
    return repo ? clone(repo) : null;
  }

  async function deleteRepo(id) {
    await load();
    const repoId = normalizeText(id);
    const existing = state.repos[repoId];
    if (!existing) return null;
    delete state.repos[repoId];
    await save();
    return clone(existing);
  }

  async function listWatches() {
    await load();
    return Object.values(state.repos).flatMap((repo) => repo.watches).map(clone);
  }

  async function putWatch(input, creator) {
    await load();
    const repo = state.repos[normalizeText(input.repo)];
    if (!repo) throw new Error('GitHub repo is not configured');
    if (!Number.isSafeInteger(input.number) || input.number < 1) throw new Error('PR number must be a positive integer');
    if (!creator?.kind || !creator.sessionId) throw new Error('Authenticated agent identity required');
    const prior = repo.watches.find((watch) => watch.number === input.number);
    const watch = { ...(prior || { createdAtMs: now(), lastReviewId: 0 }), repo: repo.id,
      number: input.number, creator: clone(prior?.creator || creator), thread_id: normalizeText(input.thread_id) || null };
    if (prior) repo.watches[repo.watches.indexOf(prior)] = watch;
    else repo.watches.push(watch);
    await save();
    return clone(watch);
  }

  async function updateWatch(repoId, number, patch = null) {
    await load();
    const repo = state.repos[repoId];
    const watch = repo?.watches.find((item) => item.number === number);
    if (!watch) return null;
    if (patch) Object.assign(watch, patch);
    else repo.watches.splice(repo.watches.indexOf(watch), 1);
    await save();
    return clone(watch);
  }

  async function close() {
    await saveQueue.catch(() => {});
    if (typeof backingStore.close === 'function') await backingStore.close();
  }

  return { upsertRepo, updateRepo, listRepos, getRepo, deleteRepo, listWatches, putWatch, updateWatch, close };
}

export async function pollGithubRepo(repoInput = {}, {
  fetchImpl = globalThis.fetch,
  env = process.env,
  now = () => Date.now(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const nowMs = now();
  const repo = normalizeGithubAgentRepo(repoInput, { nowMs });
  if (!repo.enabled) {
    return safePollResult(repo, nowMs, { skipped: true, reason: 'disabled' });
  }
  if (typeof fetchImpl !== 'function') {
    return safePollResult(repo, nowMs, { error: 'fetch_unavailable' });
  }

  const token = resolveGithubAuthToken(repo, env);
  const result = safePollResult(repo, nowMs);

  try {
    const [pulls, issues] = await Promise.all([
      repo.prEnabled ? fetchGithubList(fetchImpl, githubPullsUrl(repo), { token, timeoutMs }) : [],
      repo.issueEnabled ? fetchGithubList(fetchImpl, githubIssuesUrl(repo), { token, timeoutMs }) : [],
    ]);
    const trusted = (item) => TRUSTED_AUTHOR_ASSOCIATIONS.has(item?.author_association);
    const openPulls = pulls.filter(trusted).map(normalizeGithubItem).filter((item) => item.number > 0);
    const openIssues = issues
      .filter((item) => !item?.pull_request && trusted(item))
      .map(normalizeGithubItem)
      .filter((item) => item.number > 0);
    const baselinePr = repo.prEnabled && repo.lastSeenPrNumber == null;
    const baselineIssue = repo.issueEnabled && repo.lastSeenIssueNumber == null;
    const baselined = baselinePr || baselineIssue;
    const maxPrNumber = repo.prEnabled ? maxNumber(openPulls, repo.lastSeenPrNumber, baselinePr ? 0 : null) : repo.lastSeenPrNumber;
    const maxIssueNumber = repo.issueEnabled ? maxNumber(openIssues, repo.lastSeenIssueNumber, baselineIssue ? 0 : null) : repo.lastSeenIssueNumber;
    const newPullRequests = baselinePr ? [] : openPulls.filter((item) => item.number > Number(repo.lastSeenPrNumber || 0));
    const newIssues = baselineIssue ? [] : openIssues.filter((item) => item.number > Number(repo.lastSeenIssueNumber || 0));
    const updatedRepo = {
      ...repo,
      lastSeenPrNumber: maxPrNumber,
      lastSeenIssueNumber: maxIssueNumber,
      lastPollMs: nowMs,
      lastEvent: eventLabel({ baselined, newPullRequests, newIssues }),
      lastError: '',
      updatedAtMs: nowMs,
    };
    return {
      ...result,
      baselined,
      baselinePr,
      baselineIssue,
      newPullRequests,
      newIssues,
      openPullRequestNumbers: repo.prEnabled ? pulls.map((item) => Number(item.number)) : null,
      openIssueNumbers: repo.issueEnabled ? issues.filter((item) => !item.pull_request).map((item) => Number(item.number)) : null,
      updatedRepo: safeRepoRecord(updatedRepo),
    };
  } catch (error) {
    const sanitized = sanitizedError(error);
    return {
      ...result,
      error: sanitized,
      updatedRepo: safeRepoRecord({
        ...repo,
        lastPollMs: nowMs,
        lastError: sanitized,
        lastEvent: 'poll_error',
        updatedAtMs: nowMs,
      }),
    };
  }
}

export class GithubAgentPoller {
  constructor({
    repoStore,
    config = {},
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sessionLauncher = null,
    createPrWorktree = createGithubPullRequestWorktree,
    createIssueWorktree = createGithubIssueWorktree,
    removeWorktree = removeAgentSessionWorktree,
    resolveScratchWorkDir = defaultScratchWorkDir,
    spawnBackoff = null,
    reapWorktreesImpl = reapWorktrees,
    listExistingSessions = null,
    tmuxSessionExists = null,
    deleteSession = null,
    onResult = () => {},
    getThread = () => null,
    listRooms = () => [],
    linkWorktreePr = async () => {},
    endThread = null,
    notifyWatch = async () => {},
    log = null,
  } = {}) {
    this.repoStore = repoStore;
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.sessionLauncher = sessionLauncher;
    this.createPrWorktree = createPrWorktree;
    this.createIssueWorktree = createIssueWorktree;
    this.removeWorktree = removeWorktree;
    this.resolveScratchWorkDir = resolveScratchWorkDir;
    this.spawnBackoff = spawnBackoff instanceof Map ? spawnBackoff : new Map();
    this.reapWorktrees = reapWorktreesImpl;
    this.listExistingSessions = listExistingSessions;
    this.tmuxSessionExists = tmuxSessionExists;
    this.deleteSession = deleteSession;
    this.pollQueue = Promise.resolve();
    this.onResult = onResult;
    this.getThread = getThread;
    this.listRooms = listRooms;
    this.linkWorktreePr = linkWorktreePr;
    this.endThread = endThread;
    this.notifyWatch = notifyWatch;
    this.log = log;
    this.timer = null;
  }

  async getWorktreePr(metadata) {
    if (!metadata.pr) return null;
    const repo = await this.repoStore.getRepo(metadata.pr.repo);
    if (!repo) return null;
    return fetchGithubJson(this.fetchImpl,
      `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${metadata.pr.number}`,
      { token: resolveGithubAuthToken(repo, this.config.env || process.env), timeoutMs: this.timeoutMs });
  }

  async listRepos() {
    return this.repoStore?.listRepos ? await this.repoStore.listRepos() : [];
  }

  async pollRepo(repo, { suppressSpawn = false } = {}) {
    if (this.config?.enabled !== true) {
      return {
        repoId: repo.id,
        skipped: true,
        reason: 'github_agents_disabled',
        spawned: [],
        updatedRepo: safeRepoRecord(repo),
      };
    }
    if (!suppressSpawn && repo.enabled) await this.pollWatches(repo);
    const result = await pollGithubRepo(repo, {
      fetchImpl: this.fetchImpl,
      env: this.config.env || process.env,
      now: this.now,
      timeoutMs: this.timeoutMs,
    });
    const deletedSessions = [];
    if (!suppressSpawn && !result.error && !result.skipped && typeof this.deleteSession === 'function') {
      const sessions = this.listExistingSessions
        ? await this.listExistingSessions()
        : await listRegisteredGithubSessions(this.config);
      for (const session of sessions) {
        if (session.source !== 'github-agent' || session.endedAt) continue;
        try {
          const metadata = session.metadata || {};
          const kind = metadata.github_kind;
          const number = Number(metadata.github_number);
          if (!sessionMatchesGithubItem(session, repo, kind, { number }, this.config)) continue;
          const openNumbers = kind === 'pr' ? result.openPullRequestNumbers : kind === 'issue' ? result.openIssueNumbers : null;
          if (!openNumbers || openNumbers.includes(number)) continue;
          if (session.tmuxSession && !(await (this.tmuxSessionExists || tmuxSessionExists)(session.tmuxSession))) continue;
          const item = await fetchGithubJson(this.fetchImpl,
            `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/${kind === 'pr' ? 'pulls' : 'issues'}/${number}`, {
              token: resolveGithubAuthToken(repo, this.config.env || process.env), timeoutMs: this.timeoutMs,
            });
          if (item?.state !== 'closed') continue;
          await this.deleteSession(session);
          deletedSessions.push({ sessionId: session.id || session.sessionId, kind, number });
          this.log?.info?.({ repoId: repo.id, sessionId: session.id || session.sessionId, kind, number }, 'Deleted GitHub agent session for closed item');
        } catch (error) {
          this.log?.warn?.({ repoId: repo.id, sessionId: session.id || session.sessionId, code: sanitizedError(error) }, 'Failed to delete GitHub agent session for closed item');
        }
      }
    }
    const spawn = suppressSpawn
      ? { spawned: [], capped: false, updatedRepo: result.updatedRepo }
      : await spawnGithubAgentsForPollResult(result, {
        config: this.config,
        repoStore: this.repoStore,
        sessionLauncher: this.sessionLauncher,
        createPrWorktree: this.createPrWorktree,
        createIssueWorktree: this.createIssueWorktree,
        removeWorktree: this.removeWorktree,
        resolveScratchWorkDir: this.resolveScratchWorkDir,
        spawnBackoff: this.spawnBackoff,
        listExistingSessions: this.listExistingSessions,
        tmuxSessionExists: this.tmuxSessionExists,
        now: this.now,
        log: this.log,
      });
    const updatedRepo = spawn.updatedRepo || result.updatedRepo;
    // Persist lastSeen only after spawn so backoff skips, empty session ids,
    // and the per-poll cap cannot advance the cursor past unprocessed items.
    if (updatedRepo && this.repoStore?.updateRepo) {
      await this.repoStore.updateRepo(repo.id, updatedRepo);
    }
    const payload = {
      ...result,
      spawned: spawn.spawned,
      deletedSessions,
      spawnCapped: spawn.capped,
      updatedRepo,
    };
    await this.onResult(payload);
    return payload;
  }

  // Managed-worktree rooms are watched by branch so merge ends the room even if no one called watch_pr.
  async watchRoomPrs(repo) {
    for (const room of await this.listRooms()) {
      const worktree = room.metadata?.worktree;
      if (!worktree?.branch || worktree.pr) continue;
      try {
        const origin = await exec('git', ['-C', worktree.repo, 'config', '--get', 'remote.origin.url']);
        if (origin.stdout.trim().match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/]+\/[^/]+?)(?:\.git)?\/?$/i)?.[1].toLowerCase() !== repo.id.toLowerCase()) continue;
        const pulls = await fetchGithubList(this.fetchImpl, `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:${worktree.branch}`)}&per_page=100`,
          { token: resolveGithubAuthToken(repo, this.config.env || process.env), timeoutMs: this.timeoutMs });
        // GitHub timestamps have second precision.
        const pr = pulls.find((item) => Date.parse(item.created_at) >= Math.floor(room.createdAt / 1000) * 1000);
        if (!pr) continue;
        // An explicit watch on the same PR keeps its linkage. Notifications go to the room owner;
        // the first (always newly created) participant is the fallback creator.
        const watched = (await this.repoStore.getRepo(repo.id))?.watches.some((watch) => watch.number === pr.number);
        const [{ kind, sessionId }] = room.participants;
        // A linked room is never rediscovered, and a failed save can leave the watch in memory,
        // so any failure drops the new watch before the watch tick and retries discovery next tick.
        try {
          if (!watched) await this.repoStore.putWatch({ repo: repo.id, number: pr.number, thread_id: room.id }, { kind, sessionId });
          await this.linkWorktreePr(room.id, { repo: repo.id, number: pr.number });
        } catch (error) {
          if (!watched) await this.repoStore.updateWatch(repo.id, pr.number).catch(() => {});
          throw error;
        }
      } catch (error) {
        this.log?.warn?.({ repoId: repo.id, threadId: room.id, code: sanitizedError(error) }, 'Room PR discovery failed');
      }
    }
  }

  async pollWatches(repo) {
    await this.watchRoomPrs(repo);
    for (const watch of (await this.repoStore.getRepo(repo.id))?.watches || []) {
      try {
        const target = () => {
          const owner = watch.thread_id ? this.getThread(watch.thread_id)?.thread?.createdBy : null;
          return owner?.kind && owner.kind !== 'user' && owner.sessionId ? owner : watch.creator;
        };
        const label = `PR ${repo.id}#${watch.number}`;
        const notify = (line, recipient = target()) => this.notifyWatch(recipient, `[PR_WATCH] ${label} ${line}`);
        if (this.now() - watch.createdAtMs >= 7 * 24 * 60 * 60 * 1000) {
          await notify('watch expired after 7 days');
          await this.repoStore.updateWatch(repo.id, watch.number);
          continue;
        }
        const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls/${watch.number}`;
        const options = { token: resolveGithubAuthToken(repo, this.config.env || process.env), timeoutMs: this.timeoutMs };
        const pr = await fetchGithubJson(this.fetchImpl, url, options);
        const reviews = await fetchGithubList(this.fetchImpl, `${url}/reviews?per_page=100&page=${watch.reviewPage || 1}`, options);
        for (const review of reviews.filter((item) => item.id > watch.lastReviewId).sort((a, b) => a.id - b.id)) {
          const lines = String(review.body || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          const verdict = lines.find((line) => /^VERDICT\b/.test(line)) || (lines[0] || '').slice(0, 200);
          await notify(`review by ${review.user?.login || 'unknown'} (${review.state}): ${verdict}${lines.filter((line) => /^- \[B\]/.test(line)).slice(0, 5).map((line) => `\n${line}`).join('')}`);
          await this.repoStore.updateWatch(repo.id, watch.number, { lastReviewId: review.id });
        }
        if (reviews.length === 100) await this.repoStore.updateWatch(repo.id, watch.number, { reviewPage: (watch.reviewPage || 1) + 1 });
        if (pr.merged || pr.state === 'closed') {
          const recipient = target();
          let suffix = '';
          const thread = watch.thread_id ? this.getThread(watch.thread_id)?.thread : null;
          // A room whose worktree moved to another branch keeps working; rediscovery watches the PR on that branch.
          // An unknown branch (git failure, detached HEAD) keeps the watch and retries next tick.
          let branch = '';
          if (pr.merged && thread?.status === 'open' && thread.metadata?.worktree?.path) {
            const current = await exec('git', ['-C', thread.metadata.worktree.path, 'branch', '--show-current']);
            branch = current.stdout.trim();
            if (current.code !== 0 || !branch) throw new Error('worktree branch unknown');
          }
          if (branch && branch !== pr.head?.ref) {
            await this.linkWorktreePr(watch.thread_id, undefined, branch);
            suffix = ` · room continues on ${branch}`;
          } else if (pr.merged && thread?.status === 'open' && this.endThread) {
            try {
              const result = await this.endThread(watch.thread_id, { reason: 'PR merged' });
              suffix = ` · ended room ${watch.thread_id}: ${result.results.filter((item) => item.status === 'terminated').length} sessions terminated${result.worktree ? ` · ${result.worktree.report}` : ''}`;
            } catch (error) {
              if (error.statusCode === 409 && error.code === 'room_ending') throw error;
              this.log?.warn?.({ threadId: watch.thread_id, code: sanitizedError(error) }, 'PR watch room end failed');
              suffix = ` · room ${watch.thread_id} not ended: ${error.code || error.statusCode || 'error'}`;
            }
          }
          await notify(pr.merged ? `merged (${String(pr.merge_commit_sha || pr.head?.sha || '').slice(0, 7)})${suffix}` : 'closed without merge', recipient);
          await this.repoStore.updateWatch(repo.id, watch.number);
        } else {
          if (pr.mergeable_state === 'dirty' && watch.mergeableState !== 'dirty') await notify('has merge conflict');
          await this.repoStore.updateWatch(repo.id, watch.number, { mergeableState: pr.mergeable_state });
        }
      } catch (error) {
        this.log?.warn?.({ repoId: repo.id, number: watch.number, code: sanitizedError(error) }, 'PR watch poll failed');
      }
    }
  }

  pollOnce(options = {}) {
    const poll = this.pollQueue.catch(() => {}).then(() => this.runPollOnce(options));
    this.pollQueue = poll;
    return poll;
  }

  async runPollOnce({ id = '', suppressSpawn = false } = {}) {
    await this.runReaper();
    const repos = await this.listRepos();
    const selected = normalizeText(id)
      ? repos.filter((repo) => repo.id === normalizeText(id))
      : repos;
    const results = [];
    for (const repo of selected) {
      try {
        results.push(await this.pollRepo(repo, { suppressSpawn }));
      } catch (error) {
        if (this.log?.error) {
          this.log.error({
            repoId: repo.id,
            err: error,
            message: error?.message || String(error),
            stack: error?.stack || null,
            code: error?.code || null,
            statusCode: error?.statusCode || null,
          }, 'GitHub agent repo poll failed');
        }
        const sanitized = sanitizedError(error);
        const current = typeof this.repoStore?.getRepo === 'function'
          ? await this.repoStore.getRepo(repo.id)
          : null;
        const payload = {
          repoId: repo.id,
          error: sanitized,
          spawned: [],
          updatedRepo: safeRepoRecord({
            ...(current || repo),
            lastError: sanitized,
            lastEvent: 'poll_error',
            lastPollMs: this.now(),
          }),
        };
        if (this.repoStore?.updateRepo) await this.repoStore.updateRepo(repo.id, payload.updatedRepo);
        await this.onResult(payload);
        results.push(payload);
      }
    }
    return results;
  }

  async runReaper() {
    if (this.config?.worktreeReapEnabled !== true || typeof this.reapWorktrees !== 'function') return null;
    return this.reapWorktrees({
      enabled: true,
      sourceRepos: configuredRepoPaths(this.config.repoPaths),
      baseDirs: [expandHomePath(this.config.workDir || '~/.dueno-fleet/github-agents')],
      minAgeSec: this.config.worktreeReapMinAgeSec ?? 300,
      maxPerPass: this.config.worktreeReapMaxPerPass ?? 20,
      force: true,
      now: this.now,
      log: this.log,
    });
  }

  start() {
    this.stop();
    if (this.config?.enabled !== true) return;
    const intervalSec = Math.min(Math.max(Number(this.config.pollIntervalSec || 60), 15), 3600);
    this.timer = setInterval(() => {
      void this.pollOnce().catch((error) => {
        if (this.log?.warn) this.log.warn({ code: sanitizedError(error) }, 'GitHub agent poll failed');
      });
    }, intervalSec * 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export async function spawnGithubAgentsForPollResult(pollResult = {}, {
  config = {},
  repoStore = null,
  sessionLauncher,
  createPrWorktree = createGithubPullRequestWorktree,
  createIssueWorktree = createGithubIssueWorktree,
  removeWorktree = removeAgentSessionWorktree,
  resolveScratchWorkDir = defaultScratchWorkDir,
  spawnBackoff = null,
  listExistingSessions = null,
  tmuxSessionExists = null,
  now = () => Date.now(),
  log = null,
} = {}) {
  const enabled = config.enabled === true;
  const repo = pollResult.updatedRepo || {};
  if (!enabled || repo.enabled === false) {
    return { spawned: [], capped: false, skipped: true, reason: enabled ? 'repo_disabled' : 'github_agents_disabled' };
  }
  if (typeof sessionLauncher !== 'function') {
    return { spawned: [], capped: false, skipped: true, reason: 'session_launcher_unavailable' };
  }

  const nowMs = now();
  const spawnedItemKeys = normalizeSpawnedItemKeys(repo.spawnedItemKeys);
  const processedKeys = new Set(spawnedItemKeys);
  const newEntries = [
    ...(Array.isArray(pollResult.newPullRequests) ? pollResult.newPullRequests.map((item) => ({ kind: 'pr', item })) : []),
    ...(Array.isArray(pollResult.newIssues) ? pollResult.newIssues.map((item) => ({ kind: 'issue', item })) : []),
  ];
  const candidateKeys = new Set();
  const candidates = newEntries.filter((entry) => {
    const key = githubItemSpawnKey(entry.kind, entry.item);
    if (!key || processedKeys.has(key) || candidateKeys.has(key)) return false;
    candidateKeys.add(key);
    return !shouldSkipGithubSpawnBackoff(spawnBackoff, repo.id, entry.kind, entry.item, nowMs);
  });

  let latestRepo = repo;
  const items = [];
  for (const entry of candidates) {
    const spawnedItemKey = githubItemSpawnKey(entry.kind, entry.item);
    const existingSession = await findExistingGithubItemSession(repo, entry.kind, entry.item, {
      config,
      listExistingSessions,
      tmuxSessionExists,
    });
    if (!existingSession) {
      items.push(entry);
      continue;
    }
    processedKeys.add(spawnedItemKey);
    latestRepo = {
      ...withSpawnedItemKey(latestRepo, spawnedItemKey),
      lastSpawnSessionId: normalizeText(existingSession.id || existingSession.sessionId),
      lastEvent: `existing_${entry.kind}`,
      updatedAtMs: now(),
    };
    if (repoStore?.updateRepo) {
      latestRepo = await repoStore.updateRepo(repo.id, {
        lastSpawnSessionId: latestRepo.lastSpawnSessionId,
        lastEvent: latestRepo.lastEvent,
        spawnedItemKeys: latestRepo.spawnedItemKeys,
      }) || latestRepo;
    }
  }

  const maxSpawns = normalizeMaxSpawns(config.maxSpawnsPerPoll);
  const capped = items.length > maxSpawns;
  const selected = items.slice(0, maxSpawns);
  if (capped && log?.warn) {
    log.warn({ repoId: repo.id, requested: items.length, maxSpawns }, 'GitHub agent spawn cap reached');
  }

  const spawned = [];
  for (const entry of selected) {
    try {
      const outcome = await spawnGithubAgentForItem({
        repo,
        kind: entry.kind,
        item: entry.item,
        config,
        sessionLauncher,
        createPrWorktree,
        createIssueWorktree,
        removeWorktree,
        resolveScratchWorkDir,
        now,
        log,
      });
      spawned.push(outcome);
      if (outcome.sessionId) {
        clearGithubSpawnBackoff(spawnBackoff, repo.id, entry.kind, entry.item);
        const spawnedItemKey = githubItemSpawnKey(entry.kind, entry.item);
        processedKeys.add(spawnedItemKey);
        latestRepo = {
          ...withSpawnedItemKey(latestRepo, spawnedItemKey),
          lastSpawnSessionId: outcome.sessionId,
          lastEvent: `spawned_${entry.kind}`,
          updatedAtMs: now(),
        };
        if (repoStore?.updateRepo) {
          latestRepo = await repoStore.updateRepo(repo.id, {
            lastSpawnSessionId: outcome.sessionId,
            lastEvent: `spawned_${entry.kind}`,
            spawnedItemKeys: latestRepo.spawnedItemKeys,
          }) || latestRepo;
        }
      } else {
        recordGithubSpawnBackoff(spawnBackoff, repo.id, entry.kind, entry.item, now());
      }
    } catch (error) {
      recordGithubSpawnBackoff(spawnBackoff, repo.id, entry.kind, entry.item, now());
      throw error;
    }
  }

  const unprocessed = newEntries.filter((entry) => {
    const key = githubItemSpawnKey(entry.kind, entry.item);
    return Boolean(key) && !processedKeys.has(key);
  });
  latestRepo = {
    ...latestRepo,
    ...lastSeenCursorsForUnprocessed(repo, unprocessed),
  };

  return { spawned, capped, skipped: false, updatedRepo: latestRepo };
}

export async function spawnGithubAgentForItem({
  repo = {},
  kind = 'pr',
  item = {},
  config = {},
  sessionLauncher,
  createPrWorktree = createGithubPullRequestWorktree,
  createIssueWorktree = createGithubIssueWorktree,
  removeWorktree = removeAgentSessionWorktree,
  resolveScratchWorkDir = defaultScratchWorkDir,
  now = () => Date.now(),
  log = null,
} = {}) {
  const repoId = normalizeText(repo.id || `${repo.owner}/${repo.repo}`);
  const number = Number(item.number || 0);
  if (!repoId || !number) {
    return { kind, number, sessionId: '', error: 'invalid_github_item' };
  }
  const baseDir = expandHomePath(config.workDir || '~/.dueno-fleet/github-agents');
  const localRepoPath = configuredRepoPath(config.repoPaths, repoId);
  let repoContext = localRepoPath ? { repoPath: localRepoPath } : { fallbackReason: 'repo_not_configured' };
  let workDir = '';

  if (localRepoPath) {
    try {
      const runId = now();
      repoContext = kind === 'pr'
        ? await createPrWorktree({
          repoPath: localRepoPath,
          baseDir,
          repoId,
          prNumber: number,
          itemId: `${runId}`,
        })
        : await createIssueWorktree({
          repoPath: localRepoPath,
          baseDir,
          repoId,
          issueNumber: number,
          itemId: `${runId}`,
          incidentId: `issue-${number}-${runId}`,
          branchPrefix: 'dueno-fleet/issue',
        });
      workDir = repoContext.worktreePath;
    } catch (error) {
      repoContext = {
        repoPath: localRepoPath,
        fallbackReason: sanitizedWorktreeError(error),
      };
    }
  }

  if (!workDir) {
    workDir = await resolveScratchWorkDir({
      baseDir,
      repoId,
      kind,
      number,
      nowMs: now(),
    });
    repoContext = {
      ...repoContext,
      worktreePath: '',
      branch: '',
    };
  }

  const prompt = buildGithubAgentPrompt({ repo, kind, item, repoContext, workDir });
  const metadata = {
    github_repo: repoId,
    github_kind: kind,
    github_number: number,
    github_branch: normalizeText(repoContext.branch || ''),
    github_base_ref: normalizeText(repoContext.baseRef || '') || null,
    github_base_head: normalizeText(repoContext.baseHead || '') || null,
    github_worktree_path: normalizeText(repoContext.worktreePath || '') || null,
    github_source_repo_path: normalizeText(repoContext.repoPath || '') || null,
    github_fallback_reason: normalizeText(repoContext.fallbackReason || '') || null,
  };
  const managedWorktree = Boolean(normalizeText(repoContext.worktreePath));
  try {
    const session = await sessionLauncher({
      prompt,
      workDir,
      displayName: `GitHub ${kind.toUpperCase()} #${number}`,
      provider: config.provider,
      model: config.model,
      thinkingLevel: config.thinkingLevel,
      metadata,
      authRef: repo.authRef,
    });
    const sessionId = normalizeText(session?.id || session?.sessionId || '');
    if (!sessionId && managedWorktree) {
      await cleanupSpawnedGithubWorktree({ removeWorktree, repoContext, log });
    }
    return {
      kind,
      number,
      sessionId,
      workDir,
      metadata,
      prompt,
      fallbackReason: metadata.github_fallback_reason,
    };
  } catch (error) {
    if (managedWorktree) {
      await cleanupSpawnedGithubWorktree({ removeWorktree, repoContext, log });
    }
    throw error;
  }
}

function normalizeCursor(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return null;
  return number;
}

function normalizeMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeStoreState(raw = {}) {
  const repos = {};
  const source = raw?.repos && typeof raw.repos === 'object' ? raw.repos : {};
  for (const value of Object.values(source)) {
    try {
      const repo = normalizeGithubAgentRepo(value);
      repos[repo.id] = repo;
    } catch {
      // Ignore malformed persisted rows; route layer can surface validation on writes.
    }
  }
  return { version: 1, repos };
}

function safeRepoRecord(repo = {}) {
  return {
    id: repo.id,
    owner: repo.owner,
    repo: repo.repo,
    authRef: repo.authRef,
    prEnabled: repo.prEnabled,
    issueEnabled: repo.issueEnabled,
    autoReviewEnabled: repo.autoReviewEnabled,
    lastSeenPrNumber: repo.lastSeenPrNumber,
    lastSeenIssueNumber: repo.lastSeenIssueNumber,
    lastPollMs: repo.lastPollMs,
    lastEvent: repo.lastEvent,
    lastSpawnSessionId: repo.lastSpawnSessionId,
    spawnedItemKeys: normalizeSpawnedItemKeys(repo.spawnedItemKeys),
    lastError: repo.lastError,
    enabled: repo.enabled,
    createdAtMs: repo.createdAtMs,
    updatedAtMs: repo.updatedAtMs,
  };
}

function safePollResult(repo, nowMs, overrides = {}) {
  return {
    repoId: repo.id,
    owner: repo.owner,
    repo: repo.repo,
    lastPollMs: nowMs,
    baselined: false,
    skipped: false,
    reason: null,
    error: null,
    newPullRequests: [],
    newIssues: [],
    updatedRepo: safeRepoRecord({ ...repo, lastPollMs: nowMs }),
    ...overrides,
  };
}

export function resolveGithubAuthToken(repo, env) {
  if (!repo.authRef) return '';
  const token = normalizeText(env?.[repo.authRef]);
  if (!token) {
    const error = new Error('github auth ref unresolved');
    error.code = 'github_auth_ref_unresolved';
    throw error;
  }
  return token;
}

function githubPullsUrl(repo) {
  return `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/pulls?state=open&sort=created&per_page=100`;
}

function githubIssuesUrl(repo) {
  return `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues?state=open&sort=created&per_page=100`;
}

async function fetchGithubList(fetchImpl, url, options) {
  const payload = await fetchGithubJson(fetchImpl, url, options);
  return Array.isArray(payload) ? payload : [];
}

async function fetchGithubJson(fetchImpl, url, { token = '', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: githubHeaders(token),
      signal: controller.signal,
    });
    if (!response || typeof response.status !== 'number') {
      const error = new Error('malformed response');
      error.code = 'malformed_response';
      throw error;
    }
    if (response.status === 401 || response.status === 403) {
      const error = new Error('unauthorized');
      error.code = `http_${response.status}`;
      throw error;
    }
    if (response.status === 404) {
      const error = new Error('not found');
      error.code = 'http_404';
      throw error;
    }
    if (!response.ok) {
      const error = new Error('github http error');
      error.code = `http_${response.status}`;
      throw error;
    }
    const payload = await response.json().catch(() => {
      const error = new Error('invalid json');
      error.code = 'json_parse_failed';
      throw error;
    });
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function githubHeaders(token) {
  return {
    Accept: GITHUB_ACCEPT,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': USER_AGENT,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function normalizeGithubItem(item = {}) {
  return {
    number: Number(item.number || 0),
    id: Number(item.id || 0) || null,
    title: normalizeText(item.title).slice(0, 300),
    state: normalizeText(item.state || 'open') || 'open',
    htmlUrl: normalizeText(item.html_url),
    apiUrl: normalizeText(item.url),
    createdAt: normalizeText(item.created_at),
    updatedAt: normalizeText(item.updated_at),
    user: normalizeText(item.user?.login),
  };
}

function maxNumber(items = [], fallback = null, emptyFallback = null) {
  const max = items.reduce((highest, item) => Math.max(highest, Number(item.number || 0)), Number(fallback || 0));
  if (max > 0) return max;
  return fallback == null ? emptyFallback : fallback;
}

function eventLabel({ baselined, newPullRequests = [], newIssues = [] } = {}) {
  if (baselined) return 'baseline';
  if (newPullRequests.length || newIssues.length) return 'new_items';
  return 'no_new_items';
}

function sanitizedError(error) {
  if (error?.name === 'AbortError') return 'timeout';
  const code = normalizeText(error?.code).toLowerCase();
  if (code.includes('github_auth_ref_invalid')) return 'auth_ref_invalid';
  if (code.includes('github_auth_ref_unresolved')) return 'auth_ref_unresolved';
  if (code.includes('http_401') || code.includes('http_403')) return 'unauthorized';
  if (code.includes('http_404')) return 'not_found';
  if (code.includes('http_5')) return 'server_error';
  if (code.includes('json')) return 'malformed_response';
  if (error instanceof TypeError) return 'unreachable';
  const status = Number(error?.statusCode);
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status >= 500 && status <= 599) return 'server_error';
  return 'poll_failed';
}

function configuredRepoPath(repoPaths = {}, repoId = '') {
  if (!repoPaths || typeof repoPaths !== 'object') return '';
  const raw = repoPaths[repoId] || repoPaths[repoId.toLowerCase()] || '';
  return normalizeText(typeof raw === 'string' ? raw : raw?.primary);
}

function configuredRepoPaths(repoPaths = {}) {
  if (!repoPaths || typeof repoPaths !== 'object') return [];
  return [...new Set(Object.values(repoPaths)
    .map((raw) => normalizeText(typeof raw === 'string' ? raw : raw?.primary))
    .filter(Boolean))];
}

function expandHomePath(path = '') {
  const text = normalizeText(path);
  if (!text.startsWith('~/')) return resolve(text || '.');
  return resolve(process.env.HOME || process.cwd(), text.slice(2));
}

async function defaultScratchWorkDir({ baseDir, repoId, kind, number, nowMs } = {}) {
  const safeRepo = normalizeText(repoId).replace(/[^a-zA-Z0-9._-]+/g, '-');
  const safeKind = normalizeText(kind).replace(/[^a-zA-Z0-9._-]+/g, '-') || 'item';
  const safeNumber = Number(number || 0) || 0;
  const path = resolve(baseDir, 'scratch', safeRepo, `${safeKind}-${safeNumber}-${nowMs}`);
  await mkdir(path, { recursive: true });
  return path;
}

function normalizeMaxSpawns(value) {
  const number = Number(value || DEFAULT_MAX_SPAWNS_PER_POLL);
  if (!Number.isInteger(number)) return DEFAULT_MAX_SPAWNS_PER_POLL;
  return Math.min(Math.max(number, 1), 25);
}

function sanitizedWorktreeError(error) {
  const code = normalizeText(error?.code || error?.message).toLowerCase();
  if (code.includes('github_pr_fetch_failed')) return 'github_pr_fetch_failed';
  if (code.includes('origin_base_ref_missing')) return 'remote_default_branch_unresolved';
  if (code.includes('worktree_create_failed')) return 'worktree_create_failed';
  if (code.includes('not_directory')) return 'repo_not_directory';
  if (code.includes('git_command_failed')) return 'git_command_failed';
  return 'worktree_failed';
}

export function buildGithubAgentPrompt({
  repo = {},
  kind = 'pr',
  item = {},
  repoContext = {},
  workDir = '',
} = {}) {
  const label = kind === 'pr' ? 'pull request' : 'issue';
  const autoReview = (repo?.autoReviewEnabled ?? GITHUB_AGENT_DEFAULTS.autoReviewEnabled) === true;
  const lines = [
    'GitHub fleet agent task.',
    '',
    `- repo: ${normalizeText(repo.id || `${repo.owner}/${repo.repo}`)}`,
    `- itemKind: ${label}`,
    `- number: ${Number(item.number || 0)}`,
    `- title: ${normalizeText(item.title)}`,
    `- url: ${normalizeText(item.htmlUrl || item.html_url || item.url)}`,
    `- workDir: ${normalizeText(workDir)}`,
    `- autoReviewEnabled: ${autoReview ? 'true' : 'false'}`,
    repoContext?.worktreePath
      ? `- worktree: ${normalizeText(repoContext.worktreePath)}`
      : '- worktree: scratch/no configured checkout',
    repoContext?.repoPath ? `- sourceRepo: ${normalizeText(repoContext.repoPath)}` : '- sourceRepo: none',
    repoContext?.branch ? `- branch: ${normalizeText(repoContext.branch)}` : '- branch: none',
    repoContext?.baseRef ? `- baseRef: ${normalizeText(repoContext.baseRef)}` : '- baseRef: unknown',
    repoContext?.baseHead ? `- baseHead: ${normalizeText(repoContext.baseHead)}` : '- baseHead: unknown',
    repoContext?.sourceBranch ? `- sourceBranch: ${normalizeText(repoContext.sourceBranch)}` : '- sourceBranch: unknown',
    repoContext?.sourceHead ? `- sourceHead: ${normalizeText(repoContext.sourceHead)}` : '- sourceHead: unknown',
    repoContext?.fallbackReason ? `- fallbackReason: ${normalizeText(repoContext.fallbackReason)}` : '- fallbackReason: none',
    '',
    'Read and analyze first. Draft review notes and proposed fixes.',
  ];
  if (kind === 'pr') {
    lines.push(
      'Post exactly one GitHub pull-request review, with or without autoReviewEnabled. Do not post a separate PR comment.',
      'The review body must start with this fixed format (counts match findings; use the short reviewed PR head SHA):',
      'VERDICT: BLOCKING <n> | NON-BLOCKING <m> | sha <short head sha>',
      '- [B] <file:line> <one line>',
      '- [N] <file:line> <one line>',
      'Include one [B] or [N] line per finding, omit finding lines when there are none, then add optional detail.',
      autoReview
        ? 'autoReviewEnabled=true: you ARE authorized to post a GitHub pull-request review. Use REQUEST_CHANGES only when BLOCKING > 0; APPROVE only when BLOCKING = 0 and the change is clearly safe; otherwise COMMENT.'
        : 'autoReviewEnabled=false: use COMMENT only, regardless of findings. Never REQUEST_CHANGES or APPROVE.',
      'Add inline comments only for concrete line issues, as part of that single review.',
    );
  } else {
    lines.push('Post exactly one issue triage comment with suspected files, likely cause and proposed fix. No code pushed.');
  }
  lines.push(
    'Use the configured fleet GitHub token / gh auth available in this environment.',
    'Do not push commits, merge, force-push, change branches, change repo settings, or deploy. Do not mutate BusinessOS or other systems. The single review or triage comment is the only authorized mutation.',
    'MCP tools may be available in this workspace; use them for coordination, not for unapproved mutations.',
    'After posting, exit the session (end the agent process). Do not wait for replies or post again.',
  );
  return `${lines.join('\n')}\n`;
}

export const GITHUB_AGENT_DEFAULTS = Object.freeze({
  namespace: 'github_agent_repos',
  pollIntervalSec: 60,
  minPollIntervalSec: 15,
  maxPollIntervalSec: 3600,
  autoReviewEnabled: true,
  worktreeReapMinAgeSec: 300,
  maxSpawnsPerPoll: DEFAULT_MAX_SPAWNS_PER_POLL,
});
