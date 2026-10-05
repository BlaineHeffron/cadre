/**
 * Shared agent session state detector.
 *
 * Provider differences live in PROVIDER_CONFIGS. Wrappers keep the old
 * claude/codex export surface stable until session modules are unified.
 */

const STATES = {
  NEEDS_APPROVAL: 'needs_approval',
  NEEDS_CONFIRMATION: 'needs_confirmation',
  WAITING_FOR_INPUT: 'waiting_for_input',
  THINKING: 'thinking',
  WORKING: 'working',
  PARKED: 'parked',
  UNKNOWN: 'unknown',
  EXITED: 'exited',
  ACTIVE: 'active',
};

import { normalizeProviderPane, stripCodexIndent } from './pane-view.mjs';

export { stripCodexIndent } from './pane-view.mjs';

function normalizeLine(line) {
  return String(line || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function matchesAny(lines, patterns) {
  return lines.some((line) => patterns.some((pattern) => pattern.test(line)));
}

function lineMatches(line, patterns) {
  return patterns.some((pattern) => pattern.test(line));
}

export function isCompletedThinkingLine(line = '') {
  // Completed form: "✻ Cooked for 9s" / "✻ Worked for 4m 23s".
  // Elapsed time terminates the line. A trailing parenthetical is the live form.
  return /^[✻✢✽✶✳✦*·]?\s*\S.+\s+for\s+\d+(?:\.\d+)?[smh](?:\s+\d+(?:\.\d+)?[smh])*$/i.test(line);
}

export function isLiveSpinnerLine(line = '') {
  // Live form is frame-independent: "Word… (22s · ↓ 1.1k tokens)".
  // Glyph identity is not part of the test — · * ✻ ✢ ✶ all appear in the wild.
  return /\S(?:…|\.\.\.)\s*\(\d+(?:\.\d+)?[smh](?:\s+\d+(?:\.\d+)?[smh])?\s*·/i.test(line);
}

const PI_BORDERED_WORKING_PATTERN = /^\s*[─━]+\s*[\u2800-\u28FF]\s+Working\s+[─━]/;

export function isStatusActivityLine(line = '') {
  return isLiveSpinnerLine(line)
    || isCompletedThinkingLine(line)
    || /\bWorking\.\.\./i.test(line)
    || /(?:^|[•◦])\s*Working \(\d+/i.test(line)
    || PI_BORDERED_WORKING_PATTERN.test(line)
    || /\bRetrying \(\d+\/\d+\) in \d+s\.\.\./i.test(line)
    || /\b(?:Auto-compacting|Compacting context|Summarizing branch)\.\.\./i.test(line);
}

function activeThinkingVisible(lines, patterns) {
  return lines.some((line) => (
    !isCompletedThinkingLine(line)
    && (isLiveSpinnerLine(line) || lineMatches(line, patterns))
  ));
}

function isShellPrompt(line = '') {
  if (!line) return false;
  if (/^[$%]\s*$/.test(line)) return true;
  if (/^(?:bash|zsh|sh|fish)(?:-[\d.]+)?[$%]\s*$/.test(line)) return true;
  if (/^[\w.-]+@[\w.-]+(?::[^$%]*)?[$%]\s*$/.test(line)) return true;
  if (/^[~/.\w-]+(?:\s+\([^)]+\))?\s*[$%]\s*$/.test(line)) return true;
  return false;
}

const SHARED_APPROVAL_PATTERNS = [
  /Do you want to proceed/i,
  /Do you want to allow/i,
  /Allow\s+(once|always)/i,
  /Approve\?/i,
  /Press Enter to allow/i,
  /\(Y\)es.*\(N\)o.*\(A\)lways/i,
  /\ballow\b.*\b(command|bash|read|write|edit|glob|grep|notebook|search|network|browser|sandbox)\b/i,
];

const SHARED_CONFIRM_PATTERNS = [
  /\(y\/n\)/i,
  /\[Y\/n\]/i,
  /\[y\/N\]/i,
  /\(yes\/no\)/i,
  /Do you want to continue/i,
  /Are you sure/i,
  /Overwrite\?/i,
];

const SHARED_THINKING_PATTERNS = [
  /Thinking\.\.\./i,
  /Contemplating/i,
  /thinking with .*effort/i,
  /Generating/i,
  /Planning/i,
  /Analyzing/i,
];

const SHARED_PROMPT_ONLY_PATTERNS = [
  /^>\s*$/,
  /^›\s*$/,
  /^❯\s*$/,
  /^You:\s*$/,
];

const SHARED_PROMPT_WITH_TEXT_PATTERNS = [
  /^>\s+.+$/,
  /^›\s+.+$/,
  /^❯\s+.+$/,
  /^You:\s+.+$/,
];

const SHARED_INPUT_PATTERNS = [
  ...SHARED_PROMPT_ONLY_PATTERNS,
  ...SHARED_PROMPT_WITH_TEXT_PATTERNS,
  /\btype a message\b/i,
  /\bWhat would you like/i,
  /\bHow can I help/i,
  /\bEnter your message\b/i,
  /\bpress enter to send\b/i,
];

const CODEX_WORKING_LINE_PATTERN = /(?:^|[•◦])\s*Working \(\d+[smh](?: \d+[smh])?(?: • .*?)?\)$/i;

const SHARED_WORKING_PATTERNS = [
  /\besc to interrupt\b/i,
];

const CODEX_PROMPT_SUPPRESS_WORK_PATTERNS = [
  CODEX_WORKING_LINE_PATTERN,
  /\besc to interrupt\b/i,
];

const SHARED_PARKED_PATTERNS = [
  /\bPress esc to go back\b/i,
  /\besc to go back\b/i,
  /\bpress up\/down to select\b/i,
  /\bpress enter to select\b/i,
  /\bpress q to quit\b/i,
  /\bPreCompact\b/i,
  /\bPostCompact\b/i,
  /\bhooks?\b.*\b(enabled|disabled|command|matcher|event)\b/i,
  /\bsettings\b.*\bhooks?\b/i,
  /\bsettings\b.*\b(model|notifications|approval|sandbox)\b/i,
  /\bConfigure\b.*\bhooks?\b/i,
  /\bmenu\b.*\besc\b/i,
];

const CODEX_PLACEHOLDER_PATTERNS = [
  /^summarize recent commits$/i,
  /^run \/review on my current changes$/i,
  /^ask codex/i,
  /^type a message/i,
];

export const PI_FOOTER_PATTERN = /(?:^|\s)(?:\?%?|\d+(?:\.\d+)?%)\/[\d.]+[kmg](?:\s+\(auto\))?\s+(?:\([^)]+\)\s+)?[a-z0-9][a-z0-9_.:/-]*(?:\s+•\s+(?:thinking\s+off|minimal|low|medium|high|xhigh|max))?$/i;
export const PI_CONTEXT_FOOTER_RE = /(?:^|\s)(?:\?%?|\d+(?:\.\d+)?%)\/[\d.]+[kmg](?:\s+\(auto\))?\s+(.+)$/i;

const PI_INPUT_PATTERNS = [
  ...SHARED_INPUT_PATTERNS,
  PI_FOOTER_PATTERN,
];

const PI_WORKING_PATTERNS = [
  ...SHARED_WORKING_PATTERNS,
  /\bWorking\.\.\.(?:\s+\([^)]*interrupt[^)]*\))?$/i,
  PI_BORDERED_WORKING_PATTERN,
  /\bRetrying \(\d+\/\d+\) in \d+s\.\.\./i,
  /\b(?:Auto-compacting|Compacting context|Summarizing branch)\.\.\./i,
];

