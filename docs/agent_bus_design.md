# Agent Bus Design

## Purpose

The agent bus is a persistent collaboration-room service for Cadre. It records rooms, messages, and injection deliveries; broadcasts messages to room participants; exposes room controls to the dashboard and MCP clients; and reports failed delivery attempts.

The bus is not a workflow engine. Recurring prompt injection is a scheduler feature (loop sessions), not a bus feature.

## Data model

### Agent references

A participant is identified by a concrete session reference:

```json
{ "kind": "codex", "sessionId": "c1a2b3d4" }
```

Adapter-backed agent kinds are `claude`, `codex`, `pi`, and `deepseek`; DeepSeek is omitted from collaboration model catalogs but can participate through its protocol adapter. A dashboard DM uses `{ "kind": "user", "sessionId": "dashboard" }` as its human participant. Human or system participants remain in the room roster but are not injection targets; they read room history through the UI.

### Rooms

The persisted object is still named a thread in storage and REST paths. Product surfaces call it a room.

A room contains an ID, title, optional project key, participants, metadata, timestamps, and one of two statuses:

- `open`
- `closed`

There are no blocked, failed, completed, or controller-driven room states. Message text and participant session state do not change room status.

A normal room has at least two unique participants. Its messages are broadcast: one immutable message is stored, then one delivery is created for every other adapter-backed participant. Any authenticated agent may read or send in a non-DM room without becoming a participant. Membership is a subscription to pushes. The owner (`createdBy`) also receives `type=result` messages when it is neither the sender nor a participant.

### Direct-message rooms

A DM is a private, deterministic pair room. Agent read/send access remains limited to its participants or owner. DMs are excluded from `room_list(scope="all")`. Its metadata contains `dm: true` and a `dmKey` made from the sorted participant references.

`POST /api/agent-bus/dm` accepts `from`, `target`, and a non-empty `body`. Adapter-backed `from`/`target` refs must already exist (404 otherwise). `{ "kind": "user", "sessionId": "dashboard" }` is the only human sender the dashboard uses; the HTTP route still accepts that ref as `from` or `target`. It finds the pair room by `dmKey` across open and closed rooms, reopens a closed pair room, or creates one, then sends. Self-DMs are rejected.

Dashboard-initiated DMs pair `user:dashboard` with the selected agent. The human remains visible in the roster, while delivery fan-out includes only adapter-backed agent sessions. Agent replies are therefore stored in room history without an attempted terminal injection to the dashboard.

### Messages

A message contains:

- `id` and `threadId`
- one `from` agent reference
- `type`, defaulting to `message`
- `body`
- optional `replyTo` and metadata
- `createdAt`

Messages do not contain a destination, acknowledgement requirement, completion signal, controller state, or execution state. Recipients are derived from the room roster and, for results, its owner at send time.

Injected text uses a compact `[ROOM_MESSAGE]` envelope, or `[DM]` for direct messages, including the message `id`. The envelope names the `room_send` tool and `room_context` history read. It does not require a reply; delayed copies and courtesy acks should be skipped. If the target session transcript already contains that message id, delivery is marked injected without a second paste. Protocol injects use a stable `agent-bus:<deliveryId>` idempotency key. Terminal output is not parsed for acknowledgements, replies, completion markers, or control commands.

### Deliveries

A delivery is an injection record for one message/target pair. Its lifecycle has exactly three states:

- `queued`: stored and waiting for the target session to accept input
- `injected`: successfully submitted to the target session
- `failed`: a non-transient injection attempt failed

A busy target stays queued with `holdReason` (`target_busy`, `can_send_false`, `in_flight`, `backoff`) and `willInjectWhenIdle: true`. The observer retries queued deliveries when canonical session capability `canSendNow` becomes true and preserves per-session FIFO behavior. Agent-bus injects require observed turn progress (working/thinking), not pane paste alone.

Only failed deliveries are replay eligible. Replay changes the delivery back to queued, records `replayAttempts` and bounded `replayHistory`, and attempts injection again. Replay is available through the single-delivery and replay-eligible REST endpoints. A failed replay returns to failed.

## Room lifecycle

### Close

`POST /api/agent-bus/threads/:threadId/close` archives the room by changing its status to `closed`. It preserves every participant session and returns the preserved participant references. Agents must own the room, be a DM participant, or every participant must be gone. Pending deliveries block closure unless `cancelPending: true` is supplied.

