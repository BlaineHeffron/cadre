---
description: LaTeX math standards, theorems, equations, notation, algorithms, tables, figures, checklist.
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

# Mathematical Content Standards

### 3.1 Theorem-like Environments

Use `amsthm` environments throughout. Apply consistent label prefixes:
`thm:`, `lem:`, `prop:`, `cor:`, `def:`, `ass:`, `rem:`, `ex:`, `eq:`, `alg:`, `fig:`, `tab:`.

Every numbered environment must carry a `\label{}`. Every `\ref{}` and `\eqref{}` must match
an existing label. Use `\cref{}` (from `cleveref`) in preference to `\ref{}` wherever the
environment type should appear in text. Use `\qed` or rely on `amsthm`'s automatic QED
symbol at the end of proofs. If assumptions are referenced repeatedly, define them as
numbered `assumption` environments.

Example with full proof scaffold:

```latex
\begin{assumption}\label{ass:smoothness}
  The function $f \colon \R^n \to \R$ is $L$-smooth: there exists $L > 0$ such that
  \begin{equation}\label{eq:smoothness}
    \norm{\grad f(x) - \grad f(y)} \leq L\norm{x - y}
    \quad \text{for all } x, y \in \R^n.
  \end{equation}
\end{assumption}

\begin{theorem}[Convergence of gradient descent]\label{thm:gd-convergence}
  Suppose \cref{ass:smoothness} holds and $f$ is bounded below. Let $\{x_k\}_{k \geq 0}$
  be the iterates of gradient descent with constant step size $\alpha \in (0, 1/L]$.
  Then
  \begin{equation}\label{eq:gd-rate}
    \min_{0 \leq k \leq K-1} \norm{\grad f(x_k)}^2
    \leq \frac{2\bigl(f(x_0) - f^*\bigr)}{\alpha K},
  \end{equation}
  where $f^* \coloneqq \inf_{x \in \R^n} f(x)$.
\end{theorem}

\begin{proof}
  By $L$-smoothness (\cref{ass:smoothness}), the descent lemma gives
  \[
    f(x_{k+1}) \leq f(x_k) - \frac{1}{2L}\norm{\grad f(x_k)}^2.
  \]
  Summing from $k = 0$ to $K-1$ and dividing by $K$ yields \cref{eq:gd-rate}.
\end{proof}
```

If the user provides a theorem statement without a proof, insert a scaffold:

```latex
\begin{proof}
  \todo{Proof to be completed. Suggested outline: (i) establish the descent lemma;
  (ii) telescope; (iii) divide by $K$.}
\end{proof}
```

Do not fabricate a proof.

### 3.2 Equations and Alignment

| Context | Environment | Rule |
|---|---|---|
| Single numbered equation | `equation` | Always label |
| Multi-line derivation | `align` | Align at `=` or relational symbol using `&`; label each key step |
| Auxiliary steps (unnumbered) | `align*` | No label required |
| Inline expressions | `$...$` | Use only for short symbols; prefer display for anything non-trivial |

Use `\coloneqq` (from `mathtools`) for definitions. Use `\text{where}`, `\text{for all}`,
and similar inside display math. Place punctuation inside displayed equations when the
surrounding sentence requires it. Never use `\text{O}` for asymptotic notation; always use
`\bigO{\cdot}` as defined in the preamble.

### 3.3 Notation Conventions

Be consistent within every document. The conventions below apply unless the user specifies
otherwise.

| Object | Notation |
|---|---|
| Scalars | $\alpha, \beta, \lambda \in \R$ (lowercase italic) |
| Vectors | $\bx, \by \in \R^n$ (bold lowercase) |
| Matrices / linear operators | $\bA, \bJ \in \R^{m \times n}$ (bold uppercase) |
| Function spaces | $\Lp{2}(\Omega)$, $\Sob{1}{\Omega}$, $\SobZ{1}{\Omega}$ |
| Gradient | $\grad f(x)$ |
| Hessian | $\Hess f(x)$ |
| Iterates | $x_k$ (subscript) or $x^{(k)}$ (superscript); pick one and do not change it |
| Objective / loss | $f$, $\mathcal{L}$, or $F$ following the user's choice |
| Step size | $\alphak$ or $\etak$; do not mix |
| Regularisation parameter | $\lambda$ or $\mu$ (not $\alpha$ if that is the step size) |
| Frobenius norm | $\normF{\bA}$ |
| Expectation | $\E[\cdot]$ |
| Probability | $\Prob(\cdot)$ |

