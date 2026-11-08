---
description: Turn a batch of failing session grades into a few small environment-fix PRs.
---

# Session Improve

You are given N grade JSONs produced by the `session-grade` skill (`config/skills/session-grade.md`), each with at least one failing rubric. Fix the **environment** that produced the failures, not the sessions. Read the `writing-for-agents` skill (`config/skills/writing-for-agents.md`) before editing any document an agent reads.

## Steps

1. Group failures into **commonalities**: the same rubric failing for the same cause across sessions (the same stale instruction, the same probed fact, the same rule broken). Done when every failing rubric is in a group or marked a one-off. Open each cited transcript or diff only to confirm a cause the evidence strings leave unclear.
2. Rank groups by session count, then severity. Keep groups seen in two or more sessions; a one-off survives only if it is an instruction-adherence breach.
3. Classify each kept group with the retro categories in the `retro` skill (`config/skills/retro.md`, step 3), then map it to one target below. Done when each group names one file to change and checks that `origin/main` has not already fixed it.
4. Open at most three PRs, one per group, each the smallest edit that removes the cause. Prefer deleting or correcting a stale line over adding one. Each PR body cites the grade JSONs (session and rubric) that motivated it.
5. Report: PRs opened, groups proposed to the operator, groups dropped with why.

## Targets

| Cause | Target | Action |
| --- | --- | --- |
| Stale or missing step in a stock skill | `config/skills/<id>.md` | PR |
| Stale step in a local override | `state/skills/<id>.md` | Propose to the operator; it is git-ignored live config |
| Startup prompt or role rule wrong | prompt profiles: `modules/integrations/prompt-profile-catalog.mjs`, or the `DM_PROMPT_PROFILES_FILE` overlay | PR for the catalog; propose for the overlay |
| Repo rule stale, missing, or a no-op | the graded repo's `AGENTS.md` | PR to that repo |
| Room protocol misread (polling, acks, report types) | agent-bus protocol guidance: `modules/agent-bus/protocol.mjs` | PR |
| Mechanical mistake a check could catch | the repo's lint, test, or CI config | PR adding the check |

Edit only through PRs from your own worktree. Live config (`state/`, the live checkout, a running server) changes only by operator hand, so anything there goes in the report as a proposal.
