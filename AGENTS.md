# Cadre

Self-hosted control plane that schedules, runs, and monitors coding-agent sessions. Guidance for contributors and for operators running Cadre. A running instance holds production state and side-effect loops; handle both deliberately.

## Minimize code

Ship the feature with the fewest lines. Do not add parallel scopes, policy layers, wrappers, or helpers unless an existing path cannot do the job. Prefer deleting and reusing over extending. Extra code is extra bugs and extra maintenance.

## Safe local execution

- Agent-started smoke servers must not run side-effect loops.
- Set `CADRE_DISABLE_SIDE_EFFECTS=1 CADRE_GITHUB_AGENT_POLLER_ENABLED=0 CADRE_GITHUB_AGENTS_ENABLED=0 CADRE_SCHEDULED_AGENT_PUMP_ENABLED=0 TELEGRAM_BRIDGE=0` for smoke/dev starts.
- Side-effect loops are code-disabled unless `PORT=4310` or `CADRE_ALLOW_SIDE_EFFECTS=1`. On alternate ports, set both `PORT` and `AGENT_BUS_MCP_HTTP_PORT` to unused values.
- Logs: see `docs/production-controls-runbook.md#logs`.
- Operational controls and production behavior: `docs/production-controls-runbook.md` and `docs/production-slos.md`.

## Merge and deployment invariants

- Finished production work lands on `main`; a merge into an issue or feature branch is not complete or deployed.
- After merge/push, verify `git merge-base --is-ancestor <commit-or-branch> origin/main`.
- Before branch cleanup, audit `git branch -r --no-merged origin/main` and report intentionally unmerged refs.
- Canonical restart: `bash scripts/server.sh restart`. It deploys the live checkout (default: `<dev clone>-live`, override `CADRE_FLEET_LIVE_DIR`) from `origin/main`.
- Never treat a feature checkout as production or restart/deploy without explicit authorization.

## Verification

- Coverage and CRAP improvements must reflect behavior actually exercised. Never satisfy a quality ratchet with source-text assertions, shape-only harnesses, or mocks of framework/runtime internals; exercise public behavior through real calls, rendering, or interaction, or extract and test cohesive pure functions.
- Run the narrowest relevant tests, then `npm run check` and `npm test` for broad server changes.
