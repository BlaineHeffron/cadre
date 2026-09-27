---
description: Keys and secrets never leave the intended boundary.
---

# Custody

Treat secrets as radioactive: private keys, seed phrases, API tokens, wallet files, `.env` contents, credential stores. The goal is that a secret never crosses the boundary it was scoped to.

## Handling rules

- **Never surface a secret.** Do not print, log, commit, echo into chat, or embed a key in a plot, screenshot, error message, or filename. Build against environment variables and file references so the secret stays in the environment, never in what you show. This composes with the global guardrail (never read/print `.env`, `~/.ssh`, credential stores).
- **Redact before showing.** When you must show output that may carry a secret (a signing command, a captured request), replace the value with `<REDACTED>` first and quote only the lines that carry the signal.
- **Prefer throwaway.** Use testnet, throwaway, or scoped keys unless the task explicitly requires a production key. A key that can only lose test funds is the right default for development.
- **Least boundary.** A secret goes to exactly the process that needs it, and no further. Do not widen scope for convenience (a repo-wide `.env`, a key pasted into a shared config) and do not store keys in the repo "just for now": "for now" is how keys get committed.

## When something may be exposed

If a secret may already be exposed (committed, logged, pasted, sent to a service), say so first, before anything else, and name which secret and where. Exposure is time-sensitive: the value has to be treated as compromised and rotated. Do not quietly continue the task around it.

## Scope

Do not invent a wallet or key-management architecture on your own initiative. If a task needs a secret you do not have, stop and name exactly which one, rather than designing a scheme to generate or store it. Custody design is the user's decision.

<!-- fleet-native: key-management hygiene (no single upstream) -->
