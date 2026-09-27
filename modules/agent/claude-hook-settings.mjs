import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeStatePath } from '../ops/runtime-state.mjs';

export const CLAUDE_FLEET_HOOK_EVENTS = Object.freeze([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
]);

const REPORTER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../scripts/agent-hooks/log-event.mjs',
);

function text(value) {
  return String(value || '').trim();
}

function shellArg(value) {
  return JSON.stringify(String(value));
}

export function fleetHookReporterPath() {
  return REPORTER_PATH;
}

export function claudeHookSettingsPath(sessionId = '') {
  const id = text(sessionId) || 'unknown';
  return runtimeStatePath(`claude_hook_settings/claude-${id}.json`);
}

export function buildClaudeHookCommand({
  nodeBin = process.execPath,
  reporterPath = fleetHookReporterPath(),
  provider = 'claude',
} = {}) {
  return [
    shellArg(nodeBin),
    shellArg(reporterPath),
    shellArg('--provider'),
    shellArg(provider),
  ].join(' ');
}

export function buildClaudeHookSettings(options = {}) {
  const command = buildClaudeHookCommand(options);
  const hooks = {};
  for (const eventName of CLAUDE_FLEET_HOOK_EVENTS) {
    hooks[eventName] = [{
      matcher: '',
      hooks: [{ type: 'command', command }],
    }];
  }
  return Object.freeze({ hooks });
}

export async function prepareClaudeHookSettings({
  sessionId = '',
  nodeBin = process.execPath,
  reporterPath = fleetHookReporterPath(),
} = {}) {
  const settingsPath = claudeHookSettingsPath(sessionId);
  await mkdir(dirname(settingsPath), { recursive: true });
  const settings = buildClaudeHookSettings({ nodeBin, reporterPath, provider: 'claude' });
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return {
    settingsPath,
    reporterPath,
    events: [...CLAUDE_FLEET_HOOK_EVENTS],
  };
}

export async function cleanupClaudeHookSettings({ sessionId = '' } = {}) {
  const settingsPath = claudeHookSettingsPath(sessionId);
  await rm(settingsPath, { force: true }).catch(() => {});
  return settingsPath;
}
