---
description: Green suite, deliberate integration, verified merge; nothing ships unproven.
---

<!--
Copyright (c) 2025 Jesse Vincent

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

# Shipping a Branch

**Core principle:** Verify tests → Confirm the base → Present options → Execute choice → Verify the merge landed.

Before calling anything shipped, be able to answer with evidence (the `verify` fleet skill applies):

- what command proved the build
- what test or smoke was run
- what is not deployed yet
- rollback if this is wrong

## Step 1: Verify Tests

Run the project's full test suite (`npm test` / `cargo test` / `pytest` / `go test ./...`).

**If tests fail**, report the failures and stop — the menu comes after a green suite:

```
Tests failing (<N> failures). Must fix before completing:

[Show failures]
```

If CI is red, fix CI. Do not narrate around it.

**If tests pass:** continue to Step 2.

## Step 2: Determine Base Branch

The base branch is whatever this work forked from — usually named in the plan, the conversation, or the branch's upstream. If it is not already known, ask: "This branch split from <your best guess> - is that correct?" Confirm before merging: merging into the wrong base is expensive to undo.

## Step 3: Present Options

```
Implementation complete. What would you like to do?

1. Push and create a Pull Request against <base-branch>
2. Merge back to <base-branch> locally
3. Keep the branch as-is (I'll handle it later)

Which option?
```

Present the menu exactly as written. Discarding the work happens only in response to the user explicitly asking for it. Wait for their answer; the integration decision is theirs.

## Step 4: Execute Choice

### Option 1: Push and Create PR (default route)

```bash
git push -u origin <feature-branch>
gh pr create --base <base-branch>
```

Follow the repo's PR template and conventions if present, and report the URL. Keep the worktree — PR feedback gets fixed there.

### Option 2: Merge Locally

```bash
git checkout <base-branch>
git pull
git merge <feature-branch>
<test command>   # verify tests on the merged result
```

If tests fail on the merged result: stop, leave the branch in place, and investigate — nothing has been pushed, so the merge is local and recoverable. Once green, push, then delete the branch (`git branch -d <feature-branch>`).

### Option 3: Keep As-Is

Report: "Keeping branch <name>. Worktree preserved at <path>."

## Step 5: Verify the Merge Landed

**Finished production work lands on `main`. A merge into an issue or feature branch is not complete or deployed.**

After the PR merges (or the local merge is pushed):

```bash
git fetch origin
git merge-base --is-ancestor <commit-or-branch> origin/main && echo "landed" || echo "NOT on main"
```

Do not report the work as shipped until this says "landed".

## Deployment (fleet-specific)

Merging to `main` does not deploy. The live service runs from the `dueno-fleet-live` worktree pinned to `origin/main`; the canonical restart is `bash scripts/server.sh restart`, and it requires explicit authorization. Never treat a feature checkout as production. When reporting shipped state, say what is merged and what is not yet deployed.

## Worktree Cleanup

Fleet-managed worktrees (under `~/.dueno-fleet/agent-worktrees/`) belong to the fleet — leave them in place. Only remove a worktree you created yourself in this session, and never `--force` past a "contains modified or untracked files" refusal on your own initiative: those files exist nowhere else. Show the user `git status --porcelain -uall` output and ask.

### If the user asks to discard the work

Confirm first:

```
This will permanently delete:
- Branch <name>
- All commits: <commit-list>

Type 'discard' to confirm.
```

Wait for that exact confirmation, then `git branch -D <feature-branch>`.

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Tests passed earlier this session" | Run the suite on the tree you are about to integrate. A green run only proves the tree it ran on. |
| "They obviously want it merged" | Integration is the user's decision. Present the menu and wait. |
| "'Yeah, get rid of it' counts as confirmation" | Only the typed word `discard` authorizes deletion. |
| "The PR is up, so the worktree is clutter now" | PR feedback gets fixed in that worktree. It stays until the work lands. |
| "The merged-result failure is probably flaky" | A failing merged result stops everything. Branch stays put while you investigate. |
| "The base branch is obviously main" | Confirm the fork point or ask. Merging into the wrong base is expensive to undo. |
| "The push was rejected — force-push will fix it" | A rejected push means the remote moved. Investigate; force-push only on the user's explicit request. |
| "Merged to the issue branch, so we're done" | Finished work lands on `origin/main`. Verify with `git merge-base --is-ancestor`. |
| "I'll prepare for production while I'm here" | Deployment is separate, authorized work. Do not expand scope. |

<!-- upstream: obra/superpowers@b36e082 skills/finishing-a-development-branch/SKILL.md (adapted to fleet merge/deploy invariants) -->
