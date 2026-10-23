import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'node:test';

const script = resolve('scripts/deploy-check.sh');

it('passes only on health 200 with a non-empty, error-free journal for the server.sh unit', () => {
  const root = mkdtempSync(join(tmpdir(), 'cadre-deploy-check-test-'));
  const bin = join(root, 'bin');
  const args = join(root, 'journalctl.args');
  const fake = (name, body) => writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  const run = (health, journal) => spawnSync('bash', [script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CADRE_RESTART_CMD: 'echo Restarted (live /srv/live: abc1234)',
      FAKE_HEALTH: health,
      FAKE_JOURNAL: journal,
      JOURNAL_ARGS: args,
    },
    encoding: 'utf8',
  });
  try {
    mkdirSync(bin);
    fake('curl', 'printf %s "$FAKE_HEALTH"');
    fake('journalctl', 'echo "$*" >"$JOURNAL_ARGS"; printf %s "$FAKE_JOURNAL"');
    fake('sleep', ':');
    const clean = '{"level":30,"msg":"listening"}\n{"level":40,"msg":"slow"}\n';

    const ok = run('200', clean);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal(ok.stdout, 'deploy-check: live abc1234 health 200 errors 0 (2 journal lines from dueno-fleet)\n');
    assert.match(readFileSync(args, 'utf8'), /^--user -u dueno-fleet --since \d{4}-\d\d-\d\d \d\d:\d\d:\d\d /);

    const down = run('503', clean);
    assert.equal(down.status, 1);
    assert.match(down.stdout, /health 503 errors 0/);

    const errors = run('200', `${clean}{"level":50,"msg":"boom"}\n{"level":60,"msg":"fatal"}\n`);
    assert.equal(errors.status, 1);
    assert.match(errors.stdout, /errors 2/);
    assert.match(errors.stderr, /"msg":"boom"/);

    const empty = run('200', '');
    assert.equal(empty.status, 1);
    assert.match(empty.stderr, /returned no lines .*the check is broken/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
