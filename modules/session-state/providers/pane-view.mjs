const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_PREFIX_RE = /^((?:\r|\x1b\[[0-9;?]*[ -/]*[@-~])*)/;
const MAX_CODEX_GUTTER_WIDTH = 2;

export function stripCodexIndent(content) {
  const text = typeof content === 'string' ? content : '';
  if (!text) return text;
  const lines = text.split('\n');
  const indents = lines
    .map((line) => line.replace(ANSI_ESCAPE_RE, '').replace(/\r/g, ''))
    .filter((line) => line.trim() && line.startsWith(' '))
    .map((line) => line.match(/^ +/)?.[0].length || 0)
    .filter(Boolean);
  if (!indents.length) return text;
  const indent = ' '.repeat(Math.min(Math.min(...indents), MAX_CODEX_GUTTER_WIDTH));
  return lines.map((line) => {
    const prefix = line.match(ANSI_PREFIX_RE)?.[1] || '';
    const rest = line.slice(prefix.length);
    return rest.startsWith(indent) ? `${prefix}${rest.slice(indent.length)}` : line;
  }).join('\n');
}

function normalizeLine(line = '') {
  return String(line)
    .replace(ANSI_ESCAPE_RE, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSeparator(line) {
  return /^[-─━═_=]{6,}$/.test(line);
}

function isComposer(line) {
  return /^([>❯›]|You:)\s*(?:.*)?$/i.test(line);
}

function isSharedFooter(line) {
  return /^⏵⏵\s+/i.test(line)
    || /\bshift\+tab\b/i.test(line)
    || /\bpress enter to send\b/i.test(line)
    || /(?:^|\s·\s)\?\s+for shortcuts/i.test(line)
    || /^new task\?\s+\/clear\b/i.test(line)
    || /\btokens? left\b/i.test(line)
    || /\bbypass permissions\b/i.test(line);
}

function isTrailingBanner(line) {
  return /^✔\s+Update installed\b/i.test(line);
}

function isProviderFooter(provider, line) {
  if (isSharedFooter(line) || isTrailingBanner(line)) return true;
  if (provider === 'codex') {
    return /^[a-z][a-z0-9_.-]*\s+(?:minimal|low|medium|high|xhigh|max)\s+·/i.test(line)
      || /\b\d+% left\b/i.test(line);
  }
  return false;
}

function preliminaryRole(line) {
  if (!line) return 'blank';
  if (isSeparator(line)) return 'separator';
  if (isComposer(line)) return 'composer';
  return 'content';
}

function isChromeShaped(provider, line, role) {
  if (!line || role === 'blank' || role === 'separator' || role === 'composer') return true;
  return isProviderFooter(provider, line);
}

function applyTrailingChrome(entries, provider) {
  // Maximal run contiguous with the end of the pane. A quoted composer/footer
  // block with real content below it is not chrome, so it cannot hijack Pi
  // (whose real composer is blank and dropped).
  let chromeStart = entries.length;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (!isChromeShaped(provider, entries[index].line, entries[index].role)) break;
    chromeStart = index;
  }
  for (let index = chromeStart; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.role !== 'content' || !entry.line) continue;
    if (isProviderFooter(provider, entry.line)) entry.role = 'footer';
  }
}

export function normalizeProviderPane(provider, content = '') {
  const kind = String(provider || '').toLowerCase();
  const source = kind === 'codex' ? stripCodexIndent(String(content || '')) : String(content || '');
  const entries = source.split(/\r?\n/).map((raw) => {
    const line = normalizeLine(raw);
    return { line, role: preliminaryRole(line) };
  });
  applyTrailingChrome(entries, kind);
  for (let index = 0; index < entries.length; index += 1) {
    entries[index] = Object.freeze(entries[index]);
  }
  const lines = entries.map((entry) => entry.line).filter(Boolean);
  let promptIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].role !== 'composer') continue;
    const trailing = entries.slice(index + 1).filter((entry) => entry.line);
    if (trailing.every((entry) => ['separator', 'footer'].includes(entry.role))) {
      promptIndex = index;
      break;
    }
  }
  const activeLines = entries
    .filter((entry) => entry.line && !['separator', 'footer'].includes(entry.role))
    .map((entry) => entry.line);
  const contentLines = entries
    .filter((entry) => entry.line && entry.role === 'content')
    .map((entry) => entry.line);
  const footerLines = entries
    .filter((entry) => entry.line && entry.role === 'footer')
    .map((entry) => entry.line);
  const semanticFingerprintText = entries
    .filter((entry) => entry.line && !['separator', 'footer'].includes(entry.role))
    .map((entry) => entry.line)
    .join('\n');
  return Object.freeze({
    lines: Object.freeze(lines),
    activeLines: Object.freeze(activeLines),
    contentLines: Object.freeze(contentLines),
    footerLines: Object.freeze(footerLines),
    prompt: promptIndex >= 0 ? entries[promptIndex].line : '',
    promptVisible: promptIndex >= 0,
    semanticFingerprintText,
  });
}
