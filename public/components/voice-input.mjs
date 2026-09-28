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

async function startRecorder(onBlob) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream, { audioBitsPerSecond: 32000 });
  const chunks = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = () => {
    stream.getTracks().forEach((track) => track.stop());
    onBlob(new Blob(chunks, { type: recorder.mimeType }));
  };
  recorder.start();
  return () => recorder.stop();
}

function startBrowserSpeech(onText) {
  const recognition = new SpeechRecognition();
  recognition.lang = navigator.language || 'en-US';
  recognition.continuous = true;
  let text = '';
  recognition.onresult = (e) => { text = Array.from(e.results, (r) => r[0].transcript).join(' '); };
  recognition.onend = () => onText(text);
  recognition.start();
  return () => recognition.stop();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Hold to talk: records while pressed (or while Ctrl+Space is held when `hotkey` is set),
// transcribes on release, and hands the text to onResult.
export function VoiceInput({ onResult, hotkey = false, className = 'btn' }) {
  const [status, setStatus] = useState('idle');
  const stopRef = useRef(null);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  function deliver(text) {
    setStatus('idle');
    if (text) onResultRef.current?.(text);
  }

  async function transcribe(blob) {
    setStatus('transcribing');
    try {
      deliver((await api.post('/audio/transcribe', { audio: await blobToDataUrl(blob) })).text);
    } catch (error) {
      setStatus('idle');
      useBrowserSpeech = error.statusCode === 503 && Boolean(SpeechRecognition);
      addToast(useBrowserSpeech ? 'Server speech-to-text unavailable; hold again to use browser speech' : `Voice input failed: ${error.message}`, 'error');
    }
  }

  async function start() {
    if (stopRef.current) return;
    let released = false;
    stopRef.current = () => { released = true; };
    setStatus('recording');
    try {
      const stop = useBrowserSpeech ? startBrowserSpeech(deliver) : await startRecorder(transcribe);
      const timer = setTimeout(end, MAX_RECORD_MS);
      stopRef.current = () => { clearTimeout(timer); stop(); };
      if (released) end();
    } catch (error) {
      stopRef.current = null;
      setStatus('idle');
      addToast(`Voice input unavailable: ${error.message}`, 'error');
    }
  }

  function end() {
    const stop = stopRef.current;
    stopRef.current = null;
    stop?.();
  }

  useEffect(() => {
    if (!hotkey) return undefined;
    // Capture phase so the focused terminal does not also receive C-Space.
    const down = (e) => {
      if (!e.ctrlKey || e.code !== 'Space') return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) start();
    };
    const up = (e) => { if (e.code === 'Space' || e.key === 'Control') end(); };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, [hotkey]);
  useEffect(() => end, []);

  if (!canRecord && !SpeechRecognition) return null;

  return html`
    <button
      type="button"
      class="${className} voice-ptt ${status !== 'idle' ? 'btn-danger' : ''}"
      title=${`Hold to talk${hotkey ? ' (Ctrl+Space)' : ''}`}
      aria-pressed=${status === 'recording'}
      disabled=${status === 'transcribing'}
      onpointerdown=${(e) => { e.preventDefault(); start(); }}
      onpointerup=${end}
      onpointerleave=${end}
      onpointercancel=${end}
      oncontextmenu=${(e) => e.preventDefault()}
    >
      ${status === 'recording' ? 'Rec' : status === 'transcribing' ? '...' : 'Mic'}
    </button>
  `;
}
