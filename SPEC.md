# dewpt

An ambient ideation canvas where words and phrases condense out of "latent space" — popping in and out of a field based on what's visible, where the user prospects blank space, and how they set semantic sliders. Play, not productivity software. The name is the meteorological abbreviation for dew point: the threshold where invisible vapor becomes visible. Inspired by Kevin Kelly's "Latent Space as a New Medium" (July 2026), specifically the white-space-discovery and prototyping-via-direction ideas.

## Vocabulary

The UI and API speak weather; this table maps each term to the underlying concept so nobody gets confused. Use the weather term in all user-facing copy, API params, and schema keys. The concept column is for reasoning and for LLM generation prompts (where "strangeness" is clearer to the model than "dewpoint").

| Weather term | Concept |
| --- | --- |
| **dewpoint** (slider) | strangeness: temperature + target embedding distance from seed/anchors. Low = only the obvious condenses; high = far-field vapor precipitates. |
| **altitude** (slider) | abstraction axis: concrete tactics ↔ underlying concepts (already on-theme, unchanged) |
| **drizzle** (slider) | flux: spawn rate only; no generation effect |
| **condensate** (tray) | the harvest: pinned words collected for export |
| **evaporated** (sidebar) | ghost trail: last 20 expired words, recoverable |
| condense / evaporate | spawn / decay (verbs in copy and code comments) |

## Reference implementation

`demo/dewpt-demo.html` is a single-file static demo that establishes the target *feel*: spawn/decay animation, depth (size/blur/opacity by z), tier coloring, pulse-on-prospect, pin-to-condense, slider behavior. It fakes generation with pre-baked word pools. The production build replaces the pools with live LLM generation; the interaction model and aesthetic should carry over.

## Core loop

1. User enters a **seed** (a topic phrase). The field begins condensing words/phrases related to it.
2. Words fade in at random positions, live 5–10 s, fade out. The field never sits still.
3. **Click blank space** → "prospect": a pulse ring, then a burst of 4–5 words near the click, drawn slightly stranger than the ambient rate.
4. **Click a word** → pin it. Pinned words crystallize (stop decaying, gold, dotted underline) and join the **condensate** tray. Pinned words become anchors that bias all future generation.
5. **Sliders** shape the sampling distribution:
   - **dewpoint** — strangeness: temperature + target embedding distance from seed/anchors
   - **altitude** — abstraction axis: concrete tactics ↔ underlying concepts (hypernym ladder)
   - **drizzle** — spawn rate only; no generation effect
6. Condensate tray: chips, remove, copy list. Later: export as markdown / send to a Loomwiki page.

## Architecture (Cloudflare)

- **Pages** — static client (vanilla or lightweight framework; the demo is vanilla and that's fine for MVP)
- **Worker** — API: `POST /session`, `GET /session/:id/pool`, `POST /session/:id/pin`, `POST /session/:id/prospect`, `PATCH /session/:id/params`
- **Durable Object** per session — holds seed, slider params, pinned anchors, candidate pool, dedupe set. Alarm-driven background regeneration.
- **Workers AI** — embeddings (`bge-m3` or `bge-base-en-v1.5`) for candidate words; used for dedupe, distance-from-seed scoring, and (later) 2D projection
- **LLM generation** — Workers AI text model (DECIDED: keep everything on-platform, zero external API keys). Use the strongest available instruct model; batch 20–30 candidates per call. Because smaller models are weaker at "far-field but still meaningfully connected," invest in the prompt: give 2–3 few-shot examples per strangeness band, and consider two-pass generation at high strangeness (generate remote concepts first, then bridge them back to the seed). Budget extra time for calibration.
- **Vectorize** — optional at MVP (in-DO cosine over a few hundred vectors is fine); needed when sessions persist/grow

### The latency trick (critical)

Pop-in must feel instant; generation takes seconds. Decouple them:

- DO maintains a **pool** of ~60 scored candidates per (dewpoint-band × altitude-band) bucket.
- Client drips from the pool locally; requests refills when a bucket runs low.
- Slider moves / pins **invalidate lazily**: old pool keeps serving while the DO regenerates in the background (alarm). Never block the field on generation.
- Prospect requests can be served from the pool immediately (pick candidates whose embeddings sit between the anchors nearest the click) with a background top-up.

## Generation prompt (starting point)

System: you generate single evocative words and short phrases (1–5 words) related to a seed topic, at a specified strangeness (0 = obvious/adjacent, 1 = far-field/surreal but still meaningfully connected) and altitude (0 = concrete, specific, actionable; 1 = abstract concepts and principles). Return JSON array of strings only. No duplicates of the provided exclusion list. Anchors, if given, should tilt the flavor of results without being repeated.

Inputs per call: seed, strangeness float, altitude float, anchors[], exclude[] (recent + visible + pinned), count.

Post-process in the DO: embed all candidates, drop near-duplicates (cosine > 0.92 vs pool/exclusions), score distance-from-seed, bucket, store.

## Pool schema (DO storage)

```
session: { id, seed, params: {dewpoint, altitude, drizzle}, createdAt }
anchors: [ { text, tier, embedding, pinnedAt } ]
pool: { [bucketKey]: [ { text, embedding, seedDist, generatedAt } ] }
evaporated: ring buffer of last 20 expired words (recoverable from the evaporated sidebar)
exclude: LRU set of last ~300 served texts
```

## Milestones

1. **M1 — live field**: seed input, Worker + DO, pool generation via Workers AI, drip client. Demo aesthetic preserved. Evaporated sidebar.
2. **M2 — real prospecting**: prospect draws candidates by embedding position relative to nearby on-screen words, not just a dewpoint bump.
3. **M3 — infinite canvas**: pan/zoom (viewport = conditioning set; zoom level drives altitude automatically, retiring the altitude slider for navigation). Words get persistent coordinates from a 2D projection of embeddings.
4. **M4 — multiplayer**: DO already gives session state; add WebSocket fan-out. Two cursors prospecting one field.
5. **M5 — export**: condensate → markdown, or push to a Loomwiki page.

## Non-goals (MVP)

- Accounts/auth (session URL is the session)
- Mobile-first (desktop pointer interaction is the core; make it not-broken on touch)
- Editing words in place
- True embedding-space canvas coordinates before M3

## Design guardrails

- The field must never freeze or visibly "wait for the AI" — pool depth is a correctness requirement, not an optimization.
- Ephemerality is the point: unpinned words evaporate. The evaporated sidebar is the only mercy.
- Dewpoint tiers keep their color language: pale slate → lilac → warm ember; pinned = gold.
- Respect prefers-reduced-motion (fade only, no drift).
