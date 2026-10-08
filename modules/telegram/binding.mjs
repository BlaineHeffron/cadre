import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readHookSessionMetadata as defaultReadHookSessionMetadata } from '../agent/hook-state.mjs';
import { duenoOriginator } from '../agent/launch-env.mjs';

const DEFAULT_STATE_DIR = join(homedir(), '.claude/telegram');
const DEFAULT_CLAUDE_PROJECTS_DIR = join(homedir(), '.claude/projects');
const DEFAULT_CODEX_SESSIONS_DIR = join(homedir(), '.codex/sessions');
const DEFAULT_PI_AGENT_DIR = join(homedir(), '.pi/agent');
const DEFAULT_SCAN_LIMIT = 200;

/** A rollout's `session_meta` is its first line; this bounds how much of it we read. */
const SESSION_META_READ_BYTES = 256 * 1024;

/**
 * Anchors that prove a transcript belongs to a session. Ordered by strength.
 * A binding carrying any of these may be reused without re-proving it.
 * Anything else (notably `legacy`) is unproven and must be re-anchored.
 */
export const PROVEN_ANCHORS = Object.freeze([
  'cli_session_id',
  'originator',
  'hook',
  'env',
  'identity',
  'sole_tenant',
]);

/**
 * A live transcript may have been created slightly before the registry recorded the
 * session. Used only to *exclude* impossible candidates, never to rank them.
 */
const CREATED_CLOCK_SLACK_MS = 60_000;

function text(value = '') {
  return String(value ?? '').trim();
}

function normalizeRuntime(session = {}) {
  return text(session.runtime || session.backend || session.provider).toLowerCase();
}

function normalizeEpochMs(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 1_000_000_000_000 ? number * 1000 : number;
}

function escapeRegExp(value = '') {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, data) {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmp, filePath);
}

