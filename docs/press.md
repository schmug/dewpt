# Press — a portable design language

Press is a design language extracted from a full reverse-engineering of
[pear.no](https://pear.no) (see `ai-website-cloner-template`, branch
`claude/clone-pear-website-c33cdd`). It ships as `public/press.css`: one file,
no build step, no dependencies, framework-agnostic. dewpt is its first
consumer, applied via `public/styles.css`'s `:root` override — but `press.css`
is meant to outlive dewpt, so this document exists to spare the next consumer
the archaeology.

**Source of truth.** `public/press.css` and `test/press-tokens.test.ts` are
authoritative. This document restates them for readability; where anything
here seems to disagree with those two files, they win — that's a bug in this
document, not in the code. See the "Spec vs. shipped" and "Known caveats"
sections below for the discrepancies already found and deliberately not
fixed.

## The nine patterns

1. **Printed ground.** A near-black ground and one paper-light foreground —
   two tones, not a ramp. Text is never pure white.
2. **Hairline architecture.** The page is framed by 1px rules at fixed
   positions; content aligns to those rules rather than to boxes.
3. **Marks at intersections.** Four-pointed stars sit where rules cross,
   popping in on entry — furniture that announces a deliberate grid.
4. **Two faces, three roles.** A high-contrast display serif for anything
   large, a neutral sans for body, a mono for labels (uppercase, tracked).
5. **Depth by quantised blur.** Layers get discrete bands, never a
   continuous ramp.
6. **One easing curve.** A single `cubic-bezier` on essentially everything,
   with durations and stagger drawn from a small fixed set.
7. **Deferred entrance.** Nothing moves until a gate class lands after boot;
   then everything releases together on a stagger.
8. **One accent, hoarded.** A single accent colour used almost nowhere, so it
   means something when it appears.
9. **Copy as furniture.** Short mono labels used as typographic objects, not
   merely as text.

## Token reference

All defaults below are pear.no's own measured values, taken verbatim from
`public/press.css`. A consumer re-keys by overriding these custom properties
in its own stylesheet — **never edit `press.css` itself per-consumer.**

Every token in the "test-required" column is asserted present by
`test/press-tokens.test.ts`'s `REQUIRED_TOKENS` list (21 tokens). Two more
tokens exist in the file but are not part of that required set —
`--press-label-size` and `--press-label-tracking` — they're documented here
because `.press-label` genuinely depends on them, but a future edit that drops
them wouldn't fail the test suite.

### Palette

| Token | Default | Controls |
| --- | --- | --- |
| `--press-ground` | `#0b0a09` | The near-black background. |
| `--press-paper` | `#f2f1ed` | The one paper-light foreground tone. |
| `--press-ink` | `#1d1c19` | A second near-black, distinct from ground — published for text-on-paper contexts. **Not consumed anywhere in `press.css` or dewpt's `styles.css` today**; it exists so the palette is complete for a consumer who does put ink on paper. |
| `--press-hair` | `rgb(29 28 25 / 0.14)` | The hairline colour, consumed by `.press-rule`'s `background`. |
| `--press-accent` | `#015186` | The one hoarded accent. Not read directly by any `press.css` rule — a consumer wires it into its own accent usage (pins, focus rings). |

### Type

| Token | Default | Controls |
| --- | --- | --- |
| `--press-face-display` | `"Flecha M", "Iowan Old Style", Georgia, serif` | The display serif, for anything large. |
| `--press-face-text` | `"GT Standard L", ui-sans-serif, -apple-system, Arial, sans-serif` | The body sans. |
| `--press-face-mono` | `"GT Standard Mono", ui-monospace, SFMono-Regular, Menlo, monospace` | The label mono, consumed by `.press-label`. |
| `--press-label-size` | `11px` | `.press-label`'s font size. Not in the test's required set. |
| `--press-label-tracking` | `0.2em` | `.press-label`'s letter-spacing. Not in the test's required set. |

**Spec vs. shipped:** the design spec's architecture table describes this
group as `--press-face-display, --press-face-text, --press-face-mono, and a
size scale`, which reads like a full type scale (h1–h6, body, caption). What
actually shipped is narrower: two tokens that size and track `.press-label`
specifically, nothing else. There is no general size-scale token set in
`press.css`. Document the two real tokens, not the aspiration.

