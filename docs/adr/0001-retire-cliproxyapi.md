# Use only the unmodified agy binary for Antigravity; CLIProxyAPI is retired

Antigravity's terms (§6) forbid third-party tools from reusing its OAuth, which the local CLIProxyAPI proxy did for the Pi `antigravity` provider and Google image generation. We removed every path through it and reach Gemini by subscription only by running Google's unmodified `agy` CLI as its own provider: no proxy, no token extraction, and no `agy -p` or `agy acp`.

## Consequences

- Sessions stored under the old `antigravity` provider still list and open, but resume refuses them as an unsupported provider.
- Do not reintroduce an OAuth-reusing proxy, or read agy's credentials, to get API-style access; that is the option this decision rejects.
