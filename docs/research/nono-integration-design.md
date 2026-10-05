# nono integration design: sandboxed agent launches

Status: design only (2026-10-05), not implemented. Builds on `docs/research/nono-spike.md`, the evidence base.
Target: nono 0.79.0 on Linux (Landlock V6). Claims I re-verified for this doc are marked **[V]**: they were run by
hand in the session scratchpad, with one short headless `claude -p --model haiku` run. Claims marked **[A]** are
assumptions.

## Decisions

1. **Opt-in switch.** `CADRE_SANDBOX=nono` is a process-wide switch. When it is unset, nothing changes.
2. **Per-spawn field.** `createSession` gets one new field, `sandbox: 'nono' | 'none'`. During rollout, callers
   opt in by passing `'nono'`. In the final phase the default flips to `'nono'` and `'none'` becomes the opt-out.
   The resolved value is persisted in session meta and reused on resume.
3. **Static profiles, CLI flags per launch.** Two static, Cadre-owned profiles live in the repo:
   `config/nono/claude.json` and `config/nono/codex.json`. They are loaded with `--profile <abs path>`. Everything
   that varies per launch is passed as a `nono run` flag. **No per-launch profile file is generated.** Reasons:
   - `"extends": "<file path>"` is rejected by 0.79.0 (`Profile inheritance error: invalid base profile name
     '/abs/…json'`, also for relative paths) **[V]**. This corrects the spike's composition note: only names
     resolve. So a generated file could only extend built-ins or registry names.
   - Every profile-only setting Cadre needs is the same for every launch of a provider: `allow_vars`,
     `af_unix_mediation`, the `github` credential route and `groups.exclude`.
   - Defining a credential route does nothing until `--credential github` is passed **[V]**.

   We do not use the registry `nolabs-ai/*` packs. We never run `nono pull` or `nono setup`, and never write to
   `~/.config/nono`, `~/.claude` or `~/.codex`.
4. **Private agent state per session.** The agent gets no read-write access to the shared `~/.claude` or
   `~/.codex`. Each session gets its own `CLAUDE_CONFIG_DIR` or `CODEX_HOME`, `CLAUDE_CODE_TMPDIR`, `TMPDIR` and
   `GH_CONFIG_DIR`, all under one per-session state dir. The host auth file is exposed read-only through a
   symlink plus `--read-file`.
5. **Fail loudly.** If sandboxing resolves to `nono` and anything fails (nono missing, wrong version, invalid
   profile, a `nono:` error during startup, or a missing GitHub token for a reviewer), the spawn throws.
   There is no fallback to an unsandboxed launch. A session persisted with `sandbox: 'nono'` cannot be resumed
   while `CADRE_SANDBOX` is unset.
6. **Rollout order.** GitHub reviewer sessions first (Claude and Codex tmux sessions only). Collab sessions second.
   Pi, structured/stream-json sessions and the Codex app-server path are out of scope.

## Where it hooks into the spawn path

All tmux agent sessions, including reviewer and collab sessions, go through the same steps:

1. `createSession` (`modules/sessions/index.mjs:1011`) calls
   `renderAgentSessionLaunch` (`modules/sessions/index.mjs:408`).
2. The provider's `shellCommand` builds the pane command: codex at `:254`, claude at `:316`, pi at `:393`.
3. `buildAgentScopeLaunch` (`modules/agent/session-scope.mjs:30`) wraps the pane command in a systemd scope.
4. `launchTmuxSession` (`modules/sessions/index.mjs:991`) runs `tmux new-session … bash -lc <cmd>` with `-c workDir`.
5. `verifyLaunchedSession` (`modules/sessions/index.mjs:970`) checks that the session started.

`resumeSession` (`modules/sessions/index.mjs:1193`) repeats the same render and scope steps at `:1321`–`:1326`.

