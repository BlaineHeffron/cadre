import { detectProviderState, STATES } from '../agent/state-detector.mjs';

export function detectState(content) {
  return detectProviderState('claude', content);
}

export { STATES };
