import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('Tmux module', () => {
  it('should be importable without errors', async () => {
    // Just verify the module loads and exports the plugin
    const mod = await import('../modules/platform/tmux.mjs');
    assert.equal(typeof mod.tmuxPlugin, 'function');
  });

  it('names the server that owns the session rather than the inherited $TMUX socket', async (t) => {
    const hasTmux = await execFileAsync('tmux', ['-V']).then(() => true, () => false);
    if (!hasTmux) return t.skip('tmux is not installed');

    const { buildAttachCommand, resolveTmuxSocketPath } = await import('../modules/platform/tmux.mjs');
    const dir = await mkdtemp(join(tmpdir(), 'dueno-tmux-socket-'));
    const env = { ...process.env, TMUX_TMPDIR: dir };
    delete env.TMUX;
    delete env.TMUX_PANE;
    const tmux = (...args) => execFileAsync('tmux', args, { env });
    const saved = { TMUX: process.env.TMUX, TMUX_TMPDIR: process.env.TMUX_TMPDIR };
    try {
      // Fleet's server: the default socket under TMUX_TMPDIR, which lib/exec.mjs
      // reaches by stripping $TMUX. A second "dm-agent" server exists alongside
      // it but only holds a keepalive, mirroring the production layout.
      await tmux('new-session', '-d', '-s', 'claude-attach-probe', 'sleep 60');
      await tmux('-L', 'dm-agent', 'new-session', '-d', '-s', 'fleet-keepalive', 'sleep 60');
      const owning = (await tmux('display-message', '-p', '-t', 'claude-attach-probe', '#{socket_path}')).stdout.trim();
      const keepaliveOnly = (await tmux('-L', 'dm-agent', 'display-message', '-p', '#{socket_path}')).stdout.trim();
      assert.notEqual(owning, keepaliveOnly);
      process.env.TMUX_TMPDIR = dir;

      process.env.TMUX = `${keepaliveOnly},1,0`;
      assert.equal(await resolveTmuxSocketPath(), owning);
      assert.equal(
        buildAttachCommand('claude-attach-probe', { socketPath: await resolveTmuxSocketPath() }),
        `tmux -S ${owning} attach -t 'claude-attach-probe'`,
      );

      // A session genuinely living on the inherited server keeps its command.
      process.env.TMUX = `${owning},1,0`;
      assert.equal(
        buildAttachCommand('claude-attach-probe', { socketPath: await resolveTmuxSocketPath() }),
        `tmux -S ${owning} attach -t 'claude-attach-probe'`,
      );

      await tmux('kill-server');
      assert.equal(await resolveTmuxSocketPath(), '');
      assert.equal(
        buildAttachCommand('claude-attach-probe', { socketPath: await resolveTmuxSocketPath() }),
        "tmux attach -t 'claude-attach-probe'",
      );
    } finally {
      if (saved.TMUX === undefined) delete process.env.TMUX; else process.env.TMUX = saved.TMUX;
      if (saved.TMUX_TMPDIR === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = saved.TMUX_TMPDIR;
      await tmux('kill-server').catch(() => {});
      await tmux('-L', 'dm-agent', 'kill-server').catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('builds bare attach commands when no tmux socket is active', async () => {
    const { buildAttachCommand } = await import('../modules/platform/tmux.mjs');
    assert.equal(
      buildAttachCommand('claude-abc', { socketPath: '' }),
      "tmux attach -t 'claude-abc'"
    );
  });

  it('quotes session names safely', async () => {
    const { buildAttachCommand } = await import('../modules/platform/tmux.mjs');
    assert.equal(
      buildAttachCommand("weird'name", { socketPath: '' }),
      "tmux attach -t 'weird'\\''name'"
    );
  });
});
