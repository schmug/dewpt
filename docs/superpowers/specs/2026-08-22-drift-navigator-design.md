# drift: a swipe-card navigator over dewpt's latent space

**Date:** 2026-08-22
**Status:** implemented and live at https://dewpt.cory7593.workers.dev/drift/ (2026-08-23). Independent-critic loop stopped at cycle 3 of 12 without meeting the ship bar — see [critic-reports/README.md](../../../critic-reports/README.md) for the trajectory and why, and #104-#110 for the open findings.
**Scope:** A fourth surface at `/drift/` — a mobile-first card stack where each
swipe moves your position along a user-named semantic axis and the card is a
re-ranked candidate from the session pool. Implements
[#43](https://github.com/schmug/dewpt/issues/43). Companion to
[SPEC.md](../../../SPEC.md), which it extends rather than replaces. Map mode
([#29](https://github.com/schmug/dewpt/issues/29)) is a different surface and is
out of scope here.

## Problem

dewpt's engine has never been exercised by a second consumer that uses the
**axis** machinery. `/board/` reuses generation and pole expansion but navigates
by station, not by position. `src/axis-core.ts` and `public/axes.js` have shipped
since workstream C with an explicit comment that nothing renders them —
*"No rendering — workstream A owns pixels."* Position is computed, served on the
wire as `Served.coords`, and thrown away by every client.

Meanwhile [SPEC.md](../../../SPEC.md) makes mobile-first an explicit non-goal
("desktop pointer interaction is the core"). A thumb-driven surface covers that
ground without forcing dewpt to.

`drift` is the smallest thing that consumes the axis machinery end to end and
answers a question no spike can: **is steering an idea stream with your thumb
actually good?**

## Evidence: two spikes

Raw output, request cost and caveats in
[docs/measurements/2026-08-22-drift-mechanic-spikes.md](../../measurements/2026-08-22-drift-mechanic-spikes.md).
84 Workers AI requests total. Reproduce with `npm run axis-walk` and
`npm run axis-projection`.

#43 left the mechanic open between **(a)** two bidirectional axes — a navigator
— and **(b)** four independent poles accumulating drift, a journey with a fail
state. Both spikes exist to settle that from measurement rather than taste.

**Run 1 killed (b), and killed translation with it.** Walking a chain the way a
swipe app would under a rewrite mechanic:

| | real axis | random-pair null |
| --- | --- | --- |
| arrival, first → last (max) | 0.565 → 0.622 (0.659) | 0.715 → 0.790 (0.905) |
| fan-out diversity, Δ over 15 steps | **+0.054** | **+0.329** |
| knee (arrival ≥ `ARRIVAL_COSINE`) | crossed at 3, 7, 8, 13 — fell back each time | step **1**, never released |
| mean `axisDisp` | **+0.096** | −0.052 |

Three consequences:

- **There is no fail state to discover.** Arrival oscillates flat for 15 steps.
  (b)'s meters would have to be invented, and `src/board/types.ts` already holds
  the rule that an unmeasured threshold is a number someone made up.
- **The seed is abandoned at step 2** — `public transit` → `yard twinkle
  lights` → … → `lawn jenga party` — while `tetherSeed` sat at 0.407–0.532,
  above `TETHER_FLOOR = 0.4` the entire time. Issue
  [#52](https://github.com/schmug/dewpt/issues/52) observed live in a chain.
- **Nothing moves along the named axis.** `axisDisp` +0.096 against a measured
  `bge-m3` anisotropy of **0.414**, the mean cosine between two *unrelated*
  phrases. Four times below the unrelated-phrase baseline is not a direction.

The null captured at step 1 and paraphrased its own target forever, which proves
the instrument could have detected capture had there been any.

**Run 2 validated projection.** Generate a seed-conditioned pool once over the
six bands, then re-rank it by position. Nothing is rewritten, so the seed cannot
be abandoned:

- **Retention:** `tetherSeed` 0.456–0.642 at every position on both seeds, and
  every card visibly still about the seed. This is the head-to-head that picks
  the mechanic.
- **Turnover:** a sweep surfaces 38–51 of ~141 candidates; adjacent stops share
  0.4–1.7 of 5. The sweep steps 10% of the axis, so the finding is *a 10% step
  replaces 3–5 of 5* — the source of the step size below.
- **Independence:** `r(solemn→playful, concrete→abstract)` = −0.038 and +0.107.
  Two named axes are uncorrelated, so a 2D swipe grid is genuinely 2D.
- **Clumping:** `midShare` 0.291–0.448 against the ">0.40 is clumping" bar.

## The mechanic

**One card. Swipe moves, tap keeps.**

```
 ┌─────────────────────────────┐
 │  solemn ──●───────  playful │   your position, in the user's
 │  concrete ─────●──  abstract │   own pole terms
 │                      ⬤ 7    │   condensate count — tap to expand
 │      domestic alchemy       │   the card, coloured by tier
 │      ·  ·  ●                │   strangeness cue
 │        ← swipe to move →    │
 └─────────────────────────────┘
```

Left/right is ∓/± on axis A, up/down on axis B. Position is a reversible 2D
point. Tap pins to the condensate — no gesture conflict, both thumb-reachable.

**The card carries a strangeness cue, from data already on the wire.** `Served`
ships `tier`, so the card takes the demo's colour language —
`--t0` pale slate → `--t1` lilac → `--t2` warm ember, pinned `--pin` gold —
which [SPEC.md](../../../SPEC.md) holds as a guardrail. No extra chrome, no
extra request.

**Condensate is a count, not a tray.** A 44 pt chip in one corner shows how many
you have pinned; tapping expands the full list over the card, tapping out
dismisses. `drift` is standalone-usable without permanently spending screen the
card wants. The dismiss gesture must not read as a swipe — that is the one real
hazard in this choice and it belongs in the client guards.

**One card, not a stack, because clumping inverts.** `midShare` 0.29–0.45 means
the axis middle is a dense pile of near-ties. Showing five means picking five
arbitrary members of that pile. Showing one means you need *a* good candidate,
and near-ties become harmless — a dense middle is a deep well rather than an
illegible heap. This is the opposite of what density does to map mode, and it is
the second problem the card format dodges that the map cannot (see *Decisions*).

**A swipe steps 0.1 in normalized axis space.** Not a guess: run 2 measured that
a 10% step replaces 3–5 of 5 nearest candidates, so it is the smallest step
already shown to change the neighbourhood. Ten swipes crosses an axis.

**Tie-break is unseen-first, then freshest.** Nothing repeats in a session.

**The edge is a wall you can feel, not a game over.** Position clamps to [0,1].
The tails are thin; out there cards arrive sparse and eventually nothing
tethered to the seed remains. That is the stakes #43 wanted, discovered rather
than invented.

**Exactly two axes**, so four directions is the whole gesture vocabulary.
`MAX_AXES` is unchanged; this surface uses two of them.

## Decisions

1. **A surface in dewpt, not a new repo.** #43's stated purpose is to test
   whether the engine is renderer-agnostic; a fork with copied code passes that
   test by construction and therefore tests nothing. The cheapest version below
   cannot exist elsewhere at all, since it consumes dewpt's own API.
2. **Projection, not translation.** Run 1's verdict, and the same answer the
   axis-measurement doc's workstream D reached by a different route.
3. **Mechanic (a), a navigator.** Run 1 found no fail state for (b) to be built
   around.
4. **Client-only for the first cut.** No new Durable Object, no `src/` change,
   no `wrangler.jsonc` change. Ship the gesture, learn whether it is good, and
   only then pay for a DO.
5. **Workstreams A and B both ship; C does not.** The lint (A) is pure string
   maths and addresses a failure run 2 actually found. Workstream **B lands
   first, ahead of the surface** — see *Workstream B* below for why that is a
   research task rather than an implementation one. Workstream C's
   neighbourhood-retention finding (0.8% at 2D, 1.7% at 3D) is *devastating for
   map mode and nearly irrelevant here* — a card stack presents no adjacency, so
   it never implies two things are related by being near each other.

**The bucket friction #43 predicted does not exist.** The issue warns that
`BUCKET_KEYS` (tier × alt) "probably needs regeneralizing for axis-position
buckets." Run 2 built its pool by sweeping all six bands and **flattening them
into one set**, then projecting. Buckets never became a retrieval index — they
are how you get a semantically spread pool to project. Projection is the
retrieval layer over a flat set. `BUCKET_KEYS` stays as it is.

## What carries over from dewpt, and what does not

**Carries over unchanged:** `POST /api/session`; `GET /api/session/:id/pool`;
`GET|POST /api/session/:id/axes`; `POST /api/session/:id/pin`;
[public/axes.js](../../../public/axes.js)'s `createAxisClient` and
`normalizeCoords`; the URL hash as the session; the condensate tray concept; the
weather vocabulary.

**Does not carry over:** [public/pool-client.js](../../../public/pool-client.js).
Its `draw()` is *consuming* (`buffer.shift()`) and *per-bucket* — correct for a
field that spawns and forgets, wrong for a surface that re-ranks the same set
every time position moves. `drift` gets a sibling module rather than a change to
a file the field depends on.

**Three server behaviours the client must respect:**

- **`drawPool` is destructive** ([src/session-do.ts](../../../src/session-do.ts)):
  it `DELETE`s drawn rows and pushes them into a 300-entry exclude LRU, then
  kicks the regeneration pump. The server therefore guarantees no candidate is
  served twice, and the client owns whatever it has drawn. **A page reload loses
  the working set** — the session survives and can be re-drawn, but the cards do
  not come back. Acceptable, and consistent with the ephemerality guardrail, but
  it is a real property rather than an oversight.
- **`coords` are computed at draw time** ([src/pool-core.ts:134](../../../src/pool-core.ts))
  against whatever axes are ready. Words generated before an axis existed still
  get coordinates; a draw taken before the axes are ready returns `coords: []`.
- **`draw` samples randomly** within fresh-then-stale, so a resident set is a
  random spread of each bucket, not a ranked slice. That is what this surface
  wants.

## Design language

`drift` binds the existing `--t0` / `--t1` / `--t2` / `--pin` token contract to
the **night-walk palette**, and takes its type and motion from
[public/index.html](../../../public/index.html) rather than from Press.

That contract is already shared with two bindings in the tree. `/` binds it to
the night palette; `/app/` rebinds the same four names to Press values at
[public/styles.css:22](../../../public/styles.css) — `--pin` becomes the Press
accent blue rather than gold. So this is choosing a binding, not inventing a
language, and it avoids the half-inherited look #43 warns about because nothing
is half-taken.

| | value |
| --- | --- |
| ground | `--ink #0d0c14`, `--field #151327`, `--deep #100f1e` |
| ramp | `--t0 #cfd4e8` → `--t1 #b8a6e8` → `--t2 #e8a68f`, `--pin #f0d98c` |
| quiet | `--label #9a97b0`, `--faint #565378`, `--hair rgb(232 233 240 / .14)` |
| display | Fraunces 300, tight negative tracking |
| text | Space Grotesk 300 |
| label | mono, 9–10 px, uppercase, `.18em`–`.26em` tracking |
| motion | `cubic-bezier(0.22, 1, 0.36, 1)` — the one curve both languages share |

Two reasons this binding rather than Press's:

- **SPEC.md's tier guardrail is this palette** — *"pale slate → lilac → warm
  ember; pinned = gold."* `/app/`'s blue `--pin` is the deviation, and
  reconciling it is [#38](https://github.com/schmug/dewpt/issues/38), not this
  build.
- **Press cannot express the card's strangeness cue.**
  [public/press.css](../../../public/press.css) is explicit that its palette is
  *"Two tones, not a ramp."* A two-tone language structurally cannot carry a
  three-step tier signal, so inheriting Press would mean dropping the cue.

Fraunces and Space Grotesk load from Google Fonts on `/` with full fallback
stacks; `drift` reuses the same link and stacks.

**One deliberate deviation from `/`:** the landing uses `100svh` for its sticky
scroll sections. `drift`'s card surface uses `dvh` per #43's mobile floor, since
it is a fixed full-height surface rather than a scroll stage and should track
the toolbar rather than reserve for it.

## Architecture

```
public/drift/
  index.html       setup flow (seed -> name two axes) + the card surface
  styles.css       every selector scoped to .drift-surface
  drift.js         controller: session lifecycle, gestures, DOM
  working-set.js   the resident candidate set — owns all network
  position.js      PURE: position, ranking, tie-break, edge detection
  axis-lint.js     PURE: workstream A's checks
```

`position.js` and `axis-lint.js` are pure — no DOM, no fetch — so vitest imports
them directly, the way [test/axes-client.test.ts](../../../test/axes-client.test.ts)
already imports `public/axes.js`. `working-set.js` owns network; `drift.js` owns
pixels. Same three-way split `/board/` uses. CSS is scoped to `.drift-surface`
so the field's `styles.css`, `press.css` and the board's sheet can never collide.

Three decisions that would silently break if left implicit:

- **Position is stored in raw cosine space, never normalized space.** The
  resident set grows as it tops up, so the min–max range moves; a position
  stored as 0.5 would drift semantically without the user touching the screen.
  Freeze the per-axis normalization range after the initial prime, widen it only
  if a top-up lands outside (monotone and rare), and normalize for *display*
  only.
- **Top-up is low-water and local, not greedy or global.** A prime is 6 buckets ×
  `MAX_DRAW_COUNT` 30 = **180 candidates** against `TARGET_DEPTH` 60 × 6 = 360
  in the DO. Since drawing deletes, a greedy client outruns the pump and starves
  itself. The trigger is *unseen candidates within radius R of the current
  position*: a set of 180 can be plentiful overall and empty exactly where you
  stand, and a global count would let you walk into a hole while the client
  believes it is well stocked.
- **The `axisIds` invariant carries over verbatim.**
  [public/pool-client.js](../../../public/pool-client.js) flushes *every* buffer
  when the axis set changes, because coords are shaped for a specific axis set.
  `working-set.js` must discard on mismatch too — and additionally reset the
  frozen normalization range.

## Data flow

```
setup                                     card loop
─────                                     ─────────
 seed ──► POST /session ──► {id}            swipe ──► position ± step (raw space)
                │                                │
 name 2 axes    ▼                                ▼
   ──► POST /axes  (server expands             re-rank resident set
        + embeds + returns phrases)              by 2D distance, unseen only
                │                                │
        show expansion, run LINT                 ▼
        (editable — re-lint on edit)           render 1 card
                │                                │
                ▼                          tap ──► POST /pin
 prime: 6 parallel GET /pool?count=30            │
                │                                ▼
                ▼                          unseen-near-position < floor?
 ≤180 Served {text,tier,alt,seedDist,coords}     └──► top-up draw
                │
                ▼
 FREEZE per-axis min/max → normalization range
```

**Axes before prime.** A draw taken before the axes are ready comes back with
`coords: []` and is unrankable. The setup flow enforces the order; if it ever
races, an empty-coords row is discarded rather than rendered at a fake position.

**Ranking.** `coords[i]` is indexed by `axisIds[i]`, so axis A is `coords[0]` and
axis B is `coords[1]`. Each is normalized independently against its frozen range,
putting both on [0,1] and making a plain Euclidean 2D distance meaningful — which
is licensed by run 2's independence result, not assumed.

**Degradation to one axis.** With one axis named, or if the second fails,
left/right stays live and up/down go inert and labelled as such. The surface
opens rather than refusing.

## The probe lint (workstream A)

The axis-measurement doc's lint was built for a harness with **16 curated pairs
per axis**; a dewpt axis is **one pair** of expanded phrases, so
`d_bow = mean(bow(pos_i) − bow(neg_i))` collapses to a single difference. What
survives, and where:

**Stage 1 — on the returned expansion, before the axis is confirmed.** This
answers the doc's open question 2: lint the phrases, because that is what gets
embedded; phrase the warning in terms of the term the user typed.

| check | ports? | how |
| --- | --- | --- |
| `lenΔ` ≥ 2.0 tokens | **yes, unchanged** | token counts of the two expanded phrases; expansion targets 4–8 words, so a 2-token gap is real |
| `rarityΔ` ≥ 1.2 mean idf | **as a proxy** | no corpus ships, so a compact common-word list scores *fraction of everyday tokens*. Name it a register proxy, not idf |
| BoW overlap ≥ 0.375 | **no — needs a run** | with one pair there is no averaging to expose a dominant token |

**Stage 2 — after the prime, once a pool exists.** Rank the resident candidates
by lexical overlap with the pos-minus-neg terms and compare against the embedding
top-k; fail at ≥ 0.375. High agreement means the axis sorts by a word and the
embedder is doing no work. This necessarily warns mid-session — the evidence did
not exist earlier.

**Stage 2 ships with the BoW check and nothing else.** Workstream B looked for a
cheap statistic that could also flag a *weak* axis here and found none — see
*Workstream B* for the sign-reversal evidence. Adding one anyway would be
shipping a check that reports noise.

**When it fires: warn and allow, never block** (the doc's open question 3). One
tap re-expands; the expansion stays editable, which the latent-space design doc
already calls both the quality mechanism and the escape hatch. The lint can tell
you an axis is *fake*; it can never tell you an axis is *meaningful*, so it must
not read as a verdict.

**Stated limit: this lint would not have caught `solemn→playful`.** `"a formal
solemn ceremony"` against `"a lighthearted playful activity"` is 4 tokens to 4,
both everyday register, no shared token — it passes everything and still gave
`community engagement · park and ride` at its playful pole. Neither `sd`
(0.044–0.061) nor `midShare` separates it from the null either. The lint's scope
is exactly **lexical and register fakes, not weak axes**. Catching weak ones
needs a non-circular legibility metric with a chance line, which is
*Workstream B* below — and which now lands before this surface does.

## Workstream B: a chance line for axis legibility

**This lands before the surface.** An axis the user cannot trust makes every
other decision here moot, and `solemn→playful` proved we currently cannot tell a
weak axis from a good one by any number we have.

**The one-pair adaptation.** The axis-measurement doc's B assumes a 16-pair
harness and scores coherence against a `1/√(n−1)` chance line — 0.258 at n=16.
A dewpt axis is **one pair**, so that construction does not port. What ports is
the idea, in a better shape for one pair: build the chance line from a
**distribution of K seeded random-pair null axes computed over the same pool**,
and read the real axis's statistic as a percentile against it. That is a
permutation test, it needs no curated pairs, and it has a useful property — a
statistic that is partly circular is still usable, because the same circularity
applies to every null.

**The uncomfortable part: we have no statistic with power.** Measured over the
same pools in run 2, every candidate already to hand fails to separate a real
axis from a random-pair null:

| statistic | real | null | separates? |
| --- | --- | --- | --- |
| `poleLean` swing | ≈0.20 | 0.176–0.231 (**highest** on one seed) | no — and circular besides |
| `sd` of raw coords | 0.044–0.061 | 0.044–0.061 | no |
| `midShare` | 0.291–0.448 | 0.329–0.390 | no |

So B is **not** "apply the doc's metric." It is *find a statistic that separates
a real axis from a null over a real pool, then set the chance line under it.*
That is a research task with a real chance of a null result, and it must be
allowed to report one.

**Design.** One script, `npm run axis-power`, over a small matrix: 2 seeds × 4
axes — two axes expected good (`concrete↔abstract` is the validated 0.980 case),
one expected mush (`solemn↔playful`, the known failure), and one **surface
control** of the form `X` / `more X`, which ports from the doc unchanged and
pins the lexical ceiling. Pools are shared per seed.

Ground truth and two candidate cheap proxies:

1. **LLM-judge AUC — the ground truth.** Sample ~40 pool candidates, have the
   model rate each on the axis, and compute AUC of the projection against those
   ratings. This is `scripts/axis-spike.ts`'s existing method moved from
   hand-labelled word lists onto real pool candidates, reusing `src/metrics.ts`'s
   AUC so there stays exactly one AUC in this codebase.
2. **Pole-cluster coherence** — mean pairwise cosine among the top-k at each
   pole. Non-circular: it never references the axis vector. Hypothesis: a real
   pole is a coherent cluster while a null's top-k is arbitrary. **Unmeasured.**
3. **Inter-pole margin** — cosine between the two pole-end centroids. A real axis
   should push its ends further apart than a null does. **Unmeasured.**

(1) is both the truth and the validator: if (2) or (3) tracks judge-AUC across
the matrix, the cheap one ships in-app as `axis-lint.js` stage 2 and the
expensive one stays in `scripts/`. If neither tracks it, we ship the judge behind
an explicit user action or we ship nothing and say so.

**Do not add an ordering-accuracy metric.** The doc measured its null at 12/16,
p = 0.038 — at that sample the null has a fat tail and the metric manufactures
false positives. Gate on the null distribution instead.

**Cost:** ≈40–50 Workers AI requests, the same order as the two mechanic spikes.
Output is a number with a chance line under it, and a dated entry in
[docs/measurements/](../../measurements/) per the usual rule.

### Result: null. Run 2026-08-22, 70 requests

Full numbers in
[docs/measurements/2026-08-22-workstream-b-null-result.md](../../measurements/2026-08-22-workstream-b-null-result.md).
`npm run axis-power` reproduces it.

**No cheap client-side statistic separates a good axis from a bad one.** Both
candidates reversed sign across two runs of the same matrix:

| statistic | run 1 r with judgeAUC | run 2 r with judgeAUC | verdict |
| --- | --- | --- | --- |
| `poleCoherence` | +0.314 | **−0.843** | rejected |
| `interPoleMargin` | **−0.828** | +0.232 | rejected |
| `poleLean` | +0.898 | +0.315 | rejected — percentile 1.000 in all 16 cells, surface control included |

A sign reversal across two runs of the same matrix is noise, not signal. One
cell of eight cleared its null p95.

**The LLM judge does discriminate.** Mean judgeAUC across two seeds ranks the
axes correctly and reproduces prior knowledge — `concrete↔abstract` **0.810**
(validated 0.980 on hand-labelled words), `practical↔mystical` 0.700,
`solemn↔playful` **0.530**, and the `X` / `more X` surface control **0.530**.
The known-mush axis lands exactly on the lexical ceiling. So an axis *can* be
gated, at the cost of an inference call and its latency — a product decision,
not a measurement one, and out of scope for this build.

Two findings to carry forward:

- **An axis validated on curated word lists is not validated on the pool it
  will sort.** `concrete↔abstract` drops 0.980 → 0.810 moving from hand-labelled
  words to real pool candidates.
- **Axis quality looks seed-dependent.** `practical↔mystical` scored 0.500 on
  `public transit` and 0.900 on `home cooking`; `solemn↔playful` 0.640 and
  0.420. If that holds, "is this a good axis?" is the wrong question — it is
  "is this a good axis *over this pool*", which is harder, and which any in-app
  check would have to answer.

## Failure modes

**Never block a card on the network.** A swipe always resolves from the resident
set; top-up is strictly background. If nothing unseen sits near the new position
that is the wall, not a spinner. This is `CLAUDE.md`'s pool-depth constraint
restated for a gesture.

| failure | behaviour |
| --- | --- |
| session create fails | retry affordance; do not open a fake surface |
| axis create 409 / 422 | reuse `axes.js`'s handling — both carry `error` **plus** current `axes`, so the client explains and repaints without a follow-up GET |
| pole returned `expanded: false` | **visibly degraded** (#43's constraint) — a bare term is AUC 0.640 against 0.980, a quality cliff the user must see |
| prime partially fails | proceed with what arrived; retry the rest with backoff |
| `coords: []` on a drawn row | discard — never render at a fake position |
| `axisIds` mismatch | flush the resident set, reset the frozen range, re-prime |
| pin fails | surface it. `axes.js` already draws this line: background refill swallows, foreground actions must not |
| offline | the resident set keeps working. Service worker is [#27](https://github.com/schmug/dewpt/issues/27), out of scope |

`prefers-reduced-motion` degrades the swipe to a crossfade, no drift.

Card text goes in via `textContent`, never `innerHTML` — model output is
untrusted input and `JSON.stringify` does not escape `<`. Mobile floor from #43
holds: no tap target under 44 pt, `dvh` not `vh`, `viewport-fit=cover` with
safe-area insets, no horizontal scroll at 390 px.

## Testing

Everything fits the existing vitest shape. **No DO, so
[#31](https://github.com/schmug/dewpt/issues/31) (missing DO test harness) does
not block this build** — a real dividend of the client-only cut.

- **`position.js` — pure.** Ranking, unseen-first-then-freshest tie-break, 2D
  distance, clamping, frozen-range normalization, monotone widening on an
  out-of-range top-up, edge detection. Fixed vectors, no AI, no network.
- **`axis-lint.js` — pure, and proven independent.** A phrase pair with a
  2-token gap, one with a register gap, one sharing a dominant token. Each must
  fail its own check and pass the others, so the checks are shown to be
  independent rather than three names for one signal.
- **`working-set.js` — mocked fetch**, like
  [test/pool-client.test.ts](../../../test/pool-client.test.ts). Must cover:
  reads are **non-consuming** (the whole reason the module exists); top-up
  triggers on a *local* shortage near position rather than a global count;
  `axisIds` flush resets the frozen range; partial prime survives; empty-coords
  rows are dropped.
- **Client guards — source scanning**, extending
  [test/board-client-guards.test.ts](../../../test/board-client-guards.test.ts):
  `textContent` over `innerHTML`, `dvh` over `vh`, a reduced-motion block
  exists, no sub-44 pt tap target in the CSS, and a **"never blocks" lexical
  guard** asserting no `await` on the swipe path.
- **Wire regression.** Assert the surface never reads or stores an `embedding`
  key, guarding the 245 KB mistake from the client side (`assertNoEmbeddings`
  already guards it from the server side).

Gates are `npm run typecheck` and `npm test`, reported as counts.

**Workstream B's harness** is a `scripts/` measurement, not a unit test: it
prints a number against a null distribution and writes a measurements entry, in
the shape `axis-spike.ts` and `board-calibrate.ts` already use. Its *AUC* comes
from `src/metrics.ts`, which stays the single AUC in this codebase; its
random-pair nulls must be **seeded**, and reproducibility from a fixed seed
should be asserted before anything is asserted about their value.

**Not testable here, and not claimed:** whether swiping is *fun* — that needs
thumbs, and it is what shipping this is meant to find out. Axis *legibility* is
**not cheaply measurable**: step 0 looked and found nothing with power, so no
unit test can assert an axis is good, and none should pretend to.

## Sequencing

0. ~~**Workstream B — `npm run axis-power` + a measurements entry.**~~ **Done
   2026-08-22, 70 requests. Null result** — no cheap statistic has power, so
   step 6 ships the BoW check alone. See *Workstream B*.
1. **`position.js` + tests.** Pure, no network, no UI. The mechanic in isolation.
2. **`working-set.js` + tests.** Resident set, low-water local top-up, `axisIds`
   flush. Mocked fetch.
3. **`axis-lint.js` stage 1 + tests.** Pure string maths.
4. **`index.html` / `styles.css` / `drift.js`.** Setup flow, gestures, card
   render, edge state. Client guards land with this.
5. **Doors nav.** There is no symmetric three-way nav to extend: `/`
   (`public/index.html:329`) and `/board/` (`public/board/index.html:20`) carry
   real surface navs, while `/app/` has only a back-link to `/`
   (`public/app/index.html:65`) and no link to the board at all — that gap is
   [#56](https://github.com/schmug/dewpt/issues/56). Add `/drift/` to the two
   real navs and give `/drift/` its own. Fixing `/app/`'s nav belongs to #56,
   not here; do not silently absorb it.
6. **`axis-lint.js` stage 2.** BoW-versus-embedding overlap **only** — step 0
   found no cheap statistic with power.

Step 0 is complete, so 1–6 are now unblocked.
1–3 are independent of each other and of the UI; 4 depends on all three.

## Open questions

Resolved 2026-08-22 and kept here as a record of what was decided, since each
was live when the spec was written:

- ~~**Press or its own look?**~~ **Bind the shared `--t0/--t1/--t2/--pin`
  contract to the night-walk palette.** See *Design language*. Press is
  explicitly "two tones, not a ramp" and cannot carry the card's tier cue.
- ~~**Condensate tray here or only on the field?**~~ **A collapsed count that
  expands.** A 44 pt chip; tapping opens the list over the card.
- ~~**More than the word on a card?**~~ **The word plus a tier strangeness
  cue**, from data already on the wire.
- ~~**What catches a weak axis?**~~ **Workstream B, ahead of the surface.** See
  *Workstream B* — and note it is a research task that may return a null result.

Still open:

1. **What are the top-up radius `R` and the shortage floor under it?**
   **Decided for now: ship labelled guesses, measure in the first real session.**
   `R = 0.15` in normalized axis space — one and a half swipe steps, so a
   shortage is detected roughly a swipe and a half before you walk into it — and
   a floor of 8 unseen candidates inside it, mirroring `pool-client.js`'s
   `LOW_WATER`. **Both numbers are unmeasured and must say so at their
   definition**, per the rule at `src/board/types.ts` that an unmeasured
   threshold is a number someone made up. File an issue to measure them against
   a real session rather than leaving the guess to harden silently.
2. **Should an axis be gated by an LLM judge?** Newly open, and only askable
   because workstream B answered the cheaper question. B showed nothing free has
   power but the judge ranks axes correctly (`concrete↔abstract` 0.810 against a
   surface-control 0.530). So a gate is *possible* — one inference call at axis
   confirmation, with its latency, on a surface whose whole premise is that
   nothing waits on an AI call. Out of scope for this build; worth its own
   decision once the surface exists and the cost of a bad axis is observed
   rather than assumed.

## Non-goals

- **A new repository.** See *Decisions*.
- **A Durable Object**, position-conditioned generation, or any `src/` change.
  Position-conditioned refill is the natural second cut — `GenerationInputs`
  already carries `anchors: string[]`, so refill can pass the real candidates
  nearest your position as soft conditioning without decoding a synthetic
  coordinate — but it is not this build.
- **Extracting a shared pool engine.** Two surfaces exist and neither reused
  `PoolCore`; the board wrote `belt-core.ts` instead. Designing the abstraction
  from two points and a guess is worse than designing it from three after
  `drift` exists. Rule of three.
- **Mechanic (b)**, drift meters, or any invented fail state, without new
  evidence that supersedes run 1.
- **A third axis**, 3D, or WebGL. Four directions is two axes.
- **Workstream C** of the axis-measurement doc. (Workstream **B** was a non-goal
  when this spec was written and is now sequencing step 0 — see *Workstream B*.)
- **Map mode** ([#29](https://github.com/schmug/dewpt/issues/29)). Different
  surface, and the one that workstream C's retention numbers actually threaten.
- **Accounts, auth, or cross-session persistence.** SPEC.md holds.
