import { getAgentSessionsProvider, stripCodexIndent } from './index.mjs';

const codexProvider = getAgentSessionsProvider('codex');

export { stripCodexIndent };
export const createCodexSession = codexProvider.createSession;
export const codexSessionsPlugin = codexProvider.plugin;