### Motion

| Token | Default | Controls |
| --- | --- | --- |
| `--press-ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | The one easing curve. `test/press-tokens.test.ts` asserts this exact curve string appears in `press.css` **exactly once**, and that no other `cubic-bezier(...)` appears anywhere in the file — a second, differing curve or a second literal copy of this one both fail the test. |
| `--press-dur-fast` | `0.3s` | Short transitions (e.g. hover states). |
| `--press-dur-base` | `0.5s` | The default transition/entrance duration. |
| `--press-dur-slow` | `0.8s` | `.press-rule`'s draw-in duration. |
| `--press-stagger` | `0.07s` | One stagger step; consumers multiply it by an index for sequential reveals. |

### Depth

| Token | Default | Controls |
| --- | --- | --- |
| `--press-blur-near` | `0px` | The nearest depth band. |
| `--press-blur-mid` | `1.5px` | The middle depth band. |
| `--press-blur-far` | `4px` | The farthest depth band. |

These three are the language's *published* depth values — the canonical
record for a consumer that layers depth in CSS. dewpt's field does not read
them: `public/field.js`'s blur is driven by `public/depth.js`'s own
`BLUR_BANDS` constants (`{ fine: [4, 1.5, 0], coarse: [1.7, 0.65, 0] }`),
which happen to carry the same fine-pointer numbers. Nothing binds the two
together — see "Known caveats" for why that matters.

### Form

| Token | Default | Controls |
| --- | --- | --- |
| `--press-radius` | `0px` | Border radius. Press squares its corners by default; `test/press-tokens.test.ts` asserts `--press-radius:\s*0` specifically. |

### Grid

| Token | Default | Controls |
| --- | --- | --- |
| `--press-v1` | `5.3%` | Vertical rule position 1, from pear.no's own layout. |
| `--press-v2` | `85.6%` | Vertical rule position 2. |
| `--press-h1` | `5.3vw` | Horizontal rule position 1. |
| `--press-h2` | `calc(65.3% + 50px)` | Horizontal rule position 2. |

Published grid coordinates, for a consumer that wants to align its own rules
to pear.no's proportions. **Not consumed anywhere in dewpt** — dewpt's frame
positions its four hairlines at the plain edges of `#fieldFrame` (`top:0`,
`bottom:0`, `left:0`, `right:0`) rather than at these percentage lines,
because the field's box already has fixed dimensions that word placement
depends on.

## Utility classes and required markup

Four primitives. All four are inert until an ancestor gains `.press-go` (see
"The entrance gate," below).

### `.press-rule`

A 1px hairline that scales in from an origin.

```html
<i class="press-rule" aria-hidden="true"></i>              <!-- horizontal -->
<i class="press-rule" data-axis="y" aria-hidden="true"></i> <!-- vertical -->
```

- Horizontal is the default: it draws via `transform: scaleX(...)` from a
  `transform-origin: 0 0`.
- **Vertical rules use the `data-axis="y"` HTML attribute — not a custom
  property.** An earlier draft of `press.css`'s own comment claimed a
  `--press-rule-axis` custom property that was never implemented; a consumer
  who trusted that comment and set `style="--press-rule-axis: y"` would get a
  silently non-functioning vertical rule (it would just sit at `scaleX(0)`
  forever). The comment was fixed during development, but the failure mode is
  exactly why this document calls the attribute out explicitly.
- The delay before a rule draws in is set per-instance via
  `--press-rule-delay` (defaults to `0s` if unset) — see dewpt's `data-edge`
  convention below for how this is used to stagger four rules against each
  other.
- The element itself carries no positioning — a consumer places it (absolute,
  grid line, whatever fits its layout) and only needs the class (plus
  `data-axis="y"` for verticals).

**dewpt's convention (not part of `press.css` itself):** dewpt positions its
four frame rules with a `data-edge="top|bottom|left|right"` attribute that its
own `styles.css` reads to place each rule at the correct edge of
`#fieldFrame`, and staggers two of them in past the base delay:

```css
#fieldFrame .press-rule[data-edge="top"]{top:0; left:0; right:0; height:1px;}
#fieldFrame .press-rule[data-edge="bottom"]{bottom:0; left:0; right:0; height:1px; --press-rule-delay:0.08s;}
#fieldFrame .press-rule[data-edge="right"]{top:0; bottom:0; right:0; width:1px; --press-rule-delay:0.12s;}
```

