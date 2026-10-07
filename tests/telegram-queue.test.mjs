import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { buildInProcessFastifyRequest } from '../modules/agent-bus/in-process-mcp.mjs';
import { TelegramBridgeLoop } from '../modules/telegram/bridge-loop.mjs';
import { TelegramSender } from '../modules/telegram/sender.mjs';

const CHAT_ID = -100123;
let queue;
let app;
let stateRoot;
const commands = [];

// Import the queue after choosing its hermetic on-disk store.
before(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'cadre-telegram-queue-'));
  process.env.CADRE_STATE_DIR = join(stateRoot, 'state');
  queue = await import('../modules/integrations/command-center-ai.mjs');
  app = Fastify();
  await app.register(queue.commandCenterAIPlugin, {
    enqueueSessionCommand: async (kind, sessionId, input) => {
      commands.push({ kind, sessionId, text: input.text });
      return { ok: true };
    },
  });
});

after(async () => {
  await app.close();
  delete process.env.CADRE_STATE_DIR;
  await rm(stateRoot, { recursive: true, force: true });
});

async function bridge({ start = true, failing = false, maxMsgLength = 3000, gate = null } = {}) {
  const stateDir = await mkdtemp(join(stateRoot, 'telegram-'));
  await writeFile(join(stateDir, 'config.env'), `TELEGRAM_BOT_TOKEN="secret-token"\nTELEGRAM_CHAT_ID=${CHAT_ID}\nMAX_MSG_LENGTH=${maxMsgLength}\n`);
  const calls = [];
  const warnings = [];
  let nextMessageId = 500;
  const sender = new TelegramSender({
    stateDir,
    sleep: async () => {},
    fetchImpl: async (url, options = {}) => {
      const method = url.split('/').at(-1).split('?')[0];
      // Park the poll loop so the test drives updates through handleUpdate.
      if (method === 'getUpdates') return new Promise(() => {});
      calls.push({ method, body: JSON.parse(options.body) });
      await gate;
      if (failing) throw new TypeError('fetch failed');
      const result = method === 'createForumTopic' ? { message_thread_id: 77, name: 'Command Queue' }
        : method === 'sendMessage' ? { message_id: nextMessageId++ } : true;
      return { status: 200, json: async () => ({ ok: true, result }) };
    },
  });
  const loop = new TelegramBridgeLoop({
    sender,
    stateDir,
    listSessions: async () => [],
    requestImpl: buildInProcessFastifyRequest({ app, buildHeaders: () => ({}) }),
    watchQueue: queue.onHumanQueueChange,
    logger: { warn: (line) => warnings.push(line) },
  });
  if (start) loop.start();
  return { loop, calls, warnings, sent: () => calls.filter((call) => call.method === 'sendMessage') };
}

function addItem(input = {}, options = {}) {
  return queue.addHumanQueueItem({
    title: 'Deploy?',
    question: 'Deploy the release now?',
    details: 'Tests are green.',
    priority: 'high',
    sessionKind: 'codex',
    sessionId: 'sess-1',
    passThrough: true,
    options: [{ id: 'yes', label: 'Ship it' }, { id: 'no', label: 'Hold' }],
    ...input,
  }, { persist: false, ...options });
}

function callback(id, data, messageId, chatId = CHAT_ID) {
  return { update_id: id, callback_query: { id: `cb-${id}`, data, message: { message_id: messageId, message_thread_id: 77, chat: { id: chatId } } } };
}