- **Reviewers.** `spawnGithubAgentForItem` (`modules/integrations/github-agents.mjs:941`) creates the worktree with
  `createGithubPullRequestWorktree` / `createGithubIssueWorktree` (`modules/fleet/git-worktree.mjs:138,193`). These
  are linked worktrees under `~/.dueno-fleet/github-agents/worktrees/…`. It then calls `defaultSessionLauncher` →
  `createSession` (`modules/integrations/github-agents-plugin.mjs:70,86`). Today the prompt tells the agent to
  use "the configured fleet GitHub token / gh auth available in this environment"
  (`modules/integrations/github-agents.mjs:1326`), which means ambient `~/.config/gh` or an inherited env token.
- **Collab.** The bootstrap route creates a linked worktree with `createManagedWorktree`
  (`modules/agent-bus/routes.mjs:230`, `modules/agent-bus/managed-worktrees.mjs:38`; base `~/.cadre/worktrees/collab`)
  and sets each participant's `workDir` to it (`routes.mjs:251`). Participants are created over the in-process
  HTTP API (`modules/agent-bus/adapters.mjs:46`), so `sandbox` must be added to that body and to the session
  route schema.
- **Inputs that stay outside the sandbox.** The pane shell runs outside nono. So `$(< initialPromptFile)`, the
  `tee` into the launch log, the env prefix (`modules/agent/launch-env.mjs:21`) and the Codex MCP bearer export
  (`modules/sessions/index.mjs:259`) all keep working without grants. Their values reach the child only if they
  are listed in `allow_vars`.
- **Paths the child does need:**
  - The Claude MCP config file `<state>/mcp_client_configs/claude-<id>.json`
    (`modules/integrations/mcp-launch-preflight.mjs:106`).
  - The Claude fleet hook plugin (`modules/agent/runtime-args.mjs:171`, `modules/agent/hook-events.mjs:7`).
  - The hook recorder `scripts/agent-hooks/log-event.mjs`. Its full import closure is
    `scripts/agent-hooks/`, `modules/agent/hook-events.mjs`, `modules/session-state/providers/hook.mjs` and
    `modules/platform/cadre-env.mjs`, with only `node:` built-ins and no `config.mjs` **[V]**. It writes only to
    `<worktree>/.agent_bus/hooks` (`hook-events.mjs:9`), which is inside the read-write workdir.

### The change, in code terms (one new module plus small edits)

- `modules/agent/nono-launch.mjs` (new, ~80 lines):
  - `resolveSandbox(requested, env)` returns `'nono'` or `'none'`.
  - `prepareNonoLaunch({ provider, sessionId, workDir, mcpLaunch, headroom, githubToken })` does the host-side
    IO: mkdir the session state dir, create the auth symlink, run `git rev-parse`, call `realpath` on
    `node_modules`, and write the token file. It returns `{ env, args }`.
  - `buildNonoArgs(paths)` is a pure function that returns the argv.
- `renderAgentSessionLaunch` takes an optional `sandbox` result. When set, it passes
  `sessionBinary: 'nono'` and `allArgs: [...sandbox.args, '--', binary, ...allArgs]` into the existing
  `shellCommand`, and merges `sandbox.env` into the env prefix that already carries `headroom.env`. The returned
  `allArgs` stay unwrapped.
- `createSession` and `resumeSession` resolve the sandbox, call `prepareNonoLaunch`, and persist
  `meta.sandbox`. On delete they remove the session state dir; on launch failure they also remove the
  token file.
- `seedClaudeWorkspaceTrust` (`modules/platform/mcp-seed.mjs:109`) currently writes `$HOME/.claude.json`. It gets
  a `configPath` option so the trust entry goes to `<sd>/claude/.claude.json`, because Claude reads
  `.claude.json` from `CLAUDE_CONFIG_DIR` **[V]**.
- `launch-failure.mjs:7` gets the pattern `/^nono: /m`.
- `defaultSessionLauncher` passes `sandbox: 'nono'` and `githubToken` (phase 1). The collab bootstrap passes
  `sandbox: 'nono'` (phase 2).

## Static base profiles

`config/nono/claude.json` (the Codex profile differs only where noted):

