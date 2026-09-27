import { getAgentSessionsProvider } from './index.mjs';
import { claudeStreamJsonSessionsPlugin } from './claude-stream-json-sessions.mjs';

const claudeProvider = getAgentSessionsProvider('claude');

export const createClaudeSession = claudeProvider.createSession;
export function isClaudeStreamJsonEnabled(value = process.env.CLAUDE_STREAM_JSON_ENABLED) {
  return /^(1|true|yes)$/i.test(String(value || ''));
}

export function claudeSessionsPlugin(app, options = {}) {
  const enabled = options.streamJsonEnabled ?? isClaudeStreamJsonEnabled();
  return enabled ? claudeStreamJsonSessionsPlugin(app, options) : claudeProvider.plugin(app, options);
}
