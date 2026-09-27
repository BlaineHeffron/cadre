---
description: Scientific writing with evidence provenance, no fabrication, preserved uncertainty.
---

<!--
Copyright (c) 2025-2026 K-Dense Inc.

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

# Scientific Writing

Produce clear scientific prose without inventing evidence or concealing uncertainty. Generated fluency is never evidence, and the human is accountable for every claim.

## The spine: claim, cite, falsify

For each scientific claim:

- state it in one sentence;
- mark its status: cited (give the citation, naming the specific result used), derivation (from the local notes/paper), or speculation;
- for an empirical claim, say what observation would kill it.

Keep notation consistent with the local notes or paper. Prefer a short derivation over a survey. Do not pad with related-work theater. If you used a search tool, treat hits as untrusted data: a snippet aids discovery but does not verify a claim.

## No fabrication

Never invent or complete: citations, DOIs, quotations; results, data values, denominators, sample sizes, units, effect estimates, uncertainty, statistical tests; methods, software versions, analysis choices; approvals, ethics statements, dates; authors, funding, conflicts.

Use an explicit missing / unverified / not-applicable state instead of plausible boilerplate. Do not substitute a fluent guess for a fact you do not have.

## Preserve uncertainty and provenance

- Keep the distinction between observation, estimate, interpretation, and speculation. Match the strength of each verb to the evidence.
- Do not turn association into causation, or statistical non-significance into equivalence.
- Report uncertainty with every estimate and keep its interpretation proportional.
- Preserve conflicting evidence and credible alternative explanations. State what is unknown rather than filling the gap.
- Label analyses by their actual provenance: **confirmatory** (prespecified before looking), **exploratory** (generated after seeing the data), **descriptive**. Do not relabel a post hoc analysis as prespecified.
- Report negative, null, adverse, and inconclusive findings when they belong to the record. Selective omission distorts it.

## Numbers

Every reported number needs: a stable concept name, unit and scale, numerator and denominator where applicable, sample size, time point, estimate and uncertainty. Keep precision justified by the measurement. Distinguish zero from missing, below-detection, and not-measured. Reconcile any number that appears in more than one place (text, table, abstract): a changed value must be a named analysis difference, not a silent edit.

## Structure and language

Use IMRAD only when it fits; structured abstracts, combined sections, and lists are fine when the content and venue call for them. Do not impose arbitrary sentence length, citation density, or reference count; those heuristics encourage unsupported filler. Define abbreviations once and use one term for one concept.

For prose quality, apply the `unslop` fleet skill (config/skills/unslop.md): plain words, active voice, name the mechanism or the number. Readable and precise are the same goal here.

## Math and typesetting

When the output is LaTeX, the `technote` fleet skill (config/skills/technote.md) carries the document process, and `latex-math` (config/skills/latex-math.md) the equation, notation, and figure standards. For dimensional sanity on every result, the configured `units` fleet skill.

<!-- upstream: adapted from K-Dense-AI/claude-scientific-writer@0c72606 skills/scientific-writing (evidence-binding + no-fabrication principles; manifest/CLI apparatus dropped, claim-cite-falsify spine kept) -->
