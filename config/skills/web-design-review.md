---
description: Review implemented web interfaces for accessibility, interaction, responsive layout, content handling, and browser performance.
---

<!--
Copyright (c) 2025 Vercel Labs

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

# Web Design Review

Use this skill after frontend implementation or when the user requests an interface audit. Do not use it to select a visual concept.

Review the supplied files and the rendered interface when a browser is available. Apply only rules that fit the product and stack. Project requirements and explicit user instructions take priority.

## Accessibility

- Give an icon-only button an accessible name.
- Connect each form control to a visible label or an accessible name.
- Use a button for an action and a link for navigation.
- Give meaningful images useful alternative text. Use empty alternative text for decorative images.
- Hide decorative icons from assistive technology.
- Announce asynchronous status and validation changes when users need them.
- Prefer semantic HTML before ARIA.
- Keep heading levels in order. Add a skip link when repeated navigation precedes the main content.
- Make every action available by keyboard.
- Keep the focused element visible when headers or overlays use fixed positioning.

## Focus and forms

- Show a visible `:focus-visible` state.
- Do not remove an outline without an equal focus indicator.
- Give inputs useful `name`, `type`, `inputmode`, and `autocomplete` values.
- Do not block paste.
- Make the label and its checkbox or radio button one hit area.
- Show errors beside their fields. Focus the first error after submission.
- Keep the submit button enabled until the request starts.
- Warn the user before navigation discards unsaved changes.

## Motion and interaction

- Honor `prefers-reduced-motion`.
- Animate `transform` and `opacity` when possible.
- List transition properties. Do not use `transition: all`.
- Let user input interrupt animation.
- Add pause controls for motion that continues longer than five seconds beside other content.
- Provide a click and keyboard alternative for drag, swipe, pinch, or path gestures.
- Use `autoFocus` only when one desktop input clearly needs it.
- Make hover, active, and focus states more visible than the resting state.

## Content and layout

- Test empty, short, long, and user-written content.
- Let flex children shrink with `min-width: 0` when text can truncate.
- Prevent unwanted horizontal scrolling by fixing the source of overflow.
- Prefer CSS grid or flex layout over JavaScript size measurements.
- Account for safe-area insets in full-screen controls.
- Keep the current text rules. Do not rewrite interface text only to satisfy this review.
- Use specific action labels. State the corrective action in error messages.

## Images and performance

- Set image width and height to prevent layout movement.
- Load below-fold images lazily.
- Give above-fold critical images high fetch priority when appropriate.
- Do not read layout during render.
- Batch DOM reads and writes.
- Check large lists before adding virtualization. Use it when measurement shows a need.
- Preconnect only to required asset hosts.
- Preload only critical fonts. Use `font-display: swap` or a suitable measured alternative.
- Prefer compressed video over animated GIF for substantial motion. Provide a still image for reduced motion.

## Navigation, state, and locale

- Keep shareable filters, tabs, and pagination in the URL when users must link to that state.
- Use links for destinations so standard browser link actions work.
- Require confirmation or an undo period for destructive actions.
- Format dates, numbers, and money with the applicable `Intl` API.
- Detect language from browser or request settings, not an IP address.
- Guard server-rendered dates and times against hydration differences.
- Use `suppressHydrationWarning` only for a known, unavoidable difference.

## Required checks

Flag these defects when present:

- disabled browser zoom;
- paste prevention;
- `transition: all`;
- a removed focus outline without a replacement;
- navigation from a non-link click handler;
- a clickable `div` or `span` instead of a button;
- an image without dimensions;
- an input without a label;
- an icon button without an accessible name;
- a hardcoded locale-sensitive date or number;
- unjustified automatic focus;
- a gesture-only action.

## Report

Group findings by file. Use `file:line` locations. State the observed defect and the smallest useful correction. Mark a clean file as `pass`.

Separate code findings from browser findings. State any viewport or interaction that you could not test. Do not report a rule without evidence.

<!-- upstream: vercel-labs/web-interface-guidelines@e3d624b command.md; adapted and fixed locally, no runtime network fetch -->
