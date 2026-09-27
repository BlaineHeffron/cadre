# DeepSeek Harness

Fleet runs DeepSeek Harness as an ACP server process, not inside tmux. Each Fleet
session owns one `dsh-acp-demo` child process through the shared
`ProcessSupervisor`, and `AcpTransport` exchanges framed newline-delimited
JSON-RPC over stdin/stdout. The legacy `/api/deepseek/sessions/*` routes are
compatibility facades over the provider-neutral Session Service.

DeepSeek is **experimental and opt-in**. Provider preferences default it off.
It is an authenticated Agent Bus participant through Fleet's fixed Dueno MCP
attachment, but is not an MCP one-off task provider and does not accept
caller-supplied MCP profiles, thinking-level, or skills. Typed image prompts
are accepted only when the ACP initialization response advertises image input;
otherwise Fleet returns `unsupported_capability`.

Transcripts are **committed ACP text only**. They are not a full TTY capture.

## Local setup

The ACP server and Cordis plugins referenced by `config/deepseek-acp.cordis.yml`
are pinned project dependencies:

```bash
npm install
```

Fleet prefers `node_modules/.bin/dsh-acp-demo` and falls back to `dsh-acp-demo`
on `PATH`. Set `DEEPSEEK_ACP_BIN` to override.

DeepSeek API authentication must be available to the Fleet process as
`DEEPSEEK_API_KEY`. Never place credentials in the Cordis config. Session
create returns 503 when the binary, config, or API key is missing.

Child processes receive an explicit env allowlist (`PATH`, locale,
DeepSeek/DSH keys). They do not inherit the full Fleet environment. Fleet
resolves the permission mode once per session and pins `DSH_PERMISSION_MODE`,
`HOME`, and `DSH_HOME` into that attempt's session-owned home directory.

Fleet issues a per-attempt Agent Bus bearer and pins it only as
`DUENO_AGENT_BUS_TOKEN` in that allowlisted child environment. A validated
renderer clones the base profile into the Fleet runtime state directory,
pins the selected model and permission mode, and adds
`@deepseek-ai/dsh-mcp-client@0.1.0-rc.8`. Its Authorization header is a Cordis
`!!js` expression that reads the pinned env variable at process launch; the
bearer value is never written to Cordis, argv, session JSON, journals, logs, or
the workspace. The config is `0600` and is removed on startup failure,
attempt exit, delete, or Fleet shutdown; the credential is revoked on the same
paths.

Startup is fail-closed twice: Fleet first authenticates to the loopback Dueno
endpoint and requires the context-read and send tools, then the real Cordis
plugin activates with `failOnStartupError: true` and completes its own initial
tool synchronization before ACP becomes ready. Authentication or discovery
failure returns 503 and never starts the attempt.

## Configuration

- `DEEPSEEK_ACP_BIN`: override the ACP server executable.
- `DEEPSEEK_ACP_CONFIG`: override the Cordis YAML profile.
- `DEEPSEEK_SESSION_ROOT`: override the root for persisted Harness session data.
- `DSH_PERMISSION_MODE`: defaults to `workspace-write`; set to
  `danger-full-access` only when explicitly intended.

Enable the provider in Settings (`deepseekEnabled`) before spawning `deepseek`
sessions. Models: `deepseek-v4-pro` (default) and `deepseek-v4-flash`.

## Termination

Before spawn, Fleet durably records the structured runtime intent. After spawn
it atomically binds process-group ID, PID, and `/proc` starttime. A
supervisor-owned instance marker lets the boot reaper find a child even if
Fleet died between those writes. On delete, Fleet cancels interactions and
in-flight work, then verifies TERM-to-KILL over the process group with PID
fallback. Results use `{ok,status,residual[]}`. Boot reaping touches only
structured attempts and never tmux sessions; the systemd service therefore
remains `KillMode=process`.

## Journal, restart, and cursors

Turns, interactions, normalized transport events, and committed-text history
are stored in the dedicated journal WAL. A Fleet restart never replays an
uncertain prompt. Previously inflight turns become `unknown`, their acceptance,
settlement, and quiescence evidence is preserved, and the session is shown as
interrupted, ended-with-history, and non-resumable.

HTTP consumers can read the ordered journal at
`GET /api/deepseek/sessions/:id/events?after=<seq>&limit=<n>`. WebSocket
subscriptions to `deepseek:session:<id>` accept the same `after` (or `cursor`)
value and receive an `events` page before live deltas.

Every prompt and permission answer records a session-delivery audit entry with
`transactionId` equal to the Fleet turn ID. Operational metrics use only
transport/provider/outcome labels and distinguish `structured_orphan_reaped`
from intentionally surviving tmux sessions.

Permission answers require authenticated operator/UI authority or an explicit
pre-approved service automation policy. An agent or MCP participant cannot
self-approve a DeepSeek tool request. The authority audit records principal,
policy, tool/scope/risk, decision, attempt, and turn.

## Current capability limits

DeepSeek's per-attempt descriptor reports structured delivery, best-effort
cancellation, structured permission options with answer-once ordering,
committed-message streaming, committed-text transcript, exclusive runtime
sharing, no Fleet recovery, `mcpAttachment=launch_time_mcp_client`, and MCP
features `{tools:true,resources:false,prompts:false}`. Its Bus grade is
`authenticated_scoped` only when the pinned-client E2E evidence and the
attempt's authenticated discovery both pass. Collaboration eligibility is
computed from that grade plus E2E proof, not a static provider flag. Unsupported
requests return `unsupported_capability`.

Prompt capability negotiation intersects the attempt's ACP advertisement with
Fleet's exact type, MIME, per-file, per-turn, and per-session policy. Inline
bytes first enter Fleet's content-addressed AttachmentStore. The journal sees
only the verified digest, MIME type, byte length, and safe display name; Fleet
rehydrates bytes only at the ACP write boundary. The store verifies MIME from
content, applies a session ACL, deduplicates equal digests, persists references
atomically, reaps unreferenced objects on restart, and rejects symlink or path
escapes.

## Smoke check

The focused MCP check does not send a model prompt or use a real API key:

```bash
DUENO_DISABLE_SIDE_EFFECTS=1 node --test --test-concurrency=1 \
  tests/deepseek-mcp-integration.test.mjs
```
