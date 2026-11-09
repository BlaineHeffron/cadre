# Session grading and the daily improver

Two separate jobs close the self-improvement loop. Both are **off by default**, and each turns on independently.

- **Grading on merge.** When a watched PR merges, the GitHub poller records a ledger entry (`GET /api/agents/github/ledger`). If grading is on, the poller spawns one durable Claude task with the `session-grade` skill for each sampled entry that has a transcript. A later poll reads the task's result, stores the parsed JSON on the entry as `grade`, `gradedAt`, `graderModel`, and ends the grader session. Malformed output or a failed spawn stores `grade: null` with `gradeError`. Neither is retried.
- **Daily improver** (`sched_session_improve_daily`). Once a day it collects the ledger entries graded in the last 24 hours that have a failing rubric. If there are any, it spawns one agent with the `session-improve` skill and those grade JSONs, in a fresh worktree of the fleet clone (`branchPrefix` `dueno-fleet/session-improve`). The agent ships PRs only. A day with no failures spawns nothing.

## Safety

- Both jobs run only when side-effect loops run: `PORT=4310`, or `CADRE_ALLOW_SIDE_EFFECTS=1`. `CADRE_DISABLE_SIDE_EFFECTS=1` stops both.
- Sessions without a transcript are not graded, and neither are grader sessions.
- The improver refuses the live checkout, using the same check as the skills upstream watch.

## Config

Settings → **Session Grading** controls both jobs without a restart:

- **Sample rate** and **Grader model** are saved in the agent provider preferences (`PUT /api/agent-provider-preferences` with `graderSampleRate` 0..1 and `graderModel` from the Claude model catalog; `null` clears either). The poller reads them on every merge.
- **Daily improver** turns on through the setup route and off through the scheduled-agent cancel route below. The panel shows its next run and a **Run now** button.
- The panel also shows each rubric's pass rate and graded count over the last 7 days, and the latest graded PRs with their failing rubrics.

Precedence: a value saved in Settings wins; with none saved, the env var applies; with neither, the default below.

| Knob | Settings / env / route | Default |
| --- | --- | --- |
| Grading sample rate | Settings, else `CADRE_SESSION_GRADER_SAMPLE_RATE` (0..1) | `0` (off) |
| Grader model | Settings, else `CADRE_SESSION_GRADER_MODEL` | `claude-sonnet-5-5` |
| Improver | Settings switch, or `POST /api/fleet/session-improve/setup` registers it; cancel with `POST /api/agents/scheduled/sched_session_improve_daily/cancel` | not registered |
| Improver repo | `DM_SKILLS_UPSTREAM_REPO_PATH`, or the first fleet/githubAgents repo path | — |
| Improver provider / model | `config.sessionImprove`, otherwise inherited from `githubAgents` | githubAgents pair |

`POST /api/fleet/session-improve/run-now` runs the improver immediately and registers it if needed. Re-enabling a cancelled improver schedules its next run a day later.

## Rollout on this instance

1. Set the sample rate in Settings (this instance also sets `CADRE_SESSION_GRADER_SAMPLE_RATE=0.25` in its managed environment as the fallback).
2. Run grading alone for a week to calibrate. Read the results in the Settings panel, or from `GET /api/agents/github/ledger` and `GET /api/agents/github/ledger/trend`.
3. Turn on the improver with the Settings switch.

## Trend

`GET /api/agents/github/ledger/trend` returns:

- `days`: for each merge day, every rubric's `count`, `passRate`, and `meanScore`;
- `promptChanges`: mainline commits of the running checkout that touched `config/skills`, `AGENTS.md`, `modules/integrations/prompt-profile-catalog.mjs`, or `modules/agent-bus/protocol.mjs`, so a change in score can be traced to a prompt change.
