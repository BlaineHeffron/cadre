# Side-effect loops run only on port 4310 or with an explicit override

Many Cadre instances run on one machine (agent smoke servers, tests, workers), but only one may poll GitHub, run scheduled agents, bridge Telegram or serve the agent MCP listener without duplicating real-world actions. So loops are off unless the server is on the production port 4310 or `CADRE_ALLOW_SIDE_EFFECTS=1` is set, rather than on by default with opt-out flags.

## Consequences

- A worker machine never runs them, whatever the override says.
- `CADRE_DISABLE_SIDE_EFFECTS=1` or a test server suppresses them even on 4310.
- Anything that needs the MCP listener on another port must set the override and then turn every loop off individually.
