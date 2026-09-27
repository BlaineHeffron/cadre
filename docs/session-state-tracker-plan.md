# Canonical Session State Tracker Plan

## Goal

Replace distributed session-state heuristics with one canonical tracker used by every UI, delivery, automation, and integration consumer. Keep the design small: provider observations, one pure reducer, one per-session command gate, and compatibility projections for migration.

Issue 98's Codex guardrail policy lands after the tracker and command gate are authoritative.

## Non-goals

- Rebuild session persistence, agent-bus, or the terminal viewer.
- Create a generic workflow engine.
- Store full pane captures in canonical state.
- Make hooks mandatory. External and partially configured sessions must degrade safely.
- Infer task completion from terminal idleness.

## Hard invariants

1. Code outside `modules/session-state/` must not infer state from pane text, hooks, transcripts, processes, or provider metadata.
2. Every consumer reads the same immutable canonical snapshot revision.
3. Every automated input path uses the same per-session command gate.
4. A fresh blocking or unknown interaction makes automated messaging unsafe.
5. Hooks describe lifecycle/execution; pane observations describe visible interaction; neither globally overrides the other.
6. Requested model configuration remains distinct from observed effective runtime metadata.
7. Raw observations and reduction reasons remain inspectable for diagnosis.
8. Expired observations cannot sustain a capability; stale pane readiness disables `sendMessage`.
9. State is reconstructible after server restart. In-flight transactions recover fail-closed; persisted queued deliveries resume or receive an explicit dropped audit outcome.

## Minimal canonical contract

```js
{
  sessionId: '...',
  revision: 42,
  updatedAt: 0,
  lifecycle: 'starting' | 'running' | 'ended' | 'missing',
  execution: 'idle' | 'working' | 'thinking' | 'unknown',
  interaction: {
    kind: 'none' | 'free_text' | 'permission' | 'confirmation'
      | 'selection' | 'trust' | 'guardrail' | 'unknown_blocking',
    detail: '',
    options: [],
    fingerprint: '',
  },
  runtime: {
    requestedModel: '',
    requestedThinkingLevel: '',
    effectiveModel: '',
    effectiveThinkingLevel: '',
  },
  capabilities: {
    sendMessage: false,
    clear: false,
    interrupt: false,
    autoClose: false,
    needsAttention: false,
  },
  status: 'starting' | 'working' | 'thinking' | 'ready' | 'blocked'
    | 'awaiting_response' | 'ended' | 'unknown',
  reason: '...',
  degradedReasons: [],
}
```

`status` and `capabilities` are reducer outputs. Consumers must not re-derive them. Delivery transaction details remain owned by the command gate and existing delivery audit; the tracker receives only the minimal delivery observations needed to derive `awaiting_response`, capabilities, and reason.

## Minimal observation contract

```js
{
  source: 'process' | 'hook' | 'pane' | 'transcript' | 'delivery' | 'runtime',
  kind: '...',
  value: {},
  observedAt: 0,
  expiresAt: 0,
  fingerprint: '',
}
```

Only retain the latest relevant observation per source/kind plus a small transition ring buffer for diagnostics. Existing hook/transcript persistence stays where it is; the tracker does not duplicate full histories.

## Source ownership and reduction

| Dimension | Primary evidence | Fallback |
| --- | --- | --- |
| lifecycle | tmux/process existence | hook session lifecycle |
| execution | fresh provider hooks | transcript activity, then conservative pane patterns |
| interaction | current pane structure | hook permission notification |
| delivery | command gate transaction | none |
| runtime | provider metadata/footer | requested spawn metadata |

Rules:

1. Missing process yields `missing`; explicit normal exit yields `ended`.
2. Any fresh pane `permission`, `confirmation`, `selection`, `trust`, `guardrail`, or `unknown_blocking` interaction disables `sendMessage`, regardless of a `prompt_ready` hook.
3. `free_text` enables `sendMessage` only when process is running, no delivery is sending/awaiting response, and the observation is fresh and stable.
4. Fresh hook activity drives `working`/`thinking`; historical spinner or prompt text cannot override it.
5. A delivery remains `awaiting_response` until a post-send hook/transcript/pane transition proves progress or a newer stable free-text prompt proves completion.
6. Contradictory or stale evidence reduces to `unknown`/unsafe and records the reason.
7. Reducer is pure and deterministic: `reduce(previousSnapshot, observationSet, now)`.

