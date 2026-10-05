# Coordinator efficiency: cutting mechanical token spend

Status: research and design only (2026-10-04). Nothing here is implemented. Inputs:
`SamsQuest-wt/coordinator-handoff.md` ("Cadre improvement ideas"), `SamsQuest-wt/playtest-director.md`, a
read of Cadre `main` at `8d3375d`, a live `agent_directory` snapshot, a coordinator-handoff report from session
`claude:069cba29` (item h), and primary-source reading of comparable tools (cited per section).

## Ranked summary

Savings are **estimates per merged PR** for the director workflow (~20 cycles/day). They are reasoned from the
workflow's tool-call pattern and are not measured; see "Baseline" below. Effort: S ≈ ≤1 day, M ≈ 2–4 days,
L ≈ a week or more. The order is tokens saved per unit of effort.

| # | Problem | Proposal | Effort | Saves per PR (est.) |
|---|---|---|---|---|
| 1 | c | Deliver `type=result` room messages to the room **owner** (`createdBy`), not only to participants | S | 3–6 `room_context` polls/sleeps, ~8–15k tokens |
| 2 | e | Reap github-agent sessions when their PR/issue leaves the open list; stop spawning issue sessions that can't act | S | 1–3 terminate calls plus a manual `rm`; ~9 idle panes/day |
| 3 | g | Poster-written `summary` field on messages; return it from `summary_only` and in the envelope | S | 2–4 paginated `room_context` calls, ~5–10k tokens |
| 4 | h | Room ownership survives a coordinator handoff: `room_transfer` / `inheritRoomsFrom`, plus close-the-`parentThreadId` gap | S | Prevents a whole class of workarounds (DM every participant, mirror reports to PR comments) |
| 5 | b | One-call `room_settle`: the owner may end its own room (terminate participants, remove managed worktrees); GitHub auto-delete head branches | S–M | ~6 of the ~8 cleanup calls, ~4–6k tokens |
| 6 | d | Fixed review header (`VERDICT` line plus one line per finding) in the github-agent prompt, surfaced as a digest | S | 1–3 full-review reads, ~5–15k tokens |
| 7 | a | Server-side PR shepherd: `watch_pr(...)` driven by the existing GitHub poller; DMs on state *transitions* only, optional settle on merge | M | 5–15 Monitor wakeups plus re-arms, ~10–25k tokens; the largest single item |
| 8 | f | Project profiles: custom prompt profile today (config only); later a `projectProfile` with rules, resource class (scope limits), port block | S (today) / M | ~1–2k tokens of task file per spawn, plus fewer rule violations |
| 9 | — | Per-session token/cost rollup from the `usage` events Cadre already emits | S–M | Indirect: makes the next waste visible |
| 10 | — | Extend `task_wait`/durable tasks to tmux providers, or hook `Stop` → owner DM | M–L | Generalises #1 to every provider |

Do #1–#3 first. Each is a few lines in code paths that already exist, and together they remove most polling.
#7 is the biggest single saving, but it is only cheap once #1, #5 and #6 exist, because the shepherd's job is to
*trigger* them.

### Baseline: where a director's tokens go per PR today

| Activity | Calls/PR | Why it's expensive |
|---|---|---|
| `Monitor` on `gh pr list` (30-min cap, re-armed) | 5–15 events plus 2–4 re-arms | Fires on every review or comment count change; each event is read in full |
| Catching the DIRECTOR REPORT | 3–6 `room_context` calls or sleep timers | The owner isn't a delivery target (see c) |
| Reading long room bodies | 2–4 extra calls | 1200-char page cap with `body_offset` (see g) |
| Reading Grok reviews | 1–3 `gh` reads of full review bodies | No digest (see d) |
| Cleanup | ~8 calls | Spread across rooms, sessions, fleet worktrees and git (see b) |

In total that is roughly 20–40 mechanical tool calls per PR. The decisions themselves (merge? intervene? ask
the user?) need about 3–5.

---

