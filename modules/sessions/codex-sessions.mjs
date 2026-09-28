import { getAgentSessionsProvider, stripCodexIndent } from './index.mjs';
import { claudeStreamJsonSessionsPlugin } from './claude-stream-json-sessions.mjs';

const codexProvider = getAgentSessionsProvider('codex');

export { stripCodexIndent };
export const createCodexSession = codexProvider.createSession;
export function isCodexAppServerEnabled(value = process.env.CODEX_APP_SERVER_ENABLED) {
  return /^(1|true|yes)$/i.test(String(value || ''));
}

export function codexSessionsPlugin(app, options = {}) {
  const enabled = options.appServerEnabled ?? isCodexAppServerEnabled();
  return enabled ? claudeStreamJsonSessionsPlugin(app, { ...options, provider: 'codex' }) : codexProvider.plugin(app, options);
}
