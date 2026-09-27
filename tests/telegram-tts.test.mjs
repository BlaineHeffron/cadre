import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { cleanTextForSpeech, speechSynthesisAvailable, synthesizeSpeech } from '../modules/telegram/tts.mjs';

describe('telegram tts', () => {
  it('strips page prefixes, session tags, and markdown for speech', () => {
    assert.equal(
      cleanTextForSpeech('[2/3] [codex abc12345 tmux-x]\n**Done** with `fix`'),
      'Done with fix'
    );
  });

  it('replaces code blocks with a placeholder', () => {
    assert.equal(
      cleanTextForSpeech('Before\n```js\nconst x = 1;\n```\nAfter'),
      'Before code block omitted After'
    );
  });

  it('runs gtts-cli then ffmpeg and returns the ogg bytes', async () => {
    const calls = [];
    const execImpl = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'gtts-cli') {
        await writeFile(args[args.indexOf('-o') + 1], 'MP3');
        return { stdout: '', stderr: '', code: 0 };
      }
      if (cmd === 'ffmpeg') {
        const input = args[args.indexOf('-i') + 1];
        assert.equal(await readFile(input, 'utf8'), 'MP3');
        await writeFile(args.at(-1), 'OGGDATA');
        return { stdout: '', stderr: '', code: 0 };
      }
      throw new Error(`unexpected command ${cmd}`);
    };

    const ogg = await synthesizeSpeech('hello world', { execImpl });
    assert.equal(ogg.toString('utf8'), 'OGGDATA');
    assert.deepEqual(calls.map((call) => call.cmd), ['gtts-cli', 'ffmpeg']);
  });

  it('rejects when there is no speakable text', async () => {
    await assert.rejects(() => synthesizeSpeech('   '), /no speakable text/);
  });

  it('reports speech synthesis unavailable when a dependency is missing', async () => {
    const execImpl = async (cmd) => ({ stdout: '', stderr: '', code: cmd === 'ffmpeg' ? 0 : 1 });
    assert.equal(await speechSynthesisAvailable({ execImpl, force: true }), false);
  });

  it('reports speech synthesis available when both commands work', async () => {
    const execImpl = async () => ({ stdout: '', stderr: '', code: 0 });
    assert.equal(await speechSynthesisAvailable({ execImpl, force: true }), true);
  });
});
