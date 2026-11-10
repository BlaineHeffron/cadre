---
description: Grade a slide deck against recent conference talks with three cross-provider graders, then revise and rescore until it beats them in every category.
---

# Talk Grading Loop

You run a closed loop that makes a talk at least as good as recent conference talks of similar length. Three graders from different providers score the talk and the reference talks blind, fresh revision sessions fix the gaps, and the loop repeats until the talk meets the bar in every category. The loop improves presentation only: readability, information throughput, figures, followability, structure, wordiness and how visibly claims are supported. It never adds or changes science.

## Roles

| Role | Model | Job |
|---|---|---|
| **Grading coordinator** (you) | Opus | Owns the rubric, the references, the bar, the revision rounds, the stop decision and the final report. |
| **Grading sub-coordinator** | Haiku 5.5 (`claude`, `claude-haiku-5-5`) | Each round: spawns the three graders, checks for their files about every 15 minutes, validates them, ends the graders, and sends you one report. |
| **Graders** (3 per round, fresh each round) | Gemini 4 Argon (`antigravity`, `gemini-4-argon-high`), Grok 4.7 (`xai`, `grok-4.7`), Opus 5.5 (`claude`, `claude-opus-5-5`) | Score every talk on the rubric, blind to each other. |
| **Revision pair** (fresh each round) | Two Opus sessions: implementer and reviewer | Apply the graders' findings without changing any number or claim. |

Check the model IDs against `monitor_list_agent_providers` and the model catalog before the first spawn; prefer Claude for any role whose provider is disabled.

## Contract you start from

The operator or parent coordinator gives you: the deck (source, build command, rendered PDF), its talk length, the sources of truth for its numbers, where the work ships (PR branch or local files), what must not change, and who you report to. If any of these is missing, ask the parent coordinator before calibrating.

## Hard rules

- **Make nothing up.** Every number, claim, figure and caption traces to an existing record or result. Wording, layout and replots of existing data only. No new simulations or analyses. If a grader asks for content that doesn't exist, record it as out of scope.
- **Don't drop caveats that matter.** If a word cut would remove one, move it to speaker notes only with the operator's approval.
- **Stage, then install.** Revisions happen in a worktree or a staging copy. Install the final version at the canonical paths only after the last check; back up the version you replace (or rely on git), and keep file names so existing links work. If someone else changed the canonical files during the run, ask before overwriting.
- **Privacy.** Reference talks are public. The talk under grading stays on this machine; never upload it to a web tool.
- **Decisions go to the operator's Command Queue,** one per item, with options and a recommended default, and keep working on what doesn't depend on it. If you lack `monitor_*` tools, DM the parent coordinator, who files them for you.
- **No merges, deploys or sends** without the operator's answer.

## Steps

