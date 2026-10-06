# Collab task files

Include only the work contract and limits specific to this task or operator:

```markdown
# Task: <goal>
Worktree: <path>; branch: <branch> from origin/main.

## Scope
<changes to make; boundaries and exclusions>

## Acceptance
<observable behavior, relevant tests, and required evidence>

## PR
Title: <title>
```

Cadre injects the collab workflow through `modules/agent-bus/protocol.mjs`; task files must not repeat roles, review routing, or terminal reports. Assign participant 1 to implement and participant 2 to review in the spawn. State merge ownership or branch deletion only when it differs from the injected default (keep the branch; the operator merges, or the reviewer merges after approval and gates when the managed worktree's `.cadre/worktree.json` sets `"merge": "reviewer"`).

`AGENTS.md` and its linked docs own repo setup, safe execution, verification, and commit/PR conventions; task files must not repeat those rules. The coordinator profile owns findings routing and the Claude Code MCP reconnect instruction.

Keep machine-specific paths and limits in the task file or per-instance prompt profile: shared dependency location, protected live checkout/port, process ownership, one heavy job at a time, and operator playtesting constraints.

For an opted-in repository (`.cadre/worktree.json`), pass
`worktree: { repo: "/local/repo", branch: "feat/task", base: "origin/main" }`
to `spawn_collab_session` or `spawn_conference_session` with new participants.
Cadre creates and sets their shared workDir and watches the PR opened from
`branch` for fail-closed cleanup on merge; see [Managed worktrees](agent_bus_design.md#managed-worktrees).
