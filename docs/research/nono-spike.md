# nono sandboxing spike: Claude Code and Codex under nono

Status: research only (2026-10-05). No Cadre code changed. All runs were by hand, on a throwaway repo plus a
linked worktree under the session scratchpad. I ran one Claude Code TUI session and one Codex TUI session
inside a private tmux server (`tmux -L nonospike`), with one prompt each. Many single checks were run directly as
`nono run … -- <cmd>` from the worktree.

## Versions

| Item | Version |
|---|---|
| nono | 0.79.0 (`~/.local/bin/nono`) |
| Registry pack `nolabs-ai/claude` | 0.1.4. Profile `claude` 1.0.0, `policy.json` sha256 `7605ee62…ab8a0` |
| Registry pack `nolabs-ai/codex` | 0.2.3. Profile `codex` 1.0.0, `policy.json` sha256 `aef23ca6…03574` |
| Claude Code / Codex CLI | 2.1.289 (`--model haiku`) / codex-cli 0.160.0 (`model_reasoning_effort=low`) |
| Kernel | 7.0.11, Landlock **V6** (fs, refer, truncate, TCP, ioctl, signal + abstract-socket scoping) |

**`nono pull` installs agent wiring globally, not just profiles.** `nono pull nolabs-ai/claude` merged
`enabledPlugins["nono@nolabs-ai"]=true` into `~/.claude/settings.json`. It also added the plugin to
`~/.claude/plugins/{known_marketplaces,installed_plugins}.json`. `nono pull nolabs-ai/codex` inserted a
`developer_instructions` block, a marketplace and an enabled plugin into `~/.codex/config.toml`. The block landed
*after* the existing `[desktop]` table, despite `position: top`. So every live Claude and Codex session on the
host picked up the nono plugin. I reversed this immediately with `nono remove` (12/12 and 6/6 directives
reversed; empty dirs removed by hand). The tests used scratchpad copies of the two profile files, with
`$PACK_DIR` pointed at a copy of the pack. Left on the host: `~/.config/nono/{packages/lockfile.json,profile-drafts/}`
and `~/.local/state/nono/` (audit logs, `update-check.json`).

## Findings

"Stock" means the registry profile plus `--allow-cwd` (cwd = linked worktree, read-write).
`claude-strict` is the claude profile without its `/tmp/claude-$UID` grant (see risk 2). My scratchpad lives
under that directory, so the stock claude profile hides every path failure in the scratch repo.