1. **Freeze the rubric.** Copy the rubric below into the run folder, set the talk length, and record its sha256. Never change it after calibration starts.
2. **Pick the references.** Three public talks from conferences in the last two years, close in topic and length. If no talk of the same length is public, use the nearest length and say so in a queue item (the rubric is per slide, so length matters little). Save the PDFs, and record URL, conference, speaker and slot length in `calibration/sources.tsv`.
3. **Compute word count** for every talk with one script: visible words per slide, excluding speaker notes, title-only, references and backup pages (list the pages counted in `main-pages.tsv`). The bar is the median of the reference talks' median words per slide.
4. **Round 0: grade.** Spawn the grading sub-coordinator with the brief below. Give it the frozen rubric, the PDFs relabelled with letters (keep the letter key outside the graders' folders), the output paths and your session id. End your turn and wait for its report.
5. **Set the bar** as the per-category mean of the three references across the three graders. The talk passes a graded category when its mean is at or above the bar, and passes `word_count` when its median is at or below the reference median.
6. **Revise.** Spawn a fresh revision pair (implementer and reviewer) with: the merged grader findings, the categories below the bar, the hard rules, the build and render commands, and the staging location. The reviewer checks that every number, claim and caveat is unchanged and supported. Each round, compare with the previous round's scores; if a category drops, find what in the diff caused it before the next round.
7. **Rescore** with a fresh grader set (step 4, current talk only, same rubric) and repeat 6–7 until every category passes.
8. **Final check.** An independent reviewer compares the starting version with the final one for changed numbers, lost qualifiers and unsupported claims. Fix anything it finds (wording only), then install.
9. **Report** to the parent coordinator: the score table (round 0 and final against the bar), the final version (PR head or file sha256), the files, and what's left open. Write `report.md`, `scores.tsv` (all rows), `bar.tsv` and `rounds/rN/` in the run folder. End every session you spawned, or send their ids to the parent coordinator if you can't.

## Grading sub-coordinator brief (Haiku)

Spawn it with this brief, filled in:

> You run grading for round N of a talk-grading loop. You don't grade.
> 1. Spawn three graders (one per provider: antigravity `gemini-4-argon-high`, xai `grok-4.7`, claude `claude-opus-5-5`), each with the grader brief, the rubric path, the talk PDFs and its own output paths: `rounds/rN/scores-<grader>.tsv` and `rounds/rN/suggestions-<grader>.md`.
> 2. **Don't wait for grader messages.** The pi-backed graders (Gemini, Grok) often can't send them. Instead, start a background check that loops until all three score files exist and stop changing, sleeping about 15 minutes between checks, with a 2-hour limit; the harness wakes you when it exits. Don't poll in the foreground.
> 3. Validate each file: header `talk category score reason`, one row per talk × graded category, integer scores 1–10, a reason in every row. If a file is missing or invalid at the limit, re-spawn that one grader once.
> 4. End the three graders (`monitor_terminate_session`). If you can't, include their ids in your report.
> 5. Send the grading coordinator one DM: per-file status, row counts, the grader session ids and anything re-spawned. Then stop.

## Grader brief

> You are grading slide decks for a ~L-minute talk, labelled by letter. Read `rubric.md`. Look at each rendered PDF page, figures included. For each talk, write one row per graded category to your scores file (tab-separated: `talk category score reason`), then up to five concrete suggestions per talk in your suggestions file. Don't read other graders' files. Write the files and finish.

## Rubric

Score each category 1–10 for the talk as a whole, from the rendered PDF, for a talk of the stated length with a speaker. Anchors are for 2, 5 and 8; 10 is the best you have seen. Give one short reason per score.

1. **Readability** (`readability`): 2 = small or dense text, unreadable axes; 5 = mostly readable, some crowded slides; 8 = large type, short lines, every label readable.
2. **Information throughput** (`throughput`): 2 = filler, or more than an audience can absorb; 5 = useful but key results buried; 8 = each slide adds a distinct result at a followable pace.
3. **Figure quality** (`figures`): 2 = few, low-resolution or unlabelled figures; 5 = adequate with flaws (units, clutter, contrast); 8 = clean, labelled, one point per figure, consistent style.
4. **Followability for a physicist outside the subfield** (`followability`): 2 = jargon and assumed setup; 5 = main thread followable, several terms unexplained; 8 = motivation, setup and terms introduced briefly. **Hard rule, names not abbreviations:** slides use plain names, not abbreviations, internal project, design or study names, or symbols defined just for the talk. Field-standard abbreviations and symbols inside an equation the slide needs are allowed. List each violation with its slide. One or more caps this category at 5; three or more cap it at 3.
5. **Narrative and structure** (`narrative`): 2 = no storyline; 5 = recognisable structure, weak transitions; 8 = clear question up front, logical progression, summary that answers it.
6. **Slide density** (`density`): 2 = mostly text; 5 = mixed, many text-heavy slides; 8 = most slides carried by a figure, text limited to labels and takeaways.
7. **Claim–evidence clarity** (`claim_evidence`): 2 = claims without evidence or caveats; 5 = most supported, some numbers without source or uncertainty; 8 = each claim next to its evidence, with caveats where they apply.
8. **Word count** (`word_count`, computed by the coordinator, not graded): r = talk median words per slide divided by the reference median. r ≤ 1.00 scores 8; 1.25 scores 5; 1.75 or more scores 2; linear in between. Passes only at r ≤ 1.00.

## Lessons from earlier runs

- Graders on pi providers finish without reporting; a 3-hour stall happened when the coordinator waited for their DMs. Always check for files.
- Cutting words can cut context: one round's followability fell when explanations moved to speaker notes and the motivation moved after the method. Keep motivation first and keep one-phrase explanations on the slide.
- A deck built by a script shared with another deck can change that deck too. Build in a copy and add a guard that fails if the other deck's text or images change.
- Spawned sessions often lack `monitor_*` tools and can't end sessions they spawned; plan for the parent coordinator to file queue items and end sessions.
