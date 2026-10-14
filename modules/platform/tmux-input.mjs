import { randomBytes } from 'node:crypto';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sendTmuxEnter(execFn, target) {
  const { code, stderr } = await execFn('tmux', ['send-keys', '-t', target, '--', 'Enter']);
  if (code !== 0) throw new Error(stderr || 'Failed to send Enter');
}

// Claude Code runs its pane with -icrnl. A child that restores "sane" stty flips
// it back, and the kernel then turns Enter into Ctrl+J: a newline, not a submit.
async function keepIcrnlOff(execFn, target, warn) {
  try {
    const tty = await execFn('tmux', ['display-message', '-p', '-t', target, '#{pane_tty}']);
    const path = tty.code === 0 ? tty.stdout.trim() : '';
    if (!path) throw new Error(tty.stderr || 'Failed to read pane tty');
    const stty = await execFn('stty', ['-F', path, '-icrnl']);
    if (stty.code !== 0) throw new Error(stty.stderr || 'Failed to clear icrnl');
  } catch (err) {
    warn(err);
  }
}

export async function sendTmuxText(execFn, {
  target,
  text = '',
  enter = true,
  delayMs = 300,
  sleepFn = sleep,
  bufferPrefix = 'dueno',
  icrnlOff = false,
  warn = () => {},
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
    if (icrnlOff) await keepIcrnlOff(execFn, target, warn);
    await sendTmuxEnter(execFn, target);
  }

  return { ok: true };
}