### 3.4 Algorithm Pseudocode

Use the `algorithm2e` package (loaded with `ruled, vlined, linesnumbered`). Number lines
whenever the proof or analysis refers to specific steps. Add inline comments with `\tcp{}`.

```latex
\begin{algorithm}[H]
\caption{Iteratively Regularised Gauss--Newton (IRGN)}\label{alg:irgn}
\KwIn{Initial guess $\sigma^{(0)}$; data $\mathbf{V}$;
      regularisation parameters $\{\lambda_k\}$; tolerance $\varepsilon > 0$}
\KwOut{Approximate solution $\sigma^{(K)}$}
Set $k \leftarrow 0$\;
\While{$\norm{\sigma^{(k+1)} - \sigma^{(k)}} > \varepsilon$}{
  Compute Jacobian $\bJ_k \leftarrow \Forward'(\sigma^{(k)})$\;
  \tcp{Solve the linearised regularised subproblem}
  $\sigma^{(k+1)} \leftarrow \arg\min_{\sigma}
    \bigl\|\bJ_k(\sigma - \sigma^{(k)}) - (\mathbf{V} - \Forward(\sigma^{(k)}))\bigr\|^2
    + \lambda_k \Reg(\sigma)$\;
  $k \leftarrow k + 1$\;
}
\Return{$\sigma^{(k)}$}\;
\end{algorithm}
```

### 3.5 Tables of Numerical Results

Rules (apply without exception):
1. Use `booktabs` (`\toprule`, `\midrule`, `\bottomrule`). Never use vertical rules in the body.
2. Bold the best entry in each column with `\textbf{}`.
3. Report uncertainties as `$\mu \pm \sigma$` using `\pm`.
4. Use `siunitx` with the `S` column type for decimal alignment when precision matters.
5. Never allow a table to exceed `\linewidth`. Choose the construction method by column count:
   - Narrow (<=4 cols): plain `tabular`
   - Wide (5-7 cols): `tabularx` with `\linewidth`
   - Very wide (8+ cols): `\resizebox{\linewidth}{!}{...}`

Prefer `tabularx` over `\resizebox` wherever possible — rescaling reduces font size relative
to surrounding text.

See Section 3.5 examples below:

```latex
% Narrow table
\begin{table}[ht]
\centering
\caption{Relative reconstruction error. Bold indicates the lowest error.}\label{tab:relerr}
\begin{tabular}{lccc}
\toprule
Method & $\delta = 0.01$ & $\delta = 0.05$ & $\delta = 0.10$ \\
\midrule
Tikhonov ($\ell^2$) & $0.142 \pm 0.008$ & $0.231 \pm 0.011$ & $0.318 \pm 0.014$ \\
TV regularisation   & $\mathbf{0.103 \pm 0.006}$ & $\mathbf{0.187 \pm 0.009}$ & $0.274 \pm 0.013$ \\
\bottomrule
\end{tabular}
\end{table}

% Wide table
\begin{table}[ht]
\centering
\caption{Performance metrics across five noise levels.}\label{tab:perf}
\begin{tabularx}{\linewidth}{l *{5}{>{\centering\arraybackslash}X}}
\toprule
Method & $\delta_1$ & $\delta_2$ & $\delta_3$ & $\delta_4$ & $\delta_5$ \\
\midrule
Method A & val & val & val & val & val \\
\bottomrule
\end{tabularx}
\end{table}
```

### 3.6 TikZ Figures and pgfplots Graphs

Every figure must include: axis labels, a legend when multiple series are plotted, a
`\caption`, and a `\label`. For convergence plots, use `ymode=log`.

**Width policy (mandatory):** Every `tikzpicture` and `pgfplots` axis must declare an
explicit width using a relative length. Never use absolute `cm` or `pt` values.

| Layout | `width` value |
|---|---|
| Single figure, full-width | `0.85\textwidth` |
| Single figure, default | `0.75\textwidth` |
| Two side-by-side subfigures | `\linewidth` inside a `0.48\textwidth` subfigure |
| Three in a row | `\linewidth` inside a `0.32\textwidth` subfigure |
| Inset or thumbnail | `0.40\textwidth` |

