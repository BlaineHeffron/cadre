# Worker machines runbook

Run Claude sessions on another tailnet machine (a *worker*) while the bus, Telegram, the Command
Queue and every loop stay on the hub. Design: [multi-machine-design.md](multi-machine-design.md).

Placeholders: `<hub>.<tailnet>.ts.net` is the hub's MagicDNS name, `<worker-ip>` the worker's
Tailscale IPv4 address (`tailscale ip -4` on the worker), `<name>` the name you give the worker.

## What works today (slices 1-2)

- `spawn_session({provider: 'claude', machine: '<name>', workDir: '/home/<user>/projects/<repo>'})`.
  Claude in tmux only. `workDir` is a path on the worker.
- The child gets only the `dueno` MCP and calls the hub directly over HTTPS with a token the hub
  minted. It can `room_send`, `agent_dm` and read rooms; room messages to it are delivered.
- The hub runs one supervisor per worker (only where side-effect loops run, so on 4310). It polls
  the worker's event stream every 5 s, and backs off from 1 s to 5 min while the worker is away.
  Session rows show `machine.status` `live`, `unreachable` or `blocked`, with `since`, and keep the
  last-known state.
- A message to a worker that is away or on another protocol stays queued with
  `holdReason: machine_offline` and is injected once the worker is back. A DM sent while the worker
  is unreachable fails at send time; use a room message.
- The worker says hello to the hub on boot, after a sleep and when its addresses change; the hub
  then reconnects at once, without waiting out its backoff. A worker on another protocol shows
  `blocked` and is not retried until it restarts on the hub's protocol.
- Resume and delete go through the hub (resume rotates the session's token; delete revokes it).
  Command Queue and supervisor messages reach remote sessions.
- Not yet: `returnResults` (rejected with 400), Telegram output, the UI, other runtimes. Spawning on
  an unreachable worker fails (503, or 426 on a protocol mismatch); it is never queued.

## Hub setup (once)

1. Add to the hub's live `.env`:

   ```sh
   CADRE_TAILNET_MCP_PORT=8766
   CADRE_HUB_MCP_URL=https://<hub>.<tailnet>.ts.net:8766/mcp
   CADRE_FLEET_PRIVATE_HOSTS_REF=CADRE_MACHINE_HOSTS
   CADRE_MACHINE_HOSTS=<worker-ip>            # comma-separated, one per worker
   ```

   The tailnet MCP listener binds `127.0.0.1:8766` and accepts only hub-minted session tokens,
   whatever `DM_AGENT_BUS_MCP_AUTH` says. The existing `:8765` listener is never exposed.
2. Front it with Serve (needs MagicDNS and HTTPS certificates on the tailnet):
   `tailscale serve --bg --https=8766 http://127.0.0.1:8766`.
3. Restart the hub: `bash scripts/server.sh restart`.

## Linux worker

1. Install and log in to Tailscale (`sudo tailscale up`), Node (see `package.json` `engines`),
   tmux, git and the Claude CLI, then log in to Claude on this machine. Provider logins never pass
   through the hub.
2. Clone Cadre and install the service as on the hub, on the worker port:
   `CADRE_FLEET_PORT=4320 bash scripts/install-fleet-service.sh`.
3. Add to the worker's live `.env` (systemd lets it override the unit's `HOST=127.0.0.1`):

   ```sh
   CADRE_ROLE=worker
   HOST=<worker-ip>
   CADRE_FLEET_PRIVATE_HOSTS_REF=CADRE_MACHINE_HOSTS
   CADRE_MACHINE_HOSTS=<hub>.<tailnet>.ts.net
   AUTH_TOKEN=...                 # gates this worker's own read-only UI
   INTERNAL_BYPASS_TOKEN=...      # distinct values, as on the hub
   BROWSER_SESSION_SECRET=...
   ```

   Worker mode refuses to start unless `HOST` is one of this node's `tailscale ip` addresses, and
   refuses a Telegram bot token in `~/.claude/telegram/config.env`. It never binds `0.0.0.0` or a
   LAN address. It runs no loops, no bot, no MCP listener and no bus observer.
4. Restart with the worker's address: `HOST=<worker-ip> PORT=4320 bash scripts/server.sh restart`.
   If the service started before `tailscaled` was up, it exits and `Restart=on-failure` retries;
   after five quick failures systemd gives up, so run the restart again once Tailscale is up.
5. Keep repos on this machine's own disk and pass their paths as `workDir`.

## WSL2 worker (Windows)

Native Windows is not a Cadre host. Run the worker inside a WSL2 distro (for example Ubuntu 24.04):

1. In the distro, set `/etc/wsl.conf`:

   ```ini
   [boot]
   systemd=true
   ```

   then `wsl --shutdown` from Windows and reopen the distro. Run `loginctl enable-linger $USER` so
   the user service runs without a login shell.
2. Install Tailscale **inside the distro** and join it as its own node:
   `curl -fsSL https://tailscale.com/install.sh | sh` then `sudo tailscale up --hostname <name>`.
   The hub dials this node's own `100.x` address; the Windows host's Tailscale plays no part, and
   nothing is forwarded through Windows localhost.
3. Follow the Linux worker steps inside the distro, with `HOST=<worker-ip>` of the WSL node.
4. Keep repos on the WSL ext4 disk (`/home/<user>/...`). `C:\...`, `\\wsl$\...`,
   `\\wsl.localhost\...` and `/mnt/<drive>/...` work dirs are rejected with
   `workdir_windows_path_unsupported`.
5. Keep it running: add a Windows Task Scheduler entry at logon that runs
   `wsl.exe -d <distro> --exec /bin/true`, so systemd starts Tailscale and the worker, and raise
   `vmIdleTimeout` in `%UserProfile%\.wslconfig` if the VM stops while idle.
6. Install the provider CLIs and log in inside WSL, under the WSL `$HOME`. To watch a session from
   Windows: `wsl.exe -d <distro> tmux attach -t claude-<session-id>`.

## Pair a worker

Run the CLI from each instance's live checkout so it reads that instance's `.env` and state dir.

1. On the worker: `node scripts/cadre.mjs pair`. It prints a one-time link
   `http://<worker-ip>:4320/#<machine-id>.<code>`, valid for 5 minutes. Treat it like a password.
2. On the hub, within 5 minutes: `node scripts/cadre.mjs machine add <name> '<link>'`.
   - The hub first checks that the worker's descriptor reports the link's machine id and the hub's
     protocol. On a mismatch or no answer it stops, sends nothing and the code stays unspent.
   - A different Cadre commit only prints a warning; deploy both from `origin/main` to clear it.
   - The code is single-use. If someone else redeemed it first, `add` fails: run
     `node scripts/cadre.mjs unpair` on the worker and pair again.
3. Each side keeps only the credential it presents, in a `0600` file under its state dir
   (`machines/machines.json`); the other side stores its hash.

## Forget a worker

- On the hub: `node scripts/cadre.mjs machine forget <name>`. The hub side is revoked at once. If the
  worker is unreachable, its side stays pending; run `forget` again when it is back. The running hub
  then drops that machine's sessions from its lists and revokes their tokens within 30 s, even if
  the machine is blocked or away; the tmux sessions keep running on the worker until you end
  them there.
- On the worker: `node scripts/cadre.mjs unpair` drops its hub at once.

## Upgrades

Each machine deploys itself with `bash scripts/server.sh restart` (inside the distro for WSL). A
worker on another protocol keeps its queued messages but rejects spawns until it is updated; its
restart says hello and unblocks it. Slice 2 is protocol 2, so a slice 1 worker shows `blocked` until
it is redeployed.
