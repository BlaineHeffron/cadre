# Cadre service-out bridge

Status: implementation and local verification; production activation is a separate,
explicitly approved operation. This PR does not install units, create tunnels,
change DNS/ACLs, rotate production tokens, restart Fleet, or enable MCP enforcement.

## Design

```text
Reid / hosted automation (independent of Grok Bot GUI)
  HTTPS + Cloudflare Access service credentials + Authorization: Bearer AUTH_TOKEN
    -> Cloudflare Access -> outbound cloudflared tunnel on Dueno
    -> 127.0.0.1:4311 (dueno-fleet-bridge.service)
    -> 127.0.0.1:4310 (existing Fleet REST, FLEET_AUTH_TOKEN)
    -> existing durable state, scheduler and agent-bus delivery

Optional private operators -> Tailscale Serve HTTPS -> same 127.0.0.1:4311
```

The Node bridge is a separate system service. It imports no Fleet configuration,
starts no scheduling/execution loops, writes no state, and never invokes GUI
local-exec. The existing Fleet service owns execution and persistence. Both Dueno
and its network must stay awake; this removes the desktop application's lifecycle
as a dependency, not the host's availability. The remote caller must itself be a
hosted/background service capable of HTTPS calls while the GUI is asleep. Configure
its tool/HTTP integration with the hostname, bearer and (for Cloudflare) Access
headers below; this PR does not configure an external Grok/Reid account.

Cloudflare Tunnel is the primary route for cloud callers, with no tailnet membership
or inbound firewall opening. Tailscale Serve is an optional operator route inside
the tailnet; it alone does not make the service available to a cloud caller outside
that tailnet. Do not add cloud Grok Bot to the tailnet or use Funnel as a shortcut.

## Published API contract

Paths are unchanged from Fleet. Request/response bodies retain existing REST schemas.
The authoritative method/path allowlist is in `scripts/fleet-bridge.mjs`:

| Method | Path |
| --- | --- |
| GET | `/api/health/ready` (also requires bearer) |
| GET | `/api/agents/providers`, `/api/agents/scheduled` |
| POST | `/api/agents/sessions`, `/api/agents/tasks`, `/api/agents/scheduled` |
| POST | `/api/agents/scheduled/:id/cancel` |
| GET | `/api/agent-bus/participants`, `/api/agent-bus/model-catalog`, `/api/agent-bus/threads`, `/api/agent-bus/state` |
| GET | `/api/agent-bus/threads/by-participant`, `/api/agent-bus/threads/:id` |
| GET | `/api/agent-bus/messages/:id/context` |
| POST | `/api/agent-bus/threads`, `/api/agent-bus/messages`, `/api/agent-bus/dm` |
| POST | `/api/agent-bus/threads/:id/participants`, `/api/agent-bus/threads/:id/close` |

`GET /api/health/ready` is the only published health route; `/api/health` and
`/api/health/live` are intentionally denied. Adding a Fleet route does not publish
it; review the bridge allowlist and this table together.

IDs must contain only letters, digits, underscores or hyphens. Unknown methods,
new Fleet endpoints, encoded path segments and traversal paths are not published.
UI/static files, browser login/cookies, WebSockets, unrestricted MCP, shell APIs,
permission answers, thread deletion/end, deployment/ops controls and manual scheduler
pumping are excluded. To prompt Reid, discover its `{kind, sessionId}` using
participants and use the existing message/DM API. Use a known sender identity;
the REST bearer is an operator capability, not a per-agent MCP identity.

The bridge accepts a complete JSON request body of at most 1,048,576 bytes
(1 MiB), including keys, quotes and braces; exactly the limit is accepted and one
byte over is rejected with 413 before forwarding. Absent POST bodies stay absent;
only requests with a body receive an upstream JSON content type. Query strings are
forwarded unchanged for Fleet filtering/pagination; never put credentials in URLs.
The bridge allows a shared 120 requests/minute,
and times out upstream calls at 120 seconds. Caller-supplied cookies, forwarded IPs,
internal bypass, automation policy and MCP identity headers never reach Fleet.
It forwards only server-owned bearer, JSON content type and accept headers.
Redirects are refused; responses do not forward cookies or internal headers and
always use `Cache-Control: no-store`. No request bodies, URLs or tokens are logged
by the bridge. The journal records startup/failure; use authenticated readiness and
Fleet's existing audit/state for operational diagnosis. Configure edge logging to
redact Authorization and Access credentials and disable caching for this hostname.

