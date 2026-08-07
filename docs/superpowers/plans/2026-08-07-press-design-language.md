# Press Design Language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract pear.no's visual language into a portable `press.css` token layer, and restyle dewpt with it.

**Architecture:** One dependency-free CSS file holds the language as custom properties plus four utility classes, shipping pear.no's own values as defaults. dewpt consumes it and re-keys three variables to stay cold. Two pieces of presentation logic that were inline in `field.js` — depth blur and the opacity ramp — move into a testable `public/depth.js` so both the field and the contrast test read the same constants.

**Tech Stack:** Vanilla ES modules, plain CSS (no build step), vitest.

## Global Constraints

- **No new dependencies, no build step, no new webfonts.** `public/` is served raw.
- **`src/` is never touched.** No Worker, Durable Object, generation or pool changes.
- **Every existing accessibility affordance survives:** `:focus-visible` outlines on all interactive elements; `prefers-reduced-motion` branches; `.vh` live regions (`#hintLive`, `#manifestoSr`); `env(safe-area-inset-*)` padding and the `svh`/`dvh` fallbacks; the coarse-pointer legibility floor; the non-modal about panel's focus behaviour.
- **Every entrance, exit and state change uses `cubic-bezier(0.22, 1, 0.36, 1)`** — referenced as `var(--press-ease)`, never re-typed. Continuous ambient motion may stay `linear`: the field's 9s word drift is a constant translation, and easing it would make words accelerate and settle, which fights the drifting-vapour read. pear.no does the same for its continuous rotations.
- **Contrast bar:** opaque chrome and labels ≥ 4.5:1. Field words at their opacity floor must be ≥ 3.0:1 — and must never regress below the current design's measured values (t0 3.43:1, t1 2.68:1, t2 2.77:1).
- `npm test` and `npm run typecheck` pass after every task.

---

### Task 1: Depth bands

Move the field's depth maths out of `field.js` into a tested module. `field.js:67` currently sets a continuous blur ramp; it becomes three quantised bands. The opacity ramp at line 81 moves too — unchanged in behaviour — so the contrast test in Task 3 can import the same numbers rather than duplicating them.

**Files:**
- Create: `public/depth.js`
- Create: `test/depth.test.ts`
- Modify: `public/field.js:66-67`, `public/field.js:81`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `blurBand(depth: number, coarse: boolean): number` — px blur for a depth in [0,1]
  - `wordOpacity(depth: number, coarse: boolean): number` — the existing ramp
  - `DEPTH_OPACITY: { fine: {floor: number, range: number}, coarse: {floor: number, range: number} }`
  - `BLUR_BANDS: { fine: [number, number, number], coarse: [number, number, number] }` — ordered far → near

- [ ] **Step 1: Write the failing test**

Create `test/depth.test.ts`:

```ts
import { describe, expect, it } from "vitest";

// public/depth.js is plain JS served raw from public/ (no build step), so it
// sits outside tsconfig's include — same arrangement as pool-client.
// @ts-expect-error — public/depth.js ships untyped
import { blurBand, wordOpacity, BLUR_BANDS, DEPTH_OPACITY } from "../public/depth.js";

describe("blurBand", () => {
  it("returns the far band below 0.33", () => {
    expect(blurBand(0, false)).toBe(4);
    expect(blurBand(0.32, false)).toBe(4);
  });

  it("returns the mid band from 0.33 up to 0.66", () => {
    expect(blurBand(0.33, false)).toBe(1.5);
    expect(blurBand(0.65, false)).toBe(1.5);
  });

  it("returns no blur at 0.66 and above", () => {
    expect(blurBand(0.66, false)).toBe(0);
    expect(blurBand(1, false)).toBe(0);
  });

  it("reduces every band for coarse pointers", () => {
    expect(blurBand(0, true)).toBe(1.7);
    expect(blurBand(0.5, true)).toBe(0.65);
    expect(blurBand(1, true)).toBe(0);
  });

  it("never increases blur as depth increases", () => {
    for (const coarse of [false, true]) {
      let previous = Infinity;
      for (let d = 0; d <= 1; d += 0.01) {
        const blur = blurBand(d, coarse);
        expect(blur).toBeLessThanOrEqual(previous);
        previous = blur;
      }
    }
  });

  it("keeps coarse blur below fine blur at equal depth", () => {
    for (const d of [0, 0.4, 0.9]) {
      expect(blurBand(d, true)).toBeLessThanOrEqual(blurBand(d, false));
    }
  });
});

describe("wordOpacity", () => {
  it("bottoms out at the documented floor", () => {
    expect(wordOpacity(0, false)).toBeCloseTo(DEPTH_OPACITY.fine.floor, 5);
    expect(wordOpacity(0, true)).toBeCloseTo(DEPTH_OPACITY.coarse.floor, 5);
  });

  it("tops out at 1", () => {
    expect(wordOpacity(1, false)).toBeCloseTo(1, 5);
    expect(wordOpacity(1, true)).toBeCloseTo(1, 5);
  });

  it("gives touch a higher floor than fine pointers", () => {
    expect(DEPTH_OPACITY.coarse.floor).toBeGreaterThan(DEPTH_OPACITY.fine.floor);
  });
});

describe("BLUR_BANDS", () => {
  it("orders each set far to near", () => {
    for (const set of [BLUR_BANDS.fine, BLUR_BANDS.coarse]) {
      expect(set[0]).toBeGreaterThan(set[1]);
      expect(set[1]).toBeGreaterThan(set[2]);
      expect(set[2]).toBe(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/depth.test.ts`
