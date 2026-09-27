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

A normal room has at least two unique participants. Its messages are broadcast: one immutable message is stored, then one delivery is created for every other adapter-backed participant. The sender must already be a room participant.

### Direct-message rooms

A DM is a deterministic pair room. Its metadata contains `dm: true` and a `dmKey` made from the sorted participant references.

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

Messages do not contain a destination, acknowledgement requirement, completion signal, controller state, or execution state. Recipients are derived from the room roster at send time.

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

`POST /api/agent-bus/threads/:threadId/close` archives the room by changing its status to `closed`. It preserves every participant session and returns the preserved participant references.

Use Close when the message history should become read-only but sessions should continue independently. This is the only lifecycle action available for a DM room.

### End

`POST /api/agent-bus/threads/:threadId/end` is available only for non-DM rooms. It closes the room and attempts to terminate its participant sessions.

Before termination, each participant is checked against other open, non-DM rooms. A participant still present in another such room is skipped and its session is preserved. Open DMs do not cause a skip. The response contains:

- `results`: one termination, failure, or skipped result per participant
- `skipped`: the participant references preserved because another open non-DM room uses them
- `thread`: the closed room
- `ok`: false only when a termination attempt failed

Ending closes the room even if a session termination fails.

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
- `DELETE /threads/:threadId`: delete persisted room history
- `POST /messages`: broadcast from a room participant
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

The agent-bus MCP server exposes seven tools:

- `room_send(thread_id, body, reply_to?)`: broadcast as the authenticated agent; delivery is enqueued
- `room_context(thread_id, limit?, since?, after?, bodies?, deliveries?, summary_only?)`: read recent truncated room messages (`since` is a message id, `after` is a timestamp); deliveries omitted unless requested
- `room_list()`: list all rooms containing the authenticated agent
- `room_close(thread_id)`: close a room without terminating sessions (agent principals may call this)
- `room_end(thread_id)`: dashboard/operator only; close a non-DM room and terminate eligible sessions
- `agent_dm(kind, session_id, body)`: send a DM as the authenticated agent
- `agent_directory()`: list Claude, Codex, and Pi agents with display names and canonical state

Room access is participant-scoped. The authenticated principal supplies the sender for `room_send` and `agent_dm`; callers cannot impersonate another sender. `collaboration_guidance` is an MCP prompt, not an eighth tool.

## Persistence

`AgentBusStore` persists rooms, messages, and deliveries through the configured JSON state backend, using PostgreSQL or file storage with a file mirror. Runtime file state uses `state.json`; legacy `.agent_bus/state.json` can be read for migration. New messages are also appended under `<stateDir>/rooms/<threadId>/messages.jsonl`. Recent internal events are bounded in memory and are not part of the persisted state snapshot.

## Human In The Loop

Human-in-the-loop behavior is alerts, not actions.

A failed delivery emits a bus alert and appears in the dashboard attention surface. The operator may inspect the room and explicitly replay a failed delivery. Nothing in the bus auto-resumes, clears, re-prompts, closes, ends, or terminates a session in response to an alert, room metadata, message text, or terminal output.

A legacy or stopped loop raises no attention item. Only failed deliveries are bus-derived attention items; ordinary session approvals and prompt-ready behavior remain session concerns.

## Legacy manager-loop history

Older stored rooms may contain `metadata.managerLoop`. That object is inert archived history. The dashboard shows a compact read-only block with its status, iteration count, last decision, and error. The bus does not inspect it for scheduling, lifecycle transitions, attention, message routing, completion, or session control.

All former manager-loop runtime, parsing, and MCP controls have been removed. Recurring prompt injection is a scheduler feature (loop sessions), not a bus feature.
