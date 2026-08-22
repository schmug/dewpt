# Workstream B — a chance line for axis legibility: null result

**Date:** 2026-08-22 · **Tree:** 8e435c5 · **Cost:** 70 Workers AI requests (39 + 31)

Produced by `npm run axis-power`. Two runs: the first exposed a broken judge,
the second fixed it. Raw output of both, unedited.

**Verdict: no cheap client-side statistic separates a good user-named axis from
a bad one.** Ship `axis-lint.js` stage 2 empty. The LLM judge *does*
discriminate, so gating an axis is possible at the cost of an inference call —
that is a product decision, not a measurement one.

## What was asked

The axis-measurement doc's workstream B scores coherence against a
`1/sqrt(n-1)` chance line assuming 16 curated pairs per axis. A dewpt axis is
**one pair**, so that construction does not port. What ports is a **permutation
test**: build the chance line from K seeded random-pair null axes over the same
pool and read the real axis as a percentile against it.

Matrix: 2 seeds x 4 axes. `concrete<->abstract` (validated at AUC 0.980 on
hand-labelled words), `practical<->mystical` (1.000 there), `solemn<->playful`
(the known mush this workstream exists because of), and a **surface control** of
the form `X` / `more X`, unexpanded, pinning the lexical ceiling. 200 nulls
per pool, shared across axes so every axis meets the same chance line.

Ground truth is an LLM judge over pool candidates. The judge's labels also give
the nulls a free chance line: AUC of a *random* direction against the *real*
axis's labels is exactly "how well does a random direction predict this
ordering", at no extra inference.

## Run 2 (31 requests) — the result

Every cell balanced at 10+/10-; null p50 0.450-0.520, correctly on chance.

| seed | axis | judgeAUC | null p95 | beats? |
| --- | --- | --- | --- | --- |
| public transit | concrete -> abstract | 0.800 | 0.900 | no |
| public transit | practical -> mystical | 0.500 | 0.730 | no |
| public transit | solemn -> playful | 0.640 | 0.780 | no |
| public transit | SURFACE | 0.640 | 0.760 | no |
| home cooking | concrete -> abstract | 0.820 | 0.820 | no |
| home cooking | practical -> mystical | 0.900 | 0.790 | **yes** |
| home cooking | solemn -> playful | 0.420 | 0.910 | no |
| home cooking | SURFACE | 0.420 | 0.730 | no |

**1 of 8 clears its null p95.** At n = 10 v 10 the Mann-Whitney null has
sd ~= 0.135, so a p95 near 0.73 is expected; several cells sit higher still,
which the pool's own anisotropy (0.414) plausibly inflates. The chance line is
honest and most axes do not clear it.

### The killing evidence: the proxies reverse sign between runs

Same matrix, same statistic, two runs:

| statistic | run 1 r with judgeAUC | run 2 r with judgeAUC |
| --- | --- | --- |
| `poleCoherence` | **+0.314** | **-0.843** |
| `interPoleMargin` | **-0.828** | **+0.232** |
| `poleLean` (circular) | +0.898 | +0.315 |

`interPoleMargin` was the promising lead out of run 1 at -0.828, in the
predicted direction, near-monotone, with both surface controls at the bad end.
It came back **+0.232**. `poleCoherence` flipped the other way. Two candidate
statistics reversing sign across two runs of the same matrix is the signature of
noise, not of signal. **Both are rejected.**

`poleLean` is separately and permanently dead: its percentile is **1.000 in all
eight cells of both runs, including the surface control**. It distinguishes a
real axis from a random direction perfectly and says nothing about whether the
axis is any good.

### What does work: the judge itself

Mean judgeAUC per axis across the two seeds ranks them correctly, and matches
what was already known independently:

| axis | mean judgeAUC | prior |
| --- | --- | --- |
| concrete -> abstract | **0.810** | validated 0.980 on hand-labelled words |
| practical -> mystical | 0.700 | 1.000 on hand-labelled words |
| solemn -> playful | 0.530 | known mush |
| SURFACE (`X` / `more X`) | 0.530 | the lexical ceiling, by construction |

The known-mush axis lands exactly on the lexical ceiling. The validated axis
sits highest. So an LLM judge *can* gate an axis; nothing free can. Note the
drop from 0.980 hand-labelled to 0.810 on real pool candidates — a reminder that
an axis validated on curated word lists is not thereby validated on the pool it
will actually sort.

Caveat: 2 seeds per axis. The ordering is meaningful because it reproduces prior
knowledge, not because n is large.

### A second-order finding worth keeping

`practical<->mystical` scored 0.500 on `public transit` and 0.900 on
`home cooking`; `solemn<->playful` scored 0.640 and 0.420. **Axis quality
appears to be seed-dependent, not an intrinsic property of the axis.** If that
holds, "is this a good axis?" is not even the right question — the question is
"is this a good axis *over this pool*", which is what any in-app check would
have to answer, and which makes the problem harder rather than easier.

