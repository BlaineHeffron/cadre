import { h } from 'preact';
import { SessionCard } from './session-card.mjs';

export function CodexSessionCard(props) {
  return h(SessionCard, { ...props, provider: 'codex' });
}
