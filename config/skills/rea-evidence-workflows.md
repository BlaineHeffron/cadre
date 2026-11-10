---
description: REA guide for Evidence paging, comparisons, residual unknowns, and verification.
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

# Evidence, comparison, and verification workflows

Evidence-producing tools return the complete Evidence record in MCP
`structuredContent` and CLI JSON. Read `normalized_result` for operation data,
cite `evidence_id` when another tool or your explanation needs a stable
reference, and preserve authority, limitations, coverage, and residual unknowns.
If a result is incomplete or paginated, continue only when the remaining data
matters; do not fetch a bundle merely to re-read an inline result.

## Retained views instead of repeated producers

Many producers accept `detail: "summary"` when the connected schema advertises
it: `analyze_javascript_application`, `inspect_binary_layout`, `inspect_artifact`,
`inspect_native_exports`, native procedure/name/string inventories, and others.
The summary carries `normalized_result.parent_evidence_id`; page the retained
parent with `inspect_analysis_view` instead of re-running the producer. Batch
exact filters (names, paths, indices) and select only the `fields` you need, for
example `view: {kind: "native-inventory", offset: 0, limit: 32, fields: ["value"]}`
or `view: {kind: "inventory", collection: "occurrences", logical_paths: ["main.js"]}`.
Omit a filter to page everything; `[]` selects nothing. Follow
`coverage.next_offset` only as far as the question needs.

Keep source coverage separate from page exhaustion: an empty page or exhausted
rows over partial source Evidence does not establish absence. Retained
references live on the same MCP connection; `close_binary` clears them, so
export a bundle first when the source must survive. CLI summaries need
`--evidence_output PATH` to keep the complete record.

## Unknowns

Use `record_unknown` to track unresolved questions and name the authority or
environment still required, with supporting and contradicting Evidence IDs.
Use `update_unknown` with the current revision; reread after a stale revision
instead of retrying blindly. Only qualifying observed evidence verifies a
resolution.

## Comparisons

Use complete, compatible page sets when claiming equivalence or absence:

- `compare_artifacts` compares inventory pages by occurrence path, content,
  metadata, and graph relations.
- `compare_functions` compares explicit function Evidence, not fuzzy
  whole-binary matches. It rejects an `analyze_function` summary reply; pass the
  summary's `parent_evidence_id` as a `retained-evidence` reference.
- `compare_bundles` compares canonical bundle membership and unknown history.
- `find_changed_behavior` combines existing comparisons; static differences
  remain candidates, not causal proof.
- `build_call_path` needs complete function dossiers from one artifact/provider;
  an incomplete frontier makes absence unknown.
- `correlate_static_and_runtime` uses explicit mappings; matching patterns are
  hypotheses, not causality.
- `verify_reconstruction` evaluates a finite typed specification. A pass covers
  only declared comparable claims, not global equivalence.

## Process and network captures

Process captures are opt-in behavioral evidence, not a security sandbox. V3
captures cannot be upgraded to V4; rerun the original scenario. Distinguish root
exit from descendant settlement and require freshness when the task needs it. A
timed-out target that must write a final report needs `finalization_ms` (SIGTERM,
then one SIGKILL at the interval's end); read the outcome from
`exit.finalization`.

On retained HAR Evidence from `inspect_web_network_capture`,
`view: {kind: "api-surface"}` groups observed request lines by method, origin and
path template. Templates and format matches are inferences, not handler identity
or schemas; query values are omitted and no request is replayed.

<!-- upstream: morluto/rea@160d821 .agents/skills/reverse-engineer-anything/references/evidence-workflows.md -->
