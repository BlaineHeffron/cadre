# Modular Agentic Architecture

This repo now separates high-level agent task orchestration from provider/session backends.

## Protocol-first foundation

Structured runtimes use four provider-neutral components. Tmux providers are
unchanged in this phase and remain compatibility transports.

- `modules/agent/process-supervisor.mjs` owns structured `RuntimeInstance`
  lifecycle. It writes a provisioning intent before spawn, binds PID and Linux
  process starttime atomically, starts a separate process group, and verifies
  group-wide TERM-to-KILL termination. A supervisor-owned
  `DUENO_RUNTIME_INSTANCE_ID` marker closes the pre-bind crash window. Boot
  reaping scans only structured ledger entries; it never treats tmux sessions
  as orphans.
- `modules/agent/ndjson-json-rpc.mjs` owns newline framing, frame/no-newline
  limits, write backpressure, pending requests, and the single terminal close
  path. Unknown response IDs are ignored and unknown inbound requests with IDs
  receive JSON-RPC `-32601`.
- `modules/agent/agent-transport.mjs` defines the `AgentTransport` object
  contract and normalized event envelope. `AcpTransport` implements the
  contract for DeepSeek. Capabilities are graded per attempt; unsupported
  operations fail with `unsupported_capability` rather than being silently
  approximated.
- `modules/agent/prompt-blocks.mjs` owns the five prompt block tags (`text`,
  `image`, `audio`, `embedded_resource`, `resource_link`), exact capability
  intersection, and contract-tested future provider wire-mapping helpers.
  `modules/agent/attachment-store.mjs`
  owns content-addressed bytes, session ACLs, quotas, MIME verification, atomic
  persistence, restart cleanup, and workdir-scoped compatibility references.
- `modules/sessions/session-service.mjs` owns stable Fleet sessions, ordered
  generation-fenced attempts, turns, and interactions. Only events from the
  owning generation can update the projection. Stale events remain in the
  journal with `disposition: stale`.

The session lifecycle is
`created -> starting -> ready <-> working`, with permission work passing
through `blocked`, cancellation through `cancelling`, and terminal
`ended`/`interrupted` states. Turn evidence records acceptance, settlement,
and quiescence independently. Fleet never replays a turn whose pre-restart
outcome is uncertain.

### Durable event journal

`modules/sessions/journal-store.mjs` is the event store; it does not use the
JSON snapshot store. File mode writes checksum/length-framed NDJSON WAL files,
allocates sequence numbers under a per-session lock, applies the selected
fsync policy, truncates partial/corrupt tails, supports cursor reads and
compaction, and rebuilds projections by replay. Postgres mode uses dedicated
transactional session-counter and event tables with unique event IDs and
idempotency keys.

Canonical transport events include provenance, schema version, event ID, and
redaction class. The session-state tracker accepts authoritative `protocol`
observations with no TTL decay, so UI, Agent Bus, and HTTP projections consume
one state contract rather than independently inferring ACP state.

### Capability grades

Each attempt publishes protocol/version, delivery and cancellation grades,
structured interaction support, streaming/transcript grades, individual
session operations, recovery mode, MCP attachment/features, identity and Bus
participation, attachment limits, and runtime sharing. DeepSeek publishes
structured delivery, best-effort cancellation (settlement later proves
quiescence), structured permission options, committed-message streaming,
committed-text transcript, exclusive runtime sharing, and no recovery. Its
Dueno attachment is `launch_time_mcp_client`; tools are supported while MCP
resources and prompts are not.

The per-attempt `promptCapabilities` descriptor publishes the intersection of
transport support and Fleet policy, including type and MIME allowlists plus
file/count/session limits. Unsupported types fail explicitly. Tmux advertises
image delivery as `reference`, and its image endpoint requires an explicit
downgrade opt-in and injects a visible compatibility notice; it never silently
turns a typed block into a local path. Codex app-server and Claude stream-json
inline image mapping helpers are contract-tested scaffolding for the later L2
and L3 protocol transports; they are not wired into the current tmux sessions.
The pinned ACP SDK 0.25.1 contract makes `resource_link` baseline support for
every ACP agent; its prompt capability flags separately gate image, audio, and
embedded-resource blocks. Fleet accepts only absolute HTTP(S) or URN resource
URIs and rejects filesystem, relative, and inline-data URI pass-through.

### Authenticated Agent Bus boundary

Every launched attempt receives a generation-bound Agent Bus credential. The
credential store persists only hashes and derives the MCP actor server-side;
caller identity fields are compatibility inputs, not authority. Scope and
thread checks apply to discovery, reads, writes, acknowledgements, monitor
tools, and lifecycle controls. A Dueno-enabled ordinary attempt also receives a
non-operator child-session grant tied to its canonical work directory. It
covers supported interactive, collaboration/conference, one-off, and
recurring-loop creation surfaces while rejecting path escape, live-checkout
targets, existing-session attachment, unconfigured or provider-incompatible MCP
selection, operator-bearer capabilities, destructive session control, and
permission approval. An omitted child selection inherits the sanitized parent
snapshot; explicit non-privileged catalog additions remain valid. Sessions
without Dueno and legacy-untrusted callers receive no child authority.
Privileged scheduled coordinator control remains a separate, narrower policy.