## Security and least privilege

- `AUTH_TOKEN`: bridge-only remote capability. Generate at least 32 random bytes,
  encoded as base64url (43 characters) or hex (64). Length/alphabet validation is a
  startup guard, not proof of randomness. Never use a passphrase or a sample token.
- `FLEET_AUTH_TOKEN`: existing Fleet `AUTH_TOKEN`, retained only on Dueno. It must
  also satisfy the bridge's strong-token format. The two values must differ.
  The bridge substitutes this token only after remote authentication and allowlisting.
- Both are required; missing/weak/shared tokens prevent the listener starting.
  No loopback, cookie, query-token, tailnet or Cloudflare-header authentication bypass.
- The remote capability can create tasks/sessions/schedules and send agent prompts.
  That is powerful execution authority over Fleet, with broad data access on the
  allowed routes. This is endpoint restriction, **not** a tenant sandbox or a
  read-only token. Existing REST sees Fleet operator authority; per-agent MCP scope
  restrictions do not apply. Give the bearer only to trusted automation, never to
  arbitrary websites/users. A malicious prompt can still request harmful agent work.
- Cloudflare Access adds an independent, expiring service-token gate. Use a dedicated
  application hostname and a Service Auth policy including only the intended service
  token; no Bypass or Everyone policy. Keep Access credentials distinct from both
  application tokens. TLS terminates at Cloudflare, so Cloudflare is a trusted party.
- Optional Tailscale access: grant only an operator group access to a dedicated
  Dueno service tag on TCP 443. Restrict tag ownership to admins; review/remove any
  broader grants that already admit that destination. Do not grant callers shell,
  subnet-router access or ports 4310/4311/8765. Serve still requires `AUTH_TOKEN`.
- Bind both local HTTP listeners to loopback. The system unit uses a dynamic UID,
  no capabilities, a read-only filesystem and inaccessible home directories. Its
  dedicated root-owned install contains only the bridge, a vetted Node executable
  and the locked Fastify/rate-limit dependency tree; it mounts no Fleet checkout,
  state or dependencies. Its IP policy permits loopback
  only. The outbound tunnel runs separately under its own service identity.
  Same-host root/Fleet-account compromise remains outside this boundary.

## Approved installation

Run these steps only after the PR is merged to `main` and deployment is explicitly
approved. The canonical Fleet deployment command is `bash scripts/server.sh restart`;
never point this unit at a feature checkout. Verify the merged commit is an ancestor
of `origin/main`, deploy through that command, and ensure the live checkout contains
the script and installed dependencies. Existing Fleet must remain `HOST=127.0.0.1`,
`PORT=4310`, `TLS_ENABLED=false`; do not change live settings casually.

1. Prepare a dedicated bundle from the reviewed, deployed `main` checkout as an
   unprivileged operator. `deploy/fleet-bridge/package-lock.json` locks only Fastify,
   rate-limit and their transitive dependencies. No full Fleet `node_modules` tree,
   state, home-directory mount or credentials belong in this bundle.

   ```sh
   BRIDGE_STAGE=$(mktemp -d /tmp/dueno-bridge-bundle.XXXXXX)
   install -m 0644 scripts/fleet-bridge.mjs deploy/fleet-bridge/package.json deploy/fleet-bridge/package-lock.json "$BRIDGE_STAGE/"
   npm ci --prefix "$BRIDGE_STAGE" --omit=dev --ignore-scripts --no-audit --no-fund
   # Resolve and verify the approved Node >=22.19.0, then copy the executable.
   BRIDGE_NODE=$(command -v node)
   "$BRIDGE_NODE" --version
   install -m 0755 "$BRIDGE_NODE" "$BRIDGE_STAGE/node"
   ```

   After verifying the staged bundle, an approved operator installs it in a fresh
   dedicated directory. For an update, stop only the bridge and move the previous
   `/opt/dueno-fleet-bridge` directory aside for rollback first; do not overlay old
   dependencies. The following commands are installation steps, not part of this
   PR's local verification:

   ```sh
   sudo install -d -o root -g root -m 0755 /opt/dueno-fleet-bridge
   sudo cp -R "$BRIDGE_STAGE/." /opt/dueno-fleet-bridge/
   sudo chown -R root:root /opt/dueno-fleet-bridge
   sudo chmod -R u=rwX,go=rX /opt/dueno-fleet-bridge
   ```

   This creates the install directory explicitly. `ConditionPathExists` skips startup
   if the installed script is absent. The unit uses `WorkingDirectory=/`
   and absolute paths, so boot never depends on a bind mount creating its working
   directory. Node and code are root-owned and read-only to the dynamic service UID;
   no permissions on Fleet or operator home directories need changing. Node upgrades
   require rebuilding this bundle with the approved patched executable, followed by
   a bridge-only restart. The bundle does not follow a mutable NVM symlink. No dependency symlink may
   point outside the installed bundle.
