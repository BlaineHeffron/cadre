# Production Controls Runbook

## Logs

Live server and HTTP Agent Bus MCP diagnostics have one source: journald for
`dueno-fleet`. Fastify/Pino writes stdout; the installed user service sends both
stdout and stderr to the journal. Journald rotates automatically. Follow the last
N lines (50 by default) with:

```bash
bash scripts/server.sh logs [N]
# Or directly:
journalctl --user -u dueno-fleet --no-pager -n 50 -f
```

`logs/server.log` is a removed legacy destination; use journald. The unused
stdio MCP script that wrote `logs/agent-bus-mcp.log` has also been removed. Operators
may archive or delete those two stale files from existing checkouts. No current Cadre writer uses
`logs/`. Paths in repo-quality test fixtures are sample data, not live writers.

### File inventory and retention

Paths below are defaults. `CADRE_STATE_DIR` (legacy `DM_STATE_DIR`) overrides
`.dueno/state`; `AGENT_BUS_STATE_DIR` separately overrides the bus state directory.

| Destination | Writer / still active | Rotation or retention |
| --- | --- | --- |
| `.dueno/state/agent_launch_logs/<session>.log` | Session launcher creates the file; tmux CLI stderr is appended by `tee` | No size rotation; reset for each launch, removed on failed launch or session artifact cleanup. Can grow during a long session; not the service log. |
| `.dueno/state/agent_bus/events.ndjson` | Agent Bus store appends event mirrors | Append-only, no file rotation; the in-memory 500-event limit does not cap this file. Retained history, not disposable diagnostics. |
| `.dueno/state/agent_bus/rooms/<thread>/messages.jsonl` | Agent Bus store appends room message mirrors | Removed with eligible closed rooms after 30 idle days by default (`AGENT_BUS_CLOSED_THREAD_RETENTION_DAYS`); durable task rooms and parents are retained. No size rotation. |
| `<project>/.agent_bus/hooks/<provider>-<session>.jsonl` and `hooks/state/<provider>-<session>.json` | Agent lifecycle hooks append events and derive session state | Removed in background on session deletion. Otherwise, the Agent Bus observer removes event/state pairs after 7 days without event-file modifications when the session is absent from every registry or marked ended (`CADRE_HOOK_EVENTS_RETENTION_DAYS`). Live sessions are retained regardless of age; hooks from outside Cadre count as absent. No size rotation. |
| `.quality/repo-quality/escaped-defects.jsonl` | Repo-quality check appends its defect ledger when recording outcomes | No rotation; development quality evidence, not a live service log. |

`CADRE_HOOK_EVENTS_RETENTION_DAYS` defaults to `7`; `0` removes eligible files on
the next sweep, and a negative value disables age-based pruning. Sweeps run at
most once an hour, starting one hour after observer startup, and follow the
production side-effect gate. Each sweep
resolves at most 16 registry workDirs and reads at most 128 directory entries
across at most 4 hook directories. It never searches for projects: up to 256 known
roots are remembered in `.dueno/state/hook_event_roots.json` (or the configured
JSON store), including roots from earlier sweeps; missing hook directories are
dropped. Additional roots wait until a remembered root disappears. Only exact
provider/session event filenames and their paired state files are removed.
Tmux registries mark finished sessions with `endedAt`; structured registries use
`lifecycle: ended`. Interrupted sessions are conservatively retained.

State/audit JSON stores and provider-owned transcripts are retained application
history, not alternative service log destinations. Do not delete them as stale
log cleanup.

### Host journal retention

Retention is host configuration, not repository configuration. Recommended
`journald.conf` drop-in (for example
`/etc/systemd/journald.conf.d/retention.conf`):

```ini
[Journal]
SystemMaxUse=1G
MaxRetentionSec=14day
```

These limits apply to the host journal, including persistent user-service
journals, not just Cadre. With volatile journal storage, also set
`RuntimeMaxUse=256M`. Size pressure can remove entries before the age limit;
check usage with `journalctl --disk-usage`. Host configuration and any journald
restart require separate operator action.

