# Repository quality watch

Scheduled job `sched_repo_quality_watch`. It measures CRAP (and any JSON mutation data the CLI already printed) on configured repositories, stores reports, and fans out a bounded set of cleaner/hardener agents when the gate fails or functions remain above `crapFail`. The job does **not** self-register. After deploy, the operator enables it with `POST /api/fleet/repo-quality/setup`.

## Safety

- Refuses `/path/to/cadre-live` (`isLiveFleetCheckout`). Omit that path from `DM_REPO_QUALITY_REPO_PATHS_JSON`.
- Measurement and mutation run only in a fresh worktree (`createAgentSessionWorktree`, `branchPrefix` `dueno-fleet/quality`). The original checkout is never used as `--repo`.
- Agent-started smoke servers must not run this job's side-effect loop. Use `DUENO_DISABLE_SIDE_EFFECTS=1 DM_GITHUB_AGENT_POLLER_ENABLED=0 DM_GITHUB_AGENTS_ENABLED=0 DM_SCHEDULED_AGENT_PUMP_ENABLED=0 TELEGRAM_BRIDGE=0`. Production-shaped runs require `PORT=4310` or `DUENO_ALLOW_SIDE_EFFECTS=1`.

## Config

`config.repoQuality` (env):

| Field | Env | Default |
| --- | --- | --- |
| `repoPaths` | `DM_REPO_QUALITY_REPO_PATHS_JSON` | `{}` |
| `provider` / `model` | `DM_REPO_QUALITY_PROVIDER` / `DM_REPO_QUALITY_MODEL` via `envProviderModel({ label: 'repoQuality', defaultProvider: 'codex' })` | `codex` / provider default model. Does not inherit githubAgents. |
| `intervalSeconds` | `DM_REPO_QUALITY_INTERVAL_SECONDS` | `604800` (7 days), clamped 1d–15d |
| `maxFanout` | `DM_REPO_QUALITY_MAX_FANOUT` | `2` (1–10) |
| `topN` | `DM_REPO_QUALITY_TOP_N` | `10` (1–50) |
| `worktreeBaseDir` | `DM_REPO_QUALITY_WORKTREE_BASE` | `~/.dueno-fleet/agent-worktrees` |

`repoPaths` is a JSON object of named repositories. A string keeps the original one-repo/one-default-section behavior. An object with `path` and `sections` expands one physical repository into independently measured logical targets. The reserved section name `default` (any casing or surrounding whitespace) invokes the quality CLI without `--section`; every other name is passed as `--section <name>`. A `path` object with no sections also defaults to `default`.

```json
{
  "dueno-fleet": "/path/to/dueno-fleet",
  "example-app": {
    "path": "/path/to/example-app",
    "sections": ["default", "rust"]
  }
}
```

The target repository's `.quality-gates.json` keeps its root configuration as the default section. A named section is a partial top-level override under `sections`; for example, `sections.rust` can replace `repo`, `outputDir`, `coverage`, `complexity`, and `baseline` while inheriting unchanged root fields such as thresholds. Section output directories and baselines must be distinct when their tools would otherwise write the same files.

Legacy fleet-style `{ "primary": "...", "companions": ["..."] }` entries remain valid and make every listed path a default-section target. The live checkout is rejected at setup.

Status includes distinct physical `repoPaths`/`repoCount` plus logical `targets`/`targetCount`. Each target has `repoName`, `repoPath`, and `section`.

## Routes

- `GET /api/fleet/repo-quality` — status. Does not register the job.
- `POST /api/fleet/repo-quality/setup` — register or refresh `sched_repo_quality_watch`. Does not launch.
- `POST /api/fleet/repo-quality/run-now` — due the task immediately and step once. Registers the job if setup has not run yet.

## Tick

1. Gate with `snapshotPrimaryBranchHeads`. Each physical repository is fetched/snapshotted once even when it has multiple sections. If every configured `origin/main` (or `origin/master`) SHA is unchanged **and the last tick measured successfully** (`lastTickOk !== false`), skip (`skippedNoMainChanges`). A CLI/tool failure does not freeze the SHA gate. Empty `repoPaths` skips (`skippedNoRepos`).
2. For each non-live repo/section target, create a separate worktree from origin's default head.
3. Run `node scripts/repo-quality-check.mjs --repo <worktree> --json`. For non-default targets append `--section <name>`; `default` deliberately omits the flag for backward compatibility. Parse **stdout JSON only**; ignore stderr. Exit `1` is a measured gate failure. Exit `2` is a tool/config error.
4. Store the record under the runtime state dir `repo-quality/<collision-safe-slug>/<sha-or-error>.json`. `latest.json` is the last **valid** measurement (exit 0 or 1 with a report). Exit-2 errors write `error.json` and do not replace `latest.json`, so the next tick can still delta against the previous report. Non-default slugs hash the full path plus the exact section name; default targets retain the original path-only slug so existing history remains usable.
5. Compute a delta against the previous report for that exact repo/section (`crapAboveFail`, `crapSumAboveFail`, survivors).
6. Dispatch a fix agent when the parsed report is eligible: CLI exit `1`, or `crapAboveFail > 0`, or the previous-report ratchet failed. Exit `2` is stored as `{ code: 2, error, report: null }` and does **not** dispatch.
7. Rank all remaining dirty repo/section targets together by `crapAboveFail` then `crapSumAboveFail`. Spawn at most `maxFanout` agents **globally per tick**, not per repository or section. Worktrees that are not handed to a fix agent are removed independently. A tick with no fix sessions is a skip (`measuredNoDispatch` or `checkFailed`). Each child inherits the configured provider/model pair (codex-compatible via `envProviderModel` fallback). The brief names the repository section and includes the top-N `file:line` offenders, the survivors list, test honesty rules, and the rule "Open a PR. Do not merge."

## Manual enable

```sh
# after deploy, from an authenticated client
curl -X POST http://127.0.0.1:4310/api/fleet/repo-quality/setup
curl -X POST http://127.0.0.1:4310/api/fleet/repo-quality/run-now
```

Do not merge the agents' PRs from the watcher. Do not restart production from a feature checkout.
