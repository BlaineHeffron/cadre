import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectState as detectClaudeState } from '../modules/sessions/claude-state-detector.mjs';
import { detectState as detectCodexState } from '../modules/sessions/codex-state-detector.mjs';
import { readHookSessionMetadata, reconcileHookFirstState } from '../modules/agent/hook-state.mjs';

describe('Session state detectors', () => {
  it('does not keep showing stale Claude yes/no prompts once newer output has replaced them', () => {
    const content = [
      'Claude: Ready to apply changes.',
      'Are you sure you want to continue?',
      '(yes/no)',
      'Running rg -n "foo" .',
      'Updated 3 files.',
      'Summary written to README.md',
      '> ',
    ].join('\n');

    const state = detectClaudeState(content);
    assert.equal(state.state, 'waiting_for_input');
    assert.equal(state.inputType, 'text');
  });

  it('detects Claude waiting-for-input when the prompt is followed by footer lines', () => {
    const content = [
      'Review complete.',
      '────────────────────────────────────────────────────────────────────────────────',
      '❯ ',
      '────────────────────────────────────────────────────────────────────────────────',
      '⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n');

    const state = detectClaudeState(content);
    assert.equal(state.state, 'waiting_for_input');
    assert.equal(state.inputType, 'text');
  });

  it('lets a bottom prompt override stale completed-thinking markers', () => {
    for (const completedMarker of ['✻ Cogitated for 10m 13s', '✻ Cooked for 2m 43s']) {
      const content = [
        'Work complete.',
        completedMarker,
        '────────',
        '❯ ',
        '────────',
        '⏵⏵ bypass permissions on (shift+tab to cycle)',
      ].join('\n');

      for (const detectState of [detectClaudeState, detectCodexState]) {
        const state = detectState(content);
        assert.equal(state.state, 'waiting_for_input');
        assert.equal(state.inputType, 'text');
      }
    }
  });

  it('does not treat menu phrases in prose above an empty composer as parked', () => {
    for (const prose of [
      'Codex is committing next with the hook enabled, then opening the PR.',
      'The PreCompact hook runs before compaction.',
      'The PostCompact hook runs after compaction.',
      'The menu documentation says press q to quit.',
    ]) {
      const content = [
        prose,
        '────────────────────────────────────────────────────────────────────────────────',
        '❯ ',
        '────────────────────────────────────────────────────────────────────────────────',
        '⏵⏵ bypass permissions on (shift+tab to cycle)',
      ].join('\n');

      for (const detect of [detectClaudeState, detectCodexState]) {
        assert.deepEqual(detect(content), {
          state: 'waiting_for_input', needsInput: true, inputType: 'text', detail: 'Waiting for input',
        }, prose);
      }
    }
  });

  it('still detects a live Claude yes/no prompt at the end of the transcript', () => {
    const content = [
      'Claude: I am ready to remove those files.',
      'Are you sure?',
      '(yes/no)',
    ].join('\n');

    const state = detectClaudeState(content);
    assert.equal(state.state, 'needs_confirmation');
    assert.equal(state.inputType, 'yes-no');
  });

  it('detects Claude approval prompts as not free-text safe', () => {
    const state = detectClaudeState([
      'Claude wants to run Bash',
      'Do you want to allow this command?',
      'Allow once',
    ].join('\n'));

    assert.equal(state.state, 'needs_approval');
    assert.equal(state.inputType, 'approval');
  });

  it('detects Claude approval menus with yes/no/always options', () => {
    const state = detectClaudeState([
      'Claude wants to edit files.',
      'Do you want to proceed?',
      '(Y)es  (N)o  (A)lways',
    ].join('\n'));

    assert.equal(state.state, 'needs_approval');
    assert.equal(state.inputType, 'approval');
  });

  it('does not treat ordinary Claude prose as thinking or working', () => {
    assert.equal(detectClaudeState('Planning\nAnalyzing').state, 'unknown');
    assert.equal(detectClaudeState('Summary: Reading the config showed the flag was off.\n> ').state, 'waiting_for_input');
  });

  it('keeps Claude status-region work anchors', () => {
    assert.equal(detectClaudeState('• Working (14s • esc to interrupt)\n> ').state, 'working');
  });

  it('does not keep showing stale Codex yes/no prompts once newer output has replaced them', () => {
    const content = [
      'Codex suggests deleting generated artifacts.',
      'Do you want to continue?',
      '(y/n)',
      'Repository scan finished.',
      'Patch applied successfully.',
      'Work complete.',
      '> ',
    ].join('\n');

    const state = detectCodexState(content);
    assert.equal(state.state, 'waiting_for_input');
    assert.equal(state.inputType, 'text');
  });

  it('detects Codex waiting-for-input when the prompt is followed by footer lines', () => {
    const content = [
      'Work complete.',
      '────────────────────────────────────────────────────────────────────────────────',
      '› ',
      'Run /review on my current changes',
      'gpt-5.4 medium · 72% left · ~/projects/dueno-monitor',
    ].join('\n');

    const state = detectCodexState(content);
    assert.equal(state.state, 'waiting_for_input');
    assert.equal(state.inputType, 'text');
  });

  it('detects Codex waiting-for-input when the prompt includes inline placeholder text', () => {
    const content = [
      'Implemented the requested change.',
      'Verification passed.',
      '› Run /review on my current changes',
      'gpt-5.4 medium · 52% left · ~/projects/dueno-monitor',
    ].join('\n');

    const state = detectCodexState(content);
    assert.equal(state.state, 'waiting_for_input');
    assert.equal(state.inputType, 'text');
  });

  it('detects Codex empty composer placeholders as waiting-for-input', () => {
    const content = [
      'Work complete.',
      '────────────────────────────────────────────────────────────────────────────────',
      'Summarize recent commits',
      'gpt-5.4 medium · 72% left · ~/projects/dueno-monitor',
    ].join('\n');

    const state = detectCodexState(content);
    assert.equal(state.state, 'waiting_for_input');
    assert.equal(state.inputType, 'text');
  });

  it('keeps Codex working when a prompt is visible below the live work footer cluster', () => {
    const state = detectCodexState([
      'Reviewing repository state.',
      'tab to queue message',
      '• Working (14s • esc to interrupt)',
      '99% context left',
      '› ',
    ].join('\n'));

    assert.equal(state.state, 'working');
    assert.equal(state.needsInput, false);
  });

  it('still detects a live Codex yes/no prompt at the end of the transcript', () => {
    const content = [
      'Codex is about to overwrite the file.',
      'Overwrite?',
      '[Y/n]',
    ].join('\n');

    const state = detectCodexState(content);
    assert.equal(state.state, 'needs_confirmation');
    assert.equal(state.inputType, 'yes-no');
  });

  it('detects Codex approval prompts as not free-text safe', () => {
    const state = detectCodexState([
      'Codex wants to run a command',
      'Do you want to proceed?',
      'Press Enter to allow',
    ].join('\n'));

    assert.equal(state.state, 'needs_approval');
    assert.equal(state.inputType, 'approval');
  });

  for (const [provider, detect] of [
    ['Claude', detectClaudeState],
    ['Codex', detectCodexState],
  ]) {
    it(`detects ${provider} parked menu screens as needing attention`, () => {
      const state = detect([
        'Hooks',
        'PreCompact   enabled   command',
        'PostCompact  enabled   command',
        'Press esc to go back',
      ].join('\n'));

      assert.equal(state.state, 'parked');
      assert.equal(state.needsInput, true);
      assert.equal(state.inputType, 'escape');
    });

    it(`reports ambiguous ${provider} scrape screens as attention-needed unknown state`, () => {
      const state = detect([
        'Workspace Snapshot',
        'Model         gpt-5',
        'Notifications on',
      ].join('\n'));

      assert.equal(state.state, 'unknown');
      assert.equal(state.needsInput, true);
      assert.equal(state.inputType, 'attention');
    });
  }

  it('uses fresh hook-derived prompt-ready state ahead of scrape state', async (t) => {
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-hook-first-'));
    t.after(() => rm(workDir, { recursive: true, force: true }));
    await mkdir(join(workDir, '.git'));
    const stateDir = join(workDir, '.agent_bus', 'hooks', 'state');
    await mkdir(stateDir, { recursive: true });
    const now = Date.now();
    await writeFile(join(stateDir, 'codex-session-1.json'), JSON.stringify({
      hook: {
        lifecycle: 'running',
        activity: 'prompt_ready',
        last_hook_event_at: now,
        last_event_name: 'Stop',
        source: 'hook',
      },
    }));

    const state = await reconcileHookFirstState({
      session: { id: 'session-1', workDir },
      provider: 'codex',
      scrapeState: { state: 'working', needsInput: false, inputType: null, detail: 'Working' },
      now,
    });

    assert.equal(state.state, 'waiting_for_input');
    assert.equal(state.state_source, 'hook');
    assert.equal(state.safe_to_message, true);
  });

  it('falls back to scrape state when hook-derived state is stale', async (t) => {
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-hook-stale-'));
    t.after(() => rm(workDir, { recursive: true, force: true }));
    await mkdir(join(workDir, '.git'));
    const stateDir = join(workDir, '.agent_bus', 'hooks', 'state');
    await mkdir(stateDir, { recursive: true });
    const now = Date.now();
    await writeFile(join(stateDir, 'claude-session-1.json'), JSON.stringify({
      hook: {
        lifecycle: 'running',
        activity: 'prompt_ready',
        last_hook_event_at: now - 120000,
        last_event_name: 'Stop',
        source: 'hook',
      },
    }));

    const state = await reconcileHookFirstState({
      session: { id: 'session-1', workDir },
      provider: 'claude',
      scrapeState: { state: 'working', needsInput: false, inputType: null, detail: 'Working' },
      now,
    });

    assert.equal(state.state, 'working');
    assert.equal(state.state_source, 'scrape');
    assert.equal(state.safe_to_message, false);
  });

  it('ignores hook state older than a resumed launch while keeping CLI metadata readable', async (t) => {
    const workDir = await mkdtemp(join(tmpdir(), 'dueno-hook-resume-min-'));
    t.after(() => rm(workDir, { recursive: true, force: true }));
    await mkdir(join(workDir, '.git'));
    const stateDir = join(workDir, '.agent_bus', 'hooks', 'state');
    await mkdir(stateDir, { recursive: true });
    const endedAt = Date.now();
    const resumedAt = endedAt + 5000;
    await writeFile(join(stateDir, 'claude-session-1.json'), JSON.stringify({
      session: {
        cliSessionId: 'claude-cli-uuid',
        duenoSessionId: 'session-1',
        cwd: workDir,
        updatedAt: new Date(endedAt).toISOString(),
      },
      hook: {
        lifecycle: 'ended',
        activity: 'unknown',
        last_hook_event_at: endedAt,
        last_event_name: 'SessionEnd',
        source: 'hook',
      },
    }));

    const state = await reconcileHookFirstState({
      session: { id: 'session-1', workDir },
      provider: 'claude',
      scrapeState: { state: 'working', needsInput: false, inputType: null, detail: 'Working' },
      now: resumedAt + 1000,
      minHookEventAt: resumedAt,
    });
    const metadata = await readHookSessionMetadata({ workDir, provider: 'claude', sessionId: 'session-1' });

    assert.equal(state.state, 'working');
    assert.equal(state.state_source, 'scrape');
    assert.equal(metadata.cliSessionId, 'claude-cli-uuid');
  });
});