```latex
% Standard convergence plot
\begin{figure}[ht]
\centering
\begin{tikzpicture}
\begin{semilogyaxis}[
    xlabel={Iteration $k$},
    ylabel={$f(x_k) - f^*$},
    legend pos=north east,
    grid=major,
    width=0.75\textwidth,
    height=0.5\textwidth
]
\addplot[blue, thick] coordinates { ... };
\addlegendentry{Method A}
\addplot[red, dashed, thick] coordinates { ... };
\addlegendentry{Method B}
\end{semilogyaxis}
\end{tikzpicture}
\caption{Convergence comparison. Vertical axis in logarithmic scale.}\label{fig:convergence}
\end{figure}

% Wide diagram fallback
\begin{figure}[ht]
\centering
\adjustbox{max width=\textwidth}{%
  \begin{tikzpicture}
    % wide architecture diagram
  \end{tikzpicture}%
}
\caption{Network architecture.}\label{fig:arch}
\end{figure}
```

---


### 6.3 Mathematical Prose

Every displayed equation referred to subsequently must be labelled and introduced by a
complete grammatical sentence. Treat the equation as part of the sentence with appropriate
punctuation.

Define every symbol before or at its first use. When citing a result, state precisely which
part of the cited work is being used (e.g., `\citet[Theorem~2.1]{engl1996}`). Avoid vague
attributions such as "as shown in [3]".

Place quantitative conditions in numbered `assumption` environments rather than burying them
inside theorem statements, whenever those conditions are reusable across multiple results.

### 6.4 Consistency Checks

Before outputting any document, verify:
1. Every symbol introduced in the preamble is used at least once in the body; remove unused macros.
2. The same physical quantity uses the same symbol throughout; no silent switching.
3. All theorem environments are closed; all proofs end with `\end{proof}`.
4. Every `\begin{}` has a matching `\end{}`.
5. No conflicting packages (e.g., `amsmath` not loaded twice; `algorithm2e` and `algorithmic` not both loaded).

---


## Pre-Output Quality Checklist

Run through all items below before producing the final output.

### Compilability
- Every `\begin{}` has a matching `\end{}`.
- No undefined control sequences.
- All required packages loaded in the preamble.
- No package conflicts.

### Label Consistency
- Every numbered environment has a `\label{}`.
- Every `\ref{}`, `\eqref{}`, `\cref{}` resolves to an existing label.
- No label defined more than once.

### Notation Consistency
- Same symbol used for the same object throughout.
- Step sizes, regularisation parameters, and iterates follow Section 3.3 conventions.
- All macros used in the body are defined in the preamble.

### Mathematical Correctness
- Inequalities point in the correct direction.
- Convergence rates and complexity bounds are dimensionally consistent.
- Cited results are used correctly and not misrepresented.
- Proof steps follow logically from stated assumptions.

### Bibliography Completeness
- **Option A:** Every `\cite{}` key has a fully populated `\bibitem{}`; no orphan entries.
- **Option B1:** Every cited key exists in the `.bib` file; `\bibliographystyle{}` and `\bibliography{}` present; `biblatex` not loaded.
- **Option B2:** Every cited key in the `.bib` file; `\printbibliography` present; no `\bibliographystyle{}` or `\bibliography{}`; `natbib` not loaded.

### Margin Safety
- No plain `tabular` with more than 4 columns unless wrapped in `tabularx` or `\resizebox`.
- Every `pgfplots` axis uses a relative width; no absolute `cm` or `pt` values.
- Every free-standing wide `tikzpicture` wrapped in `\adjustbox{max width=\textwidth}`.
- Side-by-side subfigures use `width=\linewidth` inside their `subfigure` environment.

### Writing Quality
- No em dashes, en dashes (outside LaTeX ranges), or prose ellipses.
- No contractions, exclamation marks, or rhetorical questions.
- No prohibited transitional intensifiers.
- Every symbol defined before or at first use.
- Every displayed equation introduced by a complete grammatical sentence with correct punctuation.

---

<!-- upstream: hameefy/claude-latex-skill@c594f5a SKILL.md (Steps 3, 6.3-6.4, 7) -->
