# Sky and ground — design

**Status:** slice built at `/ground/` on branch `ideation-ground`. The spike is written, and its plumbing passes offline. The **real run is pending**: this sandbox cannot reach Workers AI, so it is waiting on Cory (see [the measurement](../../measurements/2026-09-24-sky-and-ground-spike.md)). · **Date:** 2026-09-24
**Plan:** [2026-09-24-sky-and-ground.md](../plans/2026-09-24-sky-and-ground.md)
**Screens:** [assets/2026-09-24-sky-and-ground/](assets/2026-09-24-sky-and-ground/)

## TL;DR

dewpt becomes two planes:
- **The sky** is the weather dewpt already makes. Words condense out of the session pool and evaporate. Nothing there is kept.
- **The ground** sits under it. It holds only what you pin. A pinned word *falls* onto the ground, and there you arrange it by hand.

Where things sit on the ground is what condenses next:
- **Beside a cluster.** Click open ground next to a cluster and dew condenses there, drawn from what is nearby.
- **Along a thread.** Draw a thread between two words, and the mark at its midpoint asks what connects them.

Both gestures are served by **re-ranking the pool the DO already holds**. Nothing calls the model inline, so the pool-depth rule stays intact.

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

Measured by bundling a minimal page with esbuild (`--minify --splitting`):
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
| click open ground at *(x, y)* | `planProspect`: pinned words within `NEIGHBOR_RADIUS`, Gaussian-weighted → query vector → `PoolCore.drawRanked` by cosine, top `PROSPECT_COUNT` | **none** — a re-rank |
| thread A—B, press its mark | `planBridge` → rank by `min(cos(c,A), cos(c,B))`, top `BRIDGE_COUNT` | **none** |
| open ground, or anchors not yet embedded | `mode: "open"` → stranger-first draw, the field's prospect semantics | none |
| export | `toExcalidrawScene` | none |

**The ground says what it listened to.** Every ground draw returns its `basis` (the pinned words it was conditioned on). The page prints it beside the gesture ("beside night bus · last train", "between X · Y", "open ground — from the sky"). The user can see why these words condensed. The system does not ask to be trusted blindly.

**Wire:** no embeddings. Every ground response goes through `assertNoEmbeddings` (the board's structural guard, reused).

**Constants:** each is labelled UNMEASURED at its definition, except `PROSPECT_COUNT`, which inherits the field's 4–5 word burst. `NEIGHBOR_RADIUS`, `NEIGHBOR_SIGMA`, `BRIDGE_COUNT` and `MAX_THREADS` are judgement calls, and say so.

**Legibility:** sky words and dew share `CAP = 14`. Dew answers a gesture, so arriving dew retires the oldest sky words early rather than overprinting (`skyToRetire`).

**Reduced motion:** words don't fall and don't drift; they fade. The landing becomes a fade, and the pulse becomes a fade-out.

---

## 5. Ephemerality: how this squares with the guardrail

SPEC: *"Ephemerality is the point: unpinned words evaporate."* A whiteboard is permanent, so the question is real. The fog-of-war section of `latent-space-navigation-design.md` gives the test: **if a change makes the product remember *words* the user did not keep, the guardrail is broken.**

The ground passes that test by construction, not by convention:

1. **Only anchors reach the ground.** `pruneToAnchors` runs on every read *and* every write of the scene. A word that is not an anchor is dropped, along with every thread touching it. `applyGroundOp` refuses to `move` or `thread` a word that is not already there. There is no "place" verb; **only pinning puts a word on the ground.** Tests: `test/ground-core.test.ts` › *pruneToAnchors — the ephemerality guard*, and › *refuses to move or thread a word that is not on the ground*.
2. **Pinned words were already permanent.** The anchors table has always persisted pins. The ground adds *positions* for things the product already kept, and nothing else.
3. **Dew is weather.** Words condensed by a ground gesture are drawn from the pool, live 7–12 s, and evaporate into the same evaporated trail, where the one mercy still applies. They are never written to the scene. Pinning one keeps it *where it condensed*, because that place is why it condensed.
4. **Release is evaporation.** Unpinning from the ground (`release`) sends the word into the evaporated trail. It is not deleted, so it stays recoverable, exactly like a word that timed out.
5. **Unpinning anywhere empties the ground.** Unpin a word in the field and it leaves the ground on the next read, because the ground has no independent list.

**What would break it:** a "save this dew" that does not go through `pin`; a ground verb that places arbitrary text; persisting dew positions for "next time". Any of those makes the ground remember words the user did not keep. The guard test is written to fail if the first two appear.

---

## 6. What this design does not claim

The drift critic loop stopped at cycle 3 without converging, and workstream B returned a null result. These are limits on what this design is allowed to say:

- **No seed-survival claim.** Nothing here asserts that ground-conditioned dew is "still about the seed". It is drawn from a pool that was generated seed-conditioned, and that is all. (`SEED_TETHER_MIN = 0.414` has no provenance, #104. It is not used and not cited.)
- **No cosine threshold as a quality gate.** The ground ranks; it never admits or rejects by a cutoff. It has no tether floor and no arrival cosine.
- **No cheap statistic stands in for the judge.** The spike's embedding numbers (top-10 Jaccard, echo rate) are printed as *diagnostics*. The pass/fail decision rests on a blind, forced-choice judge, with thresholds registered before the first run.
- **The clusters in the spike are hand-written**, three per seed, and deliberately distinct. Real clusters may be subtler, so a pass bounds the easy case. If the real run passes, a "near-cluster" variant is the next measurement.
- **The judge is llama-3.3-70b**, the same model family as the generator. A pass means *a model can tell*, which is a proxy for *a person can tell*. It is not the same claim.
- **Axis quality is not addressed.** The ground has no axes. That is deliberate: it sidesteps the seed-dependent axis legibility that workstream B could not resolve.

---

## 7. What survives, what gets cut (recommendations; nothing deleted)

No existing surface is touched on this branch. These are recommendations for Cory to accept or not:

- **field `/app/`**: the ground can replace it as the default thinking surface. What it teaches carries over. Two of its bugs (the cold-start empty bucket, and pins vanishing on resume) are fixed *on the ground* by construction: `bucketOrder` falls back across buckets, and the ground reads pins from the anchors table. Keep `/app/` until the ground has sliders.
- **night walk `/`**: keep the atmosphere and cut the reimplementation. It should link to `/ground/` as the door, and teach the loop once, not four times.
- **board `/board/`**: retire, or rebuild on projection. Its one unique idea (lineage) lives on as the thread's bridge.
- **drift `/drift/`**: keep as the phone-first companion; fix #105–#110. Its projection mechanic is what the ground's ranked draw generalises.

---

## 8. Open questions

1. **Does the real spike pass?** Everything above is conditional on it. If it fails, go back to §2. E needs its own spike, and C's windows need a projection spike.
2. **Sliders on the ground.** Dewpoint and altitude still exist server-side. Should open-ground prospects honour dewpoint, or should distance from your clusters *be* the dewpoint (stranger the further you walk from your words)? The second is more on-premise and unmeasured.
3. **Freehand loops as explicit clusters.** Proximity is the only cluster signal today. A drawn loop is a clearer one, and it is where perfect-freehand would earn its place.
4. **Pan/zoom (M3).** The ground is a fixed 1200 × 420 plane. That is fine for dozens of words. At hundreds it needs pan and zoom, and zoom-as-altitude from SPEC M3 is the obvious binding.
5. **Push (M4).** §3 has the shape. It is not built.
