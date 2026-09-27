---
description: Write a readable, compilable LaTeX technical note.
---

<!--
Copyright (c) 2026 Hassan Mohammad

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

# LaTeX Technical Note

Produce a technical note that compiles on the first try and reads well: a self-contained `.tex` document presenting a derivation, analysis, method, or result, with correct math and honest claims. This is the middle ground between a one-off snippet and a full paper.

## Classify first

Decide the mode before writing:

- **Note (default)**: a standalone `\documentclass{article}` document, preamble through `\end{document}`, for a derivation, convergence/complexity result, method writeup, or technical memo. Use the process below.
- **Snippet**: a single equation, algorithm, table, or TikZ figure to drop into someone else's document. Deliver raw body content, no preamble, as a labelled code block. Pull the relevant standards from the `latex-math` fleet skill (config/skills/latex-math.md).
- **Talk**: slides. Use the `scientific-slides` fleet skill (config/skills/scientific-slides.md) for structure and the `slides-beamer` skill (config/skills/slides-beamer.md) for the Beamer preamble.

When in doubt, ask which one.

## Process for a note

### 1. Preamble

Use the standard article preamble from the `latex-preamble` fleet skill (config/skills/latex-preamble.md) verbatim: it loads the math, algorithm, figure, table, citation, and typography packages, defines the theorem environments, and provides the notation macros. Do not improvise a preamble; extend it only when the content needs a package it lacks.

### 2. Structure

Pick the skeleton that fits the content:

- **Derivation**: Setup (define every object, notation, spaces) → Derivation (step by step, `align`) → Result (`\boxed{}` the final expression).
- **Theorem/analysis**: Problem setup → Assumptions (numbered `assumption` environments) → Main result (lemmas, then theorem with proof) → Discussion.
- **Method/memo**: Problem → Approach → Result → what remains open.

Keep the structure as light as the content allows. A two-page note does not need six sections.

### 3. Math and prose standards

All mathematical content (theorem environments, equation alignment, notation conventions, algorithm pseudocode, numerical-results tables, TikZ/pgfplots figures) follows the `latex-math` fleet skill (config/skills/latex-math.md). It also carries the writing-quality rules and the pre-output compile checklist. Load it whenever you write the body.

Load-bearing points, so the note is readable and not just correct:

- Every displayed equation you refer to later gets a `\label{}` and is introduced by a complete grammatical sentence, with the equation punctuated as part of that sentence.
- Define every symbol before or at first use. One symbol, one meaning, throughout.
- Every figure declares a **relative** width (`0.75\textwidth`), never absolute `cm`/`pt`, so nothing overflows the margin. Tables wider than 4 columns use `tabularx` or `\resizebox`.
- Never fabricate a proof, a theorem, or a numerical result that was not provided. Insert a `\todo{}` scaffold instead and say what is missing.

### 4. Claims and citations

A technical note still makes claims. Apply the `paper` fleet skill (config/skills/paper.md): each nontrivial claim is stated in one sentence, marked as derivation / cited / speculation, and (where empirical) paired with what would falsify it. Cite precisely, naming the specific result used (`\citet[Theorem~2.1]{engl1996}`), never a vague "as shown in [3]". For bibliography setup (self-contained `thebibliography` vs BibTeX vs BibLaTeX), see the reference section of the `latex-math` skill's source note; pick one workflow and do not mix them.

### 5. Compile and verify

Before declaring the note done, run the pre-output checklist from `latex-math`: every `\begin` has a matching `\end`, every `\ref`/`\cref`/`\eqref` resolves, no undefined control sequences, no package conflicts, no margin overflow. If a LaTeX toolchain is available, actually compile it and read the log; a note that "should compile" has not been verified (the `verify` fleet skill applies). If you cannot compile, say so and list what you could not check.

### 6. Readable prose, not stiff prose

The math standards ban contractions, exclamation marks, and rhetorical questions, and that is right for a formal note. But readable is the goal, not stilted: write in complete declarative sentences that each carry one step, prefer active voice ("we derive an upper bound"), quantify instead of intensifying ("grows as $\bigO{h^{-2}}$", not "grows very fast"), and cut the AI-tell vocabulary the `unslop` fleet skill (config/skills/unslop.md) targets. A note that is correct but unreadable has failed half its job.

<!-- upstream: hameefy/claude-latex-skill@c594f5a SKILL.md (split into latex-preamble/latex-math; EIT-specific defaults dropped; fleet paper/unslop/verify pointers added) -->
