const SPECIAL_KEYS = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Enter',
  Escape: 'Escape',
  Backspace: 'BSpace',
  Delete: 'Delete',
  Tab: 'Tab',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

const MODIFIER_ONLY = new Set(['Shift', 'Control', 'Alt', 'Meta']);

export function isEditableTarget(target) {
  if (!target || typeof target.closest !== 'function') return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

/**
 * Map browser keyboard events to tmux key names or literal text.
 * Returns:
 *   { type: 'tmuxKey', value: 'Enter' }
 *   { type: 'text', value: 'a' }
 *   null (ignore)
 */
export function mapKeyboardEventToTmux(event) {
  const { key, ctrlKey, altKey, metaKey, shiftKey } = event;
  if (!key || MODIFIER_ONLY.has(key)) return null;

  // Avoid hijacking browser/OS shortcuts such as Cmd+L/Cmd+R.
  if (metaKey) return null;

  // Shift+Tab should be BackTab in tmux.
  if (key === 'Tab' && shiftKey) {
    return { type: 'tmuxKey', value: 'BTab' };
  }

  if (ctrlKey && !altKey && key.length === 1) {
    // Let browser handle Ctrl+C as copy when text is selected
    if (key.toLowerCase() === 'c' && window.getSelection()?.toString()) {
      return null;
    }
    return { type: 'tmuxKey', value: `C-${key.toLowerCase()}` };
  }

  if (altKey && !ctrlKey && key.length === 1) {
    return { type: 'tmuxKey', value: `M-${key.toLowerCase()}` };
  }

  if (SPECIAL_KEYS[key]) {
    return { type: 'tmuxKey', value: SPECIAL_KEYS[key] };
  }

  if (!ctrlKey && !altKey && key.length === 1) {
    return { type: 'text', value: key };
  }

  return null;
}
