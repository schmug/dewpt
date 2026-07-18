# Mobile touch & PWA experience — research

**Issue:** [#17](https://github.com/schmug/dewpt/issues/17) · **Status:** proposed · **Date:** 2026-07-17
**Scope:** Make the existing *desktop-primary* field genuinely usable on touch and installable as a PWA. This is the SPEC's `Non-goals (MVP)` line verbatim — "desktop pointer interaction is the core; **make it not-broken on touch**" ([SPEC.md:81](../SPEC.md)) — not a mobile-first redesign. Teaching the interactions is [#7](https://github.com/schmug/dewpt/issues/7)'s scope; explaining the concept is [#6](https://github.com/schmug/dewpt/issues/6)'s. Nothing here changes the desktop experience.

## TL;DR — recommendation

Three workstreams, in priority order. Each is touch-additive (gated behind a media query or a coarse-pointer / feature check) so the desktop path is byte-for-byte unchanged.

1. **Touch reliability** (highest — the core loop is unreliable with a thumb). Inflate word hit-areas to ≥44 px with a transparent `::before` (visuals untouched), add a coarse-pointer **legibility floor** that also replaces the desktop-only `:hover` clarify, set `touch-action: manipulation` to kill the double-tap-zoom delay/misfire, and enlarge the sub-44 px controls (range thumb, chip `×`, ghosts). → workstream **A**
2. **Responsive viewport & layout** (the field is a letterboxed 480 px box on a phone). Fluid field height via `svh`/`dvh`, `viewport-fit=cover` + safe-area insets, `100vh → 100dvh`, and a real small-screen layout instead of the single 760 px stack. → workstream **B**
3. **PWA installability** (none of the install signals exist yet). Web app manifest, icon set, `theme-color`, `apple-touch-icon`. An offline service worker is **explicitly deferred** — the field needs the network to generate, so offline has near-zero value beyond a friendly shell. → workstream **C**

**Explicitly rejected for v1:** two-stage tap-to-clarify-then-pin, freeze-and-enlarge on `touchstart`, and any mobile-first infinite-canvas rework (that's SPEC M3, [SPEC.md:74](../SPEC.md)). Reasons in [Mechanisms evaluated](#mechanisms-evaluated).

The layering logic mirrors the priority: A makes the one thing the app *is* — prospect and pin — actually doable with a finger; B stops the field from being a scroll-buried 480 px rectangle; C lets someone keep it on a home screen. A is worthless without being reachable, so it leads. Each workstream ships independently; this can stay one issue (#17) or split A/B/C.

## Gap inventory

Verified against the live client, not the SPEC. Every row is a place the current code assumes a fine pointer, a hover, or a wide window.

| # | Area | Where (code) | Current | Why it breaks on touch | Fix (workstream) |
|---|---|---|---|---|---|
| 1 | **Word tap target** | font `14 + depth*15` px, single line ([field.js:61](../public/field.js)); click handler on the bare span ([field.js:87](../public/field.js)); `white-space:nowrap` ([styles.css:17](../public/styles.css)) | tap box ≈ the glyph run; a short word ("ash") at min depth is ~17 px tall | Below WCAG 2.5.8 minimum (24×24) and Apple's 44 pt; the primary verb (pin) is a coin-flip with a thumb | A — `::before` hit inflation |
| 2 | **Hover-only legibility** | `.word:hover{filter:none; opacity:1}` ([styles.css:22](../public/styles.css)); deep words spawn at `blur` up to 1.4 px + opacity `0.45` ([field.js:62,70](../public/field.js)) | hover clears blur and floors opacity so deep words become readable/pinnable | Touch has no hover — deep words stay blurred and semi-transparent, unreadable and hard to aim at, forever | A — coarse-pointer legibility floor |
| 3 | **Prospect misfire** | `if (e.target.closest('.word')) return; … onProspect()` ([field.js:131-142](../public/field.js)) | tap a word → pin; tap blank → prospect (pulse + 4 words) | A near-miss on the tiny target (#1) fires a *prospect* instead — the wrong, noisy action. Small targets make misfires frequent | A — folded into #1 |
| 4 | **Double-tap zoom** | no `touch-action` anywhere; viewport allows it ([index.html:5](../public/index.html)) | browser default | Rapid pin/prospect taps read as double-tap-zoom → ~300 ms delay and accidental page zoom | A — `touch-action: manipulation` |
| 5 | **Range thumb** | `16×16` webkit / `14×14` moz ([styles.css:29-30](../public/styles.css)) | fine-pointer sized | Far under 44 pt; the three sliders are the SPEC's core "weather" control and are hard to grab | A — enlarge on coarse pointer |
| 6 | **Chip `×` / ghosts** | chip button `padding:0`, 13 px ([styles.css:40](../public/styles.css)); ghost 14 px text link ([styles.css:66](../public/styles.css)) | tiny inline targets | Unpin and recover are sub-24 px tap targets | A — pad to ≥44 px |
| 7 | **Fixed field height** | `#field{height:480px}` ([styles.css:14](../public/styles.css)); no mobile override in the 760 px block ([styles.css:69-72](../public/styles.css)) | 480 px regardless of screen | On a phone the canvas is a letterboxed rectangle with header/controls/tray/ghosts all scrolled below it; the "field" is a fraction of the screen | B — fluid `svh`/`dvh` height |
| 8 | **`100vh` on body** | `body{min-height:100vh}` ([styles.css:8](../public/styles.css)) | legacy `vh` | Mobile `vh` counts the retracted URL bar → content jumps / hides behind chrome | B — `100dvh` |
| 9 | **No safe-area handling** | viewport lacks `viewport-fit=cover` ([index.html:5](../public/index.html)); `body` padding is fixed px ([styles.css:8](../public/styles.css)) | ignores notch/home-indicator | Content can sit under the notch / rounded corners in standalone mode | B — `viewport-fit=cover` + `env(safe-area-inset-*)` |
| 10 | **Spawn clamp assumes wide field** | `x` clamped to `rect.width-160`, band `-220` ([field.js:63-66](../public/field.js)) | tuned for a ~960 px field | On a ~360 px width the horizontal band collapses; words cluster left | B — width-relative clamp |
| 11 | **No manifest** | none in `public/`; no `<link rel="manifest">` ([index.html:1-10](../public/index.html)) | — | Not installable; no name/icon/standalone display | C — add manifest |
| 12 | **No `theme-color` / `apple-touch-icon`** | absent from `<head>` ([index.html:3-10](../public/index.html)) | — | Browser chrome doesn't match `--ink`; iOS home-screen icon is a screenshot | C — meta + icons |

## Mechanisms evaluated

The axis the issue turns on: **touch reliability** (can a thumb complete prospect → pin → shape?) vs **desktop-primary aesthetic fidelity** — depth, ephemerality, and tier color are the whole point ([SPEC.md:87-90](../SPEC.md)), and mobile-first is a stated non-goal ([SPEC.md:81](../SPEC.md)). The contested decision is workstream A's *how*: making words tappable without flattening the depth field or inventing a touch-only interaction model.

### Mechanism 1 — invisible hit-area inflation (`::before`)

A transparent pseudo-element extends each word's clickable box without moving the text: `.word::before{content:""; position:absolute; inset:-12px -10px}`. Since `.word` is absolutely positioned, the pseudo grows the hit region ~24 px on each axis; clicks bubble to the existing span handler ([field.js:87](../public/field.js)).

- **Reliability: high.** Turns a 17 px glyph into a ≥44 px target, killing both the missed-pin and the prospect-misfire (#3) in one change.
- **Aesthetic cost: zero.** Nothing visible changes — no size, color, blur, or motion touched. Depth and tier language are untouched.
- **Weaknesses.** At high density adjacent hit-boxes overlap; resolve by z-order (pinned/nearest already sit higher — `.pinned{z-index:3}` [styles.css:21](../public/styles.css)), so the topmost word wins the tap. Doesn't by itself make a *blurred* deep word readable — that's Mechanism 2's job.

### Mechanism 2 — coarse-pointer legibility floor (hover replacement)

Under a coarse pointer, raise the depth **floor**: bump the base font and the opacity floor and drop the max blur, so deep words spawn readable instead of relying on `:hover` (#2). Font size and opacity are set inline per word ([field.js:61,70](../public/field.js)), so the cleanest home is a JS branch keyed off `matchMedia('(pointer:coarse)')` in `spawnPick` (a CSS `!important` floor is the fallback, but inline styles force the `!important`).

- **Reliability: high, and it's the only thing that fixes #2.** A finger can't hover; without a floor, the deep half of the field is permanently unreadable/unaimable on touch.
- **Aesthetic cost: mild and touch-scoped.** Compresses the depth gradient a little on phones — acceptable under the "not-broken on touch, not mobile-first" mandate ([SPEC.md:81](../SPEC.md)); tier colors and fade-only motion are untouched ([SPEC.md:89-90](../SPEC.md)).
- **Weaknesses.** Divergent look between desktop and touch; keep the floor gentle (raise the minimum, don't flatten to uniform) so depth still reads.

### Mechanism 3 — two-stage tap (first tap clarifies, second pins)

First tap on a deep word brings it forward (porting `:hover`), second tap pins; tap elsewhere prospects.

- **Reliability: mixed.** Faithfully reproduces the hover affordance, but adds a step to the core "tap a word → pin" loop and needs per-word "clarified" state. A first tap that the user *meant* as a pin now feels like a dropped input.
- **Verdict: rejected for v1.** Mechanism 2 delivers the same legibility with no new interaction model or state. Revisit only if a gentle floor proves insufficient in testing.

### Mechanism 4 — freeze-and-enlarge on `touchstart`

On `touchstart` over the field, pause drift and bump the touched word's size/opacity, committing the pin on `touchend`.

- **Reliability: high but for a small problem.** Drift is slow — one `transform 9s linear` glide of ≤15 px ([styles.css:17](../public/styles.css), [field.js:71](../public/field.js)) ≈ 1.7 px/s — so words are nearly stationary already; the real pain is size + blur, which Mechanisms 1–2 fix without touching motion.
- **Guardrail friction.** Pausing the field brushes against "the field must never freeze" ([SPEC.md:87](../SPEC.md)); it also risks fighting the scroll gesture. Most code, narrowest payoff.
- **Verdict: rejected for v1.**

### Mechanism 5 — bigger words / lower CAP on small screens

Raise base font and trim `CAP` ([field.js:15](../public/field.js)) on narrow viewports so targets are naturally larger and less crowded.

- A useful *supporting* tweak (fewer overlaps for Mechanism 1, larger baseline for Mechanism 2), but partial alone: it doesn't clarify blurred deep words and it thins the "weather." **Fold the base-size bump into Mechanism 2; leave CAP mostly alone** to preserve density.

### Comparison

| | Fixes | Reliability | Aesthetic cost | Reduced-motion | Verdict |
|---|---|---|---|---|---|
| 1. `::before` hit inflation | tap target + prospect misfire | high | none | motion-free | **adopt** — A core |
| 2. Coarse-pointer legibility floor | hover-only legibility | high (only fix for #2) | mild, touch-scoped | motion-free | **adopt** — A core |
| 3. Two-stage tap | legibility | mixed (extra step) | none | motion-free | **reject** v1 |
| 4. `touchstart` freeze-enlarge | drift (already slow) | high / low value | none | n/a | **reject** v1 (guardrail friction) |
| 5. Bigger words / lower CAP | crowding, baseline size | partial | thins density | motion-free | **fold into 2** |

## Concrete proposals

### Workstream A — touch reliability

```css
/* hit-area: grow the tap box, leave the glyphs where they are */
.word::before{content:""; position:absolute; inset:-12px -10px;}
#field{touch-action:manipulation;}           /* no double-tap-zoom delay/misfire */

@media (hover:none) and (pointer:coarse){
  input[type=range]::-webkit-slider-thumb{width:28px; height:28px;}
  input[type=range]::-moz-range-thumb{width:28px; height:28px;}
  .chip button{padding:8px; margin:-8px;}      /* ≥44px unpin target */
  .ghost{padding:8px 0;}
}
```

```js
// field.js spawnPick — coarse-pointer legibility floor (Mechanism 2)
const coarse = window.matchMedia('(pointer:coarse)').matches;
const baseFont = coarse ? 18 : 14, fontSpan = coarse ? 12 : 15;   // higher floor, gentler gradient
el.style.fontSize = (baseFont + depth * fontSpan) + 'px';
el.style.filter = 'blur(' + ((1 - depth) * (coarse ? 0.6 : 1.4)).toFixed(1) + 'px)';
// …and floor the opacity in the rAF: (coarse ? 0.7 : 0.45) + depth * (coarse ? 0.3 : 0.55)
```

### Workstream B — viewport & layout

```html
<!-- index.html -->
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#14121f">
```

```css
body{min-height:100dvh;}                                    /* was 100vh */
body{padding-left:max(20px, env(safe-area-inset-left));
     padding-right:max(20px, env(safe-area-inset-right));}  /* notch / home-indicator */
@media (max-width:760px){
  #field{height:min(70svh, 560px);}                          /* was fixed 480px; fills the phone */
}
```
Desktop keeps `height:480px` (the override is inside the 760 px block). Also revisit the spawn clamp ([field.js:63-66](../public/field.js)) to a width-relative band so words don't cluster on narrow screens (gap #10).

### Workstream C — PWA installability

`public/manifest.webmanifest`:
```json
{
  "name": "dewpt",
  "short_name": "dewpt",
  "description": "An ambient ideation canvas where words condense out of latent space.",
  "start_url": "/",
  "display": "standalone",
  "orientation": "any",
  "background_color": "#14121f",
  "theme_color": "#14121f",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```
Link it (`<link rel="manifest" href="/manifest.webmanifest">`) and add `<link rel="apple-touch-icon" href="/icon-180.png">`. **Icons are an asset task:** derive from the `dew`*`pt`* wordmark ([index.html:13](../public/index.html)) — Fraunces, lilac (`--t1`) `pt` on the `--field` radial — sized 180/192/512 plus a maskable variant with a safe zone. Offline service worker deferred (see follow-ups). A progressive-enhancement `navigator.share()` for the condensate (feature-detected, alongside the existing copy button) is the mobile-idiomatic export and aligns with SPEC M5 ([SPEC.md:76](../SPEC.md)) — optional, not required for install.

## Guardrail compliance

- **Not mobile-first** ([SPEC.md:81](../SPEC.md)): every change is gated behind `@media`, `(pointer:coarse)`, or a feature check; the desktop render path is untouched. Mechanism 2's floor is the only aesthetic divergence and it's touch-scoped and gentle.
- **Field never freezes** ([SPEC.md:87](../SPEC.md)): nothing here blocks or pauses the field — that's precisely why Mechanism 4 (freeze-on-touch) was rejected. Hit inflation and the legibility floor are passive.
- **Tier colors preserved** ([SPEC.md:89](../SPEC.md)): pale slate → lilac → ember → gold are untouched; the floor raises opacity/size only, never recolors.
- **`prefers-reduced-motion`** ([SPEC.md:90](../SPEC.md)): every adopted mechanism is motion-free; the existing reduced-motion block ([styles.css:43-46](../public/styles.css)) is unaffected.
- **No new dependencies:** all of A/B are vanilla CSS/JS edits to existing files; C adds two static files and two `<head>` lines.

## Prior art (brief)

- **[Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/accessibility)** — the 44×44 pt minimum hit target; the yardstick gaps #1, #5, #6 fail.
- **[WCAG 2.5.8 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)** — 24×24 CSS px floor; the `::before` inflation clears it with margin.
- **[MDN — viewport-percentage units (`svh`/`lvh`/`dvh`)](https://developer.mozilla.org/en-US/docs/Web/CSS/length#viewport-percentage_lengths)** and **[`env()` safe-area insets](https://developer.mozilla.org/en-US/docs/Web/CSS/env)** — the fix for gaps #7–#9.
- **[MDN — `@media (hover)` / `(pointer)`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/hover)** and **[`touch-action`](https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action)** — coarse-pointer gating and the double-tap-zoom fix.
- **[MDN — Progressive web apps](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps)** / **[Web App Manifest](https://developer.mozilla.org/en-US/docs/Web/Manifest)** and **[`navigator.share`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share)** — workstream C.

## Follow-up issues

| Issue | Workstream | Contents |
|---|---|---|
| [#17](https://github.com/schmug/dewpt/issues/17) | A + B + C (umbrella) | this research; ship whole or split below |
| *(optional split)* | A — touch | hit inflation, legibility floor, `touch-action`, enlarged controls |
| *(optional split)* | B — responsive | fluid field height, `dvh`, safe-area, small-screen layout, spawn clamp |
| *(optional split)* | C — PWA | manifest, icon set, `theme-color`, `apple-touch-icon` |
| *(deferred)* | offline | service worker + offline shell — low value while generation needs the network |
| *(deferred)* | input parity | touch/keyboard operability of prospect & pin — extends the a11y gap flagged in [#7](https://github.com/schmug/dewpt/issues/7)'s research |

Ship A → B → C; each stands alone. No production code changes under this research doc.
