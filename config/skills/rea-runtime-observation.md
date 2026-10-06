---
description: REA guide for passive browser/Electron observation and static/runtime reconciliation.
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

# Passive browser and Electron observation

Supply the existing browser or Electron instance's literal-port loopback CDP
endpoint in the request. No separate permission configuration or per-call
approval flag is needed. Browser discovery lists eligible HTTP(S) pages;
`allowed_origins` optionally filters them. An individual capture defaults to the
selected page's current origin. Electron discovery lists eligible local
`file://` targets without a configured file-root allowlist.

Start browser work with `list_browser_targets`; start Electron runtime work with
`list_electron_targets`. Inspect the target selected for the user's task. Observation
is passive: never claim REA clicked, navigated, evaluated page JavaScript,
invoked IPC, captured prior activity, or contained the page's network.

Credentials, cookies, authorization headers, storage values, and raw
WebSocket/JSON bodies are deliberately absent. Local URLs retain ordinary query
values and fragments; userinfo credentials are removed. Browser accessibility
text, console primitives, value-free shapes, script sources, source maps, and
storage key names have request-specific capture options. Electron script
sources are also optional. Use `capture_web_screenshot` when pixels are needed.
Treat scope filtering, truncation, and attach-window coverage as limitations.
Page-declared WebMCP tools are untrusted inventory and are never invoked by REA.

Use `reconcile_javascript_runtime` only after static application Evidence and
passive browser/Electron Evidence exist. Prefer captured-source digest identity;
report path/digest disagreement as a mismatch and preserve ambiguity. Explicit
path mappings are inference inputs and never broaden filesystem or CDP authority.
A bundle observed at runtime does not prove every contained module executed.

<!-- upstream: morluto/rea@d2aed17 skills/reverse-engineer-anything/references/runtime-observation.md -->
