import { getAgentSessionsProvider } from './index.mjs';
import { claudeStreamJsonSessionsPlugin, hybridSessionsPlugin, isStructuredAutomatedSpawnsEnabled } from './claude-stream-json-sessions.mjs';

const claudeProvider = getAgentSessionsProvider('claude');

export const createClaudeSession = claudeProvider.createSession;
export function isClaudeStreamJsonEnabled(value = process.env.CLAUDE_STREAM_JSON_ENABLED) {
  return /^(1|true|yes)$/i.test(String(value || ''));
}

export function claudeSessionsPlugin(app, options = {}) {
  if (options.streamJsonEnabled ?? isClaudeStreamJsonEnabled()) return claudeStreamJsonSessionsPlugin(app, options);
  return isStructuredAutomatedSpawnsEnabled('claude')
    ? hybridSessionsPlugin(app, { ...options, tmuxPlugin: claudeProvider.plugin }) : claudeProvider.plugin(app, options);
}
