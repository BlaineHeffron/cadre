# Cadre

Cadre is a self-hosted control plane for running, coordinating and monitoring
coding-agent sessions. It launches Claude Code, Codex and Pi sessions on your
own machine, lets them talk to each other through an agent bus, and gives you
one web dashboard (and optionally Telegram) to watch and steer them.

It is a single Node.js service (Fastify + Preact) that serves the UI and API,
keeps state on local disk (optionally Postgres), and runs agents in tmux or
through structured runtimes.

## Features

- **Agent sessions**: spawn, attach to, message and terminate Claude Code,
  Codex and Pi sessions from the UI or API, with per-session working
  directories and managed git worktrees.
- **Agent bus**: persistent collaboration rooms and direct messages between
  agents, exposed to sessions over MCP. Collab and conference threads can
  bootstrap several participants at once.
- **Coordinators and scheduled agents**: authenticated sessions can spawn child
  sessions and loops; scheduled agents run prompts on an interval.
- **MCP catalog**: a capability catalog of MCP servers and profiles, selectable
  per session, with a built-in OAuth broker for remote servers.
- **Launch skills**: reusable prompt snippets inserted at launch, from the
  stock `config/skills`, custom read-only directories, and a writable local
  overlay edited in the UI.
- **Prompt profiles**: named system-prompt profiles, extendable from a private
  file.
- **Telegram remote control**: relay session output to Telegram topics and
  reply from your phone.
- **Monitoring dashboard**: session state, attention queue, fleet deployments,
  health and ops metrics, and production controls (kill switches, backups).

## Requirements

- Node.js >= 22.19.0 (see `.node-version`; `npm run check:node` verifies it)
- `tmux` on `PATH`
- The provider CLIs you plan to use, installed and logged in: `claude`
  (Claude Code), `codex`, and/or `pi` (override the Pi binary with `PI_BIN`)
- Linux with systemd user services if you want to run it as a service

## Quick start

```bash
git clone https://github.com/BlaineHeffron/cadre.git
cd cadre
npm install
cp .env.example .env
npm run setup            # self-signed certs in certs/ and random AUTH_TOKEN etc. in .env
```

Run a development server with side-effect loops suppressed:

```bash
CADRE_DISABLE_SIDE_EFFECTS=1 \
CADRE_GITHUB_AGENT_POLLER_ENABLED=0 \
CADRE_GITHUB_AGENTS_ENABLED=0 \
CADRE_SCHEDULED_AGENT_PUMP_ENABLED=0 \
TELEGRAM_BRIDGE=0 \
PORT=4400 AGENT_BUS_MCP_HTTP_PORT=8766 \
npm run dev
```

Open `http://127.0.0.1:4400` (or `https://` if you set `TLS_ENABLED=1`) and
sign in with the `AUTH_TOKEN` from `.env`. `npm start` runs without file
watching.

## Configuration

Settings come from environment variables, usually in `.env` (see
`.env.example` and `config.mjs`). Variables use the `CADRE_` prefix. The legacy
`DM_` and `DUENO_` names still work: `DM_X` and `DUENO_X` both read as
`CADRE_X`, and the `CADRE_` name wins if both are set. A few unprefixed names
are shared with the host (`HOST`, `PORT`, `AUTH_TOKEN`, `TLS_ENABLED`,
`TLS_CERT`, `TLS_KEY`, `AGENT_BUS_MCP_HTTP_PORT`).

Runtime state lives in `.dueno/state` under the working directory by default
(`CADRE_STATE_DIR` overrides it). Those paths keep their original names for
compatibility with existing installs.

### Private overlays

Keep personal or organization-specific configuration outside the repo and point
Cadre at it:

