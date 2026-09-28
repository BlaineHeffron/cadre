import { h } from 'preact';
import { html } from 'htm/preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { subscribe } from '../app/ws-client.mjs';
import { api } from '../app/api.mjs';
import { addToast } from '../app/state.mjs';
import { route } from 'preact-router';
import { isEditableTarget, mapKeyboardEventToTmux } from '../app/terminal-input.mjs';
import { Terminal } from '../components/terminal.mjs';
import { appendTranscript, VoiceInput } from '../components/voice-input.mjs';
import { TerminalKeys } from '../components/terminal-keys.mjs';

export function TmuxPanePage({ target }) {
  const decodedTarget = decodeURIComponent(target);
  const [content, setContent] = useState('');
  const [inputKeys, setInputKeys] = useState('');
  const keyQueue = useMemo(() => ({ chain: Promise.resolve() }), []);

  useEffect(() => {
    setContent('');
    setInputKeys('');

    api.get(`/tmux/pane/${encodeURIComponent(decodedTarget)}`)
      .then(data => { setContent(data.content); })
      .catch(e => addToast(`Failed to load pane: ${e.message}`, 'error'));

    const unsub = subscribe(`tmux:pane:${decodedTarget}`, (type, data) => {
      if (type === 'content') {
        setContent(data.content);
      }
    });

    return unsub;
  }, [decodedTarget]);

  async function sendInput() {
    try {
      await api.post(`/tmux/pane/${encodeURIComponent(decodedTarget)}/input`, {
        text: inputKeys,
        enter: true,
      });
      setInputKeys('');
    } catch (e) {
      addToast(`Failed to send input: ${e.message}`, 'error');
    }
  }

  async function sendKey(keyName) {
    try {
      await api.post(`/tmux/pane/${encodeURIComponent(decodedTarget)}/keys`, {
        keys: keyName,
      });
    } catch (e) {
      addToast(`Failed to send key: ${e.message}`, 'error');
    }
  }

  async function sendEnterOnly() {
    try {
      await api.post(`/tmux/pane/${encodeURIComponent(decodedTarget)}/input`, {
        text: '',
        enter: true,
      });
    } catch (e) {
      addToast(`Failed to send Enter: ${e.message}`, 'error');
    }
  }

  function enqueueKeyAction(task) {
    keyQueue.chain = keyQueue.chain
      .then(task)
      .catch((e) => {
        addToast(`Keyboard send failed: ${e.message}`, 'error');
      });
  }

  function handleTerminalKeyDown(event) {
    if (isEditableTarget(event.target)) return;

    const mapped = mapKeyboardEventToTmux(event);
    if (!mapped) return;

    event.preventDefault();
    event.stopPropagation();

    if (mapped.type === 'tmuxKey') {
      enqueueKeyAction(() => api.post(`/tmux/pane/${encodeURIComponent(decodedTarget)}/keys`, {
        keys: mapped.value,
      }));
      return;
    }

    enqueueKeyAction(() => api.post(`/tmux/pane/${encodeURIComponent(decodedTarget)}/input`, {
      text: mapped.value,
      enter: false,
    }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    sendInput();
  }

  function onVoiceResult(text) {
    setInputKeys((current) => appendTranscript(current, text));
  }

  async function killPane() {
    if (!confirm(`Kill pane ${decodedTarget}?`)) return;
    try {
      await api.delete(`/tmux/pane/${encodeURIComponent(decodedTarget)}`);
      addToast(`Pane ${decodedTarget} killed`, 'success');
      route('/tmux');
    } catch (e) {
      addToast(`Failed to kill pane: ${e.message}`, 'error');
    }
  }

  return html`
    <div class="tmux-pane-page">
      <div class="tmux-pane-header">
        <div class="tmux-pane-header-primary">
          <a href="/tmux" class="ctrl-btn ctrl-btn-compact tmux-pane-back" title="Back to tmux panes">←</a>
          <h1 class="tmux-pane-title" title=${decodedTarget}>${decodedTarget}</h1>
        </div>
        <button class="ctrl-btn ctrl-btn-compact ctrl-danger-sm" onclick=${killPane}>Kill</button>
      </div>

      <${Terminal}
        content=${content}
        fullHeight=${true}
        captureKeyboard=${true}
        autoFocusKeyboard=${true}
        onTerminalKeyDown=${handleTerminalKeyDown}
        resetKey=${decodedTarget}
      />

      <div class="tmux-pane-controls">
        <div class="tmux-pane-key-strip">
          <${TerminalKeys} onKey=${sendKey} />
        </div>
        <form onSubmit=${handleSubmit} class="tmux-pane-input-form">
          <input
            type="text"
            class="input tmux-pane-input"
            placeholder="Send text..."
            value=${inputKeys}
            onInput=${e => { setInputKeys(e.target.value); }}
            enterkeyhint="send"
            autocomplete="off"
          />
          <button type="submit" class="ctrl-btn ctrl-btn-compact ctrl-send">Send</button>
          <button type="button" class="ctrl-btn ctrl-btn-compact" onclick=${sendEnterOnly} title="Send Enter key only">Enter</button>
          <${VoiceInput} onResult=${onVoiceResult} />
        </form>
      </div>
    </div>
  `;
}
