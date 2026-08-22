# drift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/drift/`, a mobile-first swipe-card surface where each swipe moves your position along a user-named semantic axis and the card is a re-ranked candidate from the existing session pool.

**Architecture:** Client-only. No new Durable Object, no `src/` change, no `wrangler.jsonc` change. A resident (non-consuming) candidate set is drawn from the existing `/api/session/:id/pool` endpoints, coordinates already ship on the wire as `Served.coords`, and position is a reversible 2D point resolved by projection — never by rewriting a candidate.

**Tech Stack:** Plain ESM served raw from `public/` (no build step), vitest importing those modules directly, Cloudflare Workers static assets.

**Spec:** [docs/superpowers/specs/2026-08-22-drift-navigator-design.md](../specs/2026-08-22-drift-navigator-design.md)

## Global Constraints

- **Never block a card on the network.** A swipe resolves from the resident set. Top-up is background only. No `await` on the swipe path.
- **No embeddings on the wire or in client state.** Only `{text, tier, alt, seedDist, coords}`.
- **`textContent`, never `innerHTML`.** Model output is untrusted; `JSON.stringify` does not escape `<`.
- **Mobile floor:** no tap target under 44 pt, `dvh` not `vh`, `viewport-fit=cover` + safe-area insets, no horizontal scroll at 390 px.
- **`prefers-reduced-motion` degrades to a crossfade** — no drift, no transform animation.
- **CSS scoped to `.drift-surface`.** The field's `styles.css`, `press.css` and the board's sheet must never collide with it.
- **Design tokens are the night-walk binding** of the shared `--t0/--t1/--t2/--pin` contract: `--ink #0d0c14`, `--field #151327`, `--deep #100f1e`, `--t0 #cfd4e8`, `--t1 #b8a6e8`, `--t2 #e8a68f`, `--pin #f0d98c`, `--label #9a97b0`, `--faint #565378`, `--hair rgb(232 233 240 / .14)`, `--ease cubic-bezier(0.22,1,0.36,1)`. Fraunces / Space Grotesk / mono labels at 9–10 px, `.18em`–`.26em` tracking.
- **Any threshold that has not been measured must say so at its definition**, per `src/board/types.ts`.
- **Gates:** `npm run typecheck` and `npm test`, reported as counts.

## File Structure

| File | Responsibility |
| --- | --- |
| `public/drift/position.js` | PURE. Frozen normalization range, raw↔normalized conversion, swipe stepping, nearest-unseen ranking, local supply. No DOM, no fetch. |
| `public/drift/axis-lint.js` | PURE. Stage-1 pole checks (length, register, containment) and stage-2 BoW-versus-embedding overlap. No DOM, no fetch. |
| `public/drift/working-set.js` | Owns all network. Resident, non-consuming candidate set; prime, low-water local top-up, `axisIds` flush. |
| `public/drift/drift.js` | Owns pixels. Session lifecycle, axis setup flow, gestures, card render, condensate chip. |
| `public/drift/index.html` | Surface markup: setup flow and card stage. |
| `public/drift/styles.css` | Night-walk tokens, scoped to `.drift-surface`. |
| `test/drift-position.test.ts` | Unit tests for `position.js`. |
| `test/drift-axis-lint.test.ts` | Unit tests for `axis-lint.js`, including check independence. |
| `test/drift-working-set.test.ts` | Mocked-fetch tests for `working-set.js`. |
| `test/drift-client-guards.test.ts` | Source-scanning guards: `textContent`, `dvh`, reduced motion, 44 pt, never-blocks, no embeddings. |

Tasks 1 and 2 are independent of each other and of everything else. Task 3 depends on nothing but is consumed by 5–7. Tasks 4–7 build the surface in order. Task 8 is standalone. Task 9 depends on 2 and 3.

---

### Task 1: `position.js` — the ranking core

**Files:**
- Create: `public/drift/position.js`
- Test: `test/drift-position.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `STEP: number`, `SUPPLY_RADIUS: number`, `SUPPLY_FLOOR: number`, `freezeRange(candidates, axisCount) -> {lo: number[], hi: number[]}`, `widenRange(range, candidates) -> {lo, hi}`, `toNormalized(raw, range, axis) -> number`, `toRaw(norm, range, axis) -> number`, `initialPosition(range) -> number[]`, `stepPosition(position, range, axis, dir, step?) -> number[]`, `distanceTo(candidate, position, range) -> number`, `nextCard(candidates, position, range, seen) -> candidate|null`, `localSupply(candidates, position, range, seen, radius) -> number`.
- A `candidate` is the server's `Served` shape plus one client field: `{text: string, tier: 0|1|2, alt: 0|1, seedDist: number, coords: number[], arrivedAt: number}`.

- [ ] **Step 1: Write the failing test**

Create `test/drift-position.test.ts`:

```ts
import { describe, expect, it } from "vitest";

// public/drift/position.js is plain JS served raw from public/ (no build step),
// so it sits outside tsconfig's include — same arrangement as
// public/pool-client.js's mirror in test/pool-client.test.ts.
// @ts-expect-error — public/drift/position.js ships untyped
import * as positionUntyped from "../public/drift/position.js";

interface Range { lo: number[]; hi: number[] }
interface Candidate { text: string; tier: number; alt: number; seedDist: number; coords: number[]; arrivedAt: number }

const position = positionUntyped as {
  STEP: number;
  SUPPLY_RADIUS: number;
  SUPPLY_FLOOR: number;
  freezeRange(candidates: Candidate[], axisCount: number): Range;
  widenRange(range: Range, candidates: Candidate[]): Range;
  toNormalized(raw: number, range: Range, axis: number): number;
  toRaw(norm: number, range: Range, axis: number): number;
  initialPosition(range: Range): number[];
  stepPosition(pos: number[], range: Range, axis: number, dir: number, step?: number): number[];
  distanceTo(c: Candidate, pos: number[], range: Range): number;
  nextCard(cs: Candidate[], pos: number[], range: Range, seen: Set<string>): Candidate | null;
  localSupply(cs: Candidate[], pos: number[], range: Range, seen: Set<string>, radius: number): number;
};

function cand(text: string, coords: number[], arrivedAt = 0): Candidate {
  return { text, tier: 1, alt: 0, seedDist: 0.5, coords, arrivedAt };
}

describe("freezeRange", () => {
  it("takes per-axis min and max across the set", () => {
    const r = position.freezeRange([cand("a", [-0.1, 0.2]), cand("b", [0.3, -0.4])], 2);
    expect(r.lo).toEqual([-0.1, -0.4]);
    expect(r.hi).toEqual([0.3, 0.2]);
  });

  it("gives a degenerate axis a unit span rather than a zero one", () => {
    // A zero span would make toNormalized divide by zero and every card land at
    // NaN, which ranks as unreachable and empties the surface silently.
    const r = position.freezeRange([cand("a", [0.2]), cand("b", [0.2])], 1);
    expect(r.hi[0]! - r.lo[0]!).toBeGreaterThan(0);
    expect(position.toNormalized(0.2, r, 0)).toBeCloseTo(0.5, 5);
  });

  it("ignores non-finite and missing coords instead of poisoning the range", () => {
    const r = position.freezeRange([cand("a", [0.1]), cand("b", [NaN]), cand("c", [])], 1);
    expect(Number.isFinite(r.lo[0]!)).toBe(true);
    expect(Number.isFinite(r.hi[0]!)).toBe(true);
  });
});

describe("widenRange", () => {
  it("widens for an out-of-range top-up", () => {
    const base = { lo: [0], hi: [1] };
    const r = position.widenRange(base, [cand("x", [1.5]), cand("y", [-0.5])]);
    expect(r.lo).toEqual([-0.5]);
    expect(r.hi).toEqual([1.5]);
  });

  it("is monotone — an inside candidate never narrows the range", () => {
    // Narrowing would move what a stored raw position means, which is exactly
    // the semantic drift the frozen range exists to prevent.
    const base = { lo: [0], hi: [1] };
    const r = position.widenRange(base, [cand("x", [0.5])]);
    expect(r.lo).toEqual([0]);
    expect(r.hi).toEqual([1]);
  });
});

describe("stepPosition", () => {
  it("moves one tenth of the frozen span per swipe", () => {
    const range = { lo: [0], hi: [1] };
    expect(position.stepPosition([0.5], range, 0, 1)[0]).toBeCloseTo(0.6, 5);
    expect(position.stepPosition([0.5], range, 0, -1)[0]).toBeCloseTo(0.4, 5);
  });

  it("scales the step to the raw span, not to 0..1", () => {
    const range = { lo: [-0.2], hi: [0.2] };  // span 0.4
    expect(position.stepPosition([0], range, 0, 1)[0]).toBeCloseTo(0.04, 5);
  });

  it("clamps at the edges instead of walking outside the coordinates", () => {
    const range = { lo: [0], hi: [1] };
    expect(position.stepPosition([0.95], range, 0, 1)[0]).toBe(1);
    expect(position.stepPosition([0.05], range, 0, -1)[0]).toBe(0);
  });

  it("leaves the other axis untouched", () => {
    const range = { lo: [0, 0], hi: [1, 1] };
    expect(position.stepPosition([0.5, 0.5], range, 0, 1)[1]).toBe(0.5);
  });
});

describe("nextCard", () => {
  const range = { lo: [0, 0], hi: [1, 1] };

  it("returns the nearest unseen candidate in normalized 2D", () => {
    const cs = [cand("far", [0.9, 0.9]), cand("near", [0.55, 0.5])];
    expect(position.nextCard(cs, [0.5, 0.5], range, new Set())!.text).toBe("near");
  });

  it("skips anything already seen", () => {
    const cs = [cand("near", [0.5, 0.5]), cand("next", [0.7, 0.5])];
    expect(position.nextCard(cs, [0.5, 0.5], range, new Set(["near"]))!.text).toBe("next");
  });

  it("breaks a tie toward the freshest arrival", () => {
    // The measured axis middle is a dense pile of near-ties (midShare 0.29-0.45).
    // Fresh-first is what turns that pile into a deep well instead of a fixed one.
    const cs = [cand("old", [0.6, 0.5], 1), cand("new", [0.6, 0.5], 2)];
    expect(position.nextCard(cs, [0.5, 0.5], range, new Set())!.text).toBe("new");
  });

  it("never returns a candidate with a missing or non-finite coord", () => {
    const cs = [cand("broken", [0.5], 1), cand("ok", [0.9, 0.9], 1)];
    expect(position.nextCard(cs, [0.5, 0.5], range, new Set())!.text).toBe("ok");
  });

  it("returns null when everything is seen — that is the edge", () => {
    const cs = [cand("a", [0.5, 0.5])];
    expect(position.nextCard(cs, [0.5, 0.5], range, new Set(["a"]))).toBeNull();
  });
});

