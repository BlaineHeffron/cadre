import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../app/api.mjs';
import { addToast } from '../app/state.mjs';

const MAX_RECORD_MS = 120000;
const SpeechRecognition = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
const canRecord = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';
// Flipped when the server reports no transcriber; later holds use live browser speech instead.
let useBrowserSpeech = !canRecord;

export function appendTranscript(current, text, max = Infinity) {
  const base = String(current || '');
  const trimmed = String(text || '').trim();
  if (!trimmed) return base;
  return `${base}${base && !/\s$/.test(base) ? ' ' : ''}${trimmed}`.slice(0, max);
}

// One hold at a time: `busy` spans mic acquisition, recording, and transcription, so neither the
// button nor the hotkey can start over a previous hold. `open()` resolves to a capture session whose
// finish(keep) stops it, releases the mic, and resolves to the text ('' when the hold ended early).
export function holdToTalk({ open, onStatus, onText, onError, maxMs = MAX_RECORD_MS }) {
  let busy = false;
  let release = null;
  async function start() {
    if (busy) return;
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
      onText(await session.finish(keep));
    } catch (error) {
      onError(error);
    } finally {
      busy = false;
      release = null;
      onStatus('idle');
    }
  }
  return { start, end: () => release?.() };
}

export async function openRecorder({ getUserMedia, Recorder, transcribe }) {
  const stream = await getUserMedia({ audio: true });
  const releaseMic = () => stream.getTracks().forEach((track) => track.stop());
  try {
    const recorder = new Recorder(stream, { audioBitsPerSecond: 32000 });
    const chunks = [];
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.ondataavailable = (e) => chunks.push(e.data);
    recorder.onerror = releaseMic;
    recorder.start();
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

// Hold to talk: records while pressed (or while Ctrl+Space is held when `hotkey` is set),
// transcribes on release, and hands the text to onResult.
export function VoiceInput({ onResult, hotkey = false, className = 'btn' }) {
  const [status, setStatus] = useState('idle');
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const [hold] = useState(() => holdToTalk({
    open: () => (useBrowserSpeech ? openBrowserSpeech() : openRecorder({
      getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
      Recorder: MediaRecorder,
      transcribe: transcribeBlob,
    })),
    onStatus: setStatus,
    onText: (text) => { if (text) onResultRef.current?.(text); },
    onError: (error) => {
      const fallback = error.statusCode === 503 && Boolean(SpeechRecognition) && !useBrowserSpeech;
      if (fallback) useBrowserSpeech = true;
      addToast(fallback ? 'Server speech-to-text unavailable; hold again to use browser speech' : `Voice input failed: ${error.message}`, 'error');
    },
  }));

  useEffect(() => {
    // Once the page loses focus the matching keyup/pointerup may never arrive; stop listening.
    const onHidden = () => { if (document.hidden) hold.end(); };
    window.addEventListener('blur', hold.end);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('blur', hold.end);
      document.removeEventListener('visibilitychange', onHidden);
      hold.end();
    };
  }, []);

  useEffect(() => {
    if (!hotkey) return undefined;
    // Capture phase so the focused terminal does not also receive C-Space.
    const down = (e) => {
      if (!e.ctrlKey || e.code !== 'Space') return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) hold.start();
    };
    const up = (e) => { if (e.code === 'Space' || e.key === 'Control') hold.end(); };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, [hotkey]);

  if (!canRecord && !SpeechRecognition) return null;

  return html`
    <button
      type="button"
      class="${className} voice-ptt ${status !== 'idle' ? 'btn-danger' : ''}"
      title=${`Hold to talk${hotkey ? ' (Ctrl+Space)' : ''}`}
      aria-pressed=${status === 'recording'}
      disabled=${status === 'transcribing'}
      onpointerdown=${(e) => { e.preventDefault(); hold.start(); }}
      onpointerup=${hold.end}
      onpointerleave=${hold.end}
      onpointercancel=${hold.end}
      oncontextmenu=${(e) => e.preventDefault()}
    >
      ${status === 'recording' ? 'Rec' : status === 'transcribing' ? '...' : 'Mic'}
    </button>
  `;
}
