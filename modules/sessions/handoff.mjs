import { exec } from '../../lib/exec.mjs';

export const HANDOFF_PROMPT_MAX_CHARS = 12_000;
export const HANDOFF_CLOSING = 'Continue this work from here. The previous session is paused; verify the working tree before acting.';
const GIT_SECTION_MAX_CHARS = 2_000;
// Provider-injected context (Codex <environment_context>, <user_instructions>, ...) is not conversation.
const INJECTED_CONTEXT = /^<[a-z_-]+>/i;

function clip(value, max, keep = 'head') {
  const text = String(value || '').trimEnd();
  if (text.length <= max) return text;
  const marker = '\n[…truncated…]\n';
  const room = Math.max(max - marker.length, 0);
  return keep === 'tail' ? `${marker}${text.slice(-room)}`.trim() : `${text.slice(0, room)}${marker}`.trimEnd();
}

export function visibleMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => ['user', 'assistant'].includes(message?.role) && typeof message.text === 'string')
    .map((message) => ({ role: message.role, text: message.text.trim() }))
    .filter((message) => message.text && !INJECTED_CONTEXT.test(message.text));
}

// `git status --short` and `git diff --stat` for workDir, or null when it is not a git work tree.
export async function readGitSummary(workDir, run = exec) {
  if (!workDir) return null;
  const status = await run('git', ['-C', workDir, 'status', '--short'], { timeout: 10_000 }).catch(() => null);
  if (!status || status.code !== 0) return null;
  const diff = await run('git', ['-C', workDir, 'diff', '--stat'], { timeout: 10_000 }).catch(() => null);
  return { status: status.stdout.trimEnd(), diffStat: diff?.code === 0 ? diff.stdout.trimEnd() : '' };
}

// A bounded, text-only brief for the session that continues a handoff: the newest content wins.
export function buildHandoffPrompt({ source = {}, firstTask = '', messages = [], git = null, workDir = '', maxChars = HANDOFF_PROMPT_MAX_CHARS } = {}) {
  const header = `Handoff from Cadre session ${source.id || 'unknown'} (provider ${source.provider || 'unknown'}, model ${source.model || 'default'}).`;
  const task = clip(firstTask, Math.floor(maxChars / 4));
  const gitText = git
    ? `## Working tree (${workDir})\n\n$ git status --short\n${clip(git.status, GIT_SECTION_MAX_CHARS) || '(clean)'}\n\n$ git diff --stat\n${clip(git.diffStat, GIT_SECTION_MAX_CHARS) || '(no unstaged changes)'}`
    : '';
  let budget = maxChars - [header, task, gitText, HANDOFF_CLOSING].join('\n\n').length - 120;
  const kept = [];
  const recent = visibleMessages(messages).filter((message) => message.text !== String(firstTask || '').trim());
  for (let index = recent.length - 1; index >= 0 && budget > 200; index -= 1) {
    const label = recent[index].role === 'user' ? '### User' : '### Assistant';
    const entry = `${label}\n\n${clip(recent[index].text, budget - label.length - 2, 'tail')}`;
    kept.unshift(entry);
    budget -= entry.length + 2;
  }
  const omitted = recent.length - kept.length;
  const conversation = kept.length
    ? `## Recent conversation (oldest first${omitted ? `; ${omitted} earlier messages omitted` : ''})\n\n${kept.join('\n\n')}`
    : '';
  return [header, task ? `## Original task\n\n${task}` : '', conversation, gitText, HANDOFF_CLOSING].filter(Boolean).join('\n\n');
}