| Variable | Purpose |
| --- | --- |
| `CADRE_PROMPT_PROFILES_FILE` | JSON object of extra prompt profiles; `CADRE_PROMPT_PROFILES_JSON` entries merge on top |
| `CADRE_LAUNCH_SKILLS_CUSTOM_DIRS` | Path-delimited, read-only skill directories scanned after the stock skills |
| `CADRE_COMMAND_CENTER_DEPLOYMENT_REGISTRY_PATH` | Deployment registry for the Fleet page |
| `MCP_CAPABILITY_PROFILES_JSON` | Extra MCP capability profiles |
| `CADRE_MCP_SERVER_OVERRIDES_JSON` | Per-server MCP catalog overrides |
| `CADRE_DEFAULT_AGENT_WORKDIR` | Working directory for sessions started without one (default `~/projects/cadre`) |

### Optional integrations

- **Telegram**: put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in
  `~/.claude/telegram/config.env`. The bridge runs with the other side-effect
  loops (`TELEGRAM_BRIDGE=0` turns it off); session-output relay is opt-in via
  `CADRE_TELEGRAM_RELAY_ENABLED=1`.
- **GitHub agents**: `CADRE_GITHUB_AGENTS_ENABLED`,
  `CADRE_GITHUB_AGENT_POLLER_ENABLED`, `CADRE_GITHUB_AGENT_REPO_PATHS_JSON`.
- **Third-party MCP servers and OAuth**: see [docs/mcp-servers.md](docs/mcp-servers.md).
- **Postgres state**: set `DATABASE_URL`, then `npm run migrate:postgres-state`.

## Running as a service

`scripts/install-fleet-service.sh` installs a systemd user service that runs
from a separate live checkout (default `<dev clone>-live`, override with
`CADRE_FLEET_LIVE_DIR`) pinned to `origin/main`, plus a daily state-backup
timer. The service listens on `127.0.0.1:4310`; expose it through a private
proxy such as Tailscale Serve rather than the public internet.

```bash
bash scripts/install-fleet-service.sh   # once
bash scripts/server.sh restart           # sync live checkout to origin/main, install, check, restart
bash scripts/server.sh status            # also: start, stop, logs
```

### Phone access

Cadre is an installable PWA. To reach it from a phone on your tailnet:

1. Serve it over HTTPS: `tailscale serve --https=443 http://127.0.0.1:4310`.
2. On a signed-in desktop, open Cadre at the `https://<host>.<tailnet>.ts.net`
   URL, go to Settings, and press **Pair phone**.
3. Scan the QR code (or send yourself the link). The link carries a single-use
   code that expires after 5 minutes, in the URL fragment (`#pair=`), so it
   never reaches the server or its logs. Opening it signs the phone in with the
   normal session cookie.
4. Install: **Share → Add to Home Screen** on iOS Safari, or **Install app** in
   Chrome's menu on Android.

Other reverse proxies must pass the original `Host` header through (nginx:
`proxy_set_header Host $host;`); pairing rejects requests whose `Origin` does
not match `Host`.

## Safety

Cadre's background loops (GitHub pollers, scheduled agents, Telegram bridge,
the agent-bus MCP HTTP listener) act on the outside world. They only run when
`PORT=4310` or when `CADRE_ALLOW_SIDE_EFFECTS=1` is set, and
`CADRE_DISABLE_SIDE_EFFECTS=1` forces them off. When running a second instance
next to a live one, set both `PORT` and `AGENT_BUS_MCP_HTTP_PORT` to unused
values. See [docs/production-controls-runbook.md](docs/production-controls-runbook.md).

## Tests

```bash
npm run check    # syntax check
npm test         # full test suite
node --test tests/<file>.test.mjs
```

Contributor and agent rules are in [AGENTS.md](AGENTS.md).

## Documentation

- [Docs index](docs/README.md)
- [Local development](docs/local-development.md)
- [Agentic architecture](docs/agentic-architecture.md)
- [Agent bus design](docs/agent_bus_design.md) and [agent bus MCP](docs/agent-bus-mcp.md)
- [Durable task API](docs/durable-task-api.md)
- [Third-party MCP servers](docs/mcp-servers.md)
- [Codex plugin selection](docs/codex-plugin-selection.md)
- [DeepSeek harness](docs/deepseek-harness.md)
- [Production controls runbook](docs/production-controls-runbook.md) and [SLOs](docs/production-slos.md)
- [Repo quality check](docs/repo-quality-check.md)

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
