import { h } from 'preact';
import { AgentControlBar } from './agent-control-bar.mjs';

export function ClaudeControlBar(props) {
  return h(AgentControlBar, { ...props, provider: 'claude' });
}
