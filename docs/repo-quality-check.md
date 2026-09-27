# Repository quality check

`scripts/repo-quality-check.mjs` combines configured coverage, complexity, duplication, and changed-file mutation adapters into a normalized report. It is deterministic and makes no LLM calls.

## Run the check

From a configured repository:

```sh
node /path/to/dueno-fleet/scripts/repo-quality-check.mjs --repo .
```

The repository's npm script should normally wrap that command. For dueno-fleet:

```sh
npm run quality:crap
npm run quality:mutants -- --changed-since origin/main
```

`npm test` and `npm run check` do **not** run this gate. Coverage collection re-executes the full suite under `c8` (~90s+), so `quality:crap` is a separate command for local/CI/fleet jobs. Do not fold it into the default test script.

The CRAP command runs the coverage, complexity, and optional dry adapters. Mutation runs only through `--mutation-only` (the `quality:mutants` wrapper) and requires `--changed-since <git-ref>` unless `mutation.alwaysRun` is true. Both write `<outputDir>/quality-report.json` and retain the gate exit code in `--json` mode. Mutation output includes per-file metrics, changed-file totals, and a Markdown survivor table capped at 25 rows. When a dry adapter is configured, the report includes `{duplicatedLinesPct, clones[]}`.

Changed files are the union of `git diff --name-only <ref>...HEAD`, tracked uncommitted changes, and untracked files, filtered through `mutation.sourceGlobs`. Deleted files are omitted because they cannot be mutated. The command receives ordered files through shell-quoted `{changedFiles}` / `QUALITY_CHANGED_FILES`, and a single comma-separated mutate list through `{mutatePatterns}` / `QUALITY_MUTATE_PATTERNS` (use this for Stryker `--mutate`). Cargo adapters also receive a generated `<outputDir>/changes.diff` through `{changedDiff}` and `QUALITY_CHANGED_DIFF`; the patch includes committed, tracked uncommitted, and untracked source changes.

Without `--changed-since`, mutation is reported as `skipped: changed-since required` and exits 0. A repository may explicitly opt into an unscoped run with `mutation.alwaysRun: true`. If the diff contains no source files, mutation is reported as `skipped: no changed files` and exits 0.

Use `--no-run` to rebuild the report and apply the gate from existing adapter outputs. This is useful while tuning configuration, but normal gate runs should execute the tools so stale data cannot pass.

## Record an escaped defect

Record an escaped defect when a bug is found after merge in a file that the repository quality gate passed for that merged change. Record it once against the merged pull request and commit:

```sh
node /path/to/dueno-fleet/scripts/repo-quality-check.mjs record-escape \
  --repo /path/to/repository \
  --pr 191 \
  --sha abc123 \
  --summary "checkout rejected valid carts"
```

The command appends one JSON object to `<outputDir>/escaped-defects.jsonl`, where `outputDir` comes from `.quality-gates.json` and defaults to `.quality`. Each record contains the positive integer `pr`, trimmed non-empty `sha` and `summary` strings, and an ISO-8601 `recordedAt` timestamp. The ledger is not versioned by default, so operators who want history across clean clones or CI runs must retain the configured output directory.

CRAP and mutation reports include `totals.escapedDefects: { count, last30Days }`. Blank ledger lines are ignored; malformed JSON or an invalid `recordedAt` fails the report closed with exit 2. Recording is measurement-only: it does not run adapters, change thresholds or baselines, or alter whether the quality gate passes.

## Configuration

The default configuration path is `<repo>/.quality-gates.json`. Use `--config <file>` to select another file. Relative paths are resolved from `--repo`.

```json
{
  "repo": "example-repo",
  "outputDir": ".quality/repo-quality",
  "coverage": {
    "command": "npm run test:coverage",
    "format": "istanbul-json",
    "output": "coverage/coverage-final.json"
  },
  "complexity": {
    "command": "npx --no-install eslint --format json --output-file {outputDir}/eslint.json src",
    "format": "eslint-json",
    "output": "{outputDir}/eslint.json"
  },
  "dry": {
    "command": "npx --no-install jscpd --reporters json --output {outputDir}/jscpd src",
    "format": "jscpd-json",
    "output": "{outputDir}/jscpd/jscpd-report.json"
  },
  "mutation": {
    "command": "npx --no-install stryker run --mutate {mutatePatterns}",
    "format": "stryker-json",
    "output": "{outputDir}/mutation.json",
    "sourceGlobs": ["src/**/*.mjs"]
  },
  "thresholds": {
    "crapFail": 30,
    "mutationScoreMinChanged": 0.8,
    "survivorsMaxChanged": null
  },
  "baseline": "config/quality/crap-baseline.json"
}
```