## Module shape

```text
modules/session-state/
  contract.mjs          enums, validation, compatibility projection
  reducer.mjs           pure canonical reducer and capability policy
  tracker.mjs           per-session observations, revisions, subscriptions, waits
  providers/
    detector.mjs        adapted existing shared state-detector pattern engine
    claude.mjs          Claude pane patterns only
    codex.mjs           Codex pane patterns/footer parsing only
  command-gate.mjs      serialized automated input transactions
```

Adapt `modules/agent/state-detector.mjs` instead of replacing its normalization/pattern engine; preserve its existing fixture coverage while changing its output to pane observations. Avoid separate observer classes unless stateful behavior becomes necessary. Hooks, process discovery, transcripts, and existing pollers call `tracker.observe(...)` directly.

Public tracker API:

```js
observe(sessionId, observation)
get(sessionId)
subscribe(sessionId, callback)
waitForCapability(sessionId, capability, options)
explain(sessionId)
remove(sessionId)
```

Only `command-gate.mjs` performs automated text submission. Manual raw terminal controls remain explicitly unsafe administrative escape hatches and are not used internally.

## Consumer migration inventory

All these consumers must use canonical snapshots/capabilities:

- session list/detail and WebSocket broadcasts;
- Agents panel cards and filters;
- attention items, browser notifications, and alerts;
- agent-bus delivery observer and participant startup;
- manager/Ralph loops;
- command-center supervisor auto-sends;
- unified agent-interface task polling and state buckets;
- agent-bus participant activity/completion projections;
- monitor MCP list/output/send tools;
- Telegram relay and answer routing;
- scheduled-agent session lookup and delivery;
- startup prompt injection;
- scheduled sends;
- clear/autoclose behavior;
- approval-answer, dialog-key, and other typed terminal actions;
- runtime hooks and delivery audit records.

Compatibility projection may expose current `state`, `needsInput`, `inputType`, `detail`, and `safe_to_message` fields during migration. The projection is produced only by `contract.mjs`; consumers may not construct it.

## Command gate

Each session has one FIFO queue and one active transaction:

1. Enqueue delivery with ID, source, text, and optional deadline.
2. Wait for canonical `sendMessage` capability.
3. Re-read snapshot immediately before input; require unchanged revision and pane fingerprint.
4. Mark `sending`, paste literal text, press Enter, mark `awaiting_response`.
5. Wait for canonical evidence of progress/completion.
6. Retry only classified transient failures. Preserve queued delivery on unsafe state.
7. Record every transition in existing delivery audit storage.
8. Replace agent-bus observer per-reference input serialization with delegation to this gate. The gate is the sole per-session serializer; agent-bus delivery state consumes gate outcomes and never submits terminal input directly.

Startup input, `/clear`, dialog policies, and normal messages use typed gate operations. This keeps policy explicit without creating multiple send implementations.

## Implementation slices

### 1. Evidence and contract

- Inventory every state inference and automated input call.
- Add sanitized pane/hook/transcript fixtures for normal and blocking Claude/Codex states.
- Add contract, reducer table tests, and safety invariants.
- Add compatibility projection-equivalence tests against every existing detector/reconciler fixture; document intentional safety divergences.
- No production behavior change.

Acceptance:

- Expected state/capabilities documented for every fixture.
- Invariant test: fresh blocker always disables `sendMessage`.

### 2. Tracker in shadow mode

- Add tracker and observation adapters.
- Feed it from existing capture, hook, process, transcript, and pending-delivery paths.
- Attach non-authoritative `canonicalState` and mismatch diagnostics to internal/session debug output.
- Keep legacy state authoritative.

Acceptance:

- One observation/reduction path per session despite list/detail/WebSocket polling.
- Mismatches explain sources, ages, and reduction reason.
- Restart with an interrupted transaction reconstructs an unsafe snapshot and deterministically resumes or audits persisted delivery.

### 3. Read-consumer cutover

- Make session APIs and broadcasts publish the compatibility projection from canonical state.
- Migrate Agents panel, attention, alerts, Telegram, MCP listing, autoclose, and manager-loop reads.
- Convert Telegram relay's independent capture/classification pipeline into tracker observations; remove its hook-state mapping and stopped-state set at cutover.
- Remove consumer-local readiness/status predicates as each consumer moves.

