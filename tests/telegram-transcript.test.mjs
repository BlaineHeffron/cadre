import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractClaudeAssistantText,
  extractClaudeConversationText,
  extractClaudeOperatorQuestion,
  extractCodexAssistantText,
  extractCodexConversationText,
  readConversationPage,
  readTranscriptDelta,
} from '../modules/telegram/transcript.mjs';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dueno-telegram-transcript-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function jsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

describe('telegram transcript extraction', () => {
  it('extracts all Claude assistant text blocks from the delta', () => {
    const content = jsonl([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } },
      { message: { role: 'user', content: 'ignore me' } },
      { message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
    ]);

    assert.equal(extractClaudeAssistantText(content), 'first\n\nsecond');
  });

  it('renders Claude user and assistant turns with dividers', () => {
    const content = jsonl([
      { message: { role: 'user', content: 'show $x^2$' } },
      { message: { role: 'assistant', content: [{ type: 'text', text: '**Answer:** $x^2$' }] } },
    ]);

    assert.equal(
      extractClaudeConversationText(content),
      '## User\n\nshow $x^2$\n\n---\n\n## AI\n\n**Answer:** $x^2$',
    );
  });

  it('extracts Claude AskUserQuestion tool_use blocks from transcript', () => {
    const content = jsonl([
      {
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            name: 'AskUserQuestion',
            input: {
              questions: [{
                question: 'Proceed?',
                choices: [{ label: 'Yes' }, { label: 'No' }],
              }],
            },
          }],
        },
      },
    ]);

    assert.deepEqual(extractClaudeOperatorQuestion(content), {
      text: 'Proceed?',
      choices: ['Yes', 'No'],
    });
  });

  it('extracts all Codex assistant message output_text from the delta', () => {
    const content = jsonl([
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first' }] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'ignore' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'second' }] } },
    ]);

    assert.equal(extractCodexAssistantText(content), 'first\n\nsecond');
  });

  it('renders Codex user and assistant turns with dividers', () => {
    const content = jsonl([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } },
    ]);

    assert.equal(
      extractCodexConversationText(content),
      '## User\n\nquestion\n\n---\n\n## AI\n\nanswer',
    );
  });
});

describe('conversation paging', () => {
  const codexMessage = (index, text) => ({
    type: 'response_item',
    payload: { type: 'message', role: index % 2 ? 'assistant' : 'user', content: [{ type: 'output_text', text }] },
  });

  it('pages a log longer than the render cap back to its earliest message', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'rollout.jsonl');
      const records = Array.from({ length: 400 }, (_, index) => codexMessage(index, `message ${index} ${'x'.repeat(1000)}`));
      records.splice(200, 0, { type: 'response_item', payload: { type: 'function_call_output', output: 'y'.repeat(5 * 1024 * 1024) } });
      await writeFile(path, `${jsonl(records)}{"partial":`);
      const full = extractCodexConversationText(await readFile(path, 'utf8'));
      assert.ok(full.length > 200_000);

      const newest = await readConversationPage(path, 'codex', { limit: '100' });
      assert.equal(newest.messages.length, 100);
      assert.match(newest.messages.at(-1).text, /^message 399 /);
      assert.equal(newest.text, full.slice(-newest.text.length));

      const seen = [...newest.messages];
      let { start } = newest;
      while (start > 0) {
        const page = await readConversationPage(path, 'codex', { before: String(start), limit: '100' });
        assert.ok(page.start < start);
        seen.unshift(...page.messages);
        ({ start } = page);
      }
      assert.equal(seen.length, 400);
      assert.deepEqual(seen.map((message) => message.text.split(' ')[1]), records.flatMap((record, index) => (
        record.payload.type === 'message' ? [String(index > 200 ? index - 1 : index)] : []
      )));
    });
  });

  it('returns a message record over 4 MiB whole, on its own page, and clamps bad cursors', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'session.jsonl');
      const huge = `huge-start ${'z'.repeat(5 * 1024 * 1024)} huge-end`;
      await writeFile(path, jsonl([
        { message: { role: 'user', content: 'a' } },
        { message: { role: 'assistant', content: huge } },
        { message: { role: 'assistant', content: 'b' } },
      ]));
      const newest = await readConversationPage(path, 'claude', { limit: '10' });
      assert.deepEqual(newest.messages, [{ role: 'assistant', text: huge }, { role: 'assistant', text: 'b' }]);
      const earliest = await readConversationPage(path, 'claude', { before: String(newest.start), limit: '10' });
      assert.deepEqual([earliest.messages, earliest.start], [[{ role: 'user', text: 'a' }], 0]);
      assert.deepEqual((await readConversationPage(path, 'claude', { before: '-5', limit: '10' })).messages, []);
      assert.equal((await readConversationPage(path, 'claude', { before: '999999999999', limit: '1' })).messages[0].text, 'b');
    });
  });
});