Fields:

- `repo`: report label. Defaults to the repository directory name.
- `outputDir`: generated-artifact directory. Defaults to `.quality`.
- `coverage.command`: shell command run from the repository root.
- `coverage.format`: `istanbul-json` or `llvm-cov-json`.
- `coverage.output`: Istanbul `coverage-final.json` path, or `cargo llvm-cov --json` export path.
- `complexity.command`: shell command run from the repository root. ESLint must enable `complexity` with maximum 0 so every function is reported.
- `complexity.format`: `eslint-json` or `rust-code-analysis-json`.
- `complexity.output`: ESLint JSON file path, or a directory of `rust-code-analysis-cli --metrics -O json` per-file JSON.
- `dry.command`: duplication command. jscpd writes `jscpd-report.json` under `--output`.
- `dry.format`: `jscpd-json`.
- `dry.output`: jscpd JSON file path (`{outputDir}/jscpd/jscpd-report.json`).
- `mutation.command`: mutation command. Use `{mutatePatterns}` for Stryker `--mutate`, `{changedFiles}` for space-separated quoted paths, or `{changedDiff}` with cargo-mutants `--in-diff`.
- `mutation.format`: `stryker-json` or `cargo-mutants-outcomes`.
- `mutation.output`: Stryker `mutation.json` or cargo-mutants `outcomes.json` path.
- `mutation.sourceGlobs`: Git glob pathspecs for production source. Explicit per-repo globs keep tests and generated files out of the changed set.
- `mutation.alwaysRun`: optional explicit opt-in to mutation without `--changed-since`; defaults to `false`.
- `thresholds.crapFail`: hard CRAP band used by the report and ratchet. Defaults to 30.
- `thresholds.mutationScoreMinChanged`: minimum aggregate score on changed files. Defaults to `0.8`.
- `thresholds.survivorsMaxChanged`: optional maximum changed-file survivors. Defaults to `null` (not enforced); set `0` for agent-hardened mode.
- `baseline`: optional committed ratchet file.

`{outputDir}` in command strings is replaced with `"$QUALITY_OUTPUT_DIR"` (so `{outputDir}/cov` becomes `"$QUALITY_OUTPUT_DIR"/cov`). The CLI sets `QUALITY_OUTPUT_DIR` to the absolute output directory. In `coverage.output` / `complexity.output` / `dry.output` / `mutation.output`, `{outputDir}` expands to that absolute path. Commands are trusted repository configuration and run through `/bin/sh`. The CLI removes each declared output before running its adapter. For `rust-code-analysis-json`, that output is a directory: it is deleted and recreated empty so the tool can write per-file JSON. For `jscpd-json`, the parent of the declared JSON file is created so jscpd can write `jscpd-report.json`. ESLint exit 1 is accepted only when that invocation produced its JSON file, because `complexity: max 0` intentionally reports lint errors. jscpd may exit non-zero when clones exist (threshold defaults to 0); that is accepted when the JSON file exists so the duplication ratchet owns pass/fail.

The report is coverage-driven. Coverage functions without a same-file, same-start-line complexity match have `cc` and `crap` set to `null` (`totals.unmatchedComplexity`). Functions present only in the complexity adapter are `totals.eslintOnly` and are not scored. The join chooses the nearest start column and consumes every complexity result at most once.

