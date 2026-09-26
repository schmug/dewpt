# Sky and ground — design

**Status:** slice built at `/ground/` and fresh-context reviewed; every merge-blocking review finding is fixed (Appendix A). The first spike's real run came back **INVALID** on 2026-09-24 ([measurement](../../measurements/2026-09-24-sky-and-ground-spike.md)). The design went back to §2, and the run narrowed it to **prospect only**: the bridge is dropped and threads are arrangement (Appendix B). On branch `ground-prospect-only`, a prospect-only spike on fresh data came back **FAIL** on 2026-09-26: attribution 10/18 against a pre-registered bar of 11 ([measurement](../../measurements/2026-09-25-ground-prospect-spike.md)). Under the pre-registered rule, the slice is **not merged**, and Marginalia (§2.E) becomes the candidate, starting with its pool-reuse spike. · **Date:** 2026-09-24, revised 2026-09-26
**Plan:** [2026-09-24-sky-and-ground.md](../plans/2026-09-24-sky-and-ground.md)
**Screens:** [assets/2026-09-24-sky-and-ground/](assets/2026-09-24-sky-and-ground/)

## TL;DR

dewpt becomes two planes:
- **The sky** is the weather dewpt already makes. Words condense out of the session pool and evaporate. Nothing there is kept.
- **The ground** sits under it. It holds only what you pin. A pinned word *falls* onto the ground, and there you arrange it by hand.

Where things sit on the ground is what condenses next:
- **Beside a cluster.** Click open ground next to a cluster and dew condenses there, drawn from what is nearby.

That gesture is served by **re-ranking the pool the DO already holds**. Nothing calls the model inline, so the pool-depth rule stays intact.

**Threads are arrangement.** You can draw a thread between two words. It is shown on the ground and goes out in the export, but it condenses nothing. The earlier bridge gesture was dropped (Appendix B).

**The Excalidraw verdict:** use Excalidraw's *file format*, not its *runtime*. The ground exports a valid `.excalidraw` file, which covers M5; it opens in Excalidraw with bindings intact, checked below. Embedding the editor fails on fit, not on size:
- its font set is closed, so no Fraunces;
- its dark theme is a CSS colour inversion that turns the night palette into lavender-grey;
- most of its tools make marks the generator cannot interpret.

Because the ground's data model is a strict subset of Excalidraw's, the call can be reversed later without migrating any data.

---

## 1. What the audit found

Four subagents each ran one surface locally with `DEV_FAKE_AI=1`, screenshotted it, and read its code and spec. The orchestrator spot-checked each report's evidence against code before accepting it (`TASKS.md` §1). Condensed:

| surface | good at | vestigial / broken | overlaps with |
| --- | --- | --- | --- |
| **night walk** `/` | Atmosphere: fog, moon, dew glints. Prospect and pin work with nothing at stake. | One self-contained 1140-line file: its own tokens, and its own reimplementation of the field loop. Draws 95 words, against the field's legibility cap of 14. The seed "input" is an inert `div`. Engineering rules appear as visitor copy. | The field. It is the 1st of **four** explainers for the same loop. The others are the field's pre-seed pool, the field's about panel, and the field's legend. |
| **field** `/app/` | Pool and drip that never blocks; pin-as-anchor; "add your own word" (the only way your own thinking gets in); evaporated restore. | **Prospect is a dewpoint bump, not M2.** `session-do.ts` ignores the argument. `coords` are sent but never read. Depth is `Math.random()`. Cold start holds 2–3 words for about 15 s: `pickWord` has no fallback when a bucket is empty. Pins vanish from the field on resume. | drift: same session DO, same buckets, and the two compete for supply. |
| **board** `/board/` | The only surface where an idea visibly comes *from* a parent (rows as lineages). Seed fan-out is a real branching primitive. | Runs on the translation mechanic that `2026-08-22-drift-mechanic-spikes.md` measured as the loser. `TETHER_FLOOR` admits 53% of non-sequiturs (#52). Dead under fake AI, because the fake-AI comment about tether is false. The EDGE column is always empty. It re-renders every card every 900 ms. It overflows at 390 px. It uses a different visual language from the rest of dewpt. | drift: the same named-direction idea, minus history. |
| **drift** `/drift/` | Projection over a fixed pool (cycle 3 conceded that the happy path is real). Pole expansion. Gauges oriented like the gesture. | Several claims are unsupported: `0.414`, seed survival, axis legibility. The edge is a supply artefact, not a semantic one. Retries redraw all six buckets. Flush recovery is still broken (`range = null` → TypeError). The condensate panel is painted under the card, and a desktop drag pins. | field: shared session, anchors and pool. |

Across all four, the common failure is that each is a **word stream you watch**, plus a harvest that is a flat list. None of them gives your own arrangement of ideas a place to live. That missing place is what this design adds.

---

## 2. Five reimaginings

Each entry gives the pitch, the core gesture, what survives and what is cut, and the single riskiest assumption.

### A. Sky and ground, on Excalidraw
- **Pitch:** the weather condenses above an embedded Excalidraw whiteboard, and what you pin precipitates onto it as a text element.
- **Gesture:** pin a word, then draw on the whiteboard. A frame or loop is a cluster, an arrow asks for a bridge, and an empty spot is where you prospect.
- **Survives:** the pool, drip, pins and evaporated trail. **Cut:** the condensate tray.
- **Riskiest assumption:** that Excalidraw can be made to *belong*. That means the night palette, gold pins in the display face, and no stock chrome. It also assumes a whiteboard full of shapes can be read back as conditioning.

### B. Sky and ground, native ground — **chosen**
- **Pitch:** same two planes. The ground is dewpt's own surface, and it holds only pinned words and threads.
- **Gesture:** click a sky word and it falls. Drag to arrange. Click open ground beside words to get dew from that neighbourhood. Thread two words, then press the mark on the thread to get words near both ends.
- **Survives:** everything in A, plus Fraunces and gold on the ground.
- **Riskiest assumption:** that re-ranking a *seed-only* pool by ground geometry is **perceptible**. It needs different clusters to pull recognisably different words, and bridges that do not collapse onto one end.
- *2026-09-25:* the thread's mark (the bridge) was dropped after the first spike came back INVALID. This also retires the line under D below about a thread's bridge being a graded branch. Section 2 is kept as it was written when B was chosen; see Appendix B.

### C. Rooms with windows (Cory's)
- **Pitch:** each project is a room with its own ground, notes and tasks. You move between rooms through a deliberate doorway (event segmentation), and each room has windows onto nearby latent space.
- **Gesture:** walk through a door; look out of a window.
- **Survives:** B, per room. **Cut:** the single-session model; it adds a room index.
- **Riskiest assumption:** that a window shows something recognisably *different* from the room's own weather. A window is the room's centroid pushed along a direction, and that is translation. Translation is the mechanic measured to abandon its seed by step 2.

### D. Flight: a vector cloud with a grove of branches (Cory's cloud and branching ideas, merged)
- **Pitch:** a 3D point cloud grown from the seed. You fly it by hand or push it with a typed or spoken phrase, and at any point you fork many fast branches. A stronger model and you grade each branch for semantic direction.
- **Gesture:** fly, then fork, then grade.
- **Survives:** the pool as the cloud's points, and the board's lineage idea. **Cut:** the field's DOM rendering; this needs WebGL.
- **Riskiest assumption:** that "push in the phrase's direction" moves you *along* that direction. The walk spike measured displacement alignment at +0.096, four times below the unrelated-phrase baseline. Grading many branches per step also burns inference that the pool-depth rule forbids on the hot path.

### E. Marginalia (the radical one)
- **Pitch:** no topic box at all. You write, in a plain page, and **the paragraph under your cursor is the seed**. Weather condenses in the margins beside the sentence you are on. Pinning drops a word into the margin as a note, never into your text.
- **Gesture:** write. Glance at the margin. Pin.
- **Survives:** the pool, pins and evaporation. **Cut:** the field as a destination; the weather becomes peripheral vision.
- **Riskiest assumption:** that a pool built for paragraph *n* still serves paragraph *n+1* by re-ranking. Otherwise every paragraph invalidates the pool, the margin waits on generation, and the "never visibly wait" rule is broken on every keystroke pause. It also makes your own writing a persistent corpus, which is workstream B's paste-corpus question, and that question is still open.

### Why B, and why not the others

B is the smallest change that turns dewpt from something you watch into somewhere you think:
- your arrangement becomes the query;
- the weather stays weather;
- every gesture on the ground means exactly one thing to the generator.

It also reuses the one mechanic this repo has measured as working. That is projection over an existing pool: re-rank, never rewrite. It does not re-claim anything the evidence refused (§6).

**A is rejected for fit, not size** (§3). Excalidraw's tools produce marks with no meaning to the generator. A rectangle, a diamond, an image or a freehand scribble next to a word: is that a cluster, a boundary, or decoration? Each gesture would need an interpretation rule, and each rule is a new unmeasured claim. The file format is kept (M5) and the runtime is deferred, so choosing B keeps A open.

**C is rejected for now.** Rooms are B plus a room index, so they can come later without changing the ground. The *windows* are translation, which the walk spike measured to fail. Tasks and calendars also pull dewpt toward productivity software, and SPEC says it is play. A window that works would be projection: a pane showing the pool re-ranked toward a *pinned word in another room*. That is a good follow-up, and it needs its own spike.

**D is rejected.** Its core gesture is translation along a typed phrase, which the evidence says does not move you along that phrase. Its grading loop puts inference on the hot path. The branching half survives in a smaller form: a thread's bridge *is* a graded branch, with the judge moved offline into the spike.

**E is the most interesting thing here and the riskiest.** Its failure mode is the correctness rule the whole codebase exists to protect. It needs a pool-reuse spike before anything else (plan §Next).

---

## 3. The Excalidraw question, answered

Cory asked for this to be taken seriously. These are the facts, checked in this session rather than recalled:

| claim in the brief | checked | how |
| --- | --- | --- |
| React peer dep | **true** — `react`/`react-dom` `^17.0.2 \|\| ^18.2.0 \|\| ^19.0.0` | `npm view @excalidraw/excalidraw peerDependencies` |
| MIT | **true** | `npm view … license` |
| ~47 MB unpacked | **true** — 46,802,783 bytes; `dist/prod` is 18 MB, of which **14 MB is fonts** (mostly Xiaolai CJK) | `npm view … dist.unpackedSize`, `du` |
| v0.18.x | **true** — `latest` is 0.18.1 | `npm view … dist-tags` |
| needs a build step | **true** — ships ESM + CSS; our client is unbundled | esbuild probe |

Measured by bundling a minimal page with esbuild (`--minify --splitting`). The probe is committed at [scripts/excalidraw-probe/](../../../scripts/excalidraw-probe/), with its recorded output:
- 179 JS chunks;
- 8.4 MB raw / **2.59 MB gzip** in total, lazily split;
- **entry chunk 251 KB gzip**;
- CSS 145 KB raw / 23 KB gzip.

A probe page's first load made **18 requests, 1.6 MB** (uncompressed local server, fonts included). By comparison, the whole of `/ground/` is under 30 KB of JS and CSS.

What the numbers don't show, and the probe screenshots do:

1. **Its font set is closed.** `FONT_FAMILY` is an eight-member enum: Virgil, Helvetica, Cascadia, Excalifont, Nunito, Lilita One, Comic Shanns, Liberation Sans. It has no API for a custom family. Pinned words on an Excalidraw ground **cannot be Fraunces**. The pin's identity (gold, the display face) would change as it lands.
2. **Its dark theme inverts colours.** It applies `filter: invert(93%) hue-rotate(180deg)` to the canvas, so our night `#0d0c14` renders lavender-grey and our gold renders brown ([excalidraw-dark-theme.png](assets/2026-09-24-sky-and-ground/excalidraw-dark-theme.png)). The workaround is light theme on a dark `viewBackgroundColor`, plus overriding the light chrome ([excalidraw-light-on-night.png](assets/2026-09-24-sky-and-ground/excalidraw-light-on-night.png)). The stock white toolbar with its violet active state is still there and would need hiding and rebuilding.
3. **Programmatic text is measured before its font loads.** Text inserted with `convertToExcalidrawElements` was clipped mid-word ("night buse", "turnstile desig") in the probe, because width is computed with the fallback face. Words arriving from the sky are exactly this case.
4. **Assets default to a third-party CDN.** Fonts load from `esm.sh` unless `window.EXCALIDRAW_ASSET_PATH` is set. Self-hosting means shipping the font tree. That is fine, but it is one more thing for the static-assets budget.
5. **Semantics.** Covered in §2.A: a whiteboard's vocabulary is larger than what the generator can hear.

**Alternatives weighed:**
- **Scene JSON only (chosen).** The ground's scene (`{words:[{text,tier,x,y}], threads:[{a,b}]}`) maps one-to-one onto Excalidraw `text` elements and bound, headless `arrow` elements. `toExcalidrawScene` in `src/ground-core.ts` writes a v2 file. Round-trip check: the exported file loads through Excalidraw's own `restore()` with **6/6 elements, both arrow bindings resolved, background kept, and `serializeAsJSON` re-serialising 6/6** ([export-in-excalidraw.png](assets/2026-09-24-sky-and-ground/export-in-excalidraw.png)).
- **rough.js** (4.6.6, MIT, 170 KB unpacked, 4 deps). This gets the hand-drawn look on our own canvas without the editor. It is not used: a sketchy line clashes with Press's hairlines, and the threads already read as dashed hairlines. It is kept in mind for a freehand "loop to cluster" gesture.
- **perfect-freehand** (1.2.3, MIT, 112 KB). Pressure-sensitive strokes. It is the right library *if* freehand arrives. It isn't needed yet.

**Multiplayer: what it would take for the DO to be the room.** Excalidraw.com's collaboration runs through its own room server. That is from knowledge of the excalidraw-app repo, *not verified this session*. The package itself exports what a custom room needs:
- `reconcileElements`, `getSceneVersion` and `hashElementsVersion` (confirmed in `dist/types`);
- the props `isCollaborating`, `onPointerUpdate`, and `collaborators: Map` (confirmed).

So the DO can be the room either way:
1. accept WebSockets with the hibernation API;
2. relay element (or ground-op) broadcasts;
3. persist the latest scene, with per-element `version` as last-writer-wins;
4. fan out pointer positions.

Choosing B makes this *smaller*. Ground ops are three verbs (`move`, `thread`, `unthread`), already validated by `parseGroundOp` and applied by the pure `applyGroundOp`. The DO shell only has to broadcast the op it just applied. The field and drift already share one SessionDO per session, so two people on one URL already share anchors, and therefore a ground. What is missing is only the push.

---

## 4. The chosen direction: mechanics

**One session, several views.** `/ground/#<id>` is the same SessionDO as `/app/#<id>` and `/drift/#<id>`. A word pinned in the field or in drift is an anchor, so it appears on the ground at a deterministic free spot (`autoPlace`). This is `latent-space-navigation-design.md`'s "two modes, one session" principle.

| gesture | what the DO does | inference on the path |
| --- | --- | --- |
| click a sky word | `POST /pin`, then `POST /ground/op {move}` to where it lands | none (the pump embeds the anchor afterwards, as today) |
| drag a ground word | `POST /ground/op {move}` | none |
| click open ground at *(x, y)*, or **condense beside** from a word's menu (the keyboard route) | `planProspect`: pinned words within `NEIGHBOR_RADIUS`, Gaussian-weighted → query vector → `PoolCore.drawRanked` by cosine, top `PROSPECT_COUNT` | **none** — a re-rank |
| thread A—B (from a word's menu) | `POST /ground/op {thread}`. Arrangement only: drawn, exported, and condenses nothing (Appendix B) | none |
| open ground, or anchors not yet embedded | `mode: "open"` → stranger-first: the highest seed-distance candidates in the pool, jittered. This is stronger than the field's prospect, which only bumps tier odds; open ground is where you go for the far field | none |
| export | `toExcalidrawScene` | none |

**The ground says what it listened to.** Every ground draw returns its `basis` (the pinned words it was conditioned on). The page prints it beside the gesture ("beside night bus · last train", "open ground — the far field"). The user can see why these words condensed. The system does not ask to be trusted blindly.

**Wire:** no embeddings. Every ground response goes through `assertNoEmbeddings` (the board's structural guard, reused).

**Constants:** every behavioural or layout constant is labelled UNMEASURED at its definition, except two that inherit a measured or specced value: `PROSPECT_COUNT` (the field's 4–5 word burst) and the sky's 5–10 s lifetime (field.js). The labelled ones are:
- in `src/ground-core.ts`: `NEIGHBOR_RADIUS`, `NEIGHBOR_SIGMA`, `MAX_THREADS`, the open-ground jitter, and the `autoPlace` spiral;
- in `public/ground/ground-model.js` and `ground.js`: the dew lifetime, `landingSpot` and `dewSpots` geometry, and `DRIZZLE_MS`.

**Legibility:** sky words and dew share `CAP = 14`, and words already fading still count. When dew arrives it answers a gesture, so it gets priority:
- `makeRoom` retires the oldest sky words first, then the oldest dew, on a 0.25 s fade.
- It accepts only as much of a burst as fits.
- A property test covers every combination of live, fading and incoming counts.
- One gesture is in flight at a time.

Verified in the browser: ten rapid prospects peaked at 14 budgeted words, never 15 (Appendix A). Re-measured on 2026-09-25 by `scripts/ground-shots.mjs`, and the same: 14. The budget excludes words during their 0.25 s retire fade (`ground.js` `condenseDew`), so the raw count of word elements briefly reached **24** in the same burst. "Never 15" is true of the budget, not of every frame (Appendix B).

**Reduced motion:** words don't fall and don't drift; they fade. The landing becomes a fade, and the pulse becomes a fade-out.

---

## 5. Ephemerality: how this squares with the guardrail

SPEC: *"Ephemerality is the point: unpinned words evaporate."* A whiteboard is permanent, so the question is real. The fog-of-war section of `latent-space-navigation-design.md` gives the test: **if a change makes the product remember *words* the user did not keep, the guardrail is broken.**

The ground passes that test by construction, not by convention:

1. **Only anchors reach the ground.** `pruneToAnchors` runs on every read *and* every write of the scene. A word that is not an anchor is dropped, along with every thread touching it. `applyGroundOp` refuses to `move` or `thread` a word that is not already there. There is no "place" verb; **only pinning puts a word on the ground.** Tests: `test/ground-core.test.ts` › *pruneToAnchors — the ephemerality guard*, and › *refuses to move or thread a word that is not on the ground*.
2. **Pinned words were already permanent.** The anchors table has always persisted pins. The ground adds *positions* for things the product already kept, and nothing else.
3. **Dew is weather.** Words condensed by a ground gesture are drawn from the pool, live 7–12 s, and evaporate into the same evaporated trail, where the one mercy still applies. They are never written to the scene. Pinning one keeps it *where it condensed*, because that place is why it condensed.
4. **Release is evaporation.** Unpinning from the ground (`release`) sends the word into the evaporated trail. It is not deleted, so it stays recoverable, exactly like a word that timed out.
5. **Unpinning anywhere empties the ground, including its storage.** The ground *does* keep its own record: positions and threads, stored as one JSON value in the session's `meta` table. That record is keyed to each anchor's `(text, pinnedAt)`.
   - A word counts only while an anchor with that same text *and* pin time exists.
   - Every read prunes the record, and the pruned scene is **written back**. An unpinned word's text, position and threads therefore do not linger in storage.
   - Re-pinning the same text creates a new anchor with a new `pinnedAt`. It lands fresh: no old position, no old threads.

   Tests: `test/ground-core.test.ts` › *a word unpinned and pinned again comes back fresh*. Also verified in the browser, through the API (Appendix A).

**What would break it:** a "save this dew" that does not go through `pin`; a ground verb that places arbitrary text; persisting dew positions for "next time". Any of those makes the ground remember words the user did not keep. The guard test is written to fail if the first two appear.

**The client keeps its half too.** A pin that fails, whether with a 500, a 429 or a dropped connection, puts the word back on its evaporation clock. If the word was mid-fade when clicked, it finishes evaporating. No failed request can leave a word in the sky for good. The reviewer reproduced that bug, and it is fixed and re-verified (Appendix A).

---

## 6. What this design does not claim

The drift critic loop stopped at cycle 3 without converging, and workstream B returned a null result. These are limits on what this design is allowed to say:

- **No seed-survival claim.** Nothing here asserts that ground-conditioned dew is "still about the seed". It is drawn from a pool that was generated seed-conditioned, and that is all. (`SEED_TETHER_MIN = 0.414` has no provenance, #104. It is not used and not cited.)
- **No cosine threshold as a quality gate.** The ground ranks; it never admits or rejects by a cutoff. It has no tether floor and no arrival cosine.
- **No cheap statistic stands in for the judge.** The spike's embedding numbers (top-10 Jaccard, echo rate) are printed as *diagnostics*. The pass/fail decision rests on a blind, forced-choice judge, with thresholds registered before the first run.
- **The clusters in the spike are hand-written**, three per seed. In the first spike they were deliberately distinct. The prospect-only spike adds the hard case: in every seed, two of the three groups sit on neighbouring sub-themes. Hand-written clusters are still a bias, and real ones may be subtler still.
- **The judge is llama-3.3-70b**, the same model family as the generator. A pass means *a model can tell*, which is a proxy for *a person can tell*. It is not the same claim.
- **No bridge claim.** The bridge is dropped (Appendix B). Its only reading (3/18, hub 5) came from a run that was INVALID, so it is not evidence either way.
- **A position-driven judge voids the run.** The result is INVALID, not a FAIL and not a PASS.
- **Axis quality is not addressed.** The ground has no axes. That is deliberate: it sidesteps the seed-dependent axis legibility that workstream B could not resolve.

---

## 7. What survives, what gets cut (recommendations; nothing deleted)

No existing surface is touched on this branch. These are recommendations for Cory to accept or not:

*2026-09-26:* the prospect-only spike failed (Appendix B), so these recommendations are moot as written. Cory closed the two open calls: `/ground/` does not become the night walk's door, and `/board/` stays as it is.

- **field `/app/`**: the ground can replace it as the default thinking surface. What it teaches carries over. Two of its bugs (the cold-start empty bucket, and pins vanishing on resume) are fixed *on the ground* by construction: `bucketOrder` falls back across buckets, and the ground reads pins from the anchors table. Keep `/app/` until the ground has sliders.
- **night walk `/`**: keep the atmosphere and cut the reimplementation. It should link to `/ground/` as the door, and teach the loop once, not four times.
- **board `/board/`**: retire, or rebuild on projection. Its one unique idea (lineage) was to live on as the thread's bridge. **That no longer holds:** the bridge is dropped (Appendix B), so lineage has no home on the ground, and this recommendation needs revisiting before anyone acts on it.
- **drift `/drift/`**: keep as the phone-first companion; fix #105–#110. Its projection mechanic is what the ground's ranked draw generalises.

---

## 8. Open questions

1. **Does the prospect-only spike pass?** No: it came back FAIL on 2026-09-26 (Appendix B). Everything above was conditional on it. The first spike came back INVALID, and going back to §2 narrowed the design to prospect (Appendix B). If this spike fails, Marginalia (§2.E) is the fallback, and it needs its pool-reuse spike first. C's windows would still need a projection spike.
2. **Sliders on the ground.** Dewpoint and altitude still exist server-side. Should open-ground prospects honour dewpoint, or should distance from your clusters *be* the dewpoint (stranger the further you walk from your words)? The second is more on-premise and unmeasured.
3. **Freehand loops as explicit clusters.** Proximity is the only cluster signal today. A drawn loop is a clearer one, and it is where perfect-freehand would earn its place.
4. **Pan/zoom (M3).** The ground is a fixed 1200 × 420 plane. That is fine for dozens of words. At hundreds it needs pan and zoom, and zoom-as-altitude from SPEC M3 is the obvious binding.
5. **Push (M4).** §3 has the shape. It is not built.

---

## Appendix A — fresh-context review, and what was done

A subagent with no build context reviewed the slice. It read the code, used the capture bundle (the screenshots, the run log, and `gates.txt`), and drove the running server itself. It followed the house critic rubric (`scripts/critic-prompt.md`), adapted to this surface. It scored **mechanic 6, guardrails 3, evidence 5, UX 5, code quality 6**, and failed the slice.

For each finding: what it was, what was done, and how the fix was verified.

| # | finding (severity) | blocks merge? | action | verified by |
| --- | --- | --- | --- | --- |
| 1 | **CAP = 14 was not enforced for dew.** Overlapping prospects reached 40 on screen (blocker). | yes | `makeRoom` covers the whole budget: fading words count, and oldest sky then oldest dew are retired on a 0.25 s fade. One gesture is in flight at a time. Restore from the evaporated trail takes a slot like any sky word. | Property test over every live/fading/incoming mix. Browser: 10 rapid prospects peak at **14** (26 before the fast-retire fix, 40 in the review). |
| 2 | **A failed pin made a word immortal** (major). | yes | `pinFailed` re-arms the evaporation clock, or finishes a fade already in progress, and says so in the hint line. Applies to both sky and dew. | Browser: with `/pin` forced to 500, the word was gone after 11.5 s and the hint explained why. |
| 3 | **Unpinned words lingered in storage, and a re-pin resurrected their threads** (major). | yes | Scene words are keyed to the anchor's `pinnedAt`. The prune is written back on read, and a re-pin lands fresh. Spec §5 was corrected: the ground *does* keep a record, and the record is pruned. | Unit tests for re-pin, duplicate entries and write-back equality. API run: thread before 1, after re-pin 0, new position. |
| 4 | **The spike's control could not fail** (major). | yes (before any real run) | Removed. Replaced with a position-bias **validity gate** that makes the run INVALID; it has tests, and the offline coin-judge run tripped it. The pass bars were re-registered before any real data existed. | `test/ground-judge.test.ts` › *calls a position-driven judge INVALID*. |
| 5 | **The bridge trial could not tell a bridge from a hub** (major). | yes (before any real run) | Added a hub arm (the pool's most central word): four options, chance 1/4. A pass requires ≥ 9/18 **and** more choices than the hub. | Tests for `verdict` and `centrality`. |
| 6 | **Keyboard: the menu was unreachable, and prospect only worked at the centre** (major). | yes | The menu takes focus when it opens, arrow keys cycle it, and Esc/Tab close it and return focus to the word. Added **condense beside**, a prospect beside the selected word, which is the keyboard's cluster gesture. | Browser: Enter puts focus on "condense beside", ArrowRight moves to "thread to…", Enter condenses 5 dew words. |
| 7 | **Wrong p-values and overstated claims** (minor). | no | Exact tails (0.0144, 0.0193) are now asserted by tests. The spike now drives the shipped path (`planProspect`, `drawRanked`, `planBridge`, `planScore`). The Hugging Face claim is corrected (API reachable, CDN 403). The Excalidraw probe is committed. `TASKS.md` §1 records the spot-checks. The plan's N10 points here. | Re-read; `binomTail` test. |
| 8 | **Unlabelled constants; the open-mode comment overstated** (minor). | no | Every layout and timing constant is labelled UNMEASURED at its definition. The open-mode comment now says "stranger-first, the far field". | Re-read. |
| 9 | **Overlaps, clipping, small tap targets, wrong 409 hint** (minor). | no | Sky placement accounts for drift and skips a tick rather than overlap. Threads meet word edges on screen and in the export. The mobile empty state is left-aligned, with a "more ground →" cue. Coarse pointers get 44 px targets. The 409 hint now matches `thread-cap` or `unknown-word`. | Re-shoot (assets updated). |
| 10 | **Client races; the DO shell and routes are untested** (minor). | no | Fixed: deferred refresh waits for in-flight scene requests; release checks its unpin; bridge marks persist across renders; network errors are caught. **Still open:** there are no route-level or DO-level tests. The repo's vitest has no Workers runtime, and adding one is its own decision. The write-back prune rule it would catch is covered at the pure level. | — |

---

## Appendix B — the INVALID run, and prospect only (2026-09-25)

**The run.** The first spike ran on 2026-09-24 against Workers AI: 63 requests plus 1 probe, through wrangler's remote AI binding. It came back **INVALID**. The bridge judge picked display position 2 in 10 of 18 trials, and the pre-registered gate is ≥ 10. The pre-registered rule said FAIL or INVALID sends the design back to §2. Readings are recorded as information only, and none overrides the verdict:
- attribution 13/18 (bar ≥ 11, P = 0.0009), with answer positions 7/6/5;
- bridge 3/18, with the hub picked 5 times;
- top-10 Jaccard 0.149;
- echo 0/90.

Full output: [the measurement](../../measurements/2026-09-24-sky-and-ground-spike.md).

**The decision.** We went back to §2, but let the run narrow the choice instead of starting over:
1. **Prospect is the candidate.** It still needs its own pre-registered pass on fresh data. The 13/18 above is not that pass: the run's combined gate decided its verdict, and using its data to validate a split chosen afterwards would be post-hoc.
2. **The bridge is dropped as a way of generating words.** Threads stay on the ground as arrangement and in the `.excalidraw` export. They condense nothing.
3. **Marginalia (§2.E) is the fallback** if the prospect-only spike fails. It is not built now.

**Why the bridge was dropped, not retried.** The bridge trial is where the instrument broke. A judge that answers by position is a sign that the options did not separate for it. The readings fit that: the bridge arm was chosen 3 times in 18, below the 4.5 expected by chance, and the generic hub was chosen more often. §6 had already named the structural worry: `min(cos)` favours central words, so a bridge tends to collapse onto a hub. Retrying would mean tuning the score, the arms or the prompt *after* seeing this data. That is exactly the forking-paths move the pre-registration exists to forbid, and a second attempt would inherit the doubt. The bridge was also a second unmeasured claim riding on the ground. Without it the ground makes one claim, which one spike can test. Threads keep their value without the claim: they are how a person shows that two words belong together, and they survive the export to Excalidraw as bound arrows.

**What changed on `ground-prospect-only`.**
- *De-scope.* The following were removed end to end: the thread's mark button and its CSS; `bridge()` and its hint copy; `POST /api/session/:id/ground/bridge` and `parseBridgeBody`; `SessionDO.groundBridge`; `planBridge`, the bridge arm of `DrawPlan`/`planScore`, `bridgeScore` and `BRIDGE_COUNT`; and `threadMid`, which was dead without the mark. Threads, prospect, condense beside, open ground and `pruneToAnchors` are unchanged. A new test shows that a thread does not change what a prospect plans.
- *The historical instrument still runs.* `scripts/ground-spike.ts` carries a frozen verbatim copy of the removed bridge code as of `5bceb03`. Its `--fake` output is byte-identical to the run recorded in the measurement doc (69/69 lines).
- *The prospect-only spike.* `npm run ground-prospect-spike` uses three fresh seeds with hand-written notes. In each seed, groups 1 and 3 sit on neighbouring sub-themes and are laid out as the two outer clusters, 800 units apart. It drives the same shipped path and the same blind judge. The bars were pre-registered in `scripts/ground-prospect-judge.ts` before any real run:
  - attribution ≥ 11/18;
  - top-10 Jaccard ≤ 0.25;
  - INVALID if any position gets ≥ 12/18.

  One deliberate change from the first spike: the Jaccard bar covers only the **non-neighbour** pairs. The neighbouring pair overlaps by design, which is not hubness, so it is printed as a diagnostic next to attribution on the neighbouring groups. [Measurement (PENDING)](../../measurements/2026-09-25-ground-prospect-spike.md).
- *Re-shoot.* `scripts/ground-shots.mjs`, run against a fake-AI server (`scripts/dev-offline.mjs`), passes 6/6 checks. It shows a thread with no mark and dew from condense beside. CAP = 14 holds under 10 rapid prospects (budgeted peak 14; the raw element count briefly reached 24 during 0.25 s retire fades; see §4). No pinned word is lost, there is no horizontal scroll at 390 px, and no sky word drifts under reduced motion. The screenshots in the asset folder were replaced.

**Result (2026-09-26): FAIL.** The prospect-only spike ran complete, using 45 requests; an earlier attempt aborted on a transient binding error and is not counted.
- Attribution: 10/18, against a bar of ≥ 11.
- Validity: answers by position went 3/11/4, under the gate of 12.
- Hubness: non-neighbour Jaccard 0.172, a pass.

Under the pre-registered rule, the slice is not merged, and Marginalia (§2.E) becomes the candidate, starting with its pool-reuse spike.

The readings below were not pre-registered and do not change the verdict:
- The first burst (ranks 1–5) was right 7 of 9 times. The second burst (ranks 6–10) was right 3 of 9 times.
- The neighbouring groups (7/12) did better than the odd-one-out groups (3/6). A seed-only pool can hold too little for a cluster to pull, and re-ranking cannot add what is not there.
- The judge leaned toward display position 2 in both spikes.

[Measurement](../../measurements/2026-09-25-ground-prospect-spike.md).