const PI_THINKING_PATTERNS = [
  /Thinking\.\.\./i,
  /Contemplating/i,
  /thinking with .*effort/i,
  /Generating/i,
  /Planning/i,
  /Analyzing/i,
];

const PI_PROMPT_SUPPRESS_WORK_PATTERNS = [
  /\bWorking\.\.\.(?:\s+\([^)]*interrupt[^)]*\))?$/i,
  PI_BORDERED_WORKING_PATTERN,
  /\bRetrying \(\d+\/\d+\) in \d+s\.\.\./i,
  /\b(?:Auto-compacting|Compacting context|Summarizing branch)\.\.\./i,
];

const PROVIDER_CONFIGS = {
  claude: {
    stripArtifacts: (content) => content,
    approvalDetail: 'Tool approval needed',
    promptOnlyPatterns: SHARED_PROMPT_ONLY_PATTERNS,
    promptWithTextPatterns: SHARED_PROMPT_WITH_TEXT_PATTERNS,
    inputPatterns: SHARED_INPUT_PATTERNS,
    workingPatterns: SHARED_WORKING_PATTERNS,
    promptSuppressWorkPatterns: [],
    thinkingPatterns: SHARED_THINKING_PATTERNS,
    parkedPatterns: SHARED_PARKED_PATTERNS,
  },
  codex: {
    stripArtifacts: stripCodexIndent,
    approvalDetail: 'Approval needed',
    promptOnlyPatterns: SHARED_PROMPT_ONLY_PATTERNS,
    promptWithTextPatterns: SHARED_PROMPT_WITH_TEXT_PATTERNS,
    inputPatterns: SHARED_INPUT_PATTERNS,
    workingPatterns: [CODEX_WORKING_LINE_PATTERN, ...SHARED_WORKING_PATTERNS],
    promptSuppressWorkPatterns: CODEX_PROMPT_SUPPRESS_WORK_PATTERNS,
    thinkingPatterns: SHARED_THINKING_PATTERNS,
    parkedPatterns: SHARED_PARKED_PATTERNS,
  },
  pi: {
    stripArtifacts: (content) => content,
    approvalDetail: 'Approval needed',
    promptOnlyPatterns: SHARED_PROMPT_ONLY_PATTERNS,
    promptWithTextPatterns: SHARED_PROMPT_WITH_TEXT_PATTERNS,
    inputPatterns: PI_INPUT_PATTERNS,
    workingPatterns: PI_WORKING_PATTERNS,
    promptSuppressWorkPatterns: PI_PROMPT_SUPPRESS_WORK_PATTERNS,
    thinkingPatterns: PI_THINKING_PATTERNS,
    parkedPatterns: SHARED_PARKED_PATTERNS,
  },
};

