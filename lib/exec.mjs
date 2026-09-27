import { execFile } from 'node:child_process';
import { basename } from 'node:path';

export function commandEnvironment(cmd, overrides = {}) {
  const env = { ...process.env, ...overrides };
  if (basename(String(cmd)) === 'tmux') {
    // Fleet sessions live on the default socket. An inherited TMUX value can
    // point at a dead custom server even while its socket file still exists.
    delete env.TMUX;
    delete env.TMUX_PANE;
  }
  return env;
}

/**
 * Execute a command safely using execFile (not shell interpolation).
 * @param {string} cmd — the executable path
 * @param {string[]} args — arguments array
 * @param {object} [opts] — options: timeout (ms), cwd, env, input
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export function exec(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const timeout = opts.timeout ?? 30000;
    const child = execFile(cmd, args, {
      timeout,
      maxBuffer: 1024 * 1024, // 1MB
      cwd: opts.cwd,
      env: commandEnvironment(cmd, opts.env),
    }, (error, stdout, stderr) => {
      if (error && error.killed) {
        reject(new Error(`Command timed out after ${timeout}ms: ${cmd}`));
        return;
      }
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        code: error ? error.code ?? 1 : 0,
      });
    });
    if (opts.input !== undefined) {
      try {
        if (!child.stdin) throw new Error(`Command stdin is unavailable: ${cmd}`);
        child.stdin.end(opts.input);
      } catch (error) {
        reject(error);
      }
    }
  });
}
