#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  buildMutationReport,
  buildQualityReport,
  buildRatchetBaseline,
  compareQualityRatchet,
  formatMutationMarkdown,
  formatQualityMarkdown,
  joinFunctionMetrics,
  parseEslintComplexity,
  parseCargoMutantsOutcomes,
  parseIstanbulCoverage,
  parseLlvmCovCoverage,
  parseJscpdJson,
  parseRustCodeAnalysisComplexity,
  parseStrykerMutation,
  validateDuplicatedLinesPct,
  validateRatchetBaseline,
  normalizeRepoQualitySection,
} from '../modules/integrations/repo-quality.mjs';

function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function parseArgs(argv) {
  const options = {
    command: null,
    repo: process.cwd(),
    config: null,
    section: 'default',
    json: false,
    top: 15,
    baseline: null,
    updateBaseline: false,
    runTools: true,
    mutationOnly: false,
    changedSince: null,
    pr: null,
    sha: null,
    summary: null,
  };
  let startIndex = 0;
  if (argv[0] === 'record-escape') {
    options.command = 'record-escape';
    startIndex = 1;
  }
  const values = new Map([
    ['--repo', 'repo'],
    ['--config', 'config'],
    ['--section', 'section'],
    ['--top', 'top'],
    ['--baseline', 'baseline'],
    ['--changed-since', 'changedSince'],
  ]);
  if (options.command === 'record-escape') {
    values.set('--pr', 'pr');
    values.set('--sha', 'sha');
    values.set('--summary', 'summary');
  }
  for (let index = startIndex; index < argv.length; index += 1) {
    const arg = argv[index];
    if (values.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw usageError(`${arg} requires a value`);
      options[values.get(arg)] = value;
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--update-baseline') {
      options.updateBaseline = true;
    } else if (arg === '--no-run') {
      options.runTools = false;
    } else if (arg === '--mutation-only') {
      options.mutationOnly = true;
    } else {
      throw usageError(`unknown option: ${arg}`);
    }
  }
  options.top = Number(options.top);
  if (!Number.isInteger(options.top) || options.top < 1) throw usageError('--top must be a positive integer');
  if (options.command === 'record-escape') {
    options.pr = Number(options.pr);
    if (!Number.isInteger(options.pr) || options.pr < 1) throw usageError('--pr must be a positive integer');
    options.sha = String(options.sha || '').trim();
    options.summary = String(options.summary || '').trim();
    if (!options.sha) throw usageError('--sha must be a non-empty string');
    if (!options.summary) throw usageError('--summary must be a non-empty string');
  }
  return options;
}

function resolveFromRepo(repoRoot, value) {
  if (!value) return '';
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw usageError(`cannot read ${label} ${path}: ${error.message}`);
  }
}

function selectConfigSection(config, section = 'default') {
  const normalizedSection = normalizeRepoQualitySection(section);
  if (normalizedSection === 'default') return config;
  const selected = config?.sections?.[normalizedSection];
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) {
    throw usageError(`config section not found: ${normalizedSection}`);
  }
  const { sections: _sections, ...defaults } = config;
  return { ...defaults, ...selected };
}