Expected: FAIL — cannot resolve `../public/depth.js`

- [ ] **Step 3: Write the implementation**

Create `public/depth.js`:

```js
// Depth presentation for the word field, split out of field.js so the contrast
// test can read the same constants the field renders with. Press quantises
// depth into discrete bands rather than a continuous ramp — see
// docs/superpowers/specs/2026-08-07-press-design-language-design.md.

// Ordered far → near. The coarse set is the original 0.6/1.4 reduction ratio
// (~0.43) applied to the fine bands, preserving the touch legibility floor.
export const BLUR_BANDS = {
  fine: [4, 1.5, 0],
  coarse: [1.7, 0.65, 0],
};

// Carried over verbatim from the pre-Press field: opacity = floor + depth * range.
export const DEPTH_OPACITY = {
  fine: { floor: 0.45, range: 0.55 },
  coarse: { floor: 0.7, range: 0.3 },
};

export function blurBand(depth, coarse) {
  const bands = coarse ? BLUR_BANDS.coarse : BLUR_BANDS.fine;
  if (depth >= 0.66) return bands[2];
  if (depth >= 0.33) return bands[1];
  return bands[0];
}

export function wordOpacity(depth, coarse) {
  const ramp = coarse ? DEPTH_OPACITY.coarse : DEPTH_OPACITY.fine;
  return ramp.floor + depth * ramp.range;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/depth.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Wire it into the field**

In `public/field.js`, add to the imports at the top of the file:

```js
import { blurBand, wordOpacity } from './depth.js';
```

Replace line 67:

```js
    el.style.filter = 'blur(' + ((1 - depth) * (coarse ? 0.6 : 1.4)).toFixed(1) + 'px)';
```

with:

```js
    el.style.filter = 'blur(' + blurBand(depth, coarse).toFixed(2) + 'px)';
```

Replace line 81:

```js
      el.style.opacity = ((coarse ? 0.7 : 0.45) + depth * (coarse ? 0.3 : 0.55)).toFixed(2);
```

with:

```js
      el.style.opacity = wordOpacity(depth, coarse).toFixed(2);
```

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all pass. The other nine test files are pure logic and are unaffected.

- [ ] **Step 7: Commit**

```bash
git add public/depth.js public/field.js test/depth.test.ts
git commit -m "refactor: quantise field depth into Press blur bands"
```

---

### Task 2: The token layer

`public/press.css` — the language itself, defaults set to pear.no's own values.

**Files:**
- Create: `public/press.css`
- Create: `test/press-tokens.test.ts`
- Modify: `public/index.html:23`

**Interfaces:**
- Consumes: nothing
- Produces: the custom properties and utility classes every later task uses — `--press-ground`, `--press-paper`, `--press-ink`, `--press-hair`, `--press-accent`, `--press-face-display`, `--press-face-text`, `--press-face-mono`, `--press-ease`, `--press-dur-fast|base|slow`, `--press-stagger`, `--press-blur-near|mid|far`, `--press-radius`, `--press-v1|v2|h1|h2`; classes `.press-rule`, `.press-cross`, `.press-label`, `.press-go`

- [ ] **Step 1: Write the failing test**

Create `test/press-tokens.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../public/press.css", import.meta.url), "utf8");