## Headroom context compression

Headroom is enabled by default for Fleet agent launches. Settings → Agent Providers →
Enable Headroom context compression persists `headroomEnabled` in the existing provider
preferences store. It affects new sessions, one-off task sessions, and resumed CLI
processes. Running sessions retain their launch routing; turning the setting off does
not interrupt them. No global CLI configuration or credential files are modified.

The user service `dueno-headroom.service` listens on `127.0.0.1:8787` and survives Fleet
restarts. `scripts/server.sh start|restart|update` installs/starts it using
`scripts/install-headroom-service.sh`. Headroom 0.37.0 must already be installed at
`~/.local/bin/headroom` (`uv tool install --python 3.13 'headroom-ai[proxy]==0.37.0'`).
The service uses cache mode and lossless compression, with ML compression, memory,
subscription polling, semantic caching, rate limiting, external telemetry, and persistent
request storage disabled. The default OpenAI-compatible upstream is DeepSeek because
DSH cannot attach a routing header; other clients identify their upstream per request.

| Fleet runtime | Routing |
| --- | --- |
| Claude (tmux and stream-json) | Per-process `ANTHROPIC_BASE_URL` |
| Codex (tmux and App Server) | Per-process `dueno-headroom` custom provider with OpenAI authentication and upstream header; built-in provider IDs are never overridden |
| Pi: xAI, Google, OpenCode Go, OpenRouter | Fleet extension retains model IDs and wire formats, redirects endpoints, and supplies each model's upstream header |
| DeepSeek ACP | Allowlisted per-process `DEEPSEEK_BASE_URL` |

Launch preflight requires the pinned, ready Fleet Headroom service with its expected
DeepSeek default upstream (not an unrelated proxy occupying port 8787); otherwise it returns
`503 headroom_unavailable`. Fleet itself remains available so operators can disable
compression in Settings. Check `systemctl --user status dueno-headroom.service` and
`curl -fsS http://127.0.0.1:8787/readyz` when diagnosing availability. Smoke/test servers
with side effects suppressed do not route agents through the production proxy.

Run `node --test tests/headroom.test.mjs` for preferences and launch behavior. The
optional wire test uses real Headroom and Pi with a local fixture upstream and fake
in-memory credentials; no provider calls are billed:

```bash
HEADROOM_BIN=/absolute/path/to/headroom \
PI_SDK_PATH=/absolute/path/to/pi-coding-agent/dist/index.js \
node --test tests/integration/headroom.test.mjs
```

The browser toggle test runs with `CHROMIUM_BIN=/absolute/path/to/chromium node --test
tests/integration/headroom-settings.test.mjs` and uses the real Settings page and
preferences API against a temporary store.

Run `CODEX_BIN=/absolute/path/to/codex node --test tests/integration/codex-headroom.test.mjs`
to exercise the installed Codex CLI with Fleet's generated launch arguments, an isolated
Codex home, fake credentials, and a local Responses fixture. This catches config parser
regressions (including reserved built-in provider IDs) before any live provider call.
The custom provider retains the OpenAI routing header; an endpoint-only override would
send API-key Responses requests to the proxy's default DeepSeek upstream.
`OPENAI_BASE_URL` alone does not redirect ChatGPT-subscription Codex at all: it opens
`wss://chatgpt.com/backend-api/codex/responses` directly and bypasses Headroom. To confirm
routing, point the provider `base_url` at a closed port; Codex must report `waiting for
network` rather than answer. `node --test tests/headroom.test.mjs` also loads the generated
config through the installed Codex CLI when one is on `PATH`.

## Agent process isolation

