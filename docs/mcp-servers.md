# Third-party MCP servers

The capability catalog (`modules/integrations/mcp-server-catalog.mjs`) says what
an operator may select. This document covers the servers behind those IDs: where
they live, how the fleet authenticates, and what still has to be built.

- Endpoint + credential metadata: `modules/integrations/mcp-remote-servers.mjs`
- OAuth broker: `modules/integrations/mcp-oauth.mjs`
- Session credential injection + loopback proxy: `modules/integrations/mcp-remote-credentials.mjs`
- Launch factory: `modules/integrations/mcp-launch-preflight.mjs`
- BusinessOS keeps its dedicated path: `docs/businessos-mcp.md`

## Why the fleet brokers OAuth

Sessions run headless in tmux. A CLI's own remote-MCP OAuth flow needs a
loopback browser redirect on the machine running the CLI, which a spawned
session cannot complete (anthropics/claude-code#69205, #69326). The fleet holds
the grant instead:

1. Operator clicks **Connect** on an unavailable server in the capability
   selector (`POST /api/mcp/oauth/:provider/start`).
2. The fleet runs PKCE authorization. Google and Slack use published endpoints
   and a static OAuth client; other providers are discovered per the MCP spec
   (RFC 8414 authorization-server metadata, RFC 7591 dynamic client registration
   when no static client id is configured).
3. Refresh and access tokens are stored at `0600` in
   `.dueno/state/mcp_oauth_tokens.json`.
4. At launch, each selected server needing a credential gets a random capability
   URL on the loopback agent-bus port. The proxy injects
   `Authorization: Bearer <fresh token>`, refreshing ahead of expiry. Google Ads
   uses the private `x-google-ads-access-token` header instead, so an upstream
   Google token is not presented as MCP resource-server authorization.
5. Session cleanup deletes the capability mapping, so stale URLs stop working.

Credential-free servers (`deepwiki`, `wolfram`, and the stdio reference servers)
are handed to the agent directly with no proxy hop. Nothing is written to
workspace-global `.mcp.json`, `.codex/config.toml`, or `.claude/settings.local.json`.

## Servers

| IDs | Transport | Auth | Source |
|-----|-----------|------|--------|
| `gmail`, `google-drive`, `google-docs`, `google-sheets`, `google-slides`, `google-calendar`, `google-chat`, `google-contacts` | http | none (local) / OAuth (managed) | self-hosted `workspace-mcp` by default; Google-managed servers opt-in |
| `github` | http | `DM_MCP_GITHUB_TOKEN` / `GITHUB_TOKEN` | GitHub's official server |
| `sentry`, `linear`, `vercel`, `supabase`, `cloudflare-observability` | http | OAuth (discovery) | vendor remote servers |
| `slack` | http | none (local session) / OAuth (managed) | self-hosted `slack-mcp-server` by default; Slack-hosted MCP opt-in |
| `notion`, `atlassian` | http | OAuth (discovery) | vendor remote servers |
| `exa`, `huggingface` | http | API key env | vendor remote servers |
| `deepwiki`, `wolfram` | http | none | open remote servers |
| `playwright` | stdio | none | `@playwright/mcp` (Microsoft; pinned npm dependency) |
| `meshy` | stdio | `MESHY_API_KEY` (forwarded) | `@meshy-ai/meshy-mcp-server` (official; pinned npm dependency) |
| `rea` | stdio | none | [`rea-agents`](https://github.com/morluto/rea) (MIT; pinned npm dependency, runs `rea mcp`); decompiled output is untrusted |
| `bevy_brp` | stdio | none | [`bevy_brp_mcp`](https://github.com/natepiano/bevy_brp) 0.22.x for Bevy 0.19; operator runs `cargo install bevy_brp_mcp` |
| `pixellab` | http | `DM_MCP_PIXELLAB_API_KEY` / `PIXELLAB_API_KEY` | PixelLab's official `https://api.pixellab.ai/mcp` |
| `image-gen` | stdio | `DM_MCP_XAI_API_KEY` / `XAI_API_KEY`, `DM_MCP_OPENAI_API_KEY` / `OPENAI_API_KEY`, `DM_MCP_GOOGLE_API_KEY` / `GOOGLE_API_KEY` / `GEMINI_API_KEY` (forwarded) | [`image-router-mcp`](https://github.com/JiaDians/image-router-mcp) (MIT; pinned npm dependency) |
| `filesystem`, `git`, `fetch`, `memory`, `sequential-thinking`, `time` | stdio | none | maintained MCP reference servers |
| `espocrm`, `invoice-ninja` | http | API key env | self-hosted; endpoint must be supplied |
| `seodata` | stdio | none (optional `SEODATA_API_KEY`) | locally built [`seodata-mcp`](https://github.com/BlaineHeffron/seodata-mcp) |
| `google-ads` | http | separate Google Ads OAuth grant + developer token | locally hosted `google-ads-mcp` |

`filesystem` is scoped to the session work dir. Google scopes are read-oriented:
Gmail gets `gmail.readonly` + `gmail.compose`, Calendar gets read and free/busy
only. No send scope is requested anywhere.

### Known gates

- Slack runs in **local mode** by default: `slack` points at a self-hosted
  [`slack-mcp-server`](https://github.com/korotovsky/slack-mcp-server) that acts
  as the operator's existing Slack user. No workspace-admin app install, so it
  works in workspaces the operator belongs to but does not own. Slack's hosted
  `mcp.slack.com` stays available behind `DM_MCP_SLACK_MODE=managed` but only for
  workspaces that will install a Slack app. See "Slack setup" below.
- Google runs in **local mode** by default: every `google-*` ID resolves to one
  self-hosted `workspace-mcp` endpoint that holds the Google grant itself, so
  the fleet brokers nothing and injects no credential. The managed
  `*mcp.googleapis.com` servers stay available behind `DM_MCP_GOOGLE_MODE=managed`
  but require Workspace Developer Preview enrollment. See "Google setup" below.
- `google-chat` needs a Workspace account even in local mode; the other Google
  services work with a free Google account.
- `espocrm` and `invoice-ninja` have no public endpoint; both report
  `endpoint_not_configured` until an override supplies one.
- `meshy` and `pixellab` spend paid credits. They require explicit
  selection (`mcpServers: { add: ['meshy'] }`) and are in no profile.
  `MESHY_API_KEY` is forwarded into the stdio server: in the `0600` Claude/Pi
  launch config, and to Codex by name (see the secret forwarding note below).
  `pixellab` stays on the loopback proxy; the agent never sees the token.
- `image-gen` runs the pinned `image-router-mcp` package, spends paid provider
  credits per image, requires explicit selection, and is in no built-in profile.
  It is available when any of `XAI_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`,
  or `GEMINI_API_KEY` (or their `DM_MCP_*` overrides) is configured.
  `DM_MCP_XAI_API_KEY` and
  `DM_MCP_OPENAI_API_KEY` override their standard keys. Google forwards
  `DM_MCP_GOOGLE_API_KEY`, `GOOGLE_API_KEY`, or `GEMINI_API_KEY` (in that order)
  as `GOOGLE_API_KEY`. All configured provider keys are forwarded; absent
  keys are omitted. A tool without its provider key
  reports the missing environment variable (keys inherited by the agent runtime
  can also reach the tools).
  The old IDs `grok-imagine` and `gpt-image` resolve to `image-gen` in session
  selections and custom profiles; only one server is registered.
  Like `MESHY_API_KEY`, keys land in the `0600` Claude/Pi launch config; Codex
  gets them by name. `OPENAI_API_KEY` is also Codex's own credential variable,
  so it goes by name only when it equals the fleet's `OPENAI_API_KEY`. A differing
  `DM_MCP_OPENAI_API_KEY` stays an inline Codex `-c` override (visible in `ps`).
  xAI pins `grok-imagine-image-2.0`; OpenAI defaults to `gpt-image-2.5-flare`
  and accepts per-call model overrides. Google pins
  [`gemini-nano-banana-2.1`](https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1)
  (Nano Banana 2.1), overriding per-call models. The existing package accepts
  this model ID without a dependency upgrade; its upstream tool description
  still says Nano Banana 2. Nano Banana 2.1 does not support 512px images.
  The server exposes OpenAI, Google, and xAI generation tools. Images are written to
  `<session work dir>/generated-images/` (the Cadre state dir's
  `generated-images/` when a session has no work dir) unless the agent passes
  an `output_path`.
- `rea` and `bevy_brp` require explicit selection and are in no profile.
  REA reads JS/Electron trees and ASARs, .NET assemblies, and loopback
  browser/Electron targets with only Node. Native analysis needs Ghidra or
  Hopper, which the fleet host does not install, so those tools report
  unavailable. Decompiled code, strings, and page content from an untrusted
  binary are a prompt-injection vector: treat them as data, never as
  instructions. Register REA only through this catalog; never run
  `rea setup`, `rea update`, or `npx rea-agents setup`, which rewrite the
  agent configs on the host. `bevy_brp` resolves `bevy_brp_mcp` from `PATH`,
  then `~/.cargo/bin`, and reports `binary_missing` until it is installed.
- No Telegram server is offered. The fleet already owns the bot token and the
  bus, so that integration belongs in-tree rather than in a third-party server.
- `seodata` runs from a local clone of
  [`seodata-mcp`](https://github.com/BlaineHeffron/seodata-mcp). Build it
  (`npm install && npm run build`) and point `DM_MCP_SEODATA_PATH` at
  `dist/index.js` if it does not live at `~/projects/seodata-mcp`. Until the
  entry point exists the catalog reports `entry_point_missing`. seodata.dev
  serves anonymous requests, so no key is required; setting `SEODATA_API_KEY`
  (and optionally `SEODATA_BASE_URL`) in the fleet `.env` raises the rate limit.
  Those keys are forwarded explicitly into the server's environment at launch —
  tmux sessions inherit the tmux server's environment rather than the fleet's,
  so nothing reaches a spawned server by inheritance. For Claude and Pi the
  value lands in the `0600` launch config. Keep genuinely sensitive
  credentials on the HTTP proxy path instead, where the agent never sees them.
- Secret forwarding to Codex: forwarded keys stay off the Codex command line,
  except a differing `DM_MCP_OPENAI_API_KEY` for `image-gen` (above). Cadre writes them to a `0600` per-session file, the tmux pane exports
  them without echoing a value (app-server Codex gets them in its process
  environment), and `mcp_servers.<id>.env_vars=[...]` tells Codex to copy them
  by name into the server. The forwarded value is still agent-visible: the
  server, and Codex itself, can read it.
- `paper-search` (Research Workbench) receives `SEMANTIC_SCHOLAR_API_KEY`,
  `ADS_API_KEY`, `OPENALEX_EMAIL`, and `UNPAYWALL_EMAIL` when they are set in the
  fleet environment; unset keys are not forwarded.
- `google-ads` is intentionally separate from every Google Workspace catalog
  ID. It is unavailable until its endpoint, developer token, OAuth client, and
  dedicated `google-ads` grant are ready. The agent receives only a random
  loopback proxy URL; the proxy injects the refreshed OAuth bearer token,
  developer token, and optional MCC ID on each request. No Ads secret enters a
  spawned command, process listing, prompt, or launch config.

## Configuration

```env
DM_MCP_SERVER_OVERRIDES_JSON={"espocrm":{"url":"https://crm.internal/mcp"}}
DM_MCP_OAUTH_PUBLIC_BASE_URL=https://fleet.example.com
DM_MCP_PROXY_PATH_PREFIX=/mcp-proxy

DM_MCP_GOOGLE_MODE=local                              # or 'managed'
DM_MCP_GOOGLE_LOCAL_URL=http://127.0.0.1:8000/mcp
DM_MCP_GOOGLE_ADS_URL=http://127.0.0.1:3300/mcp
DM_MCP_GOOGLE_ADS_CLIENT_ID=...                       # dedicated Ads OAuth client
DM_MCP_GOOGLE_ADS_CLIENT_SECRET=...
DM_MCP_GOOGLE_ADS_DEVELOPER_TOKEN=...
DM_MCP_GOOGLE_ADS_LOGIN_CUSTOMER_ID=1234567890        # optional MCC, no dashes
DM_MCP_SLACK_MODE=local                               # or 'managed'
DM_MCP_SLACK_LOCAL_URL=http://127.0.0.1:13080/mcp
DM_MCP_SEODATA_PATH=/path/to/seodata-mcp/dist/index.js
GOOGLE_OAUTH_CLIENT_ID=...                            # consumed by workspace-mcp
GOOGLE_OAUTH_CLIENT_SECRET=...
DM_MCP_GOOGLE_CLIENT_ID=...                           # managed mode only
DM_MCP_GOOGLE_CLIENT_SECRET=...                       # managed mode only
SLACK_MCP_XOXC_TOKEN=...                              # local mode: browser session
SLACK_MCP_XOXD_TOKEN=...
# SLACK_MCP_XOXP_TOKEN=...                            # local mode alternative
# SLACK_MCP_ADD_MESSAGE_TOOL=true                     # allow posting
DM_MCP_SLACK_CLIENT_ID=...                            # managed mode only
DM_MCP_SLACK_CLIENT_SECRET=...                        # managed mode only
DM_MCP_GITHUB_TOKEN=...
DM_MCP_EXA_API_KEY=...
DM_MCP_PIXELLAB_API_KEY=...                           # pixellab.ai account API token
MESHY_API_KEY=...                                     # forwarded into the meshy stdio server (agent-visible)
SEMANTIC_SCHOLAR_API_KEY=...                          # optional; also ADS_API_KEY, OPENALEX_EMAIL, UNPAYWALL_EMAIL for paper-search
DM_MCP_XAI_API_KEY=...                                # or XAI_API_KEY; forwarded into image-gen (agent-visible)
DM_MCP_OPENAI_API_KEY=...                             # or OPENAI_API_KEY; forwarded into image-gen (agent-visible)
DM_MCP_GOOGLE_API_KEY=...                             # or GOOGLE_API_KEY / GEMINI_API_KEY; forwarded into image-gen (agent-visible)
DM_MCP_HUGGINGFACE_TOKEN=...
DM_MCP_ESPOCRM_TOKEN=...
DM_MCP_INVOICE_NINJA_TOKEN=...
```

The redirect URI to register with every provider is
`<DM_MCP_OAUTH_PUBLIC_BASE_URL>/api/mcp/oauth/callback`. With the base URL unset
it falls back to `http://<HOST>:<PORT>/api/mcp/oauth/callback`.

## Google Ads write setup

`google-ads` is a separate, explicitly selected write capability. It does not
reuse the read-oriented Google Workspace grant and it is not Google's official
read-only Ads MCP. Pause-on-create, `confirm: true`, and the named-only tool
surface are guarantees of the Ads MCP process, not of the fleet proxy. The
proxy only injects credentials onto loopback.

1. **Build and run the server.** Host [`google-ads-mcp`](https://github.com/BlaineHeffron/google-ads-mcp)
   on loopback (`npm install && npm run build && npm start`; port 3300 by
   default). Set `DM_MCP_GOOGLE_ADS_URL=http://127.0.0.1:3300/mcp`. Until a URL
   is set the catalog reports `endpoint_not_configured`; if the configured
   process is down, launch preflight reports `health_check_failed`.
2. **Developer token.** In the API Center of a Google Ads manager account,
   obtain a developer token with the access level needed for the target
   accounts. Set it as `DM_MCP_GOOGLE_ADS_DEVELOPER_TOKEN` in the fleet service
   environment. Until present the catalog reports `credential_missing`. The
   proxy sends it directly as the Google-required `developer-token` header; it
   is never persisted in session capability state.
3. **OAuth client.** Create a Google OAuth Web client and register
   `<DM_MCP_OAUTH_PUBLIC_BASE_URL>/api/mcp/oauth/callback`. Prefer the dedicated
   `DM_MCP_GOOGLE_ADS_CLIENT_ID` and `DM_MCP_GOOGLE_ADS_CLIENT_SECRET`. The
   Workspace client is deliberately not reused, incremental authorization is
   disabled, and the broker rejects any token response whose scope is not
   exactly `https://www.googleapis.com/auth/adwords`.
4. **MCC routing.** If the OAuth user reaches a client account through a manager,
   set `DM_MCP_GOOGLE_ADS_LOGIN_CUSTOMER_ID` to that manager's 10-digit ID with
   no dashes. Tool `customer_id` arguments identify the target client account,
   not the manager. Direct client-account access can omit the MCC setting.
5. **Consent and verify.** Click **Connect google-ads** in the capability
   selector. Before consent the catalog reports `oauth_not_connected`. First
   select `google-ads` for a test-account session, call the connection/status
   and list tools, create only paused resources, and inspect them in Google Ads
   before enabling anything.

The fleet OAuth broker holds and refreshes the grant. Do not add Ads credentials
to repository `.mcp.json`, `.codex/config.toml`, or caller-supplied spawn fields.

## Slack setup (local, workspaces you do not own)

Slack's hosted MCP requires a Slack app installed on the target workspace.
Members of workspaces they do not administer cannot do that. Local mode instead
runs [`slack-mcp-server`](https://github.com/korotovsky/slack-mcp-server) on
loopback and authenticates as the operator's existing Slack user — the same
access they already have in the Slack web client. No bot, no admin approval.

Session tokens (`xoxc` / `xoxd`) are as privileged as being logged into Slack.
They stay in the fleet `.env` and the local server; agents only get a loopback
URL. Treat them like a password and rotate them if they leak.

1. **Extract the browser session** while logged into the workspace you want
   agents to use (open that workspace in the Slack web client):

   - **xoxc.** DevTools → Console. Type `allow pasting`, then:

     ```js
     JSON.parse(localStorage.localConfig_v2).teams[document.location.pathname.match(/^\/client\/([A-Z0-9]+)/)[1]].token
     ```

     The value starts with `xoxc-`. Each workspace has its own `xoxc`; extract
     from the workspace agents should read. The `d` cookie is shared across
     workspaces on the same Slack account.
   - **xoxd.** DevTools → Application → Cookies → the cookie named `d`.
     The value starts with `xoxd-`.

2. **Fleet `.env`.**

   ```env
   DM_MCP_SLACK_MODE=local
   DM_MCP_SLACK_LOCAL_URL=http://127.0.0.1:13080/mcp
   SLACK_MCP_XOXC_TOKEN=xoxc-...
   SLACK_MCP_XOXD_TOKEN=xoxd-...
   # Optional: allow agents to post (off by default).
   # SLACK_MCP_ADD_MESSAGE_TOOL=true
   ```

3. **Install the loopback server** as a systemd user unit:

   ```bash
   scripts/slack-mcp.sh install
   ```

   It starts `npx slack-mcp-server --transport http` on `127.0.0.1:13080`.
   `serve` runs the same command in the foreground; `status` / `logs` / `uninstall`
   match the Google script. Boot-time start needs user lingering, which the
   fleet service already relies on.

4. **Verify.** `scripts/slack-mcp.sh status` reports `up`, and
   `GET /api/agents/mcp-servers` shows Slack as `availability.state: "configured"`.
   Spawn a session with `slack` selected and confirm the tools load.

If the endpoint is configured but down, launch preflight marks Slack `degraded`
with `health_check_failed` and the session still starts without it. Session
tokens expire when you log out of Slack in the browser or Slack invalidates the
session — re-extract and restart `slack-mcp` if tools start failing auth.

### Switching to Slack's hosted MCP

Only useful on a workspace you can install an internal Slack app on. Set
`DM_MCP_SLACK_MODE=managed`, provide `DM_MCP_SLACK_CLIENT_ID` and
`DM_MCP_SLACK_CLIENT_SECRET`, register
`<DM_MCP_OAUTH_PUBLIC_BASE_URL>/api/mcp/oauth/callback` as a redirect URI, add
the user-token scopes Slack lists for MCP, and click **Connect slack**. Unlisted
public apps cannot use Slack's hosted MCP.

## Google setup (local, no preview enrollment)

The fleet points every `google-*` ID at a self-hosted
[`workspace-mcp`](https://github.com/taylorwilsdon/google_workspace_mcp) server
on loopback. That server does its own Google OAuth with an ordinary Google Cloud
client, so nothing here needs the Workspace Developer Preview Program, and a
free @gmail account works for everything except Google Chat.

1. **Google Cloud project.** Enable the ordinary Workspace APIs — *not* the
   `*mcp.googleapis.com` ones, which exist only for Google's managed servers:

   | Console name | Service ID |
   |---|---|
   | Gmail API | `gmail.googleapis.com` |
   | Google Drive API | `drive.googleapis.com` |
   | Google Docs API | `docs.googleapis.com` |
   | Google Sheets API | `sheets.googleapis.com` |
   | Google Slides API | `slides.googleapis.com` |
   | Google Calendar API | `calendar-json.googleapis.com` |
   | Google Tasks API | `tasks.googleapis.com` |
   | People API | `people.googleapis.com` |
   | Google Chat API | `chat.googleapis.com` (Workspace accounts only) |
   | Google Forms API | `forms.googleapis.com` |

   Configure the OAuth consent screen as External / Testing and add your account
   as a test user. Testing-mode refresh tokens expire after seven days — publish
   the app once you are past trying it out.

   With `--tool-tier extended` and no `--tools` narrowing, the server requests
   read and write scopes for every enabled service, Gmail's `gmail.send` and
   `gmail.modify` included. Set `WORKSPACE_MCP_READ_ONLY=1` before `install` if
   agents should never send or mutate.
2. **OAuth client.** Use type *Web application* — it is the only type whose
   Console form exposes **Authorized redirect URIs**. Add
   `http://localhost:8000/oauth2callback`, matching `WORKSPACE_MCP_PORT`.
   (Desktop clients hide that field because Google implicitly allows loopback
   redirects for them, but the explicit Web-application registration is the
   supported path here.)
3. **Fleet `.env`.** The client credentials are read by the local server, not by
   the fleet broker:

   ```env
   GOOGLE_OAUTH_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=...
   DM_MCP_GOOGLE_MODE=local
   DM_MCP_GOOGLE_LOCAL_URL=http://127.0.0.1:8000/mcp
   USER_GOOGLE_EMAIL=you@example.com
   ```

   `USER_GOOGLE_EMAIL` is the granted mailbox. It lives next to the OAuth client
   in `.env`. After a server restart, tools may omit `user_google_email` and the
   server fills this address. The upstream server does **not** reject a different
   caller-supplied address; a guessed email still starts a new OAuth flow.

   Optional knobs, read by the script and baked into the unit at install time:
   `WORKSPACE_MCP_PORT` (default `8000` — change `DM_MCP_GOOGLE_LOCAL_URL` and the
   redirect URI to match), `WORKSPACE_MCP_TOOL_TIER` (`core`, `extended`, or
   `complete`), `WORKSPACE_MCP_TOOLS` to expose only some services, and
   `WORKSPACE_MCP_READ_ONLY=1` to drop every write scope.

4. **Install uv** if it is missing (`https://docs.astral.sh/uv/`), then install
   the server as a systemd user unit so it comes back on every boot:

   ```bash
   scripts/google-workspace-mcp.sh install
   ```

   It writes `~/.config/systemd/user/google-workspace-mcp.service`, enables it,
   and starts `uvx workspace-mcp --transport streamable-http --tool-tier extended`
   on `127.0.0.1:8000` with every service exposed. The unit reads the fleet
   `.env`, so the OAuth client lives in one place. `serve` runs the same command
   in the foreground; `logs` tails the journal; `uninstall` removes the unit.
   Boot-time start needs user lingering (`loginctl enable-linger $USER`), which
   the fleet service already relies on.
5. **Consent once.** On the first Google tool call the server prints an
   authorization URL; approve it in a browser. The grant is cached under
   `~/.google_workspace_mcp/credentials/<account>.json`, so later sessions and
   restarts reuse it headlessly.
6. **Keep it running.** For an always-on setup, a user unit works:

   ```ini
   # ~/.config/systemd/user/google-workspace-mcp.service
   [Unit]
   Description=Google Workspace MCP (local)
   [Service]
   ExecStart=/path/to/cadre/scripts/google-workspace-mcp.sh serve
   Restart=on-failure
   [Install]
   WantedBy=default.target
   ```

   `systemctl --user enable --now google-workspace-mcp`.
7. **Verify.** `scripts/google-workspace-mcp.sh status` shows the unit and reports `up`, and
   `GET /api/agents/mcp-servers` should show the Google entries as
   `availability.state: "configured"`. Spawn a session with `gmail` selected and
   confirm the tools load.

If the endpoint is configured but down, launch preflight marks those servers
`degraded` with `health_check_failed` and the session still starts without them.

### Switching to Google's managed servers

Only worth it once the account is accepted into the Workspace Developer Preview
Program. Set `DM_MCP_GOOGLE_MODE=managed`, provide `DM_MCP_GOOGLE_CLIENT_ID` and
`DM_MCP_GOOGLE_CLIENT_SECRET` from an enrolled project, register
`<DM_MCP_OAUTH_PUBLIC_BASE_URL>/api/mcp/oauth/callback` as a redirect URI, and
click **Connect google** in the capability selector. The fleet broker then holds
the grant and proxies the managed endpoints, with read-oriented scopes only
(Gmail read + compose, Calendar read and free/busy; no send scope anywhere).

## Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/agents/mcp-servers` | capability catalog with availability |
| GET | `/api/mcp/oauth` | provider status and the callback URI to register |
| POST | `/api/mcp/oauth/:provider/start` | begin consent, returns `authorizeUrl` |
| GET | `/api/mcp/oauth/callback` | provider redirect target (fleet auth required) |
| DELETE | `/api/mcp/oauth/:provider` | forget stored tokens |
