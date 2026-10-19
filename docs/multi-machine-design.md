# Multi-machine Cadre: spawn sessions on other tailnet machines

Status: design only, round 6 (adds the t3code code review; findings and decisions in §7). It folds in the operator constraints (msg_e25a4a761b4588b4) and the
reviewer's gates (msg_736b7418b438f35f, msg_61ca91a94cedb937).

- Designer: claude:c952c90b. Reviewer: pi:a9e71f97.
- Basis: `origin/main` at `ef3e956`. Citations are `path:line` in `/home/blaine/projects/cadre`.
- Machines:
  - **dueno-1** (Linux, today's 4310 instance) is the hub.
  - **incadence** (Windows) runs a worker inside WSL2.
  - **The university laptop** (OS unknown, sleeps and roams) is a worker on Linux, macOS or WSL2.

## TL;DR

- **Recommendation: one hub plus workers, with the same code on every machine.**
  - dueno-1 is the hub. It is the only machine with the bus, state, UI, **Telegram (the only bot)**,
    the **Command Queue** and every side-effect loop.
  - Every other machine runs the same Cadre checkout with `CADRE_ROLE=worker`. A worker owns its
    local processes: tmux, worktrees, hook logs and transcripts. It has no bot, no queue, no loops
    and an empty local bus.
- **Hub to worker:** existing REST session routes through one proxy hook on the hub, driven by a
  t3code-style supervisor per worker (phases, backoff, 426 version check). The hub also subscribes to
  each worker's session-state and hook events with an `afterSequence` cursor and replays after a
  reconnect.
- **Worker sessions to the bus:** no forward. Sessions call the hub's dedicated tailnet MCP listener
  directly over HTTPS (`tailscale serve`) with per-session tokens the hub mints. That listener
  **always requires a valid token**, whatever the global mode, so no ACL is needed. Production is in
  `issue_only` today and is not ready for `enforce`, so the existing `:8765` port must never be exposed.
- **Trust model: copy t3code's pairing. Reachability is not trust.** Other users' devices are
  on the tailnet (friends). The operator chose t3code's model, so there are no Tailscale ACLs, tags,
  whois or node pinning. (The t3code review suggested an ACL; rejected, §7.)
  - Any tailnet device can reach a port. Every request without a valid credential is rejected, on
    workers and on the hub's listener, in every global auth mode.
  - **Pairing:** `cadre pair` on the worker prints a one-time link. The code is 12 characters from a
    32-character unambiguous alphabet, lives 5 minutes, is hashed at rest and consumed atomically.
    The hub checks the descriptor's machine id and protocol before the code is spent. It exchanges two
    coarse credentials: `worker:operate` (the hub holds it) and `bus:agent` (the worker holds it, for
    its hello). Tokens are hashed or HMAC-signed, and revocation is checked against stored state on
    every call. Raw secrets are shown only at creation; "forget machine" revokes.
  - **Machine id:** each machine has a durable machine id file and a descriptor endpoint
    `{id, label, OS, commit, protocol}`. Hub rows are `{id, urlRef, authRef, envId}`; a worker has one
    hub row. Worker URLs are plain `http:` on the tailnet, checked against the fleet registry's
    private-host allowlist (`hostIsPrivate`, `DM_FLEET_PRIVATE_HOSTS_REF`); the hub row is `https:`.
- **No new session auth system:**
  - Pairing credentials are narrow-only machine credentials. They replace the worker's `AUTH_TOKEN`
    for hub-to-worker calls.
  - Sessions use the existing per-session bus tokens, **minted only by the hub**.
- **Session ids:** no new namespace. Ids stay `kind:hex`, minted by the hub, which keeps a persisted
  session-to-machine table.
- **Windows:** native win32 is not a Cadre host. incadence runs the worker in WSL2, with systemd on
  and Tailscale running inside WSL2 as its own node. Repos live on the WSL ext4 disk.
- **A laptop that sleeps is the normal case:**
  - Rows show `unreachable`, never `ended`.
  - Deliveries stay queued on the hub with `holdReason: machine_offline` (no new queue). The worker's
    hello on wake resets the backoff, and each delivery is injected once, using the existing pane dedupe.
  - Spawning on an offline machine fails closed.
  - If dueno-1 is down, the bus, Telegram and the queue are down for every machine. Nothing fails
    over.
- **Slice 1** is `spawn_session({machine})` for Claude in tmux on a Linux worker (WSL2 counts as
  Linux), with an explicit `workDir`. The child can `room_send` into hub rooms and receives DMs.
  There are 7 slices plus 1 optional one.

## 1. t3code: what is worth copying

Source: `pingdotgg/t3code` on `main`, read via the GitHub API (`docs/internals/remote.md`,
`docs/user/remote-access.md`, `docs/internals/environment-auth.md`,
`packages/client-runtime/src/connection/{compatibility,supervisor}.ts`), then by a code review at
commit `15903f1` (`t3code-REVIEW.md`).

- **Every machine runs a full t3 server**, which t3code calls an "environment". It owns providers,
  files, SQLite state and agents. The client connects straight to each one over HTTP and WebSocket.
  - t3code has **no cross-machine agent messaging**. Cadre needs that, so Cadre needs a hub.
- **"Run on" is chosen at thread creation and then fixed.** A thread belongs to one machine. Copy:
  a session belongs to one machine for life, and nothing migrates.
- **A durable environment ID file and a descriptor.** Each server mints the ID once (race-safe) and
  serves it with label, OS and version. The client checks the descriptor ID, and protocol, **before it
  spends a pairing code** and before it sends a credential on a saved route. Copy as-is (§4.2).
- **Pairing.** 12 characters from a 32-character alphabet, 5-minute TTL, consumed by one atomic
  conditional `UPDATE`. Tokens are HMAC-signed, and `verify` also reads the stored row's `revokedAt`, so
  revocation is immediate. Copy. **Adapt:** t3code stores the code in plaintext, and Cadre hashes it.
- **Scoped, narrow-only credentials.** Cadre's per-session bus tokens already have this property.
  t3code has about 17 scopes; Cadre uses two coarse ones, `worker:operate` and `bus:agent`.
- **Protocol version in the descriptor.** A mismatch is HTTP 426 and blocks as `unsupported`. Copy.
  The Cadre commit is in the descriptor too, but a commit mismatch only warns (operator decision,
  2026-10-18).
- **Disconnects don't kill agents.** The client runs one supervisor per environment.
  - Phases: `available | offline | connecting | backoff | connected | blocked`. Errors are transient
    (retry) or blocked (stop until the user acts).
  - Equal-jitter backoff from 1 s up to 5 min. Wakeups (app active, network changed) reset it.
  - Events carry a `sequence`; the client resubscribes with `afterSequence` and replays what it
    missed. Unknown event types are skipped but still advance the cursor.
  - Copy all of it. **Adapt:** t3code refuses a send to a disconnected environment and queues nothing.
    Cadre queues, through the existing `queued` + `holdReason` path with `machine_offline`.
- **SSH bootstrap leaves provider credentials on the remote host.** Copy the principle: provider
  logins live on each worker and never pass through the hub.
- **Tailscale gives reachability and TLS, not identity.** t3code uses `tailscale serve --https` and
  always requires a pairing token. Copy: that is the model behind "no ACLs".
- **WSL:** t3code binds `0.0.0.0` and dials the distro's IP, because forwarding to Windows localhost
  is unreliable. Copy the lesson: bind the tailnet address, no localhost forward (§4.8).
- **Not copied:** multi-route failover, the T3 Connect relay, Cloudflare, DPoP, auto-balance, the
  hosted client, SSH bootstrap and the fine-grained scope matrix. Every machine is on one tailnet, so
  one route per machine is enough.

## 2. Single-host assumptions today

### Launch and session state

| Area | Assumption | Where |
|---|---|---|
| tmux launch | `tmux new-session` via local `execFile`, `bash -lc`, optional systemd user scope (skipped without a user bus) | `modules/sessions/index.mjs:1054`, `modules/agent/session-scope.mjs:29-65` |
| Liveness and output | local `has-session`, `capture-pane`, `list-panes`, `kill-session`; discovery runs `tmux list-sessions` | `index.mjs:1016,1623,1750,1835-1870,2403-2421` |
| Input | `load-buffer`, `paste-buffer`, `send-keys` | `modules/platform/tmux-input.mjs:20-50`, route `index.mjs:2925` |
| Structured and protocol sessions | Linux process groups; `kill(pid,0)`, `/proc/<pid>/stat`, `/proc/*/environ` scan | `modules/agent/process-supervisor.mjs:19-58,132-142,197-270` |
| Attach | local tmux socket; on Windows, a GUI helper shells `wsl.exe` (the only win32 path in the tree) | `modules/platform/tmux.mjs:123,159-176,186-190` |
| Session ids | `randomBytes(4)` hex, unique only within one process map. Callers may supply `^[a-f0-9]{8,32}$`. Bus key is `kind:sessionId`. | `index.mjs:491,1501-1503,1109`, `modules/agent-bus/index.mjs:18`, collab pre-mint `modules/agent-bus/routes.mjs:232` |
| State dir | `.dueno/state`, relative to the process's working directory | `modules/ops/runtime-state.mjs:5` |
| workDir | resolved and `stat`ed locally; default `~/projects/cadre` | `modules/sessions/workdir.mjs:6,15-35` |
| Worktrees | isolated: `~/.dueno-fleet/agent-worktrees`. Collab: `~/.cadre/worktrees/collab/<room>`, cleaned at room end and by a periodic orphan sweep. | `modules/agent/interface.mjs:208,274-287`, `modules/agent-bus/managed-worktrees.mjs:7,167-188`, `routes.mjs:94-99,230` |
| `task_spawn` | `realpath(workDir)` on the local disk | `modules/agent-bus/task-routes.mjs:83` |

### Bus, MCP and auth

| Area | Assumption | Where |
|---|---|---|
| Bus store | one JSON file or one Postgres namespace on one host | `modules/agent-bus/store.mjs:40-62,118-144` |
| Delivery | adapters `app.inject` into the hub's own `/api/<kind>/sessions/:id/{input,clear,startup-input}` | `modules/agent-bus/adapters.mjs:11-28,131-189` |
| Resolution | a participant is resolved through local adapters, and a 404 means "ended" | `modules/agent-bus/participants.mjs:146-165` |
| Retry | transient errors stay `queued` with `backoff`, with no age limit; duplicate injection is skipped if the pane already shows `id=<msgId>` | `modules/agent-bus/delivery.mjs:4-6,100-108,125-133` |
| returnResults | the observer reads the child's hook log from the hub's disk and `stat`s it | `modules/agent-bus/observer.mjs:65-82`, `modules/agent/hook-events.mjs:9,149,336` |
| MCP URL | `http://${host}:${port}${path}`, where host inherits `HOST` | `config.mjs:148-152`, `modules/platform/mcp-seed.mjs:7-10` |
| Loopback-only checks | MCP URL checked for loopback in places | `modules/integrations/mcp-launch-preflight.mjs:95-100`; also `codex-app-server-sessions.mjs:64`, `deepseek-mcp.mjs:66` |
| Sandbox | nono opens only `config.agentBusMcpHttp.port` (plus Headroom ports). This is a port grant, not a loopback check. | `modules/agent/nono-launch.mjs:129`, applied at `:46` |
| MCP auth | default `issue_only`: a call with no token runs as legacy untrusted with scope `*` | `config.mjs:157`, `modules/agent-bus/mcp-http.mjs:160-205` |
| MCP auth, live | `issue_only`, `readyForEnforce=false`, 4 sessions missing credentials (read via `monitor_agent_bus_auth_readiness` on 2026-10-18) | |
| Credentials | minted per launch through the injected `credentialStoreOptions()`; no TTL; rotated on resume | `mcp-launch-preflight.mjs:331-366`, `modules/agent-bus/mcp-auth.mjs:236-292`, `index.mjs:515-517,1360-1374` |
| **Spawn trust** | `spawnedBy`, coordinator and loop-registration policy all come from `req.duenoAuth`. A worker that ran this code would read the hub's operator bearer as "operator" and grant operator loop delegation. | `index.mjs:2585-2600`, `modules/agent-bus/coordinator-policy.mjs:257-261` |
| API auth | internal bypass from loopback only; `AUTH_TOKEN` maps to the operator; no peer identity check | `modules/platform/auth.mjs:50-56,245-277,357-470` |
| Existing allowlist | fleet registry: refs-only URLs and tokens; private, `.ts.net` and 100.64/10 hosts blocked unless listed in `DM_FLEET_PRIVATE_HOSTS_REF` | `modules/fleet/registry.mjs:91-143,147-205`, `config.mjs:248` |

### Loops, Telegram, queue and deploy

| Area | Assumption | Where |
|---|---|---|
| Side-effect gate | loops run only on `PORT=4310` or with `CADRE_ALLOW_SIDE_EFFECTS`. The same gate also turns off the MCP listener. | `modules/platform/side-effect-loops.mjs:7-19`, `server.mjs:83-88,537,745-757` |
| Not gated | the bus observer and the worktree orphan sweep run on every instance | `modules/agent-bus/index.mjs:173`, `routes.mjs:97` |
| Telegram | session list and input go through the hub API; the output relay reads transcripts from `~/.claude/projects`, `~/.codex/sessions` and `~/.pi/agent` on the local disk | `server.mjs:352-377`, `modules/telegram/binding.mjs:9-11,406-437`, `relay.mjs:7,361-362` |
| Command Queue, permissions | a permission prompt becomes a queue item where the session runs | `modules/platform/push.mjs:12-25` |
| Command Queue, answers | answers and the supervisor use in-process `enqueueAgentSessionCommand` | `modules/integrations/command-center-ai.mjs:524-531`, `index.mjs:3572` |
| UI | no machine field; local attach command | `public/app/agent-session-nav.mjs:72-75`, `index.mjs:2573` |
| Deploy | health URL hard-coded to `127.0.0.1:4310`; the unit sets `HOST=127.0.0.1` | `scripts/server.sh:17`, `scripts/install-fleet-service.sh:55+` |

## 3. Architectures compared

### A. Hub plus workers, same code (recommended)

The hub owns all shared state. A worker is a normal Cadre checkout started with `CADRE_ROLE=worker`.
The hub keeps an index of remote sessions, with entries
`{machine, kind, sessionId, workDir, provider, metadata, status}`. It proxies those sessions'
`/api/<kind>/sessions/:id/*` routes to the worker, and the worker runs the existing launch code
unchanged.

- **Pros:**
  - Every process and disk operation in §2 stays on the machine that owns it, in code that already
    exists.
  - The bus, envelopes, room semantics and the MCP tools don't change.
  - Delivery reuses the adapter and the `transient` retry path.
  - There is one Telegram and one queue by construction.
- **Cons:**
  - dueno-1 is a single point of failure: no hub means no bus, Telegram or queue for anyone. That is
    already true for local sessions today.
  - Each worker needs a Cadre install and its own deploys.

### B. Peer Cadre instances federate

Each machine is a full hub. Rooms that span machines are replicated.

- **Cons:**
  - It needs multi-master replication of `state.json`: threads, messages, deliveries, idempotency
    keys, owner and close state, DM membership.
  - `room_end` and worktree cleanup would need a conflict policy.
  - Telegram and the queue would still need exactly one owner. Two instances on 4310 would
    double-run pollers, scheduled agents and the bot (`side-effect-loops.mjs:7-11`).
  - A sleeping laptop would wake up holding stale replicas.
- **Pros:** a machine keeps working alone during a partition, which the operator did not ask for.
- Rejected.

### C. Thin executor over SSH, no Cadre on the worker

The hub runs `ssh host tmux ...`, reads remote files over SSH, and uses an `ssh -R` forward for MCP.

- **Pros:** nothing to install on the worker, and SSH keys are an explicit allowlist.
- **Cons:**
  - Every local call in §2 would need to become remote-aware: `execFile`, `writeFile`, `stat`,
    `/proc`, `systemd-run`, git worktrees, nono, Headroom and Claude trust seeding. That is hundreds
    of call sites.
  - SSH sessions also break on every sleep or roam.
- Rejected. SSH stays useful for installing or upgrading a worker by hand.

### D. The cloud-session watcher pattern

The hub watches a remote agent but gives it no MCP, the way `adapters.mjs:254-287` handles cloud
sessions.

- What this loses: the child cannot `room_send`, DM, read `room_context` or spawn. Messages arrive
  only as relayed text, and returnResults does not apply.
- That fails the goal. Rejected.

## 4. Recommended design (A)

### 4.1 Topology

```
 dueno-1  hub  (PORT=4310, loopback)                worker  (CADRE_ROLE=worker, PORT=4320)
 ───────────────────────────────────                ──────────────────────────────────────
 bus · UI · Telegram bot · Command Queue · loops    tmux sessions · worktrees · hook logs · transcripts
 machine supervisor (one per worker) ──HTTP──►      <worker-ts-ip>:4320  /api/...   [worker:operate]
   events cursor (afterSequence)     ◄──events──    /api/machine/events
 MCP 127.0.0.1:8765   (unchanged, local agents)
 MCP 127.0.0.1:8766 ◄─ tailscale serve (HTTPS) ◄──  agent MCP client in each worker session
   [per-session token, always enforced]               (https://<hub>.ts.net:8766/mcp)
 /machine/hello (same listener) ◄───────────────    worker hello on boot, wake, network change [bus:agent]
```

- **No MCP forward.** A worker session's MCP config points straight at the hub's listener, with the
  hub-minted session token. A forward was one more moving part on a sleeping laptop, and the Windows
  localhost hop is unreliable (§4.8).
  - The loopback checks (`mcp-launch-preflight.mjs:95`, `codex-app-server-sessions.mjs:64`,
    `deepseek-mcp.mjs:66`) exist so a caller cannot aim a bearer at an arbitrary host. Slice 1 relaxes
    them to loopback or the one `https:` origin in the machine's hub row, so a session token goes only
    there.
  - nono's port grant (`nono-launch.mjs:129`) must cover the hub's listener port wherever nono runs.
- **Tailnet transport.** Hub to worker is plain HTTP between tailnet IPs; WireGuard encrypts it.
  Worker to hub is HTTPS from `tailscale serve`, and the hub's certificate also lets the worker verify
  the hub. Serve fronts only the hub listener, and no identity header is trusted (§4.2).
- **Worker bind fails closed.**
  - In worker mode, Cadre refuses to start unless `HOST` is an address that tailscaled reports as
    this node's own Tailscale IP.
  - It never binds `0.0.0.0`, `::` or a LAN address, so a laptop on university Wi-Fi exposes nothing
    to the LAN.
  - Boot ordering uses `After=tailscaled.service` and `Restart=on-failure`.
  - `AGENT_BUS_MCP_HTTP_HOST=127.0.0.1` is pinned. Today it inherits `HOST` (`config.mjs:149`), and
    slice 1 removes that inheritance.
  - Internal calls use `app.inject`, which presents as loopback, so internal bypass still works.
  - `server.sh:17` must take its health URL from `HOST` and `PORT`.

### 4.2 Auth and the trust boundary

The tailnet includes friends' devices, which are not principals. We copy t3code's model
(`environment-auth.md`, `remote-access.md`) and rely on no Tailscale ACLs, tags or node identity.
**Reachability is not trust.** Any tailnet device may reach a worker's or the hub's port, and every
request without a valid paired credential is rejected.

1. **A small machine table reuses the fleet URL allowlist, not the fleet registry.**
   - The hub reads `CADRE_MACHINES_JSON`, a list of `{id, urlRef, authRef, envId, label}`.
   - A worker reads the same shape with a single hub row, `{id:"hub", mcpUrlRef, authRef, envId}`, where
     `mcpUrlRef` is the hub listener's `https:` origin.
   - The `*Ref` fields are env var names, the existing refs-only convention, so no secrets live in
     the file. `authRef` resolves to the raw credential this machine presents to that peer.
     `pair` and `forget` write the rows and secrets.
   - **URL checks.** The machine table parses its own origins (`http:` for workers, `https:` for the hub row): no credentials, query,
     fragment or path except `/mcp` for `mcpUrlRef`.
     - It reuses only the fleet private-host allowlist: `hostIsPrivate`, `privateAllowedHosts` and
       `DM_FLEET_PRIVATE_HOSTS_REF` (`registry.mjs:91-129`). Exporting them is the only change to
       that file.
     - A private, `.ts.net` or 100.64/10 host is **rejected unless it is listed**.
     - It does **not** call `validateFleetBaseUrl`, because `parseOrigin` requires `https:`
       (`registry.mjs:78`). Worker links are plain HTTP, and the https rule stays as it is for
       BusinessOS.
     - Serve is not put in front of workers.
   - It does **not** use `parseFleetRegistry`. That function requires `environment`, rejects unknown
     health contracts (`registry.mjs:6,170`) and rejects poll intervals under 15 s (`:174-179`).
     Adding a `cadre_worker` value to that shared enum would also let a mistaken row in the
     BusinessOS registry become a deployment the incident poller loads.
   - Machine polling cadence lives in machine-poller code, not in `polling_interval_seconds`.
2. **Machine id and descriptor check.**
   - Each instance writes a durable `machine-id` file (128 random bits, race-safe create) in its state
     dir on first start. `GET /api/machine/descriptor` returns
     `{machineId, label, os, commit, protocol}`. With the pairing redeem route, it is the only route
     open without a credential.
   - Pairing records the peer's ID as `envId`.
   - **Before spending a pairing code, and before sending any credential on a saved route** (a hub
     request to a worker, a worker's hello to the hub), the client fetches the peer's descriptor and
     requires `machineId == envId` (at pairing, the link's id) and the protocol rule (§4.10; a
     commit mismatch only warns). A mismatch, or no answer, sets `blocked` or `offline`, and nothing is sent. A wrong link
     therefore does not burn the code. The check runs per credential send and per new connection,
     never from a status cache.
   - The ID is not a secret. It catches a stale or reassigned route, not an active impersonator (§4.2.7).
3. **Pairing.** One-time, short-lived, redeemed once.
   - **Issue, on the worker:** `cadre pair` prints a link carrying the worker URL, its `machineId` and
     a one-time code. The code is 12 characters from a 32-character unambiguous alphabet (rejection-sampled) and
     lives 5 minutes. It is stored only as a hash and consumed by one atomic conditional update
     (unconsumed, unexpired, unrevoked). The UI button is slice 6.
   - **Redeem, on the hub:** `cadre machine add <link>` (UI in slice 6).
     1. The hub checks the URL against the allowlist (§4.2.1), then the descriptor's `machineId` and
        protocol against the link's and its own. Only then does it send the code.
     2. It generates a hub credential (`bus:agent`) and posts `{code, hubEnvId, hubCredential}` to the worker's
        `POST /api/pairing/redeem`.
     3. The worker verifies and burns the code, stores the hub credential's hash, and returns a worker
        credential (`worker:operate`) in the response.
     4. The hub stores the worker credential under `authRef` and writes the machine row. The worker
        stores the hub credential under its hub row's `authRef` and records `hubEnvId`.
   - Each side keeps the raw secret only for the credential it presents. Tokens are HMAC-signed, and
     every verify checks the signature, then the stored row for revocation (the hash of the one it
     verifies), so revocation is immediate. **Raw secrets appear only in the creation exchange.** No route or UI ever reads one
     back.
   - **Revoke:** `cadre machine forget <id>` deletes the hub's worker credential and its hub-credential
     hash, and asks the worker to delete both of its sides. The hub side takes effect at once. If
     the worker is unreachable, its side stays `pending` and is retried. The operator can also run
     `cadre unpair` on the worker.
4. **Listeners always require a credential, whatever the hub's global mode.**
   - A worker serves every route except the descriptor and redeem route only with a valid
     `worker:operate` credential. Worker mode has no legacy-untrusted path.
   - The hub's tailnet MCP listener is a second `startAgentBusMcpHttpServer` (`mcp-http.mjs:110`) with
     `requireCredential: true`, bound to loopback and fronted by `tailscale serve` HTTPS. It behaves as
     `enforce` (`:191`) on this listener only. It needs a valid hub-minted per-session token
     (`bus:agent`), or the worker's `bus:agent` machine credential on the hello route, and it never
     creates a legacy untrusted context.
   - **No ACL.** The t3code review proposed a tailnet ACL limiting this port to the operator's own
     machines, plus global `enforce`. That is rejected on the operator's decision: friends are on the
     tailnet, and reachability is not trust. The always-on credential check does that job, and global
     `enforce` stays unscheduled (open question 6).
   - It mounts only `/mcp` and `/machine/hello`, without the BusinessOS or remote-MCP proxies (open
     question 1).
   - The worker's own `AUTH_TOKEN` still gates its read-only UI. The hub no longer uses it.
5. **Scopes are narrow-only, and only the hub mints bus credentials.**
   - **Worker credential** (`worker:operate`, held by the hub): session create/control and the event
     stream on that worker only. It
     authenticates as a `hub-peer` principal, not `ui/operator`, and is accepted by no other machine.
   - **Hub credential** (`bus:agent`, held by the worker): the hello route only. Session tokens are
     separate, per-session and also `bus:agent`. Neither reaches a hub REST or operator route.
   - Neither can mint the other's authority, and each is bound to one machine record.
   - On a remote spawn, the hub runs the same trust derivation it runs for a local spawn
     (`index.mjs:2588-2600`, extracted into one function). It mints with
     `prepareAgentBusCredentialLaunch` (`mcp-launch-preflight.mjs:331`) and sends `busCredential` in
     the create body.
   - In worker mode only, the worker uses that token through a pre-issued store passed via
     `credentialStoreOptions()` (`index.mjs:515`).
   - The worker **never mints**, and never derives policy from `req.duenoAuth`. Its local metadata is
     not authoritative, because the hub's bus enforces the token's own scopes.
   - Resume: the hub mints the rotation token and forwards it. Delete: the hub revokes it.
   - A compromised worker holds only its own sessions' tokens and the hub credential. It cannot mint
     for anything.
   - The hub ignores `busCredential` and a caller-supplied `sessionId` in its own request bodies.
     Only worker mode honors them, and only with the worker credential.
   - **Worker mode never derives spawn trust from `req.duenoAuth`.** Even though the worker
     credential is not the operator principal, running `index.mjs:2588-2600` as it does today could
     stamp operator loop-registration delegation and coordinator metadata on remote sessions.
   - In worker mode, `trustedMetadata` is the hub-supplied metadata with the reserved coordinator
     and loop keys stripped (`stripReservedCoordinatorMetadata`, `coordinator-policy.mjs:269`). No policy is derived locally.
     Authority lives only in the hub-minted token.
6. **Credentials stay out of logs.**
   - `busCredential`, the machine credentials and the pairing code are bearers, carried in POST bodies
     and headers.
   - On both hub and worker, request bodies are never logged.
   - `busCredential`, `authorization`, the machine credential header and the redeem body are added to
     the Fastify logger redact paths.
   - Proxy errors are built from status and code only, never from the forwarded body.
7. **Gaps left by dropping node pinning** (accepted, with mitigations):
   - **IP takeover or impersonation.** If a node is deleted and its 100.x address is handed to
     another device, or a friend's device answers at the saved address, the descriptor ID check
     catches a different Cadre or a non-Cadre service. It does **not** stop a peer that fetches the
     real descriptor and echoes the ID, because the ID is public. That peer would receive the
     credential on the next call. Reallocating an address needs a tailnet admin action, and the
     exposure is one machine's scoped credential. `forget` revokes it. This is the hub-to-worker
     direction only: the hub's Serve certificate lets a worker verify the hub.
     - Cheap hardening, not in v1: the worker answers the descriptor with an HMAC of a client nonce
       under the worker credential, so the hub verifies the worker before it sends anything.
   - **Bearer credentials are not bound to a device.** A leaked credential works from any tailnet
     device until revoked. Whois pinning used to limit that.
   - **First pairing is trust on first use of the link.** Whoever holds the link and reaches the worker
     first redeems it. If someone else did, the operator's redeem fails loudly (code burned), and the
     fix is `cadre unpair` and a new link. Treat the link like a password and keep its TTL short.
   - **Open surface.** Any friend can reach the descriptor and the redeem route. They learn the machine
     ID and protocol, and need the code to do anything else. They can also spam rejected requests.

Not chosen: trusting `Tailscale-User-Login` behind Serve (Serve only fronts the hub listener with HTTPS).

- Serve delivers requests from loopback, so the backend would trust a header that any local process
  can forge.
- It identifies users, not machines.
- The README's Serve exposure of the operator UI (`README.md:111-137`) is separate and is not the
  machine trust model.

### 4.3 Session ids

- **There is exactly one hub.**
  - The hub mints every id: 8-hex for `spawn_session`, plus the collab roster (`routes.mjs:232`).
  - It passes the id as `sessionId`, already accepted at `index.mjs:1109`.
  - It records every id in a persisted session-to-machine table (the remote index) and rejects ids
    already used locally or in it. The worker rejects its own
    duplicates, and the hub retries once with a new id.
- **A worker accepts creation only from its hub.** That means a request carrying the worker
  credential issued to the hub at pairing. A worker's own UI is read-only plus attach (open question 2). No second issuer
  exists, so two issuers can never mint the same 8 hex digits.
- **No format change.** The bus key stays `kind:sessionId` (`agent-bus/index.mjs:18`). Rooms,
  envelopes, MCP arguments and `agent_directory` are untouched.
  - `machine` is an attribute in the remote index and in rows. It is not part of the identity.

### 4.4 Hub routing

- **Detail proxy.** One `preHandler` covers `/api/:kind/sessions/:id` and everything under it.
  - If `(kind, id)` is in the remote index, the hook forwards it to the worker.
  - **It runs for `app.inject` as well as real sockets.** Fastify runs hooks on injected requests,
    and that is how the bus adapters deliver (`adapters.mjs:11-28`).
  - The remote-index lookup runs before any local handler. A loopback inject for a remote id is
    therefore never treated as a local session: never probed with tmux, never answered 404.
  - **Offline, blocked or protocol-mismatched machine:** input, clear, startup-input and resume
    get 503 `{code:'machine_unreachable'|'machine_protocol_mismatch', transient:true}`.
    - Adapters copy `payload` onto the error (`adapters.mjs:83-87`), so
      `isTransientDeliveryError` (`delivery.mjs:4-5`) keeps the delivery `queued`.
    - The hub sets `holdReason: machine_offline` on the held delivery through the existing `queued` +
      `holdReason` path (field names to confirm in slice 2). No new queue.
    - `resolveAgentSession` treats only 404 as ended (`participants.mjs:146-165`), so rooms stay
      intact.
    - A 4xx here would fail the delivery for good (`delivery.mjs:125-133`). A laptop that slept
      through an upgrade would then lose its queued DMs. That is why mismatch uses 503 and not 409.
  - List, get from cache, and delete still proceed (§4.10).
  - This keeps the bus adapters, Telegram input (`bridge-loop.mjs:114-135`), Command Queue answers,
    and UI detail and delete working unchanged.
- **List merge.** `/api/:kind/sessions` merges the machine poller's cached rows (§4.6), tagged with
  `machine`.
  - Remote rows never enter the local `sessions` map, so local tmux probes never touch them.
- **Create.** `POST /api/agents/sessions` and `POST /api/<kind>/sessions` take `machine`.
  1. If the machine is not online, the hub fails fast with `machine_unreachable`. **It never queues
     a spawn.**
  2. Otherwise it derives trust, mints the id and credential, and writes the index entry as
     `pending`.
  3. It posts the whole body to the worker's `POST /api/agents/sessions`. Worktree, provider
     selection, `structured`, skills and model checks then run on the worker's own disk and
     binaries.
  4. On success the entry becomes `live`. On failure the hub drops the entry and revokes the token.
  - **What stays on the hub after create returns:** `parentThreadId` attach and the solo-thread
    bookkeeping. They are never moved to the worker's empty bus.
  - **`returnResults` for a remote child is rejected with 400 until slice 3.** The observer `stat`s
    the hook log on the hub's disk (`observer.mjs:65-82`), so it would silently return nothing.
- **In-process callers.** `enqueueAgentSessionCommand` (`index.mjs:3572`) sends remote ids to the
  HTTP input route.
- **Hook registry.** `registerHookSessionRegistry` (`hook-events.mjs:14`) also registers the remote
  index, so returnResults can see remote children (slice 3).

### 4.5 Worker mode (`CADRE_ROLE=worker`)

It forces off:

- every side-effect loop, even with `CADRE_ALLOW_SIDE_EFFECTS`;
- the Telegram bridge and relay; a worker refuses to start if a Telegram bot token is set;
- the push notifier;
- the **local bus observer** (`agent-bus/index.mjs:173`);
- the **managed-worktree orphan sweep** (`routes.mjs:97`).

**The sweep is a reap bug, not just noise.** The worker's empty bus has no rooms. `getRoom` would
return nothing, so every live collab worktree would look orphaned and get cleaned
(`managed-worktrees.mjs:180-183`). Collab worktree cleanup on a worker happens only when the hub
asks (slice 5).

It also:

- rejects local `addHumanQueueItem` calls;
- starts no MCP listener (`side-effect-loops.mjs:17-19`) and no forward: its sessions call the hub
  directly (§4.1);
- sends the hub a `hello` on boot, wake and network change (§4.6).

### 4.6 One Telegram, one Command Queue: both owned by dueno-1

- **The hub has exactly one new loop: a supervisor per machine row** (t3code's model). It runs only
  on the hub and is gated by the existing side-effect switch.
  - **Phases:** `available`, `offline`, `connecting`, `backoff`, `connected`, `blocked`.
    - Transient errors retry: network, timeout, transport, 5xx.
    - Blocked errors stop until the operator acts: 401/403, bad config, descriptor mismatch, 426.
  - **Backoff:** equal-jitter exponential from 1 s up to 5 min. A worker `hello` (boot, wake, network
    change) resets it and probes at once, as does an explicit "retry now". An OS "network offline"
    report pauses the supervisor but does not tear down a live connection.
  - **Connect:** the descriptor check (a protocol mismatch is 426 and fails closed; a commit mismatch
    only warns), then
    a snapshot of session rows, then `GET /api/machine/events?afterSequence=<cursor>`. Events are
    session-state and hook events with a worker-wide persisted, monotonic `sequence`.
    - The hub stores the cursor per machine and resumes from it, so a reconnect replays what it
      missed. Unknown event types are skipped and still advance the cursor.
    - The stream replaces the 5 s list polling and slice 3's polling route.
  - Status and the row cache update from events. `connected` means the stream is open.
- **Telegram.**
  - Topics: the hub's bridge already lists sessions over the hub API (`server.mjs:352-377`). Merged
    remote rows carry `id`, `tmuxSession` and `workDir` (`:362`), so remote sessions get topics in
    the same `bindings.json` and `topics.json` on dueno-1.
  - Input: it goes through hub routes, which proxy to the worker.
  - Output (slice 6): the relay keeps its cursor **on the hub** and pulls deltas through a worker
    route, `GET /api/<kind>/sessions/:id/transcript?cursor=` (`relay.mjs:361-362` already takes
    injectable readers).
  - While the laptop sleeps, the pull returns 503, the cursor stays put, and nothing is sent. On
    wake, the relay reads from the cursor. The transcript is on the laptop's disk, so nothing is lost
    or duplicated.
  - The laptop never holds a bot token, never polls Telegram and keeps no Telegram state.
- **Command Queue.**
  - Agent-filed items (`monitor_add_human_queue_item`) already go over MCP to the hub's store.
  - Permission, confirmation and selection prompts in remote sessions (slice 6): the supervisor sees
    `state.interaction` in remote rows and calls the hub's `addHumanQueueItem`, through the same path
    as `push.mjs:12-25`, including the fingerprint dedupe.
  - Answers route through the hub input proxy.
  - The worker files nothing locally (§4.5).
- **If dueno-1 is down,** the bus, Telegram and the Command Queue are down for every machine,
  including a laptop that is the only machine awake.
  - Remote agents keep running but cannot message anyone.
  - Nothing fails over to a worker, by design: two owners would double-deliver.

### 4.7 Offline, sleep and roaming (the laptop's normal case)

Hub-side row status is `live`, `unreachable` (last-known state plus `since`), or `ended`.
**Unreachable never becomes ended.**

| Situation | Behavior |
|---|---|
| Laptop suspends mid-turn | Processes freeze in place. The row becomes `unreachable` and shows the last-known `working`. After wake, the provider CLI handles its broken API stream (retry or error) as it would on any network drop. Cadre does not end the session. |
| Deliveries while away | The proxy short-circuits 503 `transient`, so deliveries stay `queued` with `backoff`, `holdReason: machine_offline` and no age limit (`delivery.mjs:125-133`). On wake, the worker's hello resets the backoff, the supervisor reconnects and replays from its cursor, and the observer injects each held delivery once. |
| Lost response causing a double inject | If the hub's POST reached the worker but the laptop slept before replying, the retry runs the existing pane dedupe, which skips a pane that already shows `id=<msgId>` (`delivery.mjs:100-108`). That check goes through the proxied detail route. **Residual risk, accepted:** `sessionHasBusMessage` sees only the captured pane, so if the marker has scrolled off, this case injects twice. It is the same limit as for local sessions today. |
| Bus token after wake | Still valid, because tokens have no TTL (`mcp-auth.mjs`). Rotation happens only on resume, minted by the hub. |
| tmux and worktrees after wake | Both are untouched by a suspend. No reaper runs while away: the worker sweep is off (§4.5). Collab cleanup for a room that ended during sleep is recorded `pending` on the hub's index entry and retried on reconnect, keeping the existing dirty and unpushed guards. |
| Laptop reboots instead of sleeping | The tmux server is gone. The worker's journal restores rows as ended or resumable. Once reachable, the hub sees `session_not_found` and follows the normal ended path. Resume runs through the hub, using the transcript on the laptop's disk. |
| Tailnet IP or MagicDNS change | A node's 100.x address stays the same through roaming. It changes only if the node is re-registered. The hub never follows a name. The URL host must pass `DM_FLEET_PRIVATE_HOSTS_REF`, and the descriptor at that address must report the recorded `envId` (§4.2.2). Otherwise the machine is `blocked`, with a reason naming the expected and observed ID, and no credential is sent. A re-registered node keeps its `machineId` (it lives in the state dir), so the check still passes. The operator updates `urlRef` or the allowlist when the IP really moved. |
| Spawn while offline | Fails closed with `machine_unreachable`. There are no queued spawns. |
| Operator wants to forget a dead machine | "Forget" drops the index entries, revokes their tokens and revokes the pairing credentials (§4.2.3); the worker's side stays `pending` until it is reachable. If the machine comes back, those sessions get 401 from the bus and show nowhere. The worker never kills sessions on its own; the operator ends them in the worker UI. |
| Hub restarts | Remote agents keep running, but their MCP calls fail. They fail fast at the Serve front end, and nothing queues on the worker. Hub deliveries resume when the hub is back. |

### 4.8 Windows (incadence) and other OSes: the executor contract

Native win32 is **not** a Cadre host:

- Launch execs `tmux` and `bash -lc` (`index.mjs:1054-1061`).
- Structured runtimes use Linux process groups and `/proc` (`process-supervisor.mjs`).
- The only win32 code is the GUI attach helper (`tmux.mjs:159-176`).

**On Windows, the worker is a WSL2 Linux distro**, for example Ubuntu 24.04:

- **systemd on:** set `[boot] systemd=true` in `/etc/wsl.conf`.
  - The worker runs as a user unit installed by `install-fleet-service.sh` with worker env, so
    `server.sh restart` works.
  - With a user bus, sessions get `dueno-agents.slice` scopes. Without one, scopes are skipped
    quietly (`session-scope.mjs:37-40`).
- **Tailscale runs inside WSL2 as its own tailnet node** (`incadence-wsl`), not on the Windows host.
  The operator has approved this. It is for reachability only; it is not the trust mechanism (§4.2).
  - The hub dials the WSL node's 100.x address directly.
  - The Windows host's Tailscale is irrelevant to Cadre.
  - The worker binds that tailnet address (§4.1), never Windows localhost. Worker sessions dial the hub
    from inside WSL, so no forward crosses the WSL boundary.
  - Rejected alternatives:
    - `netsh portproxy` from the Windows Tailscale IP into WSL's NAT address needs Windows-side
      config that breaks when WSL's NAT address changes.
    - WSL "mirrored" networking depends on the Windows build and the Hyper-V firewall. It is a
      fallback to verify on incadence, not the default.
- **Paths:** `workDir` is a POSIX path inside the distro, for example `/home/blaine/projects/x`.
  - Repos must live on the WSL ext4 disk, not `/mnt/c`, because of git performance, file modes and
    inotify.
  - The worker rejects `C:\…`, `\\wsl$\…` and `\\wsl.localhost\…` with
    `workdir_windows_path_unsupported`.
  - Windows tools see the same tree at `\\wsl.localhost\<distro>\home\…`. That path is shown only
    as a hint, never accepted as input.
- **Keep it awake:**
  - WSL stops an idle VM, and nothing starts the distro after a Windows reboot. A Windows Task
    Scheduler entry at logon runs `wsl.exe -d <distro> --exec /bin/true`, so systemd starts the
    worker and Tailscale.
  - Raise `vmIdleTimeout` in `.wslconfig`, or rely on the running systemd services.
  - Windows sleep behaves exactly like laptop sleep (§4.7).
- **What works there:** WSL2 is a Linux worker, so these work as on dueno-1:
  - tmux Claude, Codex and Pi;
  - structured Claude and codex-app-server;
  - systemd scopes.
- **What needs verifying there:**
  - nono needs Landlock in the WSL2 kernel (check `/sys/kernel/security/lsm`). Until that is
    verified, the worker reports nono as unsupported.
  - Headroom is an optional per-machine install.
- **Hub-only:** cloud sessions stay on the hub and are unaffected.
- **Provider logins:** Claude, Codex and Pi logins and binaries are installed **inside WSL**, under
  the WSL `$HOME`.
- **Attach** from Windows: `wsl.exe -d <distro> tmux attach -t <name>`, shown as text in the worker
  UI. The `openInWindowsTerminal` helper applies only when Cadre itself is win32, which it never is.

**University laptop (OS unknown):**

- Linux: a native worker, as on dueno-1.
- Windows: the WSL2 contract above. Tailscale inside WSL also covers roaming.
- macOS: tmux sessions work (Claude, Codex, Pi). Structured and protocol runtimes are unsupported,
  because `process-supervisor.mjs` relies on `/proc`. There are no systemd scopes, and the worker
  runs under launchd. That launchd unit is a later slice, only if the laptop is a Mac.

### 4.9 UI and MCP selector

- **MCP tools.**
  - `spawn_session` (`monitor-mcp.mjs:458`) gets optional `machine`, defaulting to the hub.
  - `spawn_collab_session` (`:1108`) gets `participants[].machine` (slice 5).
  - `agent_directory` and session rows gain `machine: {id, status}`.
  - `workDir` is a path on the target machine, and errors name the machine.
- **REST.** `GET /api/machines` returns id, label, status, `since`, protocol, OS (`linux`,
  `linux-wsl2` or `darwin`) and providers, read from each worker's `/api/agents/providers`.
- **UI.**
  - The "Run on" select shows only when machines are registered. Offline machines are listed but
    disabled with "offline since …". The choice is fixed once the session exists.
  - Session lists show a machine chip and an `unreachable` badge.
  - Remote terminal view: captured content from the detail route, plus "Open on <machine>", a link
    to the worker UI, which its own `AUTH_TOKEN` gates.
  - A live pane websocket proxy is optional (slice 8).

### 4.10 Upgrades and version skew

- **Deploys.** Same repo everywhere. Each worker deploys with `bash scripts/server.sh restart` on
  that machine. For WSL that means inside the distro.
  - There is no remote self-update. Deploys stay explicit operator actions, per AGENTS.md.
- **Protocol and commit.** The descriptor carries `MACHINE_PROTOCOL` (an integer, bumped when the
  hub-to-worker contract breaks) and the Cadre commit. Only the protocol must equal the hub's; a
  protocol mismatch is HTTP 426 on connect and sets `blocked`. A commit mismatch only warns (the
  pairing CLI prints it and the hub logs it on create), per the operator's decision of 2026-10-18.
  - On a protocol mismatch the hub still allows list, get and delete.
  - Create fails closed with "update <machine> (protocol X, hub Y)".
  - Input, clear, startup-input and resume get 503 `machine_protocol_mismatch` with
    `transient:true` (§4.4), so
    queued deliveries wait for the upgrade instead of failing.
  - The machine shows as `blocked`.
- **Upgrade order.**
  - A hub deploy that keeps the protocol leaves workers working, with a commit warning until each
    runs `server.sh restart`. Deploy them back to back, workers first.
  - Breaking changes: stop the remote sessions, then upgrade everything.
  - A laptop that was away during an upgrade comes back `blocked` until it is updated. Nothing is
    lost, and its sessions are still listed.

### 4.11 What does not change

The bus store, envelopes, room and DM semantics, MCP tool behavior, credential format, cloud
sessions, local sessions, the PORT=4310 rule, and the BusinessOS fleet poller.

## 5. Slices (ordered, each shippable and testable)

Sizes count added lines, including tests. S is under 150, M is 150-350, L is 350-600.

1. **Remote spawn, end to end, on a Linux worker (L, about 550 lines).** Claude in tmux only, with
   an explicit `workDir`.
   - **Size:** slice 1 shrinks a little, from about 600. The MCP forward and its per-dial descriptor
     check (about 100 lines with tests) are gone. Part of that comes back: the loopback-check
     relaxation, hashed tokens with stored-state revocation, and the 12-character/5-minute pairing
     codes. The supervisor, hello and event stream are deliberately not here; they are slice 2. Slice 1
     uses a plain descriptor check per request and treats a failure as `unreachable`.
   - Code:
     - Worker mode: loops, observer and sweep off; no MCP listener; fail-closed tailnet bind; every
       route except the descriptor and redeem gated by a `worker:operate` credential; pre-issued
       credential store; `sessionId` and `busCredential` accepted only with the worker credential; no
       `req.duenoAuth` policy derivation.
     - The hub's tailnet MCP listener: loopback bind, `tailscale serve` HTTPS, `requireCredential`.
       Loopback checks relaxed to the hub row's `https:` origin.
     - Machine table load (`http:` workers, `https:` hub row), plus the exported `hostIsPrivate`
       allowlist with `DM_FLEET_PRIVATE_HOSTS_REF`.
     - Durable `machine-id` file and the descriptor `{machineId, label, os, commit, protocol}`.
     - Pairing: `cadre pair` (12-character code, 5-minute TTL, hashed, atomic consume), the descriptor
       check before the code is spent, `POST /api/pairing/redeem`, `cadre machine add <link>`, and
       `cadre machine forget` / `cadre unpair`. Two scopes (`worker:operate`, `bus:agent`); hashed or
       HMAC-signed tokens with a stored-state revocation check on every call.
     - Trust-derivation extraction.
     - Persisted session-to-machine table, with create and detail proxy running on `app.inject` and
       the 503 `transient` mapping.
     - `spawn_session.machine`, and `machine` in the directory. `returnResults` with `machine`
       returns 400.
     - Rejection of Windows-style paths: `C:\…`, `\\wsl$\…`, `\\wsl.localhost\…` and `/mnt/<drive>/…`.
     - Log redaction of `busCredential`, `authorization` and the pairing exchange.
   - Docs: a worker runbook covering Linux, the WSL2 setup in §4.8 (Tailscale inside WSL, tailnet
     bind) and the pairing walkthrough, so incadence can host the first real demo.
   - **Demo:**
     1. Run `cadre pair` on incadence and redeem the link on the hub.
     2. A hub agent calls `spawn_session({machine:'incadence', workDir:'/home/blaine/projects/x'})`.
     3. The child calls `room_send` into a dueno-1 room, over HTTPS direct to the hub listener.
     4. The hub DMs the child, and the delivery shows `injected`.
   - **Tests:** a hub and a worker in process on loopback ports, using real HTTP calls and an injected
     clock.
     - **Pairing and credentials:**
       - An unpaired request is rejected on every worker route except the descriptor and redeem
         route, and on the hub's tailnet listener, even while the global mode is `issue_only`.
       - A reused or expired code is rejected. Codes are not readable in stored state.
       - A descriptor ID or protocol mismatch sets `blocked`, does not burn the code, and no credential
         or `busCredential` leaves the process (asserted on a capture server).
       - A revoked credential is rejected on the next call on both sides, and `forget` while the worker
         is stopped completes on reconnect.
       - Scopes: `worker:operate` cannot reach hub routes, `bus:agent` cannot create sessions, and a
         credential for one machine fails on another.
       - No route returns a raw secret after redemption.
     - A session token is sent only to the hub row's origin.
     - The worker refuses creation without the worker credential, and refuses to bind to a
       non-Tailscale `HOST`.
     - **Spawn trust:** a create carrying the worker credential does not stamp coordinator or operator
       loop metadata, and the worker never mints.
     - A 503 delivery stays queued, then injects once. A protocol mismatch also stays queued.
     - `returnResults` with `machine` returns 400.
     - Windows-style paths are rejected.
     - Pairing codes, credentials and `busCredential` never appear in captured log output.
2. **Supervisor, event stream and lifecycle (L, about 450 lines).**
   - The per-machine supervisor: phases, transient/blocked errors, equal-jitter backoff (1 s to 5 min),
     the 426 protocol check (a commit mismatch only warns).
   - The worker's `GET /api/machine/events?afterSequence=` stream with a persisted sequence, the hub's
     cursor and replay, and the worker `hello` route that resets the backoff.
   - `unreachable`, `blocked` and `since` on rows; the list merge from snapshot plus events.
   - Fail-closed spawn, and `holdReason: machine_offline` on held deliveries.
   - Resume with a hub-minted rotation, and delete with a hub revoke.
   - The `enqueueAgentSessionCommand` branch, and the protocol-mismatch policy.
   - The "forget machine" action in the hub (credential revocation itself is slice 1).
   - Tests replay every §4.7 row with a worker that is stopped and restarted: cursor replay with no
     loss or duplicates, hello resetting a long backoff, and blocked states that do not retry.
3. **returnResults across machines (S, about 100 lines).** The observer reads remote children's hook
   events from the slice 2 stream (`observer.mjs:65-82`). There is no separate polling route.
4. **Telegram and Command Queue for remote sessions (M).**
   - Remote topics are verified (they come from slice 2's list merge).
   - The transcript-delta worker route, with the relay cursor kept on the hub.
   - Interaction rows become hub `addHumanQueueItem` items.
   - Tests: the laptop sleeps during output, then wakes, and the topic gets each line exactly once.
   - This is moved ahead of the UI because the operator requires one Telegram and one queue.
5. **Collabs across machines (M).**
   - `participants[].machine` in bootstrap.
   - Managed worktrees are created and cleaned on the participant's worker, through a worker route
     around `createManagedWorktree` and `cleanupManagedWorktree` (`routes.mjs:94,230`).
   - Cleanup while away is `pending` and is retried.
   - A room whose participants are on dueno-1 and incadence works end to end.
6. **UI and machine API (M).** `GET /api/machines`, the pairing button and add-machine form, the "Run on" select, chips and badges, "Open on
   machine", and provider lists.
7. **Other runtimes and OSes (S-M).**
   - Codex, Pi, structured Claude, `isolatedWorktree`, and nono where Landlock exists, all on the
     worker.
   - macOS tmux-only support with a launchd unit, if the laptop turns out to be a Mac.
   - `task_spawn` and DeepSeek stay hub-only until asked for.
8. **Optional: live pane websocket proxy (M).**

Slices 1-4 meet the stated goal for `spawn_session`: rooms, DMs, deliveries, returnResults, one
Telegram and one queue. Slice 5 extends it to cross-machine collabs.

## 6. Open questions for the operator

1. **Remote MCP servers.** Should remote sessions also get the hub-proxied MCP servers (BusinessOS,
   Sentry, Notion)? v1 gives them only `dueno`, to keep the tailnet surface minimal.
2. **Worker UI.** v1 makes the worker UI read-only plus attach. Do you want spawning from the worker
   UI later? Those sessions would register through the hub.
3. **Provider logins** are set up on each worker by you, inside WSL on incadence. Should the hub
   warn when a worker lacks a provider?
4. **University laptop OS.** If it is a Mac, is tmux-only (no structured runtimes) acceptable?
5. **Project paths.** Is an explicit `workDir` per spawn enough, or should the hub map each repo to
   a per-machine path?
6. **Hub-wide `enforce` rollout.** This design doesn't need it, because the tailnet listener always
   requires credentials. Do you want it scheduled anyway?
7. **Tailnet Serve.** Is HTTPS (MagicDNS and certificates) enabled on the tailnet, and may the hub
   expose `:8766` through `tailscale serve`?

Answered: Tailscale inside WSL2 on incadence is approved, and there are no ACLs (§7). A commit
mismatch only warns and only a protocol mismatch blocks (operator, 2026-10-18). Still to check at
demo time: incadence's Windows build and WSL kernel, which decide whether mirrored networking and
nono's Landlock can work.

## 7. Disagreements and decisions log

- **Round 2:**
  - Folded in the operator constraints: WSL2 as the executor, dueno-1 as the only Telegram and
    queue owner, and sleep and roam as the normal case.
  - Folded in the reviewer's gates: reuse the fleet registry allowlist instead of a new trust
    store; slice 1 adds no new namespace and no new auth system; cloud-watcher losses are stated in
    §3.D; loop ownership is stated in §4.5-4.6.
  - Found while revising: the worker-side orphan worktree sweep would reap live collab worktrees,
    so worker mode turns it off (§4.5).
- **Round 3** (reviewer msg_37dae412c6eb80b0; all 8 items accepted):
  1. **Proof of identity:** the self-reported `machineId` is no longer the proof. Peers are pinned
     by Tailscale stable node ID through local whois, both outbound and inbound (§4.2.2).
     - Refinement over the review: we pin `StableID` rather than the node key, because node keys
       rotate on re-auth and key expiry.
  2. **Machine table:** dropped `parseFleetRegistry` and the `cadre_worker` contract. It is now a
     small table that reuses only `validateFleetBaseUrl` and `DM_FLEET_PRIVATE_HOSTS_REF` (§4.2.1). Superseded in round 4: `validateFleetBaseUrl` is not used.
  3. **MCP forward:** pinned to the hub's IP and stable ID, never follows a name, no buffering,
     immediate 502. A direct hub URL was rejected, to keep the loopback checks. The nono citation is
     corrected: it is a port grant (§4.1).
  4. **Worker bind:** fails closed unless `HOST` is this node's Tailscale IP. `CADRE_PEER_ALLOW`
     takes exact IPs or stable IDs only (§4.1, §4.2.2).
  5. **Proxy and mismatch:** the proxy runs for `app.inject`. Protocol mismatch uses 503
     `transient` for input, clear and resume (§4.4, §4.10).
  6. **Spawn trust and returnResults:** worker mode never derives policy from `req.duenoAuth`, and
     slice 1 tests that. `returnResults` for remote children returns 400 until slice 3.
     `parentThreadId` attach stays on the hub (§4.2.5, §4.4).
  7. **Windows paths:** rejection, including `/mnt/<drive>`, moved into slice 1.
  8. **Redaction:** `busCredential` and `authorization` are redacted from logs on both sides
     (§4.2.6).
  - Residual risk recorded: pane dedupe misses a marker that has scrolled off (§4.7).
- **Round 4** (reviewer msg_06310b36bc795581):
  - **URL checks:** `validateFleetBaseUrl` requires https (`registry.mjs:78`), so the machine table
    now parses `http:` origins itself and reuses only `hostIsPrivate`, `privateAllowedHosts` and
    `DM_FLEET_PRIVATE_HOSTS_REF`. Serve stays off, and the BusinessOS https rule is unchanged.
  - **Naming:** the worker's hub row field is `mcpUrlRef` everywhere.
  - **Whois:** no cache on the credential path. It runs live per credential send, per forward dial
    and per new inbound connection. Only poller status may cache.
  - **Mismatch set:** §4.10 now lists startup-input in the 503 transient set, matching §4.4.
- **2026-10-18 operator:** copy t3code pairing; friends on tailnet; no ACLs, no StableID pin.
  - §4.2 rewritten around pairing, the descriptor ID check and always-on credentials. The whois helper,
    `nodeId`, `CADRE_PEER_ALLOW`, `CADRE_TAILNET_OWNER` and the ACL requirement are gone.
  - Tailscale inside WSL2 on incadence is approved, for reachability only.
  - Residual gaps are recorded in §4.2.7.
- **2026-10-18 t3code code review (t3code-REVIEW.md): supervisor + cursor replay, direct tailnet MCP, tighter pairing; ACL suggestion rejected per operator.**
  - Adopted: per-worker supervisor with `afterSequence` replay, hello, 426 protocol and commit check,
    and `machine_offline` on the existing queue (§4.6). Slice 3's polling route is replaced by the
    event stream.
  - The loopback MCP forward is dropped. Worker sessions call the hub's HTTPS listener directly with
    hub-minted tokens (§4.1, §4.2.4). The review's tailnet ACL and global `enforce` were rejected:
    friends are on the tailnet and the operator chose t3code's model, so the listener enforces
    credentials on its own.
  - Pairing tightened: 12-character codes, 5-minute TTL, hashed, atomic, descriptor checked before
    the code is spent, two scopes, stored-state revocation (§4.2.3, §4.2.5).
  - Slice 1 shrinks from about 600 to about 550 lines; slice 2 grows to L; slice 3 shrinks to S.
- **2026-10-18 operator, slice 1 approval:** block on protocol only. A commit mismatch shows a
  warning (former open question 7), so a hub deploy does not block workers until they restart.