function escapedDefectTotals(outputDir, generatedAt) {
  const ledgerPath = join(outputDir, 'escaped-defects.jsonl');
  if (!existsSync(ledgerPath)) return { count: 0, last30Days: 0 };
  let records;
  try {
    records = readFileSync(ledgerPath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch (error) {
    throw usageError(`cannot read escaped-defect ledger ${ledgerPath}: ${error.message}`);
  }
  const windowEnd = Date.parse(generatedAt);
  const windowStart = windowEnd - (30 * 24 * 60 * 60 * 1000);
  return {
    count: records.length,
    last30Days: records.filter((record) => {
      const recordedAtMs = Date.parse(record?.recordedAt);
      if (!Number.isFinite(recordedAtMs)) {
        throw usageError(`cannot read escaped-defect ledger ${ledgerPath}: invalid recordedAt`);
      }
      return recordedAtMs >= windowStart && recordedAtMs <= windowEnd;
    }).length,
  };
}

function gitSha(repoRoot) {
  const result = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (result.status !== 0) throw usageError(`cannot resolve git SHA for ${repoRoot}`);
  return result.stdout.trim();
}

const COVERAGE_FORMATS = new Set(['istanbul-json', 'llvm-cov-json']);
const COMPLEXITY_FORMATS = new Set(['eslint-json', 'rust-code-analysis-json']);

function validateAdapter(adapter, expectedFormats, label) {
  if (!adapter || !expectedFormats.has(adapter.format) || !adapter.output || !adapter.command) {
    throw usageError(`${label} adapter must use ${[...expectedFormats].join(' or ')} and declare output`);
  }
}

function validateMutationAdapter(adapter) {
  const formats = new Set(['stryker-json', 'cargo-mutants-outcomes']);
  if (!adapter || !formats.has(adapter.format) || !adapter.output || !adapter.command) {
    throw usageError('mutation adapter must use stryker-json or cargo-mutants-outcomes and declare output');
  }
}

function validateDryAdapter(adapter) {
  if (!adapter || adapter.format !== 'jscpd-json' || !adapter.output || !adapter.command) {
    throw usageError('dry adapter must use jscpd-json and declare output');
  }
}

function configuredPath(repoRoot, outputDir, value) {
  return resolveFromRepo(repoRoot, String(value).replaceAll('{outputDir}', outputDir));
}

function isStrictDescendant(parent, child) {
  const rel = relative(resolve(parent), resolve(child)).replaceAll('\\', '/');
  return Boolean(rel) && rel !== '.' && !rel.startsWith('..');
}

function assertRustMetricsOutputPath(repoRoot, outputDir, outputPath) {
  if (!isStrictDescendant(repoRoot, outputDir)) {
    throw usageError('rust-code-analysis outputDir must be a dedicated child of the repository');
  }
  if (!isStrictDescendant(outputDir, outputPath)) {
    throw usageError('rust-code-analysis output must be a dedicated child of outputDir');
  }
}

function pathsOverlap(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return a === b || isStrictDescendant(a, b) || isStrictDescendant(b, a);
}

function assertRustMetricsDoesNotOverlapCoverage(repoRoot, outputDir, config) {
  if (config.complexity?.format !== 'rust-code-analysis-json') return;
  const metricsPath = configuredPath(repoRoot, outputDir, config.complexity.output);
  const coveragePath = configuredPath(repoRoot, outputDir, config.coverage.output);
  assertRustMetricsOutputPath(repoRoot, outputDir, metricsPath);
  if (pathsOverlap(metricsPath, coveragePath)) {
    throw usageError('rust-code-analysis output must not overlap the coverage output path');
  }
}

function listJsonFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw usageError(`cannot read complexity output ${dir}: ${error.message}`);
  }
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listJsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) files.push(full);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function rustSourceFileFromOutput(outputPath, jsonPath) {
  const rel = relative(outputPath, jsonPath).replaceAll('\\', '/');
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !rel.endsWith('.json')) {
    throw usageError(`cannot derive source path from rust-code-analysis output ${jsonPath}`);
  }
  return rel.slice(0, -'.json'.length);
}

function parseComplexityAdapter(repoRoot, outputDir, adapter) {
  const outputPath = configuredPath(repoRoot, outputDir, adapter.output);
  if (adapter.format !== 'rust-code-analysis-json') {
    return parseEslintComplexity(readJson(outputPath, 'complexity output'), repoRoot);
  }
  assertRustMetricsOutputPath(repoRoot, outputDir, outputPath);
  const jsonFiles = listJsonFiles(outputPath);
  if (!jsonFiles.length) {
    throw usageError(`complexity output ${outputPath} contains no json files`);
  }
  const functions = [];
  for (const jsonPath of jsonFiles) {
    const sourceFile = rustSourceFileFromOutput(outputPath, jsonPath);
    functions.push(...parseRustCodeAnalysisComplexity(
      readJson(jsonPath, 'complexity output'),
      repoRoot,
      sourceFile,
    ));
  }
  return functions;
}

