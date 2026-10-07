import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { legacyTopicKeyFor } from './routing.mjs';
import { latexMathToUnicode } from './math.mjs';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEFAULT_MAX_MESSAGE_LENGTH = 3000;
const DEFAULT_STATE_DIR = join(homedir(), '.claude/telegram');
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_BASE_MS = 500;
const DEFAULT_MAX_ROUTE_RECORDS = 100_000;
const stateWriteQueues = new Map();

function envValue(value = '') {
  const trimmed = String(value || '').trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvFile(raw = '') {
  const values = {};
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = envValue(match[2]);
  }
  return values;
}

function chatIdValue(chatId = '') {
  const text = String(chatId || '').trim();
  if (/^-?\d+$/.test(text)) return Number(text);
  return text;
}

function shortSessionId(sessionId = '') {
  return String(sessionId || '').slice(0, 8);
}

function isMissingThreadError(error) {
  return /thread not found|topic.*(deleted|closed|not found)/i.test(String(error?.description || error?.message || ''));
}

async function readJsonFile(filePath, fallback = {}) {
  if (!existsSync(filePath)) return fallback;
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
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

async function serializeStateWrite(key, operation) {
  const previous = stateWriteQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  stateWriteQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (stateWriteQueues.get(key) === current) stateWriteQueues.delete(key);
  }
}

function splitPageByCodepoints(text, limit) {
  const chars = Array.from(text);
  return [chars.slice(0, limit).join(''), chars.slice(limit).join('')];
}

function splitPage(text, limit) {
  if (Array.from(text).length <= limit) return [text, ''];
  const chars = Array.from(text);
  const candidate = chars.slice(0, limit).join('');
  const minNewlineIndex = Math.floor(limit / 4);
  const newlineIndex = candidate.lastIndexOf('\n');
  if (newlineIndex > minNewlineIndex) {
    return [candidate.slice(0, newlineIndex + 1), `${candidate.slice(newlineIndex + 1)}${chars.slice(limit).join('')}`];
  }
  return splitPageByCodepoints(text, limit);
}

export function pagedMessages(text = '', maxLength = DEFAULT_MAX_MESSAGE_LENGTH) {
  const source = String(text ?? '');
  const max = Math.max(Number(maxLength) || DEFAULT_MAX_MESSAGE_LENGTH, 1);
  if (Array.from(source).length <= max) return [source];

  const bodyLimit = Math.max(max - 32, 1);
  const chunks = [];
  let remaining = source;
  while (remaining) {
    const [chunk, rest] = splitPage(remaining, bodyLimit);
    chunks.push(chunk);
    remaining = rest;
  }
  const total = chunks.length;
  return chunks.map((chunk, index) => `[${index + 1}/${total}] ${chunk}`);
}

function telegramButtons(buttons = []) {
  if (!Array.isArray(buttons) || buttons.length === 0) return null;
  return buttons.map((button) => {
    const text = String(button?.text || '').slice(0, 64);
    const callbackData = String(button?.callback_data || '');
    if (Buffer.byteLength(callbackData, 'utf8') > 64) {
      throw new Error('Telegram callback_data exceeds 64 bytes');
    }
    return [{ text, callback_data: callbackData }];
  });
}

