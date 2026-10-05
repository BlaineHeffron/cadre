import { readFile } from 'node:fs/promises';
import { sleep } from '../platform/tmux-input.mjs';

/** Bound for injectInitialPrompt. Startup waits fail open and inject anyway. */
export const STARTUP_INJECT_DEADLINE_MS = 20_000;

export async function readLaunchLogTail(launchLogPath) {
  if (!launchLogPath) return '';
  const content = await readFile(launchLogPath, 'utf8').catch(() => '');
  return content.slice(-12000).trim();
}

export async function waitForStartupPane(execFn, target, launchLogPath = '', { attempts = 10, intervalMs = 250 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await execFn('tmux', ['list-panes', '-t', target, '-F', '#{pane_dead}']);
    if (result.code === 0 && result.stdout.trim().split('\n').includes('0')) return;
    if (attempt + 1 < attempts) await sleep(intervalMs);
  }
  const tail = await readLaunchLogTail(launchLogPath);
  throw Object.assign(new Error(tail
    ? `Agent process exited during startup (${target}):\n${tail}`
    : `Agent startup pane unavailable after retry: ${target}`), { code: 'startup_pane_unavailable', statusCode: 500 });
}
