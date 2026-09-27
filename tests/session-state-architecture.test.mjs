import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const ROOT = resolve('.');

async function sourceFiles(directory) {
  const entries = await readdir(resolve(ROOT, directory), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => relative(ROOT, resolve(entry.parentPath, entry.name)).replaceAll('\\', '/'));
}

async function matches(pattern, roots = ['modules', 'public']) {
  const files = (await Promise.all(roots.map(sourceFiles))).flat();
  const found = [];
  for (const file of files) {
    const content = await readFile(resolve(ROOT, file), 'utf8');
    if (pattern.test(content)) found.push(file);
  }
  return found;
}

function unexpected(found, allowed) {
  return found.filter((file) => !allowed.has(file));
}

describe('canonical session-state architecture', () => {
  it('keeps pane capture in observation adapters and explicit manual terminal APIs', async () => {
    const found = await matches(/capture-pane/);
    assert.deepEqual(unexpected(found, new Set([
      'modules/sessions/index.mjs',
      'modules/platform/tmux.mjs',
    ])), []);
  });

  it('keeps automated tmux input behind the command gate', async () => {
    const found = await matches(/send-keys|paste-buffer|sendTmux(?:Text|Enter)/);
    assert.deepEqual(unexpected(found, new Set([
      'modules/sessions/index.mjs',
      'modules/session-state/command-gate.mjs',
      'modules/platform/tmux-input.mjs',
      'modules/platform/tmux.mjs',
    ])), []);
  });

  it('keeps legacy detectors as compatibility wrappers only', async () => {
    const found = await matches(/from ['"][^'"]*state-detector\.mjs['"]/);
    assert.deepEqual(unexpected(found, new Set([
      'modules/sessions/codex-state-detector.mjs',
      'modules/sessions/claude-state-detector.mjs',
    ])), []);
  });

  it('keeps legacy readiness predicates out of consumers and all client code', async () => {
    const rawStateComparisons = await matches(/\.state\s*={2,3}\s*['"]waiting_for_input['"]/);
    assert.deepEqual(unexpected(rawStateComparisons, new Set([
      'modules/session-state/providers/detector.mjs',
      'modules/session-state/providers/hook.mjs',
    ])), []);

    const clientLegacyFields = await matches(/\b(?:needsInput|inputType|safe_to_message|state_source)\b/, ['public']);
    assert.deepEqual(clientLegacyFields, []);
  });
});
