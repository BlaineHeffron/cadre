# Local development

## Prerequisites

- Node.js >= 22.19.0 (`package.json` `engines`, `npm run check:node`)
- `npm ci`
- `tmux` on PATH for tests that talk to a real tmux server (many session tests stub `tmux` themselves)

## Checks

Tests must be hermetic: use temporary directories and explicit environment/configuration fixtures, never personal setup or real services.
Never call the real GitHub API from tests. Run browsers headless.

Follow the verification ladder in `AGENTS.md`. Run `npm run check:node` when checking runtime prerequisites.

`npm test` runs `scripts/run-tests.mjs`, which forces `CADRE_AGENT_CGROUP_ISOLATION=0` so host/agent isolation env does not wrap fixture launches.

## Smoke server

Follow `AGENTS.md#safe-local-execution` for smoke-server flags and unused ports. Stop smoke servers you start after checking them.

## Pull requests

- Target `main`; publish only the PR unless the task authorizes another deliverable.
- End commits with a `Co-Authored-By` trailer naming your model.
- Write the PR body per `config/skills/pr.md` and end it with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Address blocking findings from automatic Grok PR review if it posts; wait at most about 20 minutes.