## a. No built-in PR shepherd

**Cadre today.** `GithubAgentPoller` (`modules/integrations/github-agents.mjs:499-663`) lists open PRs and
issues every `pollIntervalSec` (default 60). It only detects *new* items above `lastSeenPrNumber`.
`normalizeGithubItem` keeps `state` but nothing compares it (`:1036-1048`). There is no inbound webhook and no
MCP tool for the poller. Scheduled agents (`register_scheduled_agent`, `spawn_loop_session`) can poll, but each
tick is a model turn that costs tokens. So a coordinator cannot be woken on merge.

**How others do it.**
- **T3 Code** runs one server-side PR sync sweep every minute (60 s cache). It also forces a refresh as soon as
  an agent runs `gh pr merge|close`. "Monitoring" is a first-class thread state, and threads auto-settle when
  the PR merges or closes ([#15024](https://github.com/pingdotgg/t3code/pull/15024),
  [#7655](https://github.com/pingdotgg/t3code/pull/7655),
  [#9934](https://github.com/pingdotgg/t3code/pull/9934)). This is the T3 product the user means: T3 Chat
  (the chat app) has nothing relevant.
- **Claude Code Routines** fire on GitHub `pull_request` events with filters such as "is merged".
  `/autofix-pr` subscribes a cloud session to a PR's CI failures and review comments
  ([routines](https://code.claude.com/docs/en/routines),
  [web](https://code.claude.com/docs/en/claude-code-on-the-web)).
- **Devin** sleeps a session and wakes it on PR comments or lint failures
  ([release notes](https://docs.devin.ai/release-notes/2026)).
- **Copilot coding agent** requests review when it finishes, and GitHub's own notification wakes the human
  ([docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-on-github)).
- **Kodiak / Mergify / GitHub auto-merge** let the platform do the waiting: label- or condition-gated merge
  ([Kodiak](https://kodiakhq.com/docs/config-reference), [Mergify](https://docs.mergify.com/merge-queue/rules/),
  [GitHub auto-merge](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request)).

**Borrow.** Do the polling once, on the server, with no model in the loop. Wake an agent only on a *state
transition*, with a one-line payload. This is T3's sweep, not one Monitor loop per coordinator.

**Cadre design.**
- New MCP tool `watch_pr({ repo, number, notify: {kind, session_id}?, events?: ['merged','closed','review','conflict'], on_merge?: { settle_thread_id?, terminate_github_agents?: true } })`.
  - `notify` defaults to the caller.
  - Stored in the poller's repo state as `watches[]`. Deleted after a terminal event or 7 days (every watch
    expires, like Monitor's 30 min and `/loop`'s 7 days).
- The poller already lists open PRs each tick. A watched number that disappears from the list triggers one
  `GET /pulls/{n}` to tell merged from closed.
  - Reviews: `GET /pulls/{n}/reviews` only for watched PRs, sent with `If-None-Match` (a 304 costs no rate limit).
  - Emit at most **one DM per transition** via the existing `agent_dm` path. Examples:
    `PR #137 merged (abc1234) · settled room thr_x · 2 github-agent sessions ended`, or
    `PR #137 review by owner: VERDICT BLOCKING 1 / NON-BLOCKING 3` (uses d).
- `on_merge` calls the settle path from (b), so cleanup happens with no coordinator turn at all.
- Webhooks are optional later (L). They need a reachable endpoint on a self-hosted box; polling plus ETags is
  enough at a 60 s cadence.
- The poller is code-disabled unless side effects are allowed (`server.mjs:79-84`), so watches only fire on the
  production port, as intended.

**Effort** M. **Saves** 5–15 Monitor wakeups plus re-arms per PR, ~10–25k tokens. The director drops its
`gh pr list` Monitor entirely.

**Harness note.** The 30-min Monitor cap and the re-arm cost are a Claude Code limit, not Cadre's. Cadre's
fix is to make Monitor unnecessary for PR watching.

## b. Cleanup is ~8 tool calls per merge

**Cadre today.**
- `room_close {thread_id, cancel_pending}` archives the room but leaves sessions running
  (`modules/agent-bus/routes.mjs:225-241`).
- `room_end` closes the room *and* terminates participants that aren't in another open room (`:253-282`). But
  `agentDeniedTool` denies it to every agent principal (`mcp.mjs:289-291`), so a coordinator cannot use it on
  rooms it created.
- `monitor_terminate_session` already removes a session's *managed* worktree (`sessions/index.mjs:1582-1601`).
  The director's task worktrees are made by `mkwt.sh`, outside Cadre, so they need manual removal.
- `isolatedWorktree` exists on `/api/agents/sessions` (`modules/agent/interface.mjs:327-374`) but is not
  exposed through `spawn_session` or `spawn_collab_session`.

**How others do it.**
- T3 Code "settles" a thread on merge and runs a per-project `runOnThreadSettle` teardown. Teardown is skipped
  if another thread shares the worktree ([#12122](https://github.com/pingdotgg/t3code/pull/12122)).
- Claude Code removes a session and its worktree with `claude rm <id>`. Its escapes
  (`--discard-unpushed`, `--force-remove-worktree`) are explicit, and it never sweeps worktrees holding
  unpushed work ([worktrees](https://code.claude.com/docs/en/worktrees),
  [CLI](https://code.claude.com/docs/en/cli-reference)).
- Conductor runs `scripts.archive` before archiving a workspace
  ([scripts](https://www.conductor.build/docs/core/scripts)).
- Devin archives a session together with all its children
  ([API](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-archive)).
- GitHub's "Automatically delete head branches" repo setting removes remote branches on merge
  ([docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches)).

**Borrow.** Make one settle verb that cascades: room → participant sessions → their managed worktrees →
related github-agent sessions. Remove a worktree only if it is clean (T3's
[#13836](https://github.com/pingdotgg/t3code/issues/13836) lesson). Leave branch deletion to GitHub.

**Cadre design (minimal code).**
1. Allow `room_end` for the room's **owner** (`createdBy`). Today it's denied to all agents. Change
   `agentDeniedTool` to `name === 'room_end' && !actorIsOwner`, and add `cancel_pending` to `room_end`. This
   makes `room_end` the settle verb, with no new tool.
2. Add `github: {repo, numbers[]}` to `room_end`. It also terminates `source:'github-agent'` sessions whose
   metadata `github_repo` and `number` match. Coordinator policy already indexes these
   (`coordinator-policy.mjs:470-487`). Their managed worktrees and `dueno-fleet/*` branches go with them through
   the existing `cleanupSessionArtifacts`.
3. Expose `isolatedWorktree: true` on `spawn_collab_session` (shared by both participants) so the task worktree
   is Cadre-managed and removed by step 1. `mkwt.sh`'s isolated `node_modules` would move to a project setup
   script (f).
4. Operator decision: turn on GitHub auto-delete head branches for SamsQuest. That conflicts with the current
   "do not delete the remote branch" task rule, which exists because the *implementer* shouldn't delete it.
   Branch deletion after merge is fine and the user already approved it.

After this, cleanup is `room_end({thread_id, cancel_pending: true, github: {repo, numbers: [137, 128]}})` plus
the log row, or zero calls if (a)'s `on_merge` does it.

**Effort** S–M. **Saves** ~6 of 8 calls per PR (all of them with a).

## c. No push when a room posts its final `type=result`

**Cadre today.** `send()` targets `participants` minus the sender (`routes.mjs:314-316`). The owner
(`createdBy`) is never a delivery target, even though it is allowed to *send*. `type=result` only adds a
`Type: result` line to the envelope (`envelope.mjs:36`). So a director that created a collab room gets nothing
and must poll.

**How others do it.**
- Claude Code agent teams: a finishing teammate automatically notifies the lead with its final answer.
  `SendMessage notify_when_idle` sends one notice with a one-line status, and the subscription expires after
  12 h ([agent teams](https://code.claude.com/docs/en/agent-teams),
  [cross-session](https://code.claude.com/docs/en/cross-session-messaging)).
- Codex `notify` runs on `agent-turn-complete` with `last-assistant-message`
  ([config](https://learn.chatgpt.com/docs/config-file/config-advanced)).
- Devin MCP `devin_session_gather` waits for several sessions to settle
  ([Devin MCP](https://docs.devin.ai/work-with-devin/devin-mcp)).
- A known pitfall: T3 Code shipped false "completed" alerts when a subagent or monitor finished while the agent
  kept working ([#13625](https://github.com/pingdotgg/t3code/issues/13625)). Trigger on an *explicit* result,
  not on idle.

**Borrow.** Cadre already has the explicit signal: workers are told to post `type=result` (`protocol.mjs:22`).
It just doesn't route it to the owner.

**Cadre design.** In `send()`, when `resolvedType === 'result'` and the owner is an agent that isn't the sender
or a participant, add `createdBy` to `targets`. It then goes through the normal delivery path (idle-gated
injection, retries, audit). With (g), the owner gets the summary line plus `room_context(message_id=…)` for the
full body. That's about one line in `routes.mjs`. Ordinary messages are unchanged, so owners aren't spammed.

**Effort** S. **Saves** 3–6 polls or sleeps per PR, ~8–15k tokens, and removes background-timer fragility.

**Harness note.** For "tell me when this session stops", independent of rooms, Cadre's Claude hooks plugin
already relays `Stop` (`scripts/agent-hooks/claude-fleet/hooks/register.ts`), but only to derive state. Turning
`Stop` into an owner notification is item #10. Do c first: it works for every provider, including codex on
tmux.

## d. Automated reviews are long, with no blocking/non-blocking digest

**Cadre today.** `buildGithubAgentPrompt` (`github-agents.mjs:1123-1168`) says "Prefer one structured review
body". It defines no format and no verdict line. The Grok session posts the review itself with `gh`, so Cadre
never sees it.

**How others do it.**
- Codex review on GitHub reports **only P0/P1**. Blocking criteria live in `## Code Review Rules` in AGENTS.md
  ([docs](https://learn.chatgpt.com/docs/third-party/github)).
- CodeRabbit:
  - Header "Actionable comments posted: N", with collapsed "🧹 Nitpick comments (k)".
  - Severity badges Critical/Major/Minor/Trivial
    ([docs](https://docs.coderabbit.ai/guides/code-review-overview)).
  - Parsers should read only the leading badge; nitpick-only reviews have no actionable line
    ([pitfall](https://github.com/nathanjohnpayne/mergepath/issues/955)).
- Greptile: "Confidence Score: N/5" plus a one-line "safe to merge because…" verdict. Trust only the bot's own
  author, and check the reviewed SHA ([docs](https://www.greptile.com/docs/code-review/first-pr-review)).
- Copilot review: High/Medium/Low, plus an approval assessment
  ([docs](https://docs.github.com/en/copilot/concepts/agents/code-review)).

**Borrow.** Use a machine-parseable first line, the two-tier blocking/non-blocking split, and the reviewed SHA.

**Cadre design.** Prompt-only change in `buildGithubAgentPrompt`: the review body must *start* with

```
VERDICT: BLOCKING <n> | NON-BLOCKING <m> | sha <short>
- [B] <file:line> <one line>
- [N] <file:line> <one line>
```

then free-form detail. The shepherd (a) already fetches reviews for watched PRs, so it forwards just the
`VERDICT` line and the `[B]` lines. Parse only from the expected author, and require the SHA to match the PR
head. Without the shepherd, the coordinator can read the first few lines with
`gh pr view --json reviews -q '.reviews[-1].body' | head -5`.

**Effort** S (prompt), plus part of a. **Saves** 1–3 full-review reads per PR, ~5–15k tokens. Grok reviews
are multi-kilobyte.

## e. github-agent sessions never expire

**Cadre today.**
- The poller never re-checks spawned items.
- Idle auto-close is fully built (`sessions/auto-close.mjs`, applied at `sessions/index.mjs:3286-3340`, and it
  removes the managed worktree too). But `createSession` defaults `autoCloseMode='never'` and no caller sets it.
- `reapWorktrees` exists but `worktreeReapEnabled` defaults to false. It also force-removes dirty worktrees and
  ignores live sessions.
- A session whose pane exits on its own is marked `endedAt`, and its worktree stays.
- Live evidence on 2026-10-04:
  - `agent_directory` lists nine idle `GitHub ISSUE #128–136` pi sessions, plus PR sessions.
  - `~/.dueno-fleet/github-agents/worktrees/BlaineHeffron-SamsQuest/` has 16 entries, including PRs from
    #82 onward.
- Issue sessions are told *not to post anything* (`:1158-1161`), so for this workflow they spend tokens with no
  visible output.

**How others do it.**
- T3 Code settles a thread when the PR's `mergedAt`/`closedAt` is newer than the last human message. It has a
  per-thread keep-alive opt-out and an inactivity window
  ([#15388](https://github.com/pingdotgg/t3code/pull/15388),
  [#11846](https://github.com/pingdotgg/t3code/pull/11846)).
- AutoGen has composable termination conditions (Timeout, TokenUsage)
  ([docs](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html)).
- Claude Code's sweep never removes worktrees with unpushed work
  ([worktrees](https://code.claude.com/docs/en/worktrees)).

**Cadre design.**
1. Reap on close: in `pollOnce`, for each live `source:'github-agent'` session whose `pr:N` / `issue:N` is
   absent from the open lists the poller *already fetched*, call `deleteSession`. That's one loop with no new
   API calls, and the worktree goes with it.
2. Idle backstop: have the github launcher pass `autoCloseMode: 'when_waiting_for_input',
   autoCloseAfterMs: 2h`. It only needs plumbing through `defaultSessionLauncher`.
3. Operator config, no code: set `issueEnabled: false` for SamsQuest through `POST /api/agents/github`. Issue
   sessions do nothing useful here because the director already spawns real fixers. *Not done: this is a live
   config change, and the brief says no reconfiguration.*
4. Make the reaper safe before anyone enables it: skip worktrees referenced by a live session's
   `managedWorktree`, and skip dirty ones unless `force`.

**Effort** S. **Saves** 1–3 terminate calls plus a manual `rm -rf` per PR, and ends the daily pile-up of idle
panes and directories.

## f. Every spawn repeats the same rules

**Cadre today.**
- Prompt profiles are system-prompt templates (`prompt-profile-catalog.mjs`). Custom ones load from
  `DM_PROMPT_PROFILES_FILE` / `DM_PROMPT_PROFILES_JSON` (`config.mjs:188-192`), and `promptProfile` is accepted
  by every spawn tool.
- Resource limits are global systemd scope settings (`session-scope.mjs:41-43`: MemoryHigh 4G, MemoryMax 8G,
  TasksMax 1024).
- There is no caller-supplied env, no port allocation and no CPU limit.

**How others do it.**
- Conductor `.conductor/settings.toml`: `setup`/`run`/`archive` scripts, `CONDUCTOR_PORT` with a 10-port block
  per workspace, and `run_mode = nonconcurrent` ([docs](https://www.conductor.build/docs/core/scripts)).
- uzi `portRange` ([repo](https://github.com/devflowinc/uzi)).
- T3 Code `t3.json` `runOnWorktreeCreate` ([#2640](https://github.com/pingdotgg/t3code/issues/2640)).
- Cursor `environment.json` ([docs](https://cursor.com/docs/cloud-agent/setup)).
- Copilot `copilot-setup-steps.yml` plus path-scoped instructions
  ([docs](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment)).
- Claude Code `--settings`, `--append-system-prompt-file`, `--max-budget-usd`, and `.claude/rules/*.md`
  ([CLI](https://code.claude.com/docs/en/cli-reference), [memory](https://code.claude.com/docs/en/memory)).

**Borrow.** Keep one per-project file that the platform applies at spawn, with a named resource class and a
port block.

**Cadre design.**
- **Today, config only:** add a `samsquest` prompt profile (`placement: append`) to the profiles file. It holds
  the hard-rules block: never touch the user's checkout, headless only, caps, ports, PROTOCOL_VERSION, no
  publishing. Spawn with `promptProfile: 'samsquest'` and task files shrink to scope and acceptance. *This is
  operator config and needs a restart, so it was not done.*
- **Later (M):** a `projectKey` → project profile mapping (`spawn_collab_session` already takes `projectKey`)
  holding:
  - `promptProfile`
  - `resourceClass` (`light` | `standard` | `heavy`), mapped onto the existing systemd scope as
    `CPUWeight`/`CPUQuota`, `MemoryHigh` and `TasksMax`, plus exported `CADRE_MAX_WORKERS`
  - `portBlock`: allocate `CADRE_PORT_BASE` with 10 ports per session, exported through `launch-env.mjs`
  - `setup` script (replaces `mkwt.sh`'s `node_modules` step)

  Enforcement through cgroups beats repeating "max 6 workers" in prose.

**Effort** S (profile) / M (project profiles). **Saves** ~1–2k tokens of repeated task file per spawn. The
bigger win is that caps are enforced, not just requested.

**Harness note.** Claude Code and Codex each have their own instruction layering (CLAUDE.md, AGENTS.md).
SamsQuest's `AGENTS.md` is the natural home for repo-wide rules. Machine-specific rules (the user's checkout,
DISPLAY=:1, unrelated processes) belong in the Cadre profile, not the repo.

## g. Long room messages truncate

**Cadre today.**
- `room_context` caps `body_limit` at 1200 chars and pages with `message_id` and `body_offset`
  (`mcp.mjs:169-227`).
- `summary_only` only drops bodies; it doesn't summarise anything.
- Messages have no summary field (`store.mjs:404-417`).

**How others do it.**
- Claude Code `SendMessage` requires a 5–10 word `summary` (truncated at 200 chars) shown as the preview
  ([tools](https://code.claude.com/docs/en/tools-reference)).
- Codex `exec --output-schema` and Claude `--json-schema` give schema-validated final output
  ([Codex](https://developers.openai.com/codex/noninteractive)).
- Devin `structured_output` ([docs](https://docs.devin.ai/api-reference/v1/structured-output)).
- CrewAI `expected_output` plus a guardrail retry ([docs](https://docs.crewai.com/en/concepts/tasks)).

**Cadre design.**
- Add an optional `summary` (≤200 chars) to `room_send`, stored in message `metadata.summary` (no schema
  migration).
- `room_context(summary_only=true)` returns it, falling back to the first body line truncated to 200 chars.
- Envelopes for bodies over 1200 chars inject the summary plus `room_context(message_id=…)`, not the full body.
- `protocol.mjs` tells workers that `type=result` messages carry a summary in the form
  `merged|blocked|needs-decision · PR #n · <one line>`.
- Optionally reject a `type=result` with no summary, as a guardrail.

**Effort** S. **Saves** 2–4 paging calls per long report, ~5–10k tokens.

## h. Room access doesn't survive a coordinator handoff (reported by `claude:069cba29`)

**Observed.** The original director created four collab rooms and was then replaced by a new coordinator,
which spawned a shepherd. Neither the coordinator nor the shepherd can call `room_context`, `room_send` or
`room_close` on those rooms; they get "Actor is not a participant". The workaround (DM each participant with
`monitor_send_to_session`, mirror DIRECTOR REPORTs into PR comments, leave stale rooms for the user) costs
tokens and is fragile.

**Verified in code.**
- `assertThreadAccess` (`modules/agent-bus/mcp.mjs:388-406`) admits only `createdBy` or participants
  (`actorInThread`, `:293-296`) under `@member` credentials. That applies to `room_*` and `task_*` tools
  (`:409-411`).
- `POST /api/agent-bus/threads/:id/participants` exists (`routes.mjs:155-161`), but there is no MCP tool for
  it and no owner-transfer route.
- **Security gap:** `spawn_session(parentThreadId=…)` calls that route via `bestEffortAttachParticipant`
  (`monitor-mcp.mjs:392-404`) *without* the thread-access check. Any agent that may spawn sessions can attach
  a new session to any room and so read and write it.

  This should be closed regardless of h. Gate `parentThreadId` on `assertThreadAccess`. It must not be used as
  the handoff workaround.

**How others do it.** Most tools tie ownership to a durable project or user identity, not a session.
- T3 Code threads belong to the project, and any agent with the T3 MCP can list, read and organise them
  ([#13489](https://github.com/pingdotgg/t3code/pull/13489)).
- Devin child sessions belong to the parent and are archived with it.
- LangGraph keys state by `thread_id` plus a checkpointer, so any resumer with the id continues it
  ([interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)).

**Cadre design (pick one; the first is smallest).**
1. `room_transfer({thread_id, to: {kind, session_id}})`, callable by the current owner or by the operator. It
   sets `createdBy` to the new owner. The operator path covers a dead or replaced coordinator: the user approves
   the transfer through the existing human queue.
2. `spawn_session({ inheritRoomsFrom: {kind, session_id} })`, operator-gated, transfers all open rooms owned by
   the old session. This is the natural "replace the coordinator" call.
3. Let `room_close` succeed for any member *or* operator once every participant is gone (`already_gone`).
   This ends stale rooms without the user.

Read-only observer access by "project" is the broadest option. It needs a project identity Cadre doesn't have
yet; that comes with f's project profiles.

**Effort** S for 1 or 3, M for 2. **Saves** the per-room DM fan-out and the PR-comment mirroring, and lets
c, g and b work for successors.

---

## Beyond a–h

| Win | Seen in | Cadre today | Proposal | Effort |
|---|---|---|---|---|
| Token/cost per session | Claude `--max-budget-usd`, Devin ACU limits | Structured transports emit `usage` with `costUsd` (`claude-stream-json-transport.mjs:386-414`, `codex-app-server-transport.mjs:367`); nothing consumes it | Sum into session metadata; show it in `agent_directory` and the dashboard; optional budget soft limit that adds a human-queue item | S–M |
| Completion events for any provider | Claude `Stop`/`SubagentStop` with `last_assistant_message`; Codex `notify` | `task_wait` works only for protocol providers; tmux codex and pi return `unsupported_provider` | On hook `Stop`, if the session has an owner room, post a `type=result`-like event with the last message's first line (needs a Codex hook equivalent) | M–L |
| Two-level status / attention inbox | Devin `status_detail`, T3 `t3_inbox` | Human queue plus `canSendNow` reasons | Add `waiting_for_review` / `monitoring` detail to `agent_directory` so coordinators skip idle-but-expected sessions | S |
| Auto-merge on green | GitHub auto-merge, Kodiak labels | Director merges by hand after reading the review | Shepherd `on_review: {verdict: 'BLOCKING 0', action: 'merge', method: 'merge'}`, opt-in per watch. Product decision: the user currently wants a human-in-the-loop merge | S after a + d |
| Context handoff on restart/compaction | Claude `PreCompact`/`SessionStart(compact)`, Agents SDK `nest_handoff_history` | Coordinator handoff is manual (`coordinator-handoff.md`) | Pair with h: `inheritRoomsFrom` plus an auto-generated handoff note (open rooms, watches, pending queue items) | M |
| Treat relayed messages as untrusted | Claude Code's rule that relayed messages aren't consent | `[DM]` envelopes are typed into panes as user input | Envelopes already name the sender. Keep "from" prominent, and don't let DMs carry `passThrough` answers | — |

## What is a harness concern, not Cadre's

- Monitor's 30-minute cap and its per-event wakeups (Claude Code). Cadre fixes this by removing the need, via a.
- Background timers and sleeps in the coordinator (Claude Code). Solved by c.
- Codex/Claude instruction layering (`AGENTS.md`, `CLAUDE.md`). SamsQuest should move repo-wide rules there;
  Cadre's profile holds the machine-specific rules.
- `--max-budget-usd` / `--json-schema` are per-CLI flags. Cadre could pass them through a resource class
  (f/#9), but they apply mainly to non-interactive runs, not to the tmux sessions Cadre spawns today.

## Sources not verified

- T3 Chat internals (it's not relevant here).
- Whether every cited T3 Code PR has merged.
- Ellipsis's LGTM format, a Graphite PR-level digest, Claude Squad's notifications, and Cursor's OS
  notification triggers.
- None of these change the recommendations.

---

## Decisions and build plan (agreed with the operator, 2026-10-04)

**Room model.** Rooms are open. Any agent may read (`room_context`) and post (`room_send`) in any room.
Membership means only *subscription*: participants are pushed the room's messages. `parentThreadId` is the
documented way to attach a worker to an existing room, so the "security gap" in h is withdrawn: it is the
intended behaviour. There is no `room_join` tool. A successor coordinator gets pushes by becoming owner.

**Wave 1** (three PRs in this order, each merged to `main` before the next starts)

1. **Rooms (c, h, b)**
   - Read and send are open to every agent credential.
   - `room_list({scope: 'all'})` lists all open rooms.
   - The owner (`createdBy`) is pushed `type=result` messages only.
   - `room_transfer({thread_id, to})` is callable by the owner. Any agent may claim a room whose owner session
     no longer exists.
   - `room_end` is allowed for the owner. Participants who are in another open room are still preserved.
   - `room_close` is allowed for the owner, or for anyone once every participant is gone.
   - `room_end` gets no GitHub option; the poller handles those sessions (e).
2. **Message summaries (g)**
   - Optional `summary` (≤200 chars) on `room_send`. Messages without one fall back to their first line.
   - `room_context(summary_only)` returns the summary.
   - Envelopes for bodies over 1200 chars carry the summary plus a `room_context(message_id=…)` pointer.
   - The worker protocol asks for a summary on `type=result`. It is not enforced.
3. **GitHub sessions (e, d)**
   - The poller ends sessions whose PR or issue has left the open list.
   - The launcher sets close-on-exit plus a 2 h idle close.
   - Every github-agent session posts exactly one comment and then exits:
     - PRs: a review starting `VERDICT: BLOCKING n | NON-BLOCKING m | sha <short>`, with one `[B]`/`[N]` line
       per finding. When auto-review is off, it posts a plain COMMENT.
     - Issues: a triage comment with suspected files, likely cause and proposed fix. Nothing is pushed.
   - The format is fixed in Cadre and is the same for every repo.
   - Task worktrees stay with `mkwt.sh`; the coordinator removes them itself.

**Wave 2: `watch_pr` (a)**
- Server-side, on the existing poller.
- Notifies on merged, closed, new review (`VERDICT` and `[B]` lines only) and merge conflict. Comments are not
  notified.
- Notifies the linked room's current owner, falling back to the watch's creator.
- On merge it ends the linked room automatically.
- Expires at the first merge or close, or after 7 days.
- Cadre never merges; merge stays with the operator or the coordinator.

**Wave 3 (deferred, to be designed separately)**
- Project profiles and resource classes.
- `isolatedWorktree` plus setup scripts.
- Cost/token rollup.
- `Stop`-hook completion events.

**Operator actions (outside Cadre code)**
- Enable "Automatically delete head branches" on SamsQuest.
- Set `issueEnabled: false` for SamsQuest's github-agent repo.
- Add a per-instance `samsquest` prompt profile holding the director's hard rules.
