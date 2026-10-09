import { stripCodexIndent } from './pane-view.mjs';
import { detectPaneObservations } from './detector.mjs';

const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function normalizedLines(content) {
  return stripCodexIndent(String(content || ''))
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .split('\n')
    .map((line) => line.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function parseNumberedOptions(lines) {
  const options = [];
  for (const line of lines.slice(-16)) {
    const match = line.match(/^([>›❯])?\s*(\d+)[.)]\s+(.+)$/);
    if (!match) continue;
    options.push({ index: Number(match[2]), label: match[3].trim(), selected: Boolean(match[1]) });
  }
  return options;
}

export function detectCodexGuardrail(content) {
  const lines = normalizedLines(content);
  const context = lines.slice(-16).join('\n');
  const options = parseNumberedOptions(lines);
  const selected = options.find((option) => option.selected);
  const verificationOption = options.find((option) => (
    option.index === 2 && /^wait for verification\b/i.test(option.label)
  ));
  const guardrailContext = /verification guardrail/i.test(context)
    && /(?:choose how to continue|still (?:reviewing|verifying)|verification (?:is )?(?:pending|in progress))/i.test(context);
  if (!guardrailContext || options.length < 2 || selected?.index !== 1 || !verificationOption) return null;
  return {
    kind: 'guardrail',
    detail: 'Codex verification guardrail',
    options,
    policyOption: 2,
    policyLabel: verificationOption.label,
  };
}

export const WORKSPACE_TRUST_PROMPT_RE = /do you trust (?:the )?(?:authors|files|contents)|trust this (?:folder|workspace|directory|project)/i;

export function detectCodexTrust(content) {
  const lines = normalizedLines(content);
  const text = lines.slice(-16).join('\n');
  if (!WORKSPACE_TRUST_PROMPT_RE.test(text)) {
    return null;
  }
  const options = parseNumberedOptions(lines);
  const selected = options.find((option) => option.selected);
  const affirmative = options.find((option) => option.index === 1 && /\b(?:yes|trust|continue)\b/i.test(option.label));
  const negative = options.find((option) => option.index === 2 && /\b(?:no|exit|cancel|back)\b/i.test(option.label));
  if (selected?.index !== 1 || !affirmative || !negative) return null;
  return {
    kind: 'trust',
    detail: 'Workspace trust confirmation required',
    options,
  };
}

export function detectCodexUpdate(content) {
  const lines = normalizedLines(content);
  const text = lines.slice(-16).join('\n');
  const updateNotice = /\b(?:update available|new version available)\b/i.test(text);
  if (!updateNotice || !/\bupdate now\??\b/i.test(text)) return null;
  return {
    kind: 'update',
    detail: 'Codex update confirmation required',
    options: parseNumberedOptions(lines),
  };
}

export function parseCodexRuntimeFooter(content) {
  const lines = normalizedLines(content);
  for (const line of lines.slice(-8).reverse()) {
    const segments = line.split(/\s+·\s+/);
    const first = String(segments[0] || '').trim();
    const match = first.match(/^([a-z][a-z0-9_.-]*)\s+(minimal|low|medium|high|xhigh|max)$/i);
    if (!match || !THINKING_LEVELS.has(match[2].toLowerCase())) continue;
    return {
      effectiveModel: match[1],
      effectiveThinkingLevel: match[2].toLowerCase(),
    };
  }
  return null;
}

export function observeCodexPane(content, options = {}) {
  const interactionOverride = detectCodexGuardrail(content) || detectCodexTrust(content) || detectCodexUpdate(content);
  const runtime = parseCodexRuntimeFooter(content);
  return detectPaneObservations({
    provider: 'codex',
    content,
    ...options,
    interactionOverride,
    runtime,
  });
}

export const detectCodexPaneObservations = observeCodexPane;
