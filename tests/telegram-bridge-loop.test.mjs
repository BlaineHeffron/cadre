import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultSendSessionInput, TelegramBridgeLoop } from '../modules/telegram/bridge-loop.mjs';
import { TelegramSender } from '../modules/telegram/sender.mjs';

async function withTempState(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-telegram-bridge-'));
  await writeFile(join(dir, 'config.env'), 'TELEGRAM_BOT_TOKEN="secret-token"\nTELEGRAM_CHAT_ID=-100123\n');
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
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

function session(overrides = {}) {
  return {
    id: 'session-123456',
    tmuxSession: 'codex-session-123456',
    workDir: '/tmp/project',
    runtime: 'codex',
    ...overrides,
  };
}

function selectionState(revision = 3, fingerprint = `selection-${revision}`) {
  return {
    revision,
    status: 'blocked',
    interaction: { kind: 'selection', fingerprint },
  };
}

function buildLoop({ stateDir, inputs, sessions = [session()], fetchCalls = [], voices = [], speeches = [] }) {
  const sender = new TelegramSender({
    stateDir,
    fetchImpl: async (url, options = {}) => {
      const isJson = typeof options.body === 'string';
      fetchCalls.push({ url, body: isJson ? JSON.parse(options.body) : null, options });
      if (url.endsWith('/sendVoice')) voices.push(options.body);
      return response({ ok: true, result: true });
    },
  });
  return new TelegramBridgeLoop({
    sender,
    stateDir,
    listSessions: async () => sessions,
    sendSessionInput: async (input) => {
      inputs.push(input);
      return { ok: true };
    },
    synthesizeSpeech: async (text) => {
      speeches.push(text);
      return Buffer.from('OGG');
    },
    now: () => 5000,
    logger: { warn() {} },
  });
}

describe('telegram bridge inbound loop', () => {
  it('routes Pi/OpenCode Go free text to the Pi session API', async () => {
    const calls = [];
    await defaultSendSessionInput({
      session: { id: '34845546', runtime: 'pi' },
      text: 'continue',
      requestImpl: async (path, options) => {
        calls.push({ path, options });
        return { statusCode: 200, payload: { ok: true } };
      },
    });

    assert.equal(calls[0].path, '/api/pi/sessions/34845546/input');
    assert.deepEqual(calls[0].options.body, {
      text: 'continue',
      enter: true,
      source: 'telegram_answer',
    });
  });

  it('omits interaction guards for ordinary free-text session input', async () => {
    let request = null;
    await defaultSendSessionInput({
      session: session({
        state: {
          revision: 7,
          interaction: { kind: 'free_text', fingerprint: 'prompt-7' },
        },
      }),
      text: 'Continue',
      requestImpl: async (path, options) => {
        request = { path, options };
        return { statusCode: 200, payload: { ok: true } };
      },
    });

    assert.equal(request.options.body.text, 'Continue');
    assert.equal('expectedFingerprint' in request.options.body, false);
  });

  it('routes Codex selection answers through guarded dialog keys', async () => {
    let request = null;
    await defaultSendSessionInput({
      session: session({
        state: {
          revision: 9,
          interaction: { kind: 'selection', fingerprint: 'selection-9' },
        },
      }),
      text: '2',
      interactionAnswer: true,
      requestImpl: async (path, options) => {
        request = { path, body: options.body };
        return { statusCode: 200, payload: { ok: true } };
      },
    });

    assert.equal(request.path, '/api/codex/sessions/session-123456/keys');
    assert.deepEqual(request.body, {
      keys: '2',
      expectedRevision: 9,
      expectedFingerprint: 'selection-9',
      expectedInteractionKind: 'selection',
    });
  });

  it('keeps Codex non-selection answers as submitted text', async () => {
    let request = null;
    await defaultSendSessionInput({
      session: session({
        state: {
          revision: 10,
          interaction: { kind: 'confirmation', fingerprint: 'confirmation-10' },
        },
      }),
      text: 'y',
      interactionAnswer: true,
      requestImpl: async (path, options) => {
        request = { path, body: options.body };
        return { statusCode: 200, payload: { ok: true } };
      },
    });

    assert.equal(request.path, '/api/codex/sessions/session-123456/input');
    assert.deepEqual(request.body, {
      text: 'y',
      enter: true,
      source: 'telegram_answer',
      expectedRevision: 10,
      expectedFingerprint: 'confirmation-10',
      expectedInteractionKind: 'confirmation',
    });
  });

  it('does not attach interaction guards to plain Telegram text', async () => {
    let body = null;
    await defaultSendSessionInput({
      session: session({
        state: {
          revision: 9,
          interaction: { kind: 'guardrail', fingerprint: 'guardrail-9' },
        },
      }),
      text: 'Continue after verification',
      requestImpl: async (_path, options) => {
        body = options.body;
        return { statusCode: 200, payload: { ok: true } };
      },
    });

    assert.equal(body.expectedRevision, undefined);
    assert.equal(body.expectedFingerprint, undefined);
    assert.equal(body.expectedInteractionKind, undefined);
  });

  it('routes Claude interaction answers through the guarded keys endpoint', async () => {
    let request = null;
    await defaultSendSessionInput({
      session: session({
        runtime: 'claude',
        state: {
          revision: 12,
          interaction: { kind: 'selection', fingerprint: 'selection-12' },
        },
      }),
      text: '2',
      interactionAnswer: true,
      requestImpl: async (path, options) => {
        request = { path, body: options.body };
        return { statusCode: 200, payload: { ok: true } };
      },
    });

    assert.equal(request.path, '/api/claude/sessions/session-123456/keys');
    assert.deepEqual(request.body, {
      keys: '2',
      expectedRevision: 12,
      expectedFingerprint: 'selection-12',
      expectedInteractionKind: 'selection',
    });
  });

  it('loads the legacy update offset when bridge_state.json is absent', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, '.last_update_id'), '123456789\n');
      const inputs = [];
      const loop = buildLoop({ stateDir, inputs });

      assert.equal(await loop.loadOffset(), 123456789);
      assert.equal(loop.status().offset, 123456789);
    });
  });

  it('routes a forum-thread text reply to the mapped session', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'session:session-123456': {
          thread_id: 177,
          session_id: 'session-123456',
          cwd: '/tmp/project',
          tmux_session: 'codex-session-123456',
          backend: 'codex',
        },
      }));
      const inputs = [];
      const loop = buildLoop({ stateDir, inputs });

      const handled = await loop.handleUpdate({
        update_id: 10,
        message: {
          message_id: 901,
          chat: { id: -100123 },
          message_thread_id: 177,
          text: 'Use the direct fix',
        },
      });

      assert.equal(handled, true);
      assert.equal(inputs.length, 1);
      assert.equal(inputs[0].session.id, 'session-123456');
      assert.equal(inputs[0].text, 'Use the direct fix');

      const messages = await readJson(join(stateDir, 'messages.json'));
      assert.equal(messages['901'].session_id, 'session-123456');
      assert.equal(messages['901'].text, 'Use the direct fix');
      assert.equal(existsSync(join(stateDir, 'sent.json')), false);
      const processed = await readJson(join(stateDir, 'processed_updates.json'));
      assert.equal(processed['10'].session_id, 'session-123456');
    });
  });

  it('routes callback answer data and clears the inline keyboard', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'session:session-123456': { thread_id: 177, session_id: 'session-123456', backend: 'codex' },
      }));
      await writeFile(join(stateDir, 'sent.json'), JSON.stringify({
        'session-123456': {
          message_id: 902,
          thread_id: 177,
          interaction_revision: 3,
          interaction_kind: 'selection',
          interaction_fingerprint: 'selection-3',
        },
      }));
      const inputs = [];
      const fetchCalls = [];
      const loop = buildLoop({
        stateDir,
        inputs,
        fetchCalls,
        // Unrelated state evidence can advance the canonical revision while the
        // exact Telegram-rendered interaction remains current.
        sessions: [session({ state: selectionState(4, 'selection-after-restart') })],
      });

      const handled = await loop.handleUpdate({
        update_id: 11,
        callback_query: {
          id: 'cb-1',
          data: 'answer:2',
          message: {
            message_id: 902,
            chat: { id: -100123 },
            message_thread_id: 177,
            text: 'Choose one',
          },
        },
      });

      assert.equal(handled, true);
      assert.equal(inputs[0].text, '2');
      assert.equal(inputs[0].interactionAnswer, true);
      assert.deepEqual(inputs[0].interactionExpectation, {
        revision: 4,
        kind: 'selection',
        fingerprint: 'selection-after-restart',
      });
      assert.equal(fetchCalls[0].url, 'https://api.telegram.org/botsecret-token/answerCallbackQuery');
      assert.equal(fetchCalls[0].body.callback_query_id, 'cb-1');
      assert.equal(fetchCalls[1].url, 'https://api.telegram.org/botsecret-token/editMessageReplyMarkup');
      assert.deepEqual(fetchCalls[1].body.reply_markup, { inline_keyboard: [] });
    });
  });

  it('expires a callback when the prompt has already cleared', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'session:session-123456': { thread_id: 177, session_id: 'session-123456', backend: 'codex' },
      }));
      await writeFile(join(stateDir, 'sent.json'), JSON.stringify({
        'session-123456': {
          message_id: 902,
          interaction_revision: 3,
          interaction_kind: 'selection',
          interaction_fingerprint: 'selection-3',
        },
      }));
      const inputs = [];
      const loop = buildLoop({
        stateDir,
        inputs,
        sessions: [session({
          state: { revision: 4, status: 'ready', interaction: { kind: 'free_text', fingerprint: 'prompt-4' } },
        })],
      });

      assert.equal(await loop.handleUpdate({
        update_id: 12,
        callback_query: {
          id: 'cb-cleared',
          data: 'answer:2',
          message: { message_id: 902, chat: { id: -100123 }, message_thread_id: 177, text: 'Choose one' },
        },
      }), false);
      assert.equal(inputs.length, 0);
      assert.equal(loop.status().lastIgnoredUpdate.reason, 'stale_answer_callback');
    });
  });

  it('expires a callback when a different blocking dialog is current', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'session:session-123456': { thread_id: 177, session_id: 'session-123456', backend: 'codex' },
      }));
      await writeFile(join(stateDir, 'sent.json'), JSON.stringify({
        'session-123456': {
          message_id: 902,
          interaction_revision: 3,
          interaction_kind: 'selection',
          interaction_fingerprint: 'selection-3',
        },
      }));
      const inputs = [];
      const loop = buildLoop({
        stateDir,
        inputs,
        sessions: [session({
          state: { revision: 4, status: 'blocked', interaction: { kind: 'confirmation', fingerprint: 'confirmation-4' } },
        })],
      });

      assert.equal(await loop.handleUpdate({
        update_id: 13,
        callback_query: {
          id: 'cb-replaced',
          data: 'answer:2',
          message: { message_id: 902, chat: { id: -100123 }, message_thread_id: 177, text: 'Choose one' },
        },
      }), false);
      assert.equal(inputs.length, 0);
      assert.equal(loop.status().lastIgnoredUpdate.reason, 'stale_answer_callback');
    });
  });

  it('does not send a visible ack for routed text', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'session:session-123456': { thread_id: 177, session_id: 'session-123456', backend: 'codex' },
      }));
      const inputs = [];
      const fetchCalls = [];
      const sender = new TelegramSender({
        stateDir,
        fetchImpl: async (url, options = {}) => {
          fetchCalls.push({ url, body: JSON.parse(options.body || '{}') });
          return response({ ok: true, result: { message_id: 910 } });
        },
      });
      const loop = new TelegramBridgeLoop({
        sender,
        stateDir,
        listSessions: async () => [session({ state: { state: 'waiting_for_input' } })],
        sendSessionInput: async (input) => {
          inputs.push(input);
          return { ok: true };
        },
        now: () => 5000,
        logger: { warn() {} },
      });

      assert.equal(await loop.handleUpdate({
        update_id: 15,
        message: {
          message_id: 906,
          chat: { id: -100123 },
          message_thread_id: 177,
          text: 'queued input',
        },
      }), true);
      assert.equal(inputs[0].text, 'queued input');
      assert.equal(fetchCalls.some((call) => call.url.endsWith('/sendMessage')), false);
    });
  });

  it('routes callback answers by clicked message before shared thread topic fallback', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'thread:thr_9': { thread_id: 300, scope_type: 'thread', scope_id: 'thr_9', session_id: 'codex-session', backend: 'codex' },
      }));
      await writeFile(join(stateDir, 'messages.json'), JSON.stringify({
        902: { session_id: 'claude-session', thread_id: 300, topic_key: 'thread:thr_9', backend: 'claude' },
      }));
      await writeFile(join(stateDir, 'sent.json'), JSON.stringify({
        'claude-session': {
          message_id: 902,
          thread_id: 300,
          interaction_revision: 3,
          interaction_kind: 'selection',
          interaction_fingerprint: 'selection-3',
        },
      }));
      const inputs = [];
      const fetchCalls = [];
      const loop = new TelegramBridgeLoop({
        sender: new TelegramSender({
          stateDir,
          fetchImpl: async (url, options = {}) => {
            fetchCalls.push({ url, body: typeof options.body === 'string' ? JSON.parse(options.body) : null });
            return response({ ok: true, result: true });
          },
        }),
        stateDir,
        listSessions: async () => [
          session({ id: 'codex-session', runtime: 'codex', busThreadId: 'thr_9' }),
          session({ id: 'claude-session', runtime: 'claude', busThreadId: 'thr_9', state: selectionState() }),
        ],
        sendSessionInput: async (input) => {
          inputs.push(input);
          return { ok: true };
        },
        now: () => 5000,
        logger: { warn() {} },
      });

      assert.equal(await loop.handleUpdate({
        update_id: 15,
        callback_query: {
          id: 'cb-2',
          data: 'answer:1',
          message: {
            message_id: 902,
            chat: { id: -100123 },
            message_thread_id: 300,
            text: 'Pick one',
          },
        },
      }), true);

      assert.equal(inputs.length, 1);
      assert.equal(inputs[0].session.id, 'claude-session');
      assert.equal(inputs[0].session.runtime, 'claude');
      assert.equal(inputs[0].text, '1');
      assert.ok(fetchCalls.some((call) => call.url.endsWith('/answerCallbackQuery')));
    });
  });

  it('ignores stale callback answers after the prompt was consumed', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'thread:thr_9': { thread_id: 300, scope_type: 'thread', scope_id: 'thr_9', session_id: 'claude-session', backend: 'claude' },
      }));
      await writeFile(join(stateDir, 'messages.json'), JSON.stringify({
        902: { session_id: 'claude-session', thread_id: 300, topic_key: 'thread:thr_9', backend: 'claude' },
      }));
      await writeFile(join(stateDir, 'sent.json'), JSON.stringify({
        'claude-session': { message_id: 902, thread_id: 300, answer_consumed: true },
      }));
      const inputs = [];
      const fetchCalls = [];
      const loop = new TelegramBridgeLoop({
        sender: new TelegramSender({
          stateDir,
          fetchImpl: async (url, options = {}) => {
            fetchCalls.push({ url, body: typeof options.body === 'string' ? JSON.parse(options.body) : null });
            return response({ ok: true, result: true });
          },
        }),
        stateDir,
        listSessions: async () => [
          session({ id: 'codex-session', runtime: 'codex', busThreadId: 'thr_9' }),
          session({ id: 'claude-session', runtime: 'claude', busThreadId: 'thr_9' }),
        ],
        sendSessionInput: async (input) => {
          inputs.push(input);
          return { ok: true };
        },
        now: () => 5000,
        logger: { warn() {} },
      });

      assert.equal(await loop.handleUpdate({
        update_id: 16,
        callback_query: {
          id: 'cb-stale',
          data: 'answer:1',
          message: {
            message_id: 902,
            chat: { id: -100123 },
            message_thread_id: 300,
            text: 'Pick one',
          },
        },
      }), false);

      assert.equal(inputs.length, 0);
      assert.equal(loop.status().lastIgnoredUpdate.reason, 'stale_answer_callback');
      assert.ok(fetchCalls.some((call) => call.url.endsWith('/answerCallbackQuery')));
      assert.ok(fetchCalls.some((call) => call.url.endsWith('/editMessageReplyMarkup')));
      const processed = await readJson(join(stateDir, 'processed_updates.json'));
      assert.equal(processed['16'].stale_answer, true);
    });
  });

  it('dedupes processed update ids', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'session:session-123456': { thread_id: 177, session_id: 'session-123456', backend: 'codex' },
      }));
      const inputs = [];
      const loop = buildLoop({ stateDir, inputs });
      const update = {
        update_id: 12,
        message: {
          message_id: 903,
          chat: { id: -100123 },
          message_thread_id: 177,
          text: 'Only once',
        },
      };

      assert.equal(await loop.handleUpdate(update), true);
      assert.equal(await loop.handleUpdate(update), false);
      assert.equal(inputs.length, 1);
    });
  });

  it('handles tts callbacks by sending a voice reply instead of session input', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'messages.json'), JSON.stringify({
        902: { session_id: 'session-123456', text: 'stored message text', thread_id: 177 },
      }));
      const inputs = [];
      const fetchCalls = [];
      const voices = [];
      const speeches = [];
      const loop = buildLoop({ stateDir, inputs, fetchCalls, voices, speeches });

      const handled = await loop.handleUpdate({
        update_id: 21,
        callback_query: {
          id: 'cb-tts',
          data: 'tts',
          message: {
            message_id: 902,
            chat: { id: -100123 },
            message_thread_id: 177,
            text: 'truncated telegram text',
          },
        },
      });

      assert.equal(handled, true);
      assert.equal(inputs.length, 0);
      await loop.drainTtsJobs();
      assert.deepEqual(speeches, ['stored message text']);
      assert.equal(voices.length, 1);
      assert.ok(fetchCalls.some((call) => call.url.endsWith('/answerCallbackQuery')));
      assert.ok(fetchCalls.some((call) => call.url.endsWith('/sendVoice')));
      const processed = await readJson(join(stateDir, 'processed_updates.json'));
      assert.equal(processed['21'].tts, true);
    });
  });

  it('resolves thread-scoped topics to a live bus participant when the recorded session is gone', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'thread:thr_9': { thread_id: 300, scope_type: 'thread', scope_id: 'thr_9', session_id: 'dead-session', backend: 'codex' },
      }));
      const inputs = [];
      const loop = new TelegramBridgeLoop({
        sender: new TelegramSender({ stateDir, fetchImpl: async () => response({ ok: true, result: true }) }),
        stateDir,
        listSessions: async () => [session({ id: 'live-session', busThreadId: 'thr_9' })],
        sendSessionInput: async (input) => {
          inputs.push(input);
          return { ok: true };
        },
        now: () => 5000,
        logger: { warn() {} },
      });

      assert.equal(await loop.handleUpdate({
        update_id: 22,
        message: {
          message_id: 906,
          chat: { id: -100123 },
          message_thread_id: 300,
          text: 'route to live participant',
        },
      }), true);
      assert.equal(inputs[0].session.id, 'live-session');
    });
  });

  it('refuses to guess a target for freeform text in a shared topic', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'thread:thr_9': { thread_id: 300, scope_type: 'thread', scope_id: 'thr_9', session_id: 'session-a', backend: 'codex' },
      }));
      await writeFile(join(stateDir, 'messages.json'), JSON.stringify({
        900: { session_id: 'session-a', thread_id: 300, topic_key: 'thread:thr_9', ts: 100, backend: 'codex' },
        901: { session_id: 'session-b', thread_id: 300, topic_key: 'thread:thr_9', ts: 200, backend: 'codex' },
      }));
      const inputs = [];
      const fetchCalls = [];
      const loop = new TelegramBridgeLoop({
        sender: new TelegramSender({
          stateDir,
          fetchImpl: async (url, options = {}) => {
            fetchCalls.push({ url, body: JSON.parse(options.body || '{}') });
            return response({ ok: true, result: { message_id: 999 } });
          },
        }),
        stateDir,
        listSessions: async () => [
          session({ id: 'session-a', busThreadId: 'thr_9' }),
          session({ id: 'session-b', busThreadId: 'thr_9' }),
        ],
        sendSessionInput: async (input) => {
          inputs.push(input);
          return { ok: true };
        },
        now: () => 5000,
        logger: { warn() {} },
      });

      assert.equal(await loop.handleUpdate({
        update_id: 23,
        message: {
          message_id: 909,
          chat: { id: -100123 },
          message_thread_id: 300,
          text: 'route to latest speaker',
        },
      }), false);
      assert.equal(inputs.length, 0);
      assert.equal(loop.status().lastIgnoredUpdate.reason, 'unresolved_session');
      assert.equal(fetchCalls.at(-1).body.text, 'Multiple live sessions share this topic. Reply to a specific agent message.');
    });
  });

  it('routes replies through the durable message-route index after text cache pruning', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'thread:thr_9': {
          thread_id: 300,
          scope_type: 'thread',
          scope_id: 'thr_9',
          session_id: 'session-b',
          backend: 'codex',
        },
      }));
      await writeFile(join(stateDir, 'messages.json'), JSON.stringify({}));
      await writeFile(join(stateDir, 'message_routes.json'), JSON.stringify({
        700: {
          session_id: 'session-a',
          thread_id: 300,
          topic_key: 'thread:thr_9',
          ts: 1,
          backend: 'codex',
        },
      }));
      const inputs = [];
      const loop = new TelegramBridgeLoop({
        sender: new TelegramSender({
          stateDir,
          fetchImpl: async () => response({ ok: true, result: { message_id: 999 } }),
        }),
        stateDir,
        listSessions: async () => [
          session({ id: 'session-a', busThreadId: 'thr_9' }),
          session({ id: 'session-b', busThreadId: 'thr_9' }),
        ],
        sendSessionInput: async (input) => {
          inputs.push(input);
          return { ok: true };
        },
        now: () => 5000,
        logger: { warn() {} },
      });

      assert.equal(await loop.handleUpdate({
        update_id: 25,
        message: {
          message_id: 910,
          chat: { id: -100123 },
          message_thread_id: 300,
          reply_to_message: { message_id: 700 },
          text: 'route by durable reply binding',
        },
      }), true);
      assert.equal(inputs[0].session.id, 'session-a');
    });
  });

  it('routes legacy project topics to the unique live session for that cwd and runtime', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'name:legacy': {
          thread_id: 301,
          scope_type: 'thread',
          scope_id: 'dead-thread',
          session_id: 'dead-session',
          cwd: '/tmp/project',
          backend: 'codex',
        },
      }));
      const inputs = [];
      const loop = new TelegramBridgeLoop({
        sender: new TelegramSender({ stateDir, fetchImpl: async () => response({ ok: true, result: true }) }),
        stateDir,
        listSessions: async () => [
          session({ id: 'live-session', workDir: '/tmp/project', runtime: 'codex' }),
          session({ id: 'other-session', workDir: '/tmp/other', runtime: 'codex' }),
        ],
        sendSessionInput: async (input) => {
          inputs.push(input);
          return { ok: true };
        },
        now: () => 5000,
        logger: { warn() {} },
      });

      assert.equal(await loop.handleUpdate({
        update_id: 23,
        message: {
          message_id: 907,
          chat: { id: -100123 },
          message_thread_id: 301,
          text: 'route by project topic',
        },
      }), true);
      assert.equal(inputs[0].session.id, 'live-session');
    });
  });

  it('reports unresolved inbound updates in bridge status', async () => {
    await withTempState(async (stateDir) => {
      const loop = new TelegramBridgeLoop({
        sender: new TelegramSender({ stateDir, fetchImpl: async () => response({ ok: true, result: true }) }),
        stateDir,
        listSessions: async () => [],
        sendSessionInput: async () => ({ ok: true }),
        now: () => 5000,
        logger: { warn() {} },
      });

      assert.equal(await loop.handleUpdate({
        update_id: 24,
        message: {
          message_id: 908,
          chat: { id: -100123 },
          message_thread_id: 302,
          text: 'lost',
        },
      }), false);
      assert.equal(loop.status().ignoredUpdateCount, 1);
      assert.equal(loop.status().lastIgnoredUpdate.reason, 'unresolved_session');
      assert.equal(loop.status().lastIgnoredUpdate.threadId, 302);
    });
  });

  it('commits offsets only up to the last successfully handled update', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'session:session-123456': { thread_id: 177, session_id: 'session-123456', backend: 'codex' },
      }));
      const inputs = [];
      let fail = true;
      const loop = new TelegramBridgeLoop({
        sender: Object.assign(new TelegramSender({ stateDir, fetchImpl: async () => response({ ok: true, result: true }) }), {
          getUpdates: async () => [
            { update_id: 30, message: { message_id: 907, chat: { id: -100123 }, message_thread_id: 177, text: 'ok one' } },
            { update_id: 31, message: { message_id: 908, chat: { id: -100123 }, message_thread_id: 177, text: 'boom' } },
          ],
        }),
        stateDir,
        listSessions: async () => [session()],
        sendSessionInput: async (input) => {
          if (fail && input.text === 'boom') throw new Error('session input failed');
          inputs.push(input);
          return { ok: true };
        },
        now: () => 5000,
        logger: { warn() {} },
      });

      await assert.rejects(() => loop.pollOnce(), /session input failed/);
      assert.equal(loop.status().offset, 31);

      fail = false;
      await loop.pollOnce().catch(() => {});
      assert.deepEqual(inputs.map((input) => input.text), ['ok one', 'boom']);
    });
  });

  it('drops a poison update after repeated failures instead of blocking the queue', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'session:session-123456': { thread_id: 177, session_id: 'session-123456', backend: 'codex' },
      }));
      const inputs = [];
      const loop = new TelegramBridgeLoop({
        sender: Object.assign(new TelegramSender({ stateDir, fetchImpl: async () => response({ ok: true, result: true }) }), {
          getUpdates: async () => [
            { update_id: 40, message: { message_id: 910, chat: { id: -100123 }, message_thread_id: 177, text: 'poison' } },
            { update_id: 41, message: { message_id: 911, chat: { id: -100123 }, message_thread_id: 177, text: 'after poison' } },
          ],
        }),
        stateDir,
        listSessions: async () => [session()],
        sendSessionInput: async (input) => {
          if (input.text === 'poison') throw new Error('always fails');
          inputs.push(input);
          return { ok: true };
        },
        now: () => 5000,
        logger: { warn() {} },
      });

      await loop.pollOnce().catch(() => {});
      await loop.pollOnce().catch(() => {});
      await loop.pollOnce().catch(() => {});

      assert.equal(loop.status().offset, 42);
      assert.deepEqual(inputs.map((input) => input.text), ['after poison']);
    });
  });

  it('prefers the forum thread mapping over stale reply metadata', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'session:target-session': { thread_id: 177, session_id: 'target-session', backend: 'codex' },
        'session:other-session': { thread_id: 188, session_id: 'other-session', backend: 'codex' },
      }));
      await writeFile(join(stateDir, 'messages.json'), JSON.stringify({
        900: { session_id: 'other-session', thread_id: 188, topic_key: 'session:other-session', backend: 'codex' },
      }));
      const inputs = [];
      const loop = new TelegramBridgeLoop({
        sender: new TelegramSender({ stateDir, fetchImpl: async () => response({ ok: true, result: true }) }),
        stateDir,
        listSessions: async () => [
          session({ id: 'target-session' }),
          session({ id: 'other-session' }),
        ],
        sendSessionInput: async (input) => {
          inputs.push(input);
          return { ok: true };
        },
        now: () => 5000,
        logger: { warn() {} },
      });

      assert.equal(await loop.handleUpdate({
        update_id: 13,
        message: {
          message_id: 904,
          chat: { id: -100123 },
          message_thread_id: 177,
          reply_to_message: { message_id: 900 },
          text: 'Stay in this forum topic',
        },
      }), true);
      assert.equal(inputs[0].session.id, 'target-session');
    });
  });

  it('prefers same-thread reply-to message mapping over the topic session', async () => {
    await withTempState(async (stateDir) => {
      await writeFile(join(stateDir, 'topics.json'), JSON.stringify({
        'session:topic-session': { thread_id: 177, session_id: 'topic-session', backend: 'codex' },
        'session:reply-session': { thread_id: 177, session_id: 'reply-session', backend: 'claude' },
      }));
      await writeFile(join(stateDir, 'messages.json'), JSON.stringify({
        900: { session_id: 'reply-session', thread_id: 177, topic_key: 'session:reply-session', backend: 'claude' },
      }));
      const inputs = [];
      const loop = new TelegramBridgeLoop({
        sender: new TelegramSender({ stateDir, fetchImpl: async () => response({ ok: true, result: true }) }),
        stateDir,
        listSessions: async () => [
          session({ id: 'topic-session', runtime: 'codex' }),
          session({ id: 'reply-session', runtime: 'claude' }),
        ],
        sendSessionInput: async (input) => {
          inputs.push(input);
          return { ok: true };
        },
        now: () => 5000,
        logger: { warn() {} },
      });

      assert.equal(await loop.handleUpdate({
        update_id: 14,
        message: {
          message_id: 905,
          chat: { id: -100123 },
          message_thread_id: 177,
          reply_to_message: { message_id: 900 },
          text: 'Route to the replied Claude message',
        },
      }), true);
      assert.equal(inputs[0].session.id, 'reply-session');
      assert.equal(inputs[0].session.runtime, 'claude');
    });
  });
});
