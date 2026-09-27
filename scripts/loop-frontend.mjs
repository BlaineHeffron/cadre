#!/usr/bin/env node
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.mjs';
import { readEnv } from '../modules/platform/cadre-env.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(REPO_ROOT);

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_CYCLES = 16;
const DEFAULT_GIT_POLL_MS = 30 * 1000;

const FRONTEND_GUARDRAILS = [
  'Guardrails: check git status before edits; never revert user work.',
  'Strict boundary: The frontend crate must ONLY import from dm-contracts. ZERO imports from the dm-app backend crate.',
  'Auth constraint: ZERO token handling or JWT parsing in frontend. Auth is strictly HttpOnly cookies handled by Axum.',
  'State mechanics: Use Leptos provide_context for global UI state and create_resource mapped to real /api/ endpoints. No deep prop-drilling.',
  'Theme constraint: Read CSS variables via var(--dm-*). Do NOT write FOUC mechanics or token injection logic in Leptos; Axum handles injection.',
  'Testing contract: Add explicitly typed data-testid attributes and ARIA states (e.g., aria-disabled, aria-busy) to all interactive elements for Playwright.',
  'Reliability: No production unwrap/expect/panic. Handle errors via Result and Leptos ErrorBoundary.',
  'Gates: Run just fmt, just lint, just test. Finally, boot the server and run Playwright. Fix any Playwright trace failures before marking complete.',
].join(' ');

const DEFAULT_MESSAGES = Object.freeze([
  `Read frontend-migration-ledger.md. Spawn a worker session to implement the next incomplete UI task. Pass the worker the spec, the specific task, and enforce these rules: ${FRONTEND_GUARDRAILS}`,
  `Spawn a review session to verify the last worker's diff against the architectural constraints. If approved, execute the Playwright test suite against the real local server. If tests pass: commit, check off the ledger task, and push. If tests fail: spawn a worker to fix the UI based on the Playwright logs. ${FRONTEND_GUARDRAILS}`,
]);

function usage() {
  return [
    'Usage: node scripts/loop-session-prompts.mjs <session-id> [options]',
    '',
    'Options:',
    '  --cycles <n>            Number of A/B cycles. Default: 16',
    '  --interval-ms <ms>      Delay between sends. Default: 900000',
    '  --interval-minutes <n>  Delay between sends in minutes. Default: 15',
    '  --initial-delay-ms <ms> Delay before first send. Default: 0',
    '  --initial-delay-minutes <n> Delay before first send in minutes',
    '  --kind <codex|claude|pi> Skip auto-detect and use this session kind',
    '  --base-url <url>        Monitor base URL. Default from config/env',
    '  --message <text>        Override prompt list. Repeat for multiple steps',
    '  --messages-file <path>  Override prompt list from JSON array or non-empty lines',
    '  --watch-dir <path>      Override git dir to watch. Default: session workDir',
    '  --no-watch-git          Disable git short-circuit polling',
    '  --git-poll-ms <ms>      Git poll cadence. Default: 30000',
    '  --dry-run               Print send plan without sending',
    '',
    'Env:',
    '  LOOP_SESSION_PROMPTS_MESSAGES JSON array or newline-delimited prompt override',
  ].join('\n');
}

