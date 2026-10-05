# Local development

## Prerequisites

- Node.js >= 22.19.0 (`package.json` `engines`, `npm run check:node`)
- `npm ci`
- `tmux` on PATH for tests that talk to a real tmux server (many session tests stub `tmux` themselves)

## Checks

Tests must be hermetic: use temporary directories and explicit environment/configuration fixtures, never personal setup or real services.

```
npm run check:node
npm run check
npm test
node --test tests/<file>.test.mjs
```

`npm test` runs `scripts/run-tests.mjs`, which forces `CADRE_AGENT_CGROUP_ISOLATION=0` so host/agent isolation env does not wrap fixture launches.

## Smoke server

Do not start side-effect loops. Use unused ports:

```
CADRE_DISABLE_SIDE_EFFECTS=1 \
CADRE_GITHUB_AGENT_POLLER_ENABLED=0 \
CADRE_GITHUB_AGENTS_ENABLED=0 \
CADRE_SCHEDULED_AGENT_PUMP_ENABLED=0 \
TELEGRAM_BRIDGE=0 \
PORT=<unused> \
AGENT_BUS_MCP_HTTP_PORT=<unused> \
npm start
```

See `AGENTS.md` for production restart rules. Do not treat a feature checkout as live.
