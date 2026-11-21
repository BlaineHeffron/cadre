# Cadre

Cadre is a self-hosted control plane that schedules, runs and monitors coding-agent sessions and lets them collaborate in rooms. This glossary fixes the words for its domain; decisions behind it live in `docs/adr/`.

## Language

### Sessions

**Session**:
One running or resumable coding-agent conversation that Cadre runs or tracks, identified by its kind and session id.
_Avoid_: Agent (for the session itself), pane, process

**Provider**:
The agent harness a session runs on, or for Pi the model service behind it; for example `claude`, `codex`, `agy`, `deepseek` or `xai`.
_Avoid_: Backend, runtime, kind (those name the harness; several providers such as `xai`, `google` and `openrouter` share the `pi` harness)

**agy**:
The provider that runs Google's unmodified Antigravity CLI binary in a terminal pane; it is the only supported route to Gemini by subscription.
_Avoid_: Antigravity provider (the retired Pi provider of that name)

**Prompt profile**:
A named system-prompt text, such as `coordinator`, that is appended to or replaces a session's system prompt at launch.
_Avoid_: Persona, system profile

**Launch skill**:
A named text snippet injected as startup user text when a session launches; it is not a harness skill.
_Avoid_: Skill (unqualified), slash command

**Handoff**:
Continuing an idle session as a new linked session on another provider or model, seeded with a text brief; the source stays paused and resumable.
_Avoid_: Using "handoff" for the implementer sending a PR to a reviewer (call that the **review handoff**) or for spawning a session without `returnResults`

**Child session**:
A session spawned by another session; with `returnResults` the final message of each finished turn is sent back to the spawner.
_Avoid_: Worker (reserved for the machine role), subagent

**returnResults**:
A spawn option that DMs the final message of each finished turn of a child session back to its spawner; it applies only to `claude` and `agy` children spawned outside a room.
_Avoid_: Callback, reply-to-parent

**Coordinator**:
A session that plans work, spawns and steers child sessions and rooms, and queues decisions for the operator in the Command Queue, then acts on the answers, usually via the `coordinator` prompt profile.
_Avoid_: Manager, director, supervisor (the Fleet Supervisor is a different profile)

### Rooms

**Room**:
A persistent message log with a roster of participants and an owner; it is either open or closed.
_Avoid_: Thread (the storage and REST name for the same object; use it only when naming those APIs), channel, chat

**DM**:
A private room between exactly two participants.
_Avoid_: Direct thread, private room

**Participant**:
A session, or a human such as the dashboard user, on a room's roster; only session participants receive deliveries.
_Avoid_: Member, subscriber

**Collab**:
A room started with exactly two participants onboarded to a shared task, typically an implementer and a reviewer.
_Avoid_: Pair, pairing session

**Conference**:
A room started with two or more participants on a shared task; a collab is the two-participant case.
_Avoid_: Meeting, group chat

**Delivery**:
The record of injecting one room message into one target session; it is queued, injected or failed.
_Avoid_: Using "delivery" for the session delivery audit entry, which logs a direct send to a session

**Managed worktree**:
A git worktree Cadre creates for a room from a repo that opts in, and may remove when the room ends, only if its cleanup policy allows and all its commits are on a remote.
_Avoid_: Isolated worktree (a separate per-session option), scratch checkout

### Operations

**Human queue item**:
A decision or approval waiting for the operator in the Command Queue.
_Avoid_: Work-queue item, attention item (attention items are alerts, such as failed deliveries), ticket

**Operator**:
The human who runs the Cadre instance, approves deploys and queued actions, and by default merges.
_Avoid_: User (except the dashboard participant), admin

**Hub**:
The machine whose Cadre instance owns the rooms, the Command Queue and every side-effect loop.
_Avoid_: Server, primary, controller

**Worker**:
A paired machine that runs sessions for a hub and owns no loops, bot or room store of its own.
_Avoid_: Using "worker" for a child session

**Live checkout**:
The dedicated checkout the production service runs from, kept at `origin/main`.
_Avoid_: Prod clone, deploy dir, dev clone (the clone agents work in)

**Side-effect loop**:
A background loop that acts outside the process on its own, such as GitHub polling, scheduled agents, the Telegram bridge or the MCP listener; only the production instance runs them unless explicitly overridden.
_Avoid_: Daemon, cron, background job
