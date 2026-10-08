import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'node:test';

const script = resolve('scripts/verify-heads.sh');

it('verifies merged heads with shared dependencies and a lock, propagates failure, and cleans up', () => {
  const root = mkdtempSync(join(tmpdir(), 'cadre-verify-test-'));
  const repo = join(root, 'repo');
  const env = {
    ...process.env,
    HOME: root,
    TMPDIR: root,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost',
    VERIFY_REPORT: join(root, 'report'),
  };
  delete env.NODE_TEST_CONTEXT;
  const git = (...args) => execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const run = (...heads) => spawnSync('bash', [script, ...heads], { cwd: repo, env, encoding: 'utf8' });
  const assertClean = () => {
    assert.equal(git('worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
    assert.equal(readdirSync(root).some((name) => name.startsWith('cadre-verify-heads.')), false);
  };
  try {
    mkdirSync(repo);
    mkdirSync(join(repo, 'node_modules'));
    git('init', '-b', 'main');
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { check: 'node check.cjs', test: 'node --test test.cjs' } }));
    writeFileSync(join(repo, 'check.cjs'), `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const { spawnSync } = require('node:child_process');
      assert.equal(fs.realpathSync('node_modules'), ${JSON.stringify(join(repo, 'node_modules'))});
      assert.notEqual(spawnSync('flock', ['-n', process.env.HOME + '/.cadre/heavy-test.lock', 'true']).status, 0);
      fs.writeFileSync(process.env.VERIFY_REPORT, process.cwd());
    `);
    writeFileSync(join(repo, 'test.cjs'), `
      const { test } = require('node:test');
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      test('both heads merged', () => {
        assert.equal(fs.readFileSync('one', 'utf8'), 'one');
        assert.equal(fs.readFileSync('two', 'utf8'), 'two');
      });
    `);
    git('add', '.');
    git('commit', '-m', 'base');
    git('remote', 'add', 'origin', repo);
    git('checkout', '-b', 'one');
    writeFileSync(join(repo, 'one'), 'one');
    git('add', 'one'); git('commit', '-m', 'one');
    const one = git('rev-parse', 'HEAD');
    git('checkout', '-b', 'two', 'main');
    writeFileSync(join(repo, 'two'), 'two');
    git('add', 'two'); git('commit', '-m', 'two');
    const two = git('rev-parse', 'HEAD');
    const passed = run(one, two);
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /# pass 1\n# fail 0\n.*# skipped 0/s);
    assert.match(readFileSync(env.VERIFY_REPORT, 'utf8'), /cadre-verify-heads\.[^/]+\/worktree$/);
    assertClean();
    const failed = run(one);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stdout, /# fail 1/);
    assertClean();
    git('checkout', 'one');
    const relativeHead = run('HEAD');
    assert.equal(relativeHead.status, 1, relativeHead.stdout + relativeHead.stderr);
    assert.match(relativeHead.stdout, /# fail 1/);
    assertClean();
    assert.notEqual(run('nonexistent-head').status, 0);
    assertClean();
    assert.equal(run().status, 2);
    assertClean();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
