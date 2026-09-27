const NUMBERED_OPTION_RE = /^\s*[❯>›*•]?\s*(\d+)[.)]\s+(.+?)\s*$/;
const YES_NO_RE = /(?:\((?:y\/n|yes\/no)\)|\[(?:y\/n|yes\/no)\])/i;

function stripAnsi(text = '') {
  return String(text || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function cleanLabel(label = '') {
  return String(label || '')
    .trim()
    .replace(/\s*(?:\((?:esc|escape|enter|return|tab|space|[a-z])\)|\[(?:esc|escape|enter|return|tab|space|[a-z])\])\s*$/i, '')
    .trim()
    .slice(0, 60);
}

function dedupeOptions(options) {
  const seen = new Set();
  const result = [];
  for (const option of options) {
    if (!option.key || seen.has(option.key)) continue;
    seen.add(option.key);
    result.push(option);
  }
  return result;
}

export function parseAnswerOptions(rawPane = '', runtime = '', state = '') {
  const text = stripAnsi(rawPane);
  const numberedRuns = [];
  let current = [];

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(NUMBERED_OPTION_RE);
    if (match) {
      current.push({ key: match[1], label: cleanLabel(match[2]) });
      continue;
    }
    const trimmed = line.trim();
    if (current.length > 0 && (!trimmed || /^[-─━═]{3,}$/.test(trimmed))) {
      numberedRuns.push(current);
      current = [];
    }
  }

  if (current.length > 0) {
    numberedRuns.push(current);
  }

  const bottomRun = numberedRuns.at(-1) || [];
  const runsToCheck = bottomRun.length === 1 && /^Chat about this\.?$/i.test(bottomRun[0]?.label || '')
    ? numberedRuns.slice(0, -1)
    : numberedRuns;
  const menu = dedupeOptions(runsToCheck.at(-1) || []).filter((option) => option.label);
  if (menu.length >= 2) return menu;

  if (String(state || '') === 'needs_confirmation' && YES_NO_RE.test(text)) {
    return [
      { key: 'y', label: 'Yes' },
      { key: 'n', label: 'No' },
    ];
  }

  return [];
}
