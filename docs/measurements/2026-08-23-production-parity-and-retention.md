# Production parity, seed retention, and workstream B's third run

**Date:** 2026-08-23 · **Tree:** e7f7ae7 · **Cost:** 68 Workers AI requests (37 + 31)

Supersedes the harness configuration used in
[2026-08-22-drift-mechanic-spikes.md](2026-08-22-drift-mechanic-spikes.md) and
[2026-08-22-workstream-b-null-result.md](2026-08-22-workstream-b-null-result.md).
Their conclusions survive; the population they were measured over did not match
production, and that is fixed here. Reproduce with `npm run axis-projection`
and `npm run axis-power`.

## Why a rerun was needed

Critic cycle 2 found both harnesses measuring a pool the app never generates:

| | harness before | production |
| --- | --- | --- |
| strangeness | 0.2 / 0.5 / 0.85 | `TIER_STRANGENESS` **0.15** / 0.5 / 0.85 |
| altitude | 0.25 / 0.75 | `ALT_ABSTRACTION` **0.2 / 0.8** |
| dedupe | exact text | embedding cosine > `DEDUPE_COSINE` **0.92** |

Both now import the shipped constants and apply PoolCore's dedupe.

## Correction to an earlier claim

The mechanic-spikes entry says `tetherSeed` held "at every position". It did
not measure that. It sampled **three stops of two separate 1D sweeps**. The
claim was broader than the evidence, and the measurement below is what it should
have said.

## Seed retention over the shipped 2D loop (37 requests)

The projection harness now imports `public/drift/position.js` and drives the
real loop — 2D position, unseen-first, reach-bounded — for 400 swipes per seed,
recording the tether of **every card actually surfaced**.

```
seed "public transit"  139 cards / 400 swipes
  tetherSeed  min 0.398  p05 0.445  p50 0.550  p95 0.697  max 0.788
  weakest: "stranger intimacy dynamics" 0.398 · "hyperlocal sensemaking" 0.416
           · "funicular beekeepers" 0.421

seed "home cooking"    138 cards / 400 swipes
  tetherSeed  min 0.377  p05 0.427  p50 0.543  p95 0.699  max 0.722
  weakest: "larder time capsules" 0.377 · "can opener" 0.392
           · "commensality as resistance" 0.399

ACROSS BOTH  277 cards surfaced, 523 edge hits
  min 0.377  p01 0.398  p05 0.436  p50 0.545  max 0.788
```

**RETRACTED (2026-08-23, ee3486c / #90; recorded here for #104).** This entry
originally said `SEED_TETHER_MIN = 0.414` came from here, as "the measured
`bge-m3` anisotropy", and that it made retention an invariant. Neither holds:

- Nothing in this repository computes 0.414. It comes from an external run
  described in a design document, so it was never measured here.
- The walk spike's own counterexamples (`yard twinkle lights` 0.438, `lawn
  jenga party` 0.414, both off-seed) sit at or above it, so it cannot separate
  on-seed from off-seed cards.

The constant was removed. **Drift enforces no seed-survival criterion.** The
numbers above are a property of the pool (every candidate is seed-generated),
not an invariant the ranker enforces. Because the shipped `nextCard` no longer
filters on tether, the harness that imports it again drives the same
unfiltered loop this table describes (`npm run axis-projection`; a rerun needs
live Workers AI and was not repeated for #104).
Enforcement would need a non-circular relevance instrument and a labelled set;
workstream B found no cheap one (below), and #104 records that trade.

Note the 523 edge hits against 277 cards: with `MAX_REACH = 3 x STEP` most of
a 400-swipe random walk lands somewhere empty. That is the edge working, but it
also says the reach bound is doing a lot of work and deserves its own tuning
pass against real use.

## Workstream B, third run (31 requests)

```
                     judgeAUC   null p95   beats?
transit  concrete->abstract      0.740      0.910    no
transit  practical->mystical     0.730      0.830    no
transit  solemn->playful         0.560      0.860    no
transit  SURFACE                 0.770      0.850    no
cooking  concrete->abstract      0.970      0.990    no
cooking  practical->mystical     0.950      0.890    YES
cooking  solemn->playful         0.400      0.820    no
cooking  SURFACE                 0.540      0.870    no
```

**The null result stands, now on three runs rather than two.**

| statistic | run 1 | run 2 | run 3 (parity) |
| --- | --- | --- | --- |
| `poleCoherence` | +0.314 | −0.843 | **+0.194** |
| `interPoleMargin` | −0.828 | +0.232 | **−0.816** |
| `poleLean` (circular) | +0.898 | +0.315 | +0.316 |

`poleCoherence` has now taken three different values including both signs:
noise, conclusively. `interPoleMargin` agrees with itself on two of three runs
and reversed on the other — better, and still not something to gate an axis on.
Two of three is not a measurement.

One thing worth flagging against the judge itself: the `X` / `more X` surface
control scored **0.770 on public transit**, above `solemn->playful`'s 0.560.
The lexical ceiling outscoring a real axis is a sign the judge is noisy at
10v10, not that the control is a good axis. The ordering only reproduces prior
knowledge when averaged across seeds, and n = 2 seeds is thin.