`data-edge` is dewpt's own vocabulary, not something `press.css` reads —
another consumer is free to name this attribute (or the positioning
mechanism) anything it likes.

### `.press-cross`

The four-pointed mark that sits at a rule intersection. It draws its glyph
from an **inline `<svg>` child that the consumer must supply** — `.press-cross`
itself only sizes and animates the box (9×9px, centred via a `-4.5px` margin
on each axis, `fill: currentcolor` on the `svg`); it has no built-in shape.

```html
<i class="press-cross" aria-hidden="true">
  <svg viewBox="0 0 24 24">
    <path d="M12 0Q13.1 10.9 24 12Q13.1 13.1 12 24Q10.9 13.1 0 12Q10.9 10.9 12 0Z"/>
  </svg>
</i>
```

That exact `<path d>` (four quadratic Bézier arcs meeting at the centre) is
the star shape dewpt ships and the one this document records as the reference
mark — a consumer could draw a different four-pointed star, but this is the
one pear.no's own mark traces to.

**dewpt's convention (not part of `press.css` itself):** a `data-corner`
attribute selects which corner of `#fieldFrame` the mark sits in
(`tl`/`tr`/`bl`/`br`), and `--press-cross-delay` staggers all four marks in
together after the rules have drawn:

```css
#fieldFrame .press-cross{position:absolute; z-index:3; color:var(--t0); pointer-events:none; --press-cross-delay:0.5s;}
#fieldFrame .press-cross[data-corner="tl"]{top:0; left:0;}
#fieldFrame .press-cross[data-corner="tr"]{top:0; right:0; margin-right:-4.5px;}
```

### `.press-label`

Uppercase, tracked, mono. No required child markup — apply the class directly
to any text element:

```html
<h2 class="press-label">condensate</h2>
<button class="press-label">condense</button>
```

It reads `--press-face-mono`, `--press-label-size`, and
`--press-label-tracking` and sets `text-transform: uppercase`.

### `.press-go`

The entrance gate. It carries **no styling of its own** — adding it to any
ancestor element releases every `.press-rule` and `.press-cross` beneath that
ancestor (via `.press-go .press-rule` / `.press-go .press-cross` selectors),
and a consumer's own CSS is expected to key its own entrance transitions off
the same class the same way. dewpt adds it to `<body>`. See "The entrance
gate" below for *how* it gets added — that part is load-bearing.

## How to adopt: dewpt's own override

dewpt keeps Press's tonal architecture (near-black ground, one paper-light
foreground, hairlines at low opacity, one hoarded accent) but re-keys it cold
— dewpt's concept is meteorological, and pear.no's warm printed palette would
fight that. The entire override lives in `public/styles.css`'s `:root` block:

```css
:root{
  /* Press token overrides */
  --press-ground:#0d0c14;
  --press-paper:#e8e9f0;
  --press-hair:rgb(232 233 240 / 0.14);
  --press-accent:#f0d98c;
  --press-face-display:'Fraunces',serif;
  --press-face-text:'Space Grotesk',sans-serif;
  --press-label-size:10px;

  /* dewpt's own names, kept so existing rules keep working */
  --ink:#0d0c14; --field:#151327; --label:#9a97b0; --hair:rgb(232 233 240 / 0.14);
  --t0:#dcdeea; --t1:#cdc7dd; --t2:#e0c8bc; --pin:#f0d98c;
}
```

That's **seven** `--press-*` declarations (ground, paper, hair, accent,
face-display, face-text, label-size) — everything else (ink, the three
motion durations, the ease curve, the stagger, the three blur bands, the
radius, the four grid positions, the mono face, the label tracking) is left
at pear.no's own default and inherited unchanged. This is the whole cost of
adopting Press's tonal architecture while keeping a different identity.

Two things worth knowing before copying this pattern:

