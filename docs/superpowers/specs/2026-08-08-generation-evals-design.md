# Generation evals — design

**Date:** 2026-08-08
**Status:** approved, not yet implemented

## Problem

dewpt's generation quality is currently assessed by eyeball. `npm run calibrate`
prints three labelled batches and asks a human to squint at them, which
[CLAUDE.md](../../../CLAUDE.md) already rules out as a standard: *"Measurement
scripts should print a **number** (AUC, distribution stats), not just samples to
squint at. That is what makes a result arguable."*

The cost of that gap was paid in full during the 2026-08-08 local-inference
session. Five separate ad-hoc measurement passes were written, run, acted on,
and thrown away:

1. a three-model bake-off (`qwen2.5-coder:7b`, `qwen3.5:4b`, `qwen3:4b`)
2. Maple across three bands, three sampling variants, and two token budgets
3. a temperature sweep on `qwen3.5:4b`
4. a band test on `qwen3.5:0.8b`
5. a three-repeat temperature sweep on `qwen3.5:0.8b`

Each produced a number that changed a decision. None is reproducible today.

Two further facts make the case. The suite is largely pre-built and merely
unorganised: [scripts/axis-lib.ts](../../../scripts/axis-lib.ts) already exports
`auc()`, `cohensD()`, vector math, ground-truth word sets, and distractors.
And [scripts/axis-spike.ts](../../../scripts/axis-spike.ts) records its headline
result — `pair 0.843 > single 0.763` — in a source comment rather than in a
re-runnable harness, so nobody can tell whether it still holds.

## Goals

- Catch a regression when someone edits the load-bearing few-shot examples in
  [src/generation.ts](../../../src/generation.ts).
- Reproduce the model bake-off as a command instead of a hand-written script.
- Print numbers that make a claim arguable.

## Non-goals

- Replacing `calibrate`. It stays. Numbers alone invite optimising for the
  metric; the eyeball samples are the guard against aesthetic flattening.
- Running in CI. See "CI limitation" below.
- Judging whether a specific word is *good*. Only whether it lands in the band
  it was generated for.

## Architecture

### Files

```
scripts/eval-lib.ts          cells, metrics, aggregation — pure, no I/O
scripts/eval.ts              gate: small cell set, baseline compare, exit code
scripts/eval-matrix.ts       sweep: model × metric table, refreshes baseline
scripts/eval-baseline.json   committed; per-metric mean + spread + provenance
src/ai-runner.ts             + restAiRunner, extracted from calibrate.ts
```

`eval-lib.ts` holds pure functions over already-fetched words and vectors. This
mirrors the `pool-core` / `session-do` split that CLAUDE.md mandates: the
testable logic stays out of the layer that does I/O.

The pure vector math and ranking metrics (`dot`, `norm`, `sub`, `mean`,
`cosine`, `auc`, `cohensD`) move *out* of `axis-lib.ts` into `eval-lib.ts`, and
`axis-lib.ts` re-exports them so the existing spike scripts keep working
unchanged. They finally acquire direct tests.

The direction of that move is forced, not stylistic. `tsconfig.json` sets
`"types": []` and includes `test/**/*.ts`, so a test importing `eval-lib.ts`
drags its entire import graph into a typecheck with no node globals — and
`axis-lib.ts` calls `process.env` in `requireCreds()`. Hence the hard rule
below.

**`eval-lib.ts` must not import node APIs or anything that does.** No
`process`, no `node:fs`, no `node:os`. All I/O — reading the baseline, reading
argv, resolving the machine name — lives in `eval.ts` and `eval-matrix.ts`,
which are covered only by `tsconfig.scripts.json` and are never imported by
tests.

### Cells

A **cell** is `(seed, tier, alt)`. Tiers and alts come from the product's own
bucket structure — 3 tiers × 2 alts = the 6 buckets in
[src/types.ts](../../../src/types.ts).

| run | seeds | k per cell | cells |
| --- | --- | --- | --- |
| gate | 3 | 5 | 18 |
| sweep | 8 | 10 | 48 |

### Held-out seeds (load-bearing)

Eval seeds MUST NOT appear in `generation.ts`. `"urban gardening"` and
`"security awareness people actually enjoy"` are few-shot examples inside the
prompt; scoring against them measures recall of the prompt rather than
generalisation, and would report excellent band separation for a model that had
merely copied its examples back. The eval seed list is separate and disjoint.

### Backends

Runner selection is a flag. Local Ollama is the default (free, no credentials);
`--workers-ai` selects the REST runner, which is production's actual path.

This is where `restAiRunner` moves into `src/ai-runner.ts` alongside
`localAiRunner`, letting `calibrate.ts` and `axis-lib.ts` drop their private
copies of the same code.

### Commands

```
npm run eval                            gate; 90 calls, ~3-6 min local; exit 1 on regression
npm run eval:matrix -- --models=a,b,c   comparison table
npm run eval:baseline                   re-record the baseline
```

### CI limitation

The gate cannot run in CI: CI has no Ollama and no GPU, and the Workers AI path
needs credentials plus real spend. It is a local pre-PR command and must be
documented in CLAUDE.md's Gates section *with that limitation stated*. Claiming
an unrunnable gate is enforced is exactly the failure mode the global rule about
proving gate claims empirically exists to prevent.

## Metrics

Every metric declares its direction so the baseline comparator cannot get the
sign wrong.

### 1. Yield — code grader

Per call, `parsed ÷ requested`. Aggregated per cell into two numbers, because
they answer different questions:

- **mean yield** — how fast buckets fill. Higher better.
- **zero-rate** — fraction of calls returning nothing. A zero batch is a dead
  pump cycle. Lower better.

### 2. Dewpoint separation — code grader + embeddings

