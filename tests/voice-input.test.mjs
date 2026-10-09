import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { chromium } from 'playwright-core';
import { appendTranscript, clickToTalk, openRecorder } from '../public/components/voice-input.mjs';

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

function takeWith(open, maxMs) {
  const log = { statuses: [], texts: [], errors: [], empties: 0 };
  const take = clickToTalk({
    open,
    maxMs,
    onStatus: (s) => log.statuses.push(s),
    onText: (t) => log.texts.push(t),
    onEmpty: () => { log.empties += 1; },
    onError: (e) => log.errors.push(e.message),
  });
  return { take, log };
}

describe('voice input click-to-talk lifecycle', () => {
  it('records from one click, then releases the mic and transcribes on the next', async () => {
    const mic = fakeMic();
    const { take, log } = takeWith(() => openRecorder(mic));
    const run = take.toggle();
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(mic.tracks[0].live, true);
    take.toggle();
    await run;
    assert.equal(mic.tracks[0].live, false);
    assert.deepEqual(mic.transcribed, ['clip']);
    assert.deepEqual(log.texts, ['heard']);
    assert.equal(log.empties, 0);
    assert.deepEqual(log.statuses, ['recording', 'transcribing', 'idle']);
  });

  it('reports no speech when a kept recording transcribes to blank text', async () => {
    for (const heard of ['', '  \n', undefined]) {
      const mic = fakeMic();
      mic.transcribe = async () => heard;
      const { take, log } = takeWith(() => openRecorder(mic), 1);
      await take.toggle();
      assert.equal(log.empties, 1);
      assert.deepEqual(log.errors, []);
    }
  });

  it('types the clip from its chunks after the recorder clears its mimeType', async () => {
    const mic = fakeMic({ chunks: [new Blob(['ogg'], { type: 'audio/ogg; codecs=opus' })] });
    const { take } = takeWith(() => openRecorder(mic), 1);
    await take.toggle();
    assert.deepEqual(mic.types, ['audio/ogg; codecs=opus']);
  });

  it('reports an empty recording without transcribing it', async () => {
    for (const chunks of [[], [new Blob([], { type: 'audio/webm' })]]) {
      const mic = fakeMic({ chunks });
      const { take, log } = takeWith(() => openRecorder(mic), 1);
      await take.toggle();
      assert.deepEqual(mic.transcribed, []);
      assert.deepEqual(log.errors, ['No audio captured']);
      assert.equal(mic.tracks[0].live, false);
    }
  });

  it('ignores clicks while transcribing and starts a new take after', async () => {
    const mic = fakeMic();
    let finishTranscribe;
    mic.transcribe = () => new Promise((r) => { finishTranscribe = r; });
    const { take, log } = takeWith(() => openRecorder(mic));
    const run = take.toggle();
    await new Promise((r) => setTimeout(r, 5));
    take.toggle();
    await new Promise((r) => setTimeout(r, 5));
    take.toggle(); // click while the first clip is transcribing
    finishTranscribe('first');
    await run;
    assert.equal(mic.grants, 1);
    assert.deepEqual(log.texts, ['first']);
    assert.deepEqual(log.statuses, ['recording', 'transcribing', 'idle']);
    mic.transcribe = async () => 'second';
    const next = take.toggle();
    await new Promise((r) => setTimeout(r, 5));
    take.toggle();
    await next;
    assert.equal(mic.grants, 2);
    assert.deepEqual(log.texts, ['first', 'second']);
  });

  it('discards the take when stopped before the mic was granted', async () => {
    const mic = fakeMic();
    let grant;
    const { take, log } = takeWith(() => new Promise((r) => { grant = r; }).then(() => openRecorder(mic)));
    const run = take.toggle();
    take.toggle();
    grant();
    await run;
    assert.equal(mic.tracks[0].live, false);
    assert.deepEqual(mic.transcribed, []);
    assert.deepEqual(log.texts, ['']);
    assert.equal(log.empties, 0);
    assert.deepEqual(log.statuses, ['recording', 'idle']);
  });

  it('releases the mic when the recorder cannot be built or started', async () => {
    for (const failure of [{ failConstruct: true }, { failStart: true }]) {
      const mic = fakeMic(failure);
      const { take, log } = takeWith(() => openRecorder(mic));
      await take.toggle();
      assert.equal(mic.tracks[0].live, false);
      assert.equal(log.errors.length, 1);
      assert.deepEqual(log.statuses, ['recording', 'idle']);
    }
  });

  it('stops and transcribes a take that is never stopped at the recording limit', async () => {
    const mic = fakeMic();
    const { take, log } = takeWith(() => openRecorder(mic), 10);
    await take.toggle();
    assert.equal(mic.tracks[0].live, false);
    assert.deepEqual(log.texts, ['heard']);
  });

  it('reports transcription failures and frees the mic for the next take', async () => {
    const mic = fakeMic();
    mic.transcribe = async () => { throw Object.assign(new Error('unavailable'), { statusCode: 503 }); };
    const { take, log } = takeWith(() => openRecorder(mic), 1);
    await take.toggle();
    assert.deepEqual(log.errors, ['unavailable']);
    assert.equal(mic.tracks[0].live, false);
    await take.toggle();
    assert.equal(mic.grants, 2);
  });
});

