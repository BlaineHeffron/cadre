import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TelegramSender, pagedMessages } from '../modules/telegram/sender.mjs';
import { resolveTopicRoute } from '../modules/telegram/routing.mjs';

async function withTempState(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-telegram-sender-'));
  await writeFile(join(dir, 'config.env'), 'TELEGRAM_BOT_TOKEN="secret-token"\nTELEGRAM_CHAT_ID=-100123\nMAX_MSG_LENGTH=40\n');
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function buildFetchRecorder(calls) {
  return async (url, options = {}) => {
    calls.push({ url, body: JSON.parse(options.body || '{}'), options });
    if (url.endsWith('/createForumTopic')) {
      return response({ ok: true, result: { message_thread_id: 177, name: options?.body ? JSON.parse(options.body).name : 'topic' } });
    }
    return response({ ok: true, result: { message_id: 900 + calls.length, message_thread_id: 177 } });
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function route({
  session_id: sessionId = 'session-1',
  short = String(sessionId || '').slice(0, 8),
  cwd = '/tmp/project',
  tmux_session: tmuxSession = '',
  backend = '',
  name = '',
  bus_thread_id: busThreadId = '',
  bus_thread_title: busThreadTitle = '',
} = {}) {
  return {
    ...resolveTopicRoute({
      session: { id: sessionId, workDir: cwd, runtime: backend, name },
      busThread: busThreadId ? { id: busThreadId, title: busThreadTitle } : null,
    }),
    short,
    cwd,
    tmux_session: tmuxSession,
    backend,
  };
}

describe('telegram sender paging', () => {
  it('passes through short messages', () => {
    assert.deepEqual(pagedMessages('short', 10), ['short']);
  });

  it('splits long messages with part prefixes', () => {
    assert.deepEqual(pagedMessages('abcdefghij', 8), ['[1/10] a', '[2/10] b', '[3/10] c', '[4/10] d', '[5/10] e', '[6/10] f', '[7/10] g', '[8/10] h', '[9/10] i', '[10/10] j']);
  });

  it('prefers newline splits after the first quarter of the limit', () => {
    const pages = pagedMessages('aaa\nbbb\nccc\nddd\neee\nfff\nggg\nhhh\niii\njjj', 38);
    assert.ok(pages.length > 1);
    assert.match(pages[0], /^\[1\/\d+\] aaa\n$/);
  });

  it('splits without breaking multibyte characters', () => {
    assert.deepEqual(pagedMessages('🙂'.repeat(35), 34).slice(0, 2), ['[1/18] 🙂🙂', '[2/18] 🙂🙂']);
  });
});

describe('telegram sender API and state', () => {
  it('creates forum topics with the expected payload and parses the thread id', async () => {
    await withTempState(async (stateDir) => {
      const calls = [];
      const sender = new TelegramSender({ stateDir, fetchImpl: buildFetchRecorder(calls) });
      const result = await sender.createForumTopic('A'.repeat(140));

      assert.equal(result.threadId, 177);
      assert.equal(calls[0].url, 'https://api.telegram.org/botsecret-token/createForumTopic');
      assert.equal(calls[0].body.chat_id, -100123);
      assert.equal(calls[0].body.name.length, 128);
    });
  });

  it('creates session topics with bridge-compatible fields', async () => {
    await withTempState(async (stateDir) => {
      const calls = [];
      const sender = new TelegramSender({ stateDir, fetchImpl: buildFetchRecorder(calls) });
      const resolved = await sender.resolveTopic(route({
        session_id: 'session-123456',
        short: 'session-',
        cwd: '/tmp/project',
        tmux_session: 'codex-session-123456',
        backend: 'codex',
      }));

      assert.equal(resolved.topicKey, 'session:session-123456');
      assert.equal(resolved.threadId, 177);
      const topics = await readJson(join(stateDir, 'topics.json'));
      assert.deepEqual(topics['session:session-123456'], {
        thread_id: 177,
        name: 'session- project',
        cwd: '/tmp/project',
        tmux_session: 'codex-session-123456',
        scope_type: 'session',
        scope_id: 'session-123456',
        session_id: 'session-123456',
        backend: 'codex',
      });
    });
  });

  it('uses a session display name for new topic names', async () => {
    await withTempState(async (stateDir) => {
      const calls = [];
      const sender = new TelegramSender({ stateDir, fetchImpl: buildFetchRecorder(calls) });
      await sender.resolveTopic(route({
        session_id: 'session-abc',
        short: 'session-',
        name: 'Lead Implementer',
        cwd: '/tmp/project',
        tmux_session: 'codex-session-abc',
        backend: 'codex',
      }));

      assert.equal(calls[0].body.name, 'Lead Implementer');
      const topics = await readJson(join(stateDir, 'topics.json'));
      assert.equal(topics['session:session-abc'].name, 'Lead Implementer');
    });
  });

  it('reuses existing session topics without creating duplicates', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'session:session-1': { thread_id: 44, name: 'existing' },
      }));
      const calls = [];
      const sender = new TelegramSender({ stateDir, fetchImpl: buildFetchRecorder(calls) });
      const resolved = await sender.resolveTopic(route({ session_id: 'session-1' }));

      assert.equal(resolved.threadId, 44);
      assert.equal(calls.length, 0);
    });
  });

  it('sends messages to a forum thread and returns the last message id', async () => {
    await withTempState(async (stateDir) => {
      const calls = [];
      const sender = new TelegramSender({ stateDir, fetchImpl: buildFetchRecorder(calls) });
      const msgId = await sender.sendMessage('hello world', { threadId: 88 });

      assert.equal(msgId, 901);
      assert.equal(calls[0].url, 'https://api.telegram.org/botsecret-token/sendMessage');
      assert.equal(calls[0].body.message_thread_id, 88);
      assert.equal(calls[0].body.text, 'hello world');
    });
  });

  it('sends readable Unicode math while preserving canonical LaTeX in message state', async () => {
    await withTempState(async (stateDir) => {
      const calls = [];
      const sender = new TelegramSender({ stateDir, fetchImpl: buildFetchRecorder(calls) });
      await sender.deliver({
        route: route({ session_id: 'session-math', short: 'session-' }),
        text: 'Result: $\\frac{x_1}{2} \\leq \\pi$.',
      });

      assert.equal(calls[1].body.text, 'Result: (x₁)/(2) ≤ π.');
      const messages = await readJson(join(stateDir, 'messages.json'));
      assert.equal(messages['902'].text, 'Result: $\\frac{x_1}{2} \\leq \\pi$.');
    });
  });

  it('delivers deeply nested LaTeX as canonical text instead of dropping the message', async () => {
    await withTempState(async (stateDir) => {
      const calls = [];
      const sender = new TelegramSender({ stateDir, fetchImpl: buildFetchRecorder(calls) });
      sender.loadConfig = async () => ({
        botToken: 'secret-token',
        chatId: '-100123',
        maxMsgLength: 50_000,
      });
      let expression = 'x';
      for (let depth = 0; depth < 2_500; depth += 1) expression = `\\frac{1}{${expression}}`;
      const canonical = `$${expression}$`;

      await sender.sendMessage(canonical, { threadId: 88 });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.text, canonical);
    });
  });

  it('falls back to canonical text when math conversion fails unexpectedly', async () => {
    await withTempState(async (stateDir) => {
      const calls = [];
      const warnings = [];
      const sender = new TelegramSender({
        stateDir,
        fetchImpl: buildFetchRecorder(calls),
        mathToUnicode() {
          throw new Error('conversion exploded');
        },
        logger: { warn(message) { warnings.push(message); } },
      });

      await sender.sendMessage('canonical $x$', { threadId: 88 });

      assert.equal(calls[0].body.text, 'canonical $x$');
      assert.match(warnings[0], /sending canonical text/);
    });
  });

  it('attaches answer buttons to the last page only', async () => {
    await withTempState(async (stateDir) => {
      const calls = [];
      const sender = new TelegramSender({ stateDir, fetchImpl: buildFetchRecorder(calls) });
      await sender.sendMessage('a'.repeat(50), {
        threadId: 88,
        buttons: [
          { text: 'Yes', callback_data: 'answer:1' },
          { text: 'No', callback_data: 'answer:2' },
        ],
      });

      assert.ok(calls.length > 1);
      assert.equal(calls[0].body.reply_markup, undefined);
      assert.deepEqual(calls.at(-1).body.reply_markup, {
        inline_keyboard: [
          [{ text: 'Yes', callback_data: 'answer:1' }],
          [{ text: 'No', callback_data: 'answer:2' }],
        ],
      });
    });
  });

  it('rejects Telegram callback data over 64 bytes', async () => {
    await withTempState(async (stateDir) => {
      const sender = new TelegramSender({ stateDir, fetchImpl: buildFetchRecorder([]) });
      await assert.rejects(
        () => sender.sendMessage('hello', { buttons: [{ text: 'Too long', callback_data: `answer:${'x'.repeat(70)}` }] }),
        /callback_data exceeds 64 bytes/
      );
    });
  });

  it('records messages with bridge-compatible fields and prunes to 1000 newest entries', async () => {
    await withTempState(async (stateDir) => {
      const existing = {};
      for (let index = 0; index < 1005; index += 1) {
        existing[String(index)] = {
          session_id: 'old-session',
          thread_id: 77,
          topic_key: 'session:old-session',
          backend: 'codex',
          ts: index,
        };
      }
      await writeFile(join(stateDir, 'messages.json'), JSON.stringify(existing));
      const sender = new TelegramSender({ stateDir, now: () => 2_000_000, fetchImpl: buildFetchRecorder([]) });

      await sender.recordMessage(2000, {
        session_id: 'session-abc',
        short: 'session-',
        cwd: '/tmp/project',
        tmux_session: 'tmux-session',
        thread_id: 77,
        topic_key: 'session:session-abc',
        backend: 'claude',
      });

      const messages = await readJson(join(stateDir, 'messages.json'));
      assert.equal(Object.keys(messages).length, 1000);
      assert.equal(messages['0'], undefined);
      assert.deepEqual(messages['2000'], {
        session_id: 'session-abc',
        text: '',
        short: 'session-',
        cwd: '/tmp/project',
        tmux_session: 'tmux-session',
        thread_id: 77,
        topic_key: 'session:session-abc',
        ts: 2000,
        backend: 'claude',
      });
      const routes = await readJson(join(stateDir, 'message_routes.json'));
      assert.equal(routes['0'].session_id, 'old-session');
      assert.equal(routes['2000'].session_id, 'session-abc');
    });
  });

  it('delivers by resolving a topic, sending, and recording message state', async () => {
    await withTempState(async (stateDir) => {
      const calls = [];
      const sender = new TelegramSender({ stateDir, now: () => 123_000, fetchImpl: buildFetchRecorder(calls) });
      const result = await sender.deliver({
        route: route({
          session_id: 'session-xyz',
          short: 'session-',
          cwd: '/tmp/project',
          tmux_session: 'codex-session-xyz',
          backend: 'codex',
        }),
        header: '[codex session- codex-session-xyz]',
        text: 'hello',
      });

      assert.deepEqual(result, { msgId: 902, messageIds: [902], threadId: 177, topicKey: 'session:session-xyz' });
      assert.equal(calls.length, 2);
      assert.equal(calls[1].body.text, '[codex session- codex-session-xyz]\nhello');
      const messages = await readJson(join(stateDir, 'messages.json'));
      assert.equal(messages['902'].topic_key, 'session:session-xyz');
      assert.equal(messages['902'].thread_id, 177);
    });
  });

  it('records every paged Telegram message id for reply-to routing', async () => {
    await withTempState(async (stateDir) => {
      const calls = [];
      const sender = new TelegramSender({ stateDir, now: () => 123_000, fetchImpl: buildFetchRecorder(calls) });
      const result = await sender.deliver({
        route: route({
          session_id: 'session-long',
          short: 'session-',
          cwd: '/tmp/project',
          tmux_session: 'claude-session-long',
          backend: 'claude',
        }),
        header: '[claude session- claude-session-long]',
        text: 'x'.repeat(80),
      });

      assert.ok(result.messageIds.length > 1);
      const messages = await readJson(join(stateDir, 'messages.json'));
      for (const msgId of result.messageIds) {
        assert.equal(messages[String(msgId)].session_id, 'session-long');
        assert.equal(messages[String(msgId)].tmux_session, 'claude-session-long');
      }
      assert.match(calls[1].body.text, /^\[claude session- claude-session-long\]\n\[1\/\d+\] /);
    });
  });

  it('scopes topics to the bus thread and names them after the thread title', async () => {
    await withTempState(async (stateDir) => {
      const calls = [];
      const sender = new TelegramSender({ stateDir, fetchImpl: buildFetchRecorder(calls) });
      const resolved = await sender.resolveTopic(route({
        session_id: 'session-1',
        name: 'Session Name',
        bus_thread_id: 'thr_42',
        bus_thread_title: 'telegram bus',
        cwd: '/tmp/project',
        backend: 'claude',
      }));

      assert.equal(resolved.topicKey, 'thread:thr_42');
      assert.equal(calls[0].body.name, 'telegram bus');
      const topics = await readJson(join(stateDir, 'topics.json'));
      assert.equal(topics['thread:thr_42'].scope_type, 'thread');
      assert.equal(topics['thread:thr_42'].scope_id, 'thr_42');
      assert.equal(topics['thread:thr_42'].session_id, 'session-1');
    });
  });

  it('keeps bus thread scope even when a session-scope hint is present', async () => {
    await withTempState(async (stateDir) => {
      const calls = [];
      const sender = new TelegramSender({ stateDir, fetchImpl: buildFetchRecorder(calls) });
      const resolved = await sender.resolveTopic(route({
        session_id: 'session-1',
        name: 'Session Name',
        bus_thread_id: 'thr_42',
        bus_thread_title: 'telegram bus',
        cwd: '/tmp/project',
        backend: 'claude',
      }));

      assert.equal(resolved.topicKey, 'thread:thr_42');
      assert.equal(calls[0].body.name, 'telegram bus');
      const topics = await readJson(join(stateDir, 'topics.json'));
      assert.equal(topics['thread:thr_42'].scope_type, 'thread');
      assert.equal(topics['thread:thr_42'].scope_id, 'thr_42');
      assert.equal(topics['session:session-1'], undefined);
    });
  });

  it('does not rename a shared thread topic from per-session names', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'thread:thr_42': { thread_id: 44, name: 'thread topic', scope_type: 'thread', scope_id: 'thr_42', session_id: 'session-a' },
      }));
      const calls = [];
      const sender = new TelegramSender({ stateDir, fetchImpl: buildFetchRecorder(calls) });
      await sender.resolveTopic(route({
        session_id: 'session-b',
        name: 'Session B',
        bus_thread_id: 'thr_42',
        bus_thread_title: '',
      }));

      assert.equal(calls.length, 0);
      const topics = await readJson(join(stateDir, 'topics.json'));
      assert.equal(topics['thread:thr_42'].name, 'thread topic');
      assert.equal(topics['thread:thr_42'].session_id, 'session-b');
    });
  });

  it('migrates a legacy session topic into the thread scope instead of creating a duplicate', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'session:session-1': { thread_id: 44, name: 'old session topic', scope_type: 'session', scope_id: 'session-1', session_id: 'session-1' },
      }));
      const calls = [];
      const sender = new TelegramSender({ stateDir, fetchImpl: buildFetchRecorder(calls) });
      const resolved = await sender.resolveTopic(route({
        session_id: 'session-1',
        bus_thread_id: 'thr_7',
        bus_thread_title: 'shared work',
      }));

      assert.equal(resolved.threadId, 44);
      assert.equal(resolved.topicKey, 'thread:thr_7');
      assert.equal(calls.filter((call) => call.url.endsWith('/createForumTopic')).length, 0);
      assert.equal(calls.filter((call) => call.url.endsWith('/editForumTopic')).length, 1);
      const topics = await readJson(join(stateDir, 'topics.json'));
      assert.equal(topics['session:session-1'], undefined);
      assert.equal(topics['thread:thr_7'].thread_id, 44);
      assert.equal(topics['thread:thr_7'].name, 'shared work');
    });
  });

  it('renames an existing topic when the explicit display name changes', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'session:session-1': { thread_id: 44, name: 'old name', session_id: 'session-1' },
      }));
      const calls = [];
      const sender = new TelegramSender({ stateDir, fetchImpl: buildFetchRecorder(calls) });
      const resolved = await sender.resolveTopic(route({ session_id: 'session-1', name: 'new name' }));

      assert.equal(resolved.threadId, 44);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.endsWith('/editForumTopic'));
      assert.equal(calls[0].body.name, 'new name');
      const topics = await readJson(join(stateDir, 'topics.json'));
      assert.equal(topics['session:session-1'].name, 'new name');
    });
  });

  it('recreates the topic and retries when Telegram reports the thread missing', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'session:session-1': { thread_id: 44, name: 'gone', session_id: 'session-1' },
      }));
      const calls = [];
      const sender = new TelegramSender({
        stateDir,
        fetchImpl: async (url, options = {}) => {
          calls.push({ url, body: JSON.parse(options.body || '{}') });
          if (url.endsWith('/sendMessage') && calls.filter((c) => c.url.endsWith('/sendMessage')).length === 1) {
            return response({ ok: false, description: 'Bad Request: message thread not found' }, 400);
          }
          if (url.endsWith('/createForumTopic')) {
            return response({ ok: true, result: { message_thread_id: 555, name: 'gone' } });
          }
          return response({ ok: true, result: { message_id: 901 } });
        },
      });

      const result = await sender.deliver({ route: route({ session_id: 'session-1' }), text: 'hello' });
      assert.equal(result.threadId, 555);
      const topics = await readJson(join(stateDir, 'topics.json'));
      assert.equal(topics['session:session-1'].thread_id, 555);
    });
  });

  it('retries after a 429 using retry_after', async () => {
    await withTempState(async (stateDir) => {
      const sleeps = [];
      let attempts = 0;
      const sender = new TelegramSender({
        stateDir,
        sleep: async (ms) => sleeps.push(ms),
        fetchImpl: async () => {
          attempts += 1;
          if (attempts === 1) {
            return response({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 3 } }, 429);
          }
          return response({ ok: true, result: { message_id: 901 } });
        },
      });

      const msgId = await sender.sendMessage('hello', { threadId: 5 });
      assert.equal(msgId, 901);
      assert.deepEqual(sleeps, [3000]);
    });
  });

  it('retries Telegram POST requests after 5xx and network failures', async () => {
    await withTempState(async (stateDir) => {
      const sleeps = [];
      let attempts = 0;
      const sender = new TelegramSender({
        stateDir,
        retryBaseMs: 25,
        sleep: async (ms) => sleeps.push(ms),
        fetchImpl: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('socket reset');
          if (attempts === 2) return response({ ok: false, description: 'Bad Gateway' }, 502);
          return response({ ok: true, result: { message_id: 901 } });
        },
      });

      assert.equal(await sender.sendMessage('hello', { threadId: 5 }), 901);
      assert.equal(attempts, 3);
      assert.deepEqual(sleeps, [25, 50]);
    });
  });

  it('retries long-poll GET requests after a Telegram 5xx', async () => {
    await withTempState(async (stateDir) => {
      const sleeps = [];
      const signals = [];
      let attempts = 0;
      const sender = new TelegramSender({
        stateDir,
        retryBaseMs: 20,
        sleep: async (ms) => sleeps.push(ms),
        fetchImpl: async (_url, options = {}) => {
          signals.push(options.signal);
          attempts += 1;
          if (attempts === 1) return response({ ok: false, description: 'Bad Gateway' }, 502);
          return response({ ok: true, result: [{ update_id: 10 }] });
        },
      });

      assert.deepEqual(await sender.getUpdates({ offset: 10, timeout: 5 }), [{ update_id: 10 }]);
      assert.equal(attempts, 2);
      assert.deepEqual(sleeps, [20]);
      assert.ok(signals.every((signal) => signal instanceof AbortSignal));
    });
  });

  it('appends a TTS listen button to delivered messages', async () => {
    await withTempState(async (stateDir) => {
      const calls = [];
      const sender = new TelegramSender({ stateDir, fetchImpl: buildFetchRecorder(calls), ttsAvailable: async () => true });
      await sender.deliver({ route: route({ session_id: 'session-tts' }), text: 'hello' });

      const sendCall = calls.find((call) => call.url.endsWith('/sendMessage'));
      assert.deepEqual(sendCall.body.reply_markup.inline_keyboard.at(-1), [
        { text: '🔊 Listen', callback_data: 'tts' },
      ]);
      const messages = await readJson(join(stateDir, 'messages.json'));
      const entry = Object.values(messages).find((value) => value.session_id === 'session-tts');
      assert.equal(entry.text, 'hello');
    });
  });

  it('omits the TTS listen button when speech synthesis is unavailable', async () => {
    await withTempState(async (stateDir) => {
      const calls = [];
      const sender = new TelegramSender({ stateDir, fetchImpl: buildFetchRecorder(calls), ttsAvailable: async () => false });
      await sender.deliver({ route: route({ session_id: 'session-no-tts' }), text: 'hello' });

      const sendCall = calls.find((call) => call.url.endsWith('/sendMessage'));
      assert.equal(sendCall.body.reply_markup, undefined);
    });
  });

  it('does not write bot tokens to logger output', async () => {
    await withTempState(async (stateDir) => {
      const logs = [];
      const sender = new TelegramSender({
        stateDir,
        logger: { warn: (value) => logs.push(String(value)), error: (value) => logs.push(String(value)) },
        fetchImpl: async () => response({ ok: false, description: 'bad token secret-token' }),
      });

      let caught = null;
      await assert.rejects(() => sender.sendMessage('hello'), (error) => {
        caught = error;
        return /sendMessage failed/.test(error.message);
      });
      assert.equal(caught.message.includes('secret-token'), false);
      assert.equal(logs.some((line) => line.includes('secret-token')), false);
    });
  });
});