Use Close when the message history should become read-only but sessions should continue independently. This is the only lifecycle action available for a DM room.

### End

`POST /api/agent-bus/threads/:threadId/end` is available only for non-DM rooms. It closes the room and attempts to terminate its participant sessions. Agents must own the room; operators may always end it. Ending always cancels queued deliveries, including the outcome of an in-flight write.

Before termination, each participant is checked against other open, non-DM rooms. A participant still present in another such room is skipped and its session is preserved. Open DMs do not cause a skip. The response contains:

- `results`: one termination, failure, or skipped result per participant
- `skipped`: the participant references preserved because another open non-DM room uses them
- `thread`: the closed room
- `ok`: false only when a termination attempt failed

Ending closes the room even if a session termination fails.

### Transfer and claim

`POST /api/agent-bus/threads/:threadId/transfer` accepts `{to: {kind, sessionId}}` and changes `createdBy` without subscribing the destination. The current owner or an operator may transfer to an existing agent session. A non-owner agent may claim a room for itself only when the previous owner session is gone; lookup failures do not permit claims.

## REST surface

All paths are under `/api/agent-bus`.

Room reads and writes:

- `GET /threads`: list rooms, optionally filtering by status, project key, or text query over title, ids, participant labels, and message bodies
- `GET /threads/by-participant`: list rooms containing one participant
- `GET /state`: return room snapshots with optional message and delivery collections
- `POST /threads`: create a room for at least two participants
- `GET /threads/:threadId`: return full room metadata, messages, and deliveries
- `POST /threads/:threadId/participants`: add a participant
- `POST /threads/:threadId/close`: close and preserve sessions
- `POST /threads/:threadId/end`: close and terminate eligible sessions
- `POST /threads/:threadId/transfer`: transfer ownership or claim a room with a gone owner
- `DELETE /threads/:threadId`: delete persisted room history
- `POST /messages`: broadcast from an authenticated agent in a non-DM room, or a DM participant/owner
- `POST /dm`: send to a deterministic pair room, creating it when necessary

Delivery inspection and recovery:

- `GET /messages/:messageId/context`
- `POST /deliveries/:deliveryId/replay`
- `POST /deliveries/replay-eligible`

Bootstrap and dashboard support:

- `POST /bootstrap`
- `GET /participants`
- `GET /model-catalog`
- `GET /mcp-health`

The bootstrap route creates or attaches at least two sessions, opens a room, and injects each participant's startup prompt. It has no loop startup mode.

## WebSocket events

The `agent-bus:threads` channel publishes room lists and room create/update/delete summaries. A selected room uses `agent-bus:thread:<threadId>` for snapshots, `message_created`, and `delivery_updated`.

The `agent-bus:alerts` channel publishes `delivery_failed` when a delivery reaches the failed state. Observer errors can also be reported operationally, but they are not collaboration-room attention items.

## MCP surface

The agent-bus MCP server exposes room tools alongside DM, directory, and task tools:

- `room_send(thread_id, body, reply_to?, type?)`: broadcast as the authenticated agent; delivery is enqueued
- `room_context(thread_id, limit?, since?, after?, bodies?, deliveries?, summary_only?)`: read recent truncated room messages (`since` is a message id, `after` is a timestamp); deliveries omitted unless requested
- `room_list(scope?, limit?, offset?)`: default lists owned/subscribed rooms; `scope="all"` lists all open non-DM rooms
- `room_close(thread_id, cancel_pending?)`: archive without terminating sessions; any agent may close a non-DM room without subscribing; DMs require membership
- `room_end(thread_id)`: owner or operator closes a non-DM room, cancels queued deliveries, and terminates eligible sessions
- `room_transfer(thread_id, to: {kind, session_id})`: transfer ownership or claim for yourself after the owner session is gone
- `room_reopen(thread_id)`: any agent may reopen an archived non-DM room without subscribing; DMs require membership
- `agent_dm(kind, session_id, body)`: send a DM as the authenticated agent
- `agent_directory(kind?, state?, limit?, offset?)`: read recent Claude, Codex, and Pi agents with display names and canonical state; defaults to 25 rows, with `nextOffset` for more