---

## Run 2 raw output (31 requests)

```
bands 6x24  judged 40  topK 8  nulls 200  model @cf/meta/llama-3.3-70b-instruct-fp8-fast
  concrete -> abstract
    low  "a tangible solid material substance"
    high "a complex theoretical concept"
  practical -> mystical
    low  "a useful everyday skill"
    high "an otherworldly spiritual experience"
  solemn -> playful
    low  "a formal solemn ceremony"
    high "a lighthearted playful activity"
  SURFACE playful -> more playful
    low  "playful"
    high "more playful"

══════════════════════════════════════════════════════════════════════════════
seed "public transit" — 141 unique candidates

  concrete -> abstract
    judgeAUC 0.800  (n=20: 10+/10-)   null p50 0.490  p95 0.900  → pctile 0.820
    poleCoherence  0.476  pctile 0.000
    interPoleMargin 0.836  pctile 0.000 (inverted)
    poleLean       0.158  pctile 1.000  [known circular]

  practical -> mystical
    judgeAUC 0.500  (n=20: 10+/10-)   null p50 0.500  p95 0.730  → pctile 0.490
    poleCoherence  0.531  pctile 0.265
    interPoleMargin 0.701  pctile 0.570 (inverted)
    poleLean       0.306  pctile 1.000  [known circular]

  solemn -> playful
    judgeAUC 0.640  (n=20: 10+/10-)   null p50 0.500  p95 0.780  → pctile 0.795
    poleCoherence  0.491  pctile 0.010
    interPoleMargin 0.757  pctile 0.115 (inverted)
    poleLean       0.188  pctile 1.000  [known circular]

  SURFACE playful -> more playful
    judgeAUC 0.640  (n=20: 10+/10-)   null p50 0.490  p95 0.760  → pctile 0.765
    poleCoherence  0.504  pctile 0.050
    interPoleMargin 0.779  pctile 0.035 (inverted)
    poleLean       0.076  pctile 1.000  [known circular]

══════════════════════════════════════════════════════════════════════════════
seed "home cooking" — 142 unique candidates

  concrete -> abstract
    judgeAUC 0.820  (n=20: 10+/10-)   null p50 0.480  p95 0.820  → pctile 0.950
    poleCoherence  0.486  pctile 0.030
    interPoleMargin 0.730  pctile 0.285 (inverted)
    poleLean       0.216  pctile 1.000  [known circular]

  practical -> mystical
    judgeAUC 0.900  (n=20: 10+/10-)   null p50 0.450  p95 0.790  → pctile 1.000
    poleCoherence  0.488  pctile 0.035
    interPoleMargin 0.760  pctile 0.100 (inverted)
    poleLean       0.274  pctile 1.000  [known circular]

  solemn -> playful
    judgeAUC 0.420  (n=20: 10+/10-)   null p50 0.520  p95 0.910  → pctile 0.435
    poleCoherence  0.512  pctile 0.185
    interPoleMargin 0.766  pctile 0.095 (inverted)
    poleLean       0.185  pctile 1.000  [known circular]

  SURFACE playful -> more playful
    judgeAUC 0.420  (n=20: 10+/10-)   null p50 0.480  p95 0.730  → pctile 0.290
    poleCoherence  0.518  pctile 0.215
    interPoleMargin 0.768  pctile 0.090 (inverted)
    poleLean       0.060  pctile 1.000  [known circular]

══════════════════════════════════════════════════════════════════════════════
DOES A CHEAP PROXY TRACK judgeAUC?  (n=8 cells)
  r(poleCoherence, judgeAUC) = -0.843
  r(interPoleMargin, judgeAUC) = 0.232
  r(poleLean (circular), judgeAUC) = 0.315

  cell summary (judgeAUC vs its own null chance line):
  seed            axis                             judgeAUC  nullp95  beats?
  public transit  concrete -> abstract              0.800   0.900   no
  public transit  practical -> mystical             0.500   0.730   no
  public transit  solemn -> playful                 0.640   0.780   no
  public transit  SURFACE playful -> more playful   0.640   0.760   no
  home cooking    concrete -> abstract              0.820   0.820   no
  home cooking    practical -> mystical             0.900   0.790   YES
  home cooking    solemn -> playful                 0.420   0.910   no
  home cooking    SURFACE playful -> more playful   0.420   0.730   no

requests spent: 31
```

## Run 1 raw output (39 requests) — the broken instrument

Kept because it is why run 2 is shaped as it is, and because its `poleCoherence`
and `interPoleMargin` correlations are half the sign-flip evidence above.

Two defects, both in the harness rather than the axes:

- **Free 0-10 rating, keeping >=7 / <=3.** Most pool candidates are genuinely
  neutral on any given axis, so label sets came out as lopsided as 1+/28- and
  one cell was 11+/0- (AUC undefined). An AUC of 1.000 computed from one
  positive is noise with a decimal point, and the tiny groups pushed every null
  p95 to 0.91-1.00, where nothing can be discriminated. Fixed by forced choice:
  "name the 10 furthest toward each end".
- **`slice(0, JUDGED)` sampled the first 40 of a 136-item pool.** `buildPool`
  appends band by band, so that was bands 1-2 only and the judge never saw a
  high-strangeness candidate. Fixed with a deterministic stride across all six.

```
bands 6x24  judged 40  topK 8  nulls 200  model @cf/meta/llama-3.3-70b-instruct-fp8-fast
  concrete -> abstract
    low  "a tangible solid material substance"
    high "a complex theoretical concept"
  practical -> mystical
    low  "a useful everyday skill"
    high "an otherworldly spiritual experience"
  solemn -> playful
    low  "a formal solemn ceremony"
    high "a lighthearted playful activity"
  SURFACE playful -> more playful
    low  "playful"
    high "more playful"

══════════════════════════════════════════════════════════════════════════════
seed "public transit" — 136 unique candidates

  concrete -> abstract
    judgeAUC 0.403  (n=27: 24+/3-)   null p50 0.458  p95 0.917  → pctile 0.385
    poleCoherence  0.534  pctile 0.545
    interPoleMargin 0.773  pctile 0.025 (inverted)
    poleLean       0.168  pctile 1.000  [known circular]

  practical -> mystical
    judgeAUC 1.000  (n=29: 1+/28-)   null p50 0.393  p95 1.000  → pctile 0.910
    poleCoherence  0.499  pctile 0.175
    interPoleMargin 0.732  pctile 0.370 (inverted)
    poleLean       0.285  pctile 1.000  [known circular]

  solemn -> playful
    judgeAUC   —    (n=11: 11+/0-)   null p50   —    p95   —    → pctile   —  
    poleCoherence  0.476  pctile 0.040
    interPoleMargin 0.799  pctile 0.000 (inverted)
    poleLean       0.191  pctile 1.000  [known circular]

  SURFACE playful -> more playful
    judgeAUC 0.143  (n=15: 1+/14-)   null p50 0.500  p95 1.000  → pctile 0.155
    poleCoherence  0.478  pctile 0.040
    interPoleMargin 0.795  pctile 0.005 (inverted)
    poleLean       0.064  pctile 1.000  [known circular]

══════════════════════════════════════════════════════════════════════════════
seed "home cooking" — 142 unique candidates

  concrete -> abstract
    judgeAUC 0.858  (n=39: 20+/19-)   null p50 0.529  p95 0.961  → pctile 0.825
    poleCoherence  0.481  pctile 0.015
    interPoleMargin 0.758  pctile 0.140 (inverted)
    poleLean       0.197  pctile 1.000  [known circular]

  practical -> mystical
    judgeAUC 0.788  (n=40: 14+/26-)   null p50 0.547  p95 0.964  → pctile 0.770
    poleCoherence  0.511  pctile 0.085
    interPoleMargin 0.702  pctile 0.495 (inverted)
    poleLean       0.289  pctile 1.000  [known circular]

  solemn -> playful
    judgeAUC 0.974  (n=16: 13+/3-)   null p50 0.487  p95 0.923  → pctile 0.980
    poleCoherence  0.515  pctile 0.115
    interPoleMargin 0.724  pctile 0.345 (inverted)
    poleLean       0.229  pctile 1.000  [known circular]

  SURFACE playful -> more playful
    judgeAUC 0.250  (n=18: 14+/4-)   null p50 0.518  p95 0.911  → pctile 0.245
    poleCoherence  0.474  pctile 0.010
    interPoleMargin 0.778  pctile 0.060 (inverted)
    poleLean       0.063  pctile 1.000  [known circular]

══════════════════════════════════════════════════════════════════════════════
DOES A CHEAP PROXY TRACK judgeAUC?  (n=8 cells)
  r(poleCoherence, judgeAUC) = 0.314
  r(interPoleMargin, judgeAUC) = -0.828
  r(poleLean (circular), judgeAUC) = 0.898

  cell summary (judgeAUC vs its own null chance line):
  seed            axis                             judgeAUC  nullp95  beats?
  public transit  concrete -> abstract              0.403   0.917   no
  public transit  practical -> mystical             1.000   1.000   no
  public transit  solemn -> playful                   —       —     no
  public transit  SURFACE playful -> more playful   0.143   1.000   no
  home cooking    concrete -> abstract              0.858   0.961   no
  home cooking    practical -> mystical             0.788   0.964   no
  home cooking    solemn -> playful                 0.974   0.923   YES
  home cooking    SURFACE playful -> more playful   0.250   0.911   no

requests spent: 39
```
