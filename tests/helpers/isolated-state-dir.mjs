import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Preloaded by scripts/run-tests.mjs: each test file gets a fresh runtime state dir
// outside the checkout, so tests never read or grow the checkout's .dueno/state.
// Sets the legacy name and clears CADRE_STATE_DIR (which readEnv prefers) so an inherited
// value can't redirect tests, while a test that sets either name itself still wins.
if (process.env.NODE_TEST_CONTEXT) {
  const dir = mkdtempSync(join(tmpdir(), 'cadre-test-state-'));
  delete process.env.CADRE_STATE_DIR;
  process.env.DM_STATE_DIR = dir;
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
}
