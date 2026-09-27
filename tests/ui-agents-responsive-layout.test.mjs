import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('responsive agents layout', () => {
  it('uses desktop master/detail while preserving mobile session cards', async () => {
    const agents = await readFile('public/pages/agents.mjs', 'utf8');
    const detail = await readFile('public/pages/agent-session-detail.mjs', 'utf8');
    const styles = await readFile('public/styles/main.css', 'utf8');

    assert.match(agents, /DESKTOP_AGENTS_QUERY = '\(min-width: 981px\)'/);
    assert.match(agents, /class="agents-desktop-shell"/);
    assert.match(agents, /<\$\{AgentRailRow\}/);
    assert.match(agents, /<\$\{AgentSessionDetailPage\}[\s\S]*embedded=\$\{true\}/);
    assert.match(agents, /desktopLayout\.value \? html`[\s\S]*: html`[\s\S]*<\$\{SessionCard\}/);
    assert.match(detail, /embedded = false/);
    assert.match(detail, /agent-session-page-embedded/);
    assert.match(styles, /\.agents-desktop-shell\s*\{[\s\S]*grid-template-columns:/);
    assert.match(styles, /\.agent-session-page-embedded\s*\{[\s\S]*height: 100%/);
  });

  it('keeps the rail rows operable by keyboard and free of nested controls', async () => {
    const agents = await readFile('public/pages/agents.mjs', 'utf8');
    const styles = await readFile('public/styles/main.css', 'utf8');

    // The row body is a real button, so Enter/Space/focus are native.
    assert.match(agents, /class="agent-rail-row-main"/);
    assert.match(agents, /aria-current=\$\{active \? 'true' : undefined\}/);
    // The bulk checkbox must live outside the button, after it closes.
    const railRow = agents.slice(agents.indexOf('function AgentRailRow'), agents.indexOf('function handleRailArrowKeys'));
    assert.ok(railRow.indexOf('</button>') < railRow.indexOf('type="checkbox"'), 'checkbox must not nest inside the row button');
    assert.match(railRow, /aria-label=\$\{`Bulk select \$\{title\}`\}/);
    assert.match(agents, /function handleRailArrowKeys[\s\S]*ArrowDown[\s\S]*ArrowUp[\s\S]*Home[\s\S]*End/);
    assert.match(agents, /class="agents-desktop-rail-list" onKeyDown=\$\{handleRailArrowKeys\}/);
    assert.match(styles, /\.agent-rail-row-main:focus-visible\s*\{[\s\S]*outline:/);
  });

  it('reports the rail count that matches the rendered rows', async () => {
    const agents = await readFile('public/pages/agents.mjs', 'utf8');
    const head = agents.slice(agents.indexOf('agents-desktop-rail-head'), agents.indexOf('agents-desktop-rail-list'));
    assert.match(head, /\$\{visibleSessions\.length\}/);
    assert.doesNotMatch(head, /desktopSessions\.length/);
  });

  it('keeps the embedded panel from clobbering the host page state', async () => {
    const detail = await readFile('public/pages/agent-session-detail.mjs', 'utf8');

    // The sibling fetch overwrites the shared session signals with a
    // read-only-excluded list, so the embedded panel must skip it.
    assert.match(detail, /if \(!embedded\) loadSiblingSessions\(\);/);
    assert.match(detail, /autoFocusKeyboard: !isRustManagedReadOnly && !embedded/);
    assert.match(detail, /removeSessionForKind\(descriptor\.kind, id\)/);
    assert.match(detail, /if \(!embedded\) window\.history\.back\(\)/);
  });

  it('sizes the desktop shell from the viewport instead of a fixed chrome offset', async () => {
    const styles = await readFile('public/styles/main.css', 'utf8');

    assert.doesNotMatch(styles, /\.agents-desktop-shell\s*\{[^}]*height: calc\(100dvh - 370px\)/);
    assert.match(styles, /#app:has\(\.agents-desktop-shell\)\s*\{[\s\S]*height: calc\(100dvh/);
    assert.match(styles, /\.main:has\(\.agents-desktop-shell\)\s*\{[\s\S]*overflow: auto/);
    assert.match(styles, /\.agents-desktop-shell\s*\{[\s\S]*flex: 1 1 auto/);
    // Long titles must not widen the single-column mobile card grid.
    assert.match(styles, /\.agents-card-grid > \*\s*\{\s*min-width: 0/);
  });

  it('compresses desktop controls into one toolbar and hides bulk prompt by default', async () => {
    const agents = await readFile('public/pages/agents.mjs', 'utf8');
    const styles = await readFile('public/styles/main.css', 'utf8');

    assert.match(agents, /class="agents-desktop-toolbar"/);
    assert.match(agents, /<details class="agents-filter-menu">/);
    assert.match(agents, /showBulkPrompt\.value \? html`/);
    assert.match(agents, /!desktopLayout\.value \? html`<div class="card" style="margin-bottom:12px">/);
    assert.match(styles, /\.agents-desktop-toolbar\s*\{[\s\S]*display: flex;[\s\S]*white-space: nowrap/);
    assert.match(styles, /\.agents-bulk-prompt-bar\s*\{/);
  });
});
