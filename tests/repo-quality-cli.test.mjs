import { spawnSync } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(root, 'tests', 'fixtures', 'repo-quality');
const cli = join(root, 'scripts', 'repo-quality-check.mjs');

async function makeFixtureRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'repo-quality-cli-'));
  await mkdir(join(repo, 'inputs'), { recursive: true });
  await cp(join(fixtures, 'join-eslint.json'), join(repo, 'inputs', 'eslint.json'));
  await cp(join(fixtures, 'mutation.json'), join(repo, 'inputs', 'mutation.json'));
  await cp(join(fixtures, 'outcomes.json'), join(repo, 'inputs', 'outcomes.json'));
  const eslintPath = join(repo, 'inputs', 'eslint.json');
  const eslintJson = (await readFile(eslintPath, 'utf8'))
    .replaceAll('/repo', repo)
    .replace('complexity of 12', 'complexity of 13');
  await writeFile(eslintPath, eslintJson);
  const coverageJson = (await readFile(join(fixtures, 'join-coverage-final.json'), 'utf8'))
    .replaceAll('/repo', repo);
  await writeFile(join(repo, 'inputs', 'coverage.json'), coverageJson);
  await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
    repo: 'fixture-repo',
    outputDir: '.quality-output',
    coverage: { format: 'istanbul-json', output: 'inputs/coverage.json', command: 'unused' },
    complexity: { format: 'eslint-json', output: 'inputs/eslint.json', command: 'unused' },
    thresholds: { crapFail: 30 },
  }, null, 2)}\n`);
  spawnSync('git', ['init', '--quiet'], { cwd: repo });
  spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '.'], { cwd: repo });
  spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], { cwd: repo });
  return repo;
}

describe('repo quality CLI', () => {
  it('records escaped defects as appended JSONL entries', async () => {
    const repo = await makeFixtureRepo();
    const ledgerPath = join(repo, '.quality-output', 'escaped-defects.jsonl');

    const first = spawnSync(process.execPath, [
      cli, 'record-escape', '--repo', repo,
      '--pr', '191', '--sha', '  abc123  ', '--summary', '  checkout rejected valid carts  ',
    ], { encoding: 'utf8' });
    const second = spawnSync(process.execPath, [
      cli, 'record-escape', '--repo', repo,
      '--pr', '192', '--sha', 'def456', '--summary', 'invoice total omitted tax',
    ], { encoding: 'utf8' });

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const records = (await readFile(ledgerPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(records.map(({ recordedAt: _recordedAt, ...record }) => record), [
      { pr: 191, sha: 'abc123', summary: 'checkout rejected valid carts' },
      { pr: 192, sha: 'def456', summary: 'invoice total omitted tax' },
    ]);
    assert.ok(records.every(({ recordedAt }) => (
      typeof recordedAt === 'string' && new Date(recordedAt).toISOString() === recordedAt
    )));
  });

  it('rejects invalid escaped-defect fields without writing the ledger', async () => {
    const invalidArguments = [
      ['--sha', 'abc123', '--summary', 'missing PR'],
      ['--pr', '0', '--sha', 'abc123', '--summary', 'zero PR'],
      ['--pr', '1.5', '--sha', 'abc123', '--summary', 'fractional PR'],
      ['--pr', '191', '--summary', 'missing SHA'],
      ['--pr', '191', '--sha', '   ', '--summary', 'blank SHA'],
      ['--pr', '191', '--sha', 'abc123'],
      ['--pr', '191', '--sha', 'abc123', '--summary', '   '],
    ];

    for (const args of invalidArguments) {
      const repo = await makeFixtureRepo();
      const result = spawnSync(process.execPath, [
        cli, 'record-escape', '--repo', repo, ...args,
      ], { encoding: 'utf8' });

      assert.equal(result.status, 2, `${args.join(' ')}\n${result.stderr}`);
      await assert.rejects(access(join(repo, '.quality-output', 'escaped-defects.jsonl')), {
        code: 'ENOENT',
      });
    }

    const repo = await makeFixtureRepo();
    const normalGate = spawnSync(process.execPath, [
      cli, '--repo', repo, '--pr', '191',
    ], { encoding: 'utf8' });
    assert.equal(normalGate.status, 2, normalGate.stderr);
    assert.match(normalGate.stderr, /unknown option: --pr/);
  });

  it('reports zero escaped defects when the ledger is missing', async () => {
    const repo = await makeFixtureRepo();
    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--no-run', '--json',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).totals.escapedDefects, {
      count: 0,
      last30Days: 0,
    });
  });

  it('reports all escaped defects and those recorded in the last 30 days', async () => {
    const repo = await makeFixtureRepo();
    const outputDir = join(repo, '.quality-output');
    await mkdir(outputDir, { recursive: true });
    const recentAt = new Date(Date.now() - (10 * 24 * 60 * 60 * 1000)).toISOString();
    const oldAt = new Date(Date.now() - (40 * 24 * 60 * 60 * 1000)).toISOString();
    await writeFile(join(outputDir, 'escaped-defects.jsonl'), [
      JSON.stringify({ pr: 191, sha: 'abc123', summary: 'recent defect', recordedAt: recentAt }),
      '',
      JSON.stringify({ pr: 150, sha: 'def456', summary: 'old defect', recordedAt: oldAt }),
      '',
    ].join('\n'));

    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--no-run', '--json',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).totals.escapedDefects, {
      count: 2,
      last30Days: 1,
    });
  });

  it('fails closed when an escaped-defect recordedAt is invalid', async () => {
    const repo = await makeFixtureRepo();
    const outputDir = join(repo, '.quality-output');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'escaped-defects.jsonl'), `${JSON.stringify({
      pr: 191, sha: 'abc123', summary: 'bad timestamp', recordedAt: 'not-a-date',
    })}\n`);

    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--no-run', '--json',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /escaped-defects\.jsonl/);
    assert.match(result.stderr, /invalid recordedAt/);
  });

  it('includes escaped-defect totals on mutation-only reports', async () => {
    const repo = await makeFixtureRepo();
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.quality-output',
      mutation: {
        format: 'stryker-json',
        sourceGlobs: ['src/**/*.mjs'],
        command: 'exit 91',
        output: '{outputDir}/mutation.json',
      },
    }, null, 2)}\n`);
    const outputDir = join(repo, '.quality-output');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'escaped-defects.jsonl'), `${JSON.stringify({
      pr: 191,
      sha: 'abc123',
      summary: 'escaped on mutation path',
      recordedAt: new Date().toISOString(),
    })}\n`);

    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--mutation-only', '--json',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).totals.escapedDefects, {
      count: 1,
      last30Days: 1,
    });
  });

  it('fails closed with the ledger path when an escaped-defect line is malformed', async () => {
    const repo = await makeFixtureRepo();
    const outputDir = join(repo, '.quality-output');
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, 'escaped-defects.jsonl'), 'not json\n');

    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--no-run', '--json',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /escaped-defects\.jsonl/);
  });

  it('joins llvm-cov and rust-code-analysis outputs without rerunning tools', async () => {
    const repo = await makeFixtureRepo();
    const coverageJson = (await readFile(join(fixtures, 'join-llvm-cov.json'), 'utf8'))
      .replaceAll('/repo', repo);
    await writeFile(join(repo, 'inputs', 'llvm-cov.json'), coverageJson);
    await mkdir(join(repo, '.quality-output', 'rust-metrics', 'src'), { recursive: true });
    await cp(
      join(fixtures, 'join-rust-code-analysis.json'),
      join(repo, '.quality-output', 'rust-metrics', 'src', 'nested.rs.json'),
    );
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.quality-output',
      coverage: { format: 'llvm-cov-json', output: 'inputs/llvm-cov.json', command: 'unused' },
      complexity: { format: 'rust-code-analysis-json', output: '{outputDir}/rust-metrics', command: 'unused' },
      thresholds: { crapFail: 30 },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--no-run', '--json',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.totals.functions, 3);
    assert.equal(report.totals.eslintOnly, 1);
    assert.equal(report.totals.unmatchedComplexity, 1);
    assert.equal(report.functions[0].name, 'parent');
    assert.equal(report.functions[0].crap, 30);
    assert.equal(report.functions[1].name, 'closure');
    assert.equal(report.functions[1].crap, 20);
    assert.equal(report.functions[2].crap, null);
  });

  it('reuses tool outputs, writes the normalized report, and exits 1 for a threshold failure', async () => {
    const repo = await makeFixtureRepo();
    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--no-run', '--json', '--top', '1',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.repo, 'fixture-repo');
    assert.equal(report.totals.functions, 3);
    assert.equal(report.totals.crapAboveFail, 1);
    assert.equal(report.functions[0].crap, 34.125);
    assert.deepEqual(
      JSON.parse(await readFile(join(repo, '.quality-output', 'quality-report.json'), 'utf8')),
      report,
    );
  });

  it('selects a named config section while an omitted section keeps the root config', async () => {
    const repo = await makeFixtureRepo();
    const configPath = join(repo, '.quality-gates.json');
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.sections = {
      rust: {
        repo: 'fixture-repo-rust',
        outputDir: '.quality-output-rust',
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const frontend = spawnSync(process.execPath, [
      cli, '--repo', repo, '--no-run', '--json',
    ], { encoding: 'utf8' });
    const defaultAlias = spawnSync(process.execPath, [
      cli, '--repo', repo, '--no-run', '--json', '--section', ' Default ',
    ], { encoding: 'utf8' });
    const rust = spawnSync(process.execPath, [
      cli, '--repo', repo, '--no-run', '--json', '--section', 'rust',
    ], { encoding: 'utf8' });
    const missing = spawnSync(process.execPath, [
      cli, '--repo', repo, '--no-run', '--json', '--section', 'missing',
    ], { encoding: 'utf8' });

    assert.equal(frontend.status, 1, frontend.stderr);
    assert.equal(defaultAlias.status, 1, defaultAlias.stderr);
    assert.equal(rust.status, 1, rust.stderr);
    assert.equal(missing.status, 2, missing.stderr);
    assert.match(missing.stderr, /config section not found: missing/);
    assert.equal(JSON.parse(frontend.stdout).repo, 'fixture-repo');
    assert.equal(JSON.parse(defaultAlias.stdout).repo, 'fixture-repo');
    assert.equal(JSON.parse(rust.stdout).repo, 'fixture-repo-rust');
    assert.deepEqual(
      JSON.parse(await readFile(join(repo, '.quality-output-rust', 'quality-report.json'), 'utf8')),
      JSON.parse(rust.stdout),
    );
  });

  it('includes normalized dry data from jscpd JSON in the quality report', async () => {
    const repo = await makeFixtureRepo();
    const jscpdJson = (await readFile(join(fixtures, 'jscpd-report.json'), 'utf8'))
      .replaceAll('/repo', repo);
    await writeFile(join(repo, 'inputs', 'jscpd-report.json'), jscpdJson);
    const config = JSON.parse(await readFile(join(repo, '.quality-gates.json'), 'utf8'));
    config.dry = {
      format: 'jscpd-json',
      output: 'inputs/jscpd-report.json',
      command: 'unused',
    };
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--no-run', '--json',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.dry, {
      duplicatedLinesPct: 12.5,
      clones: [
        {
          fileA: 'src/cart.mjs',
          startA: 10,
          endA: 20,
          fileB: 'src/checkout.mjs',
          startB: 40,
          endB: 50,
          lines: 11,
        },
      ],
    });
    assert.deepEqual(
      JSON.parse(await readFile(join(repo, '.quality-output', 'quality-report.json'), 'utf8')).dry,
      report.dry,
    );
  });

  it('updates a compact ratchet baseline and exits 0', async () => {
    const repo = await makeFixtureRepo();
    const baselinePath = join(repo, 'config', 'quality', 'crap-baseline.json');
    const result = spawnSync(process.execPath, [
      cli,
      '--repo', repo,
      '--no-run',
      '--json',
      '--baseline', 'config/quality/crap-baseline.json',
      '--update-baseline',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(JSON.parse(await readFile(baselinePath, 'utf8')), {
      repo: report.repo,
      sha: report.sha,
      generatedAt: report.generatedAt,
      crapFail: 30,
      crapAboveFail: 1,
      crapSumAboveFail: 34.13,
    });
  });

  it('writes duplicatedLinesPct into the baseline when dry is configured', async () => {
    const repo = await makeFixtureRepo();
    const jscpdJson = (await readFile(join(fixtures, 'jscpd-report.json'), 'utf8'))
      .replaceAll('/repo', repo);
    await writeFile(join(repo, 'inputs', 'jscpd-report.json'), jscpdJson);
    const config = JSON.parse(await readFile(join(repo, '.quality-gates.json'), 'utf8'));
    config.dry = {
      format: 'jscpd-json',
      output: 'inputs/jscpd-report.json',
      command: 'unused',
    };
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify(config, null, 2)}\n`);
    const baselinePath = join(repo, 'config', 'quality', 'crap-baseline.json');
    const result = spawnSync(process.execPath, [
      cli,
      '--repo', repo,
      '--no-run',
      '--json',
      '--baseline', 'config/quality/crap-baseline.json',
      '--update-baseline',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
    assert.equal(baseline.duplicatedLinesPct, 12.5);
    assert.equal(baseline.crapAboveFail, 1);
  });

  it('passes existing debt and exits 1 when either ratchet metric regresses', async () => {
    const repo = await makeFixtureRepo();
    const baselinePath = join(repo, 'baseline.json');
    await writeFile(baselinePath, `${JSON.stringify({
      repo: 'fixture-repo',
      sha: 'old',
      generatedAt: '2026-08-19T00:00:00.000Z',
      crapFail: 30,
      crapAboveFail: 1,
      crapSumAboveFail: 34.13,
    })}\n`);
    const args = [cli, '--repo', repo, '--no-run', '--json', '--baseline', 'baseline.json'];

    const allowed = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(allowed.status, 0, allowed.stderr);

    await writeFile(baselinePath, `${JSON.stringify({
      repo: 'fixture-repo',
      sha: 'old',
      generatedAt: '2026-08-19T00:00:00.000Z',
      crapFail: 30,
      crapAboveFail: 1,
      crapSumAboveFail: 30,
    })}\n`);
    const regression = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(regression.status, 1, regression.stderr);
    assert.equal(JSON.parse(regression.stdout).totals.crapAboveFail, 1);
    assert.match(regression.stderr, /crapSumAboveFail: 34\.13 > baseline 30/);
  });

  it('runs the configured dry adapter before reading jscpd JSON', async () => {
    const repo = await makeFixtureRepo();
    const jscpdJson = (await readFile(join(fixtures, 'jscpd-report.json'), 'utf8'))
      .replaceAll('/repo', repo);
    await writeFile(join(repo, 'inputs', 'jscpd-report.json'), jscpdJson);
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.quality-run',
      coverage: {
        format: 'istanbul-json',
        command: 'mkdir -p {outputDir}/cov && cp inputs/coverage.json {outputDir}/cov/coverage-final.json',
        output: '{outputDir}/cov/coverage-final.json',
      },
      complexity: {
        format: 'eslint-json',
        command: 'cp inputs/eslint.json {outputDir}/eslint.json && exit 1',
        output: '{outputDir}/eslint.json',
      },
      dry: {
        format: 'jscpd-json',
        command: 'cp inputs/jscpd-report.json {outputDir}/jscpd/jscpd-report.json && exit 1',
        output: '{outputDir}/jscpd/jscpd-report.json',
      },
      thresholds: { crapFail: 30 },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [cli, '--repo', repo, '--json'], { encoding: 'utf8' });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).dry.duplicatedLinesPct, 12.5);
    await access(join(repo, '.quality-run', 'jscpd', 'jscpd-report.json'));
  });

  it('fails the dry adapter when jscpd exits non-zero without JSON', async () => {
    const repo = await makeFixtureRepo();
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.quality-run',
      coverage: {
        format: 'istanbul-json',
        command: 'mkdir -p {outputDir}/cov && cp inputs/coverage.json {outputDir}/cov/coverage-final.json',
        output: '{outputDir}/cov/coverage-final.json',
      },
      complexity: {
        format: 'eslint-json',
        command: 'cp inputs/eslint.json {outputDir}/eslint.json && exit 1',
        output: '{outputDir}/eslint.json',
      },
      dry: {
        format: 'jscpd-json',
        command: 'exit 1',
        output: '{outputDir}/jscpd/jscpd-report.json',
      },
      thresholds: { crapFail: 30 },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [cli, '--repo', repo, '--json'], { encoding: 'utf8' });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /dry command failed/);
  });

  it('fails closed when jscpd JSON omits duplicated line percentage', async () => {
    const repo = await makeFixtureRepo();
    await writeFile(join(repo, 'inputs', 'jscpd-report.json'), `${JSON.stringify({
      statistics: { total: { lines: 80, duplicatedLines: 10 } },
      duplicates: [],
    })}\n`);
    const config = JSON.parse(await readFile(join(repo, '.quality-gates.json'), 'utf8'));
    config.dry = {
      format: 'jscpd-json',
      output: 'inputs/jscpd-report.json',
      command: 'unused',
    };
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify(config, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--no-run', '--json',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /duplicatedLinesPct/);
  });

  it('fails closed when jscpd percentage is negative or above 100', async () => {
    const repo = await makeFixtureRepo();
    const config = JSON.parse(await readFile(join(repo, '.quality-gates.json'), 'utf8'));
    config.dry = {
      format: 'jscpd-json',
      output: 'inputs/jscpd-report.json',
      command: 'unused',
    };
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify(config, null, 2)}\n`);
    const args = [cli, '--repo', repo, '--no-run', '--json'];

    await writeFile(join(repo, 'inputs', 'jscpd-report.json'), `${JSON.stringify({
      statistics: { total: { percentage: -1 } },
      duplicates: [],
    })}\n`);
    const negative = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(negative.status, 2, negative.stderr);
    assert.match(negative.stderr, /duplicatedLinesPct/);

    await writeFile(join(repo, 'inputs', 'jscpd-report.json'), `${JSON.stringify({
      statistics: { total: { percentage: 100.1 } },
      duplicates: [],
    })}\n`);
    const over = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(over.status, 2, over.stderr);
    assert.match(over.stderr, /duplicatedLinesPct/);
  });

  it('exits 1 when duplicatedLinesPct rises above baseline + 0.1', async () => {
    const repo = await makeFixtureRepo();
    const jscpdJson = (await readFile(join(fixtures, 'jscpd-report.json'), 'utf8'))
      .replaceAll('/repo', repo);
    await writeFile(join(repo, 'inputs', 'jscpd-report.json'), jscpdJson);
    const config = JSON.parse(await readFile(join(repo, '.quality-gates.json'), 'utf8'));
    config.dry = {
      format: 'jscpd-json',
      output: 'inputs/jscpd-report.json',
      command: 'unused',
    };
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify(config, null, 2)}\n`);
    const baselinePath = join(repo, 'baseline.json');
    const args = [cli, '--repo', repo, '--no-run', '--json', '--baseline', 'baseline.json'];
    await writeFile(baselinePath, `${JSON.stringify({
      repo: 'fixture-repo',
      sha: 'old',
      generatedAt: '2026-08-19T00:00:00.000Z',
      crapFail: 30,
      crapAboveFail: 1,
      crapSumAboveFail: 34.13,
      duplicatedLinesPct: 12.5,
    })}\n`);

    const allowed = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(JSON.parse(allowed.stdout).dry.duplicatedLinesPct, 12.5);

    await writeFile(baselinePath, `${JSON.stringify({
      repo: 'fixture-repo',
      sha: 'old',
      generatedAt: '2026-08-19T00:00:00.000Z',
      crapFail: 30,
      crapAboveFail: 1,
      crapSumAboveFail: 34.13,
      duplicatedLinesPct: 12.3,
    })}\n`);
    const regression = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(regression.status, 1, regression.stderr);
    assert.equal(JSON.parse(regression.stdout).dry.duplicatedLinesPct, 12.5);
    assert.match(regression.stderr, /duplicatedLinesPct: 12\.5 > baseline 12\.3/);
  });

  it('prints a Markdown table limited by --top', async () => {
    const repo = await makeFixtureRepo();
    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--no-run', '--top', '1',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /\| CRAP \| CC \| Coverage \| Statements \| Function \|/);
    assert.match(result.stdout, /\| 34\.13 \| 13 \| 50\.0% \| 1\/2 \| `src\/nested\.mjs:10` parent \|/);
    assert.doesNotMatch(result.stdout, /Arrow function/);
  });

  it('refuses rust-code-analysis outputDir that is not a dedicated child of the repository', async () => {
    const repo = await makeFixtureRepo();
    const coverageJson = (await readFile(join(fixtures, 'join-llvm-cov.json'), 'utf8'))
      .replaceAll('/repo', repo);
    await writeFile(join(repo, 'inputs', 'llvm-cov.json'), coverageJson);
    await writeFile(join(repo, 'SENTINEL'), 'keep me');
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.',
      coverage: {
        format: 'llvm-cov-json',
        command: 'cp inputs/llvm-cov.json {outputDir}/llvm-cov.json',
        output: '{outputDir}/llvm-cov.json',
      },
      complexity: {
        format: 'rust-code-analysis-json',
        command: 'true',
        output: '{outputDir}/rust-metrics',
      },
      thresholds: { crapFail: 30 },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [cli, '--repo', repo, '--json'], { encoding: 'utf8' });

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /outputDir must be a dedicated child of the repository/);
    assert.equal(await readFile(join(repo, 'SENTINEL'), 'utf8'), 'keep me');
  });

  it('refuses rust-code-analysis output that is not a dedicated child of outputDir', async () => {
    const repo = await makeFixtureRepo();
    const coverageJson = (await readFile(join(fixtures, 'join-llvm-cov.json'), 'utf8'))
      .replaceAll('/repo', repo);
    await writeFile(join(repo, 'inputs', 'llvm-cov.json'), coverageJson);
    await writeFile(join(repo, 'SENTINEL'), 'keep me');
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.quality-run',
      coverage: {
        format: 'llvm-cov-json',
        command: 'cp inputs/llvm-cov.json {outputDir}/llvm-cov.json',
        output: '{outputDir}/llvm-cov.json',
      },
      complexity: {
        format: 'rust-code-analysis-json',
        command: 'true',
        output: '.',
      },
      thresholds: { crapFail: 30 },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [cli, '--repo', repo, '--json'], { encoding: 'utf8' });

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /dedicated child of outputDir/);
    assert.equal(await readFile(join(repo, 'SENTINEL'), 'utf8'), 'keep me');
  });

  it('refuses rust-code-analysis output that overlaps coverage output', async () => {
    const repo = await makeFixtureRepo();
    const coverageJson = (await readFile(join(fixtures, 'join-llvm-cov.json'), 'utf8'))
      .replaceAll('/repo', repo);
    await mkdir(join(repo, '.quality-run', 'rust-metrics'), { recursive: true });
    await writeFile(join(repo, '.quality-run', 'rust-metrics', 'llvm-cov.json'), coverageJson);
    await writeFile(join(repo, 'SENTINEL'), 'keep me');
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.quality-run',
      coverage: {
        format: 'llvm-cov-json',
        command: 'true',
        output: '{outputDir}/rust-metrics/llvm-cov.json',
      },
      complexity: {
        format: 'rust-code-analysis-json',
        command: 'true',
        output: '{outputDir}/rust-metrics',
      },
      thresholds: { crapFail: 30 },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [cli, '--repo', repo, '--json'], { encoding: 'utf8' });

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /must not overlap the coverage output path/);
    assert.equal(await readFile(join(repo, '.quality-run', 'rust-metrics', 'llvm-cov.json'), 'utf8'), coverageJson);
    assert.equal(await readFile(join(repo, 'SENTINEL'), 'utf8'), 'keep me');
  });

  it('fails closed when llvm-cov JSON is not the export document type', async () => {
    const repo = await makeFixtureRepo();
    await writeFile(join(repo, 'inputs', 'llvm-cov.json'), `${JSON.stringify({ data: [] })}\n`);
    await mkdir(join(repo, '.quality-output', 'rust-metrics', 'src'), { recursive: true });
    await cp(
      join(fixtures, 'join-rust-code-analysis.json'),
      join(repo, '.quality-output', 'rust-metrics', 'src', 'nested.rs.json'),
    );
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.quality-output',
      coverage: { format: 'llvm-cov-json', output: 'inputs/llvm-cov.json', command: 'unused' },
      complexity: { format: 'rust-code-analysis-json', output: '{outputDir}/rust-metrics', command: 'unused' },
      thresholds: { crapFail: 30 },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--no-run', '--json',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /llvm.coverage.json.export/);
  });

  it('ignores symlink entries when scanning rust-code-analysis output', async () => {
    const repo = await makeFixtureRepo();
    const coverageJson = (await readFile(join(fixtures, 'join-llvm-cov.json'), 'utf8'))
      .replaceAll('/repo', repo);
    await writeFile(join(repo, 'inputs', 'llvm-cov.json'), coverageJson);
    await mkdir(join(repo, '.quality-output', 'rust-metrics', 'src'), { recursive: true });
    await cp(
      join(fixtures, 'join-rust-code-analysis.json'),
      join(repo, '.quality-output', 'rust-metrics', 'src', 'nested.rs.json'),
    );
    const { symlink } = await import('node:fs/promises');
    await symlink(repo, join(repo, '.quality-output', 'rust-metrics', 'escape'), 'dir');
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.quality-output',
      coverage: { format: 'llvm-cov-json', output: 'inputs/llvm-cov.json', command: 'unused' },
      complexity: { format: 'rust-code-analysis-json', output: '{outputDir}/rust-metrics', command: 'unused' },
      thresholds: { crapFail: 30 },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--no-run', '--json',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).totals.functions, 3);
  });

  it('fails closed when rust-code-analysis output directory has no json files', async () => {
    const repo = await makeFixtureRepo();
    const coverageJson = (await readFile(join(fixtures, 'join-llvm-cov.json'), 'utf8'))
      .replaceAll('/repo', repo);
    await writeFile(join(repo, 'inputs', 'llvm-cov.json'), coverageJson);
    await mkdir(join(repo, '.quality-output', 'rust-metrics'), { recursive: true });
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.quality-output',
      coverage: { format: 'llvm-cov-json', output: 'inputs/llvm-cov.json', command: 'unused' },
      complexity: { format: 'rust-code-analysis-json', output: '{outputDir}/rust-metrics', command: 'unused' },
      thresholds: { crapFail: 30 },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--no-run', '--json',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /no json/i);
  });

  it('recreates a rust-code-analysis output directory before running the adapter', async () => {
    const repo = await makeFixtureRepo();
    const coverageJson = (await readFile(join(fixtures, 'join-llvm-cov.json'), 'utf8'))
      .replaceAll('/repo', repo);
    await writeFile(join(repo, 'inputs', 'llvm-cov.json'), coverageJson);
    await mkdir(join(repo, 'inputs', 'src'), { recursive: true });
    await cp(
      join(fixtures, 'join-rust-code-analysis.json'),
      join(repo, 'inputs', 'src', 'nested.rs.json'),
    );
    await mkdir(join(repo, '.quality-run', 'rust-metrics', 'stale-dir'), { recursive: true });
    await writeFile(join(repo, '.quality-run', 'rust-metrics', 'stale.json'), '{}');
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.quality-run',
      coverage: {
        format: 'llvm-cov-json',
        command: 'cp inputs/llvm-cov.json {outputDir}/llvm-cov.json',
        output: '{outputDir}/llvm-cov.json',
      },
      complexity: {
        format: 'rust-code-analysis-json',
        command: 'mkdir -p {outputDir}/rust-metrics/src && cp inputs/src/nested.rs.json {outputDir}/rust-metrics/src/nested.rs.json',
        output: '{outputDir}/rust-metrics',
      },
      thresholds: { crapFail: 30 },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [cli, '--repo', repo, '--json'], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).functions[0].name, 'parent');
    await access(join(repo, '.quality-run', 'rust-metrics', 'src', 'nested.rs.json'));
    await assert.rejects(access(join(repo, '.quality-run', 'rust-metrics', 'stale.json')));
  });

  it('runs configured adapters and accepts ESLint exit 1 when JSON was produced', async () => {
    const repo = await makeFixtureRepo();
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.quality-run',
      coverage: {
        format: 'istanbul-json',
        command: 'mkdir -p {outputDir}/cov && cp inputs/coverage.json {outputDir}/cov/coverage-final.json',
        output: '{outputDir}/cov/coverage-final.json',
      },
      complexity: {
        format: 'eslint-json',
        command: 'cp inputs/eslint.json {outputDir}/eslint.json && exit 1',
        output: '{outputDir}/eslint.json',
      },
      thresholds: { crapFail: 30 },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [cli, '--repo', repo, '--json'], { encoding: 'utf8' });

    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).totals.crapAboveFail, 1);
    await access(join(repo, '.quality-run', 'cov', 'coverage-final.json'));
    await access(join(repo, '.quality-run', 'eslint.json'));
  });

  it('rejects an ESLint exit 1 when only stale JSON exists', async () => {
    const repo = await makeFixtureRepo();
    await mkdir(join(repo, '.quality-stale'), { recursive: true });
    await cp(join(repo, 'inputs', 'eslint.json'), join(repo, '.quality-stale', 'eslint.json'));
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      outputDir: '.quality-stale',
      coverage: {
        format: 'istanbul-json',
        command: 'cp inputs/coverage.json {outputDir}/coverage.json',
        output: '{outputDir}/coverage.json',
      },
      complexity: {
        format: 'eslint-json',
        command: 'exit 1',
        output: '{outputDir}/eslint.json',
      },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [cli, '--repo', repo, '--json'], { encoding: 'utf8' });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /complexity command failed with exit 1/);
  });

  it('rejects a malformed ratchet baseline instead of passing',
    async () => {
      const repo = await makeFixtureRepo();
      await writeFile(join(repo, 'baseline.json'), `${JSON.stringify({
        repo: 'fixture-repo',
        crapFail: 30,
      })}\n`);
      const result = spawnSync(process.execPath, [
        cli, '--repo', repo, '--no-run', '--json', '--baseline', 'baseline.json',
      ], { encoding: 'utf8' });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /crapAboveFail/);
    });

  it('runs mutation only for changed source files and passes them through both command seams', async () => {
    const repo = await makeFixtureRepo();
    const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'cart.mjs'), 'export const cart = true;\n');
    spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', 'src/cart.mjs'], { cwd: repo });
    spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'change source'], { cwd: repo });
    await writeFile(join(repo, 'src', 'unused.mjs'), 'export const unused = true;\n');
    await writeFile(join(repo, 'notes.md'), 'not source\n');
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.quality-mutation',
      mutation: {
        format: 'stryker-json',
        sourceGlobs: ['src/**/*.mjs'],
        command: "mkdir -p {outputDir} && printf '%s\\n' {changedFiles} > {outputDir}/placeholder.txt && printf '%s' \"$QUALITY_CHANGED_FILES\" > {outputDir}/environment.txt && cp inputs/mutation.json {outputDir}/mutation.json",
        output: '{outputDir}/mutation.json',
      },
      thresholds: { mutationScoreMinChanged: 0.5, survivorsMaxChanged: null },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--mutation-only', '--changed-since', base, '--json',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.mutation.changedFiles, ['src/cart.mjs', 'src/unused.mjs']);
    assert.equal(await readFile(join(repo, '.quality-mutation', 'placeholder.txt'), 'utf8'), 'src/cart.mjs\nsrc/unused.mjs\n');
    assert.equal(await readFile(join(repo, '.quality-mutation', 'environment.txt'), 'utf8'), "'src/cart.mjs' 'src/unused.mjs'");
    assert.equal(report.mutation.totals.mutants, 5);
  });

  it('passes a comma-separated mutate list without printf splicing', async () => {
    const repo = await makeFixtureRepo();
    const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'cart.mjs'), 'export const cart = true;\n');
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.quality-mutation',
      mutation: {
        format: 'stryker-json',
        sourceGlobs: ['src/**/*.mjs'],
        command: 'mkdir -p {outputDir} && printf %s {mutatePatterns} > {outputDir}/mutate.txt && cp inputs/mutation.json {outputDir}/mutation.json',
        output: '{outputDir}/mutation.json',
      },
      thresholds: { mutationScoreMinChanged: 0.5 },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--mutation-only', '--changed-since', base, '--json',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(repo, '.quality-mutation', 'mutate.txt'), 'utf8'), 'src/cart.mjs');
  });

  it('prints changed-file mutation totals and surviving mutants as Markdown', async () => {
    const repo = await makeFixtureRepo();
    const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'cart.mjs'), 'export const cart = true;\n');
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.quality-mutation',
      mutation: {
        format: 'stryker-json',
        sourceGlobs: ['src/**/*.mjs'],
        command: 'mkdir -p {outputDir} && cp inputs/mutation.json {outputDir}/mutation.json',
        output: '{outputDir}/mutation.json',
      },
      thresholds: { mutationScoreMinChanged: 0.8, survivorsMaxChanged: null },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--mutation-only', '--changed-since', base,
    ], { encoding: 'utf8' });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /## Mutation report: fixture-repo/);
    assert.match(result.stdout, /Mutants: 3; killed: 1; survived: 1; timeout: 1; no coverage: 0; ignored: 0; score: 66\.7%\./);
    assert.match(result.stdout, /\| `src\/cart\.mjs:4` \| ArithmeticOperator \| `-` \|/);
  });

  it('writes the changed-source patch for cargo-mutants --in-diff', async () => {
    const repo = await makeFixtureRepo();
    const base = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    await mkdir(join(repo, 'crates', 'core', 'src'), { recursive: true });
    await writeFile(join(repo, 'crates', 'core', 'src', 'cart.rs'), 'pub fn total() -> u8 { 1 }\n');
    await writeFile(join(repo, 'notes.md'), 'not rust\n');
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.quality-mutation',
      mutation: {
        format: 'cargo-mutants-outcomes',
        sourceGlobs: ['crates/**/*.rs'],
        command: 'mkdir -p {outputDir}/mutants && cp {changedDiff} {outputDir}/captured.diff && cp inputs/outcomes.json {outputDir}/mutants/outcomes.json',
        output: '{outputDir}/mutants/outcomes.json',
      },
      thresholds: { mutationScoreMinChanged: 0.5, survivorsMaxChanged: null },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--mutation-only', '--changed-since', base, '--json',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const patchText = await readFile(join(repo, '.quality-mutation', 'captured.diff'), 'utf8');
    assert.match(patchText, /crates\/core\/src\/cart\.rs/);
    assert.doesNotMatch(patchText, /notes\.md/);
  });

  it('writes a full-source patch when cargo mutation explicitly opts into alwaysRun', async () => {
    const repo = await makeFixtureRepo();
    await mkdir(join(repo, 'crates', 'core', 'src'), { recursive: true });
    await writeFile(join(repo, 'crates', 'core', 'src', 'cart.rs'), 'pub fn total() -> u8 { 1 }\n');
    spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', 'crates/core/src/cart.rs'], { cwd: repo });
    spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'add rust source'], { cwd: repo });
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.quality-mutation',
      mutation: {
        format: 'cargo-mutants-outcomes',
        sourceGlobs: ['crates/**/*.rs'],
        alwaysRun: true,
        command: 'mkdir -p {outputDir}/mutants && cp {changedDiff} {outputDir}/captured.diff && cp inputs/outcomes.json {outputDir}/mutants/outcomes.json',
        output: '{outputDir}/mutants/outcomes.json',
      },
      thresholds: { mutationScoreMinChanged: 0.5, survivorsMaxChanged: null },
    }, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      cli, '--repo', repo, '--mutation-only', '--json',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const patchText = await readFile(join(repo, '.quality-mutation', 'captured.diff'), 'utf8');
    assert.match(patchText, /crates\/core\/src\/cart\.rs/);
  });

  it('skips mutation without an explicit diff scope or without changed source files', async () => {
    const repo = await makeFixtureRepo();
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
    await writeFile(join(repo, '.quality-gates.json'), `${JSON.stringify({
      repo: 'fixture-repo',
      outputDir: '.quality-mutation',
      mutation: {
        format: 'stryker-json',
        sourceGlobs: ['src/**/*.mjs'],
        command: 'exit 91',
        output: '{outputDir}/mutation.json',
      },
    }, null, 2)}\n`);

    const unscoped = spawnSync(process.execPath, [
      cli, '--repo', repo, '--mutation-only', '--json',
    ], { encoding: 'utf8' });
    assert.equal(unscoped.status, 0, unscoped.stderr);
    assert.equal(JSON.parse(unscoped.stdout).mutation.skipped, 'changed-since required');

    const unchanged = spawnSync(process.execPath, [
      cli, '--repo', repo, '--mutation-only', '--changed-since', head, '--json',
    ], { encoding: 'utf8' });
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(JSON.parse(unchanged.stdout).mutation.skipped, 'no changed files');
  });
});
