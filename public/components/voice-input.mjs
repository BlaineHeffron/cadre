import { h } from 'preact';
import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';

const isSupported = typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

export function VoiceInput({ onResult }) {
  const [isListening, setIsListening] = useState(false);
  const [recognition, setRecognition] = useState(null);

  useEffect(() => {
    return () => {
      if (recognition) {
        recognition.abort();
      }
    };
  }, [recognition]);

  if (!isSupported) return null;

  function startListening() {
    if (recognition) {
      recognition.abort();
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const newRecognition = new SpeechRecognition();
    newRecognition.lang = 'en-US';
    newRecognition.interimResults = false;
    newRecognition.maxAlternatives = 1;

    newRecognition.onresult = (event) => {
      const text = event.results[0][0].transcript;
      if (onResult) onResult(text);
      setIsListening(false);
    };

    newRecognition.onerror = () => {
      setIsListening(false);
    };

    newRecognition.onend = () => {
      setIsListening(false);
    };

    setRecognition(newRecognition);
    setIsListening(true);
    newRecognition.start();
  }

  return html`
    <button
      type="button"
      class="btn ${isListening ? 'btn-danger' : ''}"
      onclick=${startListening}
      title="Voice input"
      disabled=${isListening}
    >
      ${isListening ? '...' : 'Mic'}
    </button>
  `;
}