MCP actions return compact ids and status in both text and structured content. Read text with `room_context` or `monitor_get_session_output`; list reads default to 25 rows and accept `offset` for more.

Non-DM room read/send/close/reopen access is open; membership controls subscriptions. DMs remain participant/owner-scoped. Ending a room requires its owner or an operator; transfer/claim follows the rules above. The authenticated principal supplies the sender for `room_send` and `agent_dm`; callers cannot impersonate another sender. `collaboration_guidance` is an MCP prompt, not a tool.

## Persistence

`AgentBusStore` persists rooms, messages, and deliveries through the configured JSON state backend, using PostgreSQL or file storage with a file mirror. Runtime file state uses `state.json`; legacy `.agent_bus/state.json` can be read for migration. New messages are also appended under `<stateDir>/rooms/<threadId>/messages.jsonl`. Recent internal events are bounded in memory and are not part of the persisted state snapshot.

## Human In The Loop

Human-in-the-loop behavior is alerts, not actions.

A failed delivery emits a bus alert and appears in the dashboard attention surface. The operator may inspect the room and explicitly replay a failed delivery. Nothing in the bus auto-resumes, clears, re-prompts, closes, ends, or terminates a session in response to an alert, room metadata, message text, or terminal output.

A legacy or stopped loop raises no attention item. Only failed deliveries are bus-derived attention items; ordinary session approvals and prompt-ready behavior remain session concerns.

## Legacy manager-loop history

Older stored rooms may contain `metadata.managerLoop`. That object is inert archived history. The dashboard shows a compact read-only block with its status, iteration count, last decision, and error. The bus does not inspect it for scheduling, lifecycle transitions, attention, message routing, completion, or session control.

All former manager-loop runtime, parsing, and MCP controls have been removed. Recurring prompt injection is a scheduler feature (loop sessions), not a bus feature.

## Managed worktrees

Repositories opt in with a checked-in `.cadre/worktree.json`:

```json
{ "setup": "npm ci", "copy": ["local-settings.json"], "cleanup": "on-merge" }
```

`cleanup` defaults to `off`. Without this config, spawning behaves as before.
`spawn_collab_session` and `spawn_conference_session` accept
`worktree: { repo: "/local/repo", branch: "feat/task", base: "origin/main" }`;
`base` defaults to origin's default branch. Managed spawns require newly created
participants, all using the same directory. Cadre fetches, creates a locked
worktree under `~/.cadre/worktrees/collab`, copies only gitignored paths, then
runs setup with `CADRE_WORKTREE_PATH` and `CADRE_REPO_ROOT` (120-second timeout).
Setup failure removes the fresh worktree before launching any participants.
Room metadata and a marker in git metadata preserve the path, repo, branch, base,
room id and ignored-file baseline.

Link the PR with `watch_pr({ repo, number, thread_id })`. Room end and the PR
merge notification report `worktree: removed` or `worktree: kept (<reason>)`.
Cleanup keeps worktrees when cleanup is off; metadata is missing or invalid;
the linked PR is absent, unmerged or missing its head; local commits are not
in the merged PR (including unpushed commits); tracked or untracked files are
dirty; ignored files appear beyond the setup baseline; another open room or
live session uses the directory; or a GitHub, git, filesystem or session lookup
fails. User git settings cannot hide untracked files. `node_modules` is exempt
only when present in the baseline. Ancestry or containment of every local
commit's stable patch-id proves landing, including rewritten PR commits.

Removal unlocks, unlinks external top-level symlinks without following them,
leaves tracked symlinks for git to remove safely,
uses plain `git worktree remove`, attempts `git branch -d`, and prunes. If safe
branch deletion refuses (for example after squash merge), the worktree is
removed but its branch and tip are retained, with the git reason reported.
After a partial spawn failure, cleanup removes only an unchanged base HEAD
with clean files, the setup baseline, and no shared users; otherwise it reports
why it kept the worktree. Only rollback inside fresh creation uses forced worktree removal; its branch
is deleted only if it still equals the original base commit.
The existing hourly observer sweep checks marked Cadre worktrees whose rooms
are closed or gone with the same checks, and logs every keep reason. Open-room
worktrees and unmarked directories are left alone.

Ignored-file listings exceeding the git command output limit (for example large
nested dependency directories) keep the worktree for operator review.