describe('telegram transcript delta', () => {
  it('reads assistant text from only the appended transcript bytes', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'claude.jsonl');
      const first = jsonl([{ message: { role: 'assistant', content: 'first' } }]);
      const second = jsonl([{ message: { role: 'assistant', content: 'second' } }]);
      await writeFile(filePath, first);
      const firstRead = await readTranscriptDelta(filePath, 0, 'claude');
      assert.equal(firstRead.text, 'first');
      assert.equal(firstRead.nextOffset, Buffer.byteLength(first, 'utf8'));

      await writeFile(filePath, `${first}${second}`);
      const secondRead = await readTranscriptDelta(filePath, firstRead.nextOffset, 'claude');
      assert.equal(secondRead.text, 'second');
      assert.equal(secondRead.nextOffset, Buffer.byteLength(`${first}${second}`, 'utf8'));
      assert.equal(secondRead.path, filePath);
    });
  });

  it('keeps multiple assistant records appended in one delta', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'claude.jsonl');
      const content = jsonl([
        { message: { role: 'assistant', content: 'first queued message' } },
        { message: { role: 'assistant', content: 'second queued message' } },
      ]);
      await writeFile(filePath, content);

      const read = await readTranscriptDelta(filePath, 0, 'claude');
      assert.equal(read.text, 'first queued message\n\nsecond queued message');
    });
  });

  it('keeps every Pi/OpenCode Go assistant message appended in one delta', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'pi.jsonl');
      const content = jsonl([
        { type: 'session', version: 3, id: 'pi-cli', cwd: '/tmp/pi' },
        { type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'first Pi message' }] } },
        { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'tool noise' }] } },
        { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'second Pi message' }] } },
      ]);
      await writeFile(filePath, content);

      const read = await readTranscriptDelta(filePath, 0, 'pi');
      assert.equal(read.text, 'first Pi message\n\nsecond Pi message');
      assert.equal(read.nextOffset, Buffer.byteLength(content));
    });
  });

  it('does not checkpoint an incomplete trailing JSONL record', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'codex.jsonl');
      const first = jsonl([{
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first' }] },
      }]);
      const secondLine = JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'second' }] },
      });
      const partial = secondLine.slice(0, Math.floor(secondLine.length / 2));
      await writeFile(filePath, `${first}${partial}`);

      const firstRead = await readTranscriptDelta(filePath, 0, 'codex');
      assert.equal(firstRead.text, 'first');
      assert.equal(firstRead.nextOffset, Buffer.byteLength(first));
      assert.ok(firstRead.pendingBytes > 0);

      await writeFile(filePath, `${first}${secondLine}\n`);
      const secondRead = await readTranscriptDelta(filePath, firstRead.nextOffset, 'codex');
      assert.equal(secondRead.text, 'second');
      assert.equal(secondRead.nextOffset, Buffer.byteLength(`${first}${secondLine}\n`));
    });
  });

  it('repairs an old checkpoint left in the middle of a JSONL record', async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, 'codex.jsonl');
      const first = jsonl([{
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first' }] },
      }]);
      const second = jsonl([{
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'recovered' }] },
      }]);
      await writeFile(filePath, `${first}${second}`);

      const corruptOffset = Buffer.byteLength(first) + 20;
      const read = await readTranscriptDelta(filePath, corruptOffset, 'codex');
      assert.equal(read.startOffset, Buffer.byteLength(first));
      assert.equal(read.text, 'recovered');
      assert.equal(read.nextOffset, Buffer.byteLength(`${first}${second}`));
    });
  });
});
