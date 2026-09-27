import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { normalizeObservation } from '../contract.mjs';

const DEFAULT_TAIL_BYTES = 64 * 1024;
// sessions/index.mjs background observer interval. Terminal TTL is derived from this.
export const TRANSCRIPT_OBSERVER_CADENCE_MS = 15_000;
// Working is only as fresh as the last write. Keep this tight so a quiet tool_use
// cannot outrank a newer pane for tens of seconds.
export const TRANSCRIPT_WORKING_FRESHNESS_MS = 5_000;
// Latching last-record-is-terminal fact. 3x the 15s observer so a missed tick
// cannot drop it; finite so a later unreadable transcript cannot pin idle forever.
export const TRANSCRIPT_TERMINAL_FRESHNESS_MS = TRANSCRIPT_OBSERVER_CADENCE_MS * 3;

function parseJsonLines(content = '') {
  const records = [];
  for (const line of String(content || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A transcript may end with a partial write. Ignore malformed records.
    }
  }
  return records;
}

function claudeRecordActivity(record = {}) {
  if (record.type === 'progress') return 'working';
  const message = record.message && typeof record.message === 'object' ? record.message : record;
  const role = String(message.role || record.role || '');
  const content = Array.isArray(message.content) ? message.content : [];
  if (role === 'user' || record.type === 'user') return 'working';
  if (role === 'assistant' || record.type === 'assistant') {
    return content.some((block) => block?.type === 'tool_use') ? 'working' : 'terminal';
  }
  return '';
}

function piRecordActivity(record = {}) {
  const message = record.message && typeof record.message === 'object' ? record.message : record;
  if (message.role === 'user' || message.role === 'toolResult') return 'working';
  if (message.role !== 'assistant') return '';
  // Pi ends error/abort responses before executing any partial tool calls.
  if (['error', 'aborted'].includes(message.stopReason)) return 'terminal';
  const content = Array.isArray(message.content) ? message.content : [];
  if (message.stopReason === 'toolUse' || content.some((block) => block?.type === 'toolCall')) return 'working';
  if (['stop', 'length'].includes(message.stopReason)) return 'terminal';
  // Text/thinking alone does not establish that the assistant turn completed.
  return 'working';
}

function codexRecordActivity(record = {}) {
  const payload = record.payload && typeof record.payload === 'object' ? record.payload : {};
  const type = String(payload.type || '');
  if (['task_started', 'user_message', 'function_call', 'function_call_output', 'tool_call', 'tool_output'].includes(type)) {
    return 'working';
  }
  if (['task_complete', 'task_completed', 'agent_message'].includes(type)) return 'terminal';
  if (record.type === 'response_item' && type === 'message') {
    return payload.role === 'user' ? 'working' : 'terminal';
  }
  return '';
}

function latestActivity(provider, records) {
  const providerId = String(provider || '').toLowerCase();
  const classify = providerId === 'codex'
    ? codexRecordActivity
    : providerId === 'pi' ? piRecordActivity : claudeRecordActivity;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const activity = classify(records[index]);
    if (activity) return { activity, record: records[index] };
  }
  return null;
}

export function transcriptExecutionFromActivity(activity) {
  if (activity === 'working') return 'working';
  if (activity === 'terminal') return 'idle';
  // Unrecognized records are no evidence, never idle. Idle becomes load-bearing
  // for auto-close; defaulting unknown -> idle would kill a live pane.
  return '';
}

function freshnessForActivity(activity) {
  if (activity === 'working') return TRANSCRIPT_WORKING_FRESHNESS_MS;
  if (activity === 'terminal') return TRANSCRIPT_TERMINAL_FRESHNESS_MS;
  return 0;
}

export function observeTranscriptContent(content, {
  provider = 'claude',
  observedAt = Date.now(),
  expiresAt,
  writtenAt,
} = {}) {
  const latest = latestActivity(provider, parseJsonLines(content));
  if (!latest) return Object.freeze([]);
  const execution = transcriptExecutionFromActivity(latest.activity);
  if (!execution) return Object.freeze([]);
  const digest = createHash('sha256')
    .update(JSON.stringify(latest.record))
    .digest('hex')
    .slice(0, 24);
  const observedAtMs = Number(observedAt);
  const writtenAtMs = Number.isFinite(Number(writtenAt)) && Number(writtenAt) > 0
    ? Number(writtenAt)
    : observedAtMs;
  const expiresAtMs = expiresAt === undefined
    ? observedAtMs + freshnessForActivity(latest.activity)
    : Number(expiresAt);
  return Object.freeze([normalizeObservation({
    source: 'transcript',
    kind: 'execution',
    value: { execution, activity: latest.activity, writtenAt: writtenAtMs },
    observedAt: observedAtMs,
    expiresAt: expiresAtMs,
    fingerprint: `transcript:${execution}:${digest}`,
  })]);
}

export async function observeTranscriptFile(filePath, {
  provider = 'claude',
  now = Date.now(),
  freshnessMs,
  workingFreshnessMs = TRANSCRIPT_WORKING_FRESHNESS_MS,
  terminalFreshnessMs = TRANSCRIPT_TERMINAL_FRESHNESS_MS,
  tailBytes = DEFAULT_TAIL_BYTES,
} = {}) {
  const path = String(filePath || '').trim();
  if (!path) return Object.freeze([]);
  const fileStat = await stat(path);
  const length = Math.max(0, Math.min(fileStat.size, Math.max(1, Number(tailBytes) || DEFAULT_TAIL_BYTES)));
  const start = Math.max(0, fileStat.size - length);
  const buffer = Buffer.alloc(length);
  const handle = await open(path, 'r');
  try {
    await handle.read(buffer, 0, length, start);
  } finally {
    await handle.close();
  }
  let content = buffer.toString('utf8');
  if (start > 0) content = content.slice(Math.max(0, content.indexOf('\n') + 1));

  const latest = latestActivity(provider, parseJsonLines(content));
  if (!latest) return Object.freeze([]);

  const nowMs = Number(now);
  const isWorking = latest.activity === 'working';
  const windowMs = Math.max(1, Number(
    freshnessMs ?? (isWorking ? workingFreshnessMs : terminalFreshnessMs),
  ));
  // Clamp mtime to now so a future overlay-FS clock cannot pin working and
  // swallow later terminal observations on the same tracker key.
  const mtimeObservedAt = Math.min(Math.max(0, Math.floor(fileStat.mtimeMs)), nowMs);
  // Working is only as fresh as the last write. Terminal is a latching last-record
  // fact, so stamp it at read time; otherwise an old mtime discards it.
  const observedAt = isWorking ? mtimeObservedAt : nowMs;
  const expiresAt = observedAt + windowMs;
  if (isWorking && expiresAt <= nowMs) return Object.freeze([]);

  return observeTranscriptContent(content, {
    provider,
    observedAt,
    expiresAt,
    writtenAt: mtimeObservedAt,
  });
}
