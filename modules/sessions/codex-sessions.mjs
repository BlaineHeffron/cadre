import { getAgentSessionsProvider, stripCodexIndent } from './index.mjs';
import { claudeStreamJsonSessionsPlugin, hybridSessionsPlugin, isStructuredAutomatedSpawnsEnabled } from './claude-stream-json-sessions.mjs';

const codexProvider = getAgentSessionsProvider('codex');

export { stripCodexIndent };
export const createCodexSession = codexProvider.createSession;
export function isCodexAppServerEnabled(value = process.env.CODEX_APP_SERVER_ENABLED) {
  return /^(1|true|yes)$/i.test(String(value || ''));
}

export function codexSessionsPlugin(app, options = {}) {
  if (options.appServerEnabled ?? isCodexAppServerEnabled()) return claudeStreamJsonSessionsPlugin(app, { ...options, provider: 'codex' });
  return isStructuredAutomatedSpawnsEnabled('codex')
    ? hybridSessionsPlugin(app, { ...options, provider: 'codex', tmuxPlugin: codexProvider.plugin }) : codexProvider.plugin(app, options);
}
