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

// Claude hides this dialog's option numbers and lists "No" first, focused.
export function detectClaudeExternalImports(content) {
  const text = String(content || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
  if (!/Allow external CLAUDE\.md file imports\?[\s\S]*Yes, allow external imports/.test(text)) return null;
  return {
    kind: 'selection',
    detail: 'Allow external CLAUDE.md file imports?',
    options: [{ key: '1', label: 'No, disable external imports' }, { key: '2', label: 'Yes, allow external imports' }],
  };
}

export function observeClaudePane(content, options = {}) {
  return detectPaneObservations({
    provider: 'claude',
    content,
    ...options,
    interactionOverride: detectClaudeTrust(content) || detectClaudeExternalImports(content),
  });
}

export const detectClaudePaneObservations = observeClaudePane;
