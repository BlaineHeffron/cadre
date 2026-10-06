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

REA returns Evidence with each result. Read that result directly, cite its
Evidence ID when another tool or your explanation needs a stable reference, and
preserve authority, limitations, coverage, and residual unknowns. If a result
is incomplete or paginated, continue only when the remaining data matters to
the task; do not fetch a bundle or resource merely to read a result already
returned inline.

Use `record_unknown` to track unresolved questions in the user's investigation
and name the authority or environment still required. Supply supporting and
contradicting evidence IDs. It updates the session registry directly.
Use `update_unknown` with the current revision; reread after a stale revision
instead of retrying blindly. Only qualifying observed evidence can verify a
resolution.

Use comparisons with complete, compatible page sets when claiming equivalence
or absence:

- `compare_artifacts` compares inventory pages by occurrence path, content,
  metadata, and graph relations.
- `compare_functions` compares explicit function Evidence, not fuzzy
  whole-binary matches.
- `compare_bundles` compares canonical bundle membership and unknown history.
- `find_changed_behavior` combines existing comparisons; static differences
  remain candidates, not causal proof.
- `build_call_path` needs explicit function dossiers from one artifact/provider;
  an incomplete frontier makes absence unknown.
- `correlate_static_and_runtime` uses explicit mappings; matching patterns are
  hypotheses, not causality.
- `verify_reconstruction` evaluates a finite typed specification. A pass covers
  only declared comparable claims, not global equivalence.

Process captures are opt-in behavioral evidence, not a security sandbox. V3
captures cannot be upgraded to V4; rerun the original scenario. Distinguish root
exit from descendant settlement and require freshness when the task needs it.

<!-- upstream: morluto/rea@d2aed17 skills/reverse-engineer-anything/references/evidence-workflows.md -->