| Item | Stock result | Exact error | Minimal grant that fixes it |
|---|---|---|---|
| git commit from linked worktree | Fails: the worktree's gitdir and the common dir are unreadable | `fatal: not a git repository: <main>/.git/worktrees/wt`. With `--read <main>/.git` only: `Unable to create '<main>/.git/worktrees/wt/index.lock': Permission denied`, then `insufficient permission for adding an object to repository database <main>/.git/objects` | `--read <main>/.git --allow <main>/.git/worktrees/<name> --allow <main>/.git/objects --allow <main>/.git/refs --allow <main>/.git/logs`. Keeps `.git/config` and `.git/hooks` read-only. `--allow <main>/.git` also works but lets the agent plant host-side git hooks |
| Signed commit (host has `commit.gpgsign=true`, `gpg.format=ssh`) | Fails in every profile | `error: could not create temporary file: Permission denied` (`/tmp/.git_signing_buffer_tmp*` opened `O_RDWR`; `/tmp` is **write-only** in the base profile). Next: `Couldn't load public key ~/.ssh/id_ed25519.pub` | `TMPDIR=<granted dir>` + `--allow <that dir>` + `--read-file ~/.ssh/id_ed25519.pub`. `--bypass-protection` was not needed. The ssh-agent socket (`/run/user/1000/gcr/ssh`) needs no grant while AF_UNIX mediation is off |
| `node_modules` symlink into another checkout | Read fails; writes through it fail | `Error: EACCES: permission denied, open '<other>/node_modules/leftpad/index.js'` | `--read <other>/node_modules`. Landlock checks the resolved target, not the link |
| Cadre HTTP (4310) and dueno MCP (`127.0.0.1:8765/mcp`, HTTP) | Work: network is unrestricted by default. `tools/list` returned 50 tools; both TUIs listed dueno tools | — | None in default mode. Claude's `--mcp-config` file lives in `cadre-live/.dueno/state/…` and needs `--read-file`. Codex worked with `-c mcp_servers.dueno.url=… -c mcp_servers.dueno.bearer_token_env_var=…`. **With any `--allow-domain` (proxy mode), localhost is blocked even with `--open-port 8765` or `--allow-connect-port 8765`** (`Immediate connect fail for 127.0.0.1: Permission denied`). It works only with `--sandbox-policy landlock`, or with `--block-net --open-port 8765` |
| `.agent_bus/hooks` (hook root = nearest dir with `.git`, i.e. the worktree) | Read, execute and append all succeed: the dir is inside the read-write workdir | — | None for the files. The Cadre hook *recorder* fails: `node <cadre>/scripts/agent-hooks/log-event.mjs` exits 1 because the Cadre checkout is unreadable. Fix: `--read <cadre checkout>`. Then the Claude session wrote SessionStart, UserPromptSubmit, Pre/PostToolUse, Stop and SessionEnd to `claude-<uuid>.jsonl` via `--plugin-dir …/claude-fleet` |
| `~/.claude`, `~/.claude.json` | claude profile: read-write (auth worked, "Claude Max"). codex profile: denied | `head: cannot open '~/.claude/.credentials.json': Permission denied` (codex profile) | Already in claude profile. Claude also refuses to start without its temp dir: `Temp directory /tmp/claude-1000 is not readable … Set CLAUDE_CODE_TMPDIR`. The stock profile grants all of `/tmp/claude-$UID`. Per-session alternative: `CLAUDE_CODE_TMPDIR=<dir>` + `--allow <dir>` (worked) |
| `~/.codex` (auth.json, config.toml, sessions, sqlite) | codex profile: read-write; Codex authenticated and ran. claude profile: denied | `head: cannot open '~/.codex/auth.json': Permission denied` (claude profile) | Already in codex profile. Codex's own trust prompt writes `[projects."<repo root>"]` to `~/.codex/config.toml`; this happens without nono too, despite `-c projects.….trust_level`. Startup warning: "couldn't save diagnostic logs to its local database". User-level stdio MCPs from `config.toml` (firecrawl, nodus, zotero, paper-search) failed to start (their binaries and paths are not granted) |
| Model APIs | `api.anthropic.com` and `api.openai.com` reachable (401 unauthenticated via curl); both TUIs completed turns | — | None by default. Egress allowlist: `--allow-domain api.anthropic.com` / `api.openai.com` (see the localhost caveat above) |
| `gh` via credential proxy | `gh` itself fails before any request | `failed to create root command: failed to read configuration: open ~/.config/gh/config.yml: permission denied` | `GH_CONFIG_DIR=<empty granted dir>` + `--allow <dir>`, plus a profile `network.credentials:["github"]` with a `custom_credentials.github` route (`upstream https://api.github.com`, `env_var GH_TOKEN`, `credential_format "token {}"`). Child sees `GH_TOKEN=<phantom>` and `HTTPS_PROXY=http://nono:<token>@…`. Placeholder token: `gh api user` → `401 Bad credentials` from github.com. Real token (read-only `gh api user`) → login returned |
| tmux | TUI renders inside a tmux pane; host-side `tmux send-keys` (literal text + `Enter`, arrow keys, `F2`, `Escape`) drove both CLIs, including trust prompts and `/exit` / `/quit` | — | None. nono prints its banner and capability list into the pane before the TUI starts (`-s` suppresses it). After a clean Claude `/exit`, nono still printed "stderr showed a likely sandbox-related access issue" |
| **tmux socket from inside the sandbox** | **Sandbox escape.** `tmux ls` on the default socket listed the host's real tmux sessions. `tmux -L nonospike run-shell 'touch ~/proof'` created a file the sandbox cannot write directly (`touch: … Permission denied`) | — | Profile `"linux": {"af_unix_mediation": "pathname"}` blocks it (`connect /tmp/tmux-1000/nonospike (no matching unix_socket capability)`). It then also blocks ssh-agent signing and nscd unless granted (`--allow-unix-socket <path>`) |
| Codex's own sandbox nested in nono (Cadre `safeRuntime`) | Fails | `error building bubblewrap command: Permission denied`. After granting `/tmp/codex-daemon-1000` and `/tmp/codex-bwrap-synthetic-mount-targets-1000`: `bwrap: setting up uid map: Permission denied` | None found short of `/proc` write. Only `--dangerously-bypass-approvals-and-sandbox` works under nono |
| Env secrets | All inherited: 13 `*TOKEN*` / `*SECRET*` / `*_KEY` vars from the Cadre session reached the child. An `env://` credential source var (`NONO_SPIKE_GH`) is also passed to the child next to the phantom | — | Profile `"environment": {"allow_vars": [...]}`. With it, the child saw only the listed vars plus nono's proxy/CA vars and the phantom `GH_TOKEN` |

