import { html } from 'htm/preact';
import { useEffect, useRef } from 'preact/hooks';
import {
  insertQuickToken,
  insertSkillToken,
  normalizeSkillPromptText,
  serializeSkillPromptNode,
  skillPromptHtml,
} from '../app/skill-tokens.mjs';

export function hasDroppedFiles(dataTransfer) {
  return [...(dataTransfer?.types || [])].includes('Files');
}

export function captureFileDrop(event, onDropFiles) {
  if (!hasDroppedFiles(event?.dataTransfer)) return false;
  // Cancel even when FileList is empty so contenteditable cannot insert a ghost <img>.
  event.preventDefault();
  const files = [...(event.dataTransfer?.files || [])];
  if (files.length) onDropFiles?.(files);
  return true;
}

function placeCaretAtEnd(el) {
  if (!el || typeof window === 'undefined') return;
  const selection = window.getSelection?.();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function SkillPromptComposer({
  value,
  placeholder = '',
  multiline = false,
  className = 'ctrl-input',
  insertRef = null,
  onSubmit = null,
  onDropFiles = null,
  ariaLabel = 'Prompt',
} = {}) {
  const editor = useRef(null);

  function writeEditor(text) {
    const el = editor.current;
    if (!el) return;
    el.innerHTML = skillPromptHtml(text) || '';
  }

  function readEditor() {
    return normalizeSkillPromptText(serializeSkillPromptNode(editor.current));
  }

  useEffect(() => {
    writeEditor(value.value);
  }, []);

  useEffect(() => {
    const el = editor.current;
    if (!el) return;
    if (readEditor() === normalizeSkillPromptText(value.value)) return;
    writeEditor(value.value);
  }, [value.value]);

  useEffect(() => {
    if (!insertRef) return undefined;
    insertRef.current = (tokenId, kind = 'skill') => {
      const el = editor.current;
      const next = kind === 'quick'
        ? insertQuickToken(value.value, tokenId)
        : insertSkillToken(value.value, tokenId);
      value.value = next.text;
      requestAnimationFrame(() => {
        if (!el) return;
        if (readEditor() !== normalizeSkillPromptText(next.text)) writeEditor(next.text);
        el.focus();
        placeCaretAtEnd(el);
      });
    };
    return () => {
      insertRef.current = null;
    };
  }, [insertRef, value]);

  function handleInput() {
    value.value = readEditor();
  }

  function handleKeyDown(event) {
    if (!multiline && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSubmit?.(event);
    }
  }

  function handleDragOver(event) {
    if (!hasDroppedFiles(event.dataTransfer)) return;
    event.preventDefault();
  }

  function handleDrop(event) {
    captureFileDrop(event, onDropFiles);
  }

  function handlePaste(event) {
    event.preventDefault();
    const pasted = event.clipboardData?.getData('text/plain') || '';
    const el = editor.current;
    if (!el) return;
    const selection = window.getSelection?.();
    if (selection && selection.rangeCount > 0 && el.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(pasted));
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      el.appendChild(document.createTextNode(pasted));
    }
    handleInput();
  }

  return html`
    <div class="skill-prompt-composer ${multiline ? 'skill-prompt-composer-multiline' : ''}">
      <div
        ref=${editor}
        class="skill-prompt-editor ${className}"
        contenteditable="true"
        role="textbox"
        aria-label=${ariaLabel}
        aria-multiline=${multiline ? 'true' : 'false'}
        enterkeyhint="send"
        data-placeholder=${placeholder}
        onInput=${handleInput}
        onKeyDown=${handleKeyDown}
        onPaste=${handlePaste}
        onDragOver=${handleDragOver}
        onDrop=${handleDrop}
      ></div>
    </div>
  `;
}
