import { html } from 'htm/preact';
import { useRef } from 'preact/hooks';
import { providerDescriptor } from '../app/providers.mjs';
import { useSignal } from '../app/use-signal.mjs';
import { openSkillWriterWithDraft } from '../app/skill-drafts.mjs';
import { LaunchSkillSelector } from './launch-skill-selector.mjs';
import { SkillPromptComposer } from './skill-prompt-composer.mjs';
import { appendTranscript, VoiceInput } from './voice-input.mjs';

function haptic(ms = 50) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

const SLASH_COMMANDS = [
  { cmd: '/compact', label: 'Compact' },
  { cmd: '/clear', label: 'Clear' },
  { cmd: '/cost', label: 'Cost' },
  { cmd: '/help', label: 'Help' },
  { cmd: '/quit', label: 'Quit' },
];

const DELAY_OPTIONS = [
  { label: 'Now', value: 0 },
  { label: '30s', value: 30000 },
  { label: '1m', value: 60000 },
  { label: '2m', value: 120000 },
  { label: '5m', value: 300000 },
  { label: '10m', value: 600000 },
  { label: '30m', value: 1800000 },
  { label: '1h', value: 3600000 },
];

const DELAY_UNITS = [
  { label: 'sec', value: 1000 },
  { label: 'min', value: 60000 },
  { label: 'hr', value: 3600000 },
  { label: 'day', value: 86400000 },
];

