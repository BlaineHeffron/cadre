# Ported-skill upstream integration

The fleet's launch skills in `config/skills/` are ported from public skill repos and then adapted in house style. Each ported file keeps an `<!-- upstream: repo@sha path -->` comment; that is the provenance pointer, and the original work remains under its upstream license. This runbook keeps them in sync with their upstreams without losing the adaptations. It works the same by hand or under automation.

## Two tiers: scheduler fan-out and per-path agents

The `skills_upstream_watch` scheduled task (in `scheduled-agents-plugin.mjs`) is gated on an `ls-remote` HEAD snapshot, so it only fires when a watched upstream moved. When it fires the scheduler — not an LLM dispatcher — runs the detector, groups changed locals by `(repo, upstream_path)`, and fans out **one isolated worktree agent per group**, capped at `config.skillsUpstream.maxFanout` (default 3). Shared-path slices (the LaTeX skills, etc.) get one agent, not one per local file. Each child inherits the task provider/model (the github-watch default, currently xai/grok-4.6, unless `DM_SKILLS_UPSTREAM_PROVIDER` / `DM_SKILLS_UPSTREAM_MODEL` override). Running the steps below by hand collapses both tiers into one session, which is fine for a manual sync.

The watcher refuses the live deploy checkout (`dueno-fleet-live`). Set `DM_SKILLS_UPSTREAM_REPO_PATH` to a non-live clone, or configure a fleet/githubAgents repo path.

## The pin manifest

`config/skills/UPSTREAM.tsv` is the source of truth: one row per ported skill, tab-separated `local_skill  repo  upstream_path  pinned_sha  note`. The `pinned_sha` is the upstream commit the current fleet file was derived from. Fleet-native skills (`experiment`, `custody`, `client-update`, `bootstrap`, `visual-design-it-twice`) have no upstream and are not in the manifest; never touch them here.

Personal and share-alike skills live outside this repository. Their pins are kept in the private repository's `skills/UPSTREAM.tsv`, so this checker watches only files present in the public tree.

## The one rule

Diff upstream against its own past, never the fleet file against upstream. The fleet files diverge on purpose (tracker→`gh`, Skill-tool calls→repo-relative `config/skills/<id>.md` pointers, `{{skill:name}}` token inlining, dropped domain specifics, house frontmatter), so a fleet-vs-upstream diff is noise. What you want is `pinned_sha..HEAD` for the upstream path: the handful of lines the upstream actually changed. The detector does exactly this.

## Procedure

1. **Detect.** From the repo root:
   ```
   node scripts/skills-upstream-check.mjs --json --diff
   ```
   Read `.changed` and `.groups`. Each changed entry has `local`, `repo`, `upstream_path`/`path`, the pinned and HEAD shas, the commit list, and (with `--diff`) the upstream `diff` (pinned..HEAD for that path). `.groups` collapses locals that share one upstream file. If `.changed` is empty, stop: nothing to do, open no PR.

2. **Triage each changed group.** Read the upstream diff and classify its changes:
   - **Substantive** (new rule, corrected instruction, changed behavior, a new failure mode worth catching): fold in.
   - **Cosmetic or upstream-local** (their frontmatter, their plugin plumbing, formatting the house style already handles differently): skip.
   Decide whether each substantive change even applies given the fleet adaptation. A change to a section the fleet port deliberately dropped (e.g. the EIT defaults in the LaTeX skills) does not apply.

3. **Fold in, preserving the adaptations.** Edit every fleet `config/skills/<local>.md` in the group. Keep intact: the `description:` frontmatter, the leading `<!-- ... -->` license comment, repo-relative `config/skills/<id>.md` pointers to sibling fleet skills, `{{skill:name}}` tokens, embedded scripts, deliberately dropped content, and the trailing `<!-- upstream: ... -->` provenance comment. Apply only the substantive upstream delta, rewritten to match the surrounding house style.

4. **Re-pin.** Update the `pinned_sha` column for that group's row(s) in `config/skills/UPSTREAM.tsv` to the new HEAD sha (short form is fine), and update the sha in each file's provenance comment to match. Re-pin even for a change you judged cosmetic and skipped: the point of the sha is "we have looked at everything up to here."

5. **Verify.** Run the skill suites and the expansion check:
   ```
   npm test -- tests/launch-skills.test.mjs tests/skills-api.test.mjs tests/skills.test.mjs tests/ui-skill-writer.test.mjs
   ```
   Confirm every skill still discovers and every real `{{skill:name}}` token still resolves. To mention token syntax in prose, write `skill:name` without braces (angle-bracket placeholders are also safe because they are not valid skill ids). Re-run the detector; the skills you re-pinned should now report in sync.

6. **Open a PR.** Work in an isolated worktree, never the live checkout. Under automation each group opens one PR (`chore(skills): sync grilling with upstream`); by hand you may bundle a small set of groups if that reads more cleanly. In the body, list the upstream commits folded in and anything skipped with why. The fleet watcher auto-reviews. Do not merge to `main` yourself unless told to.

## When not to guess

If an upstream restructured a skill (renamed, split, rewrote its spine) so the delta cannot be folded mechanically, do not force it. Open the PR as a draft, re-pin nothing, and describe the divergence for a human to resolve. A wrong auto-merge into a skill is worse than a pending draft.
