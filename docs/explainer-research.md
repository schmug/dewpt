# Explaining dewpt to a first-time visitor

Research for [#6](https://github.com/schmug/dewpt/issues/6): how does dewpt explain **the idea** —
what this thing is, why words keep disappearing, what the weather vocabulary means — to someone
who arrives cold?

Companion research on teaching the *interactions* (prospect, pin, sliders) is
[#7](https://github.com/schmug/dewpt/issues/7) and stays out of scope here. Where the two surfaces
touch (the hint line, the empty states), this document only claims the *concept* layer.

## The problem

Everything that makes dewpt make sense lives in `SPEC.md`, which visitors never see:

- the one-paragraph concept ([SPEC.md:3](../SPEC.md)) — ambient ideation canvas, words condensing
  out of latent space, play not productivity, inspired by Kevin Kelly's *Latent Space as a New Medium*;
- the weather vocabulary table ([SPEC.md:9-16](../SPEC.md)) — dewpoint/altitude/drizzle/condensate/evaporated;
- the core loop ([SPEC.md:24-32](../SPEC.md)) — seed → condense → evaporate → prospect → pin.

The client, meanwhile, says almost nothing:

| Surface | Copy | Where |
| --- | --- | --- |
| Seed placeholder | "seed the field with a topic…" | [public/index.html:16](../public/index.html) |
| Pre-seed hint | "enter a seed to begin condensation" | [public/index.html:23](../public/index.html) |
| Post-seed hint | "click blank space to prospect · click a word to pin it" | [public/app.js:97](../public/app.js) |
| Tray empty state | "nothing has condensed yet — click words that catch you" | [public/index.html:51](../public/index.html) |
| Sidebar empty state | "nothing has evaporated yet" | [public/index.html:27](../public/index.html) |

Two consequences for a cold visitor:

1. **The pre-seed screen is dead space.** A dark rectangle, one hint line, three cryptically named
   sliders. Notably, the reference implementation never had this problem: `dewpt-demo.html` boots
   with a hard-coded seed and is condensing words within a second of load. The production client
   introduced the cold state when it added real seed entry. The current empty state is a regression
   from the demo's own first impression.
2. **Ephemerality reads as a bug.** The spec is explicit that "unpinned words evaporate; the
   evaporated sidebar is the only mercy" ([SPEC.md:88](../SPEC.md)) — but a visitor who was never
   told this watches their words vanish and concludes the app is broken or hostile. The single
   deliberate design choice most in need of framing gets none.

## Prior art: how ambient toys introduce themselves

Surveyed via web research (July 2026). What each does at first load:

1. **[Patatap](https://patatap.com/)** (Jono Brandel) — a bare gray screen and no instructions at
   all; the toy teaches itself the instant you press any key, and sound + animation is the entire
   explanation. Works because the mechanic is one action with instant feedback — dewpt's concept
   (latent space, seeds, ephemerality) is not self-evident from a single click.
2. **[Blob Opera](https://artsandculture.google.com/experiment/blob-opera/AAHWrq360NcGbw)**
   (David Li / Google Arts & Culture) — a few seconds of guided demonstration: the first blob
   appears with a drag gesture shown in-world, you imitate it, and the remaining blobs join;
   it *demonstrates* rather than describes, then gets out of the way.
3. **[Infinite Craft](https://neal.fun/infinite-craft/)** (Neal Agarwal) — the closest cousin: an
   LLM-backed word toy with zero tutorial. Four starter elements sit in a sidebar and the drag-to-
   combine mechanic is discovered in seconds. Notably it needs no concept framing — "crafting game"
   is a genre visitors already know, a luxury dewpt does not have.
4. **[Silk](http://weavesilk.com/)** (Yuri Vishnevsky) — a one-screen invitation to draw plus a
   persistent, unobtrusive **`?` help affordance in the corner**; the generative art explains
   itself, the `?` carries everything else (controls, credits) for whoever wants it.
5. **[Every Noise at Once](https://everynoise.com/)** (Glenn McDonald) — an intimidating wall of
   genre-words defused by one plain paragraph embedded at the top of the field itself: "an
   ongoing attempt at an algorithmically-generated, readability-adjusted scatter-plot of the
   musical genre-space…", including a gloss of its own axes. Proof that one resident paragraph can
   make a strange word-field legible without any interstitial.

Also noted: **[ambient.garden](https://ambient.garden/)** (an algorithmic audio landscape) starts
playing its landscape immediately — autopilot wanders the space for you until you take the controls,
i.e. the work demonstrates itself before asking anything of the visitor.

**The pattern:** none of these gate the experience behind an explanatory wall. The strongest ones
(1, 2, 6) let the toy demonstrate itself immediately, and the ones with real conceptual or
navigational depth (4, 5) park a persistent, opt-in explainer *inside* the experience. dewpt needs
both halves: demonstration for the mechanic, an opt-in reference for the vocabulary and the credit.

## Approaches compared

### A. Pre-seed empty state as explainer — manifesto line + the field condensing meta-words about itself

Before any seed exists, the field runs the normal spawn/decay machinery over a small **static,
client-side pool of meta-words** — words *about dewpt, in dewpt's voice* — while two short lines of
manifesto copy sit at the center. The visitor watches words condense, linger, and evaporate before
they've typed anything: ephemerality is demonstrated at zero stakes, and the first screen is alive
the way the demo always was.

- **Pros:** converts the dead space; *shows* the core mechanic instead of describing it (Patatap /
  Blob Opera / ambient.garden pattern); makes evaporation legible as designed behavior before the
  user has anything to lose; static pool means zero AI calls, zero latency, zero cost; restores
  demo parity (field alive from first paint).
- **Cons:** only reaches visitors who see the pre-seed state — anyone arriving on a shared session
  URL (`location.hash` resume, [public/app.js:154-165](../public/app.js)) skips it entirely; carries
  at most ~2 lines of resident copy, so it cannot hold the glossary or the credit; meta-words must
  be visually identical to real output to avoid teaching a false mechanic (they use the same tiers
  and timings — that fidelity is the point).

### B. An "about" affordance — small "what is this?" toggle opening a non-modal panel

A low-key affordance in the header (`?` glyph plus the words "what is this?") opens a **non-modal**
panel — same visual family as the evaporated sidebar — holding the concept paragraph, the weather
glossary, and the Kevin Kelly credit. The field keeps condensing behind and beside it; the panel is
dismissable by toggle, close button, or `Esc`, and never takes a backdrop.

- **Pros:** persistent — available at any moment of confusion, including mid-session and for
  shared-URL arrivals who never saw the empty state; the only surface roomy enough for the glossary
  and the credit without cluttering the field; opt-in, so its ambient cost is one small header link
  (Silk's `?`, Every Noise's resident paragraph); trivially implementable in the existing
  vanilla-JS + CSS stack.
- **Cons:** opt-in means many visitors never open it — it cannot be the *only* explainer; the
  affordance itself must be discovered (mitigated by labeling it "what is this?" rather than a bare
  `?`); requires discipline to keep non-modal (no overlay, no pause).

### C. First-run overlay / interstitial

A one-time card ("welcome to dewpt…") shown before the field starts, dismissed to enter, with a
`localStorage` flag to never show again.

- **Pros:** guaranteed exposure — every cold visitor reads at least something; unlimited room for
  narrative.
- **Cons:** it is a wall in front of the field — precisely what the guardrails' spirit forbids: the
  experience should feel ambient, and an interstitial frames a toy as software-with-a-manual;
  it explains ephemerality by *telling* when the field one click away could *show*; first-run
  detection is fragile (new device/browser/cleared storage re-gates returning users); and none of
  the surveyed prior art in this class does it — even Blob Opera's intro is an in-world
  demonstration, not a card of text. **Rejected.**

### D. Persistent header strapline

One resident line of self-description in the header (the Every Noise at Once move), e.g. a subtitle
under the wordmark.

- **Pros:** cheapest possible; always visible, so it also reaches shared-URL arrivals.
- **Cons:** one line cannot carry latent space *and* ephemerality *and* the vocabulary; header real
  estate is already tight next to the seed form. Useful garnish, not a solution.

## Recommendation

**A + B: the pre-seed field explains itself by demonstration; a persistent "what is this?" panel
holds the full concept, glossary, and credit.** D's benefit is folded in by making the about
affordance a labeled phrase ("what is this?") rather than a bare `?` — the label itself signals
"an explanation exists" to every visitor, including ones resuming a shared session. C is rejected
outright as anti-ambient.

The two halves cover each other's gaps: A reaches everyone who arrives cold but can't hold much
copy; B holds everything but only reaches those who ask. Both are pure vanilla HTML/CSS/JS additions
with no new dependencies, and neither touches the generation path.

### Draft copy

All user-facing copy below is lowercase (matching existing copy), uses the weather vocabulary, and
glosses terms without renaming them.

#### A — pre-seed manifesto (centered in the field, replaces the dead center; bottom hint line unchanged)

> **words condense out of latent space — they linger, then evaporate.**
> pin the ones that catch you; the rest is weather.

(The existing bottom hint "enter a seed to begin condensation" stays as-is; the hint mechanism
belongs to #7.)

#### A — meta-word starter pool (static, client-side; spawns through the normal field machinery)

Tier 0 (pale slate — the obvious):

> `vapor, waiting` · `words condense here` · `then evaporate` · `unpinned words don't last` ·
> `seed it with a topic` · `ideas as weather` · `play, not productivity`

Tier 1 (lilac — stranger):

> `latent space, lightly disturbed` · `the obvious condenses first` ·
> `raise the dewpoint for stranger air` · `prospect the blank space` ·
> `a ghost trail of what faded` · `the field never sits still`

Tier 2 (warm ember — far-field):

> `invisible vapor, made visible` · `meaning precipitates` · `everything here is weather` ·
> `the map has white space — go there` · `thought, at its dew point`

The pool is a starter set — final wording is an implementation decision — but the shape is the
spec: every entry describes dewpt while *behaving* like a dewpt word, using the real tier colors
and the real spawn/decay timings, so the empty state is a truthful preview of the seeded field.

#### B — header affordance

> `? what is this?`

(small text button in the header, styled like the existing seed/label copy; `aria-expanded` toggle.)

#### B — about panel

> **what is dewpt**
>
> an ambient ideation canvas. give it a seed — a topic, a question, a half-idea — and words
> condense out of latent space: some obvious, some strange. each one lives a few seconds, then
> evaporates. that's not a bug — ephemerality is the point. pin the words that catch you and they
> crystallize, gold, into your condensate. play, not productivity.
>
> the name is the meteorological abbreviation for dew point: the threshold where invisible vapor
> becomes visible water.
>
> **the weather, glossed**
>
> - **dewpoint** — how strange the words get. low: only the obvious condenses. high: far-field
>   vapor precipitates.
> - **altitude** — how abstract. ground level is concrete tactics; high altitude is underlying
>   concepts.
> - **drizzle** — how fast new words condense.
> - **condensate** — the harvest: words you've pinned, ready to copy out.
> - **evaporated** — the ghost trail: the last twenty words that faded. click one to condense it
>   again.
>
> inspired by kevin kelly's ["latent space as a new medium"](https://kevinkelly.substack.com/p/latent-space-as-a-new-medium)
> (july 2026) — the idea that a model's space of almost-ideas is a place you can wander, and that
> the white space between the known ideas is worth prospecting.

Panel behavior: an aside in the same visual family as the evaporated sidebar (`--hair` border,
14px radius, `#171528` ground), sliding over or docking at the right edge; no backdrop; the field
keeps condensing; closes via the toggle, a close button, or `Esc`; focus management but no focus
trap (non-modal).

### Guardrail compliance ([SPEC.md:85-90](../SPEC.md))

| Guardrail | How the recommendation satisfies it |
| --- | --- |
| "The field must never freeze or visibly 'wait for the AI'" (SPEC.md:87) | The pre-seed pool is a static client-side array — no AI call, no latency, nothing to wait for; it makes the field *more* alive, not less. The about panel is additive DOM beside/over a still-running field; the spawn loop is never paused, and nothing gates entry. Interstitials (approach C) were rejected for exactly this guardrail's spirit. |
| "Ephemerality is the point: unpinned words evaporate. The evaporated sidebar is the only mercy." (SPEC.md:88) | The empty state *demonstrates* evaporation before the visitor has anything at stake, so the first real loss is expected rather than alarming; the manifesto and panel say it out loud ("the rest is weather", "that's not a bug — ephemerality is the point"). No proposed surface adds persistence or undo beyond the existing sidebar, which the glossary explains as exactly that mercy. |
| "Dewpoint tiers keep their color language: pale slate → lilac → warm ember; pinned = gold." (SPEC.md:89) | Meta-words spawn through the existing tier classes (`t0`/`t1`/`t2`) with no new colors; the pool is organized by tier so strangeness still maps to color even pre-seed. Manifesto and panel use the existing palette variables (`--label`, `--t0`, `--hair`); the panel's gloss reinforces the color language ("crystallize, gold"). |
| "Respect prefers-reduced-motion (fade only, no drift)." (SPEC.md:90) | Meta-words ride the same field machinery that already implements the reduced-motion fade-only path; they inherit it for free. The panel's slide-in degrades to a fade or instant toggle under `prefers-reduced-motion`. |

Other constraints from #6: all copy above is weather-vocabulary (glossed, never renamed); both
surfaces are plain HTML/CSS/vanilla JS with zero new dependencies, inside the demo aesthetic; both
are desktop-first and need no touch affordances.

## Follow-up implementation issues

- [#11 — Implement the pre-seed empty state: manifesto copy + self-condensing meta-words](https://github.com/schmug/dewpt/issues/11) (approach A)
- [#12 — Implement the "what is this?" about panel: concept, weather glossary, credit](https://github.com/schmug/dewpt/issues/12) (approach B)

## Sources

- Kevin Kelly, [*Latent Space as a New Medium*](https://kevinkelly.substack.com/p/latent-space-as-a-new-medium), July 2026 (also covered by [Boing Boing](https://boingboing.net/2026/07/14/latent-space-new-medium.html))
- [Patatap](https://patatap.com/) — background via [Wikipedia](https://en.wikipedia.org/wiki/Patatap)
- [Blob Opera](https://artsandculture.google.com/experiment/blob-opera/AAHWrq360NcGbw) — background via [Experiments with Google](https://experiments.withgoogle.com/blob-opera)
- [Infinite Craft](https://neal.fun/infinite-craft/) — background via [Destructoid](https://www.destructoid.com/what-is-infinite-craft-neal-funs-latest-game-explained/)
- [Silk](http://weavesilk.com/) — background via [Creative Bloq](https://www.creativebloq.com/art/weave-beautiful-patterns-light-awesome-tool-2132002)
- [Every Noise at Once](https://everynoise.com/) — background via [Wikipedia](https://en.wikipedia.org/wiki/Every_Noise_at_Once)
- [ambient.garden](https://ambient.garden/) — background via [GitHub](https://github.com/pac-dev/AmbientGarden)
