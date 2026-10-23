import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'node:test';

const script = resolve('scripts/land-pr.sh');

it('refuses dirty worktrees, non-SUCCESS or mismatched heads, keeps everything when merge fails, then lands and cleans up', () => {
  const root = mkdtempSync(join(tmpdir(), 'cadre-land-pr-test-'));
  const dev = join(root, 'dev');
  const worktree = join(root, 'worktree');
  const bin = join(root, 'bin');
  const log = join(root, 'gh.log');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    GH_LOG: log,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost',
  };
  const git = (...args) => execFileSync('git', args, { cwd: dev, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const run = (sha, checks, { prHead = head, mergeFails = '' } = {}) => spawnSync('bash', [script, '7', sha, '.'], {
    cwd: worktree,
    env: { ...env, GH_MERGE_FAILS: mergeFails, GH_PR_JSON: JSON.stringify({ headRefOid: prHead, headRefName: 'feat', statusCheckRollup: checks, mergeCommit: { oid: 'f'.repeat(40) } }) },
    encoding: 'utf8',
  });
  let head;
  try {
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "pr view") jq -r "\${@: -1}" <<<"$GH_PR_JSON" ;;
  "pr merge") echo "$*" >>"$GH_LOG"; [[ -z $GH_MERGE_FAILS ]] || exit 1; git push -q origin "\${@: -1}:main" ;;
esac
`, { mode: 0o755 });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(root, 'origin.git')], { env });
    execFileSync('git', ['clone', '-q', join(root, 'origin.git'), dev], { env, stdio: 'ignore' });
    writeFileSync(join(dev, '.gitignore'), 'node_modules/\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'base');
    git('push', '-q', 'origin', 'HEAD:main', 'HEAD:stale');
    git('checkout', '-q', '-b', 'stale');
    git('commit', '-q', '--allow-empty', '-m', 'stale');
    git('push', '-q', 'origin', 'stale');
    git('checkout', '-q', '-b', 'feat', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'feat');
    head = git('rev-parse', 'HEAD');
    git('push', '-q', 'origin', 'feat');
    git('checkout', '-q', 'main');
    git('worktree', 'add', '-q', worktree, 'feat');
    mkdirSync(join(dev, 'node_modules'));
    symlinkSync(join(dev, 'node_modules'), join(worktree, 'node_modules'));

    const green = [{ conclusion: 'SUCCESS' }, { state: 'SUCCESS' }];
    writeFileSync(join(worktree, 'scratch'), 'uncommitted');
    for (const [sha, checks, options] of [
      [head, green],
      ['0'.repeat(40), green],
      [head, green, { prHead: '0'.repeat(40) }],
      [head, [{ conclusion: 'FAILURE' }, { state: 'SUCCESS' }]],
      [head, [{ conclusion: 'SUCCESS' }, { state: 'PENDING' }]],
      [head, [{ conclusion: 'SKIPPED' }, { state: 'SUCCESS' }]],
      [head, []],
    ]) {
      const refused = run(sha, checks, options);
      assert.equal(refused.status, 1, refused.stdout + refused.stderr);
      assert.match(refused.stderr, /Refusing to land PR 7/);
      assert.equal(existsSync(log), false);
      assert.equal(existsSync(join(worktree, 'node_modules')), true);
      rmSync(join(worktree, 'scratch'), { force: true });
    }

    const mergeFailed = run(head, green, { mergeFails: '1' });
    assert.equal(mergeFailed.status, 1, mergeFailed.stdout + mergeFailed.stderr);
    assert.equal(existsSync(join(worktree, 'node_modules')), true);
    assert.equal(git('rev-parse', '--verify', 'refs/heads/feat'), head);
    assert.equal(git('ls-remote', '--heads', 'origin', 'feat').endsWith('refs/heads/feat'), true);
    rmSync(log);

    const landed = run(head, green);
    assert.equal(landed.status, 0, landed.stdout + landed.stderr);
    assert.equal(readFileSync(log, 'utf8'), `pr merge 7 --merge --match-head-commit ${head}\n`);
    assert.equal(existsSync(worktree), false);
    assert.equal(existsSync(join(dev, 'node_modules')), true);
    assert.equal(git('branch', '--list', 'feat'), '');
    assert.equal(git('rev-parse', 'origin/main'), head);
    assert.equal(git('ls-remote', '--heads', 'origin', 'feat'), '');
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(landed.stdout.trim(), 'f'.repeat(40));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
