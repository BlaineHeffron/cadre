import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { discoverLaunchSkills } from './launch-skills.mjs';

export const REPO_QUALITY_TASK_ID = 'sched_repo_quality_watch';
export const DEFAULT_REPO_QUALITY_INTERVAL_SECONDS = 604800;
export const DEFAULT_REPO_QUALITY_MAX_FANOUT = 2;
export const DEFAULT_REPO_QUALITY_TOP_N = 10;

export function buildRepoQualityTaskPrompt() {
  return [
    'Scheduled repository quality watch.',
    'The scheduler measures CRAP and mutation in isolated worktrees and fans out at most maxFanout cleaner/hardener agents.',
    'This task prompt is bookkeeping only; fix agents receive a per-repo brief.',
  ].join('\n');
}

export function normalizeRepoQualitySection(section = 'default') {
  const value = String(section || '').trim();
  return !value || value.toLowerCase() === 'default' ? 'default' : value;
}

export function repoQualityReportSlug(repoPath = '', section = 'default') {
  const resolved = resolve(String(repoPath || '').trim() || '.');
  const normalizedSection = normalizeRepoQualitySection(section);
  const identity = normalizedSection === 'default'
    ? resolved
    : `${resolved}\0${normalizedSection}`;
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 12);
  const base = basename(resolved).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'repo';
  if (normalizedSection === 'default') return `${base}-${digest}`;
  const sectionSlug = normalizedSection
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
  return `${base}-${sectionSlug}-${digest}`;
}

function metricCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function metricDelta(previous, current) {
  if (previous == null) {
    return { previous: null, current, delta: null };
  }
  return { previous, current, delta: current - previous };
}

function survivorCount(report) {
  return metricCount(report?.mutation?.totals?.survived ?? report?.mutation?.survivors?.length);
}

function optionalCount(hasPrevious, value) {
  return hasPrevious ? metricCount(value) : null;
}

export function computeQualityReportDelta(current = {}, previous = null) {
  const hasPrevious = previous != null;
  return {
    previousSha: previous?.sha ?? null,
    currentSha: current?.sha ?? null,
    crapAboveFail: metricDelta(optionalCount(hasPrevious, previous?.totals?.crapAboveFail), metricCount(current?.totals?.crapAboveFail)),
    crapSumAboveFail: metricDelta(optionalCount(hasPrevious, previous?.totals?.crapSumAboveFail), metricCount(current?.totals?.crapSumAboveFail)),
    survivors: metricDelta(optionalCount(hasPrevious, survivorCount(previous)), survivorCount(current)),
  };
}

export function isRepoQualityReport(report) {
  const sha = String(report?.sha || '').trim();
  const totals = report?.totals;
  return Boolean(
    sha
    && totals
    && Number.isFinite(Number(totals.crapFail))
    && Number.isFinite(Number(totals.crapAboveFail))
    && Number.isFinite(Number(totals.crapSumAboveFail)),
  );
}

function checkFailure(error) {
  return {
    code: 2,
    report: null,
    error: String(error || 'repo_quality_check_failed').trim() || 'repo_quality_check_failed',
  };
}

export function parseRepoQualityCheckOutput({
  code,
  stdout = '',
  stderr = '',
  errorMessage = '',
} = {}) {
  let report = null;
  try {
    report = JSON.parse(String(stdout || ''));
  } catch {
    report = null;
  }
  return normalizeRepoQualityCheckResult({
    code,
    report,
    error: errorMessage || stderr || 'repo_quality_check_failed',
  });
}

export function normalizeRepoQualityCheckResult(result = {}) {
  const code = Number(result.code);
  if (!Number.isInteger(code) || (code !== 0 && code !== 1) || !isRepoQualityReport(result.report)) {
    return checkFailure(result.error);
  }
  return {
    code,
    report: result.report,
    error: null,
  };
}

export function rankRepoQualityFixCandidates(candidates = []) {
  return [...candidates].sort((left, right) => {
    const failDelta = metricCount(right.report?.totals?.crapAboveFail)
      - metricCount(left.report?.totals?.crapAboveFail);
    if (failDelta) return failDelta;
    return metricCount(right.report?.totals?.crapSumAboveFail)
      - metricCount(left.report?.totals?.crapSumAboveFail);
  });
}