export function AgentControlBar({
  provider = 'claude',
  state,
  onApprove,
  onReject,
  onEscape,
  onDialogAnswer,
  onSendInput,
  onSlashCommand,
  onScheduledSend,
  quickInsertOptions = [],
  onAttachImage,
  onDropFiles,
  onClearImage,
  imageAttached = false,
  imageSending = false,
  imagePreviewUrl = '',
  imageNote = '',
  inputText,
}) {
  const descriptor = providerDescriptor(provider);
  const skillInsert = useRef(null);
  const showSlash = useSignal(false);
  const selectedDelay = useSignal(0);
  const customDelayAmount = useSignal('');
  const customDelayUnit = useSignal(60000);
  const sessionStatus = state?.status || 'unknown';
  const policyControlled = ['guardrail', 'trust'].includes(state?.interaction?.kind);
  const canAnswerInteraction = state?.capabilities?.canAnswerInteraction === true;
  const interactionOptions = canAnswerInteraction && Array.isArray(state?.interaction?.options)
    ? state.interaction.options
    : [];

  function selectedScheduleDelay() {
    if (selectedDelay.value !== 'custom') return Number(selectedDelay.value) || 0;
    const amount = Number(customDelayAmount.value);
    if (!Number.isFinite(amount) || amount <= 0) return 0;
    return Math.round(amount * Number(customDelayUnit.value || 60000));
  }

  function handleApprove() {
    haptic(30);
    onApprove?.();
  }

  // Not the same as the Escape button in the terminal key row: that one sends a
  // raw key, while this route lets the server promote it to an interrupt when
  // the session reports canInterrupt.
  function handleReject() {
    haptic(30);
    (onReject || onEscape)?.();
  }

  function handleDialogAnswer(option) {
    haptic(30);
    onDialogAnswer?.(option);
  }

  function handleSubmit(e) {
    e.preventDefault();
    const delay = selectedScheduleDelay();
    // An attached image always goes now: the image endpoint writes the file
    // into the session workspace and announces it in the same message, so a
    // half-filled custom delay must not block it either.
    if (imageAttached) {
      onSendInput();
      return;
    }
    if (selectedDelay.value === 'custom' && delay <= 0) return;
    if (delay > 0 && onScheduledSend) {
      const draft = inputText.value;
      Promise.resolve(onScheduledSend(draft, delay)).then((scheduled) => {
        // Keep the draft when the schedule never landed, so a failed send is
        // recoverable instead of silently discarded.
        if (scheduled !== false && inputText.value === draft) inputText.value = '';
      });
    } else {
      onSendInput();
    }
  }

  function handleSlash(cmd) {
    showSlash.value = false;
    onSlashCommand(cmd);
  }

  // Quick insert drops a chip carrying only the target id. The full watch
  // prompt is resolved from live thread state when the message is sent.
  function handleQuickInsert(e) {
    const value = String(e.target.value || '');
    e.target.value = '';
    if (value) skillInsert.current?.(value, 'quick');
  }

  return html`
    <div class="claude-control-bar">
      ${sessionStatus === 'blocked' ? html`
        <div class="control-row control-row-primary">
          ${interactionOptions.length > 0 ? interactionOptions.map((option) => html`
            <button class="ctrl-btn ctrl-approve" onclick=${() => handleDialogAnswer(option)}>
              ${typeof option === 'string' ? option : option.label || option.text || option.value || option.index}
            </button>
          `) : policyControlled ? html`
            <span style="font-size:12px; color:var(--text-muted)">Applying automatic safety policy…</span>
          ` : canAnswerInteraction && state?.interaction?.kind === 'permission' && onApprove ? html`
            <button class="ctrl-btn ctrl-approve pulse-border" onclick=${handleApprove}>Approve</button>
            <button class="ctrl-btn ctrl-reject" onclick=${handleReject}>Reject</button>
          ` : canAnswerInteraction && state?.interaction?.kind === 'confirmation' ? html`
            <button class="ctrl-btn ctrl-yes" onclick=${() => handleDialogAnswer('y')}>Yes</button>
            <button class="ctrl-btn ctrl-no" onclick=${() => handleDialogAnswer('n')}>No</button>
          ` : onEscape ? html`
            <button class="ctrl-btn ctrl-reject" onclick=${handleReject}>Escape</button>
          ` : html`<span style="font-size:12px; color:var(--text-muted)">No canonical response options available.</span>`}
        </div>
      ` : null}

      ${imagePreviewUrl ? html`
        <div class="control-row control-row-attachment">
          <div class="control-attachment-preview">
            <img class="control-attachment-thumb" src=${imagePreviewUrl} alt="Attached image" draggable=${false} ondragstart=${(e) => e.preventDefault()} />
            ${onClearImage && !imageSending ? html`
              <button type="button" class="control-attachment-remove" aria-label="Remove attached image" onclick=${onClearImage}>×</button>
            ` : null}
          </div>
          ${imageNote ? html`<div class="goals-inline-note">${imageNote}</div>` : null}
        </div>
      ` : null}

      <div class="control-row control-row-tools">
        ${descriptor.hasShiftTab ? html`
          <button type="button" class="ctrl-btn ctrl-default ctrl-btn-compact" onclick=${handleApprove} title="Shift+Tab">
            S-Tab
          </button>
        ` : null}
        <button type="button" class="ctrl-btn ctrl-default ctrl-btn-compact" onclick=${handleReject} title="Escape / interrupt">
          Esc
        </button>
        <${LaunchSkillSelector} compact=${true} onInsert=${(id) => skillInsert.current?.(id)} />
        <button
          type="button"
          class="ctrl-btn ctrl-default ctrl-btn-compact"
          title="Open the skill writer with this prompt text"
          disabled=${!inputText.value.trim()}
          onclick=${() => openSkillWriterWithDraft(inputText.value)}>
          Save as skill
        </button>
        ${quickInsertOptions.length > 0 ? html`
          <select class="ctrl-inline-select ctrl-inline-select-compact" aria-label="Quick insert" onInput=${handleQuickInsert}>
            <option value="">Quick insert</option>
            ${quickInsertOptions.map((option) => html`
              <option value=${option.key} title=${option.label}>${option.label}</option>
            `)}
          </select>
        ` : null}
        ${onAttachImage ? html`
          <label class="ctrl-btn ctrl-default ctrl-btn-compact session-image-picker" style="cursor:pointer" title="Attach an image to the next message">
            ${imageAttached ? 'Image ✓' : 'Image'}
            <input type="file" accept="image/*" capture="environment" style="display:none" onChange=${onAttachImage} />
          </label>
        ` : null}
        <select
          class="ctrl-inline-select ctrl-inline-select-tiny"
          aria-label="Send delay"
          disabled=${imageAttached}
          title=${imageAttached ? 'Images send immediately' : 'Send delay'}
          value=${String(selectedDelay.value)}
          onInput=${e => { selectedDelay.value = e.target.value === 'custom' ? 'custom' : Number(e.target.value); }}
        >
          ${DELAY_OPTIONS.map(o => html`<option value=${String(o.value)}>${o.label}</option>`)}
          <option value="custom">Custom</option>
        </select>
        ${selectedDelay.value === 'custom' ? html`
          <input
            type="number"
            class="ctrl-input"
            style="flex:0 1 76px; min-width:64px"
            min="0"
            step="any"
            inputmode="decimal"
            placeholder="Amount"
            value=${customDelayAmount.value}
            onInput=${e => { customDelayAmount.value = e.target.value; }}
          />
          <select
            class="ctrl-inline-select ctrl-inline-select-tiny"
            aria-label="Delay unit"
            value=${String(customDelayUnit.value)}
            onInput=${e => { customDelayUnit.value = Number(e.target.value); }}
          >
            ${DELAY_UNITS.map(o => html`<option value=${String(o.value)}>${o.label}</option>`)}
          </select>
        ` : null}
        ${descriptor.hasSlash ? html`
          <button type="button" class="ctrl-btn ctrl-slash ctrl-btn-compact" onclick=${() => { showSlash.value = !showSlash.value; }}>/</button>
        ` : null}
      </div>

      <form class="control-row control-row-compose" onSubmit=${handleSubmit}>
        <${SkillPromptComposer}
          value=${inputText}
          insertRef=${skillInsert}
          placeholder=${imageAttached
            ? 'Message to send with the image...'
            : (sessionStatus === 'ready' ? 'Type a message...' : 'Send text to session...')}
          className="ctrl-input"
          onSubmit=${handleSubmit}
          onDropFiles=${onDropFiles}
          ariaLabel="Session prompt"
        />
        <${VoiceInput} className="ctrl-btn" hotkey onResult=${(text) => { inputText.value = appendTranscript(inputText.value, text); }} />
        <button
          type="submit"
          class="ctrl-btn ctrl-send"
          disabled=${imageSending
            || (!imageAttached && selectedDelay.value === 'custom' && selectedScheduleDelay() <= 0)
            || ((imageAttached || selectedScheduleDelay() === 0) && state?.capabilities?.canQueueMessage !== true)}>
          ${imageSending ? 'Sending…' : (selectedScheduleDelay() > 0 && !imageAttached ? 'Schedule' : 'Send')}
        </button>
      </form>

      ${descriptor.hasSlash && showSlash.value ? html`
        <div class="control-row control-row-slash">
          ${SLASH_COMMANDS.map(({ cmd, label }) => html`
            <button class="ctrl-btn ctrl-slash-cmd" onclick=${() => handleSlash(cmd)}>${label}</button>
          `)}
        </div>
      ` : null}
    </div>
  `;
}