Mutation reports are filtered back to `changedFiles` after normalizing `\` and `./` prefixes (and repo-relative absolute paths), which matters because Stryker incremental reports can retain out-of-scope historical files. If the adapter JSON contains files but none match the changed set, the gate fails instead of treating an empty overlap as a 100% score. Each file contains `killed`, `survived`, `timeout`, `noCoverage`, `ignored`, and `score`. The score is `(killed + timeout) / (killed + survived + timeout + noCoverage)`; ignored/unviable mutants are excluded. Cargo `CaughtMutant` maps to killed, `MissedMutant` to survived, and `Unviable` to ignored.

Cadre uses Stryker's TAP runner. TAP coverage is attributed per test file rather than per individual test, static mutants are ignored, and the suite has generous timeout settings for slow session tests. The committed Stryker config has `mutate: []`; supply files only through `quality:mutants` so a bare `npx stryker run` cannot start a full-tree run.

Statement ranges use each function's Istanbul body (`fn.loc`). Nested functions therefore also count toward the parent body; CRAP for the parent is mixed with children. Phase 1 does not attribute statements to the innermost function only.

## Rust adapters

Rust repositories use `llvm-cov-json` coverage and `rust-code-analysis-json` complexity. Join is the same file + start-line seam as ESLint/Istanbul. Do not use `--summary-only` on llvm-cov; the adapter needs `data[].functions[]`.

```json
{
  "coverage": {
    "command": "cargo llvm-cov --json --output-path {outputDir}/llvm-cov.json",
    "format": "llvm-cov-json",
    "output": "{outputDir}/llvm-cov.json"
  },
  "complexity": {
    "command": "rust-code-analysis-cli -m -O json -o {outputDir}/rust-metrics -p .",
    "format": "rust-code-analysis-json",
    "output": "{outputDir}/rust-metrics"
  }
}
```

`coverage.format: llvm-cov-json` reads `cargo llvm-cov --json` (`llvm.coverage.json.export`). The CLI rejects documents whose `type` is not that export id. Each function uses `count`, `filenames`, `name`, and `regions` tuples `[lineStart, columnStart, lineEnd, columnEnd, executionCount, fileId, expandedFileId, kind]`. Only code regions (`kind` 0) in the first code region's file (`filenames[fileId]`) are counted as statements. Start line/column is the earliest same-file code region (not array order). LLVM columns are 1-based and stored 0-based. `called` is `count > 0`.

`complexity.format: rust-code-analysis-json` reads `rust-code-analysis-cli --metrics -O json`. That CLI writes **one JSON file per source path** under `-o <dir>`, not one aggregate document. `complexity.output` must be that directory, and it must be a dedicated child of `outputDir` (not `.`, the repository root, `outputDir` itself, or any path outside `outputDir`). `outputDir` must itself be a dedicated child of the repository. The metrics directory must not overlap the coverage output path (exit 2 before any recursive delete). Before the adapter runs, the CLI deletes and recreates the metrics directory so stale JSON cannot pass; paths that fail the descendant or overlap checks are rejected with exit 2 and are not removed. `--no-run` still enforces those path checks. Source paths prefer the JSON root `name` when it normalizes inside the repository; otherwise they are derived by stripping the output directory and a trailing `.json` (`src/cart.rs.json` → `src/cart.rs`). Use a repo-relative input path such as `-p .`. Directory entries that are symlinks are ignored when scanning metrics JSON. Direct cyclomatic values below 1 are dropped.

Each file body is a `FuncSpace`: `{name, start_line, end_line, kind, spaces, metrics}`. The root `name` is the original source path; unit name is not a function. The adapter walks `spaces` recursively and emits `kind: "function"` records, including methods under `impl` and nested closures. Direct cyclomatic complexity is `metrics.cyclomatic.sum` minus the sums of **direct child spaces**; the serialized parent sum includes nested functions. Column is 0 because this format has no column. Same-line nested functions are therefore not column-disambiguated. An empty metrics directory or a missing directory is malformed output (exit 2), not a zero-complexity pass.

ESLint still uses a single JSON file; its file-output cleanup is unchanged. Istanbul/ESLint phase-1 behavior is unchanged.

## Ratchet and baseline updates

Without a baseline, any function above `crapFail` fails the gate. With a baseline, these values must stay at or below the committed values:

- count of functions with CRAP above `crapFail` (exact integer);
- sum of CRAP for those functions (regression if current > baseline + 0.01, to absorb rounding);
- when a dry adapter ran, `duplicatedLinesPct` (regression if current > baseline + 0.1).

Missing or non-numeric baseline metrics fail closed (exit 2), not pass. If dry is configured, a missing `duplicatedLinesPct` on the baseline also fails closed. Coverage-coupled scores can move slightly when tests are timing-sensitive; re-run `quality:crap` once before treating a sum bump as real debt, and do not refresh the baseline to hide an unexplained regression.

Create or intentionally refresh the configured baseline after reviewing the report:

```sh
npm run quality:crap:update
```

For a repository without a wrapper script:

```sh
node /path/to/dueno-fleet/scripts/repo-quality-check.mjs \
  --repo . \
  --baseline config/quality/crap-baseline.json \
  --update-baseline
```

`--update-baseline` runs the adapters unless combined with `--no-run`, writes the current compact snapshot, and exits 0. Commit the baseline with the repository configuration. Do not update it merely to hide an unexplained regression.

## Exit codes

- `0`: absolute threshold passed, ratchet passed, or an explicit baseline update completed.
- `1`: CRAP threshold/ratchet failed, duplication ratchet failed, or a changed-file mutation threshold failed.
- `2`: invalid arguments, invalid configuration, missing/malformed output, adapter failure, or another tool error. Cargo-mutants exits 2 for missed mutants and 3 for timeouts; when `outcomes.json` exists those are parsed as measurement results rather than treated as tool errors.
