# drift: a swipe-card navigator over dewpt's latent space

**Date:** 2026-08-22
**Status:** approved, not yet implemented
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
 │                             │
 │      domestic alchemy       │   the card. tap to keep.
 │                             │
 │        ← swipe to move →    │
 └─────────────────────────────┘
```

Left/right is ∓/± on axis A, up/down on axis B. Position is a reversible 2D
point. Tap pins to the condensate tray — no gesture conflict, both thumb-reachable.

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
5. **Workstream A (probe lint) ships; B and C do not.** The lint is pure string
   maths and addresses a failure run 2 actually found. Workstream C's
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
needs a non-circular legibility metric with a chance line, which is workstream B.

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

**Not testable here, and not claimed:** whether an axis is *legible* (needs
workstream B's chance line) and whether swiping is *fun* (needs thumbs). Those
are what shipping this is meant to find out.

## Sequencing

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
6. **`axis-lint.js` stage 2.** BoW-versus-embedding overlap, once a pool exists
   to run it against.

1–3 are independent of each other and of the UI; 4 depends on all three.

## Open questions

1. **Does `drift` inherit the Press design language
   ([docs/press.md](../../press.md)) or get its own?** #43 says decide
   explicitly and do not drift into a half-inherited look. **Leaning own**, and
   the precedent says so: `press.css` is loaded by `/app/` alone. `/board/`
   deliberately declined it and owns scoped tokens instead, saying so in comments
   at both `public/board/index.html:13` and `public/board/styles.css:5`. A
   companion surface writing its own scoped sheet is the established pattern
   here, not the exception — and Press was authored for desktop, which the
   44 pt / `dvh` / safe-area floor will fight.
2. **What is the top-up radius R, and the floor under it?** Both are guesses
   until measured against a real session. They should be measured, and until
   they are, said to be unmeasured.
3. **Does the condensate tray live on this surface or only on the field?** Pins
   are shared session state, so a `drift` pin already shows up in the field. A
   tray on a phone costs screen the card wants.
4. **Should a card ever show more than the word?** #43 leaves this open. The
   `Served` row already carries `tier`, `alt` and `seedDist`, so a depth or
   strangeness cue is free if it earns the pixels.
5. **What catches a weak axis?** Unresolved and the most consequential. The lint
   catches lexical and register fakes only; `solemn→playful` passes everything
   and is still mush.

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
- **Workstreams B and C** of the axis-measurement doc.
- **Map mode** ([#29](https://github.com/schmug/dewpt/issues/29)). Different
  surface, and the one that workstream C's retention numbers actually threaten.
- **Accounts, auth, or cross-session persistence.** SPEC.md holds.
