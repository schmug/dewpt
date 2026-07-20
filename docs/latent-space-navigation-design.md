# Latent-space navigation — design

**Status:** proposed · **Date:** 2026-07-20 · **Spike:** validated (see [Evidence](#evidence-the-axis-spike))
**Scope:** Adds a second way to inhabit the field — a **map** with axes the user names — plus a pasted-notes corpus to give the map terrain. Companion to [SPEC.md](../SPEC.md), which this extends rather than replaces. Teaching these interactions is out of scope here ([#7](https://github.com/schmug/dewpt/issues/7)'s territory); so is explaining the concept ([#6](https://github.com/schmug/dewpt/issues/6)).

## TL;DR — recommendation

Four decisions (lettered by workstream, **not** in build order — see [Sequencing](#sequencing)):

1. **Two modes, one session.** Weather mode (today's ephemeral field) and **map mode** (persistent coordinates) are views onto the same session state. Ephemerality survives as a *rendering* property of weather mode, not a property of the data. → workstream **A**
2. **Pasted notes, session-scoped.** Paste text, chunk it, embed it in the DO, and it dies with the session. No accounts, no Vectorize, no new non-goals broken. → workstream **B**
3. **User-named axes, expanded to phrases.** The user types a pole term; we expand it to a descriptive phrase with the LLM before embedding. This is not a refinement — the spike shows bare words *fail*. → workstream **C**
4. **Fog of war.** Corpus chunks are lit terrain; generated space is dark until prospected, then permanently lit. → workstream **D**

**Build order: C → A → B → D.** Axes first, because that is the mechanic everything else decorates, and it needs no new infrastructure — see [Sequencing](#sequencing).

**This document describes more than one implementation plan's worth of work.** Each workstream below is intended to become its own spec → plan → PR cycle. Workstream C alone is a reasonable first plan.

---

## The idea

Kevin Kelly's "Latent Space as a New Medium" frames latent space as somewhere you *go*, not something you query. dewpt today does the ambient half of that: words condense out of vapour and evaporate. What it lacks is **place** — nothing has a location, so there is nowhere to return to and no way to know what you haven't seen.

The four decisions above add place without abandoning weather. The user pastes their notes, names the dimensions they care about, and gets a landscape of their own thinking with the edges visible — and the interesting part is what condenses just past those edges.

### Why this doesn't break the ephemerality guardrail

[SPEC.md:88](../SPEC.md) says *"Ephemerality is the point — unpinned words evaporate."* Map mode appears to contradict this. It doesn't, because **fog is weather.** In map mode, words still evaporate; what persists is the *lit region* — the record of where you've explored, not the words themselves. Returning to a lit patch re-condenses fresh words there. The map remembers places, not contents.

This is the reconciliation the whole design rests on. If a future change makes map mode remember *words*, the guardrail is genuinely broken and this reasoning no longer applies.

---

## Evidence: the axis spike

The load-bearing assumption was that projecting `bge-m3` embeddings onto a user-named axis yields a *meaningful ordering*. This was tested offline before any design was committed: ~75 hand-labelled words across three axes, scored by AUC (probability a random positive outranks a random negative; 1.0 perfect, 0.5 chance).

**Result: validated, with one condition.**

| axis phrasing | concrete↔abstract | practical↔mystical |
| --- | --- | --- |
| bare words (`"concrete"` ↔ `"abstract"`) | 0.640 | 1.000 |
| synonyms (`"tangible"` ↔ `"conceptual"`) | 0.790 | 0.810 |
| two-word (`"physical object"` ↔ `"abstract idea"`) | 0.750 | 0.950 |
| **descriptive phrase** | **0.980** | **1.000** |

Descriptive phrase = `"a physical object you can touch"` ↔ `"an abstract idea or principle"`.

Three findings:

- **Pole pairs beat single terms.** Axis = `embed(pos) − embed(neg)`, scored by cosine: mean AUC 0.843 vs 0.763 for a single-term axis.
- **Descriptive phrases are required, not preferred.** Bare words swing 0.640–1.000 depending on which word you happen to pick; phrases scored ≥0.98 on both axes and never degraded a healthy one.
- **Mean-centering is worthless** (0.850 vs 0.843 — noise). Do not build it.

**Why bare words fail: polysemy of the axis term.** `embed("concrete")` is contaminated by the building material, so the axis silently became *building-materials ↔ ideas*. The tell was in the ranking: neutral distractors "porcelain" and "linoleum" took the negative pole while the labelled positive "essence" (perfume) sank to the bottom.

**Caveat on the method.** The spike also counted "neutral distractors reaching the poles," but that metric was flawed — unlabelled words have genuine positions on these axes (a *referendum* really is abstract), so intrusion there is not necessarily error. The AUC figures are sound; that column is not.

Both harnesses are committed alongside [scripts/calibrate.ts](../scripts/calibrate.ts) so every number above is reproducible and the expansion prompt can be re-measured when it is tuned:

- **`npm run axis-spike`** ([scripts/axis-spike.ts](../scripts/axis-spike.ts)) — single vs. pair vs. mean-centered axis construction across three axes. Source of the 0.763 / 0.843 / 0.850 means.
- **`npm run axis-phrasing-spike`** ([scripts/axis-phrasing-spike.ts](../scripts/axis-phrasing-spike.ts)) — the four phrasings of each pole. Source of the table above, and the test of the polysemy hypothesis.

Like `calibrate`, both talk to Workers AI over REST from node, so they are unaffected by the local `wrangler dev` egress issues.

---

## Core mechanic: position is the query

The single idea that unifies all four workstreams:

> **Where you are standing in axis-space is what gets generated.**

The user names 2–3 axes. Each axis gets a slider, and the slider is **your position along that axis** — not a weight, not a filter. Your position is a point in the space. That point does three jobs at once:

1. **Layout** — every word's coordinates are its projection onto the named axes.
2. **Focus** — words near your position render sharp; distant ones fade. This replaces the fake `Math.random()` depth at [field.js:62](../public/field.js) with a real one.
3. **Generation target** — the pool generates for *where you are*, so walking the axis genuinely changes what condenses.

This is what makes it a medium rather than a filter: moving the slider doesn't hide words, it takes you somewhere and new things condense around you. It also preserves the original "add or subtract that vector" instinct — moving along an axis *is* adding the vector — while sidestepping the arithmetic the spike warned about, because it's projection, not analogy.

### Consequence: the wire format stays small

Because axes are fixed once named, **slider movement never re-projects anything.** The server computes each word's coordinates once and sends `{text, tier, x, y, z}` — a few extra floats per word. The client can drag sliders at 60fps with no round trip.

Re-projection happens only when an axis is *renamed*, which is a deliberate, infrequent act that can afford a round trip and a visible re-layout animation.

This matters because today the client receives **text only** ([pool-client.js:24](../public/pool-client.js), consumed at [field.js:50](../public/field.js)). Shipping raw 1024-dim embeddings to the client would be ~245 KB per bucket; shipping three floats is nothing. **Do not put embeddings on the wire.**

---

## Workstreams

### A. Two modes

Weather and map are two renderers over one session. Weather mode is [field.js](../public/field.js) unchanged. Map mode is a new sibling module.

| | weather mode | map mode |
| --- | --- | --- |
| position | random ([field.js:74](../public/field.js)) | projected onto named axes |
| depth | `Math.random()` ([field.js:62](../public/field.js)) | distance from your position |
| lifetime | 5–10 s TTL, evaporates | same — words still evaporate |
| persists | nothing | the lit region only |

Shared, mode-independent state: seed, params, anchors/pins, condensate tray, evaporated ring buffer. A pin made in one mode is a pin in the other.

**Map mode requires axes to exist**, so it is unreachable until the user names at least one. The empty state is the axis-naming prompt — which conveniently makes workstream C the tutorial for workstream A.

### B. Pasted notes corpus

Paste-only, session-scoped. Chunk on arrival, embed in the DO, store alongside the pool. Dies with the session.

- **Chunking:** paragraph-ish, target ~200 chars. Chunks are the map's terrain; they are *not* candidates and never condense as words.
- **Scale:** a few hundred chunks. In-DO cosine ([pool-core.ts:26](../src/pool-core.ts)) handles this; Vectorize stays deferred per [SPEC.md:41](../SPEC.md).
- **Embedding cost:** `embedTexts` already chunks at 96/call ([generation.ts:213](../src/generation.ts)). A few hundred chunks is a handful of calls — but it is *not* instant, so ingestion needs real progress feedback, unlike everything else in dewpt.
- **Effect on generation:** corpus chunks join the anchor set as soft conditioning. The seed remains the primary handle.

`MAX_TEXT_CHARS = 64` at [index.ts:11](../src/index.ts) governs single words and must not be reused for the paste endpoint — that needs its own, much larger limit plus a hard cap on total pasted bytes.

### C. User-named axes

The mechanic from the spike. An axis is:

```
{ id, negTerm, posTerm, negPhrase, posPhrase, negVec, posVec, assignedTo: 'x'|'y'|'z' }
```

**Flow:** user types a pole term → LLM expands it to a descriptive phrase → phrase is embedded → axis vector is `posVec − negVec` → every pooled word's coordinate on that axis is `cosine(wordVec, axisVec)`.

**The expansion step is mandatory, not a nicety** — it is the difference between AUC 0.640 and 0.980. It also earns its own UI: **show the expansion and let the user edit it.** That is both the quality mechanism and the escape hatch when an axis comes out wrong, and it teaches what the axis actually means without a tutorial.

Expansion uses the existing text model ([generation.ts](../src/generation.ts) already wires it up). Prompt goal: turn a bare term into an unambiguous descriptive phrase of the form *"a physical object you can touch"* — concrete, disambiguated, ~4–8 words.

**Axes subsume the built-in sliders.** `altitude` is exactly the `concrete ↔ abstract` axis the spike measured at 0.980. Once user-named axes work, altitude becomes a *preset axis* rather than a separate concept — which is also what [SPEC.md:74](../SPEC.md) predicted when it said zoom would retire the altitude slider. Do not do this collapse in the first plan; note it and revisit.

### D. Fog of war

Corpus chunks project into the same axis-space as words. Their density defines the lit region: your notes are terrain, generated space is dark.

- Prospecting into the dark condenses words there and lights that patch **permanently** for the session.
- The lit region is the only thing map mode persists.
- Renaming an axis re-projects everything, which **invalidates the fog** — the lit region was defined in the old coordinates. Either re-project the lit patches too, or reset the fog and say so. This is a real design problem, not an implementation detail; it is listed as open below.

Fog belongs last: it is the least load-bearing and the most dependent on the other three.

---

## Sequencing

**C → A → B → D.**

Workstream **C** first because it is the mechanic everything else decorates, and every word in the pool already carries an embedding ([types.ts:22](../src/types.ts)) — so axis projection needs no new storage, no corpus, and no new model. It is the shortest path from here to a thing that demonstrably works.

**A** second: with axes real, map mode is a renderer over coordinates that already exist.

**B** third: the corpus is mostly plumbing, and it is more compelling once there is a map to put it on.

**D** last, for the reasons above.

Rejected alternative — corpus-first — would build ingestion infrastructure to serve a mechanic that hadn't been validated. The spike removed that risk for C but not for B.

---

## Testing

Existing suites are `vitest` over pure core logic ([test/pool-core.test.ts](../test/pool-core.test.ts), [test/generation.test.ts](../test/generation.test.ts)) with AI faked via [dev-fake-ai.ts](../src/dev-fake-ai.ts), whose deterministic pseudo-embeddings make projection testable without network.

- **Projection math** — unit tests for axis construction and coordinate assignment against fixed vectors. Pure functions, no AI.
- **Expansion prompt** — parse/shape tests like the existing generation tests; *quality* is measured by the promoted `scripts/axis-spike.ts`, not by unit tests.
- **Chunking** — deterministic unit tests on chunk boundaries and byte caps.
- **Wire format** — assert coordinates are present and embeddings are **absent** from `/pool` responses. This is a regression guard for the 245 KB mistake.
- **Ephemerality guard** — a test asserting map mode does not persist word *contents* across evaporation, encoding the [SPEC.md:88](../SPEC.md) reconciliation.

---

## Open questions

1. **What are the axes before the user names any?** Options: default to seed-distance × altitude (reuses existing concepts, always available), lock map mode until an axis is named (clean, but a dead-end empty state), or auto-propose axes from the corpus. Leaning toward the first as a default with the third as a later affordance.
2. **Does a 2–3 axis layout read as a *place*?** The spike proved one axis orders correctly. It did not prove three axes produce a legible map — words may clump in the middle since most words are neutral on most axes. This is a visual-legibility question best answered by a rendered prototype, not another offline script. **Biggest remaining unknown.**
3. **How is the third axis navigated?** A z-slider, or actual 3D camera orbit? Neuronpedia does orbit; dewpt's aesthetic may be better served by depth-of-field on a 2D plane. Affects whether this needs WebGL at all — everything today is DOM spans.
4. **Fog under re-projection.** See workstream D.
5. **Does the corpus condense as words?** Current answer: no, chunks are terrain only. But "surface a phrase from my own notes I'd forgotten" is arguably the strongest brainstorming feature on offer, and it contradicts that answer.

---

## Non-goals

- Accounts, auth, or any cross-session persistence ([SPEC.md:80](../SPEC.md) holds).
- Vectorize. In-DO cosine is sufficient at this scale ([SPEC.md:41](../SPEC.md)).
- File upload, folder import, or third-party sync (Obsidian, Readwise). Paste only.
- Editing corpus text in the app.
- Retiring the `dewpoint` / `drizzle` sliders. Only `altitude` is implicated, and not in the first plan.
- Multiplayer on the map ([SPEC.md:75](../SPEC.md) M4 is unaffected and unaddressed here).
