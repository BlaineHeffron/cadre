import { detectPaneObservations } from './detector.mjs';
import { detectCodexTrust, WORKSPACE_TRUST_PROMPT_RE } from './codex.mjs';

export function detectClaudeTrust(content) {
  const numbered = detectCodexTrust(content);
  if (numbered) return numbered;
  const text = String(content || '');
  if (!WORKSPACE_TRUST_PROMPT_RE.test(text)) return null;
  if (!/do you trust this (?:folder|workspace|directory|project)/i.test(text)) return null;
  return { kind: 'trust', detail: 'Workspace trust confirmation required', options: [] };
}

export function observeClaudePane(content, options = {}) {
  return detectPaneObservations({
    provider: 'claude',
    content,
    ...options,
    interactionOverride: detectClaudeTrust(content),
  });
}

export const detectClaudePaneObservations = observeClaudePane;
