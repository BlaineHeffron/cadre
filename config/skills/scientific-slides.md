---
description: Turn a running notes deck into a legible, well-ordered scientific talk.
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

# Scientific Slides

Turn research content into a talk that a room can read and follow. The common failure this skill prevents: a deck built by dumping notes onto slides, where plots are too small to read, text is dense and jumbled, and the order follows how the work was done rather than how a listener needs to hear it.

This skill assumes the fleet workflow: content starts as running Markdown notes (or a paper), and you render to a real deck. The rendering target is the user's choice; **for a math-heavy or theory talk, render to LaTeX Beamer** using the `slides-beamer` fleet skill (config/skills/slides-beamer.md), which carries the preamble and content standards. For a design-forward talk, render to whatever the user names.

## The one rule that fixes most decks

**One slide, one message, and the message is the title.** Write each slide's title as a full assertion (the finding), not a topic label. "Gradient clipping stabilizes training above lr=0.1", not "Results". The body is the single piece of evidence for that assertion: one plot, one table, or one diagram. If a slide needs two messages, it is two slides. This alone removes the density and the jumble, because every slide now has exactly one job and states it.

## Process

Work in four passes. Do not skip to rendering.

### 1. Narrative order (fixes "illogical order")

Before touching layout, write the **assertion outline**: the ordered list of slide titles, each a full-sentence claim, and nothing else. Order them so each claim is understandable given only the claims before it. The default arc is question → why it matters → approach → evidence (the bulk) → what it means → limits. Reorder from how-the-work-happened to how-a-listener-builds-understanding: a result the audience can't yet interpret comes after the setup that makes it interpretable, never before.

Check: read the titles alone, top to bottom. They should tell the whole story as a paragraph. If they don't, the deck won't either. Get the outline right before designing a single slide. Talk-length structure, timing, openings and closings: the `slides-structure` fleet skill (config/skills/slides-structure.md).

### 2. Assign evidence (fixes "dense and jumbled")

For each assertion, name the one exhibit that proves it. Cut every slide element that is not that exhibit or its label. Bullets are speaker prompts, not the content: at most 3-4 lines, 4-6 words each, and they never duplicate what you will say out loud. If a slide has prose paragraphs, it is a document, not a slide; move the prose to the notes. Aim for 40-50% empty space on every slide.

### 3. Make plots legible (fixes "plots too small to read")

Slide figures are not paper figures. A paper figure is read from 30cm; a slide figure is read from across a room. Redesign, do not paste:

- **Type size floor**: axis labels, tick labels, and legend text must render at roughly 18pt+ at final slide size. A figure exported for a two-column paper has ~8pt labels; on a slide they are unreadable. Regenerate the plot with enlarged fonts, or crop to the one panel that carries the message and enlarge that.
- **One message per figure**: a six-panel paper figure becomes one panel per slide, or one redrawn panel showing only the comparison that matters. Delete series, panels, and annotations the assertion doesn't need.
- **Contrast and encoding**: high contrast (aim 7:1), and never rely on color alone (line style, markers, direct labels) so it survives a projector and colorblind viewers.
- **Direct labels over legends**: label the line at its end rather than making the room map a legend swatch back to a curve.

Figure redesign specifics, chart-type choices, progressive disclosure of complex plots: the `slides-dataviz` fleet skill (config/skills/slides-dataviz.md).

### 4. Design pass (fixes "hard to read")

Only now, styling. Pick a deliberate palette and a display/body type pairing, set a clear hierarchy (title large, body medium), and hold it identical across every slide. Body text no smaller than 24pt. Typography, color theory, layout, visual hierarchy, accessibility: the `slides-design` fleet skill (config/skills/slides-design.md). For a talk that should look genuinely distinctive rather than templated, the `frontend-design` fleet skill's principles (config/skills/frontend-design.md) apply to slides too: ground the look in the subject, spend boldness on one signature element, keep the rest quiet.

## Visual review before done

Render, then look at every slide at presentation size (export to images or PDF and open them). Do not trust the source; trust the rendered pixels. Check each slide for: title is a full assertion, one message, figure text readable at size, nothing overflowing the frame, nothing overlapping, consistent styling. Fix and re-render. A slide that reads fine in source and overflows when rendered is a broken slide. This visual pass is not optional; it is where "looks fine to me" claims get caught (the `verify` fleet skill applies: evidence from the rendered deck, not the source).

## Prose in the deck

Slide copy is design material. Errors of density come from writing slides like paragraphs. Apply the `unslop` fleet skill (config/skills/unslop.md) to titles and bullets: cut filler, name the mechanism or the number, one idea per line.

## Checklist

- [ ] Titles alone, read top to bottom, tell the whole story
- [ ] Every title is a full-sentence assertion, not a topic label
- [ ] Every slide has exactly one message and one exhibit
- [ ] Every figure's text is readable at final slide size (18pt+ floor)
- [ ] Multi-panel paper figures split or cropped to one message each
- [ ] Body text 24pt+, high contrast, no color-only encoding
- [ ] 40-50% white space per slide
- [ ] Rendered deck reviewed slide-by-slide at presentation size
- [ ] Results occupy 40-50% of the talk

<!-- upstream: adapted from K-Dense-AI/claude-scientific-writer@0c72606 skills/scientific-slides (Nano-Banana generation dropped; assertion-evidence spine and md→render fleet workflow added) -->
