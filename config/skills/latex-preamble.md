---
description: Standard LaTeX article preamble, packages, theorem environments, notation macros.
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

# Standard Article Preamble

Use the preamble below verbatim. Do not improvise or abbreviate it.

```latex
\documentclass[11pt,a4paper]{article}

% ---------------------------------------------------------------
% Core mathematics packages
% ---------------------------------------------------------------
\usepackage{amsmath, amssymb, amsthm, mathtools}
\usepackage{bm}            % bold math symbols
\usepackage{dsfont}        % indicator function \mathds{1}

% ---------------------------------------------------------------
% Algorithms
% ---------------------------------------------------------------
\usepackage[ruled,vlined,linesnumbered]{algorithm2e}

% ---------------------------------------------------------------
% Graphics, figures, and plots
% ---------------------------------------------------------------
\usepackage{graphicx}
\usepackage{tikz}
\usepackage{pgfplots}
\pgfplotsset{compat=1.18}
\usepackage{subfigure}     % side-by-side figures
\usepackage{adjustbox}     % fallback rescaling for wide TikZ diagrams

% ---------------------------------------------------------------
% Tables
% ---------------------------------------------------------------
\usepackage{booktabs}
\usepackage{tabularx}
\usepackage{siunitx}       % decimal-aligned columns, SI units

% ---------------------------------------------------------------
% Cross-referencing and citations
% ---------------------------------------------------------------
\usepackage[numbers,sort&compress]{natbib}
\usepackage[colorlinks=true,linkcolor=blue,citecolor=blue,urlcolor=blue]{hyperref}
\usepackage[capitalise,noabbrev]{cleveref}

% ---------------------------------------------------------------
% Typography
% ---------------------------------------------------------------
\usepackage{microtype}
\usepackage{parskip}
\setlength{\parindent}{0pt}
\setlength{\parskip}{6pt}

% ---------------------------------------------------------------
% Page layout
% ---------------------------------------------------------------
\usepackage[margin=2.5cm]{geometry}

% ---------------------------------------------------------------
% Miscellaneous
% ---------------------------------------------------------------
\usepackage{xcolor}
\usepackage{todonotes}     % \todo{} markers for placeholders

% ---------------------------------------------------------------
% Theorem environments (amsthm)
% ---------------------------------------------------------------
\theoremstyle{plain}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\newtheorem{proposition}[theorem]{Proposition}
\newtheorem{corollary}[theorem]{Corollary}

\theoremstyle{definition}
\newtheorem{definition}[theorem]{Definition}
\newtheorem{assumption}{Assumption}
\newtheorem{example}[theorem]{Example}

\theoremstyle{remark}
\newtheorem{remark}[theorem]{Remark}

% ---------------------------------------------------------------
% Notation macros (computational and applied mathematics)
% ---------------------------------------------------------------
% Norms and inner products
\newcommand{\norm}[1]{\left\lVert #1 \right\rVert}
\newcommand{\normF}[1]{\left\lVert #1 \right\rVert_{\mathrm{F}}}
\newcommand{\ip}[2]{\left\langle #1,\, #2 \right\rangle}
\newcommand{\abs}[1]{\left\lvert #1 \right\rvert}

% Calculus and optimisation
\newcommand{\grad}{\nabla}
\newcommand{\Hess}{\nabla^2}
\newcommand{\Lapl}{\Delta}
\newcommand{\divergence}{\operatorname{div}}
\newcommand{\curl}{\operatorname{curl}}

% Function spaces
\newcommand{\Lp}[1]{L^{#1}}
\newcommand{\Sob}[2]{H^{#1}(#2)}
\newcommand{\SobZ}[2]{H^{#1}_0(#2)}

% Operators and matrices
\newcommand{\bA}{\mathbf{A}}
\newcommand{\bB}{\mathbf{B}}
\newcommand{\bJ}{\mathbf{J}}
\newcommand{\bK}{\mathbf{K}}
\newcommand{\bI}{\mathbf{I}}
\newcommand{\bx}{\mathbf{x}}
\newcommand{\by}{\mathbf{y}}
\newcommand{\bz}{\mathbf{z}}
\newcommand{\bu}{\mathbf{u}}
\newcommand{\bv}{\mathbf{v}}

% Probability and statistics
\newcommand{\E}{\mathbb{E}}
\newcommand{\Prob}{\mathbb{P}}
\newcommand{\Var}{\operatorname{Var}}
\newcommand{\Cov}{\operatorname{Cov}}
\newcommand{\indicator}{\mathbf{1}}

% Asymptotic notation
\newcommand{\bigO}[1]{\mathcal{O}\!\left(#1\right)}
\newcommand{\smallO}[1]{o\!\left(#1\right)}

% Common domains
\newcommand{\R}{\mathbb{R}}
\newcommand{\N}{\mathbb{N}}
\newcommand{\C}{\mathbb{C}}

% Iterates and step sizes
\newcommand{\xk}{x_k}
\newcommand{\alphak}{\alpha_k}
\newcommand{\etak}{\eta_k}
```

---

<!-- upstream: hameefy/claude-latex-skill@c594f5a SKILL.md (Step 2) -->
