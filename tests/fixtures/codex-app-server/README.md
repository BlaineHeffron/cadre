# App Server subprocess fixture provenance

Protocol source: https://learn.chatgpt.com/docs/app-server (retrieved 2026-09-07).
Installed evidence: `codex-cli 0.153.4`, stable output of
`codex app-server generate-json-schema --out <temporary-directory>`.
`ClientRequest.json` SHA-256:
`25bc001b5dfe3b35785597b8f9ad9e5aaf7e437331fa9921f041c9e0e03fc9f3`.

`provider.mjs` is a synthetic subprocess implementing the documented wire forms,
with deliberate admission, notification-order, framing, death, approval, and
recovery scenarios. It is not a captured model transcript. Tests launch it through
Node and the real ProcessSupervisor/NDJSON codec; schemaReader is the explicit
fixture seam. Production generates evidence from its installed binary.

An authorized disposable real-provider smoke on that CLI successfully initialized,
started ephemeral thread `01a07c7c-8381-7be0-a85d-680e2cc0ff1f`, and completed turn
`01a07c7c-96ba-79c0-af36-4b3aae093a0b` with `APP_SERVER_SMOKE_OK`. Requested and
thread/start response model were both `gpt-6-astra`; that is configured-model
response evidence, not inference attestation. The prompt prohibited tool calls,
file access, credential access and delegation. Its process was terminated.

The smoke's MCP inventory contained eight servers despite `mcp_servers={}`.
It did not establish scoped room read/reply. The wrapper disables
unselected discovered servers at their top-level or plugin configuration scope
and rejects remaining exposed unexpected MCP servers/tools
before admitting a prompt. The task handshake must still observe authenticated
room read and reply independently.

## Scoped wrapper smoke

`scripts/smoke-codex-app-server.mjs` starts a disposable local MCP HTTP endpoint
with an in-memory credential store and uses the real provider wrapper. Run only
with explicit real-provider authorization and the repository's safe flags. It
never reads or copies credential files, changes global configuration, or sends
to a real Fleet room. The MCP bearer exists only in memory and child environment.

Successful 2026-09-07 receipt: provider thread
`01a07c8e-cf6a-7cb0-a392-4024b61414a9`, requested/effective `gpt-6-astra`;
Dueno connected with exactly `room_context` and `room_send`; six other inventory
rows explicitly `disabled` with no tools. The model successfully called both
operations as authenticated principal `codex-app-server:disposable-app-server-smoke`
on `disposable-app-server-room`, stored one `APP_SERVER_SCOPED_SMOKE_OK` reply,
and completed its turn. Local log: `/tmp/dueno-app-server-scoped-smoke.log`.

Isolation uses the documented configuration scopes from
https://learn.chatgpt.com/docs/config-file/config-reference : `features.apps`,
`mcp_servers.<name>.enabled`, and
`plugins.<pluginId>.mcp_servers.<name>.enabled`. The installed inventory's
`pluginId` identifies the correct scope. Thread configuration repeats the safe
Dueno endpoint/token-environment reference and limits exposed tool names.
Authenticated discovery requires explicit `mcp:discover`; caller-supplied scopes
are never silently widened. Only the two bounded room handshake tools receive
per-tool `approval_mode=approve`. Other tools retain provider approval handling.
