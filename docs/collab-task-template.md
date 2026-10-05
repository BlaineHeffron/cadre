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

Cadre injects the collab workflow through `modules/agent-bus/protocol.mjs`; task files must not repeat roles, review routing, merge ownership, terminal reports, or branch retention. Assign participant 1 to implement and participant 2 to review in the spawn.

`AGENTS.md` and its linked docs own repo setup, safe execution, verification, and commit/PR conventions; task files must not repeat those rules. The coordinator profile owns findings routing and the Claude Code MCP reconnect instruction.

Keep machine-specific paths and limits in the task file or per-instance prompt profile: shared dependency location, protected live checkout/port, process ownership, one heavy job at a time, and operator playtesting constraints.