function runAdapter(repoRoot, outputDir, adapter, label, { replacements = {}, env = {} } = {}) {
  let command = adapter.command.replaceAll('{outputDir}', '"$QUALITY_OUTPUT_DIR"');
  for (const [placeholder, value] of Object.entries(replacements)) {
    command = command.replaceAll(`{${placeholder}}`, value);
  }
  const outputPath = configuredPath(repoRoot, outputDir, adapter.output);
  if (adapter.format === 'rust-code-analysis-json') {
    assertRustMetricsOutputPath(repoRoot, outputDir, outputPath);
    rmSync(outputPath, { recursive: true, force: true });
    mkdirSync(outputPath, { recursive: true });
  } else {
    rmSync(outputPath, { force: true });
    if (adapter.format === 'jscpd-json') {
      mkdirSync(dirname(outputPath), { recursive: true });
    }
  }
  const result = spawnSync(command, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, QUALITY_OUTPUT_DIR: outputDir, ...env },
    shell: '/bin/sh',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const allowedExit = result.status === 0
    || (adapter.format === 'eslint-json' && result.status === 1 && existsSync(outputPath))
    || (adapter.format === 'jscpd-json' && existsSync(outputPath))
    || (adapter.format === 'cargo-mutants-outcomes'
      && [2, 3].includes(result.status)
      && existsSync(outputPath));
  if (result.error || !allowedExit) {
    throw usageError(`${label} command failed with exit ${result.status ?? 'unknown'}`);
  }
}

function gitOutput(repoRoot, args, label) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = String(result.stderr || '').trim().split('\n')[0];
    throw usageError(`${label}${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
}

function mutationSourceGlobs(adapter) {
  if (Array.isArray(adapter.sourceGlobs) && adapter.sourceGlobs.length) return adapter.sourceGlobs;
  return adapter.format === 'cargo-mutants-outcomes'
    ? ['**/*.rs']
    : ['**/*.cjs', '**/*.mjs', '**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];
}

function gitPathspecs(adapter) {
  return mutationSourceGlobs(adapter).map((glob) => (
    String(glob).startsWith(':(') ? String(glob) : `:(glob)${glob}`
  ));
}

function changedSourceFiles(repoRoot, adapter, changedSince) {
  const pathspecs = gitPathspecs(adapter);
  const changed = new Set();
  const add = (lines) => lines.forEach((line) => changed.add(line));
  if (changedSince) {
    add(gitOutput(repoRoot, ['diff', '--name-only', '--diff-filter=ACMRTUXB', `${changedSince}...HEAD`, '--', ...pathspecs], `cannot diff ${changedSince}...HEAD`));
    add(gitOutput(repoRoot, ['diff', '--name-only', '--diff-filter=ACMRTUXB', 'HEAD', '--', ...pathspecs], 'cannot inspect uncommitted changes'));
    add(gitOutput(repoRoot, ['ls-files', '--others', '--exclude-standard', '--', ...pathspecs], 'cannot inspect untracked files'));
  } else {
    add(gitOutput(repoRoot, ['ls-files', '--', ...pathspecs], 'cannot list mutation source files'));
  }
  return [...changed]
    .filter((file) => existsSync(resolve(repoRoot, file)))
    .sort((left, right) => left.localeCompare(right));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function gitPatch(repoRoot, args, label, allowedStatuses = [0]) {
  const result = spawnSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!allowedStatuses.includes(result.status)) {
    const detail = String(result.stderr || '').trim().split('\n')[0];
    throw usageError(`${label}${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '');
}

function writeChangedDiff(repoRoot, outputDir, adapter, changedSince, changedFiles) {
  const pathspecs = gitPathspecs(adapter);
  if (!changedSince) {
    let fullPatch = '';
    for (const file of changedFiles) {
      fullPatch += gitPatch(
        repoRoot,
        ['diff', '--binary', '--no-index', '--', '/dev/null', file],
        `cannot create diff for ${file}`,
        [0, 1],
      );
    }
    const fullDiffPath = join(outputDir, 'changes.diff');
    writeFileSync(fullDiffPath, fullPatch);
    return fullDiffPath;
  }
  let patch = gitPatch(
    repoRoot,
    ['diff', '--binary', `${changedSince}...HEAD`, '--', ...pathspecs],
    `cannot create diff for ${changedSince}...HEAD`,
  );
  patch += gitPatch(
    repoRoot,
    ['diff', '--binary', 'HEAD', '--', ...pathspecs],
    'cannot create diff for uncommitted changes',
  );
  const untracked = gitOutput(
    repoRoot,
    ['ls-files', '--others', '--exclude-standard', '--', ...pathspecs],
    'cannot inspect untracked files',
  );
  for (const file of untracked) {
    patch += gitPatch(
      repoRoot,
      ['diff', '--binary', '--no-index', '--', '/dev/null', file],
      `cannot create diff for ${file}`,
      [0, 1],
    );
  }
  const diffPath = join(outputDir, 'changes.diff');
  writeFileSync(diffPath, patch);
  return diffPath;
}

