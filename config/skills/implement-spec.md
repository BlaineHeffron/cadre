---
description: Implement a spec as a ticket graph across worktrees on one integration branch.
---

<!--
Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
-->

# Implement a Spec

Implement the supplied spec and its tickets on one **integration branch**. If tickets have not been drafted, use the `to-tickets` fleet skill (config/skills/to-tickets.md).

Default tracker: GitHub issues in the current repo via `gh`. Read the full issue bodies and comments. Use local ticket files when the user asks for them or the repo has no tracker.

The tickets are a **task graph**, not a list of steps. Work the **frontier**: tickets whose blockers are all complete.

Communicate with subagents primarily through **context pointers** to the spec, tickets, research notes, and previous commits. Run implementers in the background where the harness supports it.

## Steps

1. Read the spec and tickets to understand the task graph.

2. Optionally use an **exploration subagent** to research relevant code or external documentation. Save notes outside the repo in a location all subsequent subagents can access.

3. Create the integration branch. If work closes through PRs, or the user asks for one, open a draft PR after the first ticket merge (an empty branch cannot open one). Reference the spec and tickets with closing keywords; use the `pr` fleet skill (config/skills/pr.md) for the body.

4. Dispatch **implementer subagents** for frontier tickets, each on its own branch in an isolated worktree. Use Cadre-managed worktrees when available; otherwise create worktrees with git. Each implementer:
   - confirms its branch is based on the integration branch before starting; correct a wrong base without discarding existing work;
   - reads the `tdd` fleet skill (config/skills/tdd.md) and builds the ticket through its red-green loop;
   - merges the current integration tip into its branch and verifies the result before reporting done.

5. When an implementer completes, use a **merger subagent** to integrate its work into the integration branch. Serialize integrations, resolve conflicts, and run the relevant checks on the merged result.

6. Recompute the frontier and dispatch newly unblocked tickets. Keep independent tickets running concurrently where supported.

7. Once all tickets are complete, review the full integration diff against the spec, acceptance criteria, and repository coding standards. Use the harness's review agent when available. Have one implementer fix the findings, then verify the fixes and required checks.

8. Mark an existing draft PR ready for review. Otherwise resolve tickets through the tracker's established workflow and report the integration branch. Merging to the integration branch does not mean the work has landed on `main` or been deployed; follow the `ship` fleet skill (config/skills/ship.md) when authorized to integrate further.

9. Clean up only worktrees created for this run once their work is safely integrated and their trees are clean. Leave Cadre-managed worktrees to the fleet; never force-remove modified or untracked work.

<!-- upstream: mattpocock/skills@24fe0ef skills/engineering/implement-spec/SKILL.md -->
