import { randomBytes } from 'node:crypto';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendTmuxEnter(execFn, target) {
  const { code, stderr } = await execFn('tmux', ['send-keys', '-t', target, '--', 'Enter']);
  if (code !== 0) throw new Error(stderr || 'Failed to send Enter');
}

export async function sendTmuxText(execFn, {
  target,
  text = '',
  enter = true,
  delayMs = 300,
  sleepFn = sleep,
  bufferPrefix = 'dueno',
} = {}) {
  if (typeof text !== 'string') {
    throw new Error('Missing text in request body');
  }

  if (text) {
    const bufferName = `${bufferPrefix}-${randomBytes(4).toString('hex')}`;
    const loadBuffer = await execFn('tmux', ['load-buffer', '-b', bufferName, '-'], { input: text });
    if (loadBuffer.code !== 0) throw new Error(loadBuffer.stderr || 'Failed to stage input buffer');

    const paste = await execFn('tmux', ['paste-buffer', '-b', bufferName, '-d', '-p', '-t', target]);
    if (paste.code !== 0) throw new Error(paste.stderr || 'Failed to paste input');
  }

  if (enter !== false) {
    if (text && delayMs > 0) await sleepFn(delayMs);
    await sendTmuxEnter(execFn, target);
  }

  return { ok: true };
}
