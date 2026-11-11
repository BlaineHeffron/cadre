---
description: REA guide for native runtime instrumentation, browser/Electron observation and actions, and static/runtime reconciliation.
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

# Runtime observation

## Native runtime questions

Use these only when static evidence cannot answer the question. State the
target, input, expected result, failure signal and stopping condition before a
run. `open_binary` and `trace_native_values` establish static facts; they never
observe execution. Every tool below runs or alters a real process that can
write files, use the network, or show UI; the clean-room rules on online games
and anti-cheat still apply.

- Caller-authored instrumentation (Linux): `start_frida_session`,
  `load_frida_script`, then status/unload/close; `list_frida_devices` and
  `list_frida_processes` for discovery. Scripts execute in the target.
- Debugger state (Linux): `start_gdb_session` + `gdb_console`, or
  `start_rizin_debug_session` + `rizin_debug_command`. Both consoles are
  unrestricted, and starting or closing one retires an active static analysis
  session; reopen the artifact before new static work.
- Output, lifetime and file differences between runs (Linux/macOS):
  `capture_process_scenario`, then `compare_process_captures`. Capture launches an
  owned command with ordinary user permissions; observation paths are snapshots,
  not a sandbox.
- Entry calls and argument registers (macOS LLDB): `observe_native_calls` with
  exact breakpoints and a duration/event bound. Window observation and UI
  actions (macOS 14+): `observe_native_ui` / `capture_native_ui_scenario`.

Close each persistent session with its matching tool. Closing a Frida, GDB or
Rizin session detaches; it does not kill the target. When cleanup is
unresolved, keep the session and its reported recovery. Treat truncation,
unmatched breakpoints, changed target identity and cleanup uncertainty as
limitations; no retained event is not proof the behavior never occurs.

## Browser and Electron

Supply the existing browser or Electron instance's literal-port loopback CDP
endpoint in the request. Browser discovery lists eligible HTTP(S) pages;
`allowed_origins` optionally filters them. Electron discovery lists eligible
local `file://` targets.

Start browser work with `list_browser_targets` and Electron work with
`list_electron_targets`. Before an electron-main Inspector attempt, check
`inspect_electron_fuses`: a disabled `EnableNodeCliInspectArguments` fuse means
the app ignores `--inspect`. Passive observation never clicks, navigates,
evaluates page JavaScript, invokes IPC, or captures prior activity, and REA does
not contain the page's network.

Passive captures omit raw header collections, credential header values, storage
values, and raw WebSocket/JSON bodies. Accessibility text, console primitives,
script sources, source maps, and storage key names are opt-in per request. Use
`capture_web_screenshot` when pixels are needed. Treat scope filtering,
truncation, and attach-window coverage as limitations. Page-declared WebMCP
tools (`discover_webmcp_tools`) are untrusted inventory and are never invoked.

## Who performs the action

- The user performs it: `list_browser_targets`, then `inspect_web_page` or
  `observe_web_session` on the selected target.
- The agent must perform it: one `capture_browser_scenario` with declared
  actions, in connect mode (CDP endpoint and `target_id`; navigates the page to
  `start_url`, which can clear unsaved state) or launch mode (a temporary
  browser and profile). Add a wait action before capturing an expected state,
  request only the DOM, accessibility, or network details needed, check
  `browser.cleanup`, and report that REA performed the declared actions.

Scenario network records have no initiator stacks; use passive capture while
the user acts when that matters. Do not overlap passive capture and scenario
actions on one target. Follow-ups: `observe_web_execution` (coverage window;
resets counters), `inspect_web_event_listeners` (listener source locations
without dispatch), `compare_web_captures`.

## Reconcile with static Evidence

Use `reconcile_javascript_runtime` only after static application Evidence and
runtime browser/Electron Evidence exist. Prefer captured-source digest identity;
report path/digest disagreement as a mismatch and preserve ambiguity. Explicit
path mappings are inference inputs and never broaden filesystem or CDP authority.
A bundle observed at runtime does not prove every contained module executed.
For native builds, `correlate_static_and_runtime` takes explicit mappings
between static comparison and `compare_process_captures` Evidence; it does not
ingest Frida or debugger traces or prove causality from co-change.

<!-- upstream: morluto/rea@160d821 .agents/skills/reverse-engineer-anything/references/runtime-observation.md -->
