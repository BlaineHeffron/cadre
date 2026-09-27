import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildQualityReport,
  buildMutationReport,
  buildRatchetBaseline,
  buildRepoQualityFixPrompt,
  compareQualityRatchet,
  computeQualityReportDelta,
  joinFunctionMetrics,
  normalizeRepoQualityCheckResult,
  parseRepoQualityCheckOutput,
  rankRepoQualityFixCandidates,
  readPreviousRepoQualityReport,
  repoQualityReportSlug,
  shouldDispatchRepoQualityFix,
  writeRepoQualityReportRecord,
  validateRatchetBaseline,
  parseEslintComplexity,
  parseIstanbulCoverage,
  parseLlvmCovCoverage,
  parseRustCodeAnalysisComplexity,
  parseCargoMutantsOutcomes,
  parseJscpdJson,
  parseStrykerMutation,
} from '../modules/integrations/repo-quality.mjs';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'repo-quality');
const readJsonFixture = (name) => JSON.parse(readFileSync(join(fixtureDir, name), 'utf8'));

describe('repo quality helpers', () => {
  it('parses Stryker results into normalized per-file mutation metrics', () => {
    assert.deepEqual(parseStrykerMutation(readJsonFixture('mutation.json')), {
      files: [
        {
          file: 'src/cart.mjs', killed: 1, survived: 1, timeout: 1,
          noCoverage: 0, ignored: 0, score: 0.6667,
        },
        {
          file: 'src/unused.mjs', killed: 0, survived: 0, timeout: 0,
          noCoverage: 1, ignored: 1, score: 0,
        },
      ],
      mutants: [
        {
          file: 'src/cart.mjs', line: 1, mutator: 'ArithmeticOperator',
          replacement: '-', status: 'killed',
        },
        {
          file: 'src/cart.mjs', line: 4, mutator: 'ArithmeticOperator',
          replacement: '-', status: 'survived',
        },
        {
          file: 'src/cart.mjs', line: 8, mutator: 'BlockStatement',
          replacement: '{}', status: 'timeout',
        },
        {
          file: 'src/unused.mjs', line: 1, mutator: 'BooleanLiteral',
          replacement: 'false', status: 'noCoverage',
        },
        {
          file: 'src/unused.mjs', line: 2, mutator: 'StringLiteral',
          replacement: '\"\"', status: 'ignored',
        },
      ],
    });
  });

  it('parses cargo-mutants outcomes into normalized per-file mutation metrics', () => {
    assert.deepEqual(parseCargoMutantsOutcomes(readJsonFixture('outcomes.json')), {
      files: [
        {
          file: 'crates/api/src/lib.rs', killed: 0, survived: 0, timeout: 1,
          noCoverage: 0, ignored: 1, score: 1,
        },
        {
          file: 'crates/core/src/cart.rs', killed: 1, survived: 1, timeout: 0,
          noCoverage: 0, ignored: 0, score: 0.5,
        },
      ],
      mutants: [
        {
          file: 'crates/core/src/cart.rs', line: 12, mutator: 'BinaryOperator',
          replacement: '-', status: 'killed',
        },
        {
          file: 'crates/core/src/cart.rs', line: 20, mutator: 'FnValue',
          replacement: 'Default::default()', status: 'survived',
        },
        {
          file: 'crates/api/src/lib.rs', line: 7, mutator: 'MatchArm',
          replacement: '', status: 'timeout',
        },
        {
          file: 'crates/api/src/lib.rs', line: 30, mutator: 'BinaryOperator',
          replacement: '!=', status: 'ignored',
        },
      ],
    });
  });

  it('gates mutation metrics only for changed files', () => {
    const parsed = parseStrykerMutation(readJsonFixture('mutation.json'));
    assert.deepEqual(buildMutationReport({
      parsed,
      format: 'stryker-json',
      changedSince: 'origin/main',
      changedFiles: ['src/cart.mjs'],
    }), {
      format: 'stryker-json',
      changedSince: 'origin/main',
      changedFiles: ['src/cart.mjs'],
      skipped: false,
      thresholds: { mutationScoreMinChanged: 0.8, survivorsMaxChanged: null },
      totals: {
        mutants: 3, killed: 1, survived: 1, timeout: 1,
        noCoverage: 0, ignored: 0, score: 0.6667,
      },
      files: [{
        file: 'src/cart.mjs', killed: 1, survived: 1, timeout: 1,
        noCoverage: 0, ignored: 0, score: 0.6667,
      }],
      survivors: [{
        file: 'src/cart.mjs', line: 4, mutator: 'ArithmeticOperator', replacement: '-',
      }],
      passed: false,
      failures: ['mutation score 0.6667 is below 0.8'],
    });
  });

  it('fails when mutation JSON files do not overlap the changed set', () => {
    const parsed = parseStrykerMutation({
      files: {
        './src/cart.mjs': {
          mutants: [{ status: 'Survived', mutatorName: 'BooleanLiteral', replacement: 'false', location: { start: { line: 1 } } }],
        },
      },
    });
    const matched = buildMutationReport({
      parsed,
      format: 'stryker-json',
      changedSince: 'origin/main',
      changedFiles: ['src/cart.mjs'],
    });
    assert.equal(matched.passed, false);
    assert.equal(matched.files[0].file, 'src/cart.mjs');
    assert.deepEqual(buildMutationReport({
      parsed: parseStrykerMutation({
        files: {
          'lib/other.mjs': {
            mutants: [{ status: 'Killed', mutatorName: 'BooleanLiteral', replacement: 'false', location: { start: { line: 1 } } }],
          },
        },
      }),
      format: 'stryker-json',
      changedSince: 'origin/main',
      changedFiles: ['src/cart.mjs'],
    }).failures, ['mutation report files did not match changed files']);
  });

  it('parses jscpd JSON into duplicatedLinesPct and normalized clones', () => {
    assert.deepEqual(parseJscpdJson(readJsonFixture('jscpd-report.json'), '/repo'), {
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
  });

  it('resolves relative jscpd clone paths against the repo root', () => {
    assert.deepEqual(parseJscpdJson({
      statistics: { total: { percentage: 1.5 } },
      duplicates: [{
        lines: 4,
        firstFile: { name: 'src/a.mjs', start: 2, end: 5 },
        secondFile: { name: 'src/b.mjs', start: 8, end: 11 },
      }],
    }, '/repo'), {
      duplicatedLinesPct: 1.5,
      clones: [{
        fileA: 'src/a.mjs',
        startA: 2,
        endA: 5,
        fileB: 'src/b.mjs',
        startB: 8,
        endB: 11,
        lines: 4,
      }],
    });
  });

  it('parses ESLint complexity diagnostics into normalized function records', () => {
    assert.deepEqual(parseEslintComplexity(readJsonFixture('eslint.json'), '/repo'), [
      { file: 'src/cart.mjs', line: 10, column: 2, cc: 4, name: 'checkout' },
      { file: '/outside/shared.mjs', line: 5, column: 0, cc: 2, name: 'Arrow function' },
    ]);
  });

  it('counts only statements contained by each Istanbul function body', () => {
    assert.deepEqual(parseIstanbulCoverage(readJsonFixture('coverage-final.json'), '/repo'), [
      {
        file: 'src/cart.mjs',
        line: 10,
        column: 2,
        endLine: 13,
        name: 'checkout',
        statementsTotal: 3,
        statementsCovered: 2,
        called: true,
      },
    ]);
  });

  it('counts only same-file llvm-cov code regions, earliest start, and 0-based columns', () => {
    assert.deepEqual(parseLlvmCovCoverage(readJsonFixture('llvm-cov.json'), '/repo'), [
      {
        file: 'src/cart.rs',
        line: 10,
        column: 2,
        endLine: 13,
        name: 'checkout',
        statementsTotal: 3,
        statementsCovered: 2,
        called: true,
      },
    ]);
  });

  it('subtracts nested rust-code-analysis spaces from parent cyclomatic', () => {
    assert.deepEqual(
      parseRustCodeAnalysisComplexity(readJsonFixture('rust-code-analysis.json'), '/repo', 'src/cart.rs'),
      [
        { file: 'src/cart.rs', line: 10, column: 0, cc: 12, name: 'checkout' },
        { file: 'src/cart.rs', line: 10, column: 0, cc: 4, name: 'closure' },
        { file: 'src/cart.rs', line: 50, column: 0, cc: 9, name: 'helper' },
      ],
    );
  });

  it('prefers rust-code-analysis root name when it normalizes inside the repo', () => {
    assert.deepEqual(
      parseRustCodeAnalysisComplexity(readJsonFixture('rust-code-analysis.json'), '/repo', 'abs/src/cart.rs'),
      [
        { file: 'src/cart.rs', line: 10, column: 0, cc: 12, name: 'checkout' },
        { file: 'src/cart.rs', line: 10, column: 0, cc: 4, name: 'closure' },
        { file: 'src/cart.rs', line: 50, column: 0, cc: 9, name: 'helper' },
      ],
    );
  });

  it('drops rust-code-analysis functions whose direct cyclomatic is below 1', () => {
    assert.deepEqual(
      parseRustCodeAnalysisComplexity({
        name: '/repo/src/cart.rs',
        kind: 'unit',
        spaces: [{
          name: 'broken',
          start_line: 3,
          kind: 'function',
          metrics: { cyclomatic: { sum: 2 } },
          spaces: [{ metrics: { cyclomatic: { sum: 4 } }, spaces: [] }],
        }],
      }, '/repo', 'src/cart.rs'),
      [],
    );
  });

  it('joins llvm-cov and rust-code-analysis functions by file and start line', () => {
    const complexity = parseRustCodeAnalysisComplexity(
      readJsonFixture('join-rust-code-analysis.json'),
      '/repo',
      'src/nested.rs',
    );
    const coverage = parseLlvmCovCoverage(readJsonFixture('join-llvm-cov.json'), '/repo');

    assert.deepEqual(joinFunctionMetrics(complexity, coverage), {
      functions: [
        {
          file: 'src/nested.rs', line: 14, column: 0, endLine: 16, name: 'closure',
          statementsTotal: 1, statementsCovered: 0, called: false,
          cc: 4, coverage: 0, crap: 20,
        },
        {
          file: 'src/nested.rs', line: 10, column: 0, endLine: 20, name: 'parent',
          statementsTotal: 2, statementsCovered: 1, called: true,
          cc: 12, coverage: 0.5, crap: 30,
        },
        {
          file: 'src/nested.rs', line: 30, column: 0, endLine: 32, name: 'unmatched',
          statementsTotal: 1, statementsCovered: 1, called: true,
          cc: null, coverage: 1, crap: null,
        },
      ],
      eslintOnly: [
        { file: 'src/nested.rs', line: 50, column: 0, cc: 9, name: 'rustOnly' },
      ],
    });
  });

  it('joins same-line functions by nearest column and consumes complexity entries once', () => {
    const complexity = parseEslintComplexity(readJsonFixture('join-eslint.json'), '/repo');
    const coverage = parseIstanbulCoverage(readJsonFixture('join-coverage-final.json'), '/repo');

    assert.deepEqual(joinFunctionMetrics(complexity, coverage), {
      functions: [
        {
          file: 'src/nested.mjs', line: 10, column: 39, endLine: 12, name: 'Arrow function',
          statementsTotal: 1, statementsCovered: 0, called: false,
          cc: 4, coverage: 0, crap: 20,
        },
        {
          file: 'src/nested.mjs', line: 10, column: 0, endLine: 20, name: 'parent',
          statementsTotal: 2, statementsCovered: 1, called: true,
          cc: 12, coverage: 0.5, crap: 30,
        },
        {
          file: 'src/nested.mjs', line: 30, column: 0, endLine: 32, name: 'unmatched',
          statementsTotal: 1, statementsCovered: 1, called: true,
          cc: null, coverage: 1, crap: null,
        },
      ],
      eslintOnly: [
        { file: 'src/nested.mjs', line: 50, column: 0, cc: 9, name: 'eslintOnly' },
      ],
    });
  });

  it('builds a deterministic normalized report with CRAP threshold totals', () => {
    const functions = [
      {
        file: 'src/a.mjs', line: 2, column: 0, endLine: 4, name: 'covered',
        statementsTotal: 2, statementsCovered: 2, called: true,
        cc: 4, coverage: 1, crap: 4,
      },
      {
        file: 'src/b.mjs', line: 8, column: 1, endLine: 12, name: 'risky',
        statementsTotal: 1, statementsCovered: 0, called: false,
        cc: 10, coverage: 0, crap: 110,
      },
      {
        file: 'src/c.mjs', line: 1, column: 0, endLine: 1, name: 'unmatched',
        statementsTotal: 1, statementsCovered: 1, called: true,
        cc: null, coverage: 1, crap: null,
      },
    ];

    assert.deepEqual(buildQualityReport({
      repo: 'example',
      sha: 'abc123',
      generatedAt: '2026-08-20T12:00:00.000Z',
      functions,
      eslintOnly: [{ file: 'src/d.mjs' }],
      crapFail: 30,
    }), {
      repo: 'example',
      sha: 'abc123',
      generatedAt: '2026-08-20T12:00:00.000Z',
      totals: {
        functions: 3,
        scoredFunctions: 2,
        unmatchedComplexity: 1,
        eslintOnly: 1,
        statementsTotal: 4,
        statementsCovered: 3,
        statementCoverage: 0.75,
        calledFunctions: 2,
        uncalledFunctions: 1,
        crapFail: 30,
        crapAboveFail: 1,
        crapSumAboveFail: 110,
        crapAbove6: 1,
      },
      functions: [functions[1], functions[0], functions[2]],
    });
  });

  it('ratchets both the offender count and aggregate CRAP above the threshold', () => {
    const report = {
      repo: 'example', sha: 'new', generatedAt: '2026-08-20T13:00:00.000Z',
      totals: { crapFail: 30, crapAboveFail: 3, crapSumAboveFail: 125.5 },
    };
    const baselineReport = {
      repo: 'example', sha: 'old', generatedAt: '2026-08-19T13:00:00.000Z',
      totals: { crapFail: 30, crapAboveFail: 2, crapSumAboveFail: 100 },
    };
    const baseline = buildRatchetBaseline(baselineReport);

    assert.deepEqual(baseline, {
      repo: 'example',
      sha: 'old',
      generatedAt: '2026-08-19T13:00:00.000Z',
      crapFail: 30,
      crapAboveFail: 2,
      crapSumAboveFail: 100,
    });
    assert.deepEqual(compareQualityRatchet(report, baseline), {
      passed: false,
      current: { crapAboveFail: 3, crapSumAboveFail: 125.5 },
      baseline: { crapAboveFail: 2, crapSumAboveFail: 100 },
      regressions: [
        { metric: 'crapAboveFail', baseline: 2, current: 3 },
        { metric: 'crapSumAboveFail', baseline: 100, current: 125.5 },
      ],
    });
    assert.equal(
      compareQualityRatchet({
        totals: { crapAboveFail: 2, crapSumAboveFail: 100.005 },
      }, baseline).passed,
      true,
    );
    assert.throws(
      () => validateRatchetBaseline({ crapFail: 30, crapAboveFail: 2 }),
      /crapSumAboveFail/,
    );
    assert.throws(
      () => compareQualityRatchet(report, { crapFail: 30 }),
      /crapAboveFail/,
    );
  });

  it('ratchets duplicatedLinesPct so it may not rise above baseline + 0.1', () => {
    const report = {
      repo: 'example', sha: 'new', generatedAt: '2026-08-20T13:00:00.000Z',
      totals: { crapFail: 30, crapAboveFail: 2, crapSumAboveFail: 100 },
      dry: { duplicatedLinesPct: 12.7, clones: [] },
    };
    const baseline = buildRatchetBaseline({
      repo: 'example', sha: 'old', generatedAt: '2026-08-19T13:00:00.000Z',
      totals: { crapFail: 30, crapAboveFail: 2, crapSumAboveFail: 100 },
      dry: { duplicatedLinesPct: 12.5, clones: [] },
    });

    assert.equal(baseline.duplicatedLinesPct, 12.5);
    assert.deepEqual(compareQualityRatchet(report, baseline), {
      passed: false,
      current: { crapAboveFail: 2, crapSumAboveFail: 100, duplicatedLinesPct: 12.7 },
      baseline: { crapAboveFail: 2, crapSumAboveFail: 100, duplicatedLinesPct: 12.5 },
      regressions: [
        { metric: 'duplicatedLinesPct', baseline: 12.5, current: 12.7 },
      ],
    });
    assert.equal(
      compareQualityRatchet({
        totals: { crapAboveFail: 2, crapSumAboveFail: 100 },
        dry: { duplicatedLinesPct: 12.6 },
      }, baseline).passed,
      true,
    );
    assert.throws(
      () => compareQualityRatchet(report, {
        crapFail: 30, crapAboveFail: 2, crapSumAboveFail: 100,
      }),
      /duplicatedLinesPct/,
    );
  });

  it('fails closed when current duplicatedLinesPct is non-finite, negative, or above 100', () => {
    const baseline = {
      crapFail: 30, crapAboveFail: 0, crapSumAboveFail: 0, duplicatedLinesPct: 2.81,
    };
    const report = (duplicatedLinesPct) => ({
      totals: { crapAboveFail: 0, crapSumAboveFail: 0 },
      dry: { duplicatedLinesPct },
    });
    assert.throws(
      () => compareQualityRatchet(report('not-a-number'), baseline),
      /duplicatedLinesPct/,
    );
    assert.throws(
      () => compareQualityRatchet(report(-0.1), baseline),
      /duplicatedLinesPct/,
    );
    assert.throws(
      () => compareQualityRatchet(report(100.1), baseline),
      /duplicatedLinesPct/,
    );
    assert.equal(compareQualityRatchet(report(0), baseline).passed, true);
    assert.equal(compareQualityRatchet(report(2.81), baseline).passed, true);
  });

  it('ranks fix candidates by remaining CRAP debt instead of config order', () => {
    const ranked = rankRepoQualityFixCandidates([
      { repoPath: '/a', report: { totals: { crapAboveFail: 1, crapSumAboveFail: 40 } } },
      { repoPath: '/b', report: { totals: { crapAboveFail: 9, crapSumAboveFail: 10 } } },
      { repoPath: '/c', report: { totals: { crapAboveFail: 9, crapSumAboveFail: 400 } } },
    ]);
    assert.deepEqual(ranked.map((item) => item.repoPath), ['/c', '/b', '/a']);
  });

  it('builds collision-safe report slugs from full paths instead of basenames', () => {
    const left = repoQualityReportSlug('/home/dev/projects/dueno-fleet');
    const right = repoQualityReportSlug('/tmp/other/dueno-fleet');
    assert.notEqual(left, right);
    assert.match(left, /dueno-fleet/);
    assert.match(right, /dueno-fleet/);
  });

  it('dispatches on remaining CRAP debt or previous-report ratchet failure, never on exit 2', () => {
    const dirty = { sha: 'sha_dirty', totals: { crapFail: 30, crapAboveFail: 2, crapSumAboveFail: 80 } };
    const dirtier = { sha: 'sha_dirtier', totals: { crapFail: 30, crapAboveFail: 3, crapSumAboveFail: 120 } };
    const clean = { sha: 'sha_clean', totals: { crapFail: 30, crapAboveFail: 0, crapSumAboveFail: 0 } };
    assert.equal(shouldDispatchRepoQualityFix({ code: 0, report: dirty }), true);
    assert.equal(shouldDispatchRepoQualityFix({ code: 1, report: clean }), true);
    assert.equal(shouldDispatchRepoQualityFix({ code: 1, report: dirty }), true);
    assert.equal(shouldDispatchRepoQualityFix({ code: 2, report: dirty }), false);
    assert.equal(shouldDispatchRepoQualityFix({ code: 2, report: null }), false);
    assert.equal(shouldDispatchRepoQualityFix({ code: 0, report: clean }), false);
    assert.equal(shouldDispatchRepoQualityFix({ code: 0, report: dirtier }, dirty), true);
    assert.equal(shouldDispatchRepoQualityFix({ code: Number.NaN, report: dirty }), false);
    assert.equal(shouldDispatchRepoQualityFix({ code: 3, report: dirty }), false);
  });

  it('normalizes unknown check codes to exit 2 before dispatch', () => {
    assert.deepEqual(normalizeRepoQualityCheckResult({ code: Number.NaN, report: { totals: { crapAboveFail: 2 } } }), {
      code: 2,
      report: null,
      error: 'repo_quality_check_failed',
    });
    assert.deepEqual(normalizeRepoQualityCheckResult({
      code: 1,
      report: { sha: 'abc', totals: { crapFail: 30, crapAboveFail: 0, crapSumAboveFail: 0 } },
    }), {
      code: 1,
      report: { sha: 'abc', totals: { crapFail: 30, crapAboveFail: 0, crapSumAboveFail: 0 } },
      error: null,
    });
  });

  it('parses CLI stdout JSON and ignores stderr', () => {
    const report = { sha: 'abc', totals: { crapFail: 30, crapAboveFail: 1, crapSumAboveFail: 40 } };
    assert.deepEqual(parseRepoQualityCheckOutput({
      code: 1,
      stdout: JSON.stringify(report),
      stderr: 'ratchet failed',
    }), { code: 1, report, error: null });
    assert.deepEqual(parseRepoQualityCheckOutput({
      code: 0,
      stdout: 'not-json',
      stderr: 'ignored',
      errorMessage: 'boom',
    }), { code: 2, report: null, error: 'boom' });
    assert.deepEqual(parseRepoQualityCheckOutput({
      code: 2,
      stdout: JSON.stringify(report),
      stderr: 'tool exploded',
    }), { code: 2, report: null, error: 'tool exploded' });
  });

  it('fails closed when exit 0 or 1 has a missing or malformed report', () => {
    assert.deepEqual(normalizeRepoQualityCheckResult({ code: 0, report: null }), {
      code: 2,
      report: null,
      error: 'repo_quality_check_failed',
    });
    assert.deepEqual(normalizeRepoQualityCheckResult({ code: 1, report: {} }), {
      code: 2,
      report: null,
      error: 'repo_quality_check_failed',
    });
    assert.deepEqual(normalizeRepoQualityCheckResult({
      code: 0,
      report: { totals: { crapFail: 30, crapAboveFail: 0, crapSumAboveFail: 0 } },
    }), {
      code: 2,
      report: null,
      error: 'repo_quality_check_failed',
    });
    assert.deepEqual(normalizeRepoQualityCheckResult({
      code: 1,
      report: { sha: 'abc' },
    }), {
      code: 2,
      report: null,
      error: 'repo_quality_check_failed',
    });
    assert.deepEqual(normalizeRepoQualityCheckResult({
      code: 0,
      report: { sha: 'abc', totals: { crapFail: 30, crapAboveFail: Number.NaN, crapSumAboveFail: 0 } },
    }), {
      code: 2,
      report: null,
      error: 'repo_quality_check_failed',
    });
  });

  it('computes a delta against the previous stored report', () => {
    assert.deepEqual(computeQualityReportDelta({
      sha: 'bbb',
      totals: { crapAboveFail: 3, crapSumAboveFail: 120 },
      mutation: { totals: { survived: 4 } },
    }, {
      sha: 'aaa',
      totals: { crapAboveFail: 2, crapSumAboveFail: 80 },
      mutation: { totals: { survived: 1 } },
    }), {
      previousSha: 'aaa',
      currentSha: 'bbb',
      crapAboveFail: { previous: 2, current: 3, delta: 1 },
      crapSumAboveFail: { previous: 80, current: 120, delta: 40 },
      survivors: { previous: 1, current: 4, delta: 3 },
    });
    assert.deepEqual(computeQualityReportDelta({
      sha: 'bbb',
      totals: { crapAboveFail: 2, crapSumAboveFail: 80 },
    }, null), {
      previousSha: null,
      currentSha: 'bbb',
      crapAboveFail: { previous: null, current: 2, delta: null },
      crapSumAboveFail: { previous: null, current: 80, delta: null },
      survivors: { previous: null, current: 0, delta: null },
    });
  });

  it('stores previous reports independently for each named section of one repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'repo-quality-sections-'));
    const repoPath = '/repo/businessos';
    const frontend = {
      repoPath,
      section: 'default',
      sha: 'same_sha',
      code: 1,
      report: {
        sha: 'same_sha',
        totals: { crapFail: 30, crapAboveFail: 4, crapSumAboveFail: 120 },
      },
    };
    const rust = {
      repoPath,
      section: 'rust',
      sha: 'same_sha',
      code: 1,
      report: {
        sha: 'same_sha',
        totals: { crapFail: 30, crapAboveFail: 9, crapSumAboveFail: 480 },
      },
    };

    try {
      await writeRepoQualityReportRecord(dir, frontend);
      await writeRepoQualityReportRecord(dir, rust);

      assert.equal(
        repoQualityReportSlug(repoPath, 'default'),
        repoQualityReportSlug(repoPath),
      );
      assert.equal(
        repoQualityReportSlug(repoPath, ' Default '),
        repoQualityReportSlug(repoPath, 'default'),
      );
      assert.notEqual(
        repoQualityReportSlug(repoPath, 'default'),
        repoQualityReportSlug(repoPath, 'rust'),
      );
      assert.deepEqual(
        await readPreviousRepoQualityReport(dir, repoPath, 'default'),
        frontend.report,
      );
      assert.deepEqual(
        await readPreviousRepoQualityReport(dir, repoPath, 'rust'),
        rust.report,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the last valid report after an exit-2 error record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'repo-quality-state-'));
    const repoPath = '/repo/fleet';
    const valid = {
      repoPath,
      slug: repoQualityReportSlug(repoPath),
      sha: 'sha_ok',
      code: 1,
      report: {
        sha: 'sha_ok',
        totals: { crapFail: 30, crapAboveFail: 2, crapSumAboveFail: 80 },
      },
    };
    try {
      await writeRepoQualityReportRecord(dir, valid);
      await writeRepoQualityReportRecord(dir, {
        repoPath,
        slug: valid.slug,
        code: 2,
        error: 'missing config',
        report: null,
      });
      await writeRepoQualityReportRecord(dir, {
        repoPath,
        slug: valid.slug,
        sha: 'sha_bad',
        code: 1,
        report: {},
      });
      assert.deepEqual(await readPreviousRepoQualityReport(dir, repoPath), valid.report);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('builds a per-repo fix brief with top-N file:line, survivors, test honesty, and PR rule', () => {
    const prompt = buildRepoQualityFixPrompt({
      repoPath: '/repo/fleet',
      worktreePath: '/wt/fleet',
      topN: 2,
      report: {
        repo: 'fleet',
        sha: 'abc123',
        totals: { crapFail: 30, crapAboveFail: 3, crapSumAboveFail: 121 },
        functions: [
          { file: 'hot.mjs', line: 10, name: 'explode', crap: 50, cc: 10, coverage: 0 },
          { file: 'warm.mjs', line: 20, name: 'simmer', crap: 40, cc: 8, coverage: 0.1 },
          { file: 'cool.mjs', line: 30, name: 'ok', crap: 31, cc: 7, coverage: 0.2 },
        ],
        mutation: {
          survivors: [
            { file: 'hot.mjs', line: 12, mutator: 'BooleanLiteral', replacement: 'true' },
          ],
        },
      },
    });
    assert.match(prompt, /hot\.mjs:10/);
    assert.match(prompt, /warm\.mjs:20/);
    assert.doesNotMatch(prompt, /cool\.mjs:30/);
    assert.match(prompt, /hot\.mjs:12/);
    assert.match(prompt, /Never weaken a test/);
    assert.match(prompt, /open a PR/i);
    assert.match(prompt, /do not merge/i);
    assert.match(prompt, /\/wt\/fleet/);
  });

  it('uses the quality-gate skill token when a custom skills dir provides it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dueno-repo-quality-skills-'));
    const customDir = join(root, 'custom');
    await mkdir(customDir, { recursive: true });
    await writeFile(join(customDir, 'quality-gate.md'), '# Quality Gate\n\nRun the gates.');
    const sourceConfig = { launchSkills: { dir: join(root, 'stock'), localDir: join(root, 'local'), customDirs: customDir } };
    try {
      const prompt = buildRepoQualityFixPrompt({
        repoPath: '/repo/fleet',
        worktreePath: '/wt/fleet',
        report: { repo: 'fleet', sha: 'abc123', totals: { crapFail: 30, crapAboveFail: 0 }, functions: [] },
        sourceConfig,
      });
      assert.match(prompt, /\{\{skill:quality-gate\}\}/);
      assert.doesNotMatch(prompt, /Never weaken a test/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