Score each word by `1 - cosine(seed, word)` — exactly the `seedDist` computed at
[pool-core.ts:191](../../../src/pool-core.ts). AUC with tier-2 words as
positives, tier-0 as negatives. 1.0 = every far word outranks every near word;
0.5 = the dewpoint slider does nothing. Higher better.

Tier 1 is excluded from the AUC as the ambiguous middle, but its mean `seedDist`
is printed alongside so monotonic ordering across all three tiers is visible.

### 3. Altitude separation — code grader + embeddings

The axis is built the way production builds it: `expandPole("concrete")`,
`expandPole("abstract")`, axis = `pos − neg`, score = `cosine(word, axis)`. AUC
of alt-1 words against alt-0. Higher better.

Using the production construction makes this a regression test on `axis-core`
and on pole expansion as well as on generation. The relevant prior numbers:
`axis-spike` measured pair-construction at 0.843, and `types.ts` records
expanded poles at 0.980 AUC against 0.640 for bare terms.

### 4. Throughput — code grader

Accepted candidates ÷ elapsed seconds across a cell's k calls, reported as
headroom against the requirement.

**The requirement is 1.43 candidates/sec.**
[public/field.js:160](../../../public/field.js) sets the spawn interval to
`2400 - drizzle × 19` ms plus up to 400 ms of jitter, spawning one word per
tick. At drizzle 100 that is a mean interval of ~700 ms, so the field consumes
at most ~1.43 words/sec. Sustained throughput below that means the field
visibly waits, which CLAUDE.md classifies as a correctness failure rather than a
performance one.

Measured on 2026-08-08 for scale: `qwen3.5:4b` produced 23/24 in 1.6 s ≈ 14
candidates/sec, roughly 10× headroom. Maple's best *possible* result of 24/24 in
50 s would be 0.48/sec — failing by 3× even if every word had parsed.

Wall-clock, therefore machine-dependent; the machine is recorded in baseline
provenance.

### 5. Near-duplicate rate — code grader + embeddings

Within a batch, the fraction of words whose cosine to any earlier word exceeds
`DEDUPE_COSINE`, imported from `types.ts` rather than restated. This is the
fraction the pool would discard. Lower better.

Within-batch only. The real pool also compares against existing pool entries and
anchors, but that is session state, not model quality.

### 6. Register judge — model grader, sweep only

Two phases:

- **Calibration.** The judge classifies the 72 few-shot words in
  `generation.ts` (2 seeds × 3 bands × 2 altitudes × 6 items) by band and
  altitude, and reports accuracy against their known labels.
- **Verdict.** The judge classifies fresh generated words the same way,
  reporting agreement with the band each was generated at.

The judge is always a different model from the generator. **If band-calibration
accuracy falls below 0.80, verdicts print but do not gate** — a judge that
cannot reproduce dewpt's own taste labels has not earned the right to fail a
build. 0.80 is a starting value chosen to sit well clear of the 0.33 chance rate
on a 3-way band classification; it should be re-set from the first calibration
run rather than treated as measured.

## Baseline and comparison

`eval-baseline.json` stores, per metric, `mean`, `stddev`, `n`, plus provenance:
`model`, `backend`, `date`, `commit`, `machine`.

The gate fails when a metric moves more than **2 standard deviations** in its
bad direction. Deltas print on every run, pass or fail.

Two guards, both cheap to omit and expensive to have omitted:

- **Per-metric direction.** Zero-rate and near-duplicate rate are
  lower-is-better; the rest are higher-is-better. A single shared comparator
  would silently never fire on the inverted ones.
- **Provenance staleness.** If the gate's model or backend differs from what the
  baseline recorded, the gate refuses to compare and drops to report-only,
  rather than reporting a "regression" that is only a model switch.

## Error handling

**A failed call is not a score of zero.** During the Maple investigation one run
threw on a missing model and another returned 0 parsed words; those mean
opposite things, and averaging a thrown call in as 0.0 would report a broken
endpoint as a bad model.

- Failed HTTP calls abort the run, reporting endpoint and status.
- Zero-word results are recorded as real data.
- Embedding failures abort — AUC without vectors is meaningless.
- A cell that cannot complete k calls fails loudly rather than quietly
  reporting a smaller n.

## Testing

`eval-lib.ts` is pure, so vitest covers it with no network, consistent with the
existing suite's no-network/no-Workers-runtime constraint:

- AUC against synthetic scores with known answers
- yield and zero-rate aggregation
- near-duplicate counting over hand-built vectors
- the baseline comparator — including **both** inverted-direction metrics and
  the staleness guard

The comparator is where a sign bug would hide while the suite reported green
forever, so it is written first, test-first.

## Provenance of numbers cited

| number | source |
| --- | --- |
| 1.43 candidates/sec requirement | derived from `public/field.js:160` |
| 14 candidates/sec (`qwen3.5:4b`) | measured 2026-08-08, local Ollama |
| 0.48 candidates/sec (Maple, best case) | measured 2026-08-08, mlx_lm.server |
| 0.843 / 0.763 axis AUC | `scripts/axis-spike.ts` header, 2026-07-20 |
| 0.980 / 0.640 pole AUC | `src/types.ts` `AxisPole` docs |
| `DEDUPE_COSINE` 0.92 | `src/types.ts` |

## Future work (explicitly out of scope)

- A size-aware temperature ceiling in `bandTemperature`. The 2026-08-08 sweeps
  showed small models emit malformed JSON at the high band's 1.11 temperature
  (`qwen3.5:0.8b`: 0/24 at default, 10–17/24 capped at 0.7). This eval suite
  would *measure* that fix; it does not implement it.
- Running the gate against Workers AI on a schedule to catch provider drift.