export function shouldDispatchRepoQualityFix(result = {}, previousReport = null) {
  const normalized = normalizeRepoQualityCheckResult(result);
  const code = normalized.code;
  if (code === 2) return false;
  const report = normalized.report;
  if (!report?.totals) return false;
  if (code === 1) return true;
  if (metricCount(report.totals.crapAboveFail) > 0) return true;
  if (previousReport?.totals) {
    try {
      return !compareQualityRatchet(report, buildRatchetBaseline(previousReport)).passed;
    } catch {
      return false;
    }
  }
  return false;
}

export async function writeRepoQualityReportRecord(baseDir, record = {}) {
  const slug = record.slug || repoQualityReportSlug(record.repoPath, record.section);
  const dir = join(baseDir, slug);
  await mkdir(dir, { recursive: true });
  const name = record.sha || (Number(record.code) === 2 ? 'error' : 'report');
  const payload = `${JSON.stringify({ ...record, slug }, null, 2)}\n`;
  await writeFile(join(dir, `${name}.json`), payload);
  if (Number(record.code) !== 2 && isRepoQualityReport(record.report)) {
    await writeFile(join(dir, 'latest.json'), payload);
  }
}

export async function readPreviousRepoQualityReport(baseDir, repoPath, section = 'default') {
  try {
    const raw = await readFile(join(baseDir, repoQualityReportSlug(repoPath, section), 'latest.json'), 'utf8');
    const record = JSON.parse(raw);
    return record.report || null;
  } catch {
    return null;
  }
}

function topNLimit(topN) {
  const number = Number(topN);
  return Number.isInteger(number) && number > 0 ? number : DEFAULT_REPO_QUALITY_TOP_N;
}

function offenderLines(report, limit) {
  return (Array.isArray(report.functions) ? report.functions : [])
    .filter((fn) => Number.isFinite(fn?.crap))
    .slice(0, limit)
    .map((fn) => `- \`${fn.file}:${fn.line}\` ${fn.name || '(anonymous)'} CRAP ${fn.crap}`);
}

function survivorLines(report) {
  return (Array.isArray(report.mutation?.survivors) ? report.mutation.survivors : [])
    .map((item) => `- \`${item.file}:${item.line}\` ${item.mutator || 'mutant'} -> ${item.replacement ?? ''}`);
}

function deltaLines(delta) {
  if (!delta) return [];
  return [
    `Delta vs previous ${delta.previousSha || 'none'}:`,
    `- crapAboveFail ${delta.crapAboveFail?.previous ?? 'n/a'} -> ${delta.crapAboveFail?.current ?? 'n/a'}`,
    `- crapSumAboveFail ${delta.crapSumAboveFail?.previous ?? 'n/a'} -> ${delta.crapSumAboveFail?.current ?? 'n/a'}`,
    `- survivors ${delta.survivors?.previous ?? 'n/a'} -> ${delta.survivors?.current ?? 'n/a'}`,
    '',
  ];
}

export function buildRepoQualityFixPrompt({
  repoName = '',
  repoPath = '',
  section = 'default',
  worktreePath = '',
  topN = DEFAULT_REPO_QUALITY_TOP_N,
  report = {},
  delta = null,
  sourceConfig,
} = {}) {
  const limit = topNLimit(topN);
  const hasQualityGateSkill = discoverLaunchSkills({ sourceConfig }).some((skill) => skill.id === 'quality-gate');
  return [
    `Reduce repository quality debt in ${repoName || repoPath || report.repo || 'the repository'}.`,
    `Repository path: ${repoPath || '.'}`,
    `Section: ${normalizeRepoQualitySection(section)}`,
    `Work only in this worktree: ${worktreePath || '.'}`,
    'Do not edit any other checkout, especially the live deploy tree.',
    '',
    `SHA: ${report.sha || 'unknown'}`,
    `CRAP > ${report.totals?.crapFail ?? 30}: ${report.totals?.crapAboveFail ?? 0}`,
    '',
    ...deltaLines(delta),
    `Top ${limit} CRAP offenders:`,
    offenderLines(report, limit).join('\n') || '- none',
    '',
    'Survivors:',
    survivorLines(report).join('\n') || '- none',
    '',
    hasQualityGateSkill
      ? '{{skill:quality-gate}}'
      : 'Exercise changed behavior with real tests. Never weaken a test or report an unrun check as passed.',
    '',
    'Open a PR. Do not merge.',
  ].join('\n');
}