```json
{
  "extends": "default",
  "meta": { "name": "cadre-claude", "version": "1" },
  "groups": {
    "include": ["claude_code_linux", "claude_cache_linux", "node_runtime", "git_config", "unlink_protection"],
    "exclude": ["system_write_linux"]
  },
  "filesystem": {
    "write": ["/dev/null", "/dev/zero", "/dev/full", "/dev/tty", "/dev/stdout", "/dev/stderr", "/dev/fd", "/dev/pts", "/proc/self/fd"]
  },
  "security": { "signal_mode": "isolated", "capability_elevation": false },
  "network": {
    "block": false,
    "custom_credentials": {
      "github": {
        "upstream": "https://api.github.com",
        "credential_key": "env://CADRE_SANDBOX_GH_TOKEN",
        "env_var": "GH_TOKEN",
        "credential_format": "token {}"
      }
    }
  },
  "workdir": { "access": "readwrite" },
  "linux": { "af_unix_mediation": "pathname" },
  "environment": {
    "allow_vars": [
      "PATH", "HOME", "USER", "SHELL", "TERM", "COLORTERM", "LANG", "LC_ALL",
      "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_TMPDIR", "TMPDIR", "GH_CONFIG_DIR",
      "CADRE_SESSION_ID", "DUENO_SESSION_ID", "CADRE_PROVIDER", "DUENO_PROVIDER",
      "ANTHROPIC_BASE_URL"
    ]
  }
}
```

The Codex profile differs as follows:

- Groups: `user_caches_linux` instead of the two `claude_*` groups.
- `allow_vars`: drops the `CLAUDE_*` entries and adds `CODEX_HOME`, `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`,
  `OPENAI_BASE_URL`, `DUENO_AGENT_BUS_TOKEN` and `CADRE_AGENT_BUS_TOKEN`. The Codex app-server transport already
  keeps a similar env allowlist (`modules/agent/codex-app-server-transport.mjs:13`).

Why each part is there:

- **`groups.exclude: system_write_linux` plus the `/dev` entries re-added.** The `default` profile grants write on
  all of `/tmp`. That lets an agent create or overwrite files in other sessions' `/tmp` scratch dirs. With the
  group excluded, `/tmp` writes are denied, `/dev/null` still works, and `claude auth status` still succeeds
  **[V]**. Not yet run with the full TUI under tmux **[A]**.
- **`af_unix_mediation: "pathname"` closes the tmux escape.** `tmux ls` is denied inside the sandbox **[V]**.
  Phase 1 grants no Unix sockets. DNS still resolves in open-network mode **[V]**.
- **`allow_vars` stops env secrets from reaching the child.** The Cadre env holds Slack, Ads and BOS tokens. The
  credential source var `CADRE_SANDBOX_GH_TOKEN` is not visible to the child; only the phantom `GH_TOKEN` is
  **[V]**.

## Launch command shape

This is the pane command for a Claude reviewer. The systemd scope wrapper is unchanged. `<sd>` is
`runtimeStatePath('sandbox/claude-<id>')`, which resolves to `<cadre>/.dueno/state/sandbox/claude-<id>`
(`modules/ops/runtime-state.mjs:5`).

```sh
export CADRE_SESSION_ID=…; …                       # existing buildLaunchEnvPrefix + headroom env
export CLAUDE_CONFIG_DIR=<sd>/claude CLAUDE_CODE_TMPDIR=<sd>/tmp TMPDIR=<sd>/tmp GH_CONFIG_DIR=<sd>/gh
export CADRE_SANDBOX_GH_TOKEN="$(< <state>/sandbox/claude-<id>.gh-token)"   # reviewer only; file is outside <sd>
unset CLAUDECODE
'nono' 'run' '-s' '--no-diagnostics' '--profile' '<cadre>/config/nono/claude.json' '--allow-cwd' \
  '--allow' '<sd>' \
  '--read' '<common-dir>' '--allow' '<git-dir>' \
  '--allow' '<common-dir>/objects' '--allow' '<common-dir>/refs' '--allow' '<common-dir>/logs' \
  '--read' '<realpath(workDir/node_modules)>' \
  '--read' '<cadre>/modules' '--read' '<cadre>/scripts/agent-hooks' \
  '--read-file' '<state>/mcp_client_configs/claude-<id>.json' \
  '--read-file' '<HOME>/.claude/.credentials.json' \
  '--credential' 'github' '--sandbox-policy' 'landlock' \
  '--allow-connect-port' '<AGENT_BUS_MCP_HTTP_PORT>' '--allow-connect-port' '<headroom port, if enabled>' \
  '--' '<claude bin>' <existing args> -- "$(< <prompt file>)" 2> >(tee -a <launch log> >&2)
```

