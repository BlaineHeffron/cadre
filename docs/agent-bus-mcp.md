# Agent Bus MCP

The loopback Streamable HTTP endpoint supports MCP `2026-07-28`'s sessionless
lifecycle plus legacy initialize-based clients. Modern requests must carry the
protocol/client-capability `_meta` envelope and matching `Mcp-Method` / `Mcp-Name`
headers. The server never emits `Mcp-Session-Id`; static list results advertise a
five-minute private cache lifetime.

Agent Bus MCP HTTPS requests verify TLS by default.

For local development against a self-signed monitor certificate, set:

```sh
DUENO_MONITOR_ALLOW_INSECURE_TLS=1
```

This disables certificate verification only for Agent Bus MCP HTTPS requests. It does not set `NODE_TLS_REJECT_UNAUTHORIZED`.

## Per-attempt authentication

Fleet issues an opaque, least-privilege bearer for every new Claude, Codex, Pi,
and DeepSeek attempt. Its server-side record binds the principal
`{type, kind, sessionId}`, attempt generation, `dueno-mcp` audience, `dueno`
server allowlist, thread allowlist, exact tool scopes, expiry, and `jti`. Only a
SHA-256 hash is persisted; plaintext bearer values are excluded from session
registries, journals, API responses, launch logs, and workspace files.

The credential principal is authoritative. In `enforce`, a supplied
`from_kind` or `from_session_id` that differs from it is rejected. Read tools
and write tools both enforce exact scope and thread access. `@member` means the
principal must actually occur in that thread's participants; it is not a
global grant. An explicit thread id in the allowlist is sufficient even when
`@member` is also present. Agent principals cannot use operator, destructive
session-control, or permission-answer tools even if a malformed credential
includes such a scope. An authenticated Cadre session receives the spawn tools
without a separate child-session policy or coordinator provenance. Legacy
unauthenticated callers cannot discover or call these tools.

An interactive session launched directly by an authenticated UI operator still
receives the separate non-inheritable delegation needed to create the
privileged `coordinator-v1` schedule profile. The registration route verifies
that delegation, discards caller-supplied trusted metadata, and expands the
profile server-side. Read-only extra tools remain available when the credential
lists that exact scope. UI and service credentials require explicit thread and
tool grants; they receive no implicit `@member` grant.

Delivery keeps the bearer out of process argv and tmux pane commands:

- Claude and Pi receive a session-owned `0600` client config below the Fleet
  runtime state directory. The config is removed when the attempt ends.
- Codex 0.148 uses `bearer_token_env_var`. The shell reads the value from a
  session-owned `0600` runtime-state token file; argv contains only the env-var
  name and the pane command contains only the file path.
- DeepSeek receives the bearer only in its supervisor-pinned child env. Fleet
  renders a session-owned `0600` Cordis config containing only the
  `DUENO_AGENT_BUS_TOKEN` expression, never its value. The pinned
  `@deepseek-ai/dsh-mcp-client@0.1.0-rc.8` connects over Streamable HTTP with
  `failOnStartupError`; Fleet also performs authenticated required-tool
  discovery before spawning ACP. Attempt exit removes the config and process
  teardown disposes the Cordis MCP effect before Fleet revokes the bearer.

Resume rotates the credential and increments the generation. Attempt exit,
startup failure, termination, missing-process pruning, and Fleet shutdown
revoke it. A revoked/superseded `jti`, wrong audience/server, or stale attempt
generation fails authentication. Active credentials do not expire; they stay
valid until rotate or revoke.

DeepSeek advertises `mcpAttachment=launch_time_mcp_client`, tool support only
(`resources=false`, `prompts=false`), and `busParticipation=authenticated_scoped`
only for the audited client version covered by the real client/Fleet HTTP E2E.
That E2E lists Dueno tools, sends a scoped message, reads it back from the test
thread, and verifies client disposal. A missing/drifted package version or a
failed per-attempt discovery makes the grade and collaboration eligibility
false rather than falling back to legacy access.

## Rollout modes

`DM_AGENT_BUS_MCP_AUTH` accepts:

- `off`: migration escape hatch; no credentials are issued or enforced.
- `issue_only` (default): new attempts receive credentials while legacy MCP
  calls remain available as `legacy_untrusted`. Legacy calls never qualify as
  authenticated collaboration and cannot answer permissions or send direct
  session input.
- `enforce`: missing or invalid credentials are rejected. This release never
  enables it automatically.

Before an operator enables `enforce`, call
`GET /api/agent-bus/auth/readiness` (or
`monitor_agent_bus_auth_readiness`). For each listed live session with no
credential, resume it to rotate in a credential or end it. Re-run readiness
until `readyForEnforce` is true.

## Permission authority and audit

Agent Bus credentials do not confer permission-approval authority. MCP
identity is carried from the authenticated dispatcher to Fastify through a
one-use, server-minted in-process handle; inbound clients cannot assert that
handle or a principal header. Blocking tmux `/keys` and `/input` routes consult
the live interaction snapshot even when the caller omitted a fingerprint.
Only an authenticated UI operator or a service principal with a configured
pre-approved automation policy may answer. Audits record actor, policy, tool,
scope, risk, decision, attempt, turn, and interaction.

Low-cardinality counters cover authentication accept/reject reason, issued /
rotated / revoked credentials, and legacy-untrusted calls. Rejected calls are
also retained in the credential audit without bearer material.

## Room context output

`room_context` returns one JSON payload in MCP text content, with messages and
counts and thread identity by default. Pass `metadata=true` to include thread health, delivery health,
and participant status; `deliveries=true` separately includes delivery records.
Bodies default to at most 3,000 characters each. Continue longer messages with
`message_id` and `body_offset=nextOffset`, or use `body_limit` for smaller pages.
