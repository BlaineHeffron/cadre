---
description: REA guide for missing tools, dropped connections, deadlines, and returned remediation.
---

<!--
Copyright (c) 2026 morluto

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
-->
<!-- upstream: morluto/rea@d2aed17 skills/reverse-engineer-anything/references/android-applications.md -->

# Connection and task recovery

Read this only for an observed connection, deadline, or provider blocker. Keep
the user's target and question in view and resume the investigation after the
blocker clears.

## The fleet owns registration

The catalog launches REA when the session selects `rea`; there is no client
registration to repair. Never run `rea setup` or follow a remediation that
says to. `rea doctor --json` is read-only and may be used for its provider and
`runtime-configuration:` checks; ignore its registration and `skill:identity`
results, which describe host agent configs the fleet does not use. Doctor cannot
prove the current session is connected.

| Observation | Next step |
| --- | --- |
| No REA tools in the session | Say so; ask the operator to relaunch with `rea` selected. |
| MCP connection dropped | Retry the call once only if it is safe to repeat or known not to have started. If it may have changed the target, or fails again, report it and ask for a relaunch. |
| REA could not start | Retry once, then report it. Do not retry an unchanged startup failure. |
| `provider_unavailable` or an unavailable tool | Read the operation's diagnostics or `binary_session` `result.tool_availability`. Do the supported static work and name the missing evidence separately; never install an engine. |
| Invalid arguments | Correct every reported field from the connected tool's current schema before retrying. |

## Client and server deadlines

A host message such as `timed out awaiting tools/call` with no REA result is the
client's deadline. It does not show that REA finished, cancelled, or released
resources. Do not repeat the unchanged call; inspect session state and retained
Evidence when useful, and never invent an Evidence reference.

A returned `provider_timeout` is the server's deadline. Follow its
`remediation.action`, reuse partial Evidence (`error.details.partial_observation`
goes straight to `inspect_analysis_view`), and resolve incomplete cleanup first.
Raising the client deadline does not change the server budget.

## Recovery ladder

Change a request field or a `REA_*` setting only when the returned remediation
explicitly says so; do not invent one. Host memory and `NODE_OPTIONS` do not
raise a REA limit.

- `cleanup_incomplete`, or retained cleanup owners in the details: retry that
  cleanup owner, and start no new work needing those resources until it releases.
- `resource_constraint` with `retryable: true`: wait for the active work to
  finish, then retry within the reported limits.
- An editable limit named in `details.limit`: call `update_analysis_settings`
  with `{setting, action: "set", value}` within the reported bounds, then retry
  the same input. Updates affect new work only and vanish when REA restarts.
- `configuration_invalid`: the setting lives in the environment that starts REA,
  which the fleet owns. Report the setting and value needed to the operator.
- `invalid_request`: correct the reported fields; do not repeat the call.

<!-- upstream: morluto/rea@160d821 .agents/skills/reverse-engineer-anything/references/connection-and-recovery.md -->
