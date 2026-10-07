import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { buildSentStore, listSessionsFromRegistry } from './relay.mjs';
import { synthesizeSpeech } from './tts.mjs';

const DEFAULT_STATE_DIR = join(homedir(), '.claude/telegram');
const DEFAULT_POLL_TIMEOUT_SEC = 5;
const DEFAULT_ERROR_BACKOFF_MS = 2000;
const MAX_UPDATE_ATTEMPTS = 3;
const QUEUE_ROUTE = { key: 'queue:command', name: 'Command Queue', scopeType: 'queue', scopeId: 'command', sessionId: 'command-queue' };
const BLOCKING_INTERACTION_KINDS = new Set([
  'permission', 'confirmation', 'selection', 'trust', 'guardrail', 'update', 'unknown_blocking',
]);

async function readJsonFile(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
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

function normalizeChatId(value = '') {
  return String(value || '').trim();
}

function callbackText(data = '') {
  const text = String(data || '').trim();
  return text.startsWith('answer:') ? text.slice('answer:'.length) : text;
}

function isAnswerCallback(callback = null) {
  return String(callback?.data || '').trim().startsWith('answer:');
}

function clip(value, limit) {
  const chars = Array.from(String(value ?? '').trim());
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : chars.join('');
}

// One message per queue item; stays under the sender's default page size so it is never split.
function queueItemText(item = {}) {
  const body = clip([
    `❓ ${item.title} [${item.priority}]`,
    item.sessionId ? `From: ${item.sessionKind}:${item.sessionId}` : '',
    item.question !== item.title ? item.question : '',
    item.details,
  ].filter(Boolean).join('\n\n'), 2500);
  let footer = item.operatorAction ? 'Approve or reject this action in the dashboard.'
    : item.allowFreeform ? 'Reply to this message to answer in your own words.' : '';
  if (item.status !== 'open') footer = `Status: ${item.status}${item.answer?.text ? ` · ${clip(item.answer.text, 300)}` : ''}`;
  return footer ? `${body}\n\n${footer}` : body;
}

function updateMessage(update = {}) {
  if (update.message) return { message: update.message, callback: null };
  if (update.callback_query?.message) {
    return {
      message: {
        ...update.callback_query.message,
        text: callbackText(update.callback_query.data),
      },
      callback: update.callback_query,
    };
  }
  return { message: null, callback: null };
}

function sessionRuntime(session = {}, topic = {}) {
  return String(session.runtime || session.backend || topic.backend || '').toLowerCase() || 'codex';
}

function sessionWorkDir(session = {}) {
  return String(session.workDir || session.cwd || '').trim();
}

function sessionTmux(session = {}) {
  return String(session.tmuxSession || session.tmux_session || session.name || '').trim();
}

function sessionBusThreadId(session = {}) {
  return String(session.busThreadId || session.bus_thread_id || '').trim();
}

function sessionInputPath(runtime, sessionId) {
  const kind = ['claude', 'codex', 'pi'].includes(runtime) ? runtime : 'codex';
  return `/api/${kind}/sessions/${encodeURIComponent(sessionId)}/input`;
}

function sessionKeysPath(runtime, sessionId) {
  const kind = ['claude', 'codex', 'pi'].includes(runtime) ? runtime : 'codex';
  return `/api/${kind}/sessions/${encodeURIComponent(sessionId)}/keys`;
}

export async function defaultSendSessionInput({
  session,
  text,
  interactionAnswer = false,
  interactionExpectation = null,
  requestImpl,
}) {
  if (typeof requestImpl !== 'function') throw new Error('requestImpl is required');
  const runtime = sessionRuntime(session);
  const expectedState = interactionExpectation || {
    revision: session.state?.revision,
    kind: session.state?.interaction?.kind,
    fingerprint: session.state?.interaction?.fingerprint,
  };
  const interactionKind = String(expectedState.kind || '');
  const blocking = interactionAnswer && BLOCKING_INTERACTION_KINDS.has(interactionKind);
  const dialogKeyAnswer = blocking && (runtime === 'claude' || interactionKind === 'selection');
  // Telegram buttons number options from 1; resolve the position to the option's key.
  const key = blocking && /^[1-9]\d*$/.test(text) ? session.state?.interaction?.options?.[text - 1]?.key : null;
  if (key) text = String(key);
  const response = await requestImpl(
    dialogKeyAnswer ? sessionKeysPath(runtime, session.id) : sessionInputPath(runtime, session.id), {
    method: 'POST',
    body: {
      ...(dialogKeyAnswer ? { keys: text } : { text, enter: true, source: 'telegram_answer' }),
      ...(blocking ? {
        expectedRevision: expectedState.revision,
        expectedFingerprint: expectedState.fingerprint,
        expectedInteractionKind: interactionKind,
      } : {}),
    },
  });
  if (response?.statusCode && response.statusCode >= 400) {
    throw new Error(response.payload?.error || `session_input_${response.statusCode}`);
  }
  return response?.payload || { ok: true };
}

export class TelegramBridgeLoop {
  constructor({
    sender,
    stateDir = DEFAULT_STATE_DIR,
    listSessions = () => listSessionsFromRegistry(),
    requestImpl,
    watchQueue = null,
    sendSessionInput = (input) => defaultSendSessionInput({ ...input, requestImpl }),
    sentStore = buildSentStore({ stateDir }),
    synthesizeSpeech: synthesizeSpeechImpl = synthesizeSpeech,
    pollTimeoutSec = DEFAULT_POLL_TIMEOUT_SEC,
    errorBackoffMs = DEFAULT_ERROR_BACKOFF_MS,
    now = () => Date.now(),
    logger = console,
  } = {}) {
    this.sender = sender;
    this.requestImpl = requestImpl;
    this.watchQueue = watchQueue;
    this.unwatchQueue = null;
    this.queueSync = Promise.resolve();
    this.stateDir = stateDir;
    this.listSessions = listSessions;
    this.sendSessionInput = sendSessionInput;
    this.sentStore = sentStore;
    this.synthesizeSpeech = synthesizeSpeechImpl;
    this.pollTimeoutSec = pollTimeoutSec;
    this.errorBackoffMs = errorBackoffMs;
    this.now = now;
    this.logger = logger;
    this.running = false;
    this.timer = null;
    this.ttsJobs = new Set();
    this.lastPollAt = null;
    this.lastError = null;
    this.lastErrorAt = null;
    this.errorCount = 0;
    this.lastSuccessAt = null;
    this.lastIgnoredUpdate = null;
    this.ignoredUpdateCount = 0;
    this.offset = 0;
    this.updateFailures = new Map();
  }

  processedPath() {
    return join(this.stateDir, 'processed_updates.json');
  }

  topicsPath() {
    return join(this.stateDir, 'topics.json');
  }

  messagesPath() {
    return join(this.stateDir, 'messages.json');
  }

  routesPath() {
    return join(this.stateDir, 'message_routes.json');
  }

  queueMessagesPath() {
    return join(this.stateDir, 'queue_messages.json');
  }

  statePath() {
    return join(this.stateDir, 'bridge_state.json');
  }

  legacyOffsetPath() {
    return join(this.stateDir, '.last_update_id');
  }

  async loadOffset() {
    const state = await readJsonFile(this.statePath(), {});
    let offset = Number(state.last_update_id || 0);
    if (!offset && existsSync(this.legacyOffsetPath())) {
      try {
        offset = Number(String(await readFile(this.legacyOffsetPath(), 'utf8')).trim() || 0);
      } catch {
        offset = 0;
      }
    }
    this.offset = offset;
    return this.offset;
  }

  async saveOffset(offset) {
    this.offset = Number(offset || 0);
    const previous = await readJsonFile(this.statePath(), {});
    await writeJsonAtomic(this.statePath(), {
      ...previous,
      running: this.running,
      last_update_id: this.offset,
      last_poll_succeeded_at_ms: this.now(),
    });
  }

  start() {
    if (this.running) return false;
    this.running = true;
    this.unwatchQueue = this.watchQueue?.((item) => this.queueChanged(item)) || null;
    this.loadOffset()
      .catch((error) => {
        this.lastError = error.message || String(error);
        this.logger?.warn?.(`telegram bridge offset load failed: ${this.lastError}`);
      })
      .finally(() => this.schedule(0));
    return true;
  }

  stop() {
    if (!this.running) return false;
    this.running = false;
    this.unwatchQueue?.();
    this.unwatchQueue = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return true;
  }

  status() {
    return {
      running: this.running,
      restartPending: false,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      errorCount: this.errorCount,
      lastSuccessAt: this.lastSuccessAt,
      lastIgnoredUpdate: this.lastIgnoredUpdate,
      ignoredUpdateCount: this.ignoredUpdateCount,
      offset: this.offset,
      ttsJobs: this.ttsJobs.size,
    };
  }

  schedule(delayMs = 0) {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pollOnce()
        .catch((error) => {
          this.lastError = error.message || String(error);
          this.lastErrorAt = this.now();
          this.errorCount += 1;
          this.logger?.warn?.(`telegram bridge poll failed: ${this.lastError}`);
        })
        .finally(() => this.schedule(this.lastError ? this.errorBackoffMs : 0));
    }, delayMs);
    this.timer.unref?.();
  }

  async pollOnce() {
    this.lastPollAt = this.now();
    this.lastError = null;
    const updates = await this.sender.getUpdates({ offset: this.offset, timeout: this.pollTimeoutSec });
    this.lastSuccessAt = this.now();
    let nextOffset = null;
    let failure = null;
    for (const update of Array.isArray(updates) ? updates : []) {
      const updateId = Number(update.update_id);
      try {
        await this.handleUpdate(update);
        this.updateFailures.delete(updateId);
      } catch (error) {
        const attempts = (this.updateFailures.get(updateId) || 0) + 1;
        if (attempts < MAX_UPDATE_ATTEMPTS) {
          // Leave the failed update uncommitted so the next poll retries it.
          this.updateFailures.set(updateId, attempts);
          failure = error;
          break;
        }
        // Poison update: commit past it so it cannot block the queue.
        this.updateFailures.delete(updateId);
        this.logger?.warn?.(`telegram bridge dropping update ${updateId} after ${attempts} attempts: ${error.message || error}`);
      }
      if (Number.isFinite(updateId)) nextOffset = updateId + 1;
    }
    if (nextOffset != null) await this.saveOffset(nextOffset);
    if (failure) throw failure;
  }

  async handleUpdate(update = {}) {
    const updateId = Number(update.update_id);
    if (!Number.isFinite(updateId)) return false;

    const processed = await readJsonFile(this.processedPath(), {});
    if (processed[String(updateId)]) return this.ignoreUpdate(updateId, 'already_processed');

    const { message, callback } = updateMessage(update);
    if (!message) return this.ignoreUpdate(updateId, 'unsupported_update');

    const config = await this.sender.loadConfig();
    const expectedChatId = normalizeChatId(config.chatId);
    const actualChatId = normalizeChatId(message.chat?.id);
    if (expectedChatId && (!actualChatId || actualChatId !== expectedChatId)) {
      return this.ignoreUpdate(updateId, 'wrong_chat', { chatId: actualChatId || null });
    }

    const queueMessages = await readJsonFile(this.queueMessagesPath(), {});
    const [queueTag, queueItemId, optionIndex] = String(callback?.data || '').split(':');
    if (queueTag === 'q') {
      return this.handleQueueAnswer({ updateId, processed, message, callback, itemId: queueItemId, optionIndex: Number(optionIndex) });
    }
    const repliedQueueItemId = !callback && Object.keys(queueMessages)
      .find((itemId) => queueMessages[itemId] === Number(message.reply_to_message?.message_id));
    if (repliedQueueItemId) {
      return this.handleQueueAnswer({ updateId, processed, message, itemId: repliedQueueItemId, text: String(message.text || '').trim() });
    }

    if (callback && String(callback.data || '').trim() === 'tts') {
      return this.handleTtsCallback({ updateId, callback, processed });
    }

    const threadId = Number(message.message_thread_id);
    const text = String(message.text || '').trim();
    if (!Number.isFinite(threadId)) return this.ignoreUpdate(updateId, 'missing_thread', { messageId: message.message_id || null });
    if (!text) return this.ignoreUpdate(updateId, 'empty_text', { threadId, messageId: message.message_id || null });

    const messageId = Number(message.message_id || 0) || null;
    const replyToMessageId = Number(message.reply_to_message?.message_id || 0) || null;
    const sessions = (await this.listSessions()).filter((session) => session?.id);
    const topics = await readJsonFile(this.topicsPath(), {});
    const messages = await readJsonFile(this.messagesPath(), {});
    const routes = await readJsonFile(this.routesPath(), {});
    const resolved = this.resolveSession({ threadId, messageId, replyToMessageId, sessions, topics, messages, routes });
    if (!resolved) {
      if (this.isAmbiguousThread({ threadId, sessions, topics })) {
        await this.sender.sendMessage(
          'Multiple live sessions share this topic. Reply to a specific agent message.',
          { threadId },
        ).catch((error) => {
          this.logger?.warn?.(`telegram bridge routing hint failed: ${error.message || error}`);
        });
      }
      return this.ignoreUpdate(updateId, 'unresolved_session', {
        threadId,
        messageId: message.message_id || null,
        replyToMessageId,
        liveSessionCount: sessions.length,
      });
    }

    let interactionExpectation = null;
    if (isAnswerCallback(callback)) {
      await this.sentStore.load();
      const previous = this.sentStore.get(resolved.session.id);
      const expectedMessageId = Number(previous?.interaction_message_id || previous?.message_id || 0) || null;
      interactionExpectation = {
        revision: Number(previous?.interaction_revision),
        kind: String(previous?.interaction_kind || ''),
        fingerprint: String(previous?.interaction_fingerprint || ''),
      };
      const currentState = resolved.session.state || {};
      const currentInteraction = currentState.interaction || {};
      const interactionMatches = BLOCKING_INTERACTION_KINDS.has(interactionExpectation.kind)
        && currentInteraction.kind === interactionExpectation.kind
        && Boolean(currentInteraction.fingerprint);
      if (
        !expectedMessageId
        || expectedMessageId !== messageId
        || previous?.answer_consumed === true
        || !interactionMatches
      ) {
        if (callback?.id) {
          await this.sender.answerCallbackQuery(callback.id, 'Expired answer ignored').catch((error) => {
            this.logger?.warn?.(`telegram callback ack failed: ${error.message || error}`);
          });
          await this.sender.clearMessageReplyMarkup(message.message_id).catch((error) => {
            this.logger?.warn?.(`telegram callback keyboard clear failed: ${error.message || error}`);
          });
        }
        processed[String(updateId)] = {
          update_id: updateId,
          message_id: message.message_id,
          thread_id: threadId,
          session_id: resolved.session.id,
          stale_answer: true,
          ts: this.now() / 1000,
        };
        await writeJsonAtomic(this.processedPath(), processed);
        return this.ignoreUpdate(updateId, 'stale_answer_callback', {
          threadId,
          messageId: message.message_id || null,
          sessionId: resolved.session.id,
          expectedMessageId,
          answerConsumed: previous?.answer_consumed === true,
          interactionMatches,
        });
      }
      // Telegram messages survive server restarts, while pane fingerprints do
      // not. Bind delivery to the currently observed instance after the latest
      // message id and interaction kind have been validated.
      interactionExpectation = {
        revision: currentState.revision,
        kind: currentInteraction.kind,
        fingerprint: currentInteraction.fingerprint,
      };
    }

    await this.sendSessionInput({
      session: resolved.session,
      text,
      interactionAnswer: isAnswerCallback(callback),
      interactionExpectation,
    });

    // Commit the processed marker immediately after the input lands so a
    // failure in the bookkeeping below cannot replay the input on retry.
    processed[String(updateId)] = {
      update_id: updateId,
      message_id: message.message_id,
      thread_id: threadId,
      session_id: resolved.session.id,
      ts: this.now() / 1000,
    };
    await writeJsonAtomic(this.processedPath(), processed);

    if (callback?.id) {
      await this.sender.answerCallbackQuery(callback.id, 'Sent to agent').catch((error) => {
        this.logger?.warn?.(`telegram callback ack failed: ${error.message || error}`);
      });
      await this.sender.clearMessageReplyMarkup(message.message_id).catch((error) => {
        this.logger?.warn?.(`telegram callback keyboard clear failed: ${error.message || error}`);
      });
    }

    await this.sender.recordMessage(message.message_id, {
      session_id: resolved.session.id,
      text,
      short: String(resolved.session.id).slice(0, 8),
      cwd: resolved.session.workDir || resolved.topic?.cwd || '',
      tmux_session: resolved.session.tmuxSession || resolved.topic?.tmux_session || '',
      thread_id: threadId,
      topic_key: resolved.topicKey || '',
      backend: sessionRuntime(resolved.session, resolved.topic),
    });

    if (isAnswerCallback(callback)) {
      const previous = this.sentStore.get(resolved.session.id) || {};
      await this.sentStore.set(resolved.session.id, {
        ...previous,
        session_id: resolved.session.id,
        message_id: message.message_id,
        thread_id: threadId,
        topic_key: resolved.topicKey || '',
        answer_consumed: true,
        answer_consumed_at_ms: this.now(),
        ts: this.now() / 1000,
      });
    }

    return true;
  }

  ignoreUpdate(updateId, reason, extra = {}) {
    this.ignoredUpdateCount += 1;
    this.lastIgnoredUpdate = {
      updateId,
      reason,
      ts: this.now() / 1000,
      ...extra,
    };
    return false;
  }

  // Answers go through the same HTTP route as the dashboard, so routing and operator-action auth are unchanged.
  async handleQueueAnswer({ updateId, processed, message, callback = null, itemId, optionIndex, text }) {
    let note = 'Answered';
    try {
      const queue = await this.requestImpl('/api/command-center/work-queue?status=all');
      const item = queue?.items?.find((entry) => entry.id === itemId);
      const option = callback ? item?.options?.[optionIndex] : null;
      if (!item) throw new Error('Queue item not found');
      if (callback ? !option : !item.allowFreeform || !text) throw new Error('Choose one of the options');
      await this.requestImpl(`/api/command-center/work-queue/${encodeURIComponent(itemId)}/answer`, {
        method: 'POST',
        body: option ? { optionId: option.id } : { answer: text },
      });
    } catch (error) {
      note = error.message || String(error);
      this.logger?.warn?.(`telegram queue answer failed for ${itemId}: ${note}`);
    }
    processed[String(updateId)] = { update_id: updateId, message_id: message.message_id, queue_item_id: itemId, ts: this.now() / 1000 };
    await writeJsonAtomic(this.processedPath(), processed);
    if (callback?.id) {
      await this.sender.answerCallbackQuery(callback.id, note).catch((error) => {
        this.logger?.warn?.(`telegram callback ack failed: ${error.message || error}`);
      });
    }
    return note === 'Answered' || this.ignoreUpdate(updateId, 'queue_answer_failed', { itemId, error: note });
  }

  // Never blocks or fails the queue operation: Telegram errors are logged after the sender's retries.
  queueChanged(item) {
    this.queueSync = this.queueSync.then(() => this.syncQueueItem(item)).catch((error) => {
      this.logger?.warn?.(`telegram queue sync failed for ${item?.id}: ${error.message || error}`);
    });
    return this.queueSync;
  }

  async syncQueueItem(item) {
    const messages = await readJsonFile(this.queueMessagesPath(), {});
    const text = queueItemText(item);
    const buttons = item.status === 'open' && !item.operatorAction
      ? item.options.map((option, index) => ({ text: option.label, callback_data: `q:${item.id}:${index}` }))
      : [];
    if (messages[item.id]) return this.sender.editMessageText(messages[item.id], text, { buttons });
    if (item.status !== 'open') return null;
    const { threadId } = await this.sender.resolveTopic(QUEUE_ROUTE);
    messages[item.id] = await this.sender.sendMessage(text, { threadId, buttons });
    // The queue keeps at most 200 items.
    await writeJsonAtomic(this.queueMessagesPath(), Object.fromEntries(Object.entries(messages).slice(-200)));
    return messages[item.id];
  }

  async handleTtsCallback({ updateId, callback, processed }) {
    const message = callback.message || {};
    await this.sender.answerCallbackQuery(callback.id, 'Generating audio…').catch((error) => {
      this.logger?.warn?.(`telegram tts ack failed: ${error.message || error}`);
    });
    const messages = await readJsonFile(this.messagesPath(), {});
    const recorded = messages[String(message.message_id)] || {};
    const text = String(recorded.text || message.text || '').trim();
    if (text) this.enqueueTtsJob({ text, message });
    processed[String(updateId)] = {
      update_id: updateId,
      message_id: message.message_id,
      thread_id: Number(message.message_thread_id) || null,
      tts: true,
      ts: this.now() / 1000,
    };
    await writeJsonAtomic(this.processedPath(), processed);
    return true;
  }

  enqueueTtsJob({ text, message }) {
    const job = (async () => {
      try {
        const voice = await this.synthesizeSpeech(text);
        await this.sender.sendVoiceMessage(voice, {
          threadId: Number(message.message_thread_id) || undefined,
          replyToMessageId: message.message_id,
        });
      } catch (error) {
        this.logger?.warn?.(`telegram tts failed: ${error.message || error}`);
      }
    })();
    this.ttsJobs.add(job);
    job.finally(() => this.ttsJobs.delete(job));
    return job;
  }

  async drainTtsJobs() {
    while (this.ttsJobs.size) {
      await Promise.allSettled([...this.ttsJobs]);
    }
  }

  resolveSession({ threadId, messageId, replyToMessageId, sessions, topics, messages, routes = {} }) {
    const routingMessages = { ...(messages || {}), ...(routes || {}) };
    const resolveRecordedMessage = (recordedMessageId) => {
      if (!recordedMessageId || !routingMessages[String(recordedMessageId)]?.session_id) return null;
      const message = routingMessages[String(recordedMessageId)];
      if (Number(message.thread_id) === Number(threadId)) {
        const session = sessions.find((entry) => entry.id === message.session_id);
        if (session) return { session, topicKey: message.topic_key || '', topic: topics[message.topic_key] || null };
      }
      return null;
    };

    const fromMessage = resolveRecordedMessage(messageId);
    if (fromMessage) return fromMessage;

    const fromReply = resolveRecordedMessage(replyToMessageId);
    if (fromReply) return fromReply;

    const matchingTopics = Object.entries(topics || {})
      .filter(([, topic]) => Number(topic?.thread_id) === Number(threadId));

    for (const [topicKey, topic] of matchingTopics) {
      if (topic.scope_type === 'thread') {
        const participants = sessions.filter((entry) => sessionBusThreadId(entry) === String(topic.scope_id || '').trim());
        if (participants.length === 1) return { session: participants[0], topicKey, topic };
        if (participants.length > 1) return null;
      }
      const sessionId = topic.session_id || topic.scope_id;
      const session = sessions.find((entry) => entry.id === sessionId);
      if (session) return { session, topicKey, topic };

      const byTmux = sessions.find((entry) => sessionTmux(entry) && sessionTmux(entry) === String(topic.tmux_session || topic.scope_id || '').trim());
      if (byTmux) return { session: byTmux, topicKey, topic };

      const topicCwd = String(topic.cwd || '').trim();
      const topicRuntime = String(topic.backend || '').trim().toLowerCase();
      if (topicCwd) {
        const cwdMatches = sessions.filter((entry) =>
          sessionWorkDir(entry) === topicCwd
          && (!topicRuntime || sessionRuntime(entry) === topicRuntime)
        );
        if (cwdMatches.length === 1) return { session: cwdMatches[0], topicKey, topic };
      }
    }

    return null;
  }

  isAmbiguousThread({ threadId, sessions, topics }) {
    return Object.values(topics || {}).some((topic) => {
      if (Number(topic?.thread_id) !== Number(threadId) || topic?.scope_type !== 'thread') return false;
      const scopeId = String(topic.scope_id || '').trim();
      return sessions.filter((entry) => sessionBusThreadId(entry) === scopeId).length > 1;
    });
  }
}

export function buildTelegramBridgeLoop(options = {}) {
  return new TelegramBridgeLoop(options);
}
