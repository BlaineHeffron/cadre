import { h } from 'preact';
import { AgentControlBar } from './agent-control-bar.mjs';

export function CodexControlBar(props) {
  return h(AgentControlBar, { ...props, provider: 'codex' });
}
