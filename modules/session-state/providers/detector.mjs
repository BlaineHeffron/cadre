import { createHash } from 'node:crypto';
import { detectProviderState, PI_FOOTER_PATTERN } from './patterns.mjs';
import { normalizeProviderPane } from './pane-view.mjs';
import { normalizeObservation } from '../contract.mjs';
import { PANE_FRESH_MS } from '../tracker.mjs';

const LEGACY_INTERACTIONS = Object.freeze({
  waiting_for_input: 'free_text',
  needs_approval: 'permission',
  needs_confirmation: 'confirmation',
  parked: 'selection',
  unknown: 'unknown_blocking',
});

const PI_INPUT_FOOTER_RE = PI_FOOTER_PATTERN;

function fingerprint(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);
}

function freeTextStabilityFingerprint(provider, content = '') {
  return fingerprint(normalizeProviderPane(provider, content).semanticFingerprintText);
}

function interactionFingerprint(interaction = {}) {
  const options = Array.isArray(interaction.options) ? interaction.options : [];
  return fingerprint(JSON.stringify({
    kind: String(interaction.kind || ''),
    detail: String(interaction.detail || '').trim(),
    options: options.map((option) => (
      typeof option === 'string'
        ? option.trim()
        : {
            key: String(option?.key ?? option?.index ?? option?.value ?? ''),
            label: String(option?.label ?? option?.text ?? '').trim(),
          }
    )),
  }));
}

function parseNumberedSelection(content = '', { composerVisible = false } = {}) {
  // A real full-screen selection replaces the normal text composer. Numbered
  // prose above a visible composer is output, even when its first line happens
  // to use the same arrow glyph as the selection cursor.
  if (composerVisible) return null;
  const lines = String(content || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).slice(-30);
  const runs = [];
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*([❯>›])?\s*(\d+)[.)]\s+(.+?)\s*$/);
    if (!match) {
      if (lines[index].trim()) current = null;
      continue;
    }
    const optionNumber = Number(match[2]);
    const previousNumber = Number(current?.options.at(-1)?.key || 0);
    if (!current || optionNumber !== previousNumber + 1) {
      current = { firstOptionIndex: index, selected: false, options: [] };
      runs.push(current);
    }
    current.selected ||= Boolean(match[1]);
    current.options.push({ key: match[2], label: match[3].trim().slice(0, 80) });
  }
  for (const menu of runs.filter((run) => (
    run.selected
    && run.options.length >= 2
    && run.options[0]?.key === '1'
  )).reverse()) {
    let detail = '';
    for (let index = menu.firstOptionIndex - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line || /^[-─━═]{3,}$/.test(line)) continue;
      detail = line.replace(/^[☐☑]\s*/, '').trim();
      break;
    }
    const isPrompt = /\?$/.test(detail)
      || /^(?:choose|select|pick|which|do you want|would you like|how should|please (?:choose|select|pick))\b/i.test(detail);
    if (isPrompt) return { kind: 'selection', detail, options: menu.options };
  }
  return null;
}

function paneObservation(kind, value, observedAt, expiresAt, paneFingerprint) {
  return normalizeObservation({
    source: 'pane',
    kind,
    value,
    observedAt,
    expiresAt,
    fingerprint: `${kind}:${paneFingerprint}`,
  });
}

export function detectPaneObservations({
  provider,
  content,
  observedAt = Date.now(),
  expiresAt = Number(observedAt) + PANE_FRESH_MS,
  stable = true,
  requireRepeat = false,
  interactionOverride = null,
  runtime = null,
} = {}) {
  const timestamp = Number(observedAt);
  const paneFingerprint = fingerprint(content);
  const stabilityFingerprint = freeTextStabilityFingerprint(provider, content);
  const legacy = detectProviderState(provider, content);
  const paneView = normalizeProviderPane(provider, content);
  const composerVisible = paneView.promptVisible
    || (
      String(provider || '').toLowerCase() === 'pi'
      && paneView.lines.slice(-8).some((line) => PI_INPUT_FOOTER_RE.test(line))
    );
  const observations = [];
  const interaction = interactionOverride
    || parseNumberedSelection(content, { composerVisible })
    || LEGACY_INTERACTIONS[legacy.state];

  if (legacy.state === 'exited') {
    observations.push(paneObservation(
      'lifecycle',
      { lifecycle: 'ended', detail: legacy.detail || 'Session ended' },
      timestamp,
      0,
      paneFingerprint,
    ));
  }

  if (interaction) {
    const interactionValue = typeof interaction === 'string'
      ? {
          kind: interaction,
          detail: legacy.detail || '',
          options: legacy.state === 'needs_confirmation'
            ? [{ key: 'y', label: 'Yes' }, { key: 'n', label: 'No' }]
            : [],
          stable: interaction === 'free_text' && stable,
          requireRepeat: interaction === 'free_text' && requireRepeat,
          stabilityFingerprint: interaction === 'free_text' ? stabilityFingerprint : '',
        }
      : {
          ...interaction,
          stable: interaction.kind === 'free_text' && stable,
          requireRepeat: interaction.kind === 'free_text' && requireRepeat,
          stabilityFingerprint: interaction.kind === 'free_text' ? stabilityFingerprint : '',
        };
    observations.push(paneObservation(
      'interaction',
      interactionValue,
      timestamp,
      Number(expiresAt),
      interactionValue.kind === 'free_text'
        ? paneFingerprint
        : interactionFingerprint(interactionValue),
    ));
  } else {
    observations.push(paneObservation(
      'interaction',
      { kind: 'none', detail: '', options: [], stable: false },
      timestamp,
      Number(expiresAt),
      paneFingerprint,
    ));
  }

  const execution = legacy.state === 'thinking'
    ? 'thinking'
    : legacy.state === 'working'
      ? 'working'
      : legacy.state === 'waiting_for_input'
        ? 'idle'
        : 'unknown';
  observations.push(paneObservation(
    'execution',
    { execution, detail: legacy.detail || '' },
    timestamp,
    Number(expiresAt),
    paneFingerprint,
  ));

  if (runtime && (runtime.effectiveModel || runtime.effectiveThinkingLevel)) {
    observations.push(paneObservation(
      'effective_runtime',
      {
        effectiveModel: String(runtime.effectiveModel || ''),
        effectiveThinkingLevel: String(runtime.effectiveThinkingLevel || ''),
      },
      timestamp,
      Number(expiresAt),
      paneFingerprint,
    ));
  }

  return Object.freeze(observations);
}

export { fingerprint as fingerprintPane };