function mutationThresholds(config) {
  const mutationScoreMinChanged = Number(config.thresholds?.mutationScoreMinChanged ?? 0.8);
  const rawSurvivors = config.thresholds?.survivorsMaxChanged;
  const survivorsMaxChanged = rawSurvivors === undefined || rawSurvivors === null
    ? null
    : Number(rawSurvivors);
  if (!Number.isFinite(mutationScoreMinChanged)
      || mutationScoreMinChanged < 0
      || mutationScoreMinChanged > 1) {
    throw usageError('thresholds.mutationScoreMinChanged must be between 0 and 1');
  }
  if (survivorsMaxChanged !== null
      && (!Number.isInteger(survivorsMaxChanged) || survivorsMaxChanged < 0)) {
    throw usageError('thresholds.survivorsMaxChanged must be null or an integer >= 0');
  }
  return { mutationScoreMinChanged, survivorsMaxChanged };
}

function skippedMutation(format, changedSince, reason, thresholds, changedFiles = []) {
  return {
    format,
    changedSince,
    changedFiles,
    skipped: reason,
    thresholds,
    totals: { mutants: 0, killed: 0, survived: 0, timeout: 0, noCoverage: 0, ignored: 0, score: 1 },
    files: [],
    survivors: [],
    passed: true,
    failures: [],
  };
}

function runMutation({ repoRoot, outputDir, config, options }) {
  const adapter = config.mutation;
  validateMutationAdapter(adapter);
  const thresholds = mutationThresholds(config);
  if (!options.changedSince && adapter.alwaysRun !== true) {
    return skippedMutation(adapter.format, null, 'changed-since required', thresholds);
  }
  const changedFiles = changedSourceFiles(repoRoot, adapter, options.changedSince);
  if (!changedFiles.length) {
    return skippedMutation(adapter.format, options.changedSince, 'no changed files', thresholds);
  }
  const quotedFiles = changedFiles.map(shellQuote).join(' ');
  const mutatePatterns = shellQuote(changedFiles.join(','));
  const changedDiff = adapter.format === 'cargo-mutants-outcomes'
    ? writeChangedDiff(repoRoot, outputDir, adapter, options.changedSince, changedFiles)
    : '';
  if (options.runTools) {
    runAdapter(repoRoot, outputDir, adapter, 'mutation', {
      replacements: {
        changedFiles: quotedFiles,
        mutatePatterns,
        changedDiff: shellQuote(changedDiff),
      },
      env: {
        QUALITY_CHANGED_FILES: quotedFiles,
        QUALITY_MUTATE_PATTERNS: changedFiles.join(','),
        QUALITY_CHANGED_SINCE: options.changedSince || '',
        QUALITY_CHANGED_DIFF: changedDiff,
      },
    });
  }
  const mutationJson = readJson(configuredPath(repoRoot, outputDir, adapter.output), 'mutation output');
  const parsed = adapter.format === 'stryker-json'
    ? parseStrykerMutation(mutationJson, repoRoot)
    : parseCargoMutantsOutcomes(mutationJson, repoRoot);
  return buildMutationReport({
    parsed,
    format: adapter.format,
    changedSince: options.changedSince,
    changedFiles,
    repoRoot,
    ...thresholds,
  });
}

