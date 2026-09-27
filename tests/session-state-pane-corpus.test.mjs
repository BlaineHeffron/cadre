import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { observeClaudePane } from '../modules/session-state/providers/claude.mjs';
import { observeCodexPane } from '../modules/session-state/providers/codex.mjs';
import { detectProviderState } from '../modules/session-state/providers/patterns.mjs';
import { normalizeProviderPane } from '../modules/session-state/providers/pane-view.mjs';
import { observePiPane } from '../modules/session-state/providers/pi.mjs';

const paneDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'session-state', 'panes');
const observers = {
  claude: observeClaudePane,
  codex: observeCodexPane,
  pi: observePiPane,
};
const SECRET_RE = /sk-[a-zA-Z0-9]{10,}|ghp_|gho_|github_pat_|AKIA[0-9A-Z]{16}|Bearer [A-Za-z0-9._-]{12,}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY/i;
const REQUIRED_STATES = [
  'idle-after-reply',
  'thinking',
  'mid-tool',
  'working',
  'permission-prompt',
  'selection-menu',
  'exited',
];
const RECONSTRUCTED_ONLY_STATES = ['permission-prompt', 'exited'];

async function loadManifest() {
  return JSON.parse(await readFile(join(paneDir, 'manifest.json'), 'utf8'));
}

async function loadPane(file) {
  return readFile(join(paneDir, file));
}

function classify(provider, content) {
  const observer = observers[provider];
  assert.equal(typeof observer, 'function', `unknown provider ${provider}`);
  const legacy = detectProviderState(provider, content);
  const observations = observer(content, { observedAt: 100, expiresAt: 0 });
  return {
    currentLegacyState: legacy.state,
    currentExecution: observations.find((item) => item.kind === 'execution')?.value?.execution || null,
    currentInteraction: observations.find((item) => item.kind === 'interaction')?.value?.kind || null,
  };
}

function isKnownDefect(fixture) {
  return fixture.currentLegacyState !== fixture.intendedLegacyState
    || fixture.currentExecution !== fixture.intendedExecution
    || fixture.currentInteraction !== fixture.intendedInteraction;
}