async function statOrNull(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

/**
 * Claude stores a project's transcripts under a sanitized cwd name.
 * Non-alphanumeric characters, including `/` and `.`, become `-`.
 * Slash-only encoding is kept as a fallback for older local dirs.
 */
export function claudeProjectDirName(workDir = '') {
  const normalized = text(workDir);
  if (!normalized) return '';
  return resolve(normalized).replace(/[^A-Za-z0-9]/g, '-');
}

export function claudeProjectDirNames(workDir = '') {
  const names = [];
  const canonical = claudeProjectDirName(workDir);
  if (canonical) names.push(canonical);
  const legacy = text(workDir).replace(/\//g, '-');
  if (legacy && !names.includes(legacy)) names.push(legacy);
  return names;
}

export function piProjectDirName(workDir = '') {
  const resolved = resolve(workDir);
  return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

export function piTranscriptDir(agentDir, workDir) {
  return join(agentDir, 'sessions', piProjectDirName(workDir));
}

/** Path claude writes when launched with `--session-id <cliSessionId>`. */
export function claudeTranscriptPath(projectsDir, workDir, cliSessionId) {
  const fileName = `${text(cliSessionId)}.jsonl`;
  const names = claudeProjectDirNames(workDir);
  const fallback = names[0] || claudeProjectDirName(workDir);
  for (const name of names) {
    const candidate = join(projectsDir, name, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return join(projectsDir, fallback, fileName);
}

/**
 * Transcripts are JSONL, so the bootstrap prompt's newlines are stored as the two-character
 * escape `\n`. A `\b` before `Your` would therefore have to match between the `n` of that
 * escape and `Y` — two word characters, no boundary — and never fires. Anchor only on the
 * trailing session id, so `77e575cd` cannot match `77e575cde`.
 */
export function hasExactBusIdentity(content = '', kind = '', sessionId = '') {
  const normalizedKind = text(kind).toLowerCase();
  const normalizedSessionId = text(sessionId);
  if (!normalizedKind || !normalizedSessionId) return false;
  const pattern = new RegExp(
    `Your identity:\\s*${escapeRegExp(normalizedKind)}:${escapeRegExp(normalizedSessionId)}\\b`,
    'i',
  );
  return pattern.test(String(content ?? ''));
}

function messageContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && typeof block === 'object')
    .map((block) => text(block.text || block.content))
    .filter(Boolean)
    .join('\n');
}

/**
 * Identity text is proof only when the transcript records it as input to that
 * session. A raw full-file substring is unsafe: manager tool calls and results
 * quote child bootstrap prompts, including their `Your identity:` line.
 */
function hasUserMessageBusIdentity(content = '', kind = '', sessionId = '') {
  for (const line of String(content ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const directMessage = record?.message && typeof record.message === 'object'
      ? record.message
      : null;
    const responseMessage = record?.type === 'response_item'
      && record?.payload?.type === 'message'
      ? record.payload
      : null;
    const eventMessage = record?.type === 'event_msg'
      && record?.payload?.type === 'user_message'
      ? record.payload
      : null;
    const message = directMessage || responseMessage || eventMessage;
    if (!message) continue;
    const role = text(message.role || (eventMessage ? 'user' : ''));
    if (role !== 'user') continue;
    const body = messageContentText(message.content ?? message.message);
    if (hasExactBusIdentity(body, kind, sessionId)) return true;
  }
  return false;
}

export function rolloutMatchesDuenoSession(content = '', sessionId = '') {
  const needle = text(sessionId);
  if (!needle) return false;
  return content.includes(`DUENO_SESSION_ID='${needle}'`)
    || content.includes(`DUENO_SESSION_ID="${needle}"`)
    || content.includes(`DUENO_SESSION_ID=${needle}`)
    || content.includes(`"DUENO_SESSION_ID":"${needle}"`);
}

/**
 * Read just the rollout's first line. `session_meta` carries the full base instructions, so it
 * is large, but bounded — and reading it beats reading the whole conversation to find the cwd.
 */
async function readSessionMeta(filePath) {
  let handle = null;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(SESSION_META_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SESSION_META_READ_BYTES, 0);
    const chunk = buffer.subarray(0, bytesRead).toString('utf8');
    const newlineIndex = chunk.indexOf('\n');
    const line = newlineIndex >= 0 ? chunk.slice(0, newlineIndex) : chunk;
    const record = JSON.parse(line);
    if (record?.type !== 'session_meta') return null;
    const payload = record?.payload && typeof record.payload === 'object' ? record.payload : {};
    return {
      cwd: text(payload.cwd),
      sessionId: text(payload.session_id || payload.id),
      originator: text(payload.originator),
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function rolloutCwd(content = '') {
  for (const line of String(content ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== 'session_meta') continue;
    const payload = record?.payload && typeof record.payload === 'object' ? record.payload : {};
    return { cwd: text(payload.cwd), sessionId: text(payload.session_id || payload.id) };
  }
  return { cwd: '', sessionId: '' };
}

async function listClaudeTranscripts(projectsDir, workDir) {
  const seen = new Set();
  const files = [];
  for (const name of claudeProjectDirNames(workDir)) {
    const dir = join(projectsDir, name);
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const filePath = join(dir, entry.name);
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      const fileStat = await statOrNull(filePath);
      if (fileStat) files.push({ filePath, mtimeMs: fileStat.mtimeMs, ino: fileStat.ino });
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

async function collectRolloutFiles(dir, files = []) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectRolloutFiles(entryPath, files);
    } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
      const fileStat = await statOrNull(entryPath);
      if (fileStat) files.push({ filePath: entryPath, mtimeMs: fileStat.mtimeMs, ino: fileStat.ino });
    }
  }
  return files;
}

/**
 * Rollouts live in one flat archive of every codex session ever run (thousands of files),
 * so a bare newest-N scan silently drops live sessions whose rollout is not in the newest N.
 * Filter first on "this file cannot belong to this session because it stopped being written
 * before the session started" — a correctness filter, never a ranking — then cap.
 */
async function listCodexRollouts(sessionsDir, scanLimit, minMtimeMs = 0) {
  const files = await collectRolloutFiles(sessionsDir);
  const eligible = files.filter((file) => file.mtimeMs >= minMtimeMs);
  eligible.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const limit = Math.max(Number(scanLimit) || 0, 0);
  return limit ? eligible.slice(0, limit) : eligible;
}

function createdFloorMs(session = {}) {
  const createdMs = normalizeEpochMs(session.created);
  return createdMs ? createdMs - CREATED_CLOCK_SLACK_MS : 0;
}

function bound(path, anchor, { cliSessionId = '', ino = 0 } = {}) {
  return { path, anchor, cliSessionId, ino };
}

function refused(reason) {
  return { path: null, anchor: '', reason };
}

// --- resolvers. Each proves the path it returns, or returns null. ---

/**
 * Claude is launched with `--session-id`, so the registry already knows the exact transcript
 * filename. Nothing to search.
 */
async function resolveCliSessionId(session, deps) {
  const runtime = normalizeRuntime(session);
  const cliSessionId = text(session.cliSessionId);
  if (!cliSessionId) return null;
  if (runtime === 'claude') {
    const path = claudeTranscriptPath(deps.projectsDir, session.workDir, cliSessionId);
    const fileStat = await statOrNull(path);
    if (!fileStat) return null;
    return bound(path, 'cli_session_id', { cliSessionId, ino: fileStat.ino });
  }
  if (runtime !== 'pi' || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(cliSessionId)) return null;

  const dir = deps.piSessionsDir || piTranscriptDir(deps.piAgentDir, session.workDir);
  const suffix = `_${cliSessionId}.jsonl`;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const matches = entries.filter((entry) => entry.isFile() && entry.name.endsWith(suffix));
  if (matches.length !== 1) return null;
  const path = join(dir, matches[0].name);
  const fileStat = await statOrNull(path);
  if (!fileStat) return null;
  const header = await readPiSessionHeader(path);
  if (header?.id !== cliSessionId || resolve(header.cwd) !== resolve(session.workDir)) return null;
  return bound(path, 'cli_session_id', { cliSessionId, ino: fileStat.ino });
}

async function readPiSessionHeader(filePath) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(SESSION_META_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/, 1)[0];
    const record = JSON.parse(line);
    if (record?.type !== 'session') return null;
    return { id: text(record.id), cwd: text(record.cwd) };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Codex cannot be told its rollout uuid, but it stamps our `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`
 * into `session_meta.originator`. That is a launch-time identity, and it lives on line 1.
 */
async function resolveOriginator(session, deps) {
  if (normalizeRuntime(session) !== 'codex') return null;
  const originator = duenoOriginator(session.id);
  if (!originator) return null;
  for (const file of await listCodexRollouts(deps.codexSessionsDir, deps.scanLimit, createdFloorMs(session))) {
    const meta = await readSessionMeta(file.filePath);
    if (!meta || meta.originator !== originator) continue;
    if (meta.cwd !== session.workDir) continue;
    return bound(file.filePath, 'originator', { cliSessionId: meta.sessionId, ino: file.ino });
  }
  return null;
}

async function resolveHook(session, deps) {
  const metadata = await deps.readHookSessionMetadata({
    workDir: session.workDir,
    provider: normalizeRuntime(session),
    sessionId: session.id,
  }).catch(() => null);
  // The state file is already keyed by Dueno session id, but we require the hook to
  // have written the id back explicitly. An implicit key match is not proof.
  if (text(metadata?.duenoSessionId) !== text(session.id)) return null;
  const path = text(metadata?.transcriptPath);
  if (!path) return null;
  const fileStat = await statOrNull(path);
  if (!fileStat) return null;
  return {
    ...bound(path, 'hook', { cliSessionId: text(metadata.cliSessionId), ino: fileStat.ino }),
    startOffset: Number(metadata.transcriptStartOffset) || 0,
  };
}

async function resolveEnv(session, deps) {
  if (normalizeRuntime(session) !== 'codex') return null;
  const expectedOriginator = duenoOriginator(session.id);
  for (const file of await listCodexRollouts(deps.codexSessionsDir, deps.scanLimit, createdFloorMs(session))) {
    const content = await readFile(file.filePath, 'utf8').catch(() => '');
    if (!content) continue;
    const meta = rolloutCwd(content);
    if (meta.cwd !== session.workDir) continue;
    const sessionMeta = await readSessionMeta(file.filePath);
    if (
      sessionMeta?.originator?.startsWith('dueno-')
      && sessionMeta.originator !== expectedOriginator
    ) {
      continue;
    }
    if (!rolloutMatchesDuenoSession(content, session.id)) continue;
    return bound(file.filePath, 'env', { cliSessionId: meta.sessionId, ino: file.ino });
  }
  return null;
}

async function resolveIdentity(session, deps) {
  const runtime = normalizeRuntime(session);
  if (runtime === 'claude') {
    for (const file of await listClaudeTranscripts(deps.projectsDir, session.workDir)) {
      const content = await readFile(file.filePath, 'utf8').catch(() => '');
      if (hasUserMessageBusIdentity(content, 'claude', session.id)) {
        return bound(file.filePath, 'identity', { cliSessionId: basename(file.filePath, '.jsonl'), ino: file.ino });
      }
    }
    return null;
  }
  if (runtime !== 'codex') return null;
  const expectedOriginator = duenoOriginator(session.id);
  for (const file of await listCodexRollouts(deps.codexSessionsDir, deps.scanLimit, createdFloorMs(session))) {
    const content = await readFile(file.filePath, 'utf8').catch(() => '');
    if (!content) continue;
    const meta = rolloutCwd(content);
    if (meta.cwd !== session.workDir) continue;
    const sessionMeta = await readSessionMeta(file.filePath);
    if (
      sessionMeta?.originator?.startsWith('dueno-')
      && sessionMeta.originator !== expectedOriginator
    ) {
      continue;
    }
    if (!hasUserMessageBusIdentity(content, 'codex', session.id)) continue;
    return bound(file.filePath, 'identity', { cliSessionId: meta.sessionId, ino: file.ino });
  }
  return null;
}

/**
 * Last resort, and only when this (runtime, workDir) pair has exactly one live session.
 * Candidates are *filtered* by "could not predate this session", never ranked by clock
 * distance: a live transcript's mtime is always ~now, so ranking by |mtime - created|
 * ranks by the session's own start time and hands co-located sessions each other's files.
 */
async function resolveSoleTenant(session, deps, liveTenantCount) {
  if (liveTenantCount !== 1) return null;
  const runtime = normalizeRuntime(session);
  const floorMs = createdFloorMs(session);

  if (runtime === 'claude') {
    const candidates = (await listClaudeTranscripts(deps.projectsDir, session.workDir))
      .filter((file) => file.mtimeMs >= floorMs);
    if (candidates.length !== 1) return null;
    const [file] = candidates;
    return bound(file.filePath, 'sole_tenant', { cliSessionId: basename(file.filePath, '.jsonl'), ino: file.ino });
  }
  if (runtime !== 'codex') return null;

  const candidates = [];
  const expectedOriginator = duenoOriginator(session.id);
  for (const file of await listCodexRollouts(deps.codexSessionsDir, deps.scanLimit, floorMs)) {
    const content = await readFile(file.filePath, 'utf8').catch(() => '');
    if (!content) continue;
    const meta = rolloutCwd(content);
    if (meta.cwd !== session.workDir) continue;
    const sessionMeta = await readSessionMeta(file.filePath);
    if (
      sessionMeta?.originator?.startsWith('dueno-')
      && sessionMeta.originator !== expectedOriginator
    ) {
      continue;
    }
    candidates.push({ ...file, cliSessionId: meta.sessionId });
    if (candidates.length > 1) return null;
  }
  if (candidates.length !== 1) return null;
  const [file] = candidates;
  return bound(file.filePath, 'sole_tenant', { cliSessionId: file.cliSessionId, ino: file.ino });
}

function normalizeDeps(deps = {}) {
  return {
    projectsDir: deps.projectsDir || DEFAULT_CLAUDE_PROJECTS_DIR,
    codexSessionsDir: deps.codexSessionsDir || DEFAULT_CODEX_SESSIONS_DIR,
    piAgentDir: deps.piAgentDir || process.env.PI_CODING_AGENT_DIR || DEFAULT_PI_AGENT_DIR,
    piSessionsDir: deps.piSessionsDir || process.env.PI_CODING_AGENT_SESSION_DIR || '',
    scanLimit: deps.scanLimit ?? DEFAULT_SCAN_LIMIT,
    readHookSessionMetadata: deps.readHookSessionMetadata || defaultReadHookSessionMetadata,
  };
}

/**
 * Reuse a persisted binding only when its anchor was proven and the exact file it was
 * proven against is still there. An inode change means the transcript was rotated or
 * replaced, so the proof no longer holds and we re-anchor from scratch.
 */
async function reusePrevious(previous, session) {
  const path = text(previous?.transcript_path);
  const anchor = text(previous?.anchor);
  if (!path || !PROVEN_ANCHORS.includes(anchor)) return null;
  const fileStat = await statOrNull(path);
  if (!fileStat) return null;
  if (previous.ino && Number(previous.ino) !== fileStat.ino) return null;
  const runtime = normalizeRuntime(session);
  if (runtime === 'codex' && ['env', 'identity', 'sole_tenant'].includes(anchor)) {
    const meta = await readSessionMeta(path);
    const expectedOriginator = duenoOriginator(session.id);
    if (meta?.originator?.startsWith('dueno-') && meta.originator !== expectedOriginator) {
      return null;
    }
  }
  if (anchor === 'identity') {
    const content = await readFile(path, 'utf8').catch(() => '');
    if (!hasUserMessageBusIdentity(content, runtime, session.id)) return null;
  }
  return { ...bound(path, anchor, { cliSessionId: text(previous.cli_session_id), ino: fileStat.ino }), reused: true };
}

/**
 * Resolve the transcript file a session is writing to.
 *
 * Returns `{ path, anchor, cliSessionId, ino }` on success, or `{ path: null, reason }`
 * when no anchor proves a file. Refusing is deliberate: emitting from an unproven
 * transcript cross-posts one agent's output into another's topic and poisons the
 * dedup line-hashes, which silently swallows the victim's real messages.
 *
 * `liveTenantCount` is how many live sessions share this session's (runtime, workDir).
 */
export async function resolveBinding(session = {}, { previous = null, liveTenantCount = 1, deps = {} } = {}) {
  const sessionId = text(session.id);
  const runtime = normalizeRuntime(session);
  if (!sessionId || !session.workDir || !['claude', 'codex', 'pi'].includes(runtime)) {
    return refused('unsupported_session');
  }
  const resolvedDeps = normalizeDeps(deps);

  // `/clear` moves a Claude session to a new transcript; the old file and the registry's
  // launch-time cliSessionId still name the old one, so the hook's live path wins.
  const hooked = runtime === 'claude' ? await resolveHook(session, resolvedDeps) : null;
  if (hooked && hooked.path !== text(previous?.transcript_path)) return hooked;

  const reused = await reusePrevious(previous, session);
  if (reused) return reused;

  const resolvers = [
    () => resolveCliSessionId(session, resolvedDeps),
    () => resolveOriginator(session, resolvedDeps),
    () => resolveHook(session, resolvedDeps),
    () => resolveEnv(session, resolvedDeps),
    () => resolveIdentity(session, resolvedDeps),
    () => resolveSoleTenant(session, resolvedDeps, liveTenantCount),
  ];
  for (const resolve of resolvers) {
    const result = await resolve();
    if (result) return result;
  }

  return refused(liveTenantCount > 1 ? 'ambiguous' : 'not_found');
}

/**
 * Persists transcript path, anchor and read offset as one record, so a rebind can never
 * carry a stale offset into a new file (or reset the offset of a file it kept).
 */
export function buildBindingStore({ stateDir = DEFAULT_STATE_DIR, now = () => Date.now() } = {}) {
  const filePath = join(stateDir, 'bindings.json');
  let data = {};
  const OBSERVATION_HEARTBEAT_MS = 60_000;

  async function persist() {
    await writeJsonAtomic(filePath, data);
  }

  return {
    filePath,
    async load() {
      data = await readJsonFile(filePath, {});
      return data;
    },
    get(sessionId) {
      return data[text(sessionId)] || null;
    },
    entries() {
      return Object.values(data);
    },
    /** Bind a session to a proven transcript. Restarts offset unless caller proves same-file continuity. */
    async bind(sessionId, {
      path,
      anchor,
      cliSessionId = '',
      ino = 0,
      runtime = '',
      workDir = '',
      offset = 0,
      session = null,
    }) {
      const key = text(sessionId);
      const existing = data[key] || {};
      const observed = session && typeof session === 'object' ? {
        relay_managed: true,
        tmux_session: text(session.tmuxSession || session.tmux_session),
        name: text(session.name || session.displayName),
        created: Number(session.created || 0),
        bus_thread_id: text(session.busThreadId || session.bus_thread_id),
        bus_thread_title: text(session.busThreadTitle || session.bus_thread_title),
        last_seen_at_ms: now(),
        orphaned_at_ms: 0,
      } : existing.relay_managed ? {
        relay_managed: true,
        tmux_session: existing.tmux_session || '',
        name: existing.name || '',
        created: Number(existing.created || 0),
        bus_thread_id: existing.bus_thread_id || '',
        bus_thread_title: existing.bus_thread_title || '',
        last_seen_at_ms: Number(existing.last_seen_at_ms || 0),
        orphaned_at_ms: Number(existing.orphaned_at_ms || 0),
      } : {};
      data[key] = {
        session_id: key,
        runtime,
        work_dir: workDir,
        transcript_path: path,
        cli_session_id: cliSessionId,
        anchor,
        ino,
        offset: Number(offset) || 0,
        bound_at_ms: now(),
        updated_at_ms: now(),
        ...observed,
      };
      await persist();
      return data[key];
    },
    /** Advance the offset of an existing binding; refuses to advance a different file. */
    async advance(sessionId, { path, offset }) {
      const key = text(sessionId);
      const entry = data[key];
      if (!entry || entry.transcript_path !== path) return null;
      data[key] = { ...entry, offset, updated_at_ms: now() };
      await persist();
      return data[key];
    },
    /**
     * Persist enough registry and route identity to drain a transcript briefly
     * after its session disappears. Heartbeats are intentionally sparse.
     */
    async observe(sessionId, session = {}) {
      const key = text(sessionId);
      const entry = data[key];
      if (!entry) return null;
      const observedAt = now();
      const metadata = {
        relay_managed: true,
        runtime: text(session.runtime || session.backend || entry.runtime),
        work_dir: text(session.workDir || session.cwd || entry.work_dir),
        tmux_session: text(session.tmuxSession || session.tmux_session || entry.tmux_session),
        name: text(session.name || session.displayName || entry.name),
        created: Number(session.created || entry.created || 0),
        bus_thread_id: text(session.busThreadId || session.bus_thread_id || entry.bus_thread_id),
        bus_thread_title: text(session.busThreadTitle || session.bus_thread_title || entry.bus_thread_title),
        orphaned_at_ms: 0,
      };
      const changed = Object.entries(metadata).some(([field, value]) => entry[field] !== value);
      const heartbeatDue = observedAt - Number(entry.last_seen_at_ms || 0) >= OBSERVATION_HEARTBEAT_MS;
      data[key] = { ...entry, ...metadata, last_seen_at_ms: observedAt };
      if (changed || heartbeatDue) await persist();
      return data[key];
    },
    async markMissing(sessionId) {
      const key = text(sessionId);
      const entry = data[key];
      if (!entry?.relay_managed) return null;
      if (Number(entry.orphaned_at_ms || 0) > 0) return entry;
      data[key] = { ...entry, orphaned_at_ms: now(), updated_at_ms: now() };
      await persist();
      return data[key];
    },
    /**
     * One-time import of the pre-refactor offsets file. Imported entries carry the
     * `legacy` anchor, which `resolveBinding` treats as unproven, so every session
     * re-anchors once before its next send.
     */
    async importLegacyOffsets(offsets = {}) {
      let imported = 0;
      for (const [sessionId, entry] of Object.entries(offsets || {})) {
        const key = text(sessionId);
        if (!key || data[key] || !text(entry?.transcript_path)) continue;
        data[key] = {
          session_id: key,
          runtime: '',
          work_dir: '',
          transcript_path: entry.transcript_path,
          cli_session_id: '',
          anchor: 'legacy',
          ino: 0,
          offset: Number(entry.offset) || 0,
          bound_at_ms: Number(entry.updated_at_ms) || now(),
          updated_at_ms: now(),
        };
        imported += 1;
      }
      if (imported) await persist();
      return imported;
    },
  };
}
