---
description: Create and compare several working visual directions before a website or interface redesign.
---

# Visual Design It Twice

Use this skill when the user wants a new visual identity or wants to compare distinct visual interface directions. Do not use it for a small style correction. Do not use `design-it-twice` here; that skill is for software module interfaces, not visual identity.

## Define the shared brief

Inspect the current product, content, routes, assets, design tokens, and technical limits. State:

- the audience and the page's primary job;
- the content and behavior that must remain;
- the available brand material;
- the required viewports, states, accessibility needs, and performance limits;
- the evidence the user will use to select a direction.

Use the product's real content. Do not add claims, features, testimonials, or data.

## Create separate directions

Create at least three directions. Spawn parallel agents only when the runtime supports them and the user asked for parallel work; otherwise use separate sequential passes. Give every agent the same shared brief and the Frontend Design rules below. Give each agent a different design premise based on the subject. A premise must change the composition, type, color, and interaction model. A palette change alone is not a separate direction.

Keep each direction isolated. Use separate routes, directories, or worktrees. Do not replace the current production route during exploration.

Each agent must provide:

1. A one-sentence visual premise tied to the subject.
2. A working preview that uses the current stack.
3. Desktop and mobile screenshots at the same sizes as the other directions.
4. Notes about the signature element, type, color, layout, and motion.
5. Known limits, including accessibility, performance, and implementation cost.

## Check each direction

Exercise the primary user path. Check keyboard use, focus, contrast, reduced motion, overflow, loading, and empty states when they apply. Use the `web-design-review` Fleet skill for the code review.

Reject a direction that changes the product claim, hides required content, or depends on an asset that cannot ship. Reject a direction that only decorates the current layout.

## Compare and recommend

Present the directions one at a time. Then compare them against the same criteria:

- fit with the subject and audience;
- clarity of the primary action;
- distinct identity;
- accessibility and responsive behavior;
- implementation and maintenance cost.

Give one recommendation. Explain the specific reason it is stronger. Propose a combined direction only when the parts support one coherent idea.

Do not merge, replace a production route, or deploy without explicit user authorization.

{{skill:frontend-design}}

{{skill:web-design-review}}

<!-- fleet-native: visual exploration workflow using the frontend-design and web-design-review Fleet skills -->