describe('captured pane corpus', () => {
  it('covers required UI states, with reconstructed-only gaps labelled', async () => {
    const manifest = await loadManifest();
    assert.deepEqual(manifest.reconstructedOnlyStates, RECONSTRUCTED_ONLY_STATES);
    assert.ok(manifest.fixtures.length >= 15, 'corpus is too small to lock detector behavior');

    for (const provider of ['claude', 'codex', 'pi']) {
      assert.ok(
        manifest.fixtures.some((fixture) => fixture.provider === provider && fixture.source === 'live-tmux'),
        `missing live-tmux fixture for ${provider}`,
      );
    }

    for (const state of REQUIRED_STATES) {
      const live = manifest.fixtures.some((fixture) => (
        fixture.intendedState === state && fixture.source !== 'reconstructed'
      ));
      if (RECONSTRUCTED_ONLY_STATES.includes(state)) {
        assert.equal(live, false, `${state} gained a live fixture; shrink reconstructedOnlyStates`);
        assert.ok(
          manifest.fixtures.some((fixture) => fixture.intendedState === state && fixture.source === 'reconstructed'),
          `reconstructed-only state ${state} is missing even a reconstructed fixture`,
        );
        continue;
      }
      assert.ok(live, `${state} has no live/live-derived fixture`);
    }
  });

  it('keeps same-session idle+active pairs for Claude and Pi', async () => {
    const manifest = await loadManifest();
    for (const provider of ['claude', 'pi']) {
      const paired = manifest.fixtures.filter((fixture) => (
        fixture.provider === provider && fixture.pairId && fixture.source === 'live-tmux'
      ));
      const byPair = Map.groupBy(paired, (fixture) => fixture.pairId);
      assert.ok(byPair.size >= 1, `missing same-session pair for ${provider}`);
      for (const [pairId, rows] of byPair) {
        const roles = new Set(rows.map((row) => row.pairRole));
        assert.ok(roles.has('idle') && roles.has('active'), `${pairId} is not an idle+active pair`);
      }
    }
  });

  it('requires ANSI on live fixtures and forbids it on reconstructed ones', async () => {
    const manifest = await loadManifest();
    for (const fixture of manifest.fixtures) {
      const buf = await loadPane(fixture.file);
      const text = buf.toString('utf8');
      assert.ok(text.trim(), `${fixture.id} is empty`);
      assert.equal(SECRET_RE.test(text), false, `${fixture.id} looks like it contains a secret`);
      if (fixture.source === 'reconstructed') {
        assert.equal(buf.includes(0x1b), false, `${fixture.id} reconstructed fixture must not contain ESC`);
        assert.equal(fixture.knownDefect, false, `${fixture.id} reconstructed fixture must not drive a defect row`);
        continue;
      }
      assert.ok(buf.includes(0x1b), `${fixture.id} live fixture is missing ESC bytes`);
      assert.match(text, /\x1b\[/, `${fixture.id} live fixture is missing CSI sequences`);
    }
  });

  it('does not let a quoted Claude chrome block hijack a Pi pane', async () => {
    const content = (await loadPane('pi-derived-quoted-claude-chrome-block.pane')).toString('utf8');
    const view = normalizeProviderPane('pi', content);
    assert.deepEqual(view.footerLines, []);
    assert.equal(detectProviderState('pi', content).state, 'working');
  });

  it('does not treat a quoted active footer above the composer as chrome', async () => {
    const content = (await loadPane('claude-derived-quoted-active-footer.pane')).toString('utf8');
    const view = normalizeProviderPane('claude', content);
    assert.ok(
      view.contentLines.some((line) => /\besc to interrupt\b/i.test(line)),
      'quoted interrupt line must remain content',
    );
    assert.equal(
      view.footerLines.some((line) => /\besc to interrupt\b/i.test(line)),
      false,
      'quoted interrupt line must not enter footerLines',
    );
    assert.equal(detectProviderState('claude', content).state, 'waiting_for_input');
  });

  it('keeps promptVisible when a Claude update banner trails the composer', async () => {
    const content = (await loadPane('claude-e3b3717a-idle-update-banner.pane')).toString('utf8');
    const view = normalizeProviderPane('claude', content);
    assert.equal(view.promptVisible, true);
    assert.ok(view.footerLines.some((line) => /^✔\s+Update installed\b/i.test(line)));
    assert.equal(detectProviderState('claude', content).state, 'waiting_for_input');
  });

  it('keeps busy status lines inside the last three non-chrome active lines', async () => {
    const cases = [
      ['claude-working-tool-osmosing.pane', 'claude', /Osmosing/],
      ['claude-thinking-moseying.pane', 'claude', /Moseying/],
      ['pi-working.pane', 'pi', /Working\.\.\./],
      ['pi-5427de06-active.pane', 'pi', /Working\.\.\./],
    ];
    for (const [file, provider, pattern] of cases) {
      const view = normalizeProviderPane(provider, (await loadPane(file)).toString('utf8'));
      const nonChrome = view.activeLines.filter((line) => line && line !== view.prompt);
      const fromEnd = nonChrome.findLastIndex((line) => pattern.test(line)) - nonChrome.length;
      assert.ok(fromEnd >= -3, `${file} busy marker is at ${fromEnd}, expected >= -3`);
    }
  });

  it('exposes esc-to-interrupt on live Claude busy footer lines', async () => {
    const content = (await loadPane('claude-working-tool-osmosing.pane')).toString('utf8');
    const view = normalizeProviderPane('claude', content);
    assert.ok(view.footerLines.length > 0, 'footerLines must be populated');
    assert.ok(
      view.footerLines.some((line) => /\besc to interrupt\b/i.test(line)),
      'Osmosing footer must expose esc to interrupt',
    );
    assert.equal(
      view.activeLines.some((line) => /\besc to interrupt\b/i.test(line)),
      false,
      'activeLines must still exclude the footer',
    );
  });

  it('keeps knownDefect flags aligned with intended vs current classification', async () => {
    const manifest = await loadManifest();
    for (const fixture of manifest.fixtures) {
      assert.equal(fixture.knownDefect, isKnownDefect(fixture), fixture.id);
    }
    const liveDefects = manifest.fixtures.filter((fixture) => (
      fixture.knownDefect === true && fixture.source !== 'reconstructed'
    ));
    assert.deepEqual(liveDefects.map((fixture) => fixture.id), [], 'detector corpus defects should now be empty');
  });
});

describe('pane corpus characterization', () => {
  it('locks current detector output for every fixture', async () => {
    const manifest = await loadManifest();
    for (const fixture of manifest.fixtures) {
      const content = (await loadPane(fixture.file)).toString('utf8');
      assert.deepEqual(classify(fixture.provider, content), {
        currentLegacyState: fixture.currentLegacyState,
        currentExecution: fixture.currentExecution,
        currentInteraction: fixture.currentInteraction,
      }, fixture.id);
    }
  });
});