describe('voice input button', () => {
  it('toggles recording by click and Ctrl+Space, ignores presses while transcribing, and toasts no speech', { skip: !process.env.CHROMIUM_BIN }, async () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const app = Fastify();
    await app.register(fastifyStatic, { root: join(root, 'public'), prefix: '/' });
    await app.register(fastifyStatic, { root: join(root, 'node_modules'), prefix: '/vendor/npm/', decorateReply: false });
    const index = await readFile(join(root, 'public/index.html'), 'utf8');
    app.get('/voice-fixture', async (_req, reply) => reply.type('text/html').send(index.replace(
      '<script type="module" src="/app/app.mjs"></script>',
      `<script type="module">
        import { h, render } from 'preact'; import { effect } from '@preact/signals';
        import { toasts } from '/app/state.mjs'; import { VoiceInput } from '/components/voice-input.mjs';
        window.results = []; window.toastLog = [];
        effect(() => toasts.value.forEach((t) => { if (!window.toastLog.includes(t.message)) window.toastLog.push(t.message); }));
        render(h('div', { class: 'control-row control-row-compose' }, h(VoiceInput, { className: 'ctrl-btn', hotkey: true, onResult: (text) => window.results.push(text) })), document.getElementById('app'));
      </script>`,
    )));
    const replies = [];
    let gate;
    app.post('/api/audio/transcribe', async () => { await gate; return { text: replies.shift() }; });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_BIN, headless: true,
      args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    });
    try {
      const page = await browser.newPage();
      await page.addInitScript(() => {
        const NativeAudioContext = window.AudioContext;
        window.audioContexts = [];
        window.AudioContext = class extends NativeAudioContext {
          constructor(...args) { super(...args); window.audioContexts.push(this); }
        };
        const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const stream = await getUserMedia(constraints);
          const context = new NativeAudioContext();
          const source = context.createMediaStreamSource(stream);
          const gain = context.createGain();
          gain.gain.value = 0;
          const output = context.createMediaStreamDestination();
          source.connect(gain).connect(output);
          const tone = context.createOscillator();
          tone.connect(gain);
          tone.start();
          window.inputGain = gain;
          return output.stream;
        };
      });
      await page.goto(`${origin}/voice-fixture`);
      const button = page.locator('button.voice-ptt');
      assert.equal(await button.getAttribute('title'), 'Start dictation (Ctrl+Space)');

      assert.equal(await button.getAttribute('aria-label'), 'Start dictation');
      assert.equal(await button.locator('svg').count(), 1);
      const idleBox = await button.boundingBox();

      let open;
      gate = new Promise((r) => { open = r; });
      replies.push('hello');
      await button.click();
      await page.waitForFunction(() => document.querySelector('button.voice-ptt').getAttribute('aria-label') === 'Stop and transcribe');
      assert.equal(await button.getAttribute('title'), 'Stop and transcribe (Ctrl+Space)');
      assert.equal(await button.evaluate((el) => el.classList.contains('voice-recording')), true);
      assert.equal(await button.getAttribute('aria-pressed'), 'true');
      assert.equal(await button.locator('.voice-timer').textContent(), '0:00');
      await page.waitForFunction(() => document.querySelector('.voice-timer').textContent === '0:01');
      assert.equal((await button.boundingBox()).width, idleBox.width);
      assert.equal((await button.boundingBox()).height, idleBox.height);
      await page.waitForFunction(() => document.querySelector('.voice-meter').style.getPropertyValue('--voice-level') === '0');
      const quietHeight = await button.locator('.voice-meter span').first().evaluate((el) => el.getBoundingClientRect().height);
      await page.evaluate(() => { window.inputGain.gain.value = 1; });
      await page.waitForFunction(() => Number(document.querySelector('.voice-meter').style.getPropertyValue('--voice-level')) > 0.1);
      assert.ok(await button.locator('.voice-meter span').first().evaluate((el) => el.getBoundingClientRect().height) > quietHeight);
      assert.equal(await page.evaluate(() => window.audioContexts[0].state), 'running');
      await button.click();
      await page.waitForFunction(() => document.querySelector('button.voice-ptt').getAttribute('aria-label') === 'Transcribing…');
      assert.equal(await button.isDisabled(), true);
      await page.waitForFunction(() => window.audioContexts[0].state === 'closed');
      assert.equal(await button.locator('.voice-spinner').count(), 1);
      assert.equal((await button.textContent()).trim(), 'Transcribing…');
      assert.equal((await button.boundingBox()).width, idleBox.width);
      assert.equal((await button.boundingBox()).height, idleBox.height);
      await page.keyboard.press('Control+Space'); // ignored while transcribing
      open();
      await page.waitForFunction(() => document.querySelector('button.voice-ptt').getAttribute('aria-label') === 'Start dictation');
      assert.deepEqual(await page.evaluate(() => window.results), ['hello']);

      replies.push('');
      await page.keyboard.down('Control');
      await page.keyboard.down('Space');
      await page.keyboard.down('Space'); // auto-repeat does not toggle again
      await page.keyboard.up('Space');
      await page.keyboard.up('Control');
      await page.waitForTimeout(300);
      assert.equal(await button.getAttribute('aria-label'), 'Stop and transcribe');
      await page.keyboard.press('Control+Space');
      await page.waitForFunction(() => window.toastLog.length > 0);
      assert.deepEqual(await page.evaluate(() => window.toastLog), ['No speech detected — check your microphone input']);
      assert.deepEqual(await page.evaluate(() => window.results), ['hello']);
      assert.equal(replies.length, 0);
      await page.waitForFunction(() => window.audioContexts.length === 2 && window.audioContexts.every((ctx) => ctx.state === 'closed'));
    } finally {
      await browser.close();
      await app.close();
    }
  });
});
