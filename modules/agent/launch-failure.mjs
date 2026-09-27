/**
 * A harness that dies while its stderr is still piped through `tee` can leave the tmux pane
 * alive (tee holds the pty open), so `tmux has-session` alone reports a healthy launch for a
 * session that has no harness in it. Scanning the launch log for fatal startup errors catches
 * those blank sessions before they are recorded.
 */
const SHARED_LAUNCH_FAILURE_PATTERNS = Object.freeze([
  /\bCannot find module\b/i,
  /\bcommand not found\b/i,
  /^\s*Error: Failed to load extension\b/im,
]);

const RUNTIME_LAUNCH_FAILURE_PATTERNS = Object.freeze({
  pi: Object.freeze([
    /\bFailed to load extension\b/i,
    /\bUnknown option\b/i,
    /\bUnknown provider\b/i,
    /\bno model matched\b/i,
  ]),
  claude: Object.freeze([
    /\bSession ID .* is already in use\b/i,
  ]),
  codex: Object.freeze([]),
});

export function launchFailurePatterns(runtime = '') {
  const key = String(runtime || '').trim().toLowerCase();
  return [...SHARED_LAUNCH_FAILURE_PATTERNS, ...(RUNTIME_LAUNCH_FAILURE_PATTERNS[key] || [])];
}

/**
 * Returns the trimmed log when it contains a fatal startup error, '' otherwise.
 */
export function detectLaunchFailure(launchLog = '', runtime = '') {
  const text = String(launchLog || '');
  if (!text.trim()) return '';
  return launchFailurePatterns(runtime).some((pattern) => pattern.test(text)) ? text.trim() : '';
}