const REQUIRED_TOKENS = [
  "--press-ground", "--press-paper", "--press-ink", "--press-hair", "--press-accent",
  "--press-face-display", "--press-face-text", "--press-face-mono",
  "--press-ease", "--press-dur-fast", "--press-dur-base", "--press-dur-slow",
  "--press-stagger",
  "--press-blur-near", "--press-blur-mid", "--press-blur-far",
  "--press-radius",
  "--press-v1", "--press-v2", "--press-h1", "--press-h2",
];

const REQUIRED_CLASSES = [".press-rule", ".press-cross", ".press-label", ".press-go"];

describe("press.css", () => {
  it("defines every documented token", () => {
    for (const token of REQUIRED_TOKENS) {
      expect(css, `missing ${token}`).toContain(`${token}:`);
    }
  });

  it("defines every documented utility class", () => {
    for (const cls of REQUIRED_CLASSES) {
      expect(css, `missing ${cls}`).toContain(cls);
    }
  });

  it("uses the one Press easing curve and no other cubic-bezier", () => {
    const curves = new Set(css.match(/cubic-bezier\([^)]*\)/g) ?? []);
    expect([...curves]).toEqual(["cubic-bezier(0.22, 1, 0.36, 1)"]);
  });

  it("squares corners by default", () => {
    expect(css).toMatch(/--press-radius:\s*0/);
  });

  it("honours prefers-reduced-motion", () => {
    expect(css).toContain("prefers-reduced-motion");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/press-tokens.test.ts`
Expected: FAIL — cannot read `public/press.css`

- [ ] **Step 3: Write the implementation**

Create `public/press.css`:

```css
/* Press — a portable design language extracted from pear.no.
 *
 * Nine patterns: printed ground; hairline architecture; marks at
 * intersections; two faces in three roles; depth by quantised blur; one easing
 * curve; deferred entrance; one hoarded accent; copy as furniture.
 *
 * Defaults below are pear.no's own values. Re-key by overriding these
 * properties in your own stylesheet — do not edit this file per-consumer.
 */

:root {
  /* Palette — a near-black ground and one paper-light foreground. Two tones,
     not a ramp. Text is never pure white. */
  --press-ground: #0b0a09;
  --press-paper: #f2f1ed;
  --press-ink: #1d1c19;
  --press-hair: rgb(29 28 25 / 0.14);
  --press-accent: #015186;

  /* Type — display serif for anything large, sans for body, mono for labels. */
  --press-face-display: "Flecha M", "Iowan Old Style", Georgia, serif;
  --press-face-text: "GT Standard L", ui-sans-serif, -apple-system, Arial, sans-serif;
  --press-face-mono: "GT Standard Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --press-label-size: 11px;
  --press-label-tracking: 0.2em;

  /* Motion — one curve, three durations, one stagger step. */
  --press-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --press-dur-fast: 0.3s;
  --press-dur-base: 0.5s;
  --press-dur-slow: 0.8s;
  --press-stagger: 0.07s;

  /* Depth — discrete bands, never a continuous ramp. These are the language's
     published values, for consumers that layer in CSS. dewpt's field is drawn
     from JS and reads the same numbers from public/depth.js; nothing needs to
     wire these two together. */
  --press-blur-near: 0px;
  --press-blur-mid: 1.5px;
  --press-blur-far: 4px;

  /* Form — Press squares its corners. */
  --press-radius: 0px;

  /* Grid — content aligns to these rules, not to boxes. */
  --press-v1: 5.3%;
  --press-v2: 85.6%;
  --press-h1: 5.3vw;
  --press-h2: calc(65.3% + 50px);
}

/* A 1px hairline that draws itself in from an origin once an ancestor gains
   .press-go. Set --press-rule-axis to `y` for verticals. */
.press-rule {
  background: var(--press-hair);
  transform-origin: 0 0;
  transform: scaleX(0);
  transition: transform var(--press-dur-slow) var(--press-ease) var(--press-rule-delay, 0s);
}
.press-rule[data-axis="y"] {
  transform: scaleY(0);
  transform-origin: 0 0;
}
.press-go .press-rule {
  transform: scaleX(1);
}
.press-go .press-rule[data-axis="y"] {
  transform: scaleY(1);
}

/* The four-pointed mark that sits where rules cross. */
.press-cross {
  width: 9px;
  height: 9px;
  margin: -4.5px 0 0 -4.5px;
  opacity: 0;
  transform: scale(2.6);
  transition:
    opacity var(--press-dur-base) var(--press-ease) var(--press-cross-delay, 0s),
    transform var(--press-dur-base) var(--press-ease) var(--press-cross-delay, 0s);
}
.press-cross svg {
  width: 100%;
  height: 100%;
  display: block;
  fill: currentcolor;
}
.press-go .press-cross {
  opacity: 0.9;
  transform: scale(1);
}

/* Copy as furniture. */
.press-label {
  font-family: var(--press-face-mono);
  font-size: var(--press-label-size);
  font-weight: 400;
  letter-spacing: var(--press-label-tracking);
  text-transform: uppercase;
}

/* .press-go is the entrance gate. Adding it to an ancestor releases every
   primitive above; it carries no styling of its own. */

@media (prefers-reduced-motion: reduce) {
  .press-rule,
  .press-cross {
    transition: none;
  }
  /* Degrade to the finished state, never to invisible content. */
  .press-rule {
    transform: scaleX(1);
  }
  .press-rule[data-axis="y"] {
    transform: scaleY(1);
  }
  .press-cross {
    opacity: 0.9;
    transform: scale(1);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/press-tokens.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Link it ahead of the consumer stylesheet**

In `public/index.html`, replace line 23:

```html
<link rel="stylesheet" href="/styles.css">
```

with:

```html
<link rel="stylesheet" href="/press.css">
<link rel="stylesheet" href="/styles.css">
```

Order matters: `styles.css` overrides Press tokens, so it must come second.

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add public/press.css public/index.html test/press-tokens.test.ts
git commit -m "feat: add the Press token layer"
```

---

### Task 3: Re-key dewpt's palette, with a contrast gate

dewpt takes Press's tonal architecture re-keyed cold. The contrast test is the point of this task: it composites each tier against the ground at its opacity floor, which is the only way the real ratio shows up. Raw ratios flatter these colours badly — `#cdc7dd` reads as 11.86:1 opaque but 3.19:1 at the floor.

Measured baselines for the current design, which this task must not regress: t0 3.43:1, t1 2.68:1, t2 2.77:1.

**Files:**
- Create: `test/contrast.test.ts`
- Modify: `public/styles.css:3-6` (the `:root` block)

**Interfaces:**
- Consumes: `DEPTH_OPACITY` from `public/depth.js` (Task 1); Press tokens from `public/press.css` (Task 2)
- Produces: dewpt's theme — `--ink`, `--field`, `--label`, `--hair`, `--t0`, `--t1`, `--t2`, `--pin` re-keyed, plus Press token overrides

- [ ] **Step 1: Write the failing test**

Create `test/contrast.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// @ts-expect-error — public/depth.js ships untyped
import { DEPTH_OPACITY } from "../public/depth.js";

const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

function token(name: string): string {
  const match = css.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`token ${name} not found in styles.css`);
  return match[1];
}

function channels(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Alpha-composite a foreground over a background, as the browser would. */
function over(fg: string, bg: string, alpha: number): [number, number, number] {
  const f = channels(fg);
  const b = channels(bg);
  return [0, 1, 2].map((i) => f[i] * alpha + b[i] * (1 - alpha)) as [number, number, number];
}

describe("dewpt palette contrast", () => {
  const ground = () => channels(token("--ink"));

  it("keeps opaque label text at AA body contrast", () => {
    expect(contrast(channels(token("--label")), ground())).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the accent at AA body contrast", () => {
    expect(contrast(channels(token("--pin")), ground())).toBeGreaterThanOrEqual(4.5);
  });

  // Field words are deliberately faint at depth — that is the depth cue. They
  // are held to the large-text bar at their dimmest, not the body bar.
  it.each([
    ["--t0", 3.43],
    ["--t1", 2.68],
    ["--t2", 2.77],
  ])("keeps %s legible at the fine-pointer opacity floor", (name, baseline) => {
    const composited = over(token(name), token("--ink"), DEPTH_OPACITY.fine.floor);
    const ratio = contrast(composited, ground());
    expect(ratio).toBeGreaterThanOrEqual(3.0);
    // ...and never worse than the pre-Press design measured at the same floor.
    expect(ratio).toBeGreaterThanOrEqual(baseline);
  });

  it("gives touch users more contrast than fine pointers", () => {
    for (const name of ["--t0", "--t1", "--t2"]) {
      const fine = contrast(over(token(name), token("--ink"), DEPTH_OPACITY.fine.floor), ground());
      const coarse = contrast(over(token(name), token("--ink"), DEPTH_OPACITY.coarse.floor), ground());
      expect(coarse).toBeGreaterThan(fine);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/contrast.test.ts`
Expected: FAIL — `--t1` composites to 2.68:1 against the old ground, below the 3.0 floor

- [ ] **Step 3: Write the implementation**

In `public/styles.css`, replace the `:root` block (lines 3-6):

```css
:root{
  --ink:#14121f; --field:#1a1830; --label:#7d7a99; --hair:#2c2947;
  --t0:#cfd4e8; --t1:#b8a6e8; --t2:#e8a68f; --pin:#f0d98c;
}
```

with:

```css
/* dewpt's theme: Press's tonal architecture re-keyed cold. The concept is
   condensation, so the ground stays blue-black rather than pear.no's warm
   press. Tier hues survive at much lower chroma — tier encodes strangeness,
   so it cannot collapse to one colour. See test/contrast.test.ts: these
   values are gated on composited contrast at the opacity floor, which is the
   only measurement that reflects what a viewer actually sees. */
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/contrast.test.ts`
Expected: PASS, 7 tests. t0 3.66:1, t1 3.19:1, t2 3.24:1 — all above 3.0 and all better than the pre-Press baselines.

- [ ] **Step 5: Fix the hardcoded colours the theme misses**

Several rules hardcode the old palette rather than using variables. Replace each literal in `public/styles.css`:

- `#1e1b2e` (seed input, add input, chip backgrounds) → `#17162a`
- `#565378` (placeholders, `.empty`, `.hint`, `.ghost`, `.subline`) → `#6f6c86`
- `#171528` (`#evaporated`, `#legend` backgrounds) → `#121124`
- `#4a4222` (chip border) → `rgb(240 217 140 / 0.3)`
- in the `#field` radial gradient, `#201d3d` → `#1b1934` and `#171528` → `#100f1e`

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add public/styles.css test/contrast.test.ts
git commit -m "feat: re-key dewpt's palette onto Press, gated on composited contrast"
```

---

### Task 4: The label and control system

Five separate label treatments collapse into one `.press-label`, the four buttons become hairline furniture, and the accent is confined to pinned words and focus rings. This is the pattern that carries most of the "designed" feeling, and it is almost entirely CSS.

**Files:**
- Modify: `public/styles.css` (the `.seed`, `.ctl label`, `.ctl .ends`, `#tray h2`, `#evaporated h2` rules; `#copyBtn`, `#legendBtn`, `#seedForm button`, `#addForm button`; the input rules)
- Modify: `public/index.html` (add `press-label` to the label and button elements)

**Interfaces:**
- Consumes: `.press-label`, `--press-face-display`, `--press-face-text` from `public/press.css`
- Produces: no new interface

- [ ] **Step 1: Add the class in markup**

In `public/index.html`, add `press-label` to the class list of: `.seed` (`#seedDisplay`), each `.ctl label`, each `.ctl .ends`, `#tray h2`, and `#evaporated h2`. For example:

```html
<div class="seed press-label" id="seedDisplay">
```

- [ ] **Step 2: Strip the now-duplicated declarations**

In `public/styles.css`, remove `font-size`, `letter-spacing` and `text-transform` from `.seed`, `.ctl label`, `.ctl .ends`, `#tray h2` and `#evaporated h2` — `.press-label` supplies them. Keep every `color`, `display`, `margin` and layout declaration.

`.ctl label span` keeps its `text-transform:none; letter-spacing:0` override, since the value readout inside the label is not furniture.

- [ ] **Step 3: Point the display and body faces at the tokens**

In `public/styles.css`, replace every `font-family:'Fraunces',serif` with `font-family:var(--press-face-display)`, and `font-family:'Space Grotesk',sans-serif` in the `body` rule with `font-family:var(--press-face-text)`.

- [ ] **Step 4: Make the buttons furniture**

The four buttons — `#copyBtn`, `#legendBtn`, `#seedForm button`, `#addForm button` — become hairline boxes with mono labels. In `public/index.html`, add `press-label` to `#copyBtn`, `#seedForm button` and `#addForm button` (not `#legendBtn`; it is a single `?` glyph, not a word).

In `public/styles.css`, for each of `#copyBtn`, `#seedForm button` and `#addForm button`: delete `font-size:12px` (the class supplies it) and change `border-radius:6px` to `border-radius:var(--press-radius)`. Keep `background:none`, the `border:1px solid var(--hair)`, the padding and every `:hover` and `:focus-visible` rule.

For the inputs (`#seedForm input`, `#addForm input`), change `border-radius:8px` to `border-radius:var(--press-radius)`. Leave their font-size alone — they hold user text, not furniture.

Leave `.chip`'s `border-radius:999px`. Press keeps pills for chips; only rectangles square off.

- [ ] **Step 5: Confine the accent**

Search `public/styles.css` for `var(--pin)` and confirm every remaining use is either a pinned word (`.word.pinned`), a chip (`.chip`, which is a pinned word in the tray), or a `:focus-visible` outline. Any other use — a hover tint, a border, an icon — loses the accent and takes `var(--label)` instead.

Run: `grep -n 'var(--pin)' public/styles.css` and check each hit against that rule.

- [ ] **Step 6: Verify in the browser**

Run: `npm run dev`, open http://localhost:8787

Check: every label is uppercase mono at 10px with wide tracking; the slider value readouts inside labels are still sentence case; buttons read as hairline furniture; gold appears only on pinned words, tray chips and focus rings; nothing has shifted layout.

- [ ] **Step 7: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add public/styles.css public/index.html
git commit -m "feat: collapse dewpt's labels and controls into the Press system"
```

---

### Task 5: The frame

The field's rounded card becomes hairline rules with marks at the corners. Same box, same dimensions — word positioning depends on the rect — but expressed as architecture instead of a card. This is the change most likely to look worse; `--press-radius` makes it a one-line revert.

**Files:**
- Modify: `public/index.html` (add the rule and mark elements inside `#stage`)
- Modify: `public/styles.css` (`#field` rule)

**Interfaces:**
- Consumes: `.press-rule`, `.press-cross`, `--press-radius`, `--press-hair` from `public/press.css`
- Produces: no new interface

- [ ] **Step 1: Add the frame elements**

In `public/index.html`, inside `#stage` and immediately before `<div id="field">`, add a wrapper so the rules can position against the field's box. Change:

```html
<div id="stage">
<div id="field" ...>
```

to:

```html
<div id="stage">
<div id="fieldFrame">
<i class="press-rule" data-edge="top" aria-hidden="true"></i>
<i class="press-rule" data-edge="bottom" aria-hidden="true"></i>
<i class="press-rule" data-axis="y" data-edge="left" aria-hidden="true"></i>
<i class="press-rule" data-axis="y" data-edge="right" aria-hidden="true"></i>
<i class="press-cross" data-corner="tl" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 0Q13.1 10.9 24 12Q13.1 13.1 12 24Q10.9 13.1 0 12Q10.9 10.9 12 0Z"/></svg></i>
<i class="press-cross" data-corner="tr" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 0Q13.1 10.9 24 12Q13.1 13.1 12 24Q10.9 13.1 0 12Q10.9 10.9 12 0Z"/></svg></i>
<i class="press-cross" data-corner="bl" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 0Q13.1 10.9 24 12Q13.1 13.1 12 24Q10.9 13.1 0 12Q10.9 10.9 12 0Z"/></svg></i>
<i class="press-cross" data-corner="br" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 0Q13.1 10.9 24 12Q13.1 13.1 12 24Q10.9 13.1 0 12Q10.9 10.9 12 0Z"/></svg></i>
<div id="field" ...>
```

and close `#fieldFrame` after `#field`'s closing tag.

- [ ] **Step 2: Style the frame**

In `public/styles.css`, add after the `#field` rule:

```css
/* Press frame: the field is bounded by hairlines and corner marks rather than
   a bordered card. #fieldFrame is a positioning context only — it must not
   introduce its own box, or the field's rect (which word placement reads via
   getBoundingClientRect) shifts. */
#fieldFrame{position:relative; flex:1 1 auto; min-width:0; display:flex;}
#fieldFrame .press-rule{position:absolute; z-index:2; pointer-events:none;}
#fieldFrame .press-rule[data-edge="top"]{top:0; left:0; right:0; height:1px;}
#fieldFrame .press-rule[data-edge="bottom"]{bottom:0; left:0; right:0; height:1px;}
#fieldFrame .press-rule[data-edge="left"]{top:0; bottom:0; left:0; width:1px;}
#fieldFrame .press-rule[data-edge="right"]{top:0; bottom:0; right:0; width:1px;}
#fieldFrame .press-rule[data-edge="bottom"]{--press-rule-delay:0.08s;}
#fieldFrame .press-rule[data-edge="right"]{--press-rule-delay:0.12s;}
#fieldFrame .press-cross{position:absolute; z-index:3; color:var(--t0); pointer-events:none; --press-cross-delay:0.5s;}
#fieldFrame .press-cross[data-corner="tl"]{top:0; left:0;}
#fieldFrame .press-cross[data-corner="tr"]{top:0; right:0; margin-right:-4.5px;}
#fieldFrame .press-cross[data-corner="bl"]{bottom:0; left:0; margin-bottom:-4.5px;}
#fieldFrame .press-cross[data-corner="br"]{bottom:0; right:0; margin-right:-4.5px; margin-bottom:-4.5px;}
```

Then in the existing `#field` rule, change `border-radius:14px` to `border-radius:var(--press-radius)` and delete `border:1px solid var(--hair)` — the rules replace it.

In the `#stage` rule, change `#stage #field{flex:1 1 auto; min-width:0;}` to `#stage #fieldFrame{flex:1 1 auto; min-width:0;}` and give `#field` `flex:1 1 auto; min-width:0;`.

- [ ] **Step 3: Verify the field rect is unchanged**

Run: `npm run dev`, open http://localhost:8787, seed the field, and in the console:

```js
document.getElementById('field').getBoundingClientRect()
```

Expected: same width and height as before the change (960 max-width, 480 tall on desktop). If the height collapsed, `#fieldFrame` is missing `display:flex` or `#field` is missing its flex declaration.

- [ ] **Step 4: Verify at mobile width**

Resize to ≤760px. The `#stage` column layout must still apply and `#field` must still take `min(70svh, 560px)`. Add to the existing `@media (max-width: 760px)` block if the frame needs it:

```css
  #fieldFrame{width:100%;}
```

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/styles.css
git commit -m "feat: frame the field with Press hairlines and corner marks"
```

---

### Task 6: Motion and the entrance gate

Every easing becomes the one Press curve, and the chrome entrance is gated behind `.press-go` so it releases after first paint rather than during load.

**Files:**
- Modify: `public/styles.css` (every `transition` and `animation` declaration)
- Modify: `public/app.js` (add the gate)

**Interfaces:**
- Consumes: `--press-ease`, `--press-dur-*`, `--press-stagger`, `.press-go` from `public/press.css`
- Produces: no new interface

- [ ] **Step 1: Re-key every easing**

In `public/styles.css`, replace the timing function in every `transition` and `animation` with `var(--press-ease)`:

- `.word{transition:opacity 1.4s ease, transform 9s linear, filter 0.4s}` → `transition:opacity 1.4s var(--press-ease), transform 9s linear, filter var(--press-dur-fast) var(--press-ease)`
  (the 9s drift stays `linear` — it is constant motion, not an entrance)
- `.ghost{transition:color 0.3s ease}` → `transition:color var(--press-dur-fast) var(--press-ease)`
- `.hint{transition:opacity 0.45s ease}` → `transition:opacity var(--press-dur-base) var(--press-ease)`
- `#manifesto{transition:opacity 0.45s ease}` → `transition:opacity var(--press-dur-base) var(--press-ease)`
- `@keyframes pulse` keeps `ease-out` in its `animation` shorthand → change to `var(--press-ease)`

- [ ] **Step 2: Add the staggered chrome entrance**

In `public/styles.css`, add:

```css
/* Deferred entrance: the header and controls settle once .press-go lands on
   <body>, one step apart. The field is always moving, so the chrome enters
   quietly and only once. */
header, #controls, #tray{
  opacity:0;
  transform:translateY(6px);
  transition:opacity var(--press-dur-base) var(--press-ease),
             transform var(--press-dur-base) var(--press-ease);
}
header{transition-delay:calc(var(--press-stagger) * 1);}
#controls{transition-delay:calc(var(--press-stagger) * 2);}
#tray{transition-delay:calc(var(--press-stagger) * 3);}
.press-go header, .press-go #controls, .press-go #tray{
  opacity:1;
  transform:none;
}

@media (prefers-reduced-motion: reduce){
  /* Degrade to the finished state, never to invisible content. */
  header, #controls, #tray{opacity:1; transform:none; transition:none;}
}
```

- [ ] **Step 3: Land the gate after first paint**

In `public/app.js`, at the very end of the file, after the existing `resume().then(...)` block, add:

```js
// Press entrance gate: release the chrome one frame after first paint, so the
// staggered transitions actually run instead of being the initial state.
requestAnimationFrame(() => {
  requestAnimationFrame(() => document.body.classList.add('press-go'));
});
```

- [ ] **Step 4: Verify the entrance**

Run: `npm run dev`, open http://localhost:8787 with a hard reload.

Check: the four field rules draw in, the corner marks pop shortly after, and the header, controls and tray settle one after another. Then enable `prefers-reduced-motion: reduce` in devtools, hard reload, and confirm **everything is visible and static** — no missing chrome.

- [ ] **Step 5: Confirm the field entrance does not fight the chrome**

Seed the field and watch for ~10s. If the chrome entrance reads as noise against the condensing words (a risk called out in the spec), narrow it: delete the `header, #controls, #tray` entrance block from Step 2 and keep only the rules and marks. Record which you chose in the commit message.

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add public/styles.css public/app.js
git commit -m "feat: re-key dewpt's motion onto Press and gate the entrance"
```

---

### Task 7: Document the language

`press.css` is meant to outlive dewpt. Write down what the patterns are and how to adopt them, so the next consumer does not reverse-engineer the CSS.

**Files:**
- Create: `docs/press.md`

**Interfaces:**
- Consumes: everything above
- Produces: no code interface

- [ ] **Step 1: Write the doc**

Create `docs/press.md` covering: the nine patterns with a one-line description each; the full token table with pear.no defaults and what each controls; the four utility classes and their required markup (including the `data-axis`, `data-edge` and `data-corner` attributes and the star `<path>`); a worked "how to adopt" section using dewpt's own override as the example; and the contrast rule — that tiers are gated on *composited* contrast at the opacity floor, with the reason raw ratios mislead.

- [ ] **Step 2: Verify the doc matches the code**

Cross-check every token named in `docs/press.md` against `public/press.css`. `test/press-tokens.test.ts` holds the authoritative list — if the doc and the test disagree, the test wins.

- [ ] **Step 3: Commit**

```bash
git add docs/press.md
git commit -m "docs: document the Press design language"
```

---

## Verification

After Task 7, the branch should satisfy every line of the spec:

- [ ] `npm test` passes — 12 files (9 pre-existing, plus depth, press-tokens, contrast)
- [ ] `npm run typecheck` passes
- [ ] Rendered at desktop and at ≤760px, where `#stage` becomes a column and `#field` switches to `min(70svh, 560px)`
- [ ] Rendered with `prefers-reduced-motion: reduce`: all chrome visible, no motion
- [ ] Every interactive element still shows a `:focus-visible` ring
- [ ] `#hintLive` and `#manifestoSr` still announce
- [ ] Safe-area padding still applies (check in an iOS simulator or with devtools device emulation)
- [ ] `src/` shows no diff: `git diff main --stat -- src/` is empty