export class TelegramSender {
  constructor({
    fetchImpl = globalThis.fetch,
    stateDir = DEFAULT_STATE_DIR,
    configEnvPath = join(stateDir, 'config.env'),
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    ttsAvailable = () => false,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    maxRouteRecords = DEFAULT_MAX_ROUTE_RECORDS,
    logger = console,
    mathToUnicode = latexMathToUnicode,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.stateDir = stateDir;
    this.configEnvPath = configEnvPath;
    this.now = now;
    this.sleep = sleep;
    this.ttsAvailable = ttsAvailable;
    this.requestTimeoutMs = requestTimeoutMs;
    this.retryBaseMs = retryBaseMs;
    this.maxRouteRecords = maxRouteRecords;
    this.logger = logger;
    this.mathToUnicode = mathToUnicode;
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

  async loadConfig() {
    const raw = existsSync(this.configEnvPath) ? await readFile(this.configEnvPath, 'utf8') : '';
    const values = parseEnvFile(raw);
    return {
      botToken: values.TELEGRAM_BOT_TOKEN || '',
      chatId: values.TELEGRAM_CHAT_ID || '',
      maxMsgLength: Number.parseInt(values.MAX_MSG_LENGTH || values.TELEGRAM_MAX_MSG_LENGTH || '', 10)
        || DEFAULT_MAX_MESSAGE_LENGTH,
    };
  }

  async telegramPost(method, payload, { attempts = 3 } = {}) {
    const config = await this.loadConfig();
    if (!config.botToken || !config.chatId) {
      const error = new Error('Telegram bot token or chat id is not configured');
      error.code = 'telegram_not_configured';
      throw error;
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('fetch is not available');
    }

    const redact = (value) => String(value || '').split(config.botToken).join('***');
    for (let attempt = 1; ; attempt += 1) {
      let response = null;
      let body = null;
      try {
        response = await this.fetchImpl(`${TELEGRAM_API_BASE}/bot${config.botToken}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatIdValue(config.chatId), ...payload }),
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
        try {
          body = await response.json();
        } catch {
          body = null;
        }
      } catch (error) {
        if (attempt < attempts) {
          await this.sleep(Math.min(this.retryBaseMs * (2 ** (attempt - 1)), 5000));
          continue;
        }
        throw new Error(`Telegram ${method} failed: ${redact(error?.message) || 'network error'}`);
      }
      if (body?.ok) return body.result || {};

      const retryAfterSec = Number(body?.parameters?.retry_after) || 0;
      if ((response?.status === 429 || retryAfterSec > 0) && attempt < attempts) {
        await this.sleep(Math.max(retryAfterSec, 1) * 1000);
        continue;
      }
      if (Number(response?.status || 0) >= 500 && attempt < attempts) {
        await this.sleep(Math.min(this.retryBaseMs * (2 ** (attempt - 1)), 5000));
        continue;
      }
      const error = new Error(
        `Telegram ${method} failed: ${redact(body?.description) || `HTTP ${response?.status || 'unknown'}`}`
      );
      error.description = redact(body?.description);
      error.status = response?.status;
      throw error;
    }
  }

  async telegramGet(method, query = {}, { attempts = 3, timeoutMs = this.requestTimeoutMs } = {}) {
    const config = await this.loadConfig();
    if (!config.botToken || !config.chatId) {
      const error = new Error('Telegram bot token or chat id is not configured');
      error.code = 'telegram_not_configured';
      throw error;
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('fetch is not available');
    }

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query || {})) {
      if (value == null) continue;
      params.set(key, String(value));
    }
    const suffix = params.toString() ? `?${params.toString()}` : '';
    const redact = (value) => String(value || '').split(config.botToken).join('***');
    for (let attempt = 1; ; attempt += 1) {
      let response = null;
      let body = null;
      try {
        response = await this.fetchImpl(`${TELEGRAM_API_BASE}/bot${config.botToken}/${method}${suffix}`, {
          method: 'GET',
          signal: AbortSignal.timeout(timeoutMs),
        });
        try {
          body = await response.json();
        } catch {
          body = null;
        }
      } catch (error) {
        if (attempt < attempts) {
          await this.sleep(Math.min(this.retryBaseMs * (2 ** (attempt - 1)), 5000));
          continue;
        }
        throw new Error(`Telegram ${method} failed: ${redact(error?.message) || 'network error'}`);
      }
      if (body?.ok) return body.result || [];
      const retryAfterSec = Number(body?.parameters?.retry_after) || 0;
      const retryable = response?.status === 429
        || retryAfterSec > 0
        || Number(response?.status || 0) >= 500;
      if (retryable && attempt < attempts) {
        await this.sleep(retryAfterSec > 0
          ? Math.max(retryAfterSec, 1) * 1000
          : Math.min(this.retryBaseMs * (2 ** (attempt - 1)), 5000));
        continue;
      }
      throw new Error(
        `Telegram ${method} failed: ${redact(body?.description) || `HTTP ${response?.status || 'unknown'}`}`
      );
    }
  }

  async getUpdates({ offset = 0, timeout = 5 } = {}) {
    return this.telegramGet(
      'getUpdates',
      {
        offset,
        timeout,
        allowed_updates: JSON.stringify(['message', 'callback_query']),
      },
      { timeoutMs: Math.max((Number(timeout) + 5) * 1000, this.requestTimeoutMs) },
    );
  }

  async answerCallbackQuery(callbackQueryId, text = 'Sent to agent') {
    return this.telegramPost('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text,
      show_alert: false,
    });
  }

  async clearMessageReplyMarkup(messageId) {
    return this.telegramPost('editMessageReplyMarkup', {
      message_id: Number(messageId),
      reply_markup: { inline_keyboard: [] },
    });
  }

  async editMessageText(messageId, text, { buttons } = {}) {
    return this.telegramPost('editMessageText', {
      message_id: Number(messageId),
      text: String(text ?? ''),
      reply_markup: { inline_keyboard: telegramButtons(buttons) || [] },
    });
  }

  async createForumTopic(name) {
    const result = await this.telegramPost('createForumTopic', {
      name: String(name || 'session').slice(0, 128),
    });
    const threadId = Number(result.message_thread_id);
    if (!Number.isFinite(threadId)) {
      throw new Error('Telegram createForumTopic response missing message_thread_id');
    }
    return { threadId, name: result.name || String(name || 'session').slice(0, 128) };
  }

  async editForumTopic(threadId, name) {
    return this.telegramPost('editForumTopic', {
      message_thread_id: Number(threadId),
      name: String(name || 'session').slice(0, 128),
    });
  }

  async sendVoiceMessage(voice, { threadId, replyToMessageId } = {}) {
    const config = await this.loadConfig();
    if (!config.botToken || !config.chatId) {
      const error = new Error('Telegram bot token or chat id is not configured');
      error.code = 'telegram_not_configured';
      throw error;
    }
    const form = new FormData();
    form.set('chat_id', String(chatIdValue(config.chatId)));
    if (threadId != null) form.set('message_thread_id', String(Number(threadId)));
    if (replyToMessageId != null) form.set('reply_to_message_id', String(Number(replyToMessageId)));
    form.set('voice', new Blob([voice], { type: 'audio/ogg' }), 'voice.ogg');
    const response = await this.fetchImpl(`${TELEGRAM_API_BASE}/bot${config.botToken}/sendVoice`, {
      method: 'POST',
      body: form,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!body?.ok) {
      const description = String(body?.description || '').split(config.botToken).join('***');
      const error = new Error(`Telegram sendVoice failed: ${description || `HTTP ${response?.status || 'unknown'}`}`);
      error.description = description;
      throw error;
    }
    return body.result || {};
  }

  async sendMessage(text, { threadId, buttons } = {}) {
    const result = await this.sendMessagePages(text, { threadId, buttons });
    return result.lastMessageId;
  }

  async sendMessagePages(text, { threadId, buttons, header = '' } = {}) {
    const config = await this.loadConfig();
    const messageIds = [];
    const cleanHeader = String(header || '').trim();
    let readableText;
    try {
      readableText = this.mathToUnicode(text);
    } catch (error) {
      readableText = String(text ?? '');
      this.logger?.warn?.(`telegram math conversion failed; sending canonical text: ${error.message || error}`);
    }
    const bodyLimit = cleanHeader
      ? Math.max(config.maxMsgLength - Array.from(cleanHeader).length - 1, 1)
      : config.maxMsgLength;
    const pages = pagedMessages(readableText, bodyLimit);
    const inlineKeyboard = telegramButtons(buttons);
    for (const [index, page] of pages.entries()) {
      const payload = { text: cleanHeader ? `${cleanHeader}\n${page}` : page };
      if (threadId != null) payload.message_thread_id = Number(threadId);
      if (inlineKeyboard && index === pages.length - 1) {
        payload.reply_markup = { inline_keyboard: inlineKeyboard };
      }
      const result = await this.telegramPost('sendMessage', payload);
      const messageId = Number(result.message_id);
      if (Number.isFinite(messageId)) messageIds.push(messageId);
    }
    const lastMessageId = messageIds.at(-1);
    if (!Number.isFinite(lastMessageId)) {
      throw new Error('Telegram sendMessage response missing message_id');
    }
    return { lastMessageId, messageIds };
  }

  async resolveTopic(route, { recreate = false } = {}) {
    const sessionId = String(route?.sessionId || '').trim();
    if (!sessionId) throw new Error('route.sessionId is required');
    const topicKey = String(route?.key || '').trim();
    if (!topicKey) throw new Error('route.key is required');
    const topics = await readJsonFile(this.topicsPath(), {});
    const existing = topics[topicKey];
    if (existing?.thread_id && !recreate) {
      let dirty = false;
      if (route.canRename && existing.name !== route.name) {
        try {
          await this.editForumTopic(existing.thread_id, route.name);
          existing.name = route.name;
          dirty = true;
        } catch (error) {
          if (isMissingThreadError(error)) {
            return this.resolveTopic(route, { recreate: true });
          }
          this.logger?.warn?.(`telegram topic rename failed: ${error.message || error}`);
        }
      }
      if (existing.session_id !== sessionId) {
        existing.session_id = sessionId;
        existing.tmux_session = route.tmux_session || existing.tmux_session || '';
        existing.backend = route.backend || existing.backend || '';
        dirty = true;
      }
      if (dirty) await writeJsonAtomic(this.topicsPath(), topics);
      return { topicKey, threadId: existing.thread_id, entry: existing };
    }

    if (route.scopeType === 'thread' && !recreate) {
      const legacyKey = legacyTopicKeyFor(route);
      const legacy = topics[legacyKey];
      if (legacy?.thread_id) {
        // Migrate a pre-existing per-session topic to the thread scope so we
        // reuse its forum topic instead of forking the conversation.
        if (route.canRename && legacy.name !== route.name) {
          try {
            await this.editForumTopic(legacy.thread_id, route.name);
            legacy.name = route.name;
          } catch (error) {
            this.logger?.warn?.(`telegram topic migrate rename failed: ${error.message || error}`);
          }
        }
        const entry = {
          ...legacy,
          scope_type: route.scopeType,
          scope_id: route.scopeId,
          session_id: sessionId,
          migrated_from: legacyKey,
        };
        topics[topicKey] = entry;
        delete topics[legacyKey];
        await writeJsonAtomic(this.topicsPath(), topics);
        return { topicKey, threadId: entry.thread_id, entry };
      }
    }

    const topic = await this.createForumTopic(route.name);
    const entry = {
      thread_id: topic.threadId,
      name: topic.name || route.name,
      cwd: route.cwd || '',
      tmux_session: route.tmux_session || '',
      scope_type: route.scopeType,
      scope_id: route.scopeId,
      session_id: sessionId,
      backend: route.backend || '',
    };
    topics[topicKey] = entry;
    await writeJsonAtomic(this.topicsPath(), topics);
    return { topicKey, threadId: topic.threadId, entry };
  }

  async recordMessage(messageId, session) {
    return serializeStateWrite(this.stateDir, async () => {
      const messages = await readJsonFile(this.messagesPath(), {});
      const recorded = {
        session_id: session.session_id || '',
        text: String(session.text || '').slice(0, 4000),
        short: session.short || shortSessionId(session.session_id),
        cwd: session.cwd || '',
        tmux_session: session.tmux_session || '',
        thread_id: session.thread_id,
        topic_key: session.topic_key || '',
        ts: this.now() / 1000,
        backend: session.backend || '',
      };
      messages[String(messageId)] = recorded;
      const pruned = Object.fromEntries(
        Object.entries(messages)
          .sort((a, b) => Number(a[1]?.ts || 0) - Number(b[1]?.ts || 0))
          .slice(-1000)
      );
      await writeJsonAtomic(this.messagesPath(), pruned);

      const routes = await readJsonFile(this.routesPath(), {});
      // One-time backfill preserves every route still present in the legacy
      // text-heavy message cache.
      for (const [legacyMessageId, legacy] of Object.entries(messages)) {
        if (!legacy?.session_id || routes[legacyMessageId]) continue;
        routes[legacyMessageId] = {
          session_id: legacy.session_id,
          thread_id: legacy.thread_id,
          topic_key: legacy.topic_key || '',
          ts: Number(legacy.ts || 0),
          backend: legacy.backend || '',
        };
      }
      routes[String(messageId)] = {
        session_id: recorded.session_id,
        thread_id: recorded.thread_id,
        topic_key: recorded.topic_key,
        ts: recorded.ts,
        backend: recorded.backend,
      };
      const durableRoutes = Object.fromEntries(
        Object.entries(routes)
          .sort((a, b) => Number(a[1]?.ts || 0) - Number(b[1]?.ts || 0))
          .slice(-Math.max(Number(this.maxRouteRecords) || DEFAULT_MAX_ROUTE_RECORDS, 1000))
      );
      await writeJsonAtomic(this.routesPath(), durableRoutes);
    });
  }

  async deliver({ route, text, buttons, header = '' } = {}) {
    let resolved = await this.resolveTopic(route);
    let includeTtsButton = false;
    try {
      includeTtsButton = await this.ttsAvailable();
    } catch (error) {
      this.logger?.warn?.(`telegram tts unavailable: ${error.message || error}`);
    }
    const allButtons = [
      ...(Array.isArray(buttons) ? buttons : []),
      ...(includeTtsButton ? [{ text: '🔊 Listen', callback_data: 'tts' }] : []),
    ];
    let sent;
    try {
      sent = await this.sendMessagePages(text, { threadId: resolved.threadId, buttons: allButtons, header });
    } catch (error) {
      if (!isMissingThreadError(error)) throw error;
      resolved = await this.resolveTopic(route, { recreate: true });
      sent = await this.sendMessagePages(text, { threadId: resolved.threadId, buttons: allButtons, header });
    }
    for (const msgId of sent.messageIds) {
      await this.recordMessage(msgId, {
        session_id: route.sessionId || '',
        short: route.short || shortSessionId(route.sessionId),
        cwd: route.cwd || '',
        tmux_session: route.tmux_session || '',
        backend: route.backend || '',
        text,
        thread_id: resolved.threadId,
        topic_key: resolved.topicKey,
      });
    }
    return { msgId: sent.lastMessageId, messageIds: sent.messageIds, threadId: resolved.threadId, topicKey: resolved.topicKey };
  }
}

export function buildTelegramSender(options = {}) {
  return new TelegramSender(options);
}
