# Press: a portable design language, applied to dewpt

**Date:** 2026-08-07
**Status:** approved, not yet implemented

## Problem

dewpt looks decent and reads as generic. It has a display serif, hairlines and
tracked labels — the ingredients of a considered interface — but no system
tying them together, so each element was styled on its own terms. Meanwhile
pear.no demonstrates a coherent language whose parts reinforce each other.

Two things are wanted. First, extract that language into something reusable, so
the next site does not start from nothing. Second, apply it to dewpt.

The language is extracted from a full reverse-engineering of pear.no (see
`ai-website-cloner-template`, branch `claude/clone-pear-website-c33cdd`), where
the site's authored stylesheet and scroll engine were ported wholesale. The
patterns below are what survives when the content, the WebGL film and the
5350vh scroll are stripped away.

## The language

Nine patterns. Together they are "Press".

1. **Printed ground.** A near-black ground and one paper-light foreground. Two
   tones, not a ramp. Text is never pure white — pear.no's paper is `#f2f1ed`
   on a `#0b0a09` ground.
2. **Hairline architecture.** The page is framed by 1px rules at fixed
   percentage positions (`--v1 --v2 --h1 --h2`) and content aligns to those
   rules rather than to boxes. Rules draw themselves in from an origin on load.
3. **Marks at intersections.** Four-pointed stars sit where rules cross,
   popping in on entry and shining occasionally. Furniture that announces a
   deliberate grid.
4. **Two faces, three roles.** A high-contrast display serif for anything
   large, a neutral sans for body, a mono for labels — uppercase, ~0.2em
   tracked, 10–12px. This carries most of the "designed" feeling and is the
   cheapest pattern to adopt.
5. **Depth by quantised blur.** Layers get discrete bands (0 / 1.5px / 4px)
   plus z-tiers. Never a continuous ramp.
6. **One easing curve.** `cubic-bezier(0.22, 1, 0.36, 1)` on essentially
   everything. Durations cluster 0.3–0.8s; staggers are `index × 0.07s`.
7. **Deferred entrance.** Nothing moves until a `go` class lands after boot,
   then everything releases together on a stagger. Motion is gated, not
   immediate.
8. **One accent, hoarded.** A single accent used almost nowhere, so it means
   something when it appears.
