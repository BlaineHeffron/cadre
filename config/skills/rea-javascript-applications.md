---
description: REA guide for ASARs, extracted JavaScript, feature tracing, and version comparison.
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

# JavaScript and Electron application artifacts

Use `analyze_javascript_application` directly on the operator-supplied ASAR or
extracted tree. Source-map contents are part of the static analysis. When size
is unknown or large, request `detail: "summary"` and page the returned
`parent_evidence_id` with `inspect_analysis_view`; summary reduces delivery, not
analysis work. When the question concerns known files, select exact inventoried
`source_paths` (for example `["package.json", "main.js", "preload.js"]`, plus any
manifests or source maps you need); unselected files stay unknown. Omit the
selection for complete analysis; `source_paths: []` is invalid.

To find member paths in a packaged `app.asar`, call `open_binary`, then
`inspect_artifact` with `detail: "summary"`, and page its
`normalized_result.parent_evidence_id` with `inspect_analysis_view`; pass the
chosen paths as `source_paths`. Narrowing reduces analysis work, but the
inventory still examines the whole archive.

When unpacked companions no longer match their declared digests (for example
after re-signing) and you mean to keep those contradictions, pass
`integrity_policy: "record-and-continue"` to `inspect_artifact`,
`analyze_javascript_application`, and `extract_artifact`. The default `fail`
returns `artifact_integrity_mismatch` wherever the contradiction is met,
including the initial inventory.

For captured or bundled JavaScript that needs readable source recovery,
`recover_javascript_sources` (caller-supplied Wakaru, Linux x64) writes an
`analysis_input` directory to analyze; inputs are never executed.

Limits: `max_heap_mb` (default 1024) and per-source `analysis_timeout_ms`
(default 300000) govern the isolated analyzer, not the MCP process or client
deadline. An ASAR header over 16 MiB fails admission naming
`asar.max_header_bytes`; raise it with `update_analysis_settings` and retry.
Resource-limited or timed-out analyses keep completed facts and report partial
coverage with specific unknown scopes; inspect those before retrying.

## Read without repeating analysis

Use the actual returned parent ID as `source: {kind: "retained-evidence",
evidence_id: "ev_..."}` on the same connection. Page module identities with
`view: {kind: "page", collection: "modules", offset: 0, limit: 16}`, then select
one by exact `node_id` with `view: {kind: "item", collection: "modules",
selector: {node_id: "jag_node_..."}}`. One path can map to several module roles,
so prefer `node_id` over `selector.path`. An item shows that node's observations,
identity, hashes, exports and source ranges, not every edge in the application.

Other retained views: `kind: "javascript-routes"` for route candidates (patterns
never establish reachability), `kind: "javascript"` with `projection:
"references"` for canonical identities, and `kind: "javascript-facts"` with
`where: {paths: [...]}` and selected `property_keys` for file and processing
facts. Check `source_coverage` before any negative conclusion.

`analyze_web_bundle` also pages captured endpoint observations and inferences:
`view: {kind: "web-bundle", collection: "endpoints", limit: 32}` with `detail:
"summary"`, then later `endpoints`, `inferences`, or `summary` pages from the
retained parent. Filter before requesting detail; keep `source_index` with the
parent ID and collection, and request `location` or `basis` when tracing
sources. Page exhaustion is not producer completeness: check `completeness`,
`source_unknowns`, and limitations. Endpoint candidates remain inferences, not
confirmed network behavior.

## Trace only the remaining question

Use `trace_application_feature` on the parent Evidence for one literal node ID,
route, string, API, IPC channel, module, or native export, with `incoming`,
`outgoing`, or `both`. Traversal includes containment, so even a narrow seed can
reach unrelated sibling modules; prefer a module item when it already answers
the question, and do not treat every reached node as part of the feature.
For a broad trace, pass `view: {kind: "feature-trace", collection: "paths"}` (or
`summary`) to retain the complete trace and read terminal paths first; page
`nodes` or `edges` with exact `where.node_ids` through `inspect_analysis_view`.
Include Hopper or Ghidra Evidence only when its artifact digest matches exactly.

## Oversized results

`resource_constraint` with `details.resource: "transport"` means the reply did
not fit: reuse `details.reported_limits.evidence_reference` with
`inspect_analysis_view`, or `export_evidence_bundle` to a selected file. A client
can also truncate a successful reply without that error; treat the preview as
incomplete, never parse it as canonical JSON, and never invent or rerun to
recover a lost ID.

## Static Electron surfaces

BrowserWindow preferences, preload and contextBridge surfaces, IPC
registrations, utility processes, and native binding requests are static syntax
observations. Only a unique exact literal IPC channel match supports an inferred
pairing. Dynamic or ambiguous channels remain unresolved. A requested `.node`
member is not a verified native export. Never claim runtime reachability,
registration, defaults, or policy enforcement from static analysis.

## Version comparison

Analyze each version once, then call `compare_application_versions`. Accept only
its digest, source-map, structural fingerprint, or non-module semantic matches.
Module ordinals and minified names are not persistent identity. Report added or
removed only with complete opposite-side coverage; otherwise report unknown.

For how one exported callable's returned object shape changed, call
`compare_javascript_export_shapes` with explicit module paths and export names.
Accept variant pairing only through its unique exact literal discriminant. Read
`property_inventories` and each change's `presence` before treating `unknown`
as "not observed". Dynamic values, ambiguous variants, and incomplete coverage
stay unknown. This is static inference; for runtime semantics, probe the actual
versions through the browser, Electron, or process workflows.

Trace and compare tools accept complete inline Evidence or a retained reference
for `application`, `left`, or `right`; from a summary or inspection reply, use
the complete `normalized_result.parent_evidence_id`. Native observation arrays
and runtime reconciliation's `static_layers[].analysis` and
`runtime_observations[]` also accept exact references where advertised. CLI
workflows advertising `--evidence-bundle` resolve them from that bundle.
`close_binary` releases the engine but keeps retained references and Unknown
history on the same connection; `reset_investigation` clears them (optional
`save_path` checkpoints the bundle first). Import that bundle in another
connection to restore its references. Retention is bounded and never silently
evicted; `binary_session.investigation` reports the budget.

<!-- upstream: morluto/rea@8bb01b5 .agents/skills/reverse-engineer-anything/references/javascript-applications.md -->