2. An authorized operator provisions `/etc/dueno-fleet-bridge/bridge.conf`, root-owned
   mode `0600`, beneath a root-owned `0700` directory. It has two systemd environment
   assignments: `AUTH_TOKEN=<new remote token>` and
   `FLEET_AUTH_TOKEN=<existing strong Fleet token>`. Use the approved secret manager;
   do not paste tokens into chat, shell arguments/history, the repository or logs.
   If Fleet's token is weak, coordinate a Fleet rotation before proceeding. The
   agent implementing this PR does not read or provision production credentials.
3. Install and validate the unit, then start the loopback bridge:

   ```sh
   sudo install -m 0644 deploy/dueno-fleet-bridge.service /etc/systemd/system/
   sudo systemd-analyze verify /etc/systemd/system/dueno-fleet-bridge.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now dueno-fleet-bridge.service
   sudo systemctl status dueno-fleet-bridge.service --no-pager
   ss -ltn '( sport = :4311 )'
   ```

   Expect only `127.0.0.1:4311`. Validate missing bearer returns 401 and an
   authenticated `/api/health/ready` reflects Fleet readiness **before** publishing
   any ingress. Authenticated UI/ops paths must return 404. A system service starts
   at boot without a login. Also ensure the existing user Fleet service has approved
   boot persistence (`loginctl show-user "$USER" -p Linger`); if needed an operator
   can enable linger. Do not rely on a logged-in desktop to keep Fleet alive.

## Cloudflare Tunnel (primary)

Create a dedicated Access application and Service Auth policy **first**, then a
named, managed tunnel with its own systemd `cloudflared` connector on Dueno. Provision
connector credentials through Cloudflare's approved service installation workflow;
never put a tunnel token in this repo or chat. Install the connector with boot enable
and restart-on-failure. Its sole published hostname maps to `http://127.0.0.1:4311`,
never Fleet's 4310 or MCP's 8765. No other ingress routes or private network routes.

For a locally managed tunnel, the relevant ingress fragment is:

```yaml
ingress:
  - hostname: fleet-api.example.com  # replace with the approved dedicated hostname
    service: http://127.0.0.1:4311
  - service: http_status:404
```

For dashboard-managed tunnels, configure the equivalent single published application
route. With local config, run `cloudflared tunnel ingress validate` and
`cloudflared tunnel ingress rule https://fleet-api.example.com/api/health/ready`.
Use TLS on the public hostname; do not disable certificate validation. The cloud
caller sends these headers from its secret store:

```text
Authorization: Bearer <bridge AUTH_TOKEN>
CF-Access-Client-Id: <dedicated Access service token client ID>
CF-Access-Client-Secret: <dedicated Access service token secret>
Content-Type: application/json
```

Test that absent/incorrect Access credentials fail at the edge, valid Access with
absent/incorrect bearer fails at the bridge, and both valid credentials permit only
allowlisted APIs. Check the Cloudflare application has no caching or broad bypass.

