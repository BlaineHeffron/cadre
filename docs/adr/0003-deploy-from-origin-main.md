# Production deploys only from origin/main into a dedicated live checkout

The service runs from its own live checkout, never from a dev clone or feature worktree where agents work. A restart fetches and hard-resets that checkout to `origin/main` (overridable only by `CADRE_FLEET_BRANCH`) before installing and restarting, so production is always a pushed, merged commit and local edits there are discarded.

## Consequences

- Work is deployed only once it is merged to `main` and pushed; a merge into a feature branch is not deployed.
- Agents restart or deploy only with explicit operator authorization.
