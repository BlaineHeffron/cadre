# Durable tasks and Codex App Server

The task API uses existing bus thread metadata and mailboxes, SessionService,
the session journal, and the protocol registry. Codex App Server is an explicit
`codex-app-server` task provider. Ordinary `codex`, Pi, and Claude interactive
sessions retain their existing transports. Unsupported structured task providers
return an error; a tmux injection is never reported as provider acceptance.

Durable records carry `recordType: "dueno.durable-task.v1"`. Legacy room
`metadata.task` values are ordinary metadata and do not enter task recovery,
handshake, input admission, closure or deletion guards.

## Calls

MCP exposes `task_spawn`, `task_send`, `task_wait`, `task_status`, `task_cancel`,
and `task_resume`. The same JSON bodies are accepted by authenticated POST routes
`/api/agent-bus/tasks/{spawn,send,wait,status,cancel,resume}`.

Every call includes `thread_id`, identifying the parent's collaboration room or
the child's dedicated task room. The authenticated principal establishes the
owner. Task IDs, session IDs, attempt IDs, and provider thread/turn IDs are
separate fields; a title never identifies an execution.

```json
{
  "thread_id": "<parent-room>",
  "task_key": "first-child",
  "spec": {
    "provider": "codex-app-server",
    "model": "gpt-6-astra",
    "workDir": "/absolute/authorized/worktree",
    "initialPrompt": "Perform the assigned bounded task."
  }
}
```

Repeating `task_spawn` with the same parent and `task_key` returns the original
task, including uncertain startup outcomes. A managed child must supply its own
`parent_task_id` to delegate. Root task scope allows one further delegation level
and two children, within the same resolved directory and provider. Child MCP
credentials contain only the required room operations and inherited task scopes;
they do not grant ordinary session spawning or room lifecycle control.

`task_send` takes `task_id`, `message_key`, and text `input`. Its default
`mode: "queue"` persists ordinary input while the provider is busy. Explicit
`mode: "steer"` additionally requires `expected_turn_id`, the active Fleet turn
ID returned by status. The adapter maps that identity to the provider turn ID
and calls `turn/steer` with `expectedTurnId`; it does not create another turn.
Normal work uses `turn/start`. Cancellation uses `turn/interrupt` and retains
the distinction between request acknowledgment and a terminal provider receipt.

`task_wait` takes `task_ids`, optional opaque `after`, and `timeout_ms` (0–30000).
It returns events, results, states, and a new cursor. Only passing that cursor
on a subsequent wait acknowledges consumption. Losing a wait response therefore
does not lose the result. The cursor contains independent session/attempt
positions; it is not a global sequence number. Only the immediate authenticated
parent consumes child results. Status remains available separately.

Wait reads persisted journal pages without waiting for background reconciliation
to drain. Passing a cursor requires durable acknowledgment: positive waits bound
that processing by their deadline; a zero-time poll allows up to one second for
acknowledgment and for a reconciliation wakeup so an interrupted attempt's unknown
outcome is visible before resume, then reads the journal without waiting further. `task_wait_timeout` means persistence
was not confirmed in time. Retry the same cursor; an expired queued operation
does not later mutate consumption, while an already-started write may finish.
Wait states omit the repeated provider protocol inventory; `task_status` retains
the detailed negotiated capability evidence.

`task_cancel` takes `task_id`, `request_key`, and optional `scope: "child"` or
`"descendants"`. `task_resume` takes `task_id` and `request_key`. Cancellation
fences admission durably; late real output remains evidence. Resume reconciles
provider history or creates a replacement attempt on the same task. It never
blindly repeats an uncertain external effect.

## Startup and recovery

A durable bootstrap turn asks the child to read its exact task room and reply
through authenticated MCP. Metadata-only lookups, tool visibility, summary reads,
and server preflight do not satisfy this handshake. Ordinary task input waits
for both room operations, matching requested/effective model evidence, protocol
evidence, and provider readiness. Bootstrap output is not a task result.

The adapter generates the protocol schema with the installed Codex binary,
initializes JSON-RPC over stdio, and reports the exact negotiated methods. The
catalog conservatively reports unnegotiated support. Startup model evidence is
the provider's thread response; reroute notifications update the effective model.
Neither is independent attestation of inference identity. Unexpected MCP servers
or tools fail startup before task work is admitted.

Turn outcomes are journaled before result mailbox publication. Reconciliation
republishes missing results after publication failure or restart. Earlier unknown
receipts remain history when later provider evidence resolves an outcome.
Subscriptions are wakeups, while journals and persisted cursors supply the data.

Task mailbox entries have no ordinary bus injection targets: TaskService alone
admits them. Managed task room closure and destructive deletion are guarded while
work or retained results remain. Parent consumption, a minimum retention period
(24 hours by default), and inactive provider attempts precede release. Stable
task/result tombstones survive body deletion. Unknown outcomes remain until
explicit parent consumption and release satisfy the same retention/inactivity gates.

Review approval remains an independent human/agent decision. Transport drain,
task completion, room closure, and review consensus are different events.

## Normal workflow

`task_spawn` → `task_wait` (loop on the returned cursor) → `task_send` / `task_status` → `task_cancel` / `task_resume`. `task_id` is stable across attempts. Retries with the same `task_key`, `message_key`, or `request_key` are safe.

TaskService only binds protocol providers registered via `registerProtocolSessionProvider`. At server start that is `codex-app-server` (experimental; catalog-disabled by default) and `deepseek` (experimental; catalog opt-in). `claude` is registered only when `CLAUDE_STREAM_JSON_ENABLED` is set or `CADRE_STRUCTURED_AUTOMATED_SPAWNS` covers `claude`. `CODEX_APP_SERVER_ENABLED` moves interactive `/api/codex/sessions` onto the app-server transport but does not register `codex` here. `CADRE_STRUCTURED_AUTOMATED_SPAWNS` (`1` or a comma list of `claude`,`codex`; default off) keeps tmux for human and coordinator-authority creates and serves automated `spawn_session`, scheduled spawns, and collab/conference creates on the structured runtime beside them. Ordinary tmux providers (`codex`, Claude tmux, `pi`/`xai`/`google`/…) return `unsupported_provider`. For those, use `spawn_session(parentThreadId)` with `room_send`/`room_context`, and `monitor_send_to_session` plus `monitor_list_session_deliveries`.

`task_status.ownerRef` is the original owner. `currentParentRef` is the live parent session: after `task_resume` of the parent it follows the replacement attempt, so that parent consumes child results without a manual transfer (`replacement parent retains child spawn identity and can consume existing child results` in `tests/task-service.test.mjs`). `mailbox.oldestQueuedAgeMs` is the age of the oldest queued `task_send`. `task_status.result` is only the latest result, so a worker's newer result supersedes an older reported blocker; workers should put blocker, next action, and output paths in the result text and send a fresh result when a blocker is retired. For tmux sessions, `spawn_session` does not create a room (`session.threadId` is empty); pass `parentThreadId` to attach the worker to the coordination room.

Production deployment uses only `bash scripts/server.sh restart` after reviewed
main integration.
