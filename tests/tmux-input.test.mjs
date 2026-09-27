import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sendTmuxEnter, sendTmuxText } from '../modules/platform/tmux-input.mjs';

function makeExec({ failCommand = '' } = {}) {
  const calls = [];
  const execFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (failCommand && args[0] === failCommand) {
      return { code: 1, stdout: '', stderr: `${failCommand} failed` };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  execFn.calls = calls;
  return execFn;
}

describe('tmux input', () => {
  it('stages text in a buffer, pastes it, deletes the buffer, then sends enter', async () => {
    const execFn = makeExec();
    const result = await sendTmuxText(execFn, {
      target: 'sess:1.0',
      text: 'hello\nworld',
      delayMs: 0,
      bufferPrefix: 'test',
    });

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(execFn.calls.map((call) => call.args[0]), ['load-buffer', 'paste-buffer', 'send-keys']);
    assert.equal(execFn.calls[0].args.at(-1), '-');
    assert.equal(execFn.calls[0].opts.input, 'hello\nworld');
    assert.equal(execFn.calls[1].args.includes('-d'), true);
    assert.equal(execFn.calls[2].args.at(-1), 'Enter');
  });

  it('stages large prompts on stdin instead of argv', async () => {
    const execFn = makeExec();
    const text = 'x'.repeat(256 * 1024);
    await sendTmuxText(execFn, { target: 'sess:1.0', text, delayMs: 0 });

    assert.equal(execFn.calls[0].args[0], 'load-buffer');
    assert.equal(execFn.calls[0].args.includes(text), false);
    assert.equal(execFn.calls[0].opts.input, text);
    assert.equal(execFn.calls[0].opts.input.length, 256 * 1024);
  });

  it('can send enter without staging an empty text buffer', async () => {
    const execFn = makeExec();
    await sendTmuxText(execFn, { target: 'sess:1.0', text: '', enter: true });
    assert.deepEqual(execFn.calls.map((call) => call.args[0]), ['send-keys']);
  });

  it('surfaces tmux command failures with stderr', async () => {
    const execFn = makeExec({ failCommand: 'paste-buffer' });
    await assert.rejects(
      () => sendTmuxText(execFn, { target: 'sess:1.0', text: 'hello' }),
      /paste-buffer failed/,
    );

    const enterExec = makeExec({ failCommand: 'send-keys' });
    await assert.rejects(
      () => sendTmuxEnter(enterExec, 'sess:1.0'),
      /send-keys failed/,
    );
  });
});
