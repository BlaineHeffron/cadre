---
description: Design the run and record the run, so a result is reproducible and falsifiable.
---

# Experiment

Design and record experimental runs so a result can be trusted and reproduced, whether the apparatus is physical hardware, a measurement script, or a simulation. The discipline is preregistration plus a run log: decide what would count as an answer before you run, and record what actually happened after.

## Before the run: design

Write these down before changing hardware or a measurement script:

- **Question**: the one thing this run is meant to answer, in a sentence.
- **Variables**: independent (what you set), dependent (what you measure), and held-fixed (controls).
- **Falsifier**: what result would kill the claim you expect. If no result could, the run is not testing anything; sharpen the question.
- **Stop condition**: when to quit, decided in advance (N runs, a convergence threshold, a time box). This is what keeps a null result from turning into fishing.

Prefer changing one variable at a time. When you must vary several, say how you will separate their effects before you run, not after.

## After the run: record

Record these the moment the run finishes, while the state is still recoverable:

- **Setup**: what actually ran (commit hash, config, hardware settings, seed), not what was planned. If they differ, note the difference.
- **Raw data path**: where the untouched output lives. Never overwrite raw data with processed data.
- **One artifact**: the path to the one plot or table that shows the result. It must exist now (the `verify` fleet skill applies: `ls` it, don't claim it).
- **Result**: the answer to the question, in one sentence, with its uncertainty.
- **Open**: what you still do not know, including anything that went wrong or looked off.

## Discipline

One run, one record. Do not invent a full methods paper around a single run, and do not let a run go unrecorded because it "didn't work": a failed or null run is data, and its record is what stops you repeating it. Distinguish a preregistered (confirmatory) run from an exploratory one in the record, and do not relabel exploratory results as if you predicted them.

For units and order-of-magnitude sanity on every measured quantity, the configured `units` fleet skill. When a run becomes a written claim, the `paper` fleet skill (config/skills/paper.md) carries claim-cite-falsify.

<!-- fleet-native: reproducibility + preregistration discipline (no single upstream) -->