Acceptance:

- Same snapshot revision/reason visible through API, UI, MCP, Telegram, and agent-bus.
- No consumer parses pane/hook content for state.

### 4. Command-gate cutover

- Implement FIFO per-session gate.
- Route monitor MCP, agent-bus, UI, Telegram, scheduled sends, manager loops, startup input, and clear through it.
- Unsafe transitions keep deliveries queued; they never type into dialogs.
- Retain raw tmux input endpoints only for explicit manual use.

Acceptance:

- Race tests cover a dialog appearing after readiness but before paste.
- Concurrent senders preserve FIFO order and produce one audit trail.
- Concurrent agent-bus, Telegram, and scheduled sends share the same FIFO; no second observer queue exists.
- `/clear` and approval/dialog answers are tested typed operations with capability checks.

### 5. Guardrail and effective-runtime policy

- Add exact Codex guardrail fixtures and structural observer.
- Add idempotent typed gate operation selecting option 2, `wait for verification`.
- Confirm dialog fingerprint clears before releasing queued input.
- Parse effective model/thinking footer values into runtime observations.
- Surface requested/effective mismatch without changing requested resume configuration.

Acceptance:

- Guardrail always blocks normal input and chooses option 2 once.
- Silent model downgrade appears as mismatch/attention.

### 6. Cleanup and enforcement

- Delete legacy reconciliation, duplicated state caches, pending overlays, and local predicates.
- Add architecture test allowlists across `modules/` and `public/` for `capture-pane`, detector imports, raw `waiting_for_input` comparisons, automated `send-keys`/input calls, and client-side status/capability derivation.
- Document tracker contract and debugging workflow.

Acceptance:

- `rg`/architecture tests show no state inference outside approved tracker modules.
- Browser code only renders server-projected status, capabilities, reason, and revision.
- Existing session, agent-bus, Telegram, MCP, UI, and lifecycle suites pass.

## Efficiency and reliability

- Deduplicate pane captures per session/poll tick; list/detail/WebSocket consumers share one tracker snapshot.
- Reduce only when an observation fingerprint changes or expires.
- Broadcast only when canonical revision changes.
- Bound diagnostic observations and transition history.
- Use event-driven hooks/transcripts when available; low-rate pane/process polling remains safety fallback.
- Serialize only per session; different sessions proceed concurrently.

## Rollout and rollback

1. Shadow tracker behind a config flag, enabled in development/tests.
2. Compare legacy/canonical results using structured mismatch logs.
3. Cut over read consumers while retaining legacy compatibility fields.
4. Cut over writes only after false-ready fixture/race tests pass.
5. Remove flag and legacy engine after one stable production observation window.

Rollback before cleanup: switch API projection and command routing back to legacy paths. Observation code remains passive.

## Definition of done

- Exactly one canonical tracker owns session state and capabilities.
- All consumers use its snapshots or subscriptions.
- All automated input uses its command gate.
- Unknown and blocking states are fail-closed.
- UI and integrations expose identical state revision and reason.
- Requested/effective runtime metadata remain distinct.
- Issue 98 behavior is fixture-tested, idempotent, audited, and race-safe.

## Implemented contract and debugging workflow

Authoritative state lives in `modules/session-state/`. Providers emit bounded observations; `reducer.mjs` alone derives status, reason, interaction, runtime, and capabilities. Session APIs expose the immutable snapshot as `canonicalState` and expose only `contract.mjs`'s legacy compatibility projection as `state`.

Debug one session in this order:

1. Read `canonicalState.revision`, `status`, `reason`, `degradedReasons`, and requested/effective runtime fields from the session detail API.
2. Use `sessionStateTracker.explain(canonicalSessionStateId(provider, id))` in local diagnostics to inspect retained observation sources, timestamps, expiry, and transition history. Pane contents are not retained.
3. Correlate the transaction ID through delivery-audit states: `queued`, `sending`, `awaiting_response`, then `sent`/`failed`/`dropped`.
4. Treat `unknown`, expired evidence, blockers, and interrupted restart transactions as unsafe. Do not bypass the gate except through the explicit manual terminal API.

Architecture tests enforce the capture, detector, legacy-readiness, client-derivation, and automated-input boundaries.