- Fleet-launched sessions run in transient `dueno-agent-<provider>-<session>.scope` units below `dueno-agents.slice`.
- `scripts/server.sh start|restart|update` installs the aggregate slice before starting Fleet.
- Aggregate defaults are `TasksMax=8192`, `MemoryHigh=32G`, and `MemoryMax=40G`; override them with the corresponding `CADRE_AGENTS_SLICE_*` variables when installing.
- Per-session defaults are `TasksMax=1024`, `MemoryHigh=4G`, and `MemoryMax=8G`; override them with `CADRE_AGENT_SCOPE_TASKS_MAX`, `CADRE_AGENT_SCOPE_MEMORY_HIGH`, and `CADRE_AGENT_SCOPE_MEMORY_MAX` in the Fleet service environment.
- A successful Kill requires the session scope and any stamped legacy processes to be gone before session metadata is removed.

## Auth secrets

If `AUTH_TOKEN`, `INTERNAL_BYPASS_TOKEN`, and `BROWSER_SESSION_SECRET` are all
unset, the process may start; API requests still fail closed as unconfigured.
If any of those secrets is set, all three must be set and pairwise distinct or
startup exits. Generate them with `scripts/generate-token.sh`. Do not reuse
`AUTH_TOKEN` for bypass or cookie HMAC. Internal bypass is accepted only from a
direct loopback client; requests that include `X-Forwarded-For` or `Forwarded`
are rejected.

## Runtime Kill Switches

- Inspect current effective flag state at `GET /api/ops/controls`.
- Review operator override history at `GET /api/ops/controls/audit`.
- Set a runtime override with `PUT /api/ops/controls/:flagKey/override`.
- Clear a runtime override with `DELETE /api/ops/controls/:flagKey/override`.
- Runtime overrides persist to `.production_controls.json` and are included in state backups.

## Current Flags

- `agentBus.deliveryReplay`: controls replay of failed or timed-out Agent Bus deliveries.

## Agent Bus MCP authentication rollout

`CADRE_AGENT_BUS_MCP_AUTH` is a startup rollout setting, not a runtime kill
switch. Its default after P2-A is `issue_only`. Do not change it to `enforce`
as part of deployment automation or this release.

Before a deliberate enforcement change:

1. Read `GET /api/agent-bus/auth/readiness` using operator authentication.
2. Resume every listed legacy session (which rotates in a generation-bound
   credential) or end it.
3. Confirm `readyForEnforce=true` and `missingCredentialCount=0`.
4. Review rejected-call audit and the counters
   `agent_bus_mcp_auth_accept_total`, `agent_bus_mcp_auth_reject_total`,
   `agent_bus_mcp_token_issued_total`,
   `agent_bus_mcp_token_rotated_total`,
   `agent_bus_mcp_token_revoked_total`, and
   `agent_bus_mcp_legacy_untrusted_total`.
5. Set `CADRE_AGENT_BUS_MCP_AUTH=enforce` through the normal managed environment
   change and restart procedure only with explicit operator approval.

Unexpected reject growth is a rollback signal. Return to `issue_only`, retain
the rejected-call audit, rotate affected attempts by resume, and investigate
the reason label. Never copy bearer values into incident notes or logs.

## Agent child creation and privileged loop registration

An authenticated Cadre session may spawn children and ordinary loops without a
separate child-session policy.

An interactive agent launched directly by an authenticated UI operator also
receives a separate per-attempt loop-registration delegation. That delegation
is required only for the privileged `coordinator-v1` profile; it is not the
authority boundary for ordinary child creation. Scheduled agents, GitHub
agents, one-off tasks, coordinator children, and agent-spawned sessions do not
inherit the privileged coordinator delegation.

For an ordinary recurring task, the agent supplies the normal schedule fields.
For a policy-bound coordinator, it selects the server-owned `coordinator-v1`
profile and supplies only the policy parameters:

```json
{
  "workDir": "/absolute/path/to/coordinator-workdir",
  "prompt": "Run one bounded coordinator tick.",
  "intervalSeconds": 1800,
  "provider": "codex",
  "model": "gpt-6.1-sol",
  "controlProfile": "coordinator-v1",
  "coordinator": {
    "policyId": "protocol-o5",
    "repositories": ["owner/repository", "owner/second-repository"],
    "projectRoots": ["/absolute/path/to/approved/worktree-root"],
    "protectedSessionIds": ["session-id"]
  }
}
```

Use `repository` for a legacy single-repository policy or `repositories` for a
bounded allowlist of up to eight repositories. If both are present, the legacy
`repository` value must also appear in `repositories` and remains the primary
`repository` field. Repository matching is case-insensitive. GitHub PR/issue
sessions may match any allowlisted repository. Owned-session and owned-thread
provenance must carry the same allowlist set as the live policy; changing the
allowlist drops previous owner stamps.

Fleet discards caller-supplied schedule metadata, resolves every root to a real
non-live path, requires the scheduled work directory to be within those roots,
forces the `dueno` MCP profile, stamps the trusted policy metadata, and binds
the policy to the generated schedule ID when a tick launches. The registering
agent cannot choose tool scopes, pass bearer material, delegate its privileged
registration grant, or grant that profile to the coordinator child. Missing or
ambiguous policy fields fail closed. This control does not change
`CADRE_AGENT_BUS_MCP_AUTH` or broaden the ordinary workdir-bound child policy.

A policy-bound tick may list only its own schedule, Codex/Pi sessions it owns
or that carry trusted GitHub provenance for the configured repository, and
threads under approved project roots or stamped coordinator ownership;
inspect those sessions' output; prompt eligible sessions; terminate finished
owned sessions (`sessionEnded` or lifecycle ended/missing); spawn collaboration
sessions only beneath the approved real paths (`workDir` or `projectKey` may
be omitted when the other is a real in-root path); and cancel only its own
schedule. GitHub matching is repository-wide by design (any trusted PR/issue
session on that repo). Interaction answers, foreign schedules or repositories,
unrelated loops, protected sessions, live-checkout paths, deployment/restart
controls, and auth-mode changes remain denied. Protected session IDs come from
the operator policy list, not a hardcoded production identity.

Every privileged attempt writes a `coordinator_control` audit record containing
the policy ID, schedule ID, tool, target, outcome, and denial reason. Audit
records must never include MCP bearer material. Delegated registrations write a
separate `loop_registration` audit record and increment
`loop_registration_total` by outcome.

## DeepSeek Agent Bus release gate

DeepSeek remains opt-in. Before enabling it for collaboration after a package
or lockfile change, run `tests/deepseek-mcp-integration.test.mjs` and the full
test suite. The focused test must prove the exact pinned dsh MCP client can
discover Dueno tools, send and receive in its scoped thread, and dispose its
registrations. A package version other than `0.1.0-rc.8` makes the provider
catalog report no authenticated Bus grade and therefore no collaboration
eligibility.

Session startup returning `deepseek_mcp_discovery_failed`,
`deepseek_mcp_tools_missing`, or `deepseek_mcp_credential_required` is a
fail-closed result. Check the loopback MCP listener, auth reject reason
counters, and readiness report. Do not bypass discovery, copy the bearer into
Cordis, or switch MCP auth to `off`. No P2-B step changes the authentication
rollout mode or authorizes an automatic production restart.

## Backups

- Trigger an ad hoc backup with `npm run backup:state`.
- Restore a backup with `npm run backup:restore -- --backup-dir .dueno/backups/<timestamp> --workspace-dir /tmp/restore-target`.
- Verify a backup artifact with `npm run backup:verify -- .dueno/backups/<timestamp>`.
- Daily backup scheduling is provided by the user timer `dueno-fleet-backup.timer`, installed by `scripts/install-fleet-service.sh`.

## Remote service-out API bridge

The optional authenticated systemd bridge and approved tunnel activation, token
rotation, ACLs and rollback are documented in [Service-out bridge](service-out-bridge.md).
It is installed separately; Fleet restart/install does not publish network ingress.
