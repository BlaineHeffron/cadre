#!/usr/bin/env node
/**
 * Read-only verification of Telegram bus relay routing and transcript binding.
 *
 * Prints, for every live session, the forum topic it would route to and the transcript
 * it would read from, with the anchor that proves that transcript. Makes no Telegram API
 * calls, starts no loops, and writes nothing — safe to run against production state.
 *
 *   node scripts/telegram-route-dryrun.mjs [--root <dir>] [--json]
 */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildBusThreadIndex, busThreadParticipantKey } from '../modules/telegram/bus-threads.mjs';
import { resolveTopicRoute } from '../modules/telegram/routing.mjs';
import { buildBindingStore, resolveBinding } from '../modules/telegram/binding.mjs';
import { runtimeStatePath } from '../modules/ops/runtime-state.mjs';
import { exec } from '../lib/exec.mjs';

const TELEGRAM_STATE_DIR = join(homedir(), '.claude/telegram');
const STALE_BUS_STATE_MS = 60 * 60 * 1000;

/** Same order the relay resolves bus state in, so the dry run sees what the relay sees. */
function busStatePaths(root) {
  return [join(runtimeStatePath('agent_bus'), 'state.json'), join(root, '.agent_bus/state.json')];
}

function parseArgs(argv) {
  const args = { root: process.cwd(), json: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') args.root = argv[index + 1] || args.root;
    if (argv[index] === '--json') args.json = true;
  }
  return args;
}

async function readJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function liveTmuxSessions() {
  const { stdout, code } = await exec('tmux', ['list-panes', '-a', '-F', '#{session_name}']);
  if (code !== 0) return null;
  return new Set(String(stdout || '').split(/\r?\n/).filter(Boolean));
}

async function loadSessions(root) {
  const files = [
    { path: join(root, '.dueno/state/claude_sessions.json'), runtime: 'claude' },
    { path: join(root, '.dueno/state/codex_sessions.json'), runtime: 'codex' },
  ];
  const sessions = [];
  for (const file of files) {
    for (const entry of await readJson(file.path, [])) {
      if (!entry?.id || !entry.tmuxSession || !entry.workDir) continue;
      sessions.push({
        id: entry.id,
        runtime: entry.runtime || file.runtime,
        workDir: entry.workDir,
        tmuxSession: entry.tmuxSession,
        name: entry.displayName || entry.name || '',
        created: Number(entry.created || 0),
      });
    }
  }
  return sessions;
}

function tenantCounts(sessions) {
  const counts = new Map();
  for (const session of sessions) {
    const key = `${session.runtime}\0${session.workDir}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let busState = null;
  let busStatePath = '';
  for (const candidate of busStatePaths(args.root)) {
    const state = await readJson(candidate, null);
    if (!state || !Array.isArray(state.threads)) continue;
    busState = state;
    busStatePath = candidate;
    break;
  }
  if (!busState) throw new Error(`no agent bus state under ${args.root}`);
  const busStateAgeMs = Date.now() - (await stat(busStatePath)).mtimeMs;
  if (busStateAgeMs > STALE_BUS_STATE_MS) {
    process.stderr.write(
      `WARNING: bus state ${busStatePath} is ${Math.round(busStateAgeMs / 60000)} min old; `
      + 'thread routing computed from it may be wrong\n',
    );
  }
  const busIndex = buildBusThreadIndex(busState);

  const allSessions = await loadSessions(args.root);
  const activeTmux = await liveTmuxSessions();
  const sessions = activeTmux ? allSessions.filter((s) => activeTmux.has(s.tmuxSession)) : allSessions;
  const counts = tenantCounts(sessions);

  const bindingStore = buildBindingStore({ stateDir: TELEGRAM_STATE_DIR });
  await bindingStore.load();
  const topics = await readJson(join(TELEGRAM_STATE_DIR, 'topics.json'), {});

  const rows = [];
  for (const session of sessions) {
    const busThread = busIndex.get(busThreadParticipantKey(session.runtime, session.id)) || null;
    const route = resolveTopicRoute({ session, busThread });
    const binding = await resolveBinding(session, {
      previous: bindingStore.get(session.id),
      liveTenantCount: counts.get(`${session.runtime}\0${session.workDir}`) || 1,
    });
    rows.push({
      session: `${session.runtime}:${session.id}`,
      name: session.name,
      busThread: busThread ? `${busThread.id} (${busThread.title})` : null,
      topicKey: route.key,
      topicName: route.name,
      forumTopicId: topics[route.key]?.thread_id ?? null,
      transcript: binding.path,
      anchor: binding.anchor || null,
      refusedReason: binding.reason || null,
    });
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ busStatePath, busStateAgeMs, rows }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`bus state: ${busStatePath} (${Math.round(busStateAgeMs / 1000)}s old)\n\n`);

  for (const row of rows) {
    process.stdout.write([
      `${row.session}  ${row.name}`,
      `  bus thread : ${row.busThread || '(none)'}`,
      `  topic      : ${row.topicKey}  -> forum ${row.forumTopicId ?? '(uncreated)'}  "${row.topicName}"`,
      row.transcript
        ? `  transcript : ${row.transcript}  [anchor=${row.anchor}]`
        : `  transcript : REFUSED (${row.refusedReason})`,
      '',
    ].join('\n'));
  }

  const grouped = new Map();
  for (const row of rows) grouped.set(row.topicKey, [...(grouped.get(row.topicKey) || []), row.session]);
  for (const [key, members] of grouped) {
    if (members.length > 1) process.stdout.write(`shared topic ${key}: ${members.join(', ')}\n`);
  }

  const crossBound = new Map();
  for (const row of rows) {
    if (!row.transcript) continue;
    crossBound.set(row.transcript, [...(crossBound.get(row.transcript) || []), row.session]);
  }
  for (const [path, members] of crossBound) {
    if (members.length > 1) process.stderr.write(`CROSS-BOUND transcript ${path}: ${members.join(', ')}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
});