function main(argv) {
  const options = parseArgs(argv);
  const repoRoot = resolve(options.repo);
  const configPath = resolveFromRepo(repoRoot, options.config || '.quality-gates.json');
  const config = selectConfigSection(readJson(configPath, 'config'), options.section);
  const outputDir = resolveFromRepo(repoRoot, config.outputDir || '.quality');
  mkdirSync(outputDir, { recursive: true });
  if (options.command === 'record-escape') {
    appendFileSync(join(outputDir, 'escaped-defects.jsonl'), `${JSON.stringify({
      pr: options.pr,
      sha: options.sha,
      summary: options.summary,
      recordedAt: new Date().toISOString(),
    })}\n`);
    return 0;
  }
  let report;
  if (options.mutationOnly) {
    if (!config.mutation) throw usageError('--mutation-only requires config.mutation');
    report = {
      repo: config.repo || basename(repoRoot),
      sha: gitSha(repoRoot),
      generatedAt: new Date().toISOString(),
      mutation: runMutation({ repoRoot, outputDir, config, options }),
    };
  } else {
    validateAdapter(config.coverage, COVERAGE_FORMATS, 'coverage');
    validateAdapter(config.complexity, COMPLEXITY_FORMATS, 'complexity');
    assertRustMetricsDoesNotOverlapCoverage(repoRoot, outputDir, config);
    if (options.runTools) {
      runAdapter(repoRoot, outputDir, config.coverage, 'coverage');
      runAdapter(repoRoot, outputDir, config.complexity, 'complexity');
    }
    const complexity = parseComplexityAdapter(repoRoot, outputDir, config.complexity);
    const coverageJson = readJson(configuredPath(repoRoot, outputDir, config.coverage.output), 'coverage output');
    if (config.coverage.format === 'llvm-cov-json' && coverageJson?.type !== 'llvm.coverage.json.export') {
      throw usageError('coverage output is not llvm.coverage.json.export');
    }
    const coverage = config.coverage.format === 'llvm-cov-json'
      ? parseLlvmCovCoverage(coverageJson, repoRoot)
      : parseIstanbulCoverage(coverageJson, repoRoot);
    const joined = joinFunctionMetrics(complexity, coverage);
    report = buildQualityReport({
      repo: config.repo || basename(repoRoot),
      sha: gitSha(repoRoot),
      generatedAt: new Date().toISOString(),
      functions: joined.functions,
      eslintOnly: joined.eslintOnly,
      crapFail: Number(config.thresholds?.crapFail ?? 30),
    });
    if (config.dry) {
      validateDryAdapter(config.dry);
      if (options.runTools) {
        runAdapter(repoRoot, outputDir, config.dry, 'dry');
      }
      const dry = parseJscpdJson(
        readJson(configuredPath(repoRoot, outputDir, config.dry.output), 'dry output'),
        repoRoot,
      );
      try {
        dry.duplicatedLinesPct = validateDuplicatedLinesPct(
          dry.duplicatedLinesPct,
          'dry output duplicatedLinesPct',
        );
      } catch (error) {
        throw usageError(error.message);
      }
      report.dry = dry;
    }
  }
  report.totals = { ...report.totals, escapedDefects: escapedDefectTotals(outputDir, report.generatedAt) };
  writeFileSync(join(outputDir, 'quality-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    if (!options.mutationOnly) process.stdout.write(formatQualityMarkdown(report, options.top));
    if (report.mutation) process.stdout.write(formatMutationMarkdown(report, 25));
  }
  const baselinePath = resolveFromRepo(repoRoot, options.baseline || config.baseline);
  if (options.updateBaseline) {
    if (options.mutationOnly) throw usageError('--mutation-only cannot update the CRAP baseline');
    if (!baselinePath) throw usageError('--update-baseline requires --baseline or config.baseline');
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify(buildRatchetBaseline(report), null, 2)}\n`);
    return 0;
  }
  let crapPassed = true;
  if (!options.mutationOnly && baselinePath) {
    const baseline = readJson(baselinePath, 'baseline');
    let allowed;
    try {
      allowed = validateRatchetBaseline(baseline);
    } catch (error) {
      throw usageError(error.message);
    }
    if (allowed.crapFail !== report.totals.crapFail) {
      throw usageError(`baseline crapFail ${allowed.crapFail} does not match configured ${report.totals.crapFail}`);
    }
    const comparison = compareQualityRatchet(report, baseline);
    for (const regression of comparison.regressions) {
      console.error(`${regression.metric}: ${regression.current} > baseline ${regression.baseline}`);
    }
    crapPassed = comparison.passed;
  } else if (!options.mutationOnly) {
    crapPassed = report.totals.crapAboveFail === 0;
  }
  return crapPassed && (report.mutation?.passed ?? true) ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`repo-quality-check: ${error.message || error}`);
  process.exitCode = error.exitCode || 2;
}
