import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runtimeStatePath } from '../ops/runtime-state.mjs';
import { resolvePromptProfile } from './prompt-profile-catalog.mjs';

function text(value) {
  return String(value || '').trim();
}

export function promptProfilePath(backendType, sessionId) {
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
    const flag = placement === 'replace' ? '--system-prompt' : '--append-system-prompt';
    return [flag, body];
  }
  if (normalized === 'codex') {
    return ['-c', `developer_instructions=${JSON.stringify(body)}`];
  }
  return [];
}

export async function preparePromptProfileLaunch({
  promptProfile,
  backendType,
  sessionId,
  now = new Date(),
} = {}) {
  const resolved = resolvePromptProfile({ promptProfile, now });
  if (!resolved.body) {
    return {
      resolved,
      prepared: { body: '', placement: resolved.placement, filePath: '' },
    };
  }
  const filePath = promptProfilePath(backendType, sessionId);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${resolved.body}\n`, { mode: 0o600 });
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
