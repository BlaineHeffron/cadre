import { readFile } from 'node:fs/promises';
import { buildHookSessionPaths, knownSessions } from '../agent/hook-events.mjs';
import { getProtocolSessionProvider } from './protocol-session-registry.mjs';

const FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd', 'turns', 'toolCalls', 'failedToolCalls', 'transcriptPath'];

export function foldJournalEvent(acc, event) {
  acc ||= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, lastCostUsd: 0, turns: 0, toolCalls: 0, failedToolCalls: 0 };
  const e = event.type === 'transport.event' && event.data?.disposition === 'applied' ? event.data.event || {} : {};
  if (event.type === 'turn.created') acc.turns += 1;
  else if (e.type === 'tool.call') acc.toolCalls += 1;
  else if (e.type === 'tool.update' && e.status === 'failed') acc.failedToolCalls += 1;
  // Claude repeats partial usage per stream event; only its result events (costUsd > 0) carry turn totals,
  // and their cost is cumulative per process. Codex reports per-request deltas without a cost.
  else if (e.type === 'usage' && e.costUsd !== 0) {
    acc.inputTokens += Number(e.inputTokens) || 0;
    acc.outputTokens += Number(e.outputTokens) || 0;
    acc.cacheReadTokens += Number(e.cacheReadTokens ?? e.cachedInputTokens) || 0;
    acc.cacheWriteTokens += Number(e.cacheWriteTokens ?? e.cacheWriteInputTokens) || 0;
    if (e.costUsd > 0) {
      acc.costUsd = (acc.costUsd || 0) + (e.costUsd >= acc.lastCostUsd ? e.costUsd - acc.lastCostUsd : e.costUsd);
      acc.lastCostUsd = e.costUsd;
    }
  }
  return acc;
}

// Tmux hook logs record PostToolUse only for successful calls, so a PreToolUse without one did not succeed.
export function rollupHookEvents(text) {
  const pre = new Set();
  const post = new Set();
  let turns = 0;
  let transcriptPath = null;
  for (const line of text.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const id = event.payload?.tool_use_id;
    if (event.eventName === 'PreToolUse' && id) pre.add(id);
    else if (event.eventName === 'PostToolUse' && id) post.add(id);
    else if (event.eventName === 'UserPromptSubmit') turns += 1;
    transcriptPath = event.transcriptPath || transcriptPath;
  }
  return { turns, toolCalls: pre.size, failedToolCalls: [...pre].filter((id) => !post.has(id)).length, transcriptPath };
}

export async function sessionRollup({ kind, sessionId } = {}) {
  const journal = getProtocolSessionProvider(kind)?.service?.journal;
  const journaled = journal ? await journal.rebuild(sessionId, foldJournalEvent, null).catch(() => null) : null;
  const session = [...knownSessions()].find((item) => item.provider === kind && item.id === sessionId);
  const hooks = session?.workDir
    ? await readFile((await buildHookSessionPaths({ workDir: session.workDir, provider: kind, sessionId })).eventsPath, 'utf8').then(rollupHookEvents, () => null)
    : null;
  const rollup = Object.fromEntries(FIELDS.map((key) => [key, journaled?.[key] ?? hooks?.[key] ?? null]));
  return { ...rollup, transcriptPath: rollup.transcriptPath || session?.transcriptPath || null };
}
