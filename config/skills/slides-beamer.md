---
description: LaTeX Beamer preamble and content standards for academic talks.
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

# Beamer Presentations

## Beamer Preamble

Use the preamble below for ALL Beamer presentations. Do NOT mix with the article preamble
in the `latex-preamble` skill. The two preambles are mutually exclusive.

**Theme selection:** The default theme is `Madrid`. If the user specifies a different
standard theme (e.g., `Berlin`, `AnnArbor`, `Warsaw`, `Copenhagen`, `Frankfurt`,
`Singapore`, `Boadilla`, `CambridgeUS`), substitute it in `\usetheme{}`. Never invent
custom themes; use only named Beamer built-in themes.

**Color theme:** Default is `default` (matching the chosen outer theme's palette). If the
user requests a specific color theme (e.g., `dolphin`, `beaver`, `crane`, `orchid`,
`rose`, `seagull`, `seahorse`, `whale`, `wolverine`), apply it with `\usecolortheme{}`.

```latex
\documentclass[aspectratio=169,10pt]{beamer}
% aspectratio=169 gives 16:9 widescreen; use 43 for 4:3 if user requests it.

% ---------------------------------------------------------------
% Theme — change \usetheme{} to any standard Beamer theme name
% ---------------------------------------------------------------
\usetheme{Madrid}
% \usecolortheme{dolphin}   % Uncomment and change to apply a colour theme

% ---------------------------------------------------------------
% Core mathematics
% ---------------------------------------------------------------
\usepackage{amsmath, amssymb, amsthm, mathtools}
\usepackage{bm}

% ---------------------------------------------------------------
% Algorithms — use ONE of the two options below; comment out the other
% ---------------------------------------------------------------
% OPTION A: algorithm2e (recommended for pseudocode with line numbers)
\usepackage[ruled,vlined,linesnumbered]{algorithm2e}

% OPTION B: algorithmicx + algpseudocode (uncomment if preferred)
% \usepackage{algorithmic}
% \usepackage{algorithmicx}
% \usepackage{algpseudocode}

% ---------------------------------------------------------------
% Graphics and plots
% ---------------------------------------------------------------
\usepackage{graphicx}
\usepackage{tikz}
\usepackage{pgfplots}
\pgfplotsset{compat=1.18}
\usepackage{subfigure}

% ---------------------------------------------------------------
% Tables
% ---------------------------------------------------------------
\usepackage{booktabs}
\usepackage{tabularx}

% ---------------------------------------------------------------
% Theorem-like blocks — configurable style
% ---------------------------------------------------------------
% Beamer provides: theorem, lemma, corollary, proof, definition,
% example, block, alertblock, exampleblock — all built-in.
%
% For coloured framed boxes (tcolorbox style), uncomment below:
% \usepackage{tcolorbox}
% \tcbuselibrary{theorems,skins}
% Then define custom tcolorbox environments as needed (see Step 3B).

% ---------------------------------------------------------------
% Footnote citation control
% ---------------------------------------------------------------
\usepackage{perpage}   % resets footnote counter on each slide
\MakePerPage{footnote}

% ---------------------------------------------------------------
% Miscellaneous
% ---------------------------------------------------------------
\usepackage{xcolor}
\usepackage{multicol}  % for two-column slides

% ---------------------------------------------------------------
% Notation macros (shared with article mode for consistency)
% ---------------------------------------------------------------
\newcommand{\norm}[1]{\left\lVert #1 \right\rVert}
\newcommand{\ip}[2]{\left\langle #1,\, #2 \right\rangle}
\newcommand{\abs}[1]{\left\lvert #1 \right\rvert}
\newcommand{\grad}{\nabla}
\newcommand{\R}{\mathbb{R}}
\newcommand{\N}{\mathbb{N}}
\newcommand{\E}{\mathbb{E}}
\newcommand{\bigO}[1]{\mathcal{O}\!\left(#1\right)}
\newcommand{\xk}{x_k}
\newcommand{\alphak}{\alpha_k}
\newcommand{\etak}{\eta_k}
\newcommand{\bx}{\mathbf{x}}
\newcommand{\bg}{\mathbf{g}}
\newcommand{\bA}{\mathbf{A}}
\newcommand{\bJ}{\mathbf{J}}

% ---------------------------------------------------------------
% Presentation metadata — fill in before \begin{document}
% ---------------------------------------------------------------
\title[Short Title]{Full Title of the Presentation}
\subtitle{Subtitle or Paper Title (if applicable)}
\author[H.~Mohammad]{Hassan Mohammad}
\institute[BUK]{%
  Numerical Optimisation Research Group\\
  Department of Mathematical Sciences\\
  Faculty of Physical Sciences\\
  Bayero University, Kano, Nigeria
}
\date{\today}
```

---

## Beamer Content Standards

### 3B.1 Section Structure — Flexible Defaults

The eight sections below are the default scaffold. The user may omit any section or
reorder them. When a section is omitted, remove its `\section{}` declaration and all
corresponding frames. Never leave an empty `\section{}` block.

| # | Section | `\section{}` name | Typical frame count |
|---|---|---|---|
| 1 | Title page | *(title frame, no section)* | 1 |
| 2 | Table of contents | *(TOC frame, no section)* | 1 |
| 3 | Introduction | `Introduction` | 2–3 |
| 4 | Literature review / Related work / Motivation | `Related Work` | 2–3 |
| 5 | Method / Algorithm | `Methodology` | 3–5 |
| 6 | Convergence results | `Convergence Analysis` | 2–4 |
| 7 | Implementation / Numerical experiments | `Numerical Experiments` | 2–3 |
| 8 | Conclusion / Further research | `Conclusion` | 1–2 |

If the user provides only a title or partial content, generate all eight sections with
`\todo{}` placeholder text inside each frame body. If the user provides a full manuscript,
populate each section from the manuscript, preserving mathematical notation exactly.

### 3B.2 Footnote Citations

Beamer uses `\footnotemark` / `\footnotetext{}` pairs exclusively. There is NO
reference section at the end of the presentation; every cited source appears as a
footnote on the slide where it is first cited.

**Citation pattern — use verbatim:**

```latex
% Within slide body text, place the mark:
...as shown by La Cruz et al.\footnotemark{}...

% Immediately before \end{frame}, place the text:
\footnotetext{W.~La Cruz, J.~Mart\'{\i}nez, and M.~Raydan,
  ``Spectral residual method without gradient information for solving large-scale
  nonlinear systems of equations,''
  \textit{Math.\ Comp.}, vol.~75, no.~255, pp.~1429--1448, 2006.}
```

Rules for footnote citations:
1. Every `\footnotemark` must have a matching `\footnotetext` within the same `frame`.
2. Use `\MakePerPage{footnote}` (already in the preamble) so the counter resets per slide.
3. If more than two references appear on one slide, consider splitting the slide or using
   a smaller font for the `\footnotetext` entries: `{\tiny \footnotetext{...}}`.
4. Format: Author(s), ``Title,'' \textit{Journal/Proceedings}, vol., no., pp., Year.
   For books: Author(s), \textit{Title}, Publisher, Year.
5. Never list a reference in a `\footnotetext` that does not have a corresponding
   `\footnotemark` on the same slide.
6. If the user provides BibTeX keys without full details, supply the correct bibliographic
   entry from knowledge of the standard literature. If genuinely ambiguous, insert:
   `\footnotetext{\todo{Fill in full bibliographic details.}}`

### 3B.3 Theorem-like Blocks

**Default (Beamer built-in environments):** Use `\begin{theorem}`, `\begin{lemma}`,
`\begin{corollary}`, `\begin{definition}`, `\begin{proof}` directly inside frames.
Beamer styles these automatically with coloured headers matching the chosen theme.

```latex
\begin{frame}{Convergence Result}
  \begin{theorem}[Global Convergence]\label{thm:global}
    Let Assumptions~1 and~2 hold. If $\{x_k\}$ is the sequence generated by
    Algorithm~1, then
    \[
      \lim_{k \to \infty} \|F(x_k)\| = 0.
    \]
  \end{theorem}
  \footnotetext{\todo{Citation if theorem is from a paper.}}
\end{frame}
```

**Optional tcolorbox style (activate in preamble):** If the user requests coloured framed
boxes resembling the sample slides, uncomment the `tcolorbox` lines in the preamble and
add definitions such as:

```latex
\usepackage{tcolorbox}
\tcbuselibrary{theorems,skins}
\newtcbtheorem[number within=section]{thm}{Theorem}{%
  colback=blue!5, colframe=blue!40!black,
  fonttitle=\bfseries}{thm}
\newtcbtheorem[number within=section]{lem}{Lemma}{%
  colback=green!5, colframe=green!40!black,
  fonttitle=\bfseries}{lem}
```

Do NOT load `tcolorbox` by default; only include it when the user explicitly requests
coloured framed boxes.

### 3B.4 Algorithm Pseudocode on Slides

Use `algorithm2e` (already loaded) inside a `frame` with `[fragile]` option, because
verbatim-like environments require it.

```latex
\begin{frame}[fragile]{Algorithm: Name of Algorithm}
  \begin{algorithm}[H]
  \caption{AlgorithmName}\label{alg:main}
  \KwIn{Initial point $x_0 \in \R^n$, tolerance $\varepsilon > 0$}
  \KwOut{Approximate solution $x^*$}
  Set $k \leftarrow 0$\;
  \While{$\|F(x_k)\| > \varepsilon$}{
    Compute search direction $d_k$\;
    Find steplength $\alpha_k$ via line search\;
    $x_{k+1} \leftarrow x_k + \alpha_k d_k$\;
    $k \leftarrow k + 1$\;
  }
  \Return{$x_k$}\;
  \end{algorithm}
\end{frame}
```

If using `algorithmicx` instead, the frame must also be `[fragile]`:

```latex
\begin{frame}[fragile]{Algorithm: Name}
  \begin{algorithmic}[1]
    \Require $x_0$, $\varepsilon > 0$
    \Ensure $x^*$
    \For{$k = 0, 1, 2, \ldots$}
      \State Compute $d_k$
      \State $x_{k+1} \leftarrow x_k + \alpha_k d_k$
    \EndFor
  \end{algorithmic}
\end{frame}
```

### 3B.5 Performance Profile and Numerical Results Slides

For numerical experiments, use a two-column layout to show profiles and tables side by
side:

```latex
\begin{frame}{Numerical Results — Performance Profiles}
  \begin{columns}[T]
    \begin{column}{0.48\textwidth}
      \begin{figure}
        \includegraphics[width=\linewidth]{fig_iterations.pdf}
        \caption{Number of iterations}
      \end{figure}
    \end{column}
    \begin{column}{0.48\textwidth}
      \begin{figure}
        \includegraphics[width=\linewidth]{fig_fevals.pdf}
        \caption{Function evaluations}
      \end{figure}
    \end{column}
  \end{columns}
  \vspace{0.3em}
  {\small Dolan--Mor\'{e} performance profiles; higher is better.}
\end{frame}
```

For tables of numerical results:

```latex
\begin{frame}{Numerical Results — Comparison Table}
  \begin{table}
    \centering
    \small
    \begin{tabular}{lrrr}
      \toprule
      Method & Iter. & F-Evals & CPU (s) \\
      \midrule
      Method A & 42 & 89 & \textbf{0.31} \\
      Method B & \textbf{38} & \textbf{76} & 0.45 \\
      \bottomrule
    \end{tabular}
    \caption{Comparison on test problems ($n = 1000$).}
  \end{table}
\end{frame}
```

### 3B.6 Frame Construction Rules

1. Every frame must have a non-empty `\frametitle{}` argument (or use the `{Title}` short
   form of `\begin{frame}{Title}`).
2. Never overload a single frame; limit each slide to one main idea, result, or algorithm
   step. If content overflows, split into multiple frames with the same section and a
   subtitle distinguishing them (e.g., "Proof — Part I", "Proof — Part II").
3. Use `\pause` sparingly; prefer complete slides for printed handouts.
4. Use `\alert{}` to highlight a single key term or result per frame, not multiple items.
5. Use `\begin{itemize}` / `\begin{enumerate}` with no more than five items per frame.
   Sub-items are allowed but limit nesting to two levels.
6. Equations on slides must be display-style whenever they span more than a short inline
   fragment. Prefer `\[ ... \]` over inline `$ ... $` for anything non-trivial.
7. Every frame that cites a source must have at least one `\footnotemark` and its
   matching `\footnotetext` (see Section 3B.2).

### 3B.7 Table of Contents Slide

Use `\tableofcontents` with `[hideallsubsections]` to show only section-level entries.
For a long talk, use `[currentsection]` at the start of each section to re-show the TOC
with the current section highlighted.

```latex
% Main TOC slide (after title)
\begin{frame}{Outline}
  \tableofcontents[hideallsubsections]
\end{frame}

% Optional: section-entry TOC slide at the start of each section
\AtBeginSection[]{
  \begin{frame}{Outline}
    \tableofcontents[currentsection, hideallsubsections]
  \end{frame}
}
```

---

<!-- upstream: hameefy/claude-latex-skill@c594f5a SKILL.md (Steps 2B, 3B) -->