1. **You don't have to rewire every property to `--press-*` names.** dewpt
   pre-dates Press and already had its own token vocabulary (`--ink`,
   `--field`, `--label`, `--hair`, `--t0`/`--t1`/`--t2`, `--pin`). Rather than
   rewrite every rule in `styles.css` to read `var(--press-ground)` etc.,
   dewpt kept its own names and set their values equal to (or derived from)
   the Press tokens they replace — the comment in the file says exactly why:
   "dewpt's own names, kept so existing rules keep working." A new consumer
   starting from scratch doesn't inherit this obligation and can read
   `--press-*` directly everywhere; dewpt's dual naming is migration debt
   from adopting Press onto an existing app, not a required pattern.
2. **A font override can happen by omission, not just by value.** dewpt never
   overrides `--press-face-mono`. The design intent ("labels move to a system
   mono stack, avoiding a new webfont download") is satisfied anyway, because
   `"GT Standard Mono"` is never loaded by dewpt's `<link>` tags — the browser
   falls through the stack to `ui-monospace`. The token itself still says
   `"GT Standard Mono", ui-monospace, ...`; only the *available* fonts
   changed. Don't assume an unoverridden token means unchanged rendering —
   check what's actually loaded.

## The contrast rule

Tiers (dewpt's `--t0`/`--t1`/`--t2` field-word colours) are gated on
**composited** contrast at the opacity floor, not on the raw opaque ratio —
because raw ratios badly mislead. Field words render partially transparent as
part of the depth cue (`public/depth.js`'s `DEPTH_OPACITY`, floor `0.45` for a
fine pointer, `0.7` for coarse), so a swatch's contrast against the ground
when painted at full opacity says nothing about what a viewer actually sees.
A colour can look perfectly safe as a flat swatch and still wash out once
rendered at 45% over a dark ground.

The real, verified example from this exact palette: `#cdc7dd` (dewpt's `--t1`)
reads **11.86:1** against the ground as an opaque swatch, but only **3.19:1**
once composited at the `0.45` fine-pointer opacity floor — the gap between
"looks obviously fine" and "actually barely clears the bar" is nearly 4×.
(A different figure — "10.65:1 opaque, 2.97:1 composited" — appeared in the
controller's dispatch message during palette selection. It doesn't belong to
`--t1`: it describes `#c3bcd8`, a candidate rejected for that role because it
fails the `0.45`-floor large-text bar. The shipped `--t1` is `#cdc7dd`,
measured above.)

`test/contrast.test.ts` is the gate:

- **Opaque UI text** (`--label`, `--pin`) is held to the ordinary WCAG AA body
  bar: **≥ 4.5:1** against `--ink`, measured as painted (no compositing —
  these render fully opaque).
- **Field words** (`--t0`, `--t1`, `--t2`) are composited over `--ink` at
  `DEPTH_OPACITY.fine.floor` (`0.45`, imported from `public/depth.js` so the
  test and the renderer can never drift apart) before the ratio is measured.
  They're held to the **large-text AA bar, ≥ 3.0:1**, not the 4.5 body bar —
  words are deliberately faint at depth as the depth cue itself, so they're
  judged at their dimmest, large-text moment, not as body copy.
- Each tier is also held to a **regression baseline**: never worse than the
  pre-Press design measured at the same floor (`t0` ≥ 3.43, `t1` ≥ 2.68,
  `t2` ≥ 2.77). A colour that clears the absolute 3.0 floor but is a step
  backward from what shipped before still fails.
- **Touch gets more contrast than fine pointers**: for each tier, the ratio
  composited at the coarse-pointer floor (`0.7`) must exceed the ratio at the
  fine-pointer floor (`0.45`) — the same ordering must hold as colours change.

Measured values for dewpt's shipped palette (fine floor `0.45`):

| Tier | Hex | Opaque | Composited @ fine floor | Baseline | Result |
| --- | --- | --- | --- | --- | --- |
| `--t0` | `#dcdeea` | 14.52:1 | 3.66:1 | ≥ 3.43 | pass |
| `--t1` | `#cdc7dd` | 11.86:1 | 3.19:1 | ≥ 2.68 | pass |
| `--t2` | `#e0c8bc` | 12.18:1 | 3.24:1 | ≥ 2.77 | pass |

## The entrance gate

`.press-go` on an ancestor releases every primitive beneath it — in dewpt,
that ancestor is `<body>`, and it's added by a **standalone inline `<script>`
in `public/index.html`, deliberately outside `app.js`'s module graph**:

```html
<script>
  requestAnimationFrame(() => {
    requestAnimationFrame(() => document.body.classList.add('press-go'));
  });
</script>
<script type="module" src="/app.js"></script>
```

**This placement is load-bearing, not incidental — do not "tidy" it into
`app.js`.** The gate used to live inside `app.js`. That module has top-level
imports and `getElementById`-based listener wiring that can throw before
reaching the bottom of the file; a module that throws never finishes
evaluating, so a gate placed anywhere inside it — start, middle, or end —
could be silently skipped, stranding `header`/`#controls`/`#tray` at
`opacity: 0` forever for anyone without `prefers-reduced-motion` set. The
inline script has zero imports and zero DOM lookups beyond `document.body`,
so it runs — and the chrome becomes visible — independently of whether
`app.js` loads at all. `public/app.js` carries a comment at its own tail
recording this same reasoning, so a reader who only opens that file still
finds the pointer to where the gate actually lives.

The double `requestAnimationFrame` exists so the browser paints the
`opacity: 0` initial state on at least one frame before the transition to
`opacity: 1` starts — otherwise the "entrance" never visibly happens, it's
just the finished state on first paint. It runs once and never again, so it
cannot double-fire.

`prefers-reduced-motion: reduce` and `<noscript>` both restore the finished,
visible state directly (no transition, no gate needed) rather than depending
on `.press-go` ever landing — see the `@media (prefers-reduced-motion:
reduce)` blocks in `press.css` and `styles.css`, and the `<noscript><style>`
block in `index.html`.

## Known caveats

Two things were found during review of this restyle and deliberately
deferred rather than fixed. Both are safe today; neither is guarded by a
test, so a future change could silently cross the line.

### The contrast gate composites against a flat ground

`test/contrast.test.ts` composites each tier over the flat `--ink` colour.
`#field`'s real backdrop is a radial gradient
(`radial-gradient(ellipse at 50% 42%, #1b1934 0%, var(--field) 62%, #100f1e
100%)`) whose brightest stop, `#1b1934`, is lighter than the flat `--ink` the
test uses. A word sitting near the gradient's centre therefore sees slightly
*less* real contrast than the test reports: `--t1` measures **3.15:1** in
reality against the gradient's brightest stop, versus the **3.19:1** the flat
model reports. It passes today either way — 3.15 still clears the 3.0 floor —
but the margin is thin (0.15), and a future tier colour could clear the
flat-ground gate in CI while actually dipping under 3.0 near the gradient's
centre in the browser. Fixing this would mean gating against the gradient's
lightest stop instead of `--ink`; that's a real option for whoever touches
this next, just not done here.

### Frame marks and words are only coincidentally non-overlapping

The frame's rules and corner marks are positioned as CSS siblings of `#field`
with explicit stacking (`#fieldFrame .press-rule{z-index:2;}`,
`#fieldFrame .press-cross{z-index:3;}`), while ordinary drifting words inside
`#field` have `z-index: auto`. Nothing today makes a word overlap a mark, but
that's a numeric coincidence, not a rule: `public/field.js` clamps every
word's spawn position to at least 12px from every edge of the field
(`Math.max(12, ...)` / `Math.min(rect.width - reserve, ...)` on `left`,
similarly on `top`), while the corner marks reach about 4.5px into the field
(the `-4.5px` centring margin on `.press-cross`) and the rules sit exactly on
the 0px edge. The 12px clamp and the ~4.5px mark reach are two independent
constants in two different files with nothing tying them together, and no
test asserts the gap between them. A future change to either constant — a
tighter word clamp, a bigger mark — could start painting words under the
frame furniture with no warning.

## Where to look next

- `public/press.css` — the token layer and the four primitives, in full.
- `test/press-tokens.test.ts` — the authoritative list of required tokens and
  classes.
- `test/contrast.test.ts` — the composited-contrast gate.
- `public/depth.js` — the JS-side depth bands and opacity floors that both
  the field renderer and the contrast test read from.
- `public/styles.css` — dewpt's `:root` override, the frame markup's CSS, and
  the entrance-gate transitions.
- `public/index.html` — the frame's `.press-rule`/`.press-cross` markup and
  the standalone entrance-gate script.
- `docs/superpowers/specs/2026-08-07-press-design-language-design.md` — the
  original design spec and rationale for the nine patterns and the restyle.
