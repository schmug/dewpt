# In-context teaching of the field UI — research

**Issue:** [#7](https://github.com/schmug/dewpt/issues/7) · **Status:** decided · **Date:** 2026-07-16
**Companion:** [#6](https://github.com/schmug/dewpt/issues/6) covers explaining the *concept*; this document covers teaching the *interactions* that already exist. Nothing here explains what dewpt is.

## TL;DR — recommendation

A **three-layer combination**, in priority order:

1. **Slider endpoint microcopy** (always-on, zero motion) — persistent endpoint labels under each slider (`obvious ↔ surreal`, `concrete ↔ abstract`, `sparse ↔ dense`) plus an `aria-describedby` gloss, and surfacing the evaporated sidebar's aria-only recover hint as visible text. → [#8](https://github.com/schmug/dewpt/issues/8)
2. **Progressive hint line** (first-session teacher) — extend the existing one-shot hint swap ([public/app.js:97](../public/app.js)) into a small state machine that advances one line at a time as the user acts, then goes quiet. → [#9](https://github.com/schmug/dewpt/issues/9)
3. **`?` legend popover** (recall surface) — a quiet non-modal legend of all interactions, shared with whatever "about" affordance #6 decides on. → [#10](https://github.com/schmug/dewpt/issues/10)

**Explicitly rejected for v1:** ambient demonstration (self-triggered prospect pulse / ghost cursor). Reasons in [Mechanism 3](#mechanism-3--ambient-demonstration).

The layering logic: layer 1 fixes the worst gap (three unlabeled dials) with static text that costs zero ambience; layer 2 teaches the core loop at the moment each action becomes relevant, one line at a time, and permanently shuts up; layer 3 catches everyone who ignored layers 1–2 or comes back a week later. Each layer stands alone — they can ship independently, in order.

## Interaction inventory

Verified against `public/field.js` and `public/app.js` (not just the SPEC). The core loop at SPEC.md:24–32 matches the code; the code adds a few interactions the SPEC's loop list doesn't call out (unpin via field click, sidebar restore, copy list).

| # | Interaction | Code | Current teaching | Gap | Proposed teaching moment |
|---|---|---|---|---|---|
| 1 | **Seed** the field | form `public/index.html:15-18`; submit `app.js:126-143` | placeholder "seed the field with a topic…" (`index.html:16`); pre-seed hint "enter a seed to begin condensation" (`index.html:23`) | none — adequately taught | keep as-is (hint state H0, unchanged) |
| 2 | **Prospect** blank space — pulse ring + burst of 4 words drawn stranger (`bump 0.25`) | click handler `field.js:131-142`; bump `field.js:140` | post-seed hint line (`app.js:97`); field aria-label (`index.html:22`) | hint shares one line with pinning; nothing says the burst is *stranger* | hint state H1, right after seeding: `click blank space to prospect — a pulse of stranger words` |
| 3 | **Pin** a word — crystallizes (decay cleared `field.js:99`, gold, dotted underline), joins condensate tray | word click → `togglePin` `field.js:87,90-105` | same shared hint line; tray empty-state "nothing has condensed yet — click words that catch you" (`field.js:110`, `index.html:51`); field aria-label | crystallize-vs-evaporate contrast never stated | hint state H2, after first prospect: `click a word to pin it — pinned words never evaporate` |
| 4 | **Pins steer generation** — anchors bias tier weights locally (`field.js:21-28`) and all future generation server-side (`app.js:113` → `POST /pin`; SPEC.md:27) | `field.js:17-31`, `app.js:113` | nothing, anywhere | completely invisible; this is the mechanic that makes pinning *shaping* rather than bookmarking | hint state H3, after first pin: `pins steer what condenses next · sliders set the weather` |
| 5 | **Unpin** — click the pinned word in the field, or its `×` chip in the tray | `togglePin` first branch `field.js:91-96`; chip button `field.js:117-125` (aria-label "Remove …") | chip `×` is visually self-evident; field-click path untaught | minor — the tray path suffices | legend line only ("click a pinned word, or its ×, to release it") |
| 6 | **Sliders** — dewpoint → tier weights (`field.js:18-19`); altitude → abstraction pick (`field.js:37`); drizzle → spawn interval 2400−value·19 ms (`field.js:148`); all three PATCH session params, debounced 400 ms (`app.js:80-89`) | `index.html:31-44` | label word + live number only; effects exist solely in SPEC.md:9-16 | **the worst gap** — three unlabeled dials; a user cannot know dewpoint ≠ drizzle without moving both and guessing | endpoint labels + gloss (layer 1, always-on); pointed at once by hint H3 |
| 7 | **Evaporation happens** (passive) — words live 5–10 s (`field.js:73`), fade 1.5 s, land in sidebar | `field.js:74-86` | nothing visible (concept framing is #6's scope) | that fading is *normal* belongs to #6; that faded words are *recoverable* belongs here → #8 | see #8 (sidebar sub-line) + hint H4 |
| 8 | **Recover an evaporated word** — click a ghost to respawn it | `restoreWord` `app.js:66-71`; ghost buttons `app.js:49-55` | **aria-only**: sidebar aria-label (`index.html:25`), per-ghost aria-labels (`app.js:53`); sighted users get a hover color change (`styles.css:66-67`) and the empty-state "nothing has evaporated yet" | the issue's headline inversion: screen-reader users are told, sighted users must guess | visible sub-line under the `evaporated` heading: `click a word to condense it again` (layer 1); hint H4 on first evaporation after H3 |
| 9 | **Condensate tray: copy list** | `app.js:145-151`, button `index.html:49` | self-labeled button; "Copied" feedback on success | minor: with an empty tray the click is a silent no-op (`app.js:147`) — noted, not worth a teaching moment | legend line only |
| 10 | **Session resume** — URL hash is the session (`app.js:153-165`) | `app.js:153-165` | nothing | concept-adjacent; deferred to #6's surface | out of scope here; the hint machine must *fast-forward* on resume (see H-table notes) |

**What the demo already had** (`dewpt-demo.html`, the reference implementation): the static hint line with today's exact combined copy, the same field aria-label, the same tray empty-state — and nothing else. No sidebar, no seed form, no slider explanation. So the production client has already extended the demo's teaching surface twice (pre/post-seed hint swap, sidebar aria-labels); this proposal is the third extension of the same idiom, not a new idiom.

**Side observation (not part of this proposal):** `#field` is focusable (`tabindex="0"`, `role="application"`) and its aria-label promises click interactions, but there are no keyboard handlers and words are non-focusable `<span>`s — a keyboard-only user can be *told* about prospect/pin but cannot perform them. That's an interaction-design gap, not a teaching gap, and redesigning interactions is out of scope for #7; flagging it for a separate issue. The hint copy below deliberately says *click*, which is honest about what exists.

## Mechanisms evaluated

The axis the issue asks for: **discoverability** (does a new user actually find out) vs **ambience** (does the field still feel like weather, not software with a syllabus).

### Mechanism 1 — progressive/contextual hint line

Extend `app.js:97` into a state machine over the existing `.hint` element: one line at a time, advancing on the user's own actions, then silence.

- **Discoverability: high for the core loop.** Each instruction arrives exactly when it's actionable, and only after the previous one landed (you're told about pinning once words from *your* prospect are on screen). Sequencing also un-crowds today's line, which teaches two interactions in one 11 px breath and explains neither consequence. It can teach the invisible mechanic (#4, pins-as-anchors) that no static label can carry.
- **Ambience cost: near zero.** The element, position, size and palette already exist; the only change is that the whisper changes what it's whispering. It's `pointer-events:none`, ignorable, and — crucially — *terminates*. A user who never reads it gets today's experience.
- **Weaknesses.** Bottom-left 11 px text is missable by design; a user who never prospects never advances past H1 (mitigated by layer 1 carrying the slider knowledge regardless, and a timeout fallback on the last state). Needs a small amount of state (localStorage flag + session-derived fast-forward).
- **A11y:** the hint must become a polite live region so screen-reader users get the same sequence (details under [Guardrails](#guardrail-compliance)).

### Mechanism 2 — slider microcopy

Endpoint labels or hover/focus tooltips on the three sliders.

- **Discoverability: total, for the sliders — but only if persistent.** The hover-tooltip variant fails the exact test this issue exists for: a tooltip you must already be hovering to see is undiscoverable by the user who doesn't know the slider is worth hovering. It's also unreliable for keyboard/touch/SR users (`title` especially). **Decision: persistent endpoint labels**, with the fuller gloss carried by `aria-describedby` and the legend rather than by hover.
- **Ambience cost: the lowest of all four.** Two quiet words at each end of a track is instrument-panel labeling, not tutorial. Zero motion, zero interruption, no state, no timing. Fits the existing `--label` typographic register (uppercase micro-labels already sit on every control).
- **Weaknesses.** Endpoints alone can't explain *drizzle affects speed only, not flavor* — that nuance needs the gloss/legend. Slight visual addition to the controls row (three more label pairs); kept to two words a side.
- This layer also naturally hosts the **both-ways parity fix**: the evaporated sidebar's aria-only "click one to condense it again" becomes a visible sub-line.

### Mechanism 3 — ambient demonstration

A one-time self-triggered prospect pulse, or a ghosted cursor performing the gesture.

- **Discoverability: seductive but muddled.** "Show, don't tell" works when the demonstration is unambiguous (Koalas to the Max teaches itself because *your* cursor causes the split, instantly). Here the field **already acts on its own** — words condense with no user input every couple of seconds. A self-triggered pulse is indistinguishable from ambient behavior: the likeliest lesson is "the field pulses sometimes," not "clicking pulses." A ghost cursor disambiguates, but a fake cursor is theater — the least ambient artifact of any option considered.
- **Reduced-motion: fails closed.** Under `prefers-reduced-motion` the pulse is already suppressed entirely (`styles.css:44-45` — `animation:none; opacity:0`), so the demonstration is *invisible* to exactly those users; it would need a text fallback, i.e. mechanism 1 anyway.
- **Mechanics are awkward.** A real self-prospect fires `onProspect()` (an API write) and spends 4 words from the pool the user didn't ask for; a fake one needs a parallel code path that imitates spawn without draws. Either way it's the most code for the narrowest lesson (prospect only — nothing for sliders, pins, or the sidebar).
- **Verdict: rejected for v1.** If the H1 hint proves insufficient in practice, the cheapest honest retrofit is passive: let the *user's first real* prospect do the demonstrating, which is what H1 arranges.

### Mechanism 4 — legend/help popover

A small `?` toggling a non-modal interaction legend.

- **Discoverability: poor as a *first* teacher, good as *recall*.** The issue's own worry is right: the toggle must itself be discovered, and the users most in need of help are the least likely to try a tiny `?`. But it's the only mechanism that serves the returning user ("what did altitude do again?") and the user who dismissed everything else — teaching layers 1–2 are one-shot by design; the legend is the only place the knowledge *persists*. Prior art agrees: Silk pairs its on-canvas instructions with a persistent `?` in the corner — hint teaches, legend remembers.
- **Ambience cost: low if quiet, and only when invited.** A `--label`-palette `?` next to the controls is furniture. The popover only exists on request, floats over the controls/tray zone (never the field), and dismisses on Esc/click-away. No backdrop, no focus trap, field keeps condensing behind it.
- **Weaknesses/coordination.** #6 will probably also want a `?`/about affordance. Two help buttons would be absurd; **one shared surface**, with the legend as its interactions half, is a hard requirement (baked into #10).

### Comparison

| | Teaches | Discoverability | Ambience cost | Reduced-motion | SR parity | Verdict |
|---|---|---|---|---|---|---|
| 1. Progressive hint line | core loop incl. invisible mechanics, in sequence | high (moment-of-need) | near zero; terminates | trivially safe (text fades) | needs live region | **adopt** — layer 2 |
| 2. Slider endpoint labels (persistent) | sliders + sidebar parity | total, always-on | lowest | no motion at all | `aria-describedby` | **adopt** — layer 1 |
| 2b. Slider tooltips (hover) | sliders | poor (must hover to learn to hover) | low | n/a | weak (`title`) | rejected variant |
| 3. Ambient demonstration | prospect only | muddled (agency ambiguity) | worst (theater) | **fails closed** | needs full text fallback | **reject** for v1 |
| 4. `?` legend popover | everything, on demand | poor first-run, good recall | low (quiet, invited) | static | ordinary DOM | **adopt** — layer 3 |

## Draft microcopy

All copy uses the weather vocabulary (SPEC.md:9-16); glosses in parentheses gloss, never rename.

### Sliders (layer 1 — #8)

Visible endpoint labels, one word each side, under the track:

| Slider | Left (0) | Right (100) |
|---|---|---|
| dewpoint | `obvious` | `surreal` |
| altitude | `concrete` | `abstract` |
| drizzle | `sparse` | `dense` |

Accessible gloss per slider (wired via `aria-describedby`; also the legend text):

- **dewpoint** — `how far from the seed the vapor condenses: low, only the obvious; high, far-field and surreal.`
- **altitude** — `what kind of words condense: low, concrete and specific; high, underlying concepts.`
- **drizzle** — `how fast new words condense — pace only, it doesn't change what appears.`

The drizzle gloss deliberately carries the "no generation effect" nuance (SPEC.md:13); it's the one fact endpoint words can't convey.

### Evaporated sidebar (layer 1 — #8)

Visible sub-line under the `evaporated` heading, `.empty` register:

> `click a word to condense it again`

(Verbatim promotion of the guidance in the aria-label at `index.html:25`; the aria-label stays.)

### Progressive hint script (layer 2 — #9)

One line visible at a time in the existing `.hint` element. "Retire" = what makes the line advance.

| State | Trigger (existing hook) | Line (≤60 chars) | Retires on |
|---|---|---|---|
| H0 | initial (pre-seed) | `enter a seed to begin condensation` *(unchanged)* | session start |
| H1 | session start (`start()`, app.js:91) | `click blank space to prospect — a pulse of stranger words` | first `onProspect` |
| H2 | first prospect (`field.js:141` hook) | `click a word to pin it — pinned words never evaporate` | first `onPin` |
| H3 | first pin (`app.js:113` hook) | `pins steer what condenses next · sliders set the weather` | first slider `input`, or 30 s |
| H4 | first `onEvaporate` *after* H3 retired | `faded words rest in evaporated — click to condense again` | 20 s, or first restore |
| quiet | H4 retired | *(empty — permanently)* | — |

Notes for #9:

- **Every claim is code-verified:** "stranger" = the `0.25` bump (`field.js:140`); "never evaporate" = decay cleared + pin guards (`field.js:75,81,99`); "steer what condenses next" = anchor bias (`field.js:21-28`, `POST /pin`); H4's copy matches `restoreWord` (`app.js:66-71`).
- H4 is the only event-branch state: evaporations start ~10–15 s in, so it waits its turn behind the main track rather than interrupting it.
- H3/H4 get timeout retires so a user who explores out of order can't strand the machine; action-retires always win over timeouts.
- **Resume fast-forward:** a resumed session with `info.anchors` non-empty skips to H3; `info.evaporated` non-empty and H3 done skips H4's wait.
- **Taught users** (localStorage flag set after reaching quiet): subsequent sessions show today's combined line once — `click blank space to prospect · click a word to pin it` — then fade to quiet after ~15 s. Reminder, not curriculum.

### Legend (layer 3 — #10)

Content behind the shared `?` toggle (interactions half; #6 owns the concept half):

> **prospect** — click blank space: a pulse draws a burst of slightly stranger words there
> **pin** — click a word: it crystallizes, joins the condensate, and steers what condenses next
> **release** — click a pinned word again, or its × in the tray
> **dewpoint** — how far from the seed the vapor condenses: obvious ↔ surreal
> **altitude** — what kind of words condense: concrete ↔ abstract
> **drizzle** — how fast new words condense: sparse ↔ dense (pace only)
> **evaporated** — unpinned words fade after a few seconds and rest in the sidebar; click one to condense it again
> **copy list** — copies the condensate as plain lines

## Guardrail compliance

**Never block / freeze / modally cover the field** (SPEC.md:85-90, issue constraint):

- Layer 1 is static text outside the field.
- Layer 2 lives in the existing `pointer-events:none` hint element inside the field's chrome; it intercepts nothing and the field never waits on it.
- Layer 3 is non-modal by construction: no backdrop, no focus trap, popover anchored over the controls/tray zone so the open state never overlaps `#field`; field keeps condensing behind it. Esc/click-away dismiss.
- Nothing anywhere gates seeding, prospecting, or pinning behind acknowledgment.

**`prefers-reduced-motion`** (SPEC.md:90):

- Layers 1 and 3 involve zero motion.
- Layer 2's only animation is an opacity crossfade between hint lines — within the SPEC's "fade only, no drift" allowance that `styles.css:43-46` already implements for words; #9 may still drop to instant swaps under the media query for extra caution.
- The one mechanism whose value *depended* on animation (ambient demonstration) was rejected, partly because reduced-motion suppresses the pulse entirely (`styles.css:44-45`) and the fallback would have been the hint line anyway.

**Screen-reader parity, both directions:**

- *Sighted → SR:* the hint line becomes `aria-live="polite"` so the advancing sequence is announced; because it sits inside `role="application"`, #9 must verify announcement in at least one screen reader and otherwise mirror the text into a visually-hidden live region outside `#field`. Slider endpoint labels are backed by `aria-describedby` glosses on the inputs themselves. The legend is ordinary DOM with an `aria-expanded` toggle.
- *SR → sighted (the issue's inversion):* the evaporated sidebar's aria-only recover guidance becomes visible text (#8); the field aria-label's summary is now matched — and exceeded — by the visible hint sequence. Existing aria-labels (`index.html:22,25`, ghost and chip buttons) all stay.

**Other constraints:** all copy above stays inside the weather vocabulary; no new dependencies — every layer is a few dozen lines of vanilla JS/CSS in the existing files.

## Prior art (brief)

- **[Silk](http://weavesilk.com/)** (Yuri Vishnevsky) — the closest structural match to this recommendation: brief instructions rendered quietly on the canvas itself, paired with a persistent `?` in the corner ("Double-click the ? to remove this message"). Teach inline, remember in a legend.
- **[Townscaper](https://oskarstalberg.com/Townscaper/)** (Oskar Stålberg) — the no-tutorial pole: a toy with no goals whose interface is discoverable purely through play ([design write-up](https://www.gamedeveloper.com/game-platforms/how-townscaper-works-a-story-four-games-in-the-making)). dewpt aspires to this, but Townscaper's one verb (click) is self-evidencing; dewpt's sliders are not — hence layer 1.
- **[Koalas to the Max](https://www.koalastothemax.com/)** — teaches entirely through immediate feedback: your cursor splits circles the instant you move ([overview](https://deepwiki.com/vogievetsky/KoalasToTheMax/1-koalas-to-the-max-overview)). Evidence for why dewpt's *prospect* needs so little teaching (the pulse is instant feedback) and why *pins-as-anchors* needs words (its feedback is diffuse and delayed).

## Follow-up issues

| Issue | Layer | Contents |
|---|---|---|
| [#8](https://github.com/schmug/dewpt/issues/8) | 1 — always-on | slider endpoint labels + `aria-describedby` glosses; evaporated sidebar sub-line (aria-parity fix) |
| [#9](https://github.com/schmug/dewpt/issues/9) | 2 — first-session | progressive hint state machine, live-region parity, resume fast-forward, taught flag |
| [#10](https://github.com/schmug/dewpt/issues/10) | 3 — recall | non-modal `?` legend, single surface shared with #6's explainer |

Ship in that order; each layer is independently useful. No production code changed under #7.
