# Marginalia pool-reuse spike (spec §2.E)

Confirmed by Cory 2026-09-26. Branch `marginalia-pool-reuse`, stacked on
`ground-results` (PR #113). Measurement:
`docs/measurements/2026-09-26-marginalia-pool-reuse-spike.md`.

## Problem
Marginalia seeds the margin from the paragraph under the cursor. For the margin
to never wait, the next paragraph's words must come from the pool already built
for this one, re-ranked. Unknown: does a reader place those re-ranked words
beside the NEW paragraph, or beside the one the pool was built for?

## Scope
In:
- `scripts/marginalia-spike.ts` (`npm run marginalia-spike`), with `--binding`,
  `--fake` and `--max-requests` (default 140). Plumbing comes from
  `scripts/ground-harness.ts`; helpers from `scripts/ground-judge.ts`.
- Pure parts in `scripts/marginalia-judge.ts`: bars, verdict, rotation
  scoring, the prompt, and seed truncation. Tests in
  `test/marginalia-judge.test.ts`.
- Design:
  - 5 hand-written essays × 5 paragraphs, committed.
  - One pool per essay, built from the seed.
  - The writer moves to paragraphs 2, 3 and 4 in turn. Each move is
    `drawRanked` with k=5, consuming, by `nearScore` toward that paragraph's
    bge-m3 embedding. That makes 15 trials.
- Judge:
  - It sees paragraphs k−1, k and k+1 plus the 5 words, and names the
    paragraph the words belong beside.
  - Each trial is asked in all 3 cyclic rotations. It is correct if paragraph
    k wins at least 2 of the 3.
  - Chance under a uniform judge is 7/27. A judge that only picks by position
    scores 0.
- A PENDING measurement doc, committed before any real run.

Out:
- UI, routes, and anything in `src/`.
- A fresh-pool ceiling arm (over budget).
- The paste-corpus question.
- Deploys.
- Spending requests. The real run is Cory's.

## Decisions (Cory, 2026-09-26)
- Essays: hand-written by Claude, on topics no earlier spike used. The bias
  (written knowing the test) is disclosed.
- Seed: paragraph 1 cut at the last sentence boundary within 200 characters
  (`MAX_SEED_CHARS`, src/index.ts:17), which is production parity.
- Jaccard: diagnostic only.
- Judge: llama-3.3-70b with rotation.

## Pre-registered bars (fixed before any real run)
- Correct: ≥ 8/15 trials. P(X ≥ 8 | n=15, p0=7/27) = 0.0215.
- INVALID if any display position gets ≥ 24 of the 45 judge calls
  (false-INVALID rate 0.0134).
- An unjudged rotation is a vote for nothing, so it counts toward a miss.
  Trials are never dropped from n.

## Budget
- 167 of 300 remain.
- Expected: 5 × (6 generation + 2 pool-embed + 1 paragraph-embed) + 45 judge
  = 90.
- Up to 135 if every judge call retries.
- Cap 140.

## Acceptance
1. `--fake` runs end to end with no Workers AI spend. It prints per-trial
   lines, RESULT, VERDICT and a request count.
2. The bars are in `scripts/marginalia-judge.ts`, with tests asserting both
   tails (4 dp) and that a position-only judge scores 0/15.
3. Every trial is asked in 3 rotations. A test shows the prompt carries no
   method words.
4. It uses the shipped path (`buildPool`, `drawRanked` consuming, `nearScore`),
   with no `src/` change.
5. Diagnostics printed:
   - how often the words were stuck on the previous paragraph;
   - top-10 Jaccard across targets;
   - pool depth after paragraph 4.
6. `npm run typecheck` and `npm test` are green, with counts. The PENDING doc
   and TASKS entry exist.
