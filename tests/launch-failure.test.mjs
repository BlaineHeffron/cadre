import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectLaunchFailure, launchFailurePatterns } from '../modules/agent/launch-failure.mjs';

describe('launch failure detection', () => {
  it('flags harness startup errors that leave the pane alive', () => {
    const log = 'Error: Failed to load extension "/repo/modules/integrations/pi-mcp-extension.mjs": '
      + "Cannot find module '@modelcontextprotocol/sdk/client'";
    assert.equal(detectLaunchFailure(log, 'pi'), log);
    assert.equal(detectLaunchFailure('bash: line 1: pi: command not found', 'pi').length > 0, true);
    assert.equal(
      detectLaunchFailure('Error: Session ID abc is already in use', 'claude').length > 0,
      true,
    );
    const nonoLog = 'nono: Profile read error at /missing.json: profile file not found';
    assert.equal(detectLaunchFailure(`banner\n${nonoLog}\n`, 'codex'), `banner\n${nonoLog}`);
    assert.equal(detectLaunchFailure('the nono: prefix mid-line is agent output', 'claude'), '');
  });

  it('ignores benign startup output', () => {
    assert.equal(detectLaunchFailure('', 'pi'), '');
    assert.equal(detectLaunchFailure('   \n  ', 'pi'), '');
    assert.equal(
      detectLaunchFailure("Warning: No project session found with id 'abc'; creating a new session", 'pi'),
      '',
    );
    assert.equal(detectLaunchFailure('Warning: tmux extended-keys is off.', 'pi'), '');
  });

  it('keeps shared patterns for unknown runtimes', () => {
    assert.equal(detectLaunchFailure('Cannot find module x', 'nope').length > 0, true);
    assert.equal(launchFailurePatterns('').length, launchFailurePatterns('codex').length);
  });
});
