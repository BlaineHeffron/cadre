import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

describe('Integration', () => {
  let app;
  const TOKEN = 'integration-test-token';

  before(async () => {
    process.env.AUTH_TOKEN = TOKEN;
    process.env.PORT = '0'; // random port
    process.env.LOG_LEVEL = 'error';

    // We can't easily import server.mjs since it auto-starts
    // Instead, test individual module imports
  });

  after(() => {
    delete process.env.AUTH_TOKEN;
    delete process.env.PORT;
    delete process.env.LOG_LEVEL;
  });

  it('all modules import without error', async () => {
    const modules = [
      '../config.mjs',
      '../lib/exec.mjs',
      '../lib/tail.mjs',
      '../modules/platform/auth.mjs',
    ];

    for (const mod of modules) {
      const m = await import(mod);
      assert.ok(m, `Module ${mod} imported successfully`);
    }
  });

  it('exec runs basic commands', async () => {
    const { exec } = await import('../lib/exec.mjs');
    const result = await exec('echo', ['hello']);
    assert.equal(result.stdout.trim(), 'hello');
    assert.equal(result.code, 0);
  });

  it('exec ignores inherited tmux sockets', async () => {
    const { commandEnvironment } = await import('../lib/exec.mjs');
    const env = commandEnvironment('tmux', { TMUX: '/tmp/stale,0,0', TMUX_PANE: '%1' });
    assert.equal(env.TMUX, undefined);
    assert.equal(env.TMUX_PANE, undefined);
  });

  it('exec handles timeouts', async () => {
    const { exec } = await import('../lib/exec.mjs');
    await assert.rejects(
      () => exec('sleep', ['10'], { timeout: 100 }),
      /timed out/i
    );
  });

  it('config has expected shape', async () => {
    const { config } = await import('../config.mjs');
    assert.ok(config.host);
    assert.ok(config.port !== undefined);
    assert.ok(config.auth);
    assert.ok(config.tls);
  });
});
