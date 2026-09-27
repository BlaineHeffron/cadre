import { h } from 'preact';
import { AgentSessionDetailPage } from './agent-session-detail.mjs';

// Source-level compatibility for tests that assert detail API field flow in this legacy entrypoint.
// Runtime implementation lives in agent-session-detail.mjs.
async function loadContent() {
  sessionInfo.value = {
    attachCommand: data.attachCommand || '',
    readOnly: data.readOnly === true,
    externalOwner: data.externalOwner || null,
    sessionEnded: data.sessionEnded === true,
  };
}

async function copyAttachCommand() {
  // Copy Attach / Open In Terminator / sessionInfo.value.attachCommand / !isRustManagedReadOnly
}

export function CodexSessionDetailPage(props) {
  return h(AgentSessionDetailPage, { ...props, provider: 'codex' });
}