function normalizeFile(filePath, repoRoot) {
  const absolute = resolve(filePath);
  const fromRoot = relative(resolve(repoRoot), absolute);
  return fromRoot && !fromRoot.startsWith('..') && !isAbsolute(fromRoot)
    ? fromRoot
    : absolute;
}

function complexityName(message) {
  const subject = String(message).split(' has a complexity of ')[0];
  const named = /^(?:async )?(?:function|method) ['"](.+)['"]$/i.exec(subject);
  return named?.[1] || subject;
}

export function parseEslintComplexity(eslintJson, repoRoot) {
  const functions = [];
  for (const result of Array.isArray(eslintJson) ? eslintJson : []) {
    for (const message of Array.isArray(result?.messages) ? result.messages : []) {
      if (message.ruleId !== 'complexity') continue;
      const cc = Number(/complexity of (\d+)/.exec(String(message.message))?.[1]);
      if (!Number.isFinite(cc)) continue;
      functions.push({
        file: normalizeFile(result.filePath, repoRoot),
        line: Number(message.line),
        column: Math.max(0, Number(message.column || 1) - 1),
        cc,
        name: complexityName(message.message),
      });
    }
  }
  return functions;
}

function positionAtOrAfter(position, start) {
  return position.line > start.line
    || (position.line === start.line && position.column >= start.column);
}

function positionAtOrBefore(position, end) {
  return position.line < end.line
    || (position.line === end.line && position.column <= end.column);
}

export function parseIstanbulCoverage(coverageJson, repoRoot) {
  const functions = [];
  for (const [filePath, fileCoverage] of Object.entries(coverageJson || {})) {
    const statements = Object.entries(fileCoverage?.statementMap || {}).map(([id, location]) => ({
      location,
      covered: Number(fileCoverage?.s?.[id] || 0) > 0,
    }));
    for (const [id, fn] of Object.entries(fileCoverage?.fnMap || {})) {
      const body = fn.loc;
      const inside = statements.filter(({ location }) => (
        positionAtOrAfter(location.start, body.start)
        && positionAtOrBefore(location.end, body.end)
      ));
      functions.push({
        file: normalizeFile(filePath, repoRoot),
        line: Number(fn.decl.start.line),
        column: Number(fn.decl.start.column),
        endLine: Number(body.end.line),
        name: fn.name,
        statementsTotal: inside.length,
        statementsCovered: inside.filter(({ covered }) => covered).length,
        called: Number(fileCoverage?.f?.[id] || 0) > 0,
      });
    }
  }
  return functions;
}

const LLVM_CODE_REGION = 0;

export function parseLlvmCovCoverage(coverageJson, repoRoot) {
  const functions = [];
  for (const exportData of Array.isArray(coverageJson?.data) ? coverageJson.data : []) {
    for (const fn of Array.isArray(exportData?.functions) ? exportData.functions : []) {
      const filenames = Array.isArray(fn?.filenames) ? fn.filenames : [];
      const codeRegions = (Array.isArray(fn?.regions) ? fn.regions : []).filter((region) => (
        Array.isArray(region)
        && region.length >= 8
        && Number(region[7]) === LLVM_CODE_REGION
      ));
      if (!codeRegions.length) continue;
      const fileId = Number(codeRegions[0][5]);
      const filePath = filenames[fileId];
      if (!filePath) continue;
      const sameFile = codeRegions.filter((region) => Number(region[5]) === fileId);
      const start = [...sameFile].sort((left, right) => {
        const lineDelta = Number(left[0]) - Number(right[0]);
        return lineDelta !== 0 ? lineDelta : Number(left[1]) - Number(right[1]);
      })[0];
      functions.push({
        file: normalizeFile(filePath, repoRoot),
        line: Number(start[0]),
        column: Math.max(0, Number(start[1] || 1) - 1),
        endLine: Math.max(...sameFile.map((region) => Number(region[2]))),
        name: String(fn.name || ''),
        statementsTotal: sameFile.length,
        statementsCovered: sameFile.filter((region) => Number(region[4]) > 0).length,
        called: Number(fn.count || 0) > 0,
      });
    }
  }
  return functions;
}

function rustCyclomaticSum(space) {
  return Number(space?.metrics?.cyclomatic?.sum);
}

function collectRustFunctions(space, file, functions) {
  if (!space || typeof space !== 'object') return;
  const children = Array.isArray(space.spaces) ? space.spaces : [];
  if (space.kind === 'function') {
    const sum = rustCyclomaticSum(space);
    const childSum = children.reduce((total, child) => {
      const value = rustCyclomaticSum(child);
      return total + (Number.isFinite(value) ? value : 0);
    }, 0);
    const cc = sum - childSum;
    if (Number.isFinite(cc) && cc >= 1) {
      functions.push({
        file,
        line: Number(space.start_line),
        column: 0,
        cc,
        name: String(space.name || ''),
      });
    }
  }
  for (const child of children) collectRustFunctions(child, file, functions);
}

export function parseRustCodeAnalysisComplexity(funcSpace, repoRoot, sourceFile) {
  const functions = [];
  const fromName = typeof funcSpace?.name === 'string' && funcSpace.name
    ? normalizeFile(funcSpace.name, repoRoot)
    : '';
  const fromOutput = normalizeFile(resolve(repoRoot, sourceFile), repoRoot);
  const file = fromName && !isAbsolute(fromName) ? fromName : fromOutput;
  collectRustFunctions(funcSpace, file, functions);
  return functions;
}

export function joinFunctionMetrics(complexityFunctions, coverageFunctions) {
  const complexity = (Array.isArray(complexityFunctions) ? complexityFunctions : [])
    .map((fn, index) => ({ ...fn, index }));
  const used = new Set();
  const functions = (Array.isArray(coverageFunctions) ? coverageFunctions : []).map((fn) => {
    const match = complexity
      .filter((candidate) => (
        !used.has(candidate.index)
        && candidate.file === fn.file
        && candidate.line === fn.line
      ))
      .sort((left, right) => (
        Math.abs(left.column - fn.column) - Math.abs(right.column - fn.column)
      ))[0];
    if (match) used.add(match.index);
    const coverage = fn.statementsTotal > 0
      ? fn.statementsCovered / fn.statementsTotal
      : (fn.called ? 1 : 0);
    const crap = match
      ? match.cc ** 2 * (1 - coverage) ** 3 + match.cc
      : null;
    return {
      ...fn,
      name: match?.name || fn.name,
      cc: match?.cc ?? null,
      coverage,
      crap,
    };
  });
  const eslintOnly = complexity
    .filter((fn) => !used.has(fn.index))
    .map(({ index, ...fn }) => fn);
  return { functions, eslintOnly };
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function mutationScore({ killed, survived, timeout, noCoverage }) {
  const tested = killed + survived + timeout + noCoverage;
  return tested ? round((killed + timeout) / tested) : 1;
}

const STRYKER_STATUS = new Map([
  ['Killed', 'killed'],
  ['Survived', 'survived'],
  ['Timeout', 'timeout'],
  ['NoCoverage', 'noCoverage'],
]);

export function normalizeMutationPath(filePath, repoRoot = '') {
  let value = String(filePath || '').replaceAll('\\', '/');
  if (repoRoot) {
    const fromRoot = relative(resolve(repoRoot), resolve(repoRoot, value)).replaceAll('\\', '/');
    if (fromRoot && !fromRoot.startsWith('..') && !isAbsolute(fromRoot)) value = fromRoot;
  }
  if (value.startsWith('./')) value = value.slice(2);
  return value;
}

export function parseStrykerMutation(mutationJson, repoRoot = '') {
  const files = [];
  const mutants = [];
  for (const [rawFile, result] of Object.entries(mutationJson?.files || {}).sort(([left], [right]) => left.localeCompare(right))) {
    const file = normalizeMutationPath(rawFile, repoRoot);
    const metrics = { file, killed: 0, survived: 0, timeout: 0, noCoverage: 0, ignored: 0 };
    for (const mutant of Array.isArray(result?.mutants) ? result.mutants : []) {
      const status = STRYKER_STATUS.get(mutant?.status) || 'ignored';
      metrics[status] += 1;
      mutants.push({
        file,
        line: Number(mutant?.location?.start?.line || 0),
        mutator: String(mutant?.mutatorName || 'unknown'),
        replacement: String(mutant?.replacement ?? ''),
        status,
      });
    }
    files.push({ ...metrics, score: mutationScore(metrics) });
  }
  return { files, mutants };
}

const CARGO_MUTANTS_STATUS = new Map([
  ['CaughtMutant', 'killed'],
  ['MissedMutant', 'survived'],
  ['Timeout', 'timeout'],
]);

function cloneFile(name, repoRoot) {
  const raw = String(name || '');
  if (!raw) return raw;
  return normalizeFile(isAbsolute(raw) ? raw : resolve(repoRoot || '.', raw), repoRoot);
}

export function parseJscpdJson(jscpdJson, repoRoot = '') {
  const duplicatedLinesPct = Number(jscpdJson?.statistics?.total?.percentage);
  const clones = [];
  for (const duplicate of Array.isArray(jscpdJson?.duplicates) ? jscpdJson.duplicates : []) {
    clones.push({
      fileA: cloneFile(duplicate?.firstFile?.name, repoRoot),
      startA: Number(duplicate?.firstFile?.start),
      endA: Number(duplicate?.firstFile?.end),
      fileB: cloneFile(duplicate?.secondFile?.name, repoRoot),
      startB: Number(duplicate?.secondFile?.start),
      endB: Number(duplicate?.secondFile?.end),
      lines: Number(duplicate?.lines),
    });
  }
  return { duplicatedLinesPct, clones };
}

export function parseCargoMutantsOutcomes(outcomesJson, repoRoot = '') {
  const byFile = new Map();
  const mutants = [];
  for (const outcome of Array.isArray(outcomesJson?.outcomes) ? outcomesJson.outcomes : []) {
    const mutant = outcome?.scenario?.Mutant;
    if (!mutant?.file) continue;
    const file = normalizeMutationPath(mutant.file, repoRoot);
    const status = CARGO_MUTANTS_STATUS.get(outcome?.summary) || 'ignored';
    const metrics = byFile.get(file) || {
      file, killed: 0, survived: 0, timeout: 0, noCoverage: 0, ignored: 0,
    };
    metrics[status] += 1;
    byFile.set(file, metrics);
    mutants.push({
      file,
      line: Number(mutant?.span?.start?.line || 0),
      mutator: String(mutant?.genre || 'unknown'),
      replacement: String(mutant?.replacement ?? ''),
      status,
    });
  }
  const files = [...byFile.values()]
    .sort((left, right) => left.file.localeCompare(right.file))
    .map((metrics) => ({ ...metrics, score: mutationScore(metrics) }));
  return { files, mutants };
}

export function buildMutationReport({
  parsed,
  format,
  changedSince,
  changedFiles = [],
  mutationScoreMinChanged = 0.8,
  survivorsMaxChanged = null,
  repoRoot = '',
}) {
  const changed = new Set(changedFiles.map((file) => normalizeMutationPath(file, repoRoot)));
  const reported = Array.isArray(parsed?.files) ? parsed.files : [];
  const files = reported.filter((file) => changed.has(normalizeMutationPath(file.file, repoRoot)));
  const mutants = (Array.isArray(parsed?.mutants) ? parsed.mutants : [])
    .filter((mutant) => changed.has(normalizeMutationPath(mutant.file, repoRoot)));
  const totals = {
    mutants: files.reduce((sum, file) => (
      sum + file.killed + file.survived + file.timeout + file.noCoverage + file.ignored
    ), 0),
    killed: files.reduce((sum, file) => sum + file.killed, 0),
    survived: files.reduce((sum, file) => sum + file.survived, 0),
    timeout: files.reduce((sum, file) => sum + file.timeout, 0),
    noCoverage: files.reduce((sum, file) => sum + file.noCoverage, 0),
    ignored: files.reduce((sum, file) => sum + file.ignored, 0),
  };
  totals.score = mutationScore(totals);
  const failures = [];
  if (changed.size && reported.length && files.length === 0) {
    failures.push('mutation report files did not match changed files');
  }
  if (totals.score < mutationScoreMinChanged) {
    failures.push(`mutation score ${totals.score} is below ${mutationScoreMinChanged}`);
  }
  if (survivorsMaxChanged !== null && totals.survived > survivorsMaxChanged) {
    failures.push(`survivors ${totals.survived} exceed ${survivorsMaxChanged}`);
  }
  return {
    format,
    changedSince,
    changedFiles: [...changedFiles],
    skipped: false,
    thresholds: { mutationScoreMinChanged, survivorsMaxChanged },
    totals,
    files,
    survivors: mutants
      .filter((mutant) => mutant.status === 'survived')
      .map(({ file, line, mutator, replacement }) => ({ file, line, mutator, replacement })),
    passed: failures.length === 0,
    failures,
  };
}

export function buildQualityReport({
  repo,
  sha,
  generatedAt,
  functions = [],
  eslintOnly = [],
  crapFail = 30,
}) {
  const ordered = [...functions].sort((left, right) => {
    const crapDelta = (right.crap ?? Number.NEGATIVE_INFINITY)
      - (left.crap ?? Number.NEGATIVE_INFINITY);
    if (crapDelta) return crapDelta;
    return left.file.localeCompare(right.file)
      || left.line - right.line
      || left.column - right.column;
  });
  const scored = ordered.filter((fn) => Number.isFinite(fn.crap));
  const aboveFail = scored.filter((fn) => fn.crap > crapFail);
  const statementsTotal = ordered.reduce((sum, fn) => sum + fn.statementsTotal, 0);
  const statementsCovered = ordered.reduce((sum, fn) => sum + fn.statementsCovered, 0);
  return {
    repo,
    sha,
    generatedAt,
    totals: {
      functions: ordered.length,
      scoredFunctions: scored.length,
      unmatchedComplexity: ordered.length - scored.length, // coverage fns with no ESLint CC
      eslintOnly: eslintOnly.length,
      statementsTotal,
      statementsCovered,
      statementCoverage: statementsTotal ? round(statementsCovered / statementsTotal) : 0,
      calledFunctions: ordered.filter((fn) => fn.called).length,
      uncalledFunctions: ordered.filter((fn) => !fn.called).length,
      crapFail,
      crapAboveFail: aboveFail.length,
      crapSumAboveFail: round(aboveFail.reduce((sum, fn) => sum + fn.crap, 0), 2),
      crapAbove6: scored.filter((fn) => fn.crap > 6).length,
    },
    functions: ordered,
  };
}

export function buildRatchetBaseline(report) {
  const baseline = {
    repo: report.repo,
    sha: report.sha,
    generatedAt: report.generatedAt,
    crapFail: report.totals.crapFail,
    crapAboveFail: report.totals.crapAboveFail,
    crapSumAboveFail: report.totals.crapSumAboveFail,
  };
  if (report.dry) {
    baseline.duplicatedLinesPct = report.dry.duplicatedLinesPct;
  }
  return baseline;
}

const SUM_EPSILON = 0.01;
const DUPLICATION_EPSILON = 0.1;

export function validateRatchetBaseline(baseline) {
  const crapFail = Number(baseline?.crapFail);
  const crapAboveFail = Number(baseline?.crapAboveFail);
  const crapSumAboveFail = Number(baseline?.crapSumAboveFail);
  if (!Number.isFinite(crapFail) || crapFail < 0) {
    throw new Error('baseline crapFail must be a finite number >= 0');
  }
  if (!Number.isInteger(crapAboveFail) || crapAboveFail < 0) {
    throw new Error('baseline crapAboveFail must be an integer >= 0');
  }
  if (!Number.isFinite(crapSumAboveFail) || crapSumAboveFail < 0) {
    throw new Error('baseline crapSumAboveFail must be a finite number >= 0');
  }
  return { crapFail, crapAboveFail, crapSumAboveFail };
}

export function validateDuplicatedLinesPct(value, label = 'duplicatedLinesPct') {
  const duplicatedLinesPct = Number(value);
  if (!Number.isFinite(duplicatedLinesPct) || duplicatedLinesPct < 0 || duplicatedLinesPct > 100) {
    throw new Error(`${label} must be a finite number between 0 and 100`);
  }
  return duplicatedLinesPct;
}

export function compareQualityRatchet(report, baseline) {
  const allowed = validateRatchetBaseline(baseline);
  const current = {
    crapAboveFail: report.totals.crapAboveFail,
    crapSumAboveFail: report.totals.crapSumAboveFail,
  };
  const allowedSnapshot = {
    crapAboveFail: allowed.crapAboveFail,
    crapSumAboveFail: allowed.crapSumAboveFail,
  };
  const regressions = [];
  if (current.crapAboveFail > allowed.crapAboveFail) {
    regressions.push({
      metric: 'crapAboveFail',
      baseline: allowed.crapAboveFail,
      current: current.crapAboveFail,
    });
  }
  if (current.crapSumAboveFail > allowed.crapSumAboveFail + SUM_EPSILON) {
    regressions.push({
      metric: 'crapSumAboveFail',
      baseline: allowed.crapSumAboveFail,
      current: current.crapSumAboveFail,
    });
  }
  if (report.dry) {
    const allowedPct = validateDuplicatedLinesPct(baseline?.duplicatedLinesPct, 'baseline duplicatedLinesPct');
    const currentPct = validateDuplicatedLinesPct(report.dry.duplicatedLinesPct, 'duplicatedLinesPct');
    current.duplicatedLinesPct = currentPct;
    allowedSnapshot.duplicatedLinesPct = allowedPct;
    if (currentPct > allowedPct + DUPLICATION_EPSILON) {
      regressions.push({
        metric: 'duplicatedLinesPct',
        baseline: allowedPct,
        current: currentPct,
      });
    }
  }
  return {
    passed: regressions.length === 0,
    current,
    baseline: allowedSnapshot,
    regressions,
  };
}

export function formatQualityMarkdown(report, top = 15) {
  const rows = report.functions
    .filter((fn) => Number.isFinite(fn.crap))
    .slice(0, top)
    .map((fn) => {
      const name = String(fn.name || '(anonymous)').replaceAll('|', '\\|');
      return `| ${fn.crap.toFixed(2)} | ${fn.cc} | ${(fn.coverage * 100).toFixed(1)}% | ${fn.statementsCovered}/${fn.statementsTotal} | \`${fn.file}:${fn.line}\` ${name} |`;
    });
  return [
    `## CRAP report: ${report.repo}`,
    '',
    '| CRAP | CC | Coverage | Statements | Function |',
    '| ---: | ---: | ---: | ---: | --- |',
    ...rows,
    '',
    `Functions: ${report.totals.functions}; CRAP > ${report.totals.crapFail}: ${report.totals.crapAboveFail}; CRAP > 6: ${report.totals.crapAbove6}; statements: ${(report.totals.statementCoverage * 100).toFixed(1)}%.`,
    ...(report.dry
      ? [`Duplication: ${report.dry.duplicatedLinesPct}% (${report.dry.clones.length} clones).`]
      : []),
    '',
  ].join('\n');
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('`', '\\`');
}

export function formatMutationMarkdown(report, limit = 25) {
  const mutation = report.mutation;
  if (!mutation) return '';
  const lines = [`## Mutation report: ${report.repo}`, ''];
  if (mutation.skipped) {
    lines.push(`Skipped: ${mutation.skipped}.`, '');
    return lines.join('\n');
  }
  const totals = mutation.totals;
  lines.push(
    `Mutants: ${totals.mutants}; killed: ${totals.killed}; survived: ${totals.survived}; timeout: ${totals.timeout}; no coverage: ${totals.noCoverage}; ignored: ${totals.ignored}; score: ${(totals.score * 100).toFixed(1)}%.`,
    '',
    '| Survivor | Mutator | Replacement |',
    '| --- | --- | --- |',
  );
  for (const survivor of mutation.survivors.slice(0, limit)) {
    lines.push(`| \`${markdownCell(survivor.file)}:${survivor.line}\` | ${markdownCell(survivor.mutator)} | \`${markdownCell(survivor.replacement)}\` |`);
  }
  lines.push('');
  return lines.join('\n');
}
