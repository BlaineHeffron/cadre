# Local development

## Prerequisites

- Node.js >= 22.19.0 (`package.json` `engines`, `npm run check:node`)
- `npm ci`
- `tmux` on PATH for tests that talk to a real tmux server (many session tests stub `tmux` themselves)

## Checks

Tests must be hermetic: use temporary directories and explicit environment/configuration fixtures, never personal setup or real services.
Never call the real GitHub API from tests. Run browsers headless.

Follow the verification ladder in `AGENTS.md`. Run `npm run check:node` when checking runtime prerequisites.

`npm test` runs `scripts/run-tests.mjs`, which passes tests only an allowlist of OS/node vars (`PATH`, `TMPDIR`, locale, `TERM`, `SHELL`, `USER`, `TZ`, `NODE_*`, `CI`) plus a temp `HOME` and `CADRE_AGENT_CGROUP_ISOLATION=0`; a test that needs any other var sets it itself.

## Smoke server

Follow `AGENTS.md#safe-local-execution` for smoke-server flags and unused ports. Stop smoke servers you start after checking them.

To smoke the structured runtime or real agent launches:

- Start with `env -i` and pass only what you need: `HOME`, `PATH`, provider keys, `PI_BIN` if pi isn't on `PATH`.
- Set your own `AUTH_TOKEN`, `INTERNAL_BYPASS_TOKEN` and `BROWSER_SESSION_SECRET` (all different) and your own `DM_STATE_DIR`.
- Use unused `PORT` and `AGENT_BUS_MCP_HTTP_PORT` values, never 4310.
- MCP HTTP needs `CADRE_ALLOW_SIDE_EFFECTS=1` on an alternate port, so also set every loop flag off: `CADRE_GITHUB_AGENT_POLLER_ENABLED=0 CADRE_GITHUB_AGENTS_ENABLED=0 CADRE_SCHEDULED_AGENT_PUMP_ENABLED=0 TELEGRAM_BRIDGE=0`.
- Point `RESEARCH_WORKBENCH_FLEET_TOKEN_FILE` at a scratch path.
- Use a short `TMUX_TMPDIR` such as `/tmp/<name>-tmux`; tmux socket paths over 108 bytes fail with `File name too long`.
- Set `CLAUDE_STREAM_JSON_ENABLED=1` (every Claude session is structured) or `CADRE_STRUCTURED_AUTOMATED_SPAWNS=claude` (automated spawns only).

## Pull requests

- Target `main`; publish only the PR unless the task authorizes another deliverable.
- End commits with a `Co-Authored-By` trailer naming your model.
- Write the PR body per `config/skills/pr.md` and end it with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Address blocking findings from automatic Grok PR review if it posts; wait at most about 20 minutes.
- Land a reviewed PR with `bash scripts/land-pr.sh <pr> <sha> [worktree-path]`; it refuses unless the head and the optional clean worktree are at `<sha>` and every check is SUCCESS (SKIPPED or NEUTRAL also refuse), and cleans up only after the merge reaches `origin/main`.
