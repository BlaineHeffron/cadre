import { basename } from 'node:path';

const MAX_TOPIC_NAME_LENGTH = 128;

function text(value = '') {
  return String(value ?? '').trim();
}

function shortSessionId(sessionId = '') {
  return text(sessionId).slice(0, 8);
}

function clampTopicName(value = '') {
  return text(value).slice(0, MAX_TOPIC_NAME_LENGTH);
}

/**
 * Name used when nothing better is available: `<short id> <workdir basename>`.
 */
function derivedSessionName(session = {}) {
  const short = shortSessionId(session.id) || 'session';
  const dir = basename(text(session.workDir).replace(/\/+$/, '')) || 'session';
  return `${short} ${dir}`;
}

/**
 * DM rooms use `DM: kind:id|kind:id` titles and metadata.dm. They must not own a
 * Telegram topic, or a named session is renamed the first time it DMs anyone.
 */
export function isDmBusThread(busThread = {}) {
  if (busThread?.dm === true || busThread?.metadata?.dm === true) return true;
  return /^DM:\s*\S+:.+\|\S+:/.test(text(busThread?.title));
}

/**
 * The single authority for which Telegram forum topic a session's output lands in.
 *
 * Two branches, never a chain: a session that belongs to a non-DM agent-bus thread
 * routes to that thread's topic, and everything else routes to its own session topic.
 * There is deliberately no input that can force session scope while a non-DM
 * `busThread.id` is set — that override is what let every previous fix regress.
 *
 * `canRename` gates topic renaming: only an authoritative name (a bus thread title, or
 * an operator-assigned session display name) may rename an existing topic. A derived
 * name must never rename, or two participants in one thread ping-pong the topic title.
 */
export function resolveTopicRoute({ session = {}, busThread = null } = {}) {
  const sessionId = text(session.id);
  if (!sessionId) throw new Error('resolveTopicRoute requires session.id');

  const threadId = text(busThread?.id);
  if (threadId && !isDmBusThread(busThread)) {
    const title = text(busThread?.title);
    return {
      key: `thread:${threadId}`,
      name: clampTopicName(title || derivedSessionName(session)),
      scopeType: 'thread',
      scopeId: threadId,
      canRename: Boolean(title),
      sessionId,
    };
  }

  const displayName = text(session.name);
  return {
    key: `session:${sessionId}`,
    name: clampTopicName(displayName || derivedSessionName(session)),
    scopeType: 'session',
    scopeId: sessionId,
    canRename: Boolean(displayName),
    sessionId,
  };
}

/**
 * Legacy topic key a thread-scoped route may adopt, so a conversation that started
 * before its bus thread existed keeps its forum topic instead of forking a new one.
 */
export function legacyTopicKeyFor(route = {}) {
  if (route?.scopeType !== 'thread') return '';
  const sessionId = text(route.sessionId);
  return sessionId ? `session:${sessionId}` : '';
}