function parseArgs(argv) {
  const args = [...argv];
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(usage());
    process.exit(0);
  }
  const sessionId = args.shift();
  const opts = {
    sessionId,
    cycles: DEFAULT_CYCLES,
    intervalMs: DEFAULT_INTERVAL_MS,
    initialDelayMs: 0,
    kind: '',
    baseUrl: '',
    messages: [],
    messagesFile: '',
    watchDir: '',
    watchGit: true,
    gitPollMs: DEFAULT_GIT_POLL_MS,
    dryRun: false,
  };

  while (args.length > 0) {
    const flag = args.shift();
    const value = args[0];
    if (flag === '--cycles') opts.cycles = Number(args.shift());
    else if (flag === '--interval-ms') opts.intervalMs = Number(args.shift());
    else if (flag === '--interval-minutes') opts.intervalMs = Number(args.shift()) * 60 * 1000;
    else if (flag === '--initial-delay-ms') opts.initialDelayMs = Number(args.shift());
    else if (flag === '--initial-delay-minutes') opts.initialDelayMs = Number(args.shift()) * 60 * 1000;
    else if (flag === '--kind') opts.kind = String(args.shift() || '').trim().toLowerCase();
    else if (flag === '--base-url') opts.baseUrl = String(args.shift() || '').trim();
    else if (flag === '--message') {
      if (args.length === 0) throw new Error('--message requires a value');
      opts.messages.push(String(args.shift()).trim());
    } else if (flag === '--messages-file') {
      if (args.length === 0) throw new Error('--messages-file requires a value');
      opts.messagesFile = String(args.shift()).trim();
    }
    else if (flag === '--watch-dir') opts.watchDir = String(args.shift() || '').trim();
    else if (flag === '--no-watch-git') opts.watchGit = false;
    else if (flag === '--git-poll-ms') opts.gitPollMs = Number(args.shift());
    else if (flag === '--dry-run') opts.dryRun = true;
    else if (flag === '--help' || flag === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${flag}${value ? ` ${value}` : ''}`);
    }
  }

  if (!opts.sessionId) throw new Error('session-id is required');
  if (!Number.isInteger(opts.cycles) || opts.cycles < 1) throw new Error('--cycles must be a positive integer');
  if (!Number.isFinite(opts.intervalMs) || opts.intervalMs < 0) throw new Error('--interval must be a non-negative number');
  if (!Number.isFinite(opts.initialDelayMs) || opts.initialDelayMs < 0) throw new Error('--initial-delay must be a non-negative number');
  if (opts.kind && !['codex', 'claude', 'pi'].includes(opts.kind)) throw new Error('--kind must be codex, claude, or pi');
  if (opts.messagesFile && opts.messages.length > 0) throw new Error('--message and --messages-file cannot be combined');
  if (!Number.isFinite(opts.gitPollMs) || opts.gitPollMs < 1000) throw new Error('--git-poll-ms must be >= 1000');
  return opts;
}

function parseMessageList(raw, source) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error(`${source} must be a JSON array or newline-delimited text`);
    return parsed.map((message) => String(message || '').trim()).filter(Boolean);
  }
  return trimmed.split(/\r?\n/).map((message) => message.trim()).filter(Boolean);
}

async function loadMessages(opts) {
  let messages = opts.messages.filter(Boolean);
  if (opts.messagesFile) {
    const raw = await readFile(resolve(opts.messagesFile), 'utf8');
    messages = parseMessageList(raw, '--messages-file');
  } else if (messages.length === 0 && process.env.LOOP_SESSION_PROMPTS_MESSAGES) {
    messages = parseMessageList(process.env.LOOP_SESSION_PROMPTS_MESSAGES, 'LOOP_SESSION_PROMPTS_MESSAGES');
  }
  if (messages.length === 0) messages = [...DEFAULT_MESSAGES];
  if (messages.length === 0) throw new Error('at least one message is required');
  return messages;
}

function defaultBaseUrl() {
  const protocol = config.tlsEnabled ? 'https' : 'http';
  return `${protocol}://${config.host}:${config.port}`;
}

async function requestJson(baseUrl, path, { method = 'GET', body = null } = {}) {
  const headers = {};
  if (config.auth.token) headers.authorization = `Bearer ${config.auth.token}`;
  if (body !== null) headers['content-type'] = 'application/json';

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === null ? undefined : JSON.stringify(body),
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const error = new Error(payload?.error || payload?.message || `HTTP ${res.status}`);
    error.statusCode = res.status;
    throw error;
  }

  return payload;
}

function sessionAliases(session) {
  const values = [
    session?.id,
    session?.sessionName,
    session?.name,
    session?.tmuxSession,
    session?.displayName,
  ].map((value) => String(value || '').trim()).filter(Boolean);

  for (const value of [...values]) {
    const stripped = value.replace(/^(codex|claude|pi)-/, '');
    if (stripped && stripped !== value) values.push(stripped);
  }

  return new Set(values);
}

async function findSessionRef(baseUrl, sessionId, requestedKind) {
  const kinds = requestedKind ? [requestedKind] : ['codex', 'claude', 'pi'];
  for (const kind of kinds) {
    try {
      const session = await requestJson(baseUrl, `/api/${kind}/sessions/${encodeURIComponent(sessionId)}?lines=1`);
      return { kind, sessionId: session?.id || sessionId };
    } catch (error) {
      if (error.statusCode && error.statusCode !== 404 && error.statusCode !== 400) throw error;
    }
  }

  for (const kind of kinds) {
    const data = await requestJson(baseUrl, `/api/${kind}/sessions?includeReadOnly=true`);
    const matches = (data?.sessions || []).filter((session) => sessionAliases(session).has(sessionId));
    if (matches.length === 1) return { kind, sessionId: matches[0].id };
    if (matches.length > 1) throw new Error(`Ambiguous ${kind} session reference: ${sessionId}`);
  }

  throw new Error(`Session not found in ${kinds.join(' or ')} sessions: ${sessionId}`);
}