describe("localSupply", () => {
  const range = { lo: [0, 0], hi: [1, 1] };

  it("counts only unseen candidates inside the radius", () => {
    const cs = [cand("in", [0.52, 0.5]), cand("out", [0.95, 0.95]), cand("seen", [0.51, 0.5])];
    expect(position.localSupply(cs, [0.5, 0.5], range, new Set(["seen"]), 0.15)).toBe(1);
  });

  it("is local, not global — a full set far away reads as a shortage", () => {
    // A global count would let the user walk into a hole while the client
    // believes it is well stocked.
    const cs = Array.from({ length: 50 }, (_, i) => cand(`x${i}`, [0.95, 0.95], i));
    expect(position.localSupply(cs, [0.1, 0.1], range, new Set(), 0.15)).toBe(0);
  });
});

describe("unmeasured constants are labelled as such", () => {
  it("declares SUPPLY_RADIUS and SUPPLY_FLOOR", () => {
    expect(position.SUPPLY_RADIUS).toBeGreaterThan(0);
    expect(position.SUPPLY_FLOOR).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/drift-position.test.ts`
Expected: FAIL — cannot resolve `../public/drift/position.js`.

- [ ] **Step 3: Write minimal implementation**

Create `public/drift/position.js`:

```js
// Pure ranking core for the drift surface. No DOM, no fetch — everything here
// is testable from vitest with fixed vectors and no network.
//
// The mechanic is PROJECTION, not translation: a swipe moves your position and
// the pool is re-ranked, so a candidate is never rewritten and the seed can
// never be abandoned. Measured in
// docs/measurements/2026-08-22-drift-mechanic-spikes.md.

/** One swipe, as a fraction of the frozen span. MEASURED: a 10% step replaces
 *  3-5 of the 5 nearest candidates, so it is the smallest step already shown to
 *  change the neighbourhood. */
export const STEP = 0.1;

/** UNMEASURED, and must stay labelled until it isn't. Radius is 1.5 swipe
 *  steps, so a shortage is detected about a swipe and a half before you walk
 *  into it; the floor mirrors pool-client.js's LOW_WATER of 8. Both are
 *  guesses — see open question 1 in the spec. Measure against a real session
 *  before treating either as tuned. */
export const SUPPLY_RADIUS = 0.15;
export const SUPPLY_FLOOR = 8;

function usable(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Per-axis min/max over the primed set. Frozen once and only ever widened,
 *  because position is stored RAW: if the range moved, a stored position would
 *  drift semantically without the user touching the screen. */
export function freezeRange(candidates, axisCount) {
  const lo = [];
  const hi = [];
  for (let a = 0; a < axisCount; a++) {
    let mn = Infinity;
    let mx = -Infinity;
    for (const c of candidates) {
      const v = c.coords?.[a];
      if (!usable(v)) continue;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    // A degenerate or empty axis gets a unit span CENTRED ON THE VALUE ITSELF,
    // not on zero. A zero span would divide by zero in toNormalized, land every
    // card at NaN, and empty the surface with no error anywhere — but a span of
    // [-0.5, 0.5] around zero is just as wrong when every candidate sits at,
    // say, 0.2: they would all normalize to 0.7 and sit off-centre on a gauge
    // that has nothing to be off-centre about. Centre it and they read 0.5.
    if (!usable(mn) || !usable(mx) || mn === mx) {
      const centre = usable(mn) ? mn : 0;
      mn = centre - 0.5;
      mx = centre + 0.5;
    }
    lo.push(mn);
    hi.push(mx);
  }
  return { lo, hi };
}

/** Monotone by construction — a top-up can only widen. Narrowing would move
 *  what an already-stored raw position means. */
export function widenRange(range, candidates) {
  const lo = [...range.lo];
  const hi = [...range.hi];
  for (let a = 0; a < lo.length; a++) {
    for (const c of candidates) {
      const v = c.coords?.[a];
      if (!usable(v)) continue;
      if (v < lo[a]) lo[a] = v;
      if (v > hi[a]) hi[a] = v;
    }
  }
  return { lo, hi };
}

export function toNormalized(raw, range, axis) {
  const span = range.hi[axis] - range.lo[axis];
  return span === 0 ? 0.5 : (raw - range.lo[axis]) / span;
}

export function toRaw(norm, range, axis) {
  return range.lo[axis] + norm * (range.hi[axis] - range.lo[axis]);
}

/** Start mid-axis on every axis. */
export function initialPosition(range) {
  return range.lo.map((lo, a) => lo + (range.hi[a] - lo) / 2);
}

/** One swipe. `dir` is -1 or +1. The step scales to the RAW span so a swipe is
 *  always a tenth of the axis regardless of how wide the cosines happen to be. */
export function stepPosition(position, range, axis, dir, step = STEP) {
  const next = [...position];
  const span = range.hi[axis] - range.lo[axis];
  const moved = position[axis] + dir * step * span;
  next[axis] = Math.min(range.hi[axis], Math.max(range.lo[axis], moved));
  return next;
}

/** Euclidean distance in NORMALIZED space, so two axes with different raw spans
 *  contribute comparably. Licensed by the measured independence of two named
 *  axes (r -0.038 / +0.107); on correlated axes this would double-count one
 *  direction. A candidate missing any coord returns Infinity and can never win
 *  — the empty-coords guard, enforced at ranking as well as at ingest. */
export function distanceTo(candidate, position, range) {
  let sum = 0;
  for (let a = 0; a < range.lo.length; a++) {
    const v = candidate.coords?.[a];
    if (!usable(v)) return Infinity;
    const d = toNormalized(v, range, a) - toNormalized(position[a], range, a);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Nearest unseen candidate; null when nothing is reachable, which IS the edge
 *  rather than an error. Ties break toward the freshest arrival: the measured
 *  axis middle is a dense pile of near-ties (midShare 0.29-0.45), and fresh-first
 *  is what makes that pile a deep well rather than a fixed one. */
export function nextCard(candidates, position, range, seen) {
  let best = null;
  let bestD = Infinity;
  for (const c of candidates) {
    if (seen.has(c.text)) continue;
    const d = distanceTo(c, position, range);
    if (!Number.isFinite(d)) continue;
    if (d < bestD || (d === bestD && best !== null && c.arrivedAt > best.arrivedAt)) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

/** Unseen candidates within `radius` of the position. The top-up trigger is
 *  LOCAL on purpose: a set of 180 can be plentiful overall and empty exactly
 *  where you stand, and a global count would let you walk into a hole while the
 *  client believes it is well stocked. */
export function localSupply(candidates, position, range, seen, radius) {
  let n = 0;
  for (const c of candidates) {
    if (seen.has(c.text)) continue;
    if (distanceTo(c, position, range) <= radius) n++;
  }
  return n;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/drift-position.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Run the full gates**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; test count rises from 665 to 682, 0 failing.

- [ ] **Step 6: Commit**

```bash
git add public/drift/position.js test/drift-position.test.ts
git commit -m "feat: drift's pure ranking core — frozen range, swipe stepping, nearest-unseen"
```

---

### Task 2: `axis-lint.js` stage 1 — pole checks

**Files:**
- Create: `public/drift/axis-lint.js`
- Test: `test/drift-axis-lint.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LEN_DELTA_MAX: number`, `REGISTER_DELTA_MAX: number`, `tokenize(text) -> string[]`, `commonShare(text) -> number`, `lintPoles(negTerm, posTerm, negPhrase, posPhrase) -> {warnings: {check: string, message: string}[], lenDelta: number, registerDelta: number, contained: boolean}`.
- Warning messages name the **typed term**, never the expanded phrase — the user did not write the phrase and cannot act on a complaint about it.

- [ ] **Step 1: Write the failing test**

Create `test/drift-axis-lint.test.ts`:

```ts
import { describe, expect, it } from "vitest";

// @ts-expect-error — public/drift/axis-lint.js ships untyped
import * as lintUntyped from "../public/drift/axis-lint.js";

interface Warning { check: string; message: string }
interface Report { warnings: Warning[]; lenDelta: number; registerDelta: number; contained: boolean }

const lint = lintUntyped as {
  LEN_DELTA_MAX: number;
  REGISTER_DELTA_MAX: number;
  tokenize(text: string): string[];
  commonShare(text: string): number;
  lintPoles(negTerm: string, posTerm: string, negPhrase: string, posPhrase: string): Report;
};

const checks = (r: Report) => r.warnings.map((w) => w.check).sort();

describe("tokenize", () => {
  it("lowercases and drops punctuation", () => {
    expect(lint.tokenize("A physical object, you can touch!")).toEqual(
      ["a", "physical", "object", "you", "can", "touch"],
    );
  });
});

describe("the three checks are independent", () => {
  // Each fixture must trip its OWN check and no other. Without this the three
  // could be three names for one signal and nobody would notice.

  it("a length gap trips only lenDelta", () => {
    const r = lint.lintPoles(
      "solemn", "playful",
      "a solemn thing",                         // 3 tokens
      "a playful thing you can do with people", // 8 tokens
    );
    expect(checks(r)).toEqual(["lenDelta"]);
    expect(r.lenDelta).toBeGreaterThanOrEqual(lint.LEN_DELTA_MAX);
  });

  it("a register gap trips only registerDelta", () => {
    const r = lint.lintPoles(
      "plain", "arcane",
      "a thing you use",                             // 4 tokens, all everyday
      "heteroscedastic epistemic praxis nomothetic", // 4 tokens, none everyday
    );
    expect(checks(r)).toEqual(["registerDelta"]);
    expect(r.registerDelta).toBeGreaterThanOrEqual(lint.REGISTER_DELTA_MAX);
  });

  it("a contained pole trips only containment", () => {
    // MEASURED: workstream B scored the `X` / `more X` surface control at
    // judgeAUC 0.530 across both seeds — exactly the lexical ceiling, and the
    // same score as the known-mush axis. See
    // docs/measurements/2026-08-22-workstream-b-null-result.md.
    const r = lint.lintPoles("playful", "more playful", "playful", "more playful");
    expect(checks(r)).toEqual(["containment"]);
    expect(r.contained).toBe(true);
  });

  it("a healthy axis trips nothing", () => {
    const r = lint.lintPoles(
      "concrete", "abstract",
      "a tangible solid material substance",
      "a complex theoretical concept",
    );
    expect(r.warnings).toEqual([]);
  });
});

describe("warnings speak in the user's own words", () => {
  it("names the typed term, not the expanded phrase", () => {
    // The user typed "playful". They never wrote "a lighthearted playful
    // activity" and cannot act on a complaint about it.
    const r = lint.lintPoles("dull", "playful", "a dull thing", "a lighthearted playful activity for groups");
    expect(r.warnings.length).toBeGreaterThan(0);
    for (const w of r.warnings) {
      expect(w.message).toMatch(/dull|playful/);
      expect(w.message).not.toMatch(/lighthearted/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/drift-axis-lint.test.ts`
Expected: FAIL — cannot resolve `../public/drift/axis-lint.js`.

- [ ] **Step 3: Write minimal implementation**

Create `public/drift/axis-lint.js`:

```js
// Workstream A's probe lint, adapted to dewpt's ONE-pair axes.
//
// The axis-measurement doc's lint assumes 16 curated pairs, where
// d_bow = mean(bow(pos_i) - bow(neg_i)) can expose a token that dominates the
// mean. With one pair there is no averaging, so only part of it ports. What
// runs here is stage 1: three pure string checks over the EXPANDED phrases,
// reported in terms of the term the user actually typed.
//
// SCOPE, stated because it is easy to over-trust: this catches lexical and
// register fakes. It does NOT catch a weak axis. `solemn` / `playful` expands
// to 4 tokens against 4, both everyday register, no shared token — it passes
// everything here and still produced "community engagement . park and ride" at
// its playful pole. Workstream B went looking for a cheap check that would
// catch that and found none (docs/measurements/2026-08-22-workstream-b-null-result.md).
//
// The lint can tell you an axis is FAKE. It can never tell you an axis is
// MEANINGFUL, so nothing here may present as a verdict — warn and allow.

/** Ports unchanged from the axis-measurement doc: a 2-token gap between poles
 *  that both target 4-8 words is a real length confound. */
export const LEN_DELTA_MAX = 2;

/** UNMEASURED. A register proxy, not idf — there is no corpus to compute idf
 *  against on the client, so this scores the share of tokens drawn from a
 *  compact everyday-word list. Deliberately loose: short descriptive phrases
 *  are mostly function words, which compresses the range and makes a tight
 *  threshold cry wolf. Measure before tightening. */
export const REGISTER_DELTA_MAX = 0.5;

/** Below this, commonShare carries no register signal and must not be trusted.
 *  A one-token phrase scores 0 or 1; a two-token phrase scores 0, 0.5 or 1. The
 *  `X` / `more X` surface control is exactly that shape — "playful" scores 0/1
 *  and "more playful" scores 1/2 — so a single function word manufactures a
 *  0.5 delta out of nothing. That is quantization, not register, and without
 *  this floor the register check fires on every contained pole and stops being
 *  independent of the containment check. */
const MIN_REGISTER_TOKENS = 3;

/** The ~150 most frequent English words. Enough to separate "everyday" from
 *  "technical" in a 4-8 word phrase, and small enough to ship in a client
 *  module. Not a frequency table and not a substitute for one. */
const COMMON = new Set([
  'a','about','after','all','also','an','and','any','are','as','at','back','be','because','been','before',
  'being','between','both','but','by','can','come','could','day','do','does','down','each','even','first',
  'for','from','get','give','go','good','great','has','have','he','her','here','him','his','how','i','if',
  'in','into','is','it','its','just','know','last','life','like','little','long','look','made','make','man',
  'many','may','me','more','most','much','must','my','never','new','no','not','now','of','off','old','on',
  'one','only','or','other','our','out','over','own','part','people','place','put','right','said','same',
  'see','she','should','since','so','some','still','such','take','than','that','the','their','them','then',
  'there','these','they','thing','things','think','this','those','through','time','to','too','two','under',
  'up','us','use','used','very','want','was','way','we','well','were','what','when','where','which','while',
  'who','why','will','with','work','world','would','year','you','your',
]);

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Fraction of tokens drawn from COMMON. 1.0 = entirely everyday. */
export function commonShare(text) {
  const t = tokenize(text);
  if (t.length === 0) return 0;
  return t.filter((w) => COMMON.has(w)).length / t.length;
}

/** True when one pole's token set is a subset of the other's — the `X` /
 *  `more X` shape. MEASURED: workstream B scored that surface control at
 *  judgeAUC 0.530 on both seeds, exactly the lexical ceiling and exactly the
 *  score of the known-mush axis. An axis of this shape orders nothing. */
function isContained(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return true;
  const subset = (x, y) => [...x].every((w) => y.has(w));
  return subset(sa, sb) || subset(sb, sa);
}

/** Stage 1. Runs on the EXPANDED phrases, because that is what gets embedded;
 *  reports in terms of the TYPED terms, because that is what the user can
 *  change. */
export function lintPoles(negTerm, posTerm, negPhrase, posPhrase) {
  const negTokens = tokenize(negPhrase);
  const posTokens = tokenize(posPhrase);
  const lenDelta = Math.abs(negTokens.length - posTokens.length);
  // Scored either way so the caller can see it, but only ACTED on when both
  // sides are long enough for the share to mean anything.
  const registerDelta = Math.abs(commonShare(negPhrase) - commonShare(posPhrase));
  const registerMeasurable =
    negTokens.length >= MIN_REGISTER_TOKENS && posTokens.length >= MIN_REGISTER_TOKENS;
  const contained = isContained(negPhrase, posPhrase);

  const warnings = [];
  if (contained) {
    warnings.push({
      check: 'containment',
      message: `"${negTerm}" and "${posTerm}" describe the same thing with an extra word, so the axis has no direction to give. Try two opposites.`,
    });
  }
  if (lenDelta >= LEN_DELTA_MAX) {
    warnings.push({
      check: 'lenDelta',
      message: `"${negTerm}" and "${posTerm}" expanded to very different lengths, which can make the axis sort by wordiness. Try re-expanding.`,
    });
  }
  if (registerMeasurable && registerDelta >= REGISTER_DELTA_MAX) {
    warnings.push({
      check: 'registerDelta',
      message: `"${negTerm}" and "${posTerm}" expanded into different registers — one everyday, one technical — which can make the axis sort by vocabulary. Try re-expanding.`,
    });
  }
  return { warnings, lenDelta, registerDelta, contained };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/drift-axis-lint.test.ts`
Expected: PASS, 6 tests. If the "register gap trips only registerDelta" fixture also trips `lenDelta`, adjust the fixture's token counts to match — not the threshold.

- [ ] **Step 5: Run the full gates**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; 688 passing, 0 failing.

- [ ] **Step 6: Commit**

```bash
git add public/drift/axis-lint.js test/drift-axis-lint.test.ts
git commit -m "feat: drift's stage-1 probe lint — length, register, containment"
```

---

### Task 3: `working-set.js` — the resident candidate set

**Files:**
- Create: `public/drift/working-set.js`
- Test: `test/drift-working-set.test.ts`

**Interfaces:**
- Consumes: nothing at module level. Callers pass `fetchImpl` for testing.
- Produces: `BUCKETS: string[]`, `DRAW_COUNT: number`, `createWorkingSet(sessionId, opts?) -> {prime(), all(), topUp(), axisIds(), onFlush(cb), size()}`.
  - `all()` returns the resident array. **Non-consuming** — this is the whole reason the module exists, because `pool-client.js`'s `draw()` does `buffer.shift()`.
  - Each resident item is `{text, tier, alt, seedDist, coords, arrivedAt}`; `arrivedAt` is a monotonically increasing counter assigned on ingest, feeding `position.js`'s fresh-first tie-break.
  - `onFlush(cb)` fires when `axisIds` changed and the set was discarded; the caller must reset its frozen range and its seen set.

- [ ] **Step 1: Write the failing test**

Create `test/drift-working-set.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error — public/drift/working-set.js ships untyped
import * as wsUntyped from "../public/drift/working-set.js";

interface Item { text: string; tier: number; alt: number; seedDist: number; coords: number[]; arrivedAt: number }
interface WorkingSet {
  prime(): Promise<void>;
  all(): Item[];
  topUp(): Promise<void>;
  axisIds(): string[];
  onFlush(cb: () => void): void;
  size(): number;
}

const ws = wsUntyped as {
  BUCKETS: string[];
  DRAW_COUNT: number;
  createWorkingSet(id: string, opts?: { fetchImpl?: typeof fetch }): WorkingSet;
};

function served(text: string, coords: number[] = [0.1, 0.2]) {
  return { text, tier: 1, alt: 0, seedDist: 0.4, coords };
}

/** Answers every /pool draw with `bodyFor(bucket)`. */
function poolFetch(bodyFor: (bucket: string) => unknown, status = 200) {
  return vi.fn(async (url: string) => {
    const bucket = new URL(url, "http://x").searchParams.get("bucket")!;
    return { ok: status === 200, status, json: async () => bodyFor(bucket) } as unknown as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => vi.restoreAllMocks());

describe("prime", () => {
  it("draws every bucket and keeps what arrives", async () => {
    const fetchImpl = poolFetch((b) => ({ condensed: [served(`${b}-1`), served(`${b}-2`)], axisIds: ["ax", "ay"] }));
    const set = ws.createWorkingSet("s1", { fetchImpl });
    await set.prime();
    expect(set.size()).toBe(ws.BUCKETS.length * 2);
    expect(set.axisIds()).toEqual(["ax", "ay"]);
  });

  it("survives a partial failure and keeps the buckets that answered", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const bucket = new URL(url, "http://x").searchParams.get("bucket")!;
      if (bucket === "w0a0") return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      return { ok: true, status: 200, json: async () => ({ condensed: [served(bucket)], axisIds: ["ax"] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const set = ws.createWorkingSet("s1", { fetchImpl });
    await set.prime();
    expect(set.size()).toBe(ws.BUCKETS.length - 1);
  });

  it("drops rows whose coords are empty rather than ranking them at a fake position", async () => {
    // coords: [] means the draw beat the axes to readiness. Such a row has no
    // position at all; rendering it would put it wherever the maths happens to
    // land.
    const fetchImpl = poolFetch(() => ({
      condensed: [served("good", [0.1, 0.2]), { ...served("bad"), coords: [] }],
      axisIds: ["ax", "ay"],
    }));
    const set = ws.createWorkingSet("s1", { fetchImpl });
    await set.prime();
    expect(set.all().every((i) => i.coords.length === 2)).toBe(true);
    expect(set.all().some((i) => i.text === "bad")).toBe(false);
  });

  it("stamps a strictly increasing arrivedAt so fresh-first tie-breaks work", async () => {
    const fetchImpl = poolFetch((b) => ({ condensed: [served(`${b}-1`), served(`${b}-2`)], axisIds: ["ax"] }));
    const set = ws.createWorkingSet("s1", { fetchImpl });
    await set.prime();
    const stamps = set.all().map((i) => i.arrivedAt);
    expect(new Set(stamps).size).toBe(stamps.length);
  });
});

describe("all() is non-consuming", () => {
  it("returns the same candidates on repeated reads", async () => {
    // pool-client.js's draw() does buffer.shift(). Projection re-ranks the SAME
    // set every time position moves, so consuming here would empty the surface
    // one swipe at a time.
    const fetchImpl = poolFetch(() => ({ condensed: [served("a")], axisIds: ["ax"] }));
    const set = ws.createWorkingSet("s1", { fetchImpl });
    await set.prime();
    const first = set.all().map((i) => i.text);
    const second = set.all().map((i) => i.text);
    expect(second).toEqual(first);
    expect(set.size()).toBe(ws.BUCKETS.length);
  });
});

describe("axisIds flush", () => {
  it("discards the whole set and notifies when the axis set changes", async () => {
    // coords are shaped for a specific axis set; mixing shapes would rank
    // differently-scored candidates against each other with nothing to tell
    // them apart. pool-client.js flushes every buffer for the same reason.
    let ids = ["ax"];
    const fetchImpl = poolFetch(() => ({ condensed: [served("a", [0.1])], axisIds: ids }));
    const set = ws.createWorkingSet("s1", { fetchImpl });
    const onFlush = vi.fn();
    set.onFlush(onFlush);
    await set.prime();
    expect(set.size()).toBe(ws.BUCKETS.length);

    ids = ["ax", "ay"];
    await set.topUp();
    expect(onFlush).toHaveBeenCalled();
    // Only the post-flush draws survive; nothing scored against ["ax"] remains.
    expect(set.axisIds()).toEqual(["ax", "ay"]);
  });

  it("does not flush when the axis set is unchanged", async () => {
    const fetchImpl = poolFetch(() => ({ condensed: [served("a")], axisIds: ["ax"] }));
    const set = ws.createWorkingSet("s1", { fetchImpl });
    const onFlush = vi.fn();
    set.onFlush(onFlush);
    await set.prime();
    await set.topUp();
    expect(onFlush).not.toHaveBeenCalled();
  });
});

describe("topUp", () => {
  it("does not run twice concurrently", async () => {
    // Draws are DESTRUCTIVE server-side: drawPool DELETEs the rows it returns.
    // A double top-up drains the DO faster than its pump refills.
    const fetchImpl = poolFetch(() => ({ condensed: [served("a")], axisIds: ["ax"] }));
    const set = ws.createWorkingSet("s1", { fetchImpl });
    await Promise.all([set.topUp(), set.topUp()]);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(ws.BUCKETS.length);
  });

  it("never stores an embedding key", async () => {
    // Guards the 245 KB wire mistake from the client side.
    const fetchImpl = poolFetch(() => ({
      condensed: [{ ...served("a"), embedding: [1, 2, 3] }],
      axisIds: ["ax"],
    }));
    const set = ws.createWorkingSet("s1", { fetchImpl });
    await set.prime();
    for (const item of set.all()) expect(Object.keys(item)).not.toContain("embedding");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/drift-working-set.test.ts`
Expected: FAIL — cannot resolve `../public/drift/working-set.js`.

- [ ] **Step 3: Write minimal implementation**

Create `public/drift/working-set.js`:

```js
// The resident candidate set for the drift surface. Owns all network.
//
// This is a SIBLING of public/pool-client.js, not a replacement, and the field
// keeps using that one. The difference is consumption: pool-client's draw() does
// buffer.shift(), which is right for a field that spawns a word and forgets it,
// and wrong here — projection re-ranks the SAME set every time position moves,
// so a consuming read would empty the surface one swipe at a time.
//
// Three server behaviours this has to respect:
//  - drawPool is DESTRUCTIVE. It DELETEs the rows it returns and pushes them
//    into a 300-entry exclude LRU, then kicks the regeneration pump. So the
//    server guarantees no candidate is served twice, this client owns whatever
//    it has drawn, and a reload loses the set.
//  - coords are computed AT DRAW TIME against whatever axes are ready. A draw
//    that beats the axes returns coords: [], which has no position at all.
//  - axisIds indexes coords. A changed axis set makes every held coord
//    unreadable, so the set is discarded rather than silently mixing shapes.

export const BUCKETS = ['w0a0', 'w0a1', 'w1a0', 'w1a1', 'w2a0', 'w2a1'];

/** MAX_DRAW_COUNT on the server is 30. Six buckets at 30 is a 180-candidate
 *  prime against the DO's TARGET_DEPTH of 60 x 6 = 360, so a prime takes about
 *  half the pool and the pump refills behind it. */
export const DRAW_COUNT = 30;

export function createWorkingSet(sessionId, opts = {}) {
  const doFetch = opts.fetchImpl ?? fetch;
  let items = [];
  let currentAxisIds = [];
  let arrivals = 0;
  let inflight = null;
  const flushHandlers = [];

  function sameAxisIds(a, b) {
    return a.length === b.length && a.every((id, i) => id === b[i]);
  }

  /** Copy field by field rather than spreading the server row. A spread would
   *  carry through any key the server later adds — including an embedding, the
   *  245 KB mistake this is a client-side guard against. */
  function ingest(row) {
    return {
      text: row.text,
      tier: row.tier,
      alt: row.alt,
      seedDist: row.seedDist,
      coords: row.coords,
      arrivedAt: ++arrivals,
    };
  }

  async function drawBucket(bucket) {
    // No try/catch swallow at the call site: a bucket that fails is a bucket
    // that contributed nothing, and prime()/topUp() proceed with what arrived.
    const res = await doFetch(`/api/session/${sessionId}/pool?bucket=${bucket}&count=${DRAW_COUNT}`);
    if (!res.ok) return null;
    const body = await res.json();
    return { condensed: body.condensed ?? [], axisIds: body.axisIds ?? [] };
  }

  async function draw() {
    const results = await Promise.all(
      BUCKETS.map((b) => drawBucket(b).catch(() => null)),
    );
    for (const result of results) {
      if (!result) continue;
      if (!sameAxisIds(currentAxisIds, result.axisIds)) {
        // ADOPTION IS NOT A FLUSH. On the first draw currentAxisIds is [] and
        // the server returns the real set, which is not a change — there is
        // nothing stale to discard, and firing onFlush here would make the
        // caller reset a frozen range it has only just computed. Only an
        // already-adopted set changing underneath us is a flush.
        if (currentAxisIds.length > 0) {
          // Every held coord was scored against the old axis set and cannot be
          // reconciled. Losing the set is free — it is ephemeral by design —
          // and the caller must also reset its frozen range and seen set,
          // which is what onFlush is for.
          items = [];
          for (const cb of flushHandlers) cb();
        }
        currentAxisIds = result.axisIds;
      }
      for (const row of result.condensed) {
        // An empty coords array means the draw beat the axes to readiness.
        // Such a row has no position; ranking it would place it wherever the
        // maths happens to land.
        if (!Array.isArray(row.coords) || row.coords.length === 0) continue;
        items.push(ingest(row));
      }
    }
  }

  /** Serialized: draws are destructive, so two concurrent passes drain the DO
   *  faster than its pump refills. */
  function once() {
    if (inflight) return inflight;
    inflight = draw().finally(() => { inflight = null; });
    return inflight;
  }

  return {
    prime: once,
    topUp: once,
    all: () => items,
    size: () => items.length,
    axisIds: () => currentAxisIds,
    onFlush(cb) { flushHandlers.push(cb); },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/drift-working-set.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Run the full gates**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; 697 passing, 0 failing.

- [ ] **Step 6: Commit**

```bash
git add public/drift/working-set.js test/drift-working-set.test.ts
git commit -m "feat: drift's resident working set — non-consuming reads, axisIds flush"
```

---

### Task 4: the surface shell — markup, tokens, and the guard suite

**Files:**
- Create: `public/drift/index.html`, `public/drift/styles.css`
- Test: `test/drift-client-guards.test.ts`

**Interfaces:**
- Consumes: nothing yet — `drift.js` is stubbed in Task 5.
- Produces: element ids consumed by `drift.js` — `#drift-setup`, `#drift-seed-form`, `#drift-seed-input`, `#drift-axis-form`, `#drift-axis-a-neg`, `#drift-axis-a-pos`, `#drift-axis-b-neg`, `#drift-axis-b-pos`, `#drift-axis-status`, `#drift-stage`, `#drift-card`, `#drift-gauges`, `#drift-condensate`, `#drift-condensate-count`, `#drift-condensate-panel`, `#drift-edge`.

- [ ] **Step 1: Write the failing guard test**

Create `test/drift-client-guards.test.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The drift client ships as raw files out of public/drift/ — no build step, no
// module graph a unit test can reach. Everything it promises about ITSELF
// (textContent over innerHTML, reduced motion, touch targets, dvh, never
// blocking) is only a comment unless something reads the files off disk and
// checks. Same shape as test/board-client-guards.test.ts.

const DIR = new URL("../public/drift/", import.meta.url);
const scripts = readdirSync(DIR)
  .filter((n) => n.endsWith(".js"))
  .sort()
  .map((name) => ({ name, source: readFileSync(new URL(name, DIR), "utf8") }));
const css = readFileSync(new URL("styles.css", DIR), "utf8");
const html = readFileSync(new URL("index.html", DIR), "utf8");

/** Lines that are not comments — so a rule can be DISCUSSED in a docstring
 *  without the sweep reading the discussion as a violation. */
function liveLines(source: string): string[] {
  return source
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
}

describe("drift scripts build DOM safely", () => {
  it("never assigns innerHTML — model output is untrusted input", () => {
    for (const { name, source } of scripts) {
      expect(liveLines(source).filter((l) => /\binnerHTML\b/.test(l)), `${name} uses innerHTML`).toEqual([]);
    }
  });

  it("never reads an embedding off the wire", () => {
    for (const { name, source } of scripts) {
      expect(liveLines(source).filter((l) => /\bembedding\b/.test(l)), `${name} touches embeddings`).toEqual([]);
    }
  });
});

describe("the swipe path never blocks", () => {
  it("keeps await out of the gesture handler", () => {
    // A swipe must resolve from the resident set. Pool depth is a correctness
    // requirement, not an optimization (CLAUDE.md).
    const drift = scripts.find((s) => s.name === "drift.js");
    expect(drift, "drift.js is missing").toBeTruthy();
    const body = drift!.source.match(/function onSwipe\([\s\S]*?\n}/);
    expect(body, "onSwipe not found — rename the handler or update this guard").toBeTruthy();
    expect(liveLines(body![0]).filter((l) => /\bawait\b/.test(l))).toEqual([]);
  });
});

describe("drift styles honour prefers-reduced-motion", () => {
  it("declares a reduced-motion block that removes animation and transition", () => {
    const idx = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(idx, "no reduced-motion block").toBeGreaterThan(-1);
    const block = css.slice(idx, css.indexOf("}\n}", idx) + 3);
    expect(block, "reduced motion does not remove animation").toMatch(/animation:\s*none/);
    expect(block, "reduced motion does not remove transition").toMatch(/transition:\s*none/);
  });
});

describe("drift meets the mobile floor", () => {
  it("uses dvh rather than bare vh", () => {
    // \b does NOT sit between "0" and "d", so /\bdvh\b/ never matches 100dvh.
    // Anchor on the digits instead. The bare-vh probe is fine as written:
    // \d+vh cannot match 100dvh because of the intervening "d".
    expect(css.match(/\b\d+vh\b/), "bare vh found; use dvh").toBeNull();
    expect(css, "no dvh unit found").toMatch(/\d+dvh\b/);
  });

  it("declares viewport-fit=cover and uses safe-area insets", () => {
    expect(html).toMatch(/viewport-fit=cover/);
    expect(css).toMatch(/safe-area-inset/);
  });

  it("declares no tap target under 44px", () => {
    const sizes = [...css.matchAll(/min-(?:width|height):\s*(\d+)px/g)].map((m) => Number(m[1]));
    expect(sizes.length, "no min-width/min-height declared at all").toBeGreaterThan(0);
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(44);
  });

  it("never allows horizontal scroll", () => {
    expect(css).toMatch(/overflow-x:\s*hidden/);
  });
});

describe("drift styles keep [hidden] working", () => {
  it("declares a [hidden] override that beats its own display rules", () => {
    // .drift-setup / .drift-axes / .drift-stage / the condensate panel all set
    // an explicit display, which overrides the UA's [hidden] { display: none }.
    // Without an override, el.hidden = true changes nothing on screen.
    expect(css, "no [hidden] override — hidden elements will still render")
      .toMatch(/\[hidden\][^{]*\{[^}]*display:\s*none\s*!important/);
  });
});

describe("drift styles cannot collide with the other surfaces", () => {
  it("scopes every rule to .drift-surface", () => {
    // The field's styles.css, press.css and the board's sheet are different
    // surfaces. An unscoped selector here would leak across all of them.
    const selectors = css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("}")
      .map((chunk) => chunk.split("{")[0]!.trim())
      .filter((s) => s && !s.startsWith("@") && !/^\d+%$/.test(s) && s !== "from" && s !== "to");
    for (const sel of selectors) {
      for (const part of sel.split(",")) {
        const t = part.trim();
        if (!t || t.startsWith(":root")) continue;
        expect(t, `unscoped selector: ${t}`).toMatch(/\.drift-surface/);
      }
    }
  });

  it("does not load the field's or the board's stylesheet", () => {
    // Match an actual <link>, not a mention. The file's own header comment
    // explains WHY it does not inherit press.css, and a bare substring probe
    // reads that explanation as the violation it is warning against.
    const links = [...html.matchAll(/<link\b[^>]*href="([^"]+)"[^>]*>/g)].map((m) => m[1]!);
    expect(links.filter((h) => /press\.css$/.test(h)), "loads press.css").toEqual([]);
    expect(links.filter((h) => /^\/styles\.css$/.test(h)), "loads the field's styles.css").toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/drift-client-guards.test.ts`
Expected: FAIL — `ENOENT`, `public/drift/index.html` does not exist.

- [ ] **Step 3: Write the markup**

Create `public/drift/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark" />
    <title>dewpt · drift</title>
    <meta name="description" content="Name two directions, then steer an idea stream with your thumb." />
    <link rel="icon" href="/favicon-32.png" sizes="32x32" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300..500&family=Space+Grotesk:wght@300..500&display=swap" rel="stylesheet" />
    <!-- Only this stylesheet. The field's styles.css and press.css are a
         different binding of the same token contract; every selector in
         styles.css is scoped to .drift-surface so the surfaces cannot collide.
         test/drift-client-guards.test.ts enforces both halves. -->
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body class="drift-surface">
    <header class="drift-masthead">
      <nav class="drift-doors" aria-label="dewpt surfaces">
        <a href="/"><span aria-hidden="true">←</span> night walk</a>
        <a href="/app/">the field</a>
        <a href="/board/">board</a>
      </nav>
      <h1 class="drift-title">drift</h1>
    </header>

    <section id="drift-setup" class="drift-setup">
      <form id="drift-seed-form" class="drift-seed">
        <label class="drift-vh" for="drift-seed-input">seed</label>
        <input id="drift-seed-input" class="drift-input" type="text" maxlength="64"
               placeholder="a topic, a phrase…" autocomplete="off" />
        <button type="submit" class="drift-button">condense</button>
      </form>

      <form id="drift-axis-form" class="drift-axes" hidden>
        <p class="drift-legend">name two directions to steer by</p>
        <div class="drift-axis-row">
          <input id="drift-axis-a-neg" class="drift-input" type="text" maxlength="32" placeholder="solemn" autocomplete="off" />
          <span class="drift-arrow" aria-hidden="true">↔</span>
          <input id="drift-axis-a-pos" class="drift-input" type="text" maxlength="32" placeholder="playful" autocomplete="off" />
        </div>
        <div class="drift-axis-row">
          <input id="drift-axis-b-neg" class="drift-input" type="text" maxlength="32" placeholder="concrete" autocomplete="off" />
          <span class="drift-arrow" aria-hidden="true">↔</span>
          <input id="drift-axis-b-pos" class="drift-input" type="text" maxlength="32" placeholder="abstract" autocomplete="off" />
        </div>
        <button type="submit" class="drift-button">set the compass</button>
        <!-- Expansion output, lint warnings and failures all land here. It is a
             live region because axis creation is slow by design: the server
             expands both poles with an LLM call before embedding them. -->
        <p id="drift-axis-status" class="drift-status" role="status" aria-live="polite"></p>
      </form>
    </section>

    <main id="drift-stage" class="drift-stage" hidden>
      <div id="drift-gauges" class="drift-gauges"></div>
      <button id="drift-condensate" class="drift-condensate" type="button" aria-expanded="false">
        <span class="drift-vh">condensate</span>
        <span id="drift-condensate-count">0</span>
      </button>
      <div id="drift-condensate-panel" class="drift-condensate-panel" hidden></div>
      <div id="drift-card" class="drift-card" tabindex="0" role="button"
           aria-describedby="drift-hint">…</div>
      <p id="drift-edge" class="drift-edge" role="status" aria-live="polite" hidden></p>
      <p id="drift-hint" class="drift-hint">swipe to move · tap to keep</p>
    </main>

    <script type="module" src="./drift.js"></script>
  </body>
</html>
```

- [ ] **Step 4: Write the stylesheet**

Create `public/drift/styles.css`:

```css
/* drift's surface. Every selector below is scoped to .drift-surface so this
 * cannot collide with public/styles.css, public/press.css or the board's sheet
 * — test/drift-client-guards.test.ts enforces that.
 *
 * The palette binds the shared --t0/--t1/--t2/--pin token contract to the
 * NIGHT-WALK values, matching public/index.html rather than press.css. Two
 * reasons, both in the spec: SPEC.md's tier guardrail is this palette ("pale
 * slate -> lilac -> warm ember; pinned = gold"), and press.css is explicitly
 * "two tones, not a ramp", so it structurally cannot carry the card's
 * strangeness cue. */
:root {
  --ink: #0d0c14;
  --field: #151327;
  --deep: #100f1e;
  --t0: #cfd4e8;
  --t1: #b8a6e8;
  --t2: #e8a68f;
  --pin: #f0d98c;
  --label: #9a97b0;
  --faint: #565378;
  --hair: rgb(232 233 240 / 0.14);
  --serif: 'Fraunces', 'Iowan Old Style', Georgia, serif;
  --sans: 'Space Grotesk', ui-sans-serif, -apple-system, 'Helvetica Neue', Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
}

.drift-surface {
  margin: 0;
  min-height: 100dvh;
  overflow-x: hidden;
  background: var(--ink);
  color: var(--t0);
  font-family: var(--sans);
  font-weight: 300;
  padding:
    env(safe-area-inset-top) env(safe-area-inset-right)
    env(safe-area-inset-bottom) env(safe-area-inset-left);
}

/* [hidden] MUST beat our own display declarations. The UA rule is
 * [hidden] { display: none }, which any explicit `display` on the same element
 * overrides — and .drift-setup, .drift-axes, .drift-stage and the condensate
 * panel all set display: grid. Without this the setup form stays on screen
 * after the stage opens while el.hidden dutifully reports true, so the DOM and
 * the pixels disagree and only a screenshot catches it. Pinned by
 * test/drift-client-guards.test.ts. */
.drift-surface [hidden] { display: none !important; }

.drift-surface .drift-vh {
  position: absolute;
  width: 1px; height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.drift-surface .drift-masthead { padding: 18px 20px 0; }

.drift-surface .drift-doors {
  display: flex;
  gap: 18px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
}
.drift-surface .drift-doors a {
  color: var(--label);
  text-decoration: none;
  border-bottom: 1px solid transparent;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
}
.drift-surface .drift-doors a:hover,
.drift-surface .drift-doors a:focus-visible { color: var(--t0); border-color: var(--pin); }

.drift-surface .drift-title {
  font-family: var(--serif);
  font-weight: 300;
  font-size: clamp(38px, 11vw, 64px);
  letter-spacing: -0.015em;
  margin: 8px 0 0;
}

.drift-surface .drift-setup { padding: 24px 20px; display: grid; gap: 22px; }
.drift-surface .drift-legend {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.2em;
  text-transform: uppercase; color: var(--label); margin: 0 0 10px;
}
.drift-surface .drift-seed,
.drift-surface .drift-axis-row { display: flex; gap: 10px; align-items: center; }
.drift-surface .drift-axes { display: grid; gap: 14px; }
.drift-surface .drift-arrow { color: var(--faint); }

.drift-surface .drift-input {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 44px;
  padding: 10px 12px;
  background: var(--deep);
  color: var(--t0);
  border: 1px solid var(--hair);
  border-radius: 3px;
  font: inherit;
}
.drift-surface .drift-button {
  min-height: 44px;
  min-width: 44px;
  padding: 10px 18px;
  background: transparent;
  color: var(--pin);
  border: 1px solid var(--hair);
  border-radius: 3px;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  cursor: pointer;
}
.drift-surface .drift-status {
  font-size: 13px; line-height: 1.6; color: var(--label); margin: 0; min-height: 1.6em;
}
.drift-surface .drift-status[data-tone='warn'] { color: var(--t2); }
.drift-surface .drift-status[data-tone='degraded'] { color: var(--t2); font-style: italic; }

.drift-surface .drift-stage {
  position: relative;
  min-height: 78dvh;
  display: grid;
  grid-template-rows: auto 1fr auto;
  gap: 16px;
  padding: 12px 20px 24px;
}

/* Right padding reserves the condensate chip's corner. The chip is
 * position: absolute at top/right of the stage and the gauges are the stage's
 * first grid row, so without this the chip lands on top of the positive pole's
 * label — 44px chip + 12px breathing room. */
.drift-surface .drift-gauges { display: grid; gap: 8px; padding-right: 56px; }
.drift-surface .drift-gauge {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 10px;
  align-items: center;
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--label);
}
.drift-surface .drift-gauge-track {
  position: relative; height: 1px; background: var(--hair);
}
.drift-surface .drift-gauge-mark {
  position: absolute; top: -3px; width: 7px; height: 7px; border-radius: 50%;
  background: var(--pin); transform: translateX(-50%);
  transition: left 0.3s var(--ease);
}

.drift-surface .drift-card {
  align-self: center;
  justify-self: center;
  max-width: 90%;
  text-align: center;
  font-family: var(--serif);
  font-weight: 300;
  font-size: clamp(30px, 9vw, 54px);
  line-height: 1.08;
  letter-spacing: -0.01em;
  color: var(--t0);
  background: none;
  border: 0;
  cursor: pointer;
  transition: opacity 0.3s var(--ease), transform 0.3s var(--ease);
}
/* The strangeness cue. tier already ships on Served, so this costs nothing.
 * SPEC.md holds the ramp as a guardrail: pale slate -> lilac -> warm ember,
 * pinned = gold. */
.drift-surface .drift-card[data-tier='0'] { color: var(--t0); }
.drift-surface .drift-card[data-tier='1'] { color: var(--t1); }
.drift-surface .drift-card[data-tier='2'] { color: var(--t2); }
.drift-surface .drift-card[data-pinned='true'] { color: var(--pin); }
.drift-surface .drift-card[data-leaving='true'] { opacity: 0; }

.drift-surface .drift-condensate {
  position: absolute;
  top: 0; right: 20px;
  min-width: 44px; min-height: 44px;
  background: transparent;
  border: 1px solid var(--hair);
  border-radius: 999px;
  color: var(--pin);
  font-family: var(--mono);
  font-size: 12px;
  cursor: pointer;
}
.drift-surface .drift-condensate-panel {
  position: absolute;
  inset: 0;
  z-index: 2;
  background: var(--deep);
  border: 1px solid var(--hair);
  border-radius: 4px;
  padding: 20px;
  overflow-y: auto;
  display: grid;
  gap: 10px;
  align-content: start;
}
.drift-surface .drift-condensate-item { color: var(--pin); font-size: 16px; }

.drift-surface .drift-edge {
  text-align: center;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--t2);
  margin: 0;
}
.drift-surface .drift-hint {
  text-align: center;
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.24em;
  text-transform: uppercase;
  color: var(--faint);
  margin: 0;
}

/* Fade only, no drift — a correctness constraint, not a preference. */
@media (prefers-reduced-motion: reduce) {
  .drift-surface .drift-card,
  .drift-surface .drift-gauge-mark {
    animation: none;
    transition: none;
  }
}
```

- [ ] **Step 5: Create a placeholder `drift.js` so the guard suite can load**

The `never blocks` guard looks for `function onSwipe(`. Create `public/drift/drift.js` with just enough to satisfy the file read; Task 5 replaces it wholesale.

```js
// Replaced in full by Task 5.
export function onSwipe() {
  return null;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/drift-client-guards.test.ts`
Expected: PASS, 10 tests. The `textContent` assertion is deliberately not here — see Task 6 step 2.

- [ ] **Step 7: Run the full gates**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; 707 passing, 0 failing.

- [ ] **Step 8: Commit**

```bash
git add public/drift/index.html public/drift/styles.css public/drift/drift.js test/drift-client-guards.test.ts
git commit -m "feat: drift's surface shell — night-walk tokens, scoped CSS, client guards"
```

---

### Task 5: `drift.js` — the setup flow

**Files:**
- Modify (replace wholesale): `public/drift/drift.js`
- Test: manual browser verification; the guard suite from Task 4 keeps passing.

**Interfaces:**
- Consumes: `createWorkingSet` from `working-set.js`; `lintPoles` from `axis-lint.js`; `createAxisClient` from `/axes.js` (existing — `axes()`, `list()`, `create(negTerm, posTerm)`, `remove(id)`).
- Produces: module-level `state` shared with Task 6 — `{sessionId, set, range, position, seen, axes, pinned}`, plus `startStage()` which Task 6 calls once the prime completes.

**Existing API shapes this task relies on** (do not re-derive them):
- `POST /api/session` with `{seed, dewpoint, altitude, drizzle}` → `{id, ...}`.
- `POST /api/session/:id/axes` via `createAxisClient.create(negTerm, posTerm)` → `{axes: [...]}` on 201; throws with `.status` 409 (cap) or 422 (degenerate poles), and the thrown error's `.payload` carries `{error, axes}` so the client can explain and repaint without a follow-up GET.
- `createAxisClient.create()` resolves to the axes **array itself**, not to a `{ axes }` envelope.
- An axis is `{ id, neg: {term, phrase}, pos: {term, phrase}, ready, degraded }`. **The poles are nested** — there are no flat `negTerm`/`posPhrase` fields. Verified against the running server.

- [ ] **Step 1: Replace `public/drift/drift.js`**

```js
// drift's controller. Owns pixels and lifecycle; position.js owns the maths and
// working-set.js owns the network.
//
// Client-only by design: no Durable Object, no src/ change. Coordinates already
// ship on the wire as Served.coords, so this surface is a new renderer over
// machinery that has been sitting unrendered since workstream C.

import { createAxisClient } from '/axes.js';
import { lintPoles } from './axis-lint.js';
import { createWorkingSet } from './working-set.js';
import {
  SUPPLY_FLOOR, SUPPLY_RADIUS,
  freezeRange, initialPosition, localSupply, nextCard, stepPosition, toNormalized, widenRange,
} from './position.js';

const els = {
  setup: document.getElementById('drift-setup'),
  seedForm: document.getElementById('drift-seed-form'),
  seedInput: document.getElementById('drift-seed-input'),
  axisForm: document.getElementById('drift-axis-form'),
  aNeg: document.getElementById('drift-axis-a-neg'),
  aPos: document.getElementById('drift-axis-a-pos'),
  bNeg: document.getElementById('drift-axis-b-neg'),
  bPos: document.getElementById('drift-axis-b-pos'),
  status: document.getElementById('drift-axis-status'),
  stage: document.getElementById('drift-stage'),
  card: document.getElementById('drift-card'),
  gauges: document.getElementById('drift-gauges'),
  condensate: document.getElementById('drift-condensate'),
  condensateCount: document.getElementById('drift-condensate-count'),
  condensatePanel: document.getElementById('drift-condensate-panel'),
  edge: document.getElementById('drift-edge'),
};

export const state = {
  sessionId: null,
  axisClient: null,
  set: null,
  range: null,
  position: null,
  seen: new Set(),
  axes: [],
  pinned: [],
  current: null,
};

function say(message, tone) {
  els.status.textContent = message;
  if (tone) els.status.dataset.tone = tone;
  else delete els.status.dataset.tone;
}

// ── seed ────────────────────────────────────────────────────────────────────

els.seedForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const seed = els.seedInput.value.trim();
  if (!seed) return;
  const button = els.seedForm.querySelector('button');
  button.disabled = true;
  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seed, dewpoint: 0.35, altitude: 0.25, drizzle: 0.5 }),
    });
    if (!res.ok) throw new Error(`session create failed: ${res.status}`);
    const session = await res.json();
    state.sessionId = session.id;
    state.axisClient = createAxisClient(session.id);
    state.set = createWorkingSet(session.id);
    // A flush means every held coord was scored against a different axis set.
    // The frozen range and the seen set are shaped for those coords too, so
    // they go with it.
    state.set.onFlush(() => { state.range = null; state.seen = new Set(); });
    location.hash = session.id;
    els.seedForm.hidden = true;
    els.axisForm.hidden = false;
    els.aNeg.focus();
  } catch (err) {
    console.error(err);
    say('could not start a session. try again.', 'warn');
    button.disabled = false;
  }
});

// ── axes ────────────────────────────────────────────────────────────────────

/** Axis creation is slow by design — the server expands both poles with an LLM
 *  call before embedding them — so this shows progress and never runs on the
 *  swipe path. */
async function createAxis(negTerm, posTerm) {
  // createAxisClient.create() resolves to the axes ARRAY itself, not to a
  // { axes } envelope — verified against the running server, not assumed. The
  // newly created axis is the last element.
  const axes = await state.axisClient.create(negTerm, posTerm);
  return axes[axes.length - 1];
}

/** An axis is { id, neg: {term, phrase}, pos: {term, phrase}, ready, degraded }.
 *  The poles are NESTED; there are no flat negTerm/posPhrase fields. Read off
 *  the live API rather than assumed — the flat shape cost a full browser debug
 *  cycle, and the failure was silent in a nasty way: the server had already
 *  created the axis before the client threw on the shape, so the UI reported
 *  "could not create that axis" about an axis that existed. */
const negTermOf = (a) => a.neg.term;
const posTermOf = (a) => a.pos.term;

function reportAxis(axis) {
  // A degraded pole means expandPole fell back to the bare term. The spike puts
  // a bare term at AUC 0.640 against 0.980 for a descriptive phrase, so this is
  // a quality cliff the user has to be able to see.
  if (axis.degraded) {
    say(`"${negTermOf(axis)}" or "${posTermOf(axis)}" could not be expanded, so this axis will sort weakly. Try different words.`, 'degraded');
    return;
  }
  const report = lintPoles(negTermOf(axis), posTermOf(axis), axis.neg.phrase, axis.pos.phrase);
  if (report.warnings.length > 0) {
    // Warn and allow, never block. The lint can tell you an axis is fake; it
    // can never tell you an axis is meaningful, so it must not read as a
    // verdict — and workstream B found nothing cheap that catches a merely
    // WEAK axis at all.
    say(report.warnings[0].message, 'warn');
  }
}

els.axisForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const pairs = [
    [els.aNeg.value.trim(), els.aPos.value.trim()],
    [els.bNeg.value.trim(), els.bPos.value.trim()],
  ].filter(([n, p]) => n && p);
  if (pairs.length === 0) {
    say('name at least one direction — two gives you all four swipes.', 'warn');
    return;
  }
  const button = els.axisForm.querySelector('button');
  button.disabled = true;
  say('expanding the poles…');

  const created = [];
  for (const [negTerm, posTerm] of pairs) {
    try {
      const axis = await createAxis(negTerm, posTerm);
      created.push(axis);
      reportAxis(axis);
    } catch (err) {
      // 409 (cap) and 422 (degenerate poles) both carry `error` plus the
      // current `axes`, specifically so this can explain and repaint without a
      // follow-up GET.
      const detail = err?.payload?.error ?? 'could not create that axis';
      say(`"${negTerm}" ↔ "${posTerm}": ${detail}`, 'warn');
    }
  }
  if (created.length === 0) {
    button.disabled = false;
    return;
  }
  state.axes = created;
  await enterStage();
});

// ── prime and hand off ──────────────────────────────────────────────────────

async function enterStage() {
  say('condensing…');
  // Axes before prime: a draw taken before the axes are ready comes back with
  // coords: [] and is unrankable. working-set.js drops those rows, so an early
  // prime would silently yield an empty set rather than a wrong one.
  await state.set.prime();
  if (state.set.size() === 0) {
    say('nothing condensed yet — give it a moment and try again.', 'warn');
    els.axisForm.querySelector('button').disabled = false;
    return;
  }
  state.range = freezeRange(state.set.all(), state.axes.length);
  state.position = initialPosition(state.range);
  els.setup.hidden = true;
  els.stage.hidden = false;
  renderGauges();
  advance();
}

// renderGauges, advance, onSwipe and the condensate handlers are Task 6 and 7.
export { enterStage };
```

- [ ] **Step 2: Verify the guard suite still passes**

Run: `npx vitest run test/drift-client-guards.test.ts`
Expected: FAIL on the `never blocks` guard — `onSwipe` no longer exists. That is correct; Task 6 restores it. Note the failure and continue to Task 6 rather than weakening the guard.

- [ ] **Step 3: Commit**

```bash
git add public/drift/drift.js
git commit -m "feat: drift's setup flow — seed, axis naming, expansion report, prime"
```

---

### Task 6: `drift.js` — the card loop

**Files:**
- Modify: `public/drift/drift.js` (append)
- Test: `test/drift-client-guards.test.ts` (already written; the `never blocks` guard becomes meaningful here)

**Interfaces:**
- Consumes: `state`, `els`, `enterStage` from Task 5; everything `position.js` produces.
- Produces: `onSwipe(axis, dir)`, `advance()`, `renderGauges()`.

- [ ] **Step 1: Append the card loop to `public/drift/drift.js`**

```js
// ── the card loop ───────────────────────────────────────────────────────────

const AXIS_KEYS = [
  { axis: 0, dir: -1, key: 'ArrowLeft' },
  { axis: 0, dir: 1, key: 'ArrowRight' },
  { axis: 1, dir: -1, key: 'ArrowUp' },
  { axis: 1, dir: 1, key: 'ArrowDown' },
];

function renderGauges() {
  els.gauges.textContent = '';
  // With one axis named — or one of two failing to create — up/down have
  // nowhere to go. The spec's degradation rule is that they go inert and are
  // LABELLED inert, so the surface opens rather than refusing and the user is
  // not left swiping at a direction that silently does nothing.
  document.getElementById('drift-hint').textContent =
    state.axes.length >= 2 ? 'swipe to move · tap to keep' : 'swipe left and right to move · tap to keep';
  state.axes.forEach((axis, i) => {
    const row = document.createElement('div');
    row.className = 'drift-gauge';
    const lo = document.createElement('span');
    // textContent, never innerHTML: these are user-typed terms, and the card
    // below is model output. Both are untrusted.
    lo.textContent = negTermOf(axis);
    const track = document.createElement('div');
    track.className = 'drift-gauge-track';
    const mark = document.createElement('i');
    mark.className = 'drift-gauge-mark';
    mark.dataset.axis = String(i);
    track.appendChild(mark);
    const hi = document.createElement('span');
    hi.textContent = posTermOf(axis);
    row.append(lo, track, hi);
    els.gauges.appendChild(row);
  });
  paintGauges();
}

function paintGauges() {
  for (const mark of els.gauges.querySelectorAll('.drift-gauge-mark')) {
    const a = Number(mark.dataset.axis);
    mark.style.left = `${toNormalized(state.position[a], state.range, a) * 100}%`;
  }
}

/** Show the nearest unseen candidate, or the edge. Synchronous by contract —
 *  never awaits, because a swipe must resolve from the resident set. */
function advance() {
  const card = nextCard(state.set.all(), state.position, state.range, state.seen);
  state.current = card;
  if (card === null) {
    // Not an error and not a game over: the tails of a projected blob are thin,
    // so out here there is nothing left that is still tethered to the seed.
    els.card.textContent = '';
    els.edge.hidden = false;
    els.edge.textContent = 'nothing out here yet';
    return;
  }
  els.edge.hidden = true;
  els.card.textContent = card.text;
  els.card.dataset.tier = String(card.tier);
  els.card.dataset.pinned = String(state.pinned.includes(card.text));
  state.seen.add(card.text);
}

/** A swipe. NO await anywhere in here — pool depth is a correctness
 *  requirement, not an optimization (CLAUDE.md), and the top-up below is
 *  deliberately un-awaited so the card never waits on the network. */
function onSwipe(axis, dir) {
  if (state.range === null || axis >= state.axes.length) return null;
  state.position = stepPosition(state.position, state.range, axis, dir);
  paintGauges();
  advance();
  maybeTopUp();
  return state.current;
}

/** Fire-and-forget. The trigger is LOCAL supply near the current position: a
 *  set of 180 can be plentiful overall and empty exactly where you stand. */
function maybeTopUp() {
  const supply = localSupply(state.set.all(), state.position, state.range, state.seen, SUPPLY_RADIUS);
  if (supply >= SUPPLY_FLOOR) return;
  state.set.topUp()
    .then(() => {
      if (state.range === null) {
        // The set flushed under us — the axis set changed. Re-freeze from
        // whatever arrived rather than reusing a range shaped for old coords.
        if (state.set.size() === 0) return;
        state.range = freezeRange(state.set.all(), state.axes.length);
        state.position = initialPosition(state.range);
      } else {
        state.range = widenRange(state.range, state.set.all());
      }
      paintGauges();
      if (state.current === null) advance();
    })
    .catch((err) => console.error('drift top-up failed', err));
}

// ── input ───────────────────────────────────────────────────────────────────

let touchStart = null;
const SWIPE_MIN_PX = 40;

els.card.addEventListener('touchstart', (e) => {
  const t = e.changedTouches[0];
  touchStart = { x: t.clientX, y: t.clientY };
}, { passive: true });

els.card.addEventListener('touchend', (e) => {
  if (!touchStart) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touchStart.x;
  const dy = t.clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) < SWIPE_MIN_PX && Math.abs(dy) < SWIPE_MIN_PX) return; // a tap; the click handler owns it
  if (Math.abs(dx) >= Math.abs(dy)) onSwipe(0, dx > 0 ? 1 : -1);
  else onSwipe(1, dy > 0 ? 1 : -1);
}, { passive: true });

// Keyboard parity, so the surface is operable without a pointer (#26's concern,
// solved here rather than inherited).
els.card.addEventListener('keydown', (e) => {
  const match = AXIS_KEYS.find((k) => k.key === e.key);
  if (match) {
    e.preventDefault();
    onSwipe(match.axis, match.dir);
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    pinCurrent();
  }
});

export { advance, onSwipe, renderGauges };
```

- [ ] **Step 2: Restore the textContent assertion, now that a renderer exists**

Add back into `test/drift-client-guards.test.ts`, inside the
`drift scripts build DOM safely` block. It is deliberately absent from Task 4:
until the card renderer existed it asserted a claim the code did not make.

```ts
  it("uses textContent somewhere, so cards are actually rendered the safe way", () => {
    expect(scripts.some((s) => /\btextContent\b/.test(s.source))).toBe(true);
  });
```

- [ ] **Step 3: Run the guard suite**

Run: `npx vitest run test/drift-client-guards.test.ts`
Expected: PASS, 11 tests. The `never blocks` guard now finds `function onSwipe(` and confirms no `await` in its body.

- [ ] **Step 3: Run the full gates**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; 708 passing, 0 failing.

- [ ] **Step 4: Verify in a browser**

Start the dev server through the preview tooling (never `wrangler dev` from Bash), open `/drift/`, and confirm:
- a seed starts a session and the axis form appears;
- naming two axes shows the expansion status and then the card stage;
- arrow keys move both gauge marks and change the card;
- the card's colour changes with `data-tier`;
- at 390 px wide there is no horizontal scroll.

If Workers AI is unreachable, `/api/debug/ai` will say so — see `CLAUDE.md` for the WARP and Access traps before debugging this surface's code.

- [ ] **Step 5: Commit**

```bash
git add public/drift/drift.js
git commit -m "feat: drift's card loop — swipe moves position, projection picks the card"
```

---

### Task 7: the condensate chip

**Files:**
- Modify: `public/drift/drift.js` (append)

**Interfaces:**
- Consumes: `state`, `els`, `advance` from Tasks 5–6.
- Produces: `pinCurrent()` — referenced by Task 6's keydown handler, so this task must land for that path to work.

- [ ] **Step 1: Append the condensate handlers**

```js
// ── condensate ──────────────────────────────────────────────────────────────

/** Tap keeps. Pins are shared session state, so a pin made here is a pin in the
 *  field. This is a FOREGROUND user action: unlike a background top-up, its
 *  failure must surface rather than be swallowed. */
async function pinCurrent() {
  const card = state.current;
  if (!card || state.pinned.includes(card.text)) return;
  els.card.dataset.pinned = 'true';
  state.pinned.push(card.text);
  paintCondensate();
  try {
    const res = await fetch(`/api/session/${state.sessionId}/pin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: card.text, tier: card.tier }),
    });
    if (!res.ok) throw new Error(`pin failed: ${res.status}`);
  } catch (err) {
    console.error(err);
    // Roll the optimistic paint back rather than showing a pin the server does
    // not have.
    state.pinned = state.pinned.filter((t) => t !== card.text);
    els.card.dataset.pinned = 'false';
    paintCondensate();
    els.edge.hidden = false;
    els.edge.textContent = 'could not keep that one';
  }
}

function paintCondensate() {
  els.condensateCount.textContent = String(state.pinned.length);
  els.condensatePanel.textContent = '';
  for (const text of state.pinned) {
    const row = document.createElement('div');
    row.className = 'drift-condensate-item';
    row.textContent = text;
    els.condensatePanel.appendChild(row);
  }
}

els.card.addEventListener('click', (e) => {
  e.preventDefault();
  pinCurrent();
});

els.condensate.addEventListener('click', () => {
  const open = els.condensatePanel.hidden;
  els.condensatePanel.hidden = !open;
  els.condensate.setAttribute('aria-expanded', String(open));
});

// The panel dismisses on its own click and on Escape — deliberately NOT on a
// swipe. A swipe-to-dismiss over a swipe surface is the one real hazard in
// choosing an expandable chip, and the two gestures must not overlap.
els.condensatePanel.addEventListener('click', () => {
  els.condensatePanel.hidden = true;
  els.condensate.setAttribute('aria-expanded', 'false');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.condensatePanel.hidden) {
    els.condensatePanel.hidden = true;
    els.condensate.setAttribute('aria-expanded', 'false');
    els.condensate.focus();
  }
});

export { pinCurrent };
```

- [ ] **Step 2: Run the full gates**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; 708 passing, 0 failing.

- [ ] **Step 3: Verify in a browser**

Tap a card; the chip count increments and the card turns gold. Tap the chip; the panel lists the kept words. Tap the panel or press Escape; it closes. Confirm a swipe on the card while the panel is open does not move position.

- [ ] **Step 4: Commit**

```bash
git add public/drift/drift.js
git commit -m "feat: drift's condensate chip — tap to keep, tap the count to review"
```

---

### Task 8: the doors nav

**Files:**
- Modify: `public/index.html` (the `#doors` nav, around line 329)
- Modify: `public/board/index.html` (the `.board-doors` nav, around line 20)
- Test: `test/landing-nav.test.ts` (existing — extend it)

**Interfaces:** none. Pure markup.

There is **no symmetric three-way nav to extend**. `/` and `/board/` carry real surface navs; `/app/` has only a back-link to `/` and no board link at all. That gap is [#56](https://github.com/schmug/dewpt/issues/56) — **do not fix it here.** Adding `/drift/` to `/app/` would mean building the nav #56 exists to build, in a PR about a different surface.

- [ ] **Step 1: Read the existing nav test to match its shape**

Run: `sed -n '1,40p' test/landing-nav.test.ts`

- [ ] **Step 2: Add a failing assertion**

Append to `test/landing-nav.test.ts` a case asserting the landing's `#doors` nav links to `/drift/`, in whatever style the surrounding cases already use (they read `public/index.html` off disk).

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/landing-nav.test.ts`
Expected: FAIL — no `/drift/` link.

- [ ] **Step 4: Add the link to both real navs**

In `public/index.html`'s `#doors` nav, after the `/app/` link:

```html
    <a href="/drift/">drift</a>
```

In `public/board/index.html`'s `.board-doors` nav, after the `/app/` link:

```html
        <a href="/drift/">drift</a>
```

- [ ] **Step 5: Run the full gates**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; 709 passing, 0 failing.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/board/index.html test/landing-nav.test.ts
git commit -m "feat: give drift a door from the landing page and the board"
```

---

### Task 9: `axis-lint.js` stage 2 — BoW versus embedding

**Files:**
- Modify: `public/drift/axis-lint.js` (append)
- Modify: `test/drift-axis-lint.test.ts` (append)
- Modify: `public/drift/drift.js` (call it after the prime)

**Interfaces:**
- Consumes: the resident set from `working-set.js`; `tokenize` from stage 1.
- Produces: `BOW_OVERLAP_MAX: number`, `lintAgainstPool(negPhrase, posPhrase, candidates, coordsAxis) -> {overlap: number, warning: {check, message}|null}`.

**Stage 2 ships the BoW check and nothing else.** Workstream B looked for a cheap statistic that could also flag a *weak* axis here and found none — `poleCoherence` went +0.314 → −0.843 and `interPoleMargin` −0.828 → +0.232 across two runs of the same matrix. Adding either would be shipping a check that reports noise. See [docs/measurements/2026-08-22-workstream-b-null-result.md](../../measurements/2026-08-22-workstream-b-null-result.md).

- [ ] **Step 1: Append the failing test**

```ts
describe("stage 2 — BoW versus embedding", () => {
  interface Cand { text: string; coords: number[] }
  const stage2 = lintUntyped as unknown as {
    BOW_OVERLAP_MAX: number;
    lintAgainstPool(neg: string, pos: string, cands: Cand[], axis: number): { overlap: number; warning: unknown };
  };

  it("fires when the lexical ranking and the embedding ranking agree", () => {
    // If a bag of words retrieves what the embedder retrieves, the axis is
    // lexically drivable and the embedder is doing no work.
    const cands = [
      { text: "playful games", coords: [0.9] },
      { text: "playful toys", coords: [0.8] },
      { text: "playful fun", coords: [0.7] },
      { text: "solemn rites", coords: [-0.9] },
      { text: "quiet ledger", coords: [-0.5] },
      { text: "grey office", coords: [-0.3] },
    ];
    const r = stage2.lintAgainstPool("solemn ceremony", "playful activity", cands, 0);
    expect(r.overlap).toBeGreaterThanOrEqual(stage2.BOW_OVERLAP_MAX);
    expect(r.warning).not.toBeNull();
  });

  it("stays quiet when the embedding ranking is not lexical", () => {
    const cands = [
      { text: "bus stop insects", coords: [0.9] },
      { text: "mobility as empathy", coords: [0.8] },
      { text: "commuter psyche", coords: [0.7] },
      { text: "subsidy as social contract", coords: [-0.9] },
      { text: "infrastructure as institution", coords: [-0.8] },
      { text: "transportation as trust", coords: [-0.7] },
    ];
    const r = stage2.lintAgainstPool("solemn ceremony", "playful activity", cands, 0);
    expect(r.overlap).toBeLessThan(stage2.BOW_OVERLAP_MAX);
    expect(r.warning).toBeNull();
  });

  it("returns overlap 0 and no warning on a set too small to rank", () => {
    const r = stage2.lintAgainstPool("a", "b", [{ text: "x", coords: [0.1] }], 0);
    expect(r.overlap).toBe(0);
    expect(r.warning).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/drift-axis-lint.test.ts`
Expected: FAIL — `lintAgainstPool is not a function`.

- [ ] **Step 3: Append the implementation to `public/drift/axis-lint.js`**

```js
// ── stage 2: BoW versus embedding, once a pool exists ───────────────────────
//
// The doc's check, finally possible: with one pair there was no averaging to
// expose a dominant token at stage 1, but with a POOL to rank there is. Score
// every candidate by lexical overlap with the pos-minus-neg terms, take the
// top-k, and compare against the embedding's top-k. High agreement means the
// axis sorts by a word and the embedder is doing no work.
//
// This necessarily warns mid-session — the evidence did not exist earlier.
//
// This is ALL of stage 2. Workstream B went looking for a cheap statistic that
// would also flag a merely WEAK axis and found none: poleCoherence and
// interPoleMargin both reversed sign across two runs of the same matrix
// (docs/measurements/2026-08-22-workstream-b-null-result.md). Shipping either
// would be shipping a check that reports noise.

/** Ports from the axis-measurement doc unchanged. */
export const BOW_OVERLAP_MAX = 0.375;

const TOP_K = 8;

function topKBy(items, score, k) {
  return items
    .map((item, i) => ({ i, s: score(item) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => x.i);
}

/** Overlap of the lexical top-k with the embedding top-k, as a fraction of k. */
export function lintAgainstPool(negPhrase, posPhrase, candidates, coordsAxis) {
  // k adapts to the pool. A fixed k of 8 with a hard `length < 16` guard makes
  // the check silently inert on anything smaller, which is the worst failure
  // mode a lint can have: it reports nothing and looks like a pass.
  const k = Math.min(TOP_K, Math.floor(candidates.length / 2));
  if (k < 2) return { overlap: 0, warning: null };

  const posTokens = new Set(tokenize(posPhrase));
  const negTokens = new Set(tokenize(negPhrase));
  // The bag-of-words direction: tokens the positive pole has and the negative
  // one does not, minus the reverse. No semantics at all — that is the point.
  const bow = (text) => {
    const t = tokenize(text);
    let s = 0;
    for (const w of t) {
      if (posTokens.has(w) && !negTokens.has(w)) s += 1;
      else if (negTokens.has(w) && !posTokens.has(w)) s -= 1;
    }
    return t.length === 0 ? 0 : s / t.length;
  };

  // NO LEXICAL SIGNAL, NO FINDING. When every candidate scores the same — the
  // normal case, since most pool words contain neither pole's vocabulary — the
  // sort is a no-op and "lexical top-k" is just the first k in input order.
  // Comparing that against the embedding top-k manufactures agreement out of
  // array order and fires on a perfectly good axis. A bag of words that
  // distinguishes nothing has not retrieved anything, so the question is void.
  const scores = candidates.map((c) => bow(c.text));
  if (new Set(scores).size <= 1) return { overlap: 0, warning: null };

  const lexical = new Set(topKBy(candidates, (c) => bow(c.text), k));
  const embedded = topKBy(candidates, (c) => c.coords?.[coordsAxis] ?? -Infinity, k);
  const shared = embedded.filter((i) => lexical.has(i)).length;
  const overlap = shared / k;

  if (overlap < BOW_OVERLAP_MAX) return { overlap, warning: null };
  return {
    overlap,
    warning: {
      check: 'bowOverlap',
      message: 'this direction is sorting by a word rather than a meaning. Try re-expanding the poles, or pick different words.',
    },
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run test/drift-axis-lint.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Wire it into `drift.js` after the prime**

In `enterStage()`, immediately after `state.position = initialPosition(state.range);`:

```js
  // Stage 2 needs a pool to rank, so it can only run now. Warn and allow, same
  // as stage 1 — the surface stays usable.
  state.axes.forEach((axis, i) => {
    const { warning } = lintAgainstPool(axis.negPhrase, axis.posPhrase, state.set.all(), i);
    if (warning) console.warn(`drift axis "${axis.negTerm}" ↔ "${axis.posTerm}": ${warning.message}`);
  });
```

And extend the import at the top of `drift.js`:

```js
import { lintAgainstPool, lintPoles } from './axis-lint.js';
```

- [ ] **Step 6: Run the full gates**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; 712 passing, 0 failing.

- [ ] **Step 7: Commit**

```bash
git add public/drift/axis-lint.js public/drift/drift.js test/drift-axis-lint.test.ts
git commit -m "feat: drift's stage-2 lint — BoW versus embedding over the primed pool"
```

---

## After the plan

Two follow-ups the spec names and this plan deliberately does not build:

- **File an issue to measure `SUPPLY_RADIUS` and `SUPPLY_FLOOR`** against a real session. They ship labelled unmeasured; the risk is that the label rots and the guess hardens into a constant nobody questions.
- **Open question 2 — should an axis be gated by an LLM judge?** Workstream B showed the judge ranks axes correctly (`concrete↔abstract` 0.810 against a surface-control 0.530) while nothing free does. A gate costs one inference call at axis confirmation on a surface whose premise is that nothing waits on an AI call. Decide it once the cost of a bad axis is observed rather than assumed.