describe('telegram Command Queue topic', () => {
  it('posts a new item with its buttons and answers it from a button', async () => {
    const { loop, calls, sent } = await bridge();
    const item = await addItem();
    await loop.queueSync;

    assert.deepEqual(calls.find((call) => call.method === 'createForumTopic').body.name, 'Command Queue');
    const [post] = sent();
    assert.equal(post.body.message_thread_id, 77);
    assert.match(post.body.text, /Deploy\? \[high\][\s\S]*From: codex:sess-1[\s\S]*Deploy the release now\?[\s\S]*Tests are green\./);
    assert.deepEqual(post.body.reply_markup.inline_keyboard, [
      [{ text: 'Ship it', callback_data: `q:${item.id}:0` }],
      [{ text: 'Hold', callback_data: `q:${item.id}:1` }],
    ]);

    assert.equal(await loop.handleUpdate(callback(1, `q:${item.id}:1`, 500)), true);
    await loop.queueSync;
    loop.stop();

    assert.equal(item.status, 'routed');
    assert.equal(item.answer.optionId, 'no');
    assert.deepEqual(commands.at(-1), { kind: 'codex', sessionId: 'sess-1', text: `Answer for Command Center queue item ${item.id}:\nHold` });
    assert.equal(calls.find((call) => call.method === 'answerCallbackQuery').body.text, 'Answered');
    const edit = calls.find((call) => call.method === 'editMessageText');
    assert.equal(edit.body.message_id, 500);
    assert.match(edit.body.text, /Status: routed · Hold/);
    assert.deepEqual(edit.body.reply_markup.inline_keyboard, []);
  });

  it('answers with the text of a reply to the item message', async () => {
    const { loop } = await bridge();
    const item = await addItem();
    await loop.queueSync;
    const handled = await loop.handleUpdate({
      update_id: 2,
      message: { message_id: 900, message_thread_id: 77, chat: { id: CHAT_ID }, text: 'Wait for QA', reply_to_message: { message_id: 500 } },
    });
    loop.stop();

    assert.equal(handled, true);
    assert.equal(item.answer.text, 'Wait for QA');
    assert.equal(commands.at(-1).text, `Answer for Command Center queue item ${item.id}:\nWait for QA`);
  });

  it('edits the message when the item is answered in the dashboard, withdrawn or updated', async () => {
    const { loop, calls } = await bridge();
    const agent = { type: 'agent', kind: 'codex', sessionId: 'sess-1' };
    const answered = await addItem();
    const withdrawn = await addItem({ title: 'Rebase?' }, { principal: agent });
    await loop.queueSync;
    await app.inject({ method: 'POST', url: `/api/command-center/work-queue/${answered.id}/answer`, payload: { optionId: 'yes' } });
    await queue.updateHumanQueueItem(withdrawn.id, { question: 'Rebase onto main?' }, { persist: false, principal: agent });
    await loop.queueSync;
    await queue.dismissHumanQueueItem(withdrawn.id, { persist: false, principal: agent });
    await loop.queueSync;
    loop.stop();

    const edits = calls.filter((call) => call.method === 'editMessageText').map((call) => call.body);
    assert.equal(edits.length, 3);
    assert.equal(edits[0].message_id, 500);
    assert.match(edits[0].text, /Status: routed · Ship it/);
    assert.equal(edits[1].message_id, 501);
    assert.match(edits[1].text, /Rebase onto main\?/);
    assert.deepEqual(edits[1].reply_markup.inline_keyboard, []);
    assert.match(edits[2].text, /Status: withdrawn/);
    assert.deepEqual(edits[2].reply_markup.inline_keyboard, []);
  });

  it('leaves operator actions to the dashboard', async () => {
    const { loop, sent, calls } = await bridge();
    const item = await addItem({ operatorAction: { method: 'POST', path: '/api/agents/github' } }, { principal: { type: 'agent', kind: 'codex', sessionId: 'sess-1' } });
    await loop.queueSync;
    const [post] = sent();
    assert.match(post.body.text, /Approve or reject this action in the dashboard\./);
    assert.deepEqual(post.body.reply_markup, undefined);

    // A forged approve callback is refused.
    assert.equal(await loop.handleUpdate(callback(3, `q:${item.id}:0`, 500)), false);
    loop.stop();
    assert.equal(item.status, 'open');
    assert.equal(calls.find((call) => call.method === 'answerCallbackQuery').body.text, 'Options changed; answer in the dashboard');
  });

  it('rejects a button tapped after the options changed', async () => {
    const { loop, calls } = await bridge();
    const agent = { type: 'agent', kind: 'codex', sessionId: 'sess-1' };
    const item = await addItem({}, { principal: agent });
    await queue.updateHumanQueueItem(item.id, { options: ['Hold', 'Ship it'] }, { persist: false, principal: agent });
    await loop.queueSync;
    assert.equal(await loop.handleUpdate(callback(5, `q:${item.id}:0`, 500)), false);
    loop.stop();
    assert.equal(item.status, 'open');
    assert.equal(calls.find((call) => call.method === 'answerCallbackQuery').body.text, 'Options changed; answer in the dashboard');
  });

  it('only accepts a button on the message recorded for its item', async () => {
    const { loop } = await bridge();
    const first = await addItem();
    await addItem({ title: 'Second' });
    await loop.queueSync;
    // Message 501 belongs to the second item; a payload naming the first item there is refused.
    assert.equal(await loop.handleUpdate(callback(6, `q:${first.id}:0`, 501)), false);
    loop.stop();
    assert.equal(first.status, 'open');
  });

  it('keeps an oversized item in one message under the configured limit', async () => {
    const { loop, sent } = await bridge({ maxMsgLength: 200 });
    await addItem({ details: 'x'.repeat(1000) });
    await loop.queueSync;
    loop.stop();
    assert.equal(sent().length, 1);
    assert.ok(Array.from(sent()[0].body.text).length <= 200);
    assert.match(sent()[0].body.text, /…\n\nReply to this message/);
  });

  it('ignores answers from another chat', async () => {
    const { loop } = await bridge();
    const item = await addItem();
    await loop.queueSync;
    assert.equal(await loop.handleUpdate(callback(4, `q:${item.id}:0`, 500, -999)), false);
    loop.stop();
    assert.equal(loop.status().lastIgnoredUpdate.reason, 'wrong_chat');
    assert.equal(item.status, 'open');
  });

  it('keeps queue operations working when Telegram fails', async () => {
    const { loop, calls, warnings } = await bridge({ failing: true });
    const item = await addItem();
    await loop.queueSync;
    await queue.dismissHumanQueueItem(item.id, { persist: false });
    await loop.queueSync;
    loop.stop();

    assert.equal(item.status, 'dismissed');
    assert.equal(calls.length, 3, 'createForumTopic is retried with backoff');
    assert.match(warnings.join('\n'), /telegram queue sync failed for .*fetch failed/);
  });

  it('drops queued syncs once the bridge stops', async () => {
    let release;
    const { calls, loop } = await bridge({ gate: new Promise((resolve) => { release = resolve; }) });
    const first = await addItem();
    while (!calls.length) await new Promise((resolve) => setImmediate(resolve));
    // The first item is mid-send; its dismissal is queued behind it.
    await queue.dismissHumanQueueItem(first.id, { persist: false });
    loop.stop();
    release();
    await loop.queueSync;
    assert.equal(calls.some((call) => call.method === 'editMessageText'), false);
  });

  it('sends nothing while the bridge is not running', async () => {
    const { calls, loop } = await bridge({ start: false });
    const item = await addItem();
    await queue.dismissHumanQueueItem(item.id, { persist: false });
    await loop.queueSync;
    assert.deepEqual(calls, []);
  });
});
