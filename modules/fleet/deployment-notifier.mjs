import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { exec as defaultExec } from '../../lib/exec.mjs';
import { buildPostgresJsonStore } from '../ops/postgres-json-store.mjs';
import { legacyRootStatePath, runtimeStatePath } from '../ops/runtime-state.mjs';

const DEFAULT_STORE_FILE = runtimeStatePath('fleet_deployment_notifications.json');
const LEGACY_STORE_FILE = legacyRootStatePath('fleet_deployment_notifications.json');
const DEFAULT_NOTE_DIR = join(tmpdir(), 'dueno-release-notes');
const HASH_RE = /\b[0-9a-f]{7,40}\b/gi;
const INTERNAL_TOKEN_RE = /\b(?:BOS|DM)_[A-Z0-9_]+\b/g;
const FLAG_TOKEN_RE = /\b[A-Z]{2,}_[A-Z0-9_]+\b/g;

// A failed notify consumes the SHA. A later poll must not start another agent
// for the same build.

function normalizeText(value) {
  return String(value || '').trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeState(raw = {}) {
  return {
    version: 1,
    deployments: raw?.deployments && typeof raw.deployments === 'object' ? clone(raw.deployments) : {},
  };
}

function normalizeSha(value) {
  return normalizeText(value);
}

function deploymentKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function isExplicitEmptyNote(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return false;
  return !normalizeText(draft.summary) && !normalizeText(draft.body);
}

function extractAgentOutput(result = {}) {
  return normalizeText(
    result?.task?.output
    || result?.output
    || result?.content
    || result?.result?.task?.output
    || result?.result?.output
    || ''
  );
}

function parseJsonObject(text) {
  const raw = normalizeText(text);
  if (!raw) return null;
  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(unfenced);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function scrubOperatorText(value, { maxChars = 4000 } = {}) {
  return normalizeText(value)
    .replace(HASH_RE, '')
    .replace(INTERNAL_TOKEN_RE, '')
    .replace(FLAG_TOKEN_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars)
    .trim();
}

export function sanitizeReleaseNoteDraft(draft) {
  // Default params only cover `undefined`, not `null` — and a failed agent
  // parse yields `null`. Guard explicitly so a missing note skips cleanly
  // instead of throwing on `draft.title`.
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null;
  const title = scrubOperatorText(draft.title || 'What\'s new', { maxChars: 120 }) || 'What\'s new';
  const summary = scrubOperatorText(draft.summary || '', { maxChars: 600 });
  const body = scrubOperatorText(draft.body || '', { maxChars: 4000 });
  if (summary.length < 20) return null;
  return {
    title,
    summary,
    body: body || null,
  };
}

export function buildReleaseNotePrompt({ repoPath, previousBuildSha, newBuildSha, noteFilePath } = {}) {
  const range = `${previousBuildSha}..${newBuildSha}`;
  return [
    'BusinessOS deployment patch-note request.',
    '',
    'Task:',
    `1. Run: git -C ${JSON.stringify(repoPath)} log ${range} --no-merges --pretty=format:%s%n%b%n---END-COMMIT---`,
    '2. Summarize the operator-visible changes in plain business language.',
    '3. Produce compact JSON with this exact shape:',
    '{"title":"What\'s new","summary":"One short paragraph for operators.","body":"- Optional short bullet\\n- Optional short bullet"}',
    `4. Write ONLY that JSON object to this exact file path using your file-writing tool: ${noteFilePath}`,
    '   - The file must contain exactly the JSON object and nothing else: no markdown, no code fences, no commentary.',
    '   - The file is the only deliverable that is read; terminal output is ignored. Write the file as your final action.',
    '',
    'Rules:',
    '- Do not include commit hashes, branch names, build ids, env var names, feature flag names, provider internals, or engineering jargon.',
    '- Write for the person running the business dashboard, not for developers.',
    '- Keep it short. Prefer 2-4 bullets in body when there are multiple changes.',
    '- If no operator-facing change is present, write {"title":"What\'s new","summary":"","body":""} to the file.',
  ].join('\n');
}

// Capture is file-based: the agent writes the JSON to a known path, so we never
// scrape its (TUI) terminal output. extractAgentOutput remains a best-effort
// fallback for harnesses that do surface clean stdout.
async function readNoteFromFile(noteFilePath) {
  try {
    const raw = await readFile(noteFilePath, 'utf8');
    return parseJsonObject(raw);
  } catch {
    return null;
  }
}

async function gitLogRange({ repoPath, previousBuildSha, newBuildSha, execImpl, timeoutMs }) {
  const result = await execImpl('git', [
    '-C',
    repoPath,
    'log',
    `${previousBuildSha}..${newBuildSha}`,
    '--no-merges',
    '--pretty=format:%s%n%b%n---END-COMMIT---',
  ], { timeout: timeoutMs });
  if (Number(result?.code || 0) !== 0) return null;
  const stdout = normalizeText(result?.stdout || '');
  return stdout ? stdout : null;
}

async function postReleaseNote({
  deployment,
  note,
  buildSha,
  fetchImpl,
  webhookPath = '/api/webhooks/release-notes',
  timeoutMs = 10_000,
}) {
  const baseUrl = normalizeText(deployment?.baseUrl).replace(/\/+$/g, '');
  const token = normalizeText(deployment?.token);
  if (!baseUrl || !token) return { posted: false, reason: 'missing_target_or_token' };
  const path = `/${normalizeText(webhookPath || '/api/webhooks/release-notes').replace(/^\/+/g, '')}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        release_note_id: buildSha,
        idempotency_key: buildSha,
        title: note.title,
        summary: note.summary,
        body: note.body,
        build_sha: buildSha,
      }),
      signal: controller.signal,
    });
    if (!response || typeof response.status !== 'number') {
      return { posted: false, reason: 'malformed_response' };
    }
    if (!response.ok) {
      return { posted: false, reason: `http_${response.status}` };
    }
    return { posted: true, status: response.status };
  } finally {
    clearTimeout(timer);
  }
}

export function buildFleetDeploymentNotifier({
  enabled = false,
  stateStore,
  storeFile = DEFAULT_STORE_FILE,
  namespace = 'fleet_deployment_notifications',
  env = process.env,
  modeEnvKey = 'APP_STATE_STORAGE',
  fetchImpl = globalThis.fetch,
  agentTaskRunner,
  execImpl = defaultExec,
  log = console,
  now = () => Date.now(),
  repoPath = '',
  webhookPath = '/api/webhooks/release-notes',
  provider = 'codex',
  model = '',
  thinkingLevel = '',
  agentTimeoutMs = 600_000,
  gitTimeoutMs = 30_000,
  noteDir = DEFAULT_NOTE_DIR,
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
  let state = normalizeState(backingStore.loadSync?.() || {});
  const inFlight = new Map();

  async function load() {
    if (loaded) return;
    if (!loadingPromise) {
      loadingPromise = (async () => {
        const raw = await backingStore.load().catch(() => null);
        if (raw && typeof raw === 'object') state = normalizeState(raw);
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

  async function observeDeploymentBuildOnce({ deployment = {}, snapshot = {} } = {}) {
    await load();
    const deploymentId = deploymentKey(snapshot.deploymentId || deployment.deploymentId);
    const newBuildSha = normalizeSha(snapshot.buildSha || snapshot.build_sha);
    if (!deploymentId || !newBuildSha) return { action: 'skipped', reason: 'missing_build_sha' };

    const previous = state.deployments[deploymentId] || {};
    const previousBuildSha = normalizeSha(previous.lastNotificationCheckpointBuildSha || previous.lastNotifiedBuildSha || previous.lastBuildSha);
    state.deployments[deploymentId] = {
      ...previous,
      lastObservedBuildSha: newBuildSha,
      lastObservedAtMs: now(),
    };
    await save();

    if (!previousBuildSha) {
      state.deployments[deploymentId] = {
        ...state.deployments[deploymentId],
        lastBuildSha: newBuildSha,
        lastNotificationCheckpointBuildSha: newBuildSha,
      };
      await save();
      return { action: 'recorded_first_observation', buildSha: newBuildSha };
    }
    if (previousBuildSha === newBuildSha) {
      state.deployments[deploymentId] = {
        ...state.deployments[deploymentId],
        lastBuildSha: newBuildSha,
        lastNotificationCheckpointBuildSha: newBuildSha,
      };
      await save();
      return { action: 'unchanged', buildSha: newBuildSha };
    }
    if (!enabled) {
      state.deployments[deploymentId] = {
        ...state.deployments[deploymentId],
        lastBuildSha: newBuildSha,
        lastNotificationCheckpointBuildSha: newBuildSha,
      };
      await save();
      return { action: 'recorded_transition_notify_disabled', previousBuildSha, buildSha: newBuildSha };
    }
    if (typeof agentTaskRunner !== 'function') return { action: 'skipped', reason: 'agent_runner_missing' };
    if (typeof fetchImpl !== 'function') return { action: 'skipped', reason: 'fetch_unavailable' };
    if (!normalizeText(repoPath)) return { action: 'skipped', reason: 'DM_FLEET_DEPLOYMENT_NOTIFY_BUSINESSOS_REPO_PATH_missing' };

    const acceptTransition = async (reason, extra = {}) => {
      const { failedNotify: _clearedFailure, ...kept } = state.deployments[deploymentId] || {};
      state.deployments[deploymentId] = {
        ...kept,
        lastBuildSha: newBuildSha,
        lastNotificationCheckpointBuildSha: newBuildSha,
        ...extra,
      };
      await save();
      return { action: 'skipped', reason, buildSha: newBuildSha };
    };
    const recordFailure = async (reason) => {
      await acceptTransition('notify_failed', {
        lastFailedNotify: {
          buildSha: newBuildSha,
          attempts: 1,
          lastAttemptAtMs: now(),
          reason,
        },
      });
      return { action: 'notify_failed', reason, attempts: 1 };
    };

    const preflight = await gitLogRange({
      repoPath,
      previousBuildSha,
      newBuildSha,
      execImpl,
      timeoutMs: gitTimeoutMs,
    }).catch((error) => {
      log.warn?.({
        deploymentId,
        code: normalizeText(error?.code || error?.message || 'git_log_failed') || 'git_log_failed',
      }, 'Fleet release note git preflight failed');
      return null;
    });
    if (!preflight) {
      log.warn?.({ deploymentId }, 'Fleet release note skipped: commit range unavailable or empty');
      return { action: 'skipped', reason: 'empty_or_missing_commit_range' };
    }

    // File handoff: the agent writes the JSON note to a known path and we read
    // the file, rather than scraping its (TUI) terminal output. A stale file is
    // cleared first; extractAgentOutput stays as a best-effort stdout fallback.
    const noteFilePath = join(noteDir, `${deploymentId}-${newBuildSha}.json`);
    let note = null;
    try {
      await mkdir(noteDir, { recursive: true });
      await rm(noteFilePath, { force: true });
      const prompt = buildReleaseNotePrompt({ repoPath, previousBuildSha, newBuildSha, noteFilePath });
      const agentResult = await agentTaskRunner({
        provider,
        prompt,
        workDir: repoPath,
        displayName: `Release notes ${deploymentId}`,
        model: normalizeText(model) || undefined,
        thinkingLevel: normalizeText(thinkingLevel) || undefined,
        timeoutMs: agentTimeoutMs,
      });
      const draft = (await readNoteFromFile(noteFilePath)) || parseJsonObject(extractAgentOutput(agentResult));
      if (isExplicitEmptyNote(draft)) return acceptTransition('no_operator_facing_change');
      note = sanitizeReleaseNoteDraft(draft);
    } catch (error) {
      log.warn?.({
        deploymentId,
        code: normalizeText(error?.code || error?.message || 'agent_task_failed') || 'agent_task_failed',
      }, 'Fleet release note agent run failed');
      // The agent may have written the file before a harness-level error.
      const recovered = await readNoteFromFile(noteFilePath);
      if (isExplicitEmptyNote(recovered)) return acceptTransition('no_operator_facing_change');
      note = sanitizeReleaseNoteDraft(recovered);
    } finally {
      await rm(noteFilePath, { force: true }).catch(() => {});
    }
    if (!note) return recordFailure('empty_or_invalid_agent_note');

    const posted = await postReleaseNote({
      deployment,
      note,
      buildSha: newBuildSha,
      fetchImpl,
      webhookPath,
    });
    if (!posted.posted) {
      log.warn?.({ deploymentId, reason: posted.reason }, 'Fleet release note post failed');
      return recordFailure(posted.reason);
    }
    const { failedNotify: _clearedFailure, lastFailedNotify: _clearedLastFailure, ...kept } = state.deployments[deploymentId] || {};
    state.deployments[deploymentId] = {
      ...kept,
      lastBuildSha: newBuildSha,
      lastNotificationCheckpointBuildSha: newBuildSha,
      lastNotifiedBuildSha: newBuildSha,
      lastNotifiedAtMs: now(),
    };
    await save();
    return { action: 'posted', buildSha: newBuildSha, status: posted.status };
  }

  async function observeDeploymentBuild({ deployment = {}, snapshot = {} } = {}) {
    const deploymentId = deploymentKey(snapshot.deploymentId || deployment.deploymentId);
    const newBuildSha = normalizeSha(snapshot.buildSha || snapshot.build_sha);
    const inFlightKey = `${deploymentId}:${newBuildSha}`;
    if (enabled && deploymentId && newBuildSha) {
      const existing = inFlight.get(inFlightKey);
      if (existing) return existing;
      const next = observeDeploymentBuildOnce({ deployment, snapshot }).finally(() => {
        inFlight.delete(inFlightKey);
      });
      inFlight.set(inFlightKey, next);
      return next;
    }
    return observeDeploymentBuildOnce({ deployment, snapshot });
  }

  async function close() {
    await saveQueue.catch(() => {});
    if (typeof backingStore.close === 'function') await backingStore.close();
  }

  return {
    observeDeploymentBuild,
    close,
  };
}
