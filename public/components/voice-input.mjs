import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../app/api.mjs';
import { addToast } from '../app/state.mjs';

const MAX_RECORD_MS = 120000;
const SpeechRecognition = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
const canRecord = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
// Flipped when the server reports no transcriber; later takes use live browser speech instead.
let useBrowserSpeech = !canRecord;

export function appendTranscript(current, text, max = Infinity) {
  const base = String(current || '');
  const trimmed = String(text || '').trim();
  if (!trimmed) return base;
  return `${base}${base && !/\s$/.test(base) ? ' ' : ''}${trimmed}`.slice(0, max);
}

// One take at a time: `busy` spans mic acquisition, recording, and transcription. toggle() starts a
// take or stops the recording; it is ignored while transcribing, and a stop before the mic is granted
// discards the take. `open()` resolves to a capture session whose finish(keep) stops it, releases the
// mic, and resolves to the text ('' when discarded). onEmpty fires when a kept take has no speech.
export function clickToTalk({ open, onStatus, onText, onEmpty, onError, maxMs = MAX_RECORD_MS }) {
  let busy = false;
  let release = null;
  async function start() {
    busy = true;
    let held = true;
    release = () => { held = false; };
    onStatus('recording');
    try {
      const session = await open();
      const keep = held;
      if (keep) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, maxMs);
          release = () => { clearTimeout(timer); resolve(); };
        });
        onStatus('transcribing');
      }
      release = null;
      const text = await session.finish(keep);
      if (keep && !text?.trim()) onEmpty();
      onText(text);
    } catch (error) {
      onError(error);
    } finally {
      busy = false;
      release = null;
      onStatus('idle');
    }
  }
  const stop = () => release?.();
  return { toggle: () => (busy ? stop() : start()), stop };
}

export async function openRecorder({ getUserMedia, Recorder, transcribe, onStream }) {
  const stream = await getUserMedia({ audio: true });
  const releaseMic = () => stream.getTracks().forEach((track) => track.stop());
  try {
    const recorder = new Recorder(stream, { audioBitsPerSecond: 32000 });
    const chunks = [];
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onerror = releaseMic;
    recorder.start();
    onStream?.(stream);
    return {
      async finish(keep) {
        try {
          if (recorder.state !== 'inactive') recorder.stop();
          await stopped;
        } finally {
          releaseMic();
        }
        if (!keep) return '';
        // Chunk type, not recorder.mimeType: Firefox resets that to '' on stop.
        const blob = new Blob(chunks, { type: chunks[0]?.type });
        if (!blob.size) throw new Error('No audio captured');
        return transcribe(blob);
      },
    };
  } catch (error) {
    releaseMic();
    throw error;
  }
}

function openBrowserSpeech() {
  const recognition = new SpeechRecognition();
  recognition.lang = navigator.language || 'en-US';
  recognition.continuous = true;
  let text = '';
  const ended = new Promise((resolve) => { recognition.onend = resolve; });
  recognition.onresult = (e) => { text = Array.from(e.results, (r) => r[0].transcript).join(' '); };
  recognition.start();
  return { async finish(keep) { recognition.stop(); await ended; return keep ? text : ''; } };
}

async function transcribeBlob(blob) {
  const audio = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return (await api.post('/audio/transcribe', { audio })).text;
}

// Click to talk: a click (or Ctrl+Space when `hotkey` is set) starts recording, the next one
// transcribes, and the text goes to onResult. Hiding the page stops and transcribes the take.
export function VoiceInput({ onResult, hotkey = false, className = 'btn' }) {
  const [status, setStatus] = useState('idle');
  const [elapsed, setElapsed] = useState(0);
  const [stream, setStream] = useState(null);
  const meter = useRef(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const [take] = useState(() => clickToTalk({
    open: () => (useBrowserSpeech ? openBrowserSpeech() : openRecorder({
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
      Recorder: MediaRecorder,
      transcribe: transcribeBlob,
      onStream: setStream,
    })),
    onStatus: setStatus,
    onText: (text) => { if (text) onResultRef.current?.(text); },
    onEmpty: () => addToast('No speech detected — check your microphone input', 'warning'),
    onError: (error) => {
      const fallback = error.statusCode === 503 && Boolean(SpeechRecognition) && !useBrowserSpeech;
      if (fallback) useBrowserSpeech = true;
      addToast(fallback ? 'Server speech-to-text unavailable; click again to use browser speech' : `Voice input failed: ${error.message}`, 'error');
    },
  }));

  useEffect(() => {
    if (status !== 'recording') {
      setStream(null);
      return undefined;
    }
    if (!stream) return undefined;
    let context;
    let frame;
    try {
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const draw = () => {
        analyser.getByteTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((sum, sample) => sum + ((sample - 128) / 128) ** 2, 0) / samples.length);
        meter.current?.style.setProperty('--voice-level', String(Math.min(1, rms * 4)));
        frame = requestAnimationFrame(draw);
      };
      draw();
    } catch {
      // Dictation still works when Web Audio is unavailable.
    }
    return () => {
      cancelAnimationFrame(frame);
      context?.close().catch(() => {});
    };
  }, [stream, status]);

  useEffect(() => {
    if (status !== 'recording') return undefined;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => { clearInterval(timer); setElapsed(0); };
  }, [status]);

  useEffect(() => {
    const onHidden = () => { if (document.hidden) take.stop(); };
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      take.stop();
    };
  }, []);

  useEffect(() => {
    if (!hotkey) return undefined;
    // Capture phase so the focused terminal does not also receive C-Space.
    const down = (e) => {
      if (!e.ctrlKey || e.code !== 'Space') return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) take.toggle();
    };
    window.addEventListener('keydown', down, true);
    return () => window.removeEventListener('keydown', down, true);
  }, [hotkey]);

  if (!canRecord && !SpeechRecognition) return null;

  // pointerdown preventDefault keeps focus in the draft being dictated into; keyboard activation still clicks.
  const label = status === 'recording' ? 'Stop and transcribe' : status === 'transcribing' ? 'Transcribing…' : 'Start dictation';

  return html`
    <button
      type="button"
      class="${className} voice-ptt ${status === 'recording' ? 'voice-recording' : ''}"
      title=${`${label}${hotkey ? ' (Ctrl+Space)' : ''}`}
      aria-label=${label}
      aria-pressed=${status === 'recording'}
      disabled=${status === 'transcribing'}
      onpointerdown=${(e) => e.preventDefault()}
      onclick=${() => take.toggle()}
    >
      ${status === 'recording' ? html`
        <span class="voice-meter" ref=${meter} aria-hidden="true">
          <span></span><span></span><span></span>
        </span>
        <span class="voice-timer" aria-hidden="true">${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}</span>
        <span aria-hidden="true">■</span>
      ` : status === 'transcribing' ? html`
        <span class="voice-spinner" aria-hidden="true"></span>
        <span>Transcribing…</span>
      ` : html`
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <rect x="9" y="2" width="6" height="12" rx="3" />
          <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" />
        </svg>
      `}
    </button>
  `;
}