async function sendMessage(baseUrl, kind, sessionId, text) {
  return requestJson(baseUrl, `/api/${kind}/sessions/${encodeURIComponent(sessionId)}/input`, {
    method: 'POST',
    body: { text, enter: true },
  });
}

function runGit(cwd, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: '', stderr: '' });
    });
  });
}

async function gitSnapshot(cwd) {
  const head = await runGit(cwd, ['rev-parse', 'HEAD']);
  if (head.code !== 0) return null;
  const upstream = await runGit(cwd, ['rev-parse', '@{u}']);
  return {
    head: head.stdout,
    upstream: upstream.code === 0 ? upstream.stdout : null,
  };
}

async function isGitRepo(cwd) {
  if (!cwd) return false;
  const r = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.stdout === 'true';
}

async function fetchSessionWorkDir(baseUrl, kind, sessionId) {
  try {
    const data = await requestJson(baseUrl, `/api/${kind}/sessions/${encodeURIComponent(sessionId)}?lines=1`);
    return data?.workDir || data?.session?.workDir || '';
  } catch {
    return '';
  }
}

async function watchedSleep(intervalMs, watchCfg) {
  if (!watchCfg?.dir) {
    await sleep(intervalMs);
    return { shortCircuited: false };
  }
  const baseline = await gitSnapshot(watchCfg.dir);
  if (!baseline) {
    await sleep(intervalMs);
    return { shortCircuited: false };
  }
  const deadline = Date.now() + intervalMs;
  const pollMs = Math.min(watchCfg.pollMs, intervalMs);
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    await sleep(Math.min(pollMs, remaining));
    const snap = await gitSnapshot(watchCfg.dir);
    if (!snap) continue;
    if (snap.head !== baseline.head) return { shortCircuited: true, reason: 'commit', from: baseline.head, to: snap.head };
    if (baseline.upstream !== null && snap.upstream !== null && snap.upstream !== baseline.upstream) {
      return { shortCircuited: true, reason: 'push', from: baseline.upstream, to: snap.upstream };
    }
  }
  return { shortCircuited: false };
}

function log(event, data = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...data,
  }));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const messages = await loadMessages(opts);
  const baseUrl = opts.baseUrl || readEnv('DUENO_MONITOR_BASE_URL') || defaultBaseUrl();
  const sessionRef = await findSessionRef(baseUrl, opts.sessionId, opts.kind);
  const { kind, sessionId } = sessionRef;

  let watchCfg = null;
  if (opts.watchGit) {
    let dir = opts.watchDir;
    if (!dir) dir = await fetchSessionWorkDir(baseUrl, kind, sessionId);
    if (dir && (await isGitRepo(dir))) {
      watchCfg = { dir, pollMs: opts.gitPollMs };
    } else if (dir) {
      log('git_watch_skipped', { reason: 'not_a_git_repo', dir });
    } else {
      log('git_watch_skipped', { reason: 'no_workdir' });
    }
  }

  log('started', {
    sessionId,
    requestedSessionId: opts.sessionId,
    kind,
    baseUrl,
    cycles: opts.cycles,
    intervalMs: opts.intervalMs,
    initialDelayMs: opts.initialDelayMs,
    messageCount: messages.length,
    watchDir: watchCfg?.dir || null,
    gitPollMs: watchCfg?.pollMs || null,
    dryRun: opts.dryRun,
  });

  if (opts.initialDelayMs > 0) {
    log('initial_sleep', { intervalMs: opts.initialDelayMs });
    await sleep(opts.initialDelayMs);
  }

  for (let cycle = 1; cycle <= opts.cycles; cycle += 1) {
    for (let index = 0; index < messages.length; index += 1) {
      const text = messages[index];
      log(opts.dryRun ? 'dry_send' : 'send', { cycle, step: index + 1, text });
      if (!opts.dryRun) await sendMessage(baseUrl, kind, sessionId, text);

      const isLastSend = cycle === opts.cycles && index === messages.length - 1;
      if (!isLastSend) {
        log('sleep', { cycle, step: index + 1, intervalMs: opts.intervalMs, watching: Boolean(watchCfg) });
        const result = await watchedSleep(opts.intervalMs, watchCfg);
        if (result.shortCircuited) {
          log('short_circuit', { cycle, step: index + 1, reason: result.reason, from: result.from, to: result.to });
        }
      }
    }
  }

  log('finished', { sessionId, requestedSessionId: opts.sessionId, kind, cycles: opts.cycles });
}

main().catch((error) => {
  log('failed', { error: error.message, statusCode: error.statusCode || null });
  process.exitCode = 1;
});
