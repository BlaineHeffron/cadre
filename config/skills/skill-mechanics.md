---
description: How fleet launch skills load, compose, and disclose.
---

<!--
Copyright (c) 2026 Matt Pocock

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

# Skill Mechanics

The skill-specific branch of `writing-for-agents`: what changes when the document is a fleet launch skill. Everything else about writing it is the universal reference (config/skills/writing-for-agents.md).

## How skills load

A skill is one flat `.md` file. Stock skills live in `config/skills/` (git-tracked, deployed from origin/main); local overrides live in `state/skills/` (git-ignored, and a local file shadows a stock skill with the same id). The id is the filename; frontmatter carries only `description:`.

Nothing auto-loads. Selecting a skill at launch injects its body as startup user text, and a `{{skill:<name>}}` token in any prompt or skill body inlines that skill's body at injection time. The description never reaches the agent: it labels the skill in the picker, for the human. Every fleet skill is human-invoked; the human is the index, and that cognitive load is the design, not a cost to remove.

## Composition and disclosure

The `{{skill:<name>}}` token is the single-source mechanism: reference that every branch of a skill needs lives in its own file and is token-inlined, so it stays independently injectable and is edited in one place. Expansion is recursive with bounded depth, so keep token graphs acyclic.

Reference only some branches reach stays a separate skill, reached by pointer, not token. A pointer names the skill and its repo-relative path, like: the `agent-brief` skill (`config/skills/agent-brief.md`). The receiving agent reads the file from the current checkout when the branch fires; injecting it up front is the human's call.

## Descriptions

One human-facing line: what the skill does when injected. There is no model invocation to steer, so trigger lists ("use when the user says...") are dead weight here.

## Router skills

When skills multiply past what the human can remember, write a router: one skill that names the others and when to reach for each. It hints; the human injects.

<!-- adapted from: mattpocock/skills@885e2ca skills/productivity/writing-for-agents/SKILL-MECHANICS.md -->
