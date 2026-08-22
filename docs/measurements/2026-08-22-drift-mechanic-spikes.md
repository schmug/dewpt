# drift mechanic — translation vs projection

**Date:** 2026-08-22 · **Tree:** ab4c519 · **Cost:** 84 Workers AI requests (63 + 21)

Two spikes run to settle the mechanic for the swipe-card companion
([#43](https://github.com/schmug/dewpt/issues/43)), specced as `drift` in
[docs/superpowers/specs/2026-08-22-drift-navigator-design.md](../superpowers/specs/2026-08-22-drift-navigator-design.md).

The question #43 left open was (a) two bidirectional axes — a navigator — versus
(b) four independent poles — a journey with a fail state. Rather than pick from
the armchair, run 1 measured whether the fail state (b) needs actually exists,
and run 2 measured whether the alternative mechanic works at all.

**Verdict: (a), implemented as projection.** Run 1 found no fail state on a real
axis and a seed abandoned at step 2. Run 2 found the seed retained at every
position, real turnover per swipe, and two named axes that are genuinely
independent.

Both scripts are committed so every number below is reproducible:
`npm run axis-walk` and `npm run axis-projection`. Raw output, unedited.

---

## Run 1 — `npm run axis-walk` (63 requests)

Walks the chain a swipe app would walk under a **translation** mechanic:
generate a fan-out toward one expanded pole, select the best-aligned candidate,
make it the new position, repeat. Same target every step, because that is what
"swipe left five times" means.

```
seed: "public transit"   steps: 15   fanout: 8   model: @cf/meta/llama-3.3-70b-instruct-fp8-fast

real axis: "solemn" -> "a somber formal ceremony" (expanded=true)
           "playful" -> "a lighthearted playful activity" (expanded=true)
null target (seeded random pair): "a salted kiln kept for the winter"

── REAL — push toward the expanded pole ────────────────────────
  step  arrival  tetherSeed  tetherPar  fanoutDiv  axisDisp  text
     1   0.565     0.524     0.524     0.468    0.116  travel bingo game
     2   0.573     0.438     0.424     0.474    0.051  yard twinkle lights
     3   0.639     0.498     0.607     0.495    0.137  nighttime bubble fun ←exhausted
     4   0.596     0.532     0.525     0.479    0.097  sidewalk chalk art
     5   0.584     0.444     0.423     0.487    0.056  bubble party games
     6   0.602     0.462     0.514     0.475    0.109  backyard scavenger hunt
     7   0.640     0.508     0.583     0.532    0.168  obstacle course fun ←exhausted
     8   0.645     0.468     0.612     0.545    0.131  backyard water games ←exhausted
     9   0.547     0.407     0.491     0.449    0.092  croquet mallet fun
    10   0.600     0.453     0.475     0.495    0.126  lawn twister game
    11   0.554     0.358     0.537     0.474    0.040  bouncy castle play
    12   0.570     0.414     0.494     0.501    0.011  lawn jenga party
    13   0.659     0.472     0.592     0.501    0.168  ring toss fun ←exhausted
    14   0.591     0.430     0.578     0.497    0.050  giant jenga play
    15   0.622     0.457     0.529     0.522    0.092  capture flag fun
  knee (first arrival >= 0.628): 3
  arrival   0.565 -> 0.622   (max 0.659)
  tetherSeed 0.524 -> 0.457
  fanoutDiv 0.468 -> 0.522

── NULL — push toward a seeded random phrase ───────────────────
  step  arrival  tetherSeed  tetherPar  fanoutDiv  axisDisp  text
     1   0.715     0.459     0.459     0.515    0.008  seasonal rail kiln ←exhausted
     2   0.817     0.412     0.776     0.578    -0.057  winter salt kiln ←exhausted
     3   0.782     0.389     0.780     0.563    -0.046  winterized kiln house ←exhausted
     4   0.814     0.354     0.626     0.561    -0.071  salted kiln storage ←exhausted
     5   0.677     0.383     0.558     0.665    -0.058  winter kiln dormant ←exhausted
     6   0.806     0.392     0.624     0.580    -0.065  cold kiln salting ←exhausted
     7   0.658     0.381     0.575     0.651    0.008  kiln winter keep ←exhausted
     8   0.693     0.348     0.521     0.630    -0.043  salted kiln cache ←exhausted
     9   0.806     0.367     0.713     0.698    -0.045  salted winter kiln barn ←exhausted
    10   0.905     0.359     0.829     0.831    -0.052  kiln salted for winter ←exhausted
    11   0.880     0.342     0.878     0.827    -0.054  kiln kept salted cold ←exhausted
    12   0.769     0.351     0.737     0.776    -0.074  kiln salted winter vault ←exhausted
    13   0.855     0.369     0.816     0.828    -0.062  salted kiln winter shed ←exhausted
    14   0.850     0.365     0.843     0.844    -0.081  kiln with winter salt coat ←exhausted
    15   0.790     0.368     0.770     0.741    -0.084  salted cold kiln shelter ←exhausted
  knee (first arrival >= 0.628): 1
  arrival   0.715 -> 0.790   (max 0.905)
  tetherSeed 0.459 -> 0.368
  fanoutDiv 0.515 -> 0.741

requests spent: 63
```

### What it decided

- **No knee on a real axis.** Arrival oscillated in a flat 0.55–0.66 band for
  all 15 steps; fan-out diversity rose only +0.054. The threshold crossings at
  steps 3, 7, 8 and 13 are noise brushing a line, not saturation. Mechanic (b)'s
  fail state would have had to be invented, and `src/board/types.ts` already
  holds the rule that an unmeasured threshold is a number someone made up.
- **The instrument works.** The null captured at step 1 and never released —
  arrival to 0.905, diversity to 0.844, output degenerating into paraphrases of
  its own target (`kiln salted for winter`, `kiln kept salted cold`). So the
  probe can detect capture; it did not find it on a real axis.
- **The seed is abandoned at step 2 and `TETHER_FLOOR` cannot see it.**
  `public transit` → `yard twinkle lights` → … → `lawn jenga party`, with
  `tetherSeed` sitting at 0.407–0.532 the whole way, above `TETHER_FLOOR = 0.4`.
  This is issue #52 ("admits 53% of non-sequiturs") observed live in a chain.
- **Movement is not along the named axis.** Mean `axisDisp` +0.096 real,
  −0.052 null, against a measured `bge-m3` anisotropy of 0.414 — the mean cosine
  between two *unrelated* phrases. Displacement alignment four times below the
  unrelated-phrase baseline is not movement along a direction.

The cause is structural: the probe reuses the board's shipped `scoreCandidates`,
which rebuilds `stationVec = phraseEmb − parentEmb` every step. That is
point-seeking, not axis-following — the **translation** mechanic that the axis
measurement doc's workstream D already recorded as the loser, here reproduced in
a generation loop rather than a retrieval one.

### Caveats

n=1 seed, n=1 real axis, one draw at temperature 0.9. A gate, not an estimate.
The null was also **narrower** than the real pole — "a salted kiln" has a dozen
restatements, "a lighthearted playful activity" has thousands — so part of the
real-versus-null gap is pole breadth rather than pole meaningfulness. A
broad-but-arbitrary null would separate those and was not run.

---

## Run 2 — `npm run axis-projection` (21 requests)

Probes the **projection** mechanic instead: generate a seed-conditioned pool
once over the DO's six bands, then re-rank it by position along the named axes.
Nothing is rewritten, so the seed cannot be abandoned. Only pool construction
costs inference; all analysis after that is pure maths.

```
bands: 6 x 24   topK: 5   sweep: 11   model: @cf/meta/llama-3.3-70b-instruct-fp8-fast
axis "solemn -> playful": "a formal solemn ceremony"  <->  "a lighthearted playful activity"  (expanded true/true)
axis "concrete -> abstract": "a tangible solid material substance"  <->  "a complex theoretical concept"  (expanded true/true)
null axis (seeded random pair): "a salted kiln kept for the winter"  <->  "a lukewarm ledger left facing north"

════════════════════════════════════════════════════════════════════════
seed "public transit"  —  141 unique candidates

  ── axis: solemn -> playful ──
  spread: sd(raw) 0.049  range -0.086..0.169   midShare 0.376  (0.20 even, >0.40 clumping)
  turnover: 45/141 distinct candidates surfaced across the sweep   mean overlap between adjacent stops 1.000/5
  pos 0.0  poleLean -0.051  tetherSeed 0.501   infrastructure as institution · subsidy as social contract · sustainable infrastructure · paths as social contracts · transportation as trust
  pos 0.5  poleLean +0.038  tetherSeed 0.548   route optimization · human scale · place making · route planners · subway car galleries
  pos 1.0  poleLean +0.143  tetherSeed 0.584   mobility as empathy · commuter psyche · bus stop insects · community engagement · park and ride

  ── axis: concrete -> abstract ──
  spread: sd(raw) 0.050  range -0.134..0.177   midShare 0.291  (0.20 even, >0.40 clumping)
  turnover: 38/141 distinct candidates surfaced across the sweep   mean overlap between adjacent stops 1.700/5
  pos 0.0  poleLean -0.102  tetherSeed 0.585   passenger as sensor · highway rest stop sculptures · station kiosks · accessibility · road median wildflowers
  pos 0.5  poleLean +0.018  tetherSeed 0.563   transit oriented development · crowd tracking · social cohesion · traffic circle mazes · monorail-supported orchards
  pos 1.0  poleLean +0.107  tetherSeed 0.509   route optimization myth · congestion pricing psychology · transfer penalty logic · route optimization · urban planning

  ── axis: NULL (random pair) ──
  spread: sd(raw) 0.044  range -0.101..0.134   midShare 0.390  (0.20 even, >0.40 clumping)
  turnover: 45/141 distinct candidates surfaced across the sweep   mean overlap between adjacent stops 1.000/5
  pos 0.0  poleLean -0.081  tetherSeed 0.545   subway tunnel art tours · bike share kiosks · shared experience · trip as ritual · road diet pilot projects
  pos 0.5  poleLean +0.015  tetherSeed 0.577   park and ride · bus stop insects · streetcar ghost ships · fare cards · parking garage greenwalls
  pos 1.0  poleLean +0.095  tetherSeed 0.592   invisibility of infrastructure · accessibility · traffic as symptom · metro line beehives · traffic management

  ── axis independence (Pearson r over the pool) ──
  r(solemn -> playful, concrete -> abstract) = -0.038
  r(solemn -> playful, NULL (random pair)) = -0.180
  r(concrete -> abstract, NULL (random pair)) = 0.181

════════════════════════════════════════════════════════════════════════
seed "home cooking"  —  143 unique candidates

  ── axis: solemn -> playful ──
  spread: sd(raw) 0.052  range -0.071..0.172   midShare 0.336  (0.20 even, >0.40 clumping)
  turnover: 51/143 distinct candidates surfaced across the sweep   mean overlap between adjacent stops 0.400/5
  pos 0.0  poleLean -0.053  tetherSeed 0.528   ritual · table as altar · heritage · dinner table ouroboros · gastronomic heritage
  pos 0.5  poleLean +0.046  tetherSeed 0.576   food cart automatons · domestic alchemy · togetherness · abundance · communal eating
  pos 1.0  poleLean +0.149  tetherSeed 0.499   creativity · comfort mythologies · experimentation · forgotten pantry taxidermy · leftover luggage carousel

  ── axis: concrete -> abstract ──
  spread: sd(raw) 0.048  range -0.219..0.073   midShare 0.448  (0.20 even, >0.40 clumping)
  turnover: 41/143 distinct candidates surfaced across the sweep   mean overlap between adjacent stops 1.400/5
  pos 0.0  poleLean -0.157  tetherSeed 0.531   sauce stain removal · silicone spatula · stand mixer · wooden spoon rest · wooden spoon
  pos 0.5  poleLean -0.064  tetherSeed 0.585   homemade pasta night · flavors of nostalgia · toaster oven · meat grinder wind chime · pastry bag harmonica
  pos 1.0  poleLean +0.040  tetherSeed 0.556   comfort mythologies · domestic alchemy · ancestral wisdom · experimentation · recipe puzzle box

  ── axis: NULL (random pair) ──
  spread: sd(raw) 0.061  range -0.199..0.095   midShare 0.329  (0.20 even, >0.40 clumping)
  turnover: 49/143 distinct candidates surfaced across the sweep   mean overlap between adjacent stops 0.600/5
  pos 0.0  poleLean -0.173  tetherSeed 0.642   cooking as therapy · kitchen as sanctuary · warmth of the oven · pepper mill · cast iron skillets
  pos 0.5  poleLean -0.049  tetherSeed 0.591   soup kettle foghorn · breakfast for dinner · food as ancestry · cutting board · food photography props
  pos 1.0  poleLean +0.058  tetherSeed 0.456   can opener · butcher block kaleidoscope · identity · leftover luggage carousel · togetherness

  ── axis independence (Pearson r over the pool) ──
  r(solemn -> playful, concrete -> abstract) = 0.107
  r(solemn -> playful, NULL (random pair)) = 0.140
  r(concrete -> abstract, NULL (random pair)) = 0.194

requests spent: 21
```

### What it decided

- **Seed retention — decisive.** `tetherSeed` 0.456–0.642 at every position on
  both seeds, and every card at every position is still visibly about the seed.
  Against run 1's identical-looking 0.407–0.532 while semantically gone, this is
  the head-to-head that picks the mechanic.
- **Turnover — the gesture does real work.** A sweep surfaced 38–51 of ~141
  candidates (27–36% of the pool); adjacent stops shared only 0.4–1.7 of 5
  cards. Read carefully: the sweep steps 10% of the axis, so the finding is "a
  10% step replaces 3–5 of 5", which is the source of the specced step size.
- **Axis independence — green light for 2D.** `r(solemn→playful,
  concrete→abstract)` = −0.038 and +0.107 across the two seeds. Two named axes
  are essentially uncorrelated, so a two-axis swipe grid does not silently
  collapse to one dimension.
- **Clumping.** `midShare` 0.291–0.448 against the design doc's ">0.40 is
  clumping" bar. The axis middle is a dense pile of near-ties, the ends are
  thin. For a one-card surface this inverts into an asset — see the spec.

### `poleLean` is circular — do not reuse it

`poleLean` measures `cos(cand, pos) − cos(cand, neg)` over candidates *sorted by
projection onto (pos − neg)*. It cannot separate a real axis from a null, and it
did not: swings of ≈0.20 for the real axes against 0.176–0.231 for the null,
which scored **highest** of the three on `home cooking`. Same trap the
latent-space design doc flagged on `DISTRACTORS`.

Reading the texts does separate them cleanly — `sauce stain removal · silicone
spatula · stand mixer` at the concrete pole against `comfort mythologies ·
domestic alchemy · ancestral wisdom` at the abstract one, versus a null that is
noise at both ends. But that is an eyeball, not a metric. **There is currently
no non-circular numeric legibility control**, which is what workstream B of the
axis-measurement doc exists to supply.

### The weak-axis gap

`solemn→playful` passed every check available and still produced `community
engagement · park and ride` at its playful pole. It is 4 tokens against 4, both
in everyday register, no shared token — so the specced probe lint would not have
caught it, and neither `sd` (0.044–0.061) nor `midShare` separates it from the
null. Weak axes are an open problem; the lint catches lexical and register
fakes only.
