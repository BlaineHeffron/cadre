import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const agents = await readFile(new URL('../public/pages/agents.mjs', import.meta.url), 'utf8');
const selector = await readFile(new URL('../public/components/mcp-capability-selector.mjs', import.meta.url), 'utf8');
const styles = await readFile(new URL('../public/styles/main.css', import.meta.url), 'utf8');

describe('new agent pane (prompt-first layout)', () => {
  it('puts the prompt composer first with a compact skill insert', () => {
    const form = agents.slice(agents.indexOf('class="card new-agent-form"'), agents.indexOf('new-agent-setup-grid'));
    assert.match(form, /SkillPromptComposer[\s\S]*multiline=\$\{true\}/);
    assert.match(form, /LaunchSkillSelector[\s\S]*compact=\$\{true\}/);
    // The prompt is the hero element, so it keeps the shared multiline height.
    assert.doesNotMatch(styles, /\.new-agent-prompt \.skill-prompt-editor\s*\{[^}]*min-height/);
  });

  it('spaces sections from the container, not adjacent-sibling margins', () => {
    assert.match(styles, /\.new-agent-form\s*\{[^}]*flex-direction: column;[^}]*gap: 14px/);
    // An optional node (e.g. the Codex helper) must not be able to collapse a gap.
    assert.doesNotMatch(styles, /\.new-agent-setup-grid \+ \.new-agent-section/);
    assert.doesNotMatch(styles, /p\.new-agent-hint \+ \.new-agent-section/);
    assert.match(styles, /@media \(max-width: 720px\)[\s\S]*\.new-agent-setup-grid\s*\{\s*grid-template-columns: repeat\(2/);
  });

  it('does not render an empty helper paragraph for Codex thinking levels', () => {
    assert.match(agents, /const codexThinkingHelp = normalizeProvider\(newProvider\.value\) === 'codex'/);
    assert.match(agents, /\$\{codexThinkingHelp \? html`\s*<p class="new-agent-hint">\$\{codexThinkingHelp\}<\/p>/);
  });

  it('escapes progressively instead of discarding a typed prompt', () => {
    const start = agents.indexOf("if (e.key !== 'Escape') return;");
    assert.ok(start > 0, 'the form must guard on Escape');
    const handler = agents.slice(start, agents.indexOf('<span class="card-title">New Agent Session</span>'));
    assert.match(handler, /if \(showFolderPicker\.value\) \{ showFolderPicker\.value = false; return; \}/);
    assert.match(handler, /if \(newPrompt\.value\.trim\(\)\) return;/);
    assert.ok(
      handler.indexOf('newPrompt.value.trim()') < handler.indexOf('showNewModal.value = false'),
      'the draft guard must run before the close'
    );
  });

  it('opens Advanced when the MCP selection needs attention and lets the user close it', () => {
    assert.match(agents, /const advancedNeedsAttention = newMcpWarning\.value/);
    assert.match(agents, /if \(advancedNeedsAttention\) newAdvancedOpen\.value = true;/);
    assert.match(agents, /open=\$\{newAdvancedOpen\.value\}[\s\S]*onToggle=\$\{e => \{ newAdvancedOpen\.value = e\.target\.open; \}\}/);
    assert.match(agents, /onWarning=\$\{\(warning\) => \{ newMcpWarning\.value = warning; \}\}/);
    assert.match(agents, /newAdvancedOpen\.value = false;/);
  });
});

describe('MCP capability rows keep their detail reachable', () => {
  it('reports availability and compatibility warnings to the host form', () => {
    assert.match(selector, /onWarning = null/);
    assert.match(selector, /const hasWarning = Boolean\(catalog\.value\) &&/);
    assert.match(selector, /useEffect\(\(\) => \{\s*onWarning\?\.\(hasWarning\);\s*\}, \[hasWarning\]\);/);
  });

  it('exposes truncated descriptions and selected-server permissions', () => {
    assert.match(selector, /class="mcp-selector-row-desc" title=\$\{server\.description \|\| ''\}/);
    assert.match(selector, /const permissionsId = \(checked && server\.permissions\) \? `mcp-perm-\$\{server\.id\}` : undefined;/);
    assert.match(selector, /aria-describedby=\$\{permissionsId\}/);
    assert.match(selector, /<span class="mcp-selector-row-perms" id=\$\{permissionsId\}>Permissions: \$\{server\.permissions\}<\/span>/);
    assert.match(styles, /\.mcp-selector-row-perms\s*\{/);
  });
});