export function detectProviderState(provider, content) {
  const providerName = String(provider || '').toLowerCase();
  const config = PROVIDER_CONFIGS[providerName] || PROVIDER_CONFIGS.codex;
  if (!content || typeof content !== 'string') {
    return { state: STATES.ACTIVE, needsInput: false, inputType: null, detail: null };
  }

  const view = normalizeProviderPane(providerName, content);
  const normalizedTail = view.activeLines.slice(-30).map(normalizeLine).filter(Boolean);
  const promptIndex = view.promptVisible ? normalizedTail.lastIndexOf(normalizeLine(view.prompt)) : -1;
  const lastLine = normalizedTail[normalizedTail.length - 1] || '';
  const recentLines = normalizedTail.slice(-8);
  const promptWindow = view.promptVisible
    ? normalizedTail.slice(promptIndex)
    : normalizedTail.slice(providerName === 'claude' ? -5 : -3);
  const footerLines = (view.footerLines || []).map(normalizeLine).filter(Boolean);
  // Pi has no composer, so view.promptVisible is false and the old last-8
  // window was the whole reply. An idle Pi footer means we are at a prompt,
  // not a permission dialog — do not treat content verbs as approval UI.
  const piIdleFooterVisible = providerName === 'pi'
    && matchesAny(normalizedTail.slice(-3), [PI_FOOTER_PATTERN]);
  const promptText = (
    promptIndex >= 0
      ? normalizedTail.slice(promptIndex)
      : piIdleFooterVisible
        ? []
        : normalizedTail.slice(-8)
  ).join('\n');
  const promptLine = normalizeLine(view.prompt);
  const nonChromeActive = normalizedTail.filter((line) => line && line !== promptLine);
  // Chrome + last 3 non-chrome active lines. Claude spinner sits at -2;
  // Pi Working... sits at -3 above cwd+status, which stay in activeLines.
  const statusLines = [
    ...footerLines,
    ...nonChromeActive.slice(-3).filter((line) => isStatusActivityLine(line)),
    // Codex may put a command and a tip below its background-terminal wait.
    ...providerName === 'codex' ? recentLines.filter((line) => /^◦\s+Waiting for background terminal\s+\(.*\besc to interrupt\b/i.test(line)) : [],
  ];
  const codexPlaceholderVisible = config === PROVIDER_CONFIGS.codex
    && matchesAny(promptWindow, CODEX_PLACEHOLDER_PATTERNS);

  const promptVisible = (
    view.promptVisible
    || lineMatches(lastLine, config.promptOnlyPatterns)
    || lineMatches(lastLine, config.promptWithTextPatterns)
    || matchesAny(promptWindow, config.inputPatterns)
    || codexPlaceholderVisible
  );
  const interruptVisible = matchesAny(footerLines, [/\besc to interrupt\b/i]);
  const liveSpinnerVisible = statusLines.some((line) => isLiveSpinnerLine(line));
  const activeWorkVisible = matchesAny(statusLines, config.workingPatterns) || interruptVisible;
  const activeWorkAtBottom = activeWorkVisible;
  const promptSuppressWorkVisible = matchesAny(statusLines, config.promptSuppressWorkPatterns || []);
  const thinkingVisible = providerName === 'claude'
    ? interruptVisible && (liveSpinnerVisible || activeThinkingVisible(statusLines, config.thinkingPatterns))
    : activeThinkingVisible(statusLines, config.thinkingPatterns);

  if (isShellPrompt(lastLine) && !promptVisible && !activeWorkVisible && !thinkingVisible) {
    return { state: STATES.EXITED, needsInput: false, inputType: null, detail: 'Session ended' };
  }

  for (const pattern of SHARED_APPROVAL_PATTERNS) {
    if (pattern.test(promptText)) {
      return { state: STATES.NEEDS_APPROVAL, needsInput: true, inputType: 'approval', detail: config.approvalDetail };
    }
  }

  for (const pattern of SHARED_CONFIRM_PATTERNS) {
    if (pattern.test(promptText)) {
      return { state: STATES.NEEDS_CONFIRMATION, needsInput: true, inputType: 'yes-no', detail: 'Confirmation needed' };
    }
  }

  if (matchesAny(recentLines, config.parkedPatterns)) {
    return { state: STATES.PARKED, needsInput: true, inputType: 'escape', detail: 'Parked on menu' };
  }

  if (thinkingVisible) {
    return { state: STATES.THINKING, needsInput: false, inputType: null, detail: 'Thinking' };
  }

  if (promptVisible && !activeWorkAtBottom && !promptSuppressWorkVisible) {
    return { state: STATES.WAITING_FOR_INPUT, needsInput: true, inputType: 'text', detail: 'Waiting for input' };
  }

  if (activeWorkVisible) {
    return { state: STATES.WORKING, needsInput: false, inputType: null, detail: 'Working' };
  }

  return { state: STATES.UNKNOWN, needsInput: true, inputType: 'attention', detail: 'Unknown session screen' };
}

export function detectorForProvider(provider) {
  return (content) => detectProviderState(provider, content);
}

export { PROVIDER_CONFIGS, STATES };
