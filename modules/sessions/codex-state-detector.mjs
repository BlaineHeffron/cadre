import { detectProviderState, stripCodexIndent, STATES } from '../agent/state-detector.mjs';

export function detectState(content) {
  return detectProviderState('codex', content);
}

export { stripCodexIndent, STATES };
