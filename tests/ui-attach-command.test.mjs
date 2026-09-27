import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function functionBody(source, name) {
  const marker = new RegExp(`async\\s+function\\s+${name}\\s*\\([^)]*\\)`);
  const match = marker.exec(source);
  const start = match?.index ?? -1;
  assert.notEqual(start, -1, `missing function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart, index + 1);
    }
  }
  throw new Error(`unclosed function ${name}`);
}

function assertSessionInfoFieldFlow(source, expected = {}) {
  const loadContent = functionBody(source, 'loadContent');
  const assignmentMatch = loadContent.match(/sessionInfo\.value\s*=\s*\{([\s\S]*?)\n\s*\};/);
  assert.ok(assignmentMatch, 'missing sessionInfo.value assignment in loadContent');
  const assignment = assignmentMatch[1];
  for (const [field, pattern] of Object.entries(expected)) {
    assert.match(assignment, pattern, `sessionInfo.${field} must be populated from API data`);
  }
}

describe('UI attach commands', () => {
  it('uses server-provided attachCommand in session detail pages', async () => {
    const [claude, codex] = await Promise.all([
      readFile('public/pages/claude-session-detail.mjs', 'utf8'),
      readFile('public/pages/codex-session-detail.mjs', 'utf8'),
    ]);

    assert.match(claude, /sessionInfo\.value\.attachCommand/);
    assert.match(codex, /sessionInfo\.value\.attachCommand/);
    assert.doesNotMatch(claude, /fallbackAttachCommand/);
    assert.doesNotMatch(codex, /fallbackAttachCommand/);
    assert.doesNotMatch(claude, /tmux attach -t/);
    assert.doesNotMatch(codex, /tmux attach -t/);
    assert.doesNotMatch(functionBody(claude, 'copyAttachCommand'), /readOnly === true|externalOwner === 'rust-monitor'/);
    assert.doesNotMatch(functionBody(codex, 'copyAttachCommand'), /readOnly === true|externalOwner === 'rust-monitor'/);
    assert.match(claude, /Copy Attach/);
    assert.match(codex, /Copy Attach/);
    assert.match(claude, /Open In Terminator[\s\S]*?!isRustManagedReadOnly|!isRustManagedReadOnly[\s\S]*?Open In Terminator/);
    assert.match(codex, /Open In Terminator[\s\S]*?!isRustManagedReadOnly|!isRustManagedReadOnly[\s\S]*?Open In Terminator/);
  });

  it('uses pane/session attachCommand in the tmux page', async () => {
    const tmux = await readFile('public/pages/tmux.mjs', 'utf8');

    assert.match(tmux, /session\?\.attachCommand/);
    assert.match(tmux, /sessions\[name\]\[0\]\?\.attachCommand/);
    assert.match(tmux, /session\.attachCommand \? html/);
    assert.doesNotMatch(tmux, /fallbackAttachCommand/);
    assert.doesNotMatch(tmux, /tmux attach -t/);
  });

  it('preserves attach and read-only fields from detail API responses', async () => {
    const [claude, codex] = await Promise.all([
      readFile('public/pages/claude-session-detail.mjs', 'utf8'),
      readFile('public/pages/codex-session-detail.mjs', 'utf8'),
    ]);

    const expected = {
      attachCommand: /attachCommand:\s*data\.attachCommand\s*\|\|\s*''/,
      readOnly: /readOnly:\s*data\.readOnly\s*===\s*true/,
      externalOwner: /externalOwner:\s*data\.externalOwner\s*\|\|\s*null/,
      sessionEnded: /sessionEnded:\s*data\.sessionEnded\s*===\s*true/,
    };

    assertSessionInfoFieldFlow(claude, expected);
    assertSessionInfoFieldFlow(codex, expected);
  });
});