9. **Copy as furniture.** Short mono labels ("FULL DISCLOSURE", "AT YOUR
   SERVICE") used as typographic objects, not merely as text.

## Architecture

### `public/press.css` — the token layer

One file, no build step, no dependencies. Framework-agnostic so a React app can
adopt it as readily as a vanilla one.

It defines custom properties in four groups:

| Group  | Properties |
| ------ | ---------- |
| Palette | `--press-ground`, `--press-paper`, `--press-ink`, `--press-hair`, `--press-accent` |
| Type    | `--press-face-display`, `--press-face-text`, `--press-face-mono`, and a size scale |
| Motion  | `--press-ease`, `--press-dur-fast/base/slow`, `--press-stagger` |
| Depth   | `--press-blur-near/mid/far`, and the grid positions `--press-v1/v2/h1/h2` |
| Form    | `--press-radius` (0 by default — Press squares its corners) |

Plus four utility primitives:

- `.press-rule` — a 1px hairline that draws in from an origin under `.press-go`
- `.press-cross` — the four-pointed star mark, popping in and shining
- `.press-label` — uppercase, tracked, mono
- `.press-go` — the entrance gate; adding it to an ancestor releases all of the
  above

Defaults ship pear.no's own values, so the file is a faithful record of the
language. A consumer re-keys by overriding variables in its own stylesheet.

**Why variables over components.** dewpt is vanilla JS and donthype-me is React
19. A component kit would mean two implementations or a web-components layer,
which is real infrastructure with real maintenance for two consumers. Variables
plus four utility classes cost nothing and port everywhere.

### dewpt's override

dewpt keeps its identity. Its concept is meteorological — words condensing out
of vapour — and pear.no's warm printed palette would fight that. So dewpt takes
the *tonal architecture* (near-black ground, one paper-light foreground,
hairlines at ~14%, one hoarded accent) re-keyed cold:

| Token | dewpt value | Was |
| ----- | ----------- | --- |
| `--press-ground` | `#0d0c14` | `#14121f` |
| `--press-paper` | `#e8e9f0` | `#cfd4e8` |
| `--press-hair` | `rgb(232 233 240 / 0.14)` | `#2c2947` |
| `--press-accent` | `#f0d98c` | `#f0d98c` (unchanged, but now reserved) |

## Changes to dewpt

### The frame

The largest visual move. `#field` is currently a rounded card:
`border-radius: 14px`, a hairline border, and a radial gradient. Press has no
rounded cards — it has rules and marks.

The box keeps its dimensions (word positioning depends on the rect). The radius
goes to 0, the border becomes four `.press-rule` hairlines that draw in on load,
and four `.press-cross` marks sit at the corners. The radial gradient stays; it
is doing real work selling depth.

### Type

Fraunces stays as the display face — a variable high-contrast serif, and the
closest freely-licensed relative of pear.no's Flecha. Space Grotesk narrows to
body only. Labels move to a system mono stack, avoiding a new webfont download.

These all collapse into one `.press-label`: `.seed`, `.ctl label`, `.ctl .ends`,
`#tray h2`, `#evaporated h2`.

### Depth

`public/field.js:67` currently sets a continuous blur ramp:

```js
el.style.filter = 'blur(' + ((1 - depth) * (coarse ? 0.6 : 1.4)).toFixed(1) + 'px)';
```

This becomes three quantised bands. `depth` selects a band by threshold rather
than scaling continuously:

| `depth` | fine pointer | coarse pointer |
| ------- | ------------ | -------------- |
| ≥ 0.66  | 0px          | 0px            |
| ≥ 0.33  | 1.5px        | 0.65px         |
| < 0.33  | 4px          | 1.7px          |

The coarse column is the existing `0.6 / 1.4` reduction ratio (≈0.43) applied to
the new bands, preserving the touch legibility floor. The opacity ramp at line
81 is untouched.

### Tier colour

Tier encodes strangeness, so it carries information and cannot be flattened to
one colour. The hues stay; their chroma drops hard, so t1 (violet) and t2
(coral) become desaturated tints of the paper tone rather than distinct
colours. Depth then does more of the work, hue less.

**Each tier colour is checked against WCAG AA on the new ground before it
ships.** If a desaturated tint fails, its chroma comes back up until it passes.
Contrast wins over restraint.

### Motion

Every easing becomes `--press-ease`. A `.press-go` class lands after first paint
and releases the entrance: rules draw, corner marks pop, header and labels
settle on an `index × 0.07s` stagger. Field spawn and decay are re-keyed to the
same curve.

### Accent

Gold appears on pinned words and focus rings, nowhere else. Buttons
(`#copyBtn`, `#legendBtn`, the seed and add forms) become hairline borders with
mono labels.

## Scope

**Touched:** `public/styles.css`, `public/press.css` (new), and small hooks in
`public/field.js` and `public/app.js`.

**Untouched:** `src/` entirely — no Worker, Durable Object, generation or pool
changes. This is a restyle, not a refactor.

## Constraints

Every one of these survives intact. They are existing, deliberate work:

- `:focus-visible` outlines on every interactive element
- the `prefers-reduced-motion` branches
- `.vh` visually-hidden live regions (`#hintLive`, `#manifestoSr`)
- safe-area insets (`env(safe-area-inset-*)`) and the `svh`/`dvh` fallbacks
- the coarse-pointer legibility floor in `field.js`
- the non-modal about panel's focus behaviour

## Non-goals

No WebGL. No scroll film. No title-card gate — dewpt is a tool people return to,
not a narrative. No new dependencies, no framework change, no new webfonts.

## Verification

- `npm test` — 9 vitest files, all pure logic (pool, axes, generation,
  hint-machine, preseed). **Confirmed: none assert on DOM or CSS**, so the
  restyle cannot break them. They must still pass.
- `npm run typecheck`
- Every tier colour and every label size checked against WCAG AA on the new
  ground.
- Rendered at desktop and at ≤760px, where `#stage` becomes a column and
  `#field` switches to `min(70svh, 560px)`.
- Checked with `prefers-reduced-motion: reduce` active: the entrance must
  degrade to no motion, not to invisible content.

## Risks

**Squaring the field's corners may simply look worse.** It is the change most
likely to be a downgrade. `--press-radius` stays a variable so restoring the
14px radius is a one-line revert.

**Desaturating tiers may cost legibility.** Mitigated by the AA check above,
which takes precedence over the pattern.

**The entrance may fight the field.** dewpt's field is always moving; a staggered
chrome entrance on top could read as noise. If so, the entrance narrows to the
rules and marks only, and the labels appear without animation.