Other observations:

- **Startup overhead** (warm, 3 runs): `nono run -- true` ≈ 240 ms with the claude profile, which runs a host-side
  `session_hooks.before` script, and 30–50 ms with codex. `claude --version` 6 ms → ~375 ms;
  `codex --version` ~28 ms → ~55 ms. Proxy (credential) mode adds ~15 ms, with one outlier of 2.1 s.
- **Launch failures:** nono's own errors exit **1** with one line on stderr, e.g. `nono: Profile read error at
  /nope.json: profile file not found` or `nono: Profile parse error: unknown field 'bogus' … line 1 column 35`.
  The child's exit code propagates unchanged (`exit 42` → 42), so a child exiting 1 looks the same as a nono
  failure. An unreadable binary gives 127 plus a "grant read access to the binary's directory" hint. The
  diagnostic footer ("No path denials were observed… may be unrelated") also appears on real sandbox failures
  (Claude's temp-dir refusal), so don't parse it. `--diagnostics-json` gives a machine-readable form (not
  tested).
- **Endpoint rules don't block requests:** a `custom_credentials` route restricted to `GET /**` still forwarded
  `POST /markdown` upstream, without injecting the credential (`401 Bad credentials`). The proxy also injects
  the credential when the client sends no `Authorization` header at all (`GET /user` → 200 with the real token).
- **Landlock quirks:** `access(2)`, `test -r` and `touch` on an existing file (utimensat) are not mediated, so they
  report success on denied paths. Probe with a real `open`/`create`. There is no deny-inside-allow on Linux;
  nono refuses to start if a `deny` overlaps an `allow`. `/tmp` is write-only in the base profile, so any
  `--read` under `/tmp` silently becomes read-write.

## Composition and per-launch grants

- **Profiles:** JSON, `extends` a name, a file path or a list (left-to-right). `groups.include` / `groups.exclude`
  for built-in policy groups (`nono profile groups`). Arrays are append-and-dedupe, and inherited filesystem paths
  cannot be removed, only whole groups. `platform_overrides.linux` patches. Variables: `$HOME`, `$UID`,
  `$WORKDIR`, `$TMPDIR`, `$XDG_RUNTIME_DIR`, `$NONO_CONFIG`, `$PACK_DIR`. `nono profile show|validate|diff`
  resolves and checks; `--dry-run -v` prints the final capability set with each grant's source.
- **Per launch:** CLI flags stack on the profile: `--allow/--read/--write[-file]`, `--allow-unix-socket*`,
  `--allow-domain`, `--open-port`, `--allow-connect-port`, `--credential`, `--allow-endpoint SERVICE:METHOD:PATH`,
  `--extends <profile>`. Several have env forms (`NONO_ALLOW`, `NONO_ALLOW_DOMAIN`, `NONO_PROFILE`, …).
  Env-var settings (`environment.allow_vars`), credential routes, AF_UNIX mediation and `groups.exclude`
  are profile-only. So a caller wanting those writes a generated profile per launch that `extends` a
  base profile. `-c/--config <manifest>` takes a fully resolved capability manifest instead. It is exclusive with
  all other flags; not tested.
- Profiles are file-path loadable, so nothing needs to be installed under `~/.config/nono` (`--profile /abs/path.json`).
  A profile's `session_hooks.before` script runs **on the host, unsandboxed**.

## Grants a Cadre-launched session would need (from this spike)

Base: the registry `claude` / `codex` profile with cwd = the agent worktree (read-write). Then:

1. Linked worktree: read `<main>/.git`, read-write `.git/worktrees/<name>`, `objects`, `refs`, `logs`.
2. Shared `node_modules` symlink target: read.
3. Cadre checkout (hook recorder `scripts/agent-hooks/log-event.mjs` and the `modules/` it imports): read.
   Claude `--mcp-config` file: read-file.
4. Claude: `CLAUDE_CODE_TMPDIR` set to a per-session dir with read-write, instead of all of `/tmp/claude-$UID`.
5. Commit signing (this host): `TMPDIR` set to a granted dir, the signing pubkey read-file, and the ssh-agent
   socket if AF_UNIX mediation is on.
6. `gh`: `GH_CONFIG_DIR` set to an empty granted dir, plus a GitHub credential route. Never mount `~/.config/gh`.
7. Hardening that changes behavior: `linux.af_unix_mediation: "pathname"` (closes the tmux escape) and
   `environment.allow_vars`. If egress is allowlisted: `--sandbox-policy landlock`, or Cadre's localhost ports stay
   unreachable.

## Open risks

1. **tmux escape:** without `af_unix_mediation: "pathname"`, a sandboxed agent can drive the host tmux server
   (`run-shell`, `new-window`, `send-keys` to other agents). Cadre runs every agent under tmux, so this is the
   first thing to close. The same applies to any other host Unix socket: Docker, `/tmp/codex-daemon-1000`, the
   ssh agent.
2. **Shared agent state stays writable:** the claude profile grants read-write on `~/.claude`, `~/.claude.json`
   and `/tmp/claude-$UID`; the codex profile on `~/.codex`. A sandboxed agent can therefore read every other
   session's scratchpad and transcripts. It can also add hooks or MCP commands to `settings.json` /
   `config.toml`, which then run **unsandboxed** in the next unsandboxed session. Credentials in
   `~/.claude/.credentials.json` / `~/.codex/auth.json` are readable by the agent. Nothing in the profiles
   separates "auth" from "config".
3. **Secrets in env:** Cadre's spawn env (Slack, Google Ads and BOS tokens, the dueno bearer, …) passes through
   unless `allow_vars` is set. `env://` credential sources leak the real value too.
4. **Network is open by default.** Allowlisting egress breaks localhost MCP under the default `auto` policy
   (likely a nono bug).
5. **`nono pull` mutates global agent config** (see Versions). Any rollout should load profiles by path and
   never `pull` on a host running live agents.
6. **Codex safe mode is unusable under nono** (nested bwrap fails), and Codex's trust prompt persists entries
   to the global `config.toml`.
7. **Exit code 1 is ambiguous** between nono and the child. nono adds diagnostic text to the child's stderr and
   the TUI pane unless `-s` is passed.
8. **Landlock limits:** no deny-within-allow; `access(2)`/utimensat are unmediated. AF_UNIX mediation is opt-in, and
   `nono run --help` notes that socket-directory grants are recursive under the current Linux Landlock fallback. Needs kernel
   Landlock ABI ≥ 4 for TCP rules (V6 here).

## Implications for Cadre

nono can wrap both CLIs with modest overhead (< 0.5 s) and no TUI or `send-keys` breakage. Hooks, MCP and model
APIs work with a handful of per-launch path grants. A wrapper would need: a generated per-launch profile file (for
`allow_vars`, AF_UNIX mediation and credential routes) plus CLI path flags for the worktree, git common dir,
`node_modules` target and Cadre checkout. It would also need per-session `CLAUDE_CODE_TMPDIR`, `GH_CONFIG_DIR`
and `TMPDIR`, and `-s`. Without AF_UNIX mediation the sandbox does not hold against tmux. With the stock
profiles' read-write access to `~/.claude` / `~/.codex`, it does not protect the next unsandboxed session.
Treat both as prerequisites before relying on nono for isolation.
