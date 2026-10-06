import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendTranscript, holdToTalk, openRecorder } from '../public/components/voice-input.mjs';

describe('voice input transcript append', () => {
  it('appends dictated text after the draft with one separating space', () => {
    assert.equal(appendTranscript('', '  hello  '), 'hello');
    assert.equal(appendTranscript('fix the', 'tests'), 'fix the tests');
    assert.equal(appendTranscript('line one\n', 'line two'), 'line one\nline two');
    assert.equal(appendTranscript('keep me', '   '), 'keep me');
    assert.equal(appendTranscript(null, undefined), '');
  });

  it('caps the combined draft at the max length', () => {
    assert.equal(appendTranscript('abc', 'defgh', 6), 'abc de');
  });
});

// Fake mic stream and recorder with the MediaRecorder surface openRecorder uses.
function fakeMic({ failConstruct, failStart, chunks = [new Blob(['clip'], { type: 'audio/webm' })] } = {}) {
  const tracks = [{ live: true, stop() { this.live = false; } }];
  const mic = { tracks, grants: 0, transcribed: [], types: [] };
  mic.getUserMedia = async () => { mic.grants += 1; return { getTracks: () => tracks }; };
  mic.Recorder = class {
    constructor() {
      if (failConstruct) throw new Error('NotSupportedError');
      this.state = 'inactive';
      this.mimeType = 'audio/webm';
    }
    start() {
      if (failStart) throw new Error('InvalidStateError');
      this.state = 'recording';
    }
    stop() {
      this.state = 'inactive';
      this.mimeType = ''; // Firefox resets mimeType on stop
      for (const data of chunks) this.ondataavailable({ data });
      setTimeout(() => this.onstop());
    }
  };
  mic.transcribe = async (blob) => {
    mic.transcribed.push(await blob.text());
    mic.types.push(blob.type);
    return 'heard';
  };
  return mic;
}

function holdWith(open, maxMs) {
  const log = { statuses: [], texts: [], errors: [] };
  const hold = holdToTalk({
    open,
    maxMs,
    onStatus: (s) => log.statuses.push(s),
    onText: (t) => log.texts.push(t),
    onError: (e) => log.errors.push(e.message),
  });
  return { hold, log };
}

describe('voice input hold-to-talk lifecycle', () => {
  it('records while held, releases the mic, and transcribes on release', async () => {
    const mic = fakeMic();
    const { hold, log } = holdWith(() => openRecorder(mic));
    const run = hold.start();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(mic.tracks[0].live, true);
    hold.end();
    await run;
    assert.equal(mic.tracks[0].live, false);
    assert.deepEqual(mic.transcribed, ['clip']);
    assert.deepEqual(log.texts, ['heard']);
    assert.deepEqual(log.statuses, ['recording', 'transcribing', 'idle']);
  });

  it('types the clip from its chunks after the recorder clears its mimeType', async () => {
    const mic = fakeMic({ chunks: [new Blob(['ogg'], { type: 'audio/ogg; codecs=opus' })] });
    const { hold } = holdWith(() => openRecorder(mic), 1);
    await hold.start();
    assert.deepEqual(mic.types, ['audio/ogg; codecs=opus']);
  });

  it('reports an empty recording without transcribing it', async () => {
    for (const chunks of [[], [new Blob([], { type: 'audio/webm' })]]) {
      const mic = fakeMic({ chunks });
      const { hold, log } = holdWith(() => openRecorder(mic), 1);
      await hold.start();
      assert.deepEqual(mic.transcribed, []);
      assert.deepEqual(log.errors, ['No audio captured']);
      assert.equal(mic.tracks[0].live, false);
    }
  });

  it('ignores new holds from any input until acquisition, recording, and transcription finish', async () => {
    const mic = fakeMic();
    let finishTranscribe;
    mic.transcribe = () => new Promise((r) => { finishTranscribe = r; });
    const { hold, log } = holdWith(() => openRecorder(mic));
    const run = hold.start();
    hold.start(); // second press while the mic request is pending
    await new Promise((r) => setTimeout(r, 5));
    hold.end();
    await new Promise((r) => setTimeout(r, 5));
    hold.start(); // hotkey press while the first clip is transcribing
    finishTranscribe('first');
    await run;
    assert.equal(mic.grants, 1);
    assert.deepEqual(log.texts, ['first']);
    await Promise.all([hold.start(), hold.end()]);
    assert.equal(mic.grants, 2);
  });

  it('stops the mic without transcribing when released before the mic was granted', async () => {
    const mic = fakeMic();
    let grant;
    const { hold, log } = holdWith(() => new Promise((r) => { grant = r; }).then(() => openRecorder(mic)));
    const run = hold.start();
    hold.end();
    grant();
    await run;
    assert.equal(mic.tracks[0].live, false);
    assert.deepEqual(mic.transcribed, []);
    assert.deepEqual(log.texts, ['']);
    assert.deepEqual(log.statuses, ['recording', 'idle']);
  });

  it('releases the mic when the recorder cannot be built or started', async () => {
    for (const failure of [{ failConstruct: true }, { failStart: true }]) {
      const mic = fakeMic(failure);
      const { hold, log } = holdWith(() => openRecorder(mic));
      await hold.start();
      assert.equal(mic.tracks[0].live, false);
      assert.equal(log.errors.length, 1);
      assert.deepEqual(log.statuses, ['recording', 'idle']);
    }
  });

  it('ends a hold that is never released at the recording limit', async () => {
    const mic = fakeMic();
    const { hold, log } = holdWith(() => openRecorder(mic), 10);
    await hold.start();
    assert.equal(mic.tracks[0].live, false);
    assert.deepEqual(log.texts, ['heard']);
  });

  it('reports transcription failures and frees the hold for the next attempt', async () => {
    const mic = fakeMic();
    mic.transcribe = async () => { throw Object.assign(new Error('unavailable'), { statusCode: 503 }); };
    const { hold, log } = holdWith(() => openRecorder(mic), 1);
    await hold.start();
    assert.deepEqual(log.errors, ['unavailable']);
    assert.equal(mic.tracks[0].live, false);
    await hold.start();
    assert.equal(mic.grants, 2);
  });
});
