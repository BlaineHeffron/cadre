import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readEnv } from '../platform/cadre-env.mjs';

export const DEFAULT_SESSION_WORKDIR = '~/projects/cadre';

export function expandHomePath(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === '~') return homedir();
  if (text.startsWith('~/')) return resolve(homedir(), text.slice(2));
  return text;
}

export async function normalizeSessionWorkDir(workDir = '') {
  const requested = String(workDir || '').trim() || readEnv('DUENO_DEFAULT_AGENT_WORKDIR') || DEFAULT_SESSION_WORKDIR;
  // A WSL2 worker takes POSIX paths on its own ext4 disk, not Windows or /mnt/<drive> paths.
  if (/^(?:[a-z]:[\\/]|\\\\wsl(?:\$|\.localhost)\\|\/mnt\/[a-z](?:\/|$))/i.test(requested)) {
    throw Object.assign(new Error(`Windows paths are not supported; use a path on the Linux disk: ${requested}`), {
      statusCode: 400, code: 'workdir_windows_path_unsupported',
    });
  }
  const expanded = expandHomePath(requested);
  if (!expanded) return '';

  const normalized = resolve(expanded);
  let stats;
  try {
    stats = await stat(normalized);
  } catch {
    if (!String(workDir || '').trim()) return '';
    const error = new Error(`Working directory does not exist: ${normalized}`);
    error.statusCode = 400;
    throw error;
  }

  if (!stats.isDirectory()) {
    const error = new Error(`Working directory is not a directory: ${normalized}`);
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}