References: [Tunnel setup](https://developers.cloudflare.com/tunnel/setup/),
[local ingress configuration](https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/),
[service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

## Optional Tailscale Serve

After reviewing existing Serve configuration (`tailscale serve status`) and applying
the narrow operator ACL/grant, expose the bridge on a dedicated available HTTPS port:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4311
tailscale serve status
```

Do not overwrite another service's port mapping. Background Serve persists; verify
HTTPS certificates and ACLs using the approved operator device, plus denial from an
unauthorized device. No Grok cloud node enrollment is needed or intended.
Reference: [Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Client use and acceptance

Remote integrations use HTTPS REST directly; they need no shell command or GUI tool.
A session creation body may include Fleet's `idempotencyKey` for safe replay of that
same launch. Message, task and schedule mutations have no new bridge deduplication.
Never blindly retry a timed-out mutation: a 502/504 or lost connection may follow a
successful write. Inspect thread history, participants or schedules to reconcile.
Long one-off tasks can exceed the bridge or edge timeout; prefer session creation
and bus interaction for long-running work. The bridge never retries a mutation.

Acceptance after approved deployment:

1. Pass the negative auth/path checks above locally and through the selected ingress.
2. With a disposable operator-approved agent/thread, send an enqueue-mode message:

   ```json
   {"threadId":"<test-thread>","from":{"kind":"<sender-kind>","sessionId":"<sender-id>"},"body":"service-out acceptance","deliveryMode":"enqueue"}
   ```

   POST it to `/api/agent-bus/messages` and GET `/api/agent-bus/threads/<test-thread>`;
   confirm the returned message ID and body. Verify delivery in Fleet separately.
3. Close/idle the Grok Bot app and repeat from the independent hosted caller.
   Record only timestamp, message ID and outcome. Then create a disposable session
   with a unique `idempotencyKey`, confirm its participant appears, and close test
   sessions through the normal operator controls.
4. Restart just the bridge and connector; repeat readiness and round trip. During
   an approved maintenance window, reboot Dueno and confirm all services recover
   without login. These operational steps are not claimed by local tests.

Local regression command (no production credentials or GUI required):

```sh
DUENO_DISABLE_SIDE_EFFECTS=1 DM_GITHUB_AGENT_POLLER_ENABLED=0 \
DM_GITHUB_AGENTS_ENABLED=0 DM_SCHEDULED_AGENT_PUMP_ENABLED=0 TELEGRAM_BRIDGE=0 \
PORT=14310 AGENT_BUS_MCP_HTTP_PORT=18765 node --test tests/fleet-bridge.test.mjs
```

Tests use random credentials and ephemeral loopback listeners. They exercise the
real Fleet auth, agent-bus routes and temporary store for thread creation, message
persistence and readback; provider execution is supplied by the existing test
harness. They also cover auth/header isolation, strict routing, request size/rate
limits (including the exact wire-byte boundary), authenticated readiness and upstream
not-ready status, absent POST bodies, redirects, outages and timeouts. They do not prove external DNS, Access,
systemd sandbox operation or a production provider launch.

## Rotation, recovery and rollback

- Rotate remote `AUTH_TOKEN` on a defined operator cadence (for example 90 days),
  on ownership changes, or immediately after suspected disclosure. Pause callers,
  replace the value in the managed root-only file and remote secret store, restart
  only `dueno-fleet-bridge`, verify old token fails/new succeeds, then resume.
  There is no dual-token grace period. Existing in-flight writes may complete.
- Rotate `FLEET_AUTH_TOKEN` together with Fleet's operator token through its approved
  deployment process, update the bridge configuration, then restart the bridge.
  Plan a short outage; do not temporarily disable auth. Bridge rotation alone does
  not rotate or revoke per-attempt MCP credentials.
- Rotate/revoke Cloudflare Access service tokens independently; check expiry and
  tunnel connector health. Revoke compromised connector credentials in Cloudflare.
  Review Tailscale group/tag membership and device access when operators change.
- A 401 indicates bridge credentials; edge denial indicates Access/ACL; 502/504
  indicates local Fleet availability or timeout. Authenticated readiness is an
  upstream check, not merely process liveness. Inspect `systemctl status` and
  `journalctl -u dueno-fleet-bridge` without printing environment/credential files.
  Shared rate limiting can deny all callers during a flood; block it at Access/WAF.
- Emergency isolation: `sudo systemctl stop dueno-fleet-bridge`; remove/disable the
  dedicated Cloudflare hostname route or connector and revoke its Access token.
  For the optional dedicated Serve listener: `tailscale serve --https=443 off`.
  Do not reset unrelated Serve mappings. For persistent rollback, disable the
  bridge unit and dedicated connector. Local Fleet continues independently.
- Updating the bridge uses reviewed code merged to `main`, the approved canonical
  live deployment, rebuilding/replacing the dedicated bundle, and a separate bridge
  restart. Roll back by stopping the bridge, restoring its previous root-owned bundle
  and restarting it with the current managed credentials.
  Never automatically open ingress from the Fleet installer/restart scripts.
