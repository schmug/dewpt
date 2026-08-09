# The conveyor board: a companion surface for dewpt

**Date:** 2026-08-08
**Status:** approved, not yet implemented
**Scope:** A second UI over dewpt's latent-space machinery — a horizontal
conveyor of kanban-like columns where an idea is rewritten at each station it
passes. Companion to [SPEC.md](../../../SPEC.md), which it extends rather than
replaces. The swipe-card companion is
[#43](https://github.com/schmug/dewpt/issues/43) and is out of scope here.

## Problem

dewpt is one gesture: an ambient field you prospect and pin. It navigates
latent space by *position* — where the sliders put you is what condenses.

What it cannot express is a **sequence**. There is no way to say "take this
idea, make it concrete, then make it strange, then bring it back down," and no
way to see an idea's history, because dewpt has exactly one position and words
have no ancestry.

The conveyor board is that missing gesture. It is not a better dewpt; it is the
composition half of the same idea, and the pitch is one sentence: **you author
the pipeline, and order matters.**

## The mechanic

Columns are **stations** on a belt that runs left to right. Rows are
**lineages** — one idea's journey.

1. Column 0 is the user's. A seed typed there fans into 2–3 lineages.
2. Each subsequent column is a **named direction**, editable by the user.
3. When a lineage's live card reaches station *k*, that station **rewrites**
   it. The previous text stays behind in station *k−1* as a **ghost**, fading
   with distance.
4. Cards that pass the last station reach the **edge** and evaporate into the
   ghost ring.
5. Clicking a card **harvests a copy** to the shelf, where it is expanded from
   a fragment into a sentence. The belt keeps running.

Read a row left to right and you see how an idea got cooked. The ghost trail
*is* the lineage; adjacency does all the work, so no arrows, connectors or
"was:" labels are needed.

### Why rows-as-lineages is load-bearing

The first mockup put ghosts loose in columns and needed explicit `was: …`
labels to explain them. It was unreadable. Aligning each lineage to a row
removed the labels, the connectors and the ambiguity in one move, and it gives
the board a natural capacity limit: **the row count is the concurrency cap**,
which is legible in a way dewpt's `CAP = 14` never was.

## Decisions

Six, in the order they were settled. Each foreclosed the ones under it.

1. **Conveyor, not fan-out or chain.** Cards are generated per column *and*
   drift rightward, with the right edge as death. Fan-out (columns as
   independent lenses on one seed) makes column order meaningless; a pure
   discrete chain loses dewpt's continuous motion.
2. **Rewrite, leaving a fading trail.** A station replaces the card's text and
   the old form persists as a ghost. Rejected: rewrite-with-no-trail (loses any
   chance to rescue a good intermediate) and spawn (population grows
   multiplicatively and column order stops mattering).
3. **Fragments on the belt, prose on pin.** Cards travel as 1–5 word fragments
   in dewpt's existing register; *pinning* expands one into a sentence.
   Ephemeral content stays cheap, fast and on-voice; only harvested content
   pays for prose, and only on a deliberate act that already affords a round
   trip.
4. **Columns are directions, not operations.** A column names a place to move
   toward ("make strange"), not a thing to do ("objections"). The reason is
   structural, and it was not obvious until it was mocked up: **operations
   reply rather than rewrite.** "landlords say no" is not a new version of
   "urban gardening" — it is a response to it, so the row becomes a dialogue
   and by the third column you are operating on the objection rather than on
   the idea. Directions preserve the trail semantics decision 2 depends on.
   Operations remain the strongest v2 candidate, and would need **branching**
   card motion rather than replacement.
5. **Same repo, second route.** `/board` on the existing Worker, sharing
   `axis-core`, `generation` and `dev-fake-ai` by direct import.
6. **Lookahead-by-one; cards advance when ready.** See
   [Belt behaviour](#belt-behaviour).

## What carries over from dewpt, and what does not

This was audited rather than assumed, and the first read was wrong.

**`PoolCore` is not reusable here.** It is welded to dewpt's model in four
places: buckets are `tier × alt`
([types.ts:8](../../../src/types.ts)), `affinity()` is dewpoint/altitude
slider math ([pool-core.ts:505](../../../src/pool-core.ts)), `genPlan()` picks
buckets by that affinity, and `draw()` picks *randomly* from a bucket
([pool-core.ts:113](../../../src/pool-core.ts)). The board needs a *targeted*
pick, and its candidates are **parent-relative**, not seed-relative — so
bucket-pooling is structurally unavailable, not merely inconvenient.

| Asset | Reusable? |
| --- | --- |
| [axis-core.ts](../../../src/axis-core.ts) — `axisVector`, `coordsFor`, `isDegeneratePole` | Yes, unchanged |
| [generation.ts](../../../src/generation.ts) — `expandPole`, `embedTexts`, `parseCandidateList`, `AiRunner` | Yes, unchanged |
| `cosineSim` ([pool-core.ts:30](../../../src/pool-core.ts)) | Yes |
| [dev-fake-ai.ts](../../../src/dev-fake-ai.ts) | Yes — deterministic embeddings make scoring tests real |
| [session-do.ts](../../../src/session-do.ts) | Pattern only (thin shell + alarm loop) |
| `PoolCore` | **No** — `belt-core.ts` is new code |

## Architecture

`/api/*` already routes worker-first
([wrangler.jsonc](../../../wrangler.jsonc)), so `/api/board/*` needs no routing
change; `public/board/index.html` serves at `/board` through the assets
binding. `BoardDO` is a **new class under a new migration tag** — `SessionDO`'s
`v1` tag must not be edited.

Logic stays out of the Durable Object, per
[CLAUDE.md](../../../CLAUDE.md):

| Module | Role |
| --- | --- |
| `src/board/types.ts` | `Station`, `Card`, `Lineage`, constants |
| `src/board/belt-core.ts` | Pure belt: advance, capacity, ghost depth, edge eviction, rename cascade, arrival |
| `src/board/rewrite.ts` | `(parent, station) → candidates`, scored and selected. Pure + `AiRunner` |
| `src/board/board-do.ts` | Thin stateful shell and alarm loop |

### Data model

```ts
interface Station { id; order; term; phrase; expanded; embedding: number[] | null }
interface Card    { id; text; stationIndex; bornAt; embedding: number[] | null }
interface Lineage { id; seedText; cards: Card[] }
interface Harvest { id; fragment; lineageId; chain: string[]; prose: string | null; expanded: boolean }
```

`Harvest` is a **board-level list, not a field on `Lineage`**, because pinning
copies rather than removes: one lineage can be harvested at several stations,
so a single `pinnedCardId` could not represent it. `chain` is the ancestry
snapshot taken at pin time — it is what conditions the prose expansion, and it
must be captured then because the lineage keeps moving afterwards.

A lineage's **last card is live; every earlier one is a ghost.** Ghost opacity
is `f(head − index)` and is computed **client-side** — the server never stores
a fade.

**No embeddings on the wire, ever.** The types above are the *server* model;
the wire form is a projection of it with every `embedding` field dropped. 1024
dims × the visible set is the 245 KB mistake documented in
[latent-space-navigation-design.md](../../latent-space-navigation-design.md).

## The scoring rule

A direction needs two poles. **The parent card is the negative pole; the
station phrase is the positive one.**

```
stationVec = axisVector(parentEmb, phraseEmb)              // phrase − parent
score(C)   = coordsFor(axisVector(parentEmb, embC), [stationVec])[0]
```

Both functions exist unchanged at
[axis-core.ts:11](../../../src/axis-core.ts) and
[:22](../../../src/axis-core.ts). This preserves the **pair** construction the
axis spike measured at mean AUC **0.843 against 0.763** for a single term.
Scoring candidates against the station phrase embedding alone would have been
precisely the weaker construction the spike warned about — it looks equivalent
and is not.

Per hop: generate ~8 candidates → `embedTexts` → drop anything below the
**tether floor** against the parent → dedupe on `DEDUPE_COSINE` against the
lineage's own history and the board exclude set → take argmax score.

### Constants that must be measured, not guessed

`scripts/board-calibrate.ts`, over the Workers AI REST API from node (which
sidesteps both the WARP egress and Cloudflare Access traps in
[CLAUDE.md](../../../CLAUDE.md)), printing **numbers**, not samples:

- **`TETHER_FLOOR`** — below this a "rewrite" is a non-sequitur.
- **`ARRIVAL_COSINE`** — when parent ≈ station phrase, the lineage has
  *arrived* and that direction has nothing left to give.
  `isDegeneratePole` ([axis-core.ts:100](../../../src/axis-core.ts)) is the
  right predicate and is reusable as-is, but `DEGENERATE_POLE_COSINE = 0.98`
  was tuned pole-against-pole and **almost certainly does not transfer**.
  Reusing it unmeasured is the most likely quiet mistake in this design.
- **candidates per hop.**

## Belt behaviour

- A lineage whose head sits at station *k* is **hungry** for *k+1*. The alarm
  loop batches hungry lineages by target station, one call per station.
- A card advances the instant its child lands. **There is no fixed belt
  speed**, which dissolves the stall problem rather than solving it: the board
  is never waiting on one specific card, and varied dwell times read as
  organic. This is how the never-block-on-generation guardrail in
  [CLAUDE.md](../../../CLAUDE.md) is honoured without an understudy pool.
- Head passes the last station → dwells at the edge for `EDGE_DWELL_MS` (a
  legibility pause, not a tuning knob — long enough to be readable and
  pinnable) → evicted, head text into the evaporated ring.
- `MAX_LINEAGES` is the legibility cap. New seeds queue behind it.
- **A seed fans into 2–3 lineages on entry, from one call.** Without this, a
  fresh board with a single seed has all its motion gated on one generation and
  will look like waiting.

### The rename cascade

Renaming station *k* **evaporates every card at and downstream of *k***; each
affected lineage re-flows from its last surviving upstream card through the new
direction. Pinned cards are untouched.

This is cheaper than dewpt's lazy-invalidation stamps and more correct here:
you changed the direction, so work done under the old one blows off the belt
and re-cooks. It is legible, it costs no bookkeeping, and it keeps
ephemerality. It is also genuinely destructive — **one rename can clear most of
the board, and pinning first is the only protection.** That is accepted, not
overlooked.

Adding or removing a station rides the same cascade unchanged: inserting at *k*
is "everything at and downstream of *k* re-flows."

## Interaction

- **Seed** — text input in column 0; Enter fans into 2–3 lineages.
- **Pin copies, it does not remove.** The lineage keeps travelling, so the same
  lineage can be harvested at more than one station.
- **Expansion-on-pin takes the whole lineage as context**, not just the
  fragment. `urban gardening → rooftop bee lease → pigeon-assisted pollination`
  yields a far better sentence than the final fragment alone. This is the one
  place the board beats dewpt at prose, and the chain is already there for
  free. Failure falls back to the bare fragment, marked.
- **Rename** — click header, edit term, `expandPole` runs, and the phrase
  renders under the header **editable**. Showing the expansion is
  simultaneously the quality knob, the escape hatch and the tutorial, exactly
  as argued for axes in
  [latent-space-navigation-design.md](../../latent-space-navigation-design.md).
  A degraded station must *look* degraded.
- **Stations**: 2–5, default 3. Shipped defaults `Concretize` ·
  `Make strange` · `Ground it`, chosen because they demonstrate that order
  matters.
- **`prefers-reduced-motion`** — no belt travel, no fade transitions. Cards
  step between stations; ghosts render at static reduced opacity. dewpt's rule
  is fade-only-no-drift; here the drift *is* the belt, so it becomes step-only.
- **Touch** — desktop-first, not-broken on touch, mirroring
  [SPEC.md:81](../../../SPEC.md). A wide horizontal board on a phone is a real
  design problem and gets its own issue rather than a hand-wave.

## Failure modes

Specified rather than left to implementation, because every row below has a
silent-failure variant that looks like working software.

| Failure | Behaviour |
| --- | --- |
| Model returns junk | `parseCandidateList` yields `[]` ([generation.ts:166](../../../src/generation.ts)) and never throws. Hop retried next alarm with backoff; after **3** consecutive failures the lineage is **released to the edge** — a permanently stuck card is indistinguishable from a slow one |
| Every candidate fails the tether floor | Treated as an empty batch. Retry once at a higher candidate count, then release. **Never silently lower the floor**; that turns a quality guard into a no-op |
| `embedTexts` throws ([generation.ts:222](../../../src/generation.ts)) | Caught at the DO boundary; hop abandoned and retried. Must never escape the alarm loop, which would freeze the whole board |
| Pole expansion fails | Falls back to the bare term with `expanded: false` and **stays visibly degraded**. 0.640 vs 0.980 AUC means a silently-degraded station emits bad rewrites that look entirely normal |
| Station not yet embedded | Lineage **holds**. It does not fall through to unscored selection — unscored output is indistinguishable from scored output, the same class of bug as the row above |
| Parent ≈ station phrase | Not an error: the lineage has **arrived** and that direction is exhausted for that idea. Mark it visibly and send it to the edge. This is information |
| Many hungry lineages at once | Cap concurrent generations per tick; the rest wait. Harmless by construction — there is no fixed belt speed to fall behind |

## Testing

`vitest` over pure core logic, no network and no Workers runtime, with AI faked
by [dev-fake-ai.ts](../../../src/dev-fake-ai.ts) — whose deterministic
pseudo-embeddings make the scoring tests genuinely real rather than mocked
away.

- **`belt-core.test.ts`** — advance, capacity queueing, ghost depth, edge
  eviction, arrival marking, and the **rename cascade** (at-and-downstream
  evaporates, upstream survives, pinned survive). Pure, zero AI.
- **`rewrite.test.ts`** — prompt shape; `parseCandidateList` against junk,
  fenced and prose payloads; scoring against fixed synthetic vectors (argmax
  must pick the largest projection); tether filtering; dedupe.
- **Wire-format guard** — no `embedding` key in any `/api/board/*` response.
- **Ephemerality guard** — an unpinned card's text does not survive eviction
  anywhere in stored state. Encodes [SPEC.md:88](../../../SPEC.md) for this
  app.
- **Never-blocks guard** — a state read returns without awaiting any AI call,
  and a lineage with a pending hop still serves its current head.

Gates are `npm run typecheck` and `npm test`, reported as counts.

## Sequencing

**This document describes more than one implementation plan's worth of work.**
M0 and M1 together are a reasonable first plan; M2–M4 each want their own
spec → plan → PR cycle.

**M0 — calibrate first.** `TETHER_FLOOR`, `ARRIVAL_COSINE`, candidates-per-hop.
Spike-before-build, as workstream C went. **This is a real gate:** if "moved
meaningfully toward the direction" and "still recognizably derived from the
parent" turn out to have no overlapping range, the rewrite mechanic does not
work and M1 should not be built. Better known in a day than after a UI exists.

**M1 — the belt.** Seed → fan → flow → edge, fixed default stations,
reduced-motion. No rename, no pin. This alone is the demo.

**M2 — rename**, expansion UI, cascade.

**M3 — pin** → shelf plus lineage-conditioned prose expansion.

**M4 — add/remove stations, arrival.**

## Open questions

1. **Do fragments read as a lineage?** The risk named when granularity was
   chosen: `rooftop bee lease → pigeon-assisted pollination` may look like two
   unrelated fragments rather than one rewrite. M1 answers it for real. The
   honest fallback is moving the belt to idea-lines after all — which would
   invalidate decision 3, not merely tune it.
2. **What does the board look like before the first seed?** dewpt solved the
   equivalent with a self-condensing pre-seed state
   ([#11](https://github.com/schmug/dewpt/issues/11)); the board needs its own
   answer.
3. **Does the board inherit Press?** ([press.md](../../press.md)) Likely yes,
   but a horizontal belt has no obvious home for the hairline frame and corner
   marks. Decide deliberately rather than drifting into a half-inherited look.
4. **Mobile.** A wide horizontal board on a phone is unsolved and deferred.
5. **`MAX_LINEAGES`.** Bounded by legibility, exact value unmeasured. The
   mockups read comfortably at four rows.

## Non-goals

- **Operation columns.** Deferred by decision, not oversight; they need
  branching card motion.
- Mobile-first layout.
- Multiplayer.
- Accounts, auth, or cross-session persistence — the session URL is the
  session, as in [SPEC.md:80](../../../SPEC.md).
- The pasted-notes corpus
  ([#30](https://github.com/schmug/dewpt/issues/30)) — orthogonal.
- **Extracting a shared engine** with the swipe-card companion
  ([#43](https://github.com/schmug/dewpt/issues/43)). The seam shows itself
  after the second consumer, not before. Record friction; do not refactor
  speculatively.
