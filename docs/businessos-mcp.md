# BusinessOS MCP

Fleet supports the optional BusinessOS MCP server as an opt-in agent tool surface.

- Callers opt in with the canonical ID-only request `mcpServers: { add: ["businessos"], remove: [] }`, optionally combined with `mcpProfile`.
- Fleet rejects caller-supplied MCP URLs, commands, paths, arguments, environment values, and legacy selection aliases.
- Fleet injects only a loopback capability URL into the selected agent launch. It does not persist BusinessOS into workspace-global `.mcp.json`, `.codex/config.toml`, or `.claude/settings.local.json`.
- Persisted session metadata contains only the sanitized resolved capability snapshot; it never contains the proxy capability URL or token.
- The BOS bearer token is stored server-side under `.dueno/state/businessos_mcp_sessions.json` with mode `0600`.
- The loopback proxy injects `Authorization: Bearer <token>` when the agent connects. The token is not written to prompts, thread metadata, transcripts, or agent workspace config.
- Session cleanup removes the capability mapping, so stale capability URLs stop working.

Config:

```env
BUSINESSOS_MCP_URL=https://businessos.example.com/api/agent-mcp
BUSINESSOS_MCP_OPERATOR_TOKEN=...
BUSINESSOS_MCP_PROXY_PATH_PREFIX=/businessos-mcp
AGENT_BUS_MCP_HTTP_HOST=127.0.0.1
```

Use a dedicated, revocable, scoped `operator_users` personal token for `BUSINESSOS_MCP_OPERATOR_TOKEN`. Do not reuse a broad shared operator token unless no scoped token exists yet.

The BusinessOS proxy refuses service unless the agent-bus MCP HTTP server is bound to loopback and the caller is loopback.

Fleet does not add send/publish/approve/provider-write behavior. It only proxies the BOS MCP endpoint; BOS keeps enforcing its own tool scope, staged-draft posture, and `mcp:` actor stamping.
