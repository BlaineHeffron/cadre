import { chmod, lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import { resolvePromptProfile } from './prompt-profile-catalog.mjs';

function text(value) {
  return String(value || '').trim();
}

// Codex takes a profile only as `-p <name>`, loaded from $CODEX_HOME/<name>.config.toml.
export function promptProfilePath(backendType, sessionId, { codexHome = '' } = {}) {
  if (text(backendType) === 'codex') {
    return join(codexHome || process.env.CODEX_HOME || join(homedir(), '.codex'), `cadre-${text(sessionId)}.config.toml`);
  }
  return runtimeStatePath(`prompt_profiles/${text(backendType)}-${text(sessionId)}.txt`);
}

export function buildPromptLaunchArgs({ runtime = '', promptLaunch = null } = {}) {
  const body = text(promptLaunch?.body);
  if (!body) return [];
  const placement = promptLaunch.placement === 'replace' ? 'replace' : 'append';
  const normalized = String(runtime || '').trim().toLowerCase();
  if (normalized === 'claude') {
    const flag = placement === 'replace' ? '--system-prompt-file' : '--append-system-prompt-file';
    return promptLaunch.filePath ? [flag, promptLaunch.filePath] : [];
  }
  if (normalized === 'pi') {
    // Pi reads either flag's value as a file when the path exists.
    const flag = placement === 'replace' ? '--system-prompt' : '--append-system-prompt';
    return promptLaunch.filePath ? [flag, promptLaunch.filePath] : [];
  }
  if (normalized === 'codex') {
    return promptLaunch.filePath ? ['-p', basename(promptLaunch.filePath, '.config.toml')] : [];
  }
  return [];
}

export async function preparePromptProfileLaunch({
  promptProfile,
  backendType,
  sessionId,
  codexHome = '',
  now = new Date(),
} = {}) {
  const resolved = resolvePromptProfile({ promptProfile, now });
  if (!resolved.body) {
    return {
      resolved,
      prepared: { body: '', placement: resolved.placement, filePath: '' },
    };
  }
  const filePath = promptProfilePath(backendType, sessionId, { codexHome });
  // A sandboxed agent can write its CODEX_HOME, so never follow a link it planted there.
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  if (codexHome && !(await lstat(dirname(filePath))).isDirectory()) throw new Error(`Prompt profile directory is not a plain directory: ${dirname(filePath)}`);
  await rm(filePath, { force: true });
  // JSON string escapes are valid TOML basic-string escapes, except DEL, which TOML requires escaped.
  const content = text(backendType) === 'codex' ? `developer_instructions = ${JSON.stringify(resolved.body).replace(/\x7f/g, '\\u007f')}` : resolved.body;
  await writeFile(filePath, `${content}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(filePath, 0o600).catch(() => {});
  return {
    resolved,
    prepared: {
      body: resolved.body,
      placement: resolved.placement,
      filePath,
    },
  };
}

export async function cleanupPromptProfileLaunch({ backendType, sessionId } = {}) {
  await rm(promptProfilePath(backendType, sessionId), { force: true }).catch(() => {});
}

export function sanitizedPromptSnapshot(resolved) {
  return Object.freeze({
    profileId: resolved.profileId,
    placement: resolved.placement,
    catalogVersion: resolved.catalogVersion,
    catalogDigest: resolved.catalogDigest,
    attached: Boolean(text(resolved.body)),
  });
}