Pi model discovery can vary by process launch context. If a successful fresh
catalog omits one known built-in provider, Fleet retains the bounded built-in
provider/model pairs as launch candidates so catalog prevalidation and the real
launch do not drift (including `xai/grok-4.6`). The provider launch remains the
authority; total discovery/auth failures and unknown model IDs still fail
closed rather than being reclassified as a user-login request.

Tmux resume rotates the credential; all terminal attempt paths revoke it.
`DM_AGENT_BUS_MCP_AUTH=issue_only` is the migration default, so legacy sessions
remain callable but are graded `legacy_untrusted`, never
`authenticated_scoped`. Operators retire them by resume-with-rotation or end
before explicitly selecting `enforce`.

Protocol capabilities remain the source of collaboration eligibility. A
provider is eligible only when the attempt reports
`busParticipation=authenticated_scoped` and the provider's end-to-end Bus
probe is proven. Merely receiving a credential or environment variable does
not satisfy either condition.

For DeepSeek, catalog eligibility is computed from the audited
`@deepseek-ai/dsh-mcp-client` version's E2E evidence rather than a provider
boolean. Per-attempt startup separately requires authenticated discovery of
the send and context-read tools. The capability grade is
`authenticated_scoped` only when both gates hold; package drift, missing
tools, invalid authentication, or discovery failure leaves it ineligible.

## Layers

### Agent interface layer

File:
- `modules/agent/interface.mjs`

Responsibilities:
- expose a unified provider catalog
- spawn interactive sessions through one API
- run one-off tasks through one API
- choose direct execution vs fallback execution mode

HTTP surface:
- `GET /api/agents/providers`
- `POST /api/agents/sessions`
- `POST /api/agents/tasks`

### Provider interface layer

File:
- `modules/agent/provider-interface.mjs`

Responsibilities:
- normalize provider identifiers
- map providers to backend session types and runtimes
- describe one-off execution capabilities

Current provider mapping:
- `codex` -> backend `codex`, runtime `codex`
- `claude` -> backend `claude`, runtime `claude`
- `xai` (`grok` models; `openai`/`chatgpt`/`openai-codex` aliases normalize to `codex`) -> backend `pi`, runtime `pi`, Pi provider `xai`
- `google` (`gemini` alias) -> backend `pi`, runtime `pi`, Pi provider `google`
- `opencode-go` (`opencode` alias) -> backend `pi`, runtime `pi`, Pi provider `opencode-go`

Pi provider and model are separate values. The server requires a compatible external
Pi CLI (`pi`, version 0.80.7 or newer; override with `PI_BIN`). Canonical Node-based Pi
installs require Node.js 22.19.0 or newer. Pi credentials remain owned by Pi. Missing
binary, incompatible runtime, and missing provider credentials produce explicit API errors.
The project runtime is pinned by `.node-version`. Install that exact version before deploying,
then refresh the generated user service so `ExecStart` and `PATH` use the validated binary:

```bash
nvm install
bash scripts/install-fleet-service.sh
bash scripts/server.sh restart
curl -fsS http://127.0.0.1:4310/api/health/ready
```

Readiness reports Pi separately as `components.piProvider`. An unavailable Pi runtime degrades
provider health without blocking Claude or Codex sessions.

## One-off task execution

`POST /api/agents/tasks` runs a task without requiring a long-lived tmux session.

Current behavior:
- no providers advertise direct one-off execution yet
- all one-off tasks use `ephemeral_session_fallback`
- fallback flow is:
  1. create provider session
  2. inject prompt
  3. poll until terminal state
  4. capture output
  5. terminate session automatically

Blocking session states such as `needs_approval` and `needs_confirmation` fail fast and still trigger cleanup.

Example:

```json
POST /api/agents/tasks
{
  "provider": "xai",
  "model": "grok-4.6",
  "workDir": "/path/to/repo",
  "prompt": "Review the last commit for production risks.",
  "timeoutMs": 120000
}
```

Example result:

```json
{
  "status": "completed",
  "provider": "xai",
  "backendType": "pi",
  "runtime": "pi",
  "executionMode": "ephemeral_session_fallback",
  "session": {
    "id": "pi_ab12cd34",
    "sessionName": "pi-ab12cd34",
    "initialPromptInjected": true
  },
  "task": {
    "state": "waiting_for_input",
    "detail": null,
    "output": "...captured agent output...",
    "timedOut": false
  }
}
```

## Interactive sessions

`POST /api/agents/sessions` is the unified interactive spawn API. Existing backend routes remain available:
- `/api/claude/sessions`
- `/api/codex/sessions`
- `/api/pi/sessions`
- `/api/deepseek/sessions` (compatibility facade over Session Service)

Example:

```json
POST /api/agents/sessions
{
  "provider": "xai",
  "model": "grok-4.3",
  "workDir": "/path/to/repo",
  "displayName": "xAI Research Session",
  "initialPrompt": "Audit the queue worker."
}
```

## MCP / Monitor tools

`modules/platform/monitor-mcp.mjs` now exposes:
- `monitor_list_agent_providers`
- `monitor_run_agent_task`
- `spawn_session` routed through `/api/agents/sessions`

Examples:

```json
{"tool":"monitor_list_agent_providers"}
```

```json
{
  "tool":"monitor_run_agent_task",
  "provider":"codex",
  "workDir":"/path/to/repo",
  "prompt":"Summarize the current agent-bus failure modes."
}
```