How each group of flags is built:

- **Git.** `<git-dir>` and `<common-dir>` come from `git -C workDir rev-parse --path-format=absolute --git-dir
  --git-common-dir`. For a plain checkout both point inside the workdir, and the git flags are omitted.
  `.git/config` and `.git/hooks` stay read-only. A linked-worktree commit with exactly these grants succeeded
  **[V]**.
- **`node_modules`.** The read grant is added only when `node_modules` resolves outside the workdir. Landlock
  checks the resolved target, not the symlink.
- **Cadre checkout.** Only `modules/` and `scripts/agent-hooks/` are granted, **not the checkout root**. The root
  holds `.env`, `.dueno/state` (every session's MCP tokens) and `*_sessions.json`.
- **Claude auth.** `<sd>/claude/.credentials.json` is a symlink to `~/.claude/.credentials.json`. With
  `--read-file` on the target, Claude reports `loggedIn: true` and the agent cannot write the file **[V]**.
  `~/.claude/settings.json`, `~/.claude/` and `~/.codex/auth.json` are all denied **[V]**.
- **Codex auth.** `CODEX_HOME=<sd>/codex` with an `auth.json` symlink plus `--read-file ~/.codex/auth.json`.
  `codex login status` reports "Logged in using ChatGPT" **[V]**. Without `CODEX_HOME` in `allow_vars`, Codex
  falls back to `~/.codex` and fails on `config.toml` **[V]**.
- **Network flags** (`--credential`, `--sandbox-policy landlock`, `--allow-connect-port`). Passed only in proxy
  mode, i.e. when there is a credential or a domain allowlist. See the next section.

## Network: GitHub credential and the localhost conflict

All verified **[V]** against a throwaway local HTTP server:

| Mode | localhost MCP port | api.anthropic.com | github via route | other hosts |
|---|---|---|---|---|
| No network flags (open) | reachable | reachable | n/a (no `GH_TOKEN`) | reachable |
| `--credential github` (default `auto` policy) | **blocked** | via proxy | proxied | via proxy |
| `--credential github` + `af_unix_mediation` (`auto`) | blocked | **proxy itself unreachable** | **fails** | fails |
| `--credential github --sandbox-policy landlock --allow-connect-port P` (with or without `af_unix`) | reachable | via proxy | proxied (`401` with bogus token) | via proxy |
| same + `--allow-domain api.anthropic.com` | reachable | via proxy | proxied | **blocked** |
| `--sandbox-policy landlock --allow-connect-port P` *without* a proxy | reachable | **blocked** | — | **blocked** |

Rules that follow from the table:

- **Proxy mode** is on when there is a credential or a domain allowlist. In proxy mode, always pass
  `--sandbox-policy landlock` and `--allow-connect-port` for each localhost port the session needs:
  - the agent-bus MCP port;
  - the headroom port when `prepareHeadroomLaunch` sets `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` to a local
    origin (`modules/agent/headroom.mjs:17,24`).

  Cadre's own HTTP port (4310) is not needed: hooks write files, not HTTP.
- **Open mode:** pass none of these flags. A bare `--allow-connect-port` silently switches TCP to deny-by-default.
  Any other combination fails closed or breaks the session.
- **Reviewer GitHub route.**
  1. The launcher resolves the repo's `authRef` with the existing `resolveGithubAuthToken`
     (`modules/integrations/github-agents.mjs:1117`). An unresolved ref fails the spawn.
  2. The token is written 0600 to a state file outside `<sd>`.
  3. The pane shell exports it as `CADRE_SANDBOX_GH_TOKEN`; the value never appears in the tmux command line.
  4. `--credential github` turns the route on, and `GH_CONFIG_DIR=<sd>/gh` stays empty.

  The child sees a phantom `GH_TOKEN` plus nono's proxy and CA vars. nono only **warns** when the credential is
  missing (`credential_not_found`, exit 0) **[V]**, which is why Cadre checks first.
- **Limits of the route** (from the spike). `endpoint_rules` do not block requests, so the phantom token can
  still call any API the real token allows; only the real value cannot leak. Pushing over HTTPS to `github.com`
  gets no credential, which suits reviewers (they must not push).
- **Egress allowlist.** Not enabled in phase 1 (see open questions). The mechanism works today with
  `--allow-domain`.

## Failure handling (spike risk 7)

nono's own errors are a single stderr line starting with `nono: ` and exit 1. The child's exit status passes
through unchanged, so the exit code alone cannot tell them apart. Cadre does not rely on it:

1. **Once per process, before the first sandboxed spawn:**
   - check that `nono --version` equals the pinned `0.79.0`;
   - run `nono profile validate <profile>` for each profile.

   If either fails, the spawn throws `sandbox_unavailable` (HTTP 500 with the stderr). Cache only success.
2. **Before tmux**, the host-side prep (`mkdir`, `git rev-parse`, symlink, token check) throws on any error.
   Missing grant paths must be created first: nono silently skips a missing `--allow` path (exit 0) **[V]**.
   That fails closed, but would surface later as confusing EACCES errors.
3. **At launch:**
   - With `-s`, nono prints nothing of its own except fatal `nono: …` lines **[V]**, for example
     `nono: Profile read error at …: profile file not found` or
     `nono: Command execution failed: <bin>: cannot find binary path`.
   - With `--no-diagnostics`, nothing is printed on child exit either **[V]**, so the pane and the launch log
     only carry nono output when nono itself failed.
   - The existing `tee` into the launch log plus `verifyLaunchedSession` already kill the tmux session and raise
     500 on a matching pattern. The pattern `/^nono: /m` is added there.
   - Sandboxed launches set a verify grace of at least 1000 ms. Pi already uses 3000 ms
     (`modules/sessions/index.mjs:351`); Claude and Codex currently check once at 250 ms.
   - A missing `nono` binary already matches `command not found`.
4. **After launch**, a child exit is the agent's own exit. nono applies Landlock before `exec`, so a running
   child is a sandboxed child.

   `--dry-run` is **not** a useful preflight: it catches profile errors but exits 0 for a missing binary and for
   an undefined `--credential` **[V]**.
5. **Never fall back:**
   - No catch path re-renders an unsandboxed launch.
   - If `meta.sandbox === 'nono'` and the env switch is off, resume fails with `sandbox_required`.
   - A Codex `researchSafeRuntime` launch combined with nono is rejected with 400, because nested bwrap fails
     under nono.

## Known behaviour changes for sandboxed sessions

- **Claude transcripts** move to `<sd>/claude/projects` **[V]** (`claude auth status` reports
  `projectsDirectory`). Cadre still learns the `transcriptPath` from hook payloads. The Telegram binding's default
  `~/.claude/projects` scan (`modules/telegram/binding.mjs:9-10`) will not see these transcripts. Reviewers do not
  use Telegram. `<sd>` must survive until the session is deleted, so that `--resume` can find the transcript.
- **User-level config is not loaded:** `~/.claude/CLAUDE.md`, settings, skills and plugins; `~/.codex/AGENTS.md`,
  plugins, `hooks.json` and the user-level stdio MCP servers. Cadre passes everything it needs on the command
  line. Phase 1 rejects `codexPlugins.add` and stdio or research MCP servers
  (`mcp-launch-preflight.mjs:499,511`) for sandboxed launches, because their binaries would run inside the
  sandbox without grants.
- **Codex trust writes** now land in the per-session `config.toml`, not the global one. This fixes the second half of spike risk 6.
- **Signed commits** need `--allow-unix-socket $SSH_AUTH_SOCK`, the signing pubkey via `--read-file`, and
  `SSH_AUTH_SOCK` in `allow_vars`. Not needed for reviewers; see open questions for collab.

## Tests that would prove it

Unit tests (pure, run in `npm test`):

- `buildNonoArgs`:
  - a linked-worktree fixture gives exact git grants; a plain repo gives none;
  - proxy mode adds `landlock` and the ports; open mode adds no network flags;
  - the Cadre grant is never the checkout root.
- `renderAgentSessionLaunch` with a sandbox:
  - the pane command runs `nono … -- <bin>`;
  - the env prefix sets the four per-session vars;
  - the GitHub token value never appears in the command string.
- `detectLaunchFailure` matches `nono: Profile read error …`.
- `resolveSandbox` combinations, and resume with `sandbox: 'nono'` while the switch is off → `sandbox_required`.

Hermetic integration tests, run with real `nono` and skipped when `nono` or Landlock is missing. Fixtures live
**outside `/tmp`**: the base profile grants `/tmp`, and a read grant under it silently becomes read-write. Each
test uses a fake `HOME`.

- Linked worktree: commit succeeds; writing `<common>/config` or `<common>/hooks` is denied.
- A private `tmux -L` server is unreachable from inside the sandbox.
- Fake `HOME/.claude/settings.json` is unreadable, `/tmp` writes are denied, and a secret env var is absent.
- A bad profile path makes `createSession` throw and leaves no tmux session.

Manual acceptance on a dev port with side effects disabled: one Claude reviewer and one Codex reviewer run on a
real PR worktree. The review is posted through the credential route, hooks are recorded, the dueno MCP works,
and `CADRE_SANDBOX` unset gives a byte-identical pane command to today's.

## Rollout

1. **Land the code with the switch off.** Ship `config/nono/*.json`, `nono-launch.mjs` and the edits above.
   With `CADRE_SANDBOX` unset, behaviour is unchanged.
2. **Phase 1: reviewers.**
   - Install pinned nono 0.79.0 on the host.
   - Set `CADRE_SANDBOX=nono`; only `defaultSessionLauncher` passes `sandbox: 'nono'`.
   - Watch launch failures, the review-posted rate and `nono:` lines in the launch logs for a week.
3. **Phase 2: collab.** The bootstrap route passes `sandbox: 'nono'` (plus the signing socket, if chosen).
4. **Phase 3, separate decision.** Flip the default to `'nono'` with a per-spawn `'none'` opt-out. Add Pi and the
   structured transports.

## Open questions for the operator

1. **Token refresh.** Claude and Codex read the live host credential files read-only. When an access token
   expires mid-session, the CLI will try to refresh and fail to write **[A]**: not observed, since no session ran
   that long. Reviewers end within 2 h (`autoCloseAfterMs`), which is probably inside the token lifetime.
   Options:
   - **Claude (preferred):** a long-lived `claude setup-token` token passed as `CLAUDE_CODE_OAUTH_TOKEN`.
     This means no file, no refresh, and inference-only scope. It needs one interactive operator step.
   - **Codex:** an API key instead of the ChatGPT login, at API billing.

   Either way, the agent can read whatever credential it is given.
2. **Egress allowlist** in phase 1: keep it open, or limit it to model APIs plus GitHub? I recommend open for
   phase 1, then derive the list from proxy logs. The required hosts for Claude/Codex telemetry and the ChatGPT
   backend are unverified.
3. **Collab signing.** Granting the ssh-agent socket also lets the agent authenticate as you over ssh (push).
   Accept that for collab, or disable signing in sandboxed worktrees?
4. **Codex `researchSafeRuntime`.** Reject it under nono (proposed), or replace Codex's read-only sandbox with a
   read-only nono workdir?
5. **User-level instructions.** Should sandboxed sessions see `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`?
   That would be a read-only symlink plus `--read-file`.
6. **Landlock absent.** Confirm that nono 0.79.0 refuses to start rather than degrade **[A]**. Not testable on this
   kernel. Startup check 1 could also assert the Landlock ABI from `nono` output.
