# Workstream C: User-Named Semantic Axes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user name a semantic axis by typing two pole terms, and serve every pooled word's coordinate along those axes.

**Architecture:** A user types a pole term; an LLM call expands it into an unambiguous descriptive phrase; the phrase is embedded; the axis vector is `posVec − negVec`; each candidate's coordinate is `cosine(candidateVec, axisVec)`. Pure projection math lives in a new `src/axis-core.ts`, axis state hangs off `PoolCore`, the `SessionDO` orchestrates expansion and embedding, and `/pool` responses gain a `coords` array. **This workstream ships no pixels** — it ends at a client-side data module. Rendering is workstream A.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` for expansion, `@cf/baai/bge-m3` for embeddings), vitest, vanilla ES modules on the client.

## Global Constraints

- **Pole phrases are mandatory, not optional.** Bare terms score AUC 0.640 vs 0.980 for descriptive phrases ([docs/latent-space-navigation-design.md](../../latent-space-navigation-design.md#evidence-the-axis-spike)). Never embed a raw user term as an axis pole. **When expansion fails the fallback is allowed but must be visible:** `expandPole` returns `{phrase, expanded}`, `AxisPole` records `expanded`, and `SerializedAxis` surfaces `degraded`. A silent fallback would violate this constraint invisibly (adjudicated 2026-07-20).
- **Axis construction is `pos − neg` (a pole *pair*).** Single-term axes score 0.763 vs 0.843 mean AUC. Never build an axis from one term.
- **Do not mean-center.** Measured at 0.850 vs 0.843 — noise. Not worth the code.
- **Never put embeddings on the wire.** `/pool` sends coordinates (a few floats), never the 1024-dim vectors. There is an explicit regression test for this.
- **Coordinates are served raw; normalization is the client's job.** Raw cosines occupy a narrow band (sd 0.05–0.07 near zero) and must be min-max normalized against the *visible* set, which only the client knows.
- **Maximum 3 axes** (`MAX_AXES = 3`) — one per spatial dimension.
- **`DEGENERATE_POLE_COSINE` (0.98) catches identical/near-identical expanded
  *text*, not semantic collapse.** Measured against real `bge-m3` embeddings
  (post-implementation, corrected from the original in-code rationale):
  genuine paraphrase collisions ("a physical object you can touch" vs "a
  tangible object you can hold", etc.) scored 0.79-0.92 cosine, and
  legitimate antonym-pole axes ("a warm colour" vs "a cool colour", etc.)
  scored 0.59-0.92 — the *same* range, with "a warm colour"/"a cool colour"
  landing at 0.9201, identical to the top paraphrase collision. No threshold
  separates the two sets, so the guard cannot detect general semantic
  collapse; it only fires when both poles collapse onto the same (or
  near-identical) literal expanded text, which is realistic because the
  few-shot prompt in `generation.ts` pins phrasing tightly. Do not lower the
  threshold to try to catch paraphrase collisions — it would only reject
  valid narrow axes.
- **The field must never block on AI.** Axis creation is an explicit user action and may await; it must never stall the pool-serving path.
- **Weather vocabulary in user-facing copy and API params; plain concepts in prompts** ([CLAUDE.md](../../../CLAUDE.md)). "Axis" and "pole" are neutral engineering terms and are fine in both.
- **Gates:** `npm run typecheck` and `npm test` must pass before every commit. Report counts. **One documented exception:** Task 1 adds `coords` to `Served` without populating it, so its commit lands with a failing `npm run typecheck` that Task 3 turns green. (`npm test` still passes at that commit — vitest does not typecheck, so the breakage is visible only to `tsc`.) This was raised in pre-flight and accepted deliberately (2026-07-20) — it is not an oversight, and Task 1's reviewer should not treat it as one. No other task may commit red.
- **`normalizeCoords` is mirrored** in `src/axis-core.ts` (canonical) and `public/axes.js` (browser). The repo's existing precedent for this — `src/hint-machine.ts` / `public/hint-machine.js` — guards the copy with a shared suite that runs against both, so drift fails CI. Task 6 must do the same; an unguarded copy is not the precedent.
- **Commits:** conventional prefixes (`feat:`, `test:`, `refactor:`). Never push to `main`; this work belongs on a feature branch.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/axis-core.ts` | **new** — pure projection: axis vectors, coordinates, normalization. No I/O. |
| `test/axis-core.test.ts` | **new** — unit tests for the above. |
| `src/types.ts` | **modify** — `AxisPole`, `Axis`, `SerializedAxis`; `coords` on `Served`; axis limits. |
| `src/generation.ts` | **modify** — pole-expansion prompt, parser, and `expandPole()`. |
| `test/generation.test.ts` | **modify** — expansion prompt/parser tests. |
| `src/pool-core.ts` | **modify** — axis list in state; add/remove/list; coordinate attachment on `draw()`. |
| `test/pool-core.test.ts` | **modify** — axis state and coordinate tests. |
| `src/session-do.ts` | **modify** — `createAxis` / `removeAxis` / `listAxes` orchestration. |
| `src/index.ts` | **modify** — `/axes` routes and validation. |
| `test/api-axes.test.ts` | **new** — route validation tests. |
| `public/axes.js` | **new** — client axis data module: create/list/remove, normalize coords. |
| `public/pool-client.js` | **modify** — carry `coords` through the buffer. |

Tasks 1–5 are server-side and independently verifiable. Task 6 is the client data path with no rendering.

---

### Task 1: Pure axis projection core

**Files:**
- Create: `src/axis-core.ts`
- Create: `test/axis-core.test.ts`
- Modify: `src/types.ts`

**Interfaces:**
- Consumes: `cosineSim` from `src/pool-core.ts`.
- Produces: `axisVector(neg: number[], pos: number[]): number[]`, `coordsFor(vec: number[], axisVecs: number[][]): number[]`, `normalizeCoords(values: number[]): number[]`, and the types `AxisPole`, `Axis`, `SerializedAxis`.

- [ ] **Step 1: Add axis types and limits to `src/types.ts`**

Append to `src/types.ts`:

```typescript
/** One end of a user-named axis. `term` is what the user typed; `phrase` is the
 *  LLM-expanded descriptive form that actually gets embedded — bare terms lose
 *  ~0.34 AUC to polysemy, so `phrase` is never optional. */
export interface AxisPole {
  term: string;
  phrase: string;
  /** False when expansion failed and `phrase` is just the bare term. A bare
   *  pole scores AUC 0.640 against 0.980 for an expanded one, so a degraded
   *  pole must stay visible rather than passing as a normal axis. */
  expanded: boolean;
  embedding: number[] | null; // filled in lazily, like Anchor.embedding
}

export interface Axis {
  id: string;
  neg: AxisPole;
  pos: AxisPole;
  createdAt: number;
}

/** Axis as sent to the client — no embeddings on the wire, ever. */
export interface SerializedAxis {
  id: string;
  neg: { term: string; phrase: string };
  pos: { term: string; phrase: string };
  ready: boolean; // both poles embedded, so coordinates are being served
  degraded: boolean; // at least one pole fell back to its bare term
}

export const MAX_AXES = 3; // one per spatial dimension
export const MAX_POLE_TERM_CHARS = 48;
export const MAX_POLE_PHRASE_CHARS = 120;
```

Then change `Served` (currently at `src/types.ts:40`) to carry coordinates:

```typescript
export interface Served {
  text: string;
  tier: Tier;
  alt: Alt;
  seedDist: number;
  coords: number[]; // one raw cosine per ready axis, in axis order; [] when none
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/axis-core.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { axisVector, coordsFor, normalizeCoords } from "../src/axis-core";

/** Unit vector along dimension i — mirrors the idiom in pool-core.test.ts. */
function axisEmb(i: number, dim = 8): number[] {
  const v = new Array(dim).fill(0);
  v[i % dim] = 1;
  return v;
}

describe("axisVector", () => {
  it("is the difference pos - neg", () => {
    expect(axisVector([1, 0, 0], [0, 1, 0])).toEqual([-1, 1, 0]);
  });

  it("tolerates poles of differing length by using the shorter", () => {
    expect(axisVector([1, 0, 0, 9], [0, 1, 0])).toEqual([-1, 1, 0]);
  });
});

describe("coordsFor", () => {
  it("scores a word near the positive pole above one near the negative pole", () => {
    const av = axisVector(axisEmb(0), axisEmb(1));
    const [nearPos] = coordsFor(axisEmb(1), [av]);
    const [nearNeg] = coordsFor(axisEmb(0), [av]);
    expect(nearPos).toBeGreaterThan(0);
    expect(nearNeg).toBeLessThan(0);
    expect(nearPos).toBeGreaterThan(nearNeg!);
  });

  it("scores a word orthogonal to the axis at zero", () => {
    const av = axisVector(axisEmb(0), axisEmb(1));
    expect(coordsFor(axisEmb(5), [av])[0]).toBeCloseTo(0, 10);
  });

  it("returns one coordinate per axis, in order", () => {
    const a = axisVector(axisEmb(0), axisEmb(1));
    const b = axisVector(axisEmb(2), axisEmb(3));
    expect(coordsFor(axisEmb(1), [a, b])).toHaveLength(2);
  });

  it("returns [] when there are no axes", () => {
    expect(coordsFor(axisEmb(0), [])).toEqual([]);
  });

  it("returns 0 rather than NaN for a zero-length axis vector", () => {
    expect(coordsFor(axisEmb(0), [[0, 0, 0]])).toEqual([0]);
  });
});

describe("normalizeCoords", () => {
  it("maps the observed range onto 0..1", () => {
    expect(normalizeCoords([-0.1, 0, 0.1])).toEqual([0, 0.5, 1]);
  });

  it("centers a degenerate range instead of dividing by zero", () => {
    expect(normalizeCoords([0.3, 0.3, 0.3])).toEqual([0.5, 0.5, 0.5]);
  });

  it("returns [] for an empty input", () => {
    expect(normalizeCoords([])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/axis-core.test.ts`
Expected: FAIL — `Failed to resolve import "../src/axis-core"`.

- [ ] **Step 4: Write the implementation**

Create `src/axis-core.ts`:

```typescript
// Pure projection math for user-named semantic axes. No bindings, no storage,
// no I/O — the SessionDO supplies embeddings and persists the results.
//
// An axis is a PAIR of poles (pos - neg), not a single term: measured mean AUC
// 0.843 vs 0.763. See docs/latent-space-navigation-design.md.

import { cosineSim } from "./pool-core";

/** Direction from the negative pole to the positive pole. */
export function axisVector(neg: number[], pos: number[]): number[] {
  const n = Math.min(neg.length, pos.length);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = pos[i]! - neg[i]!;
  return out;
}

/** One raw cosine per axis, in axis order. Raw on purpose: the useful range is
 *  narrow (sd ~0.05-0.07 near zero) and normalization depends on the visible
 *  set, which only the client knows. cosineSim returns 0 for a zero vector, so
 *  a degenerate axis yields 0 rather than NaN. */
export function coordsFor(vec: number[], axisVecs: number[][]): number[] {
  return axisVecs.map((av) => cosineSim(vec, av));
}

/** Min-max onto 0..1 for layout. A degenerate range centers rather than
 *  dividing by zero. Mirrored in public/axes.js for the client. */
export function normalizeCoords(values: number[]): number[] {
  if (values.length === 0) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  if (span === 0) return values.map(() => 0.5);
  return values.map((v) => (v - lo) / span);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/axis-core.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Run the full gates**

Run: `npm run typecheck; npm test`

Expected — note which gate goes red, it is the opposite of what you might assume:

- **`npm run typecheck` FAILS**, with exactly one error: `src/pool-core.ts(121,5): error TS2322 ... Property 'coords' is missing`. `draw()` returns objects without `coords` but is declared `Served[]`.
- **`npm test` PASSES** (130/130). Vitest transpiles without typechecking, so a missing property is invisible to it.

**This is expected**; Task 3 fixes it. Do not patch `pool-core.ts` here.

Beware `grep`-ing this output for errors: `tsc` writes to stdout and a sloppy pattern can hide the failure. Check the exit code — `npx tsc --noEmit; echo $?` should print `2`.

- [ ] **Step 7: Commit**

```bash
git add src/axis-core.ts test/axis-core.test.ts src/types.ts
git commit -m "feat: pure axis projection core

Axis vectors, per-axis coordinates, and min-max normalization for
user-named semantic axes. Pure functions, no I/O.

Axes are pole PAIRS (pos - neg): measured mean AUC 0.843 vs 0.763 for a
single-term axis. Coordinates are served raw because the useful range is
narrow and normalization depends on the visible set.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Pole expansion

**Files:**
- Modify: `src/generation.ts` (append; do not disturb the candidate-generation path)
- Modify: `test/generation.test.ts` (append)

**Interfaces:**
- Consumes: `AiRunner`, `ChatMessage`, `extractResponse` from `src/generation.ts`.
- Produces: `buildPoleExpansionMessages(term: string): ChatMessage[]`, `parsePolePhrase(raw: unknown): string | null`, `expandPole(ai: AiRunner, model: string, term: string): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

Append to `test/generation.test.ts` (and add `buildPoleExpansionMessages`, `expandPole`, `parsePolePhrase` to the existing import block at the top of the file):

```typescript
describe("buildPoleExpansionMessages", () => {
  it("shows the model the disambiguation it must perform", () => {
    const text = allText(buildPoleExpansionMessages("concrete")).toLowerCase();
    expect(text).toContain("a physical object you can touch");
    expect(text).toContain("concrete");
  });

  it("puts the term to expand in the final user message", () => {
    const messages = buildPoleExpansionMessages("liminal");
    expect(messages[messages.length - 1]!.role).toBe("user");
    expect(messages[messages.length - 1]!.content).toContain("liminal");
  });
});

describe("parsePolePhrase", () => {
  it("reads the phrase out of a JSON object", () => {
    expect(parsePolePhrase('{"phrase":"a physical object you can touch"}')).toBe("a physical object you can touch");
  });

  it("survives code fences", () => {
    expect(parsePolePhrase('```json\n{"phrase":"an abstract idea"}\n```')).toBe("an abstract idea");
  });

  it("accepts a bare string", () => {
    expect(parsePolePhrase('"a routine practical task"')).toBe("a routine practical task");
  });

  it("collapses whitespace", () => {
    expect(parsePolePhrase('{"phrase":"a  physical\\n object"}')).toBe("a physical object");
  });

  it("rejects an over-long phrase rather than truncating it", () => {
    expect(parsePolePhrase(`{"phrase":"${"x".repeat(200)}"}`)).toBeNull();
  });

  it("returns null for junk", () => {
    expect(parsePolePhrase("I'm sorry, I can't help with that.")).toBeNull();
    expect(parsePolePhrase(null)).toBeNull();
    expect(parsePolePhrase('{"phrase":""}')).toBeNull();
  });
});

describe("expandPole", () => {
  it("reports a real expansion as expanded", async () => {
    const ai = new MockRunner(['{"phrase":"a mystical or magical practice"}']);
    expect(await expandPole(ai, "m", "mystical")).toEqual({
      phrase: "a mystical or magical practice",
      expanded: true,
    });
  });

  it("flags the fallback when the model returns junk", async () => {
    const ai = new MockRunner(["no."]);
    expect(await expandPole(ai, "m", "mystical")).toEqual({ phrase: "mystical", expanded: false });
  });

  it("flags the fallback when the call throws", async () => {
    const ai: AiRunner = { async run() { throw new Error("upstream down"); } };
    expect(await expandPole(ai, "m", "mystical")).toEqual({ phrase: "mystical", expanded: false });
  });

  it("does not report a degraded pole as expanded even when the model echoes the term", async () => {
    // The model legitimately returning the bare term must still count as an
    // expansion — `expanded` tracks whether parsing succeeded, not whether the
    // text changed. Otherwise the flag would be guesswork at the call site.
    const ai = new MockRunner(['{"phrase":"mystical"}']);
    expect(await expandPole(ai, "m", "mystical")).toEqual({ phrase: "mystical", expanded: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/generation.test.ts`
Expected: FAIL — `buildPoleExpansionMessages is not exported`.

- [ ] **Step 3: Write the implementation**

Append to `src/generation.ts`:

```typescript
// ── pole expansion ─────────────────────────────────────────────────────────
// A user types "concrete"; embedding that bare word drags the axis toward
// cement, costing ~0.34 AUC. Expanding to "a physical object you can touch"
// recovers it. This step is mandatory — see the spike table in
// docs/latent-space-navigation-design.md.

const POLE_SYSTEM_PROMPT = `You expand a single term into an unambiguous descriptive phrase naming one end of a semantic axis.

The phrase gets embedded and used as a direction in vector space, so ambiguity is fatal: "concrete" on its own pulls toward cement rather than toward the opposite of abstract.

Rules:
- Respond with a JSON object of the form {"phrase": "..."} and nothing else. No prose, no code fences.
- 4-8 words. A noun phrase naming the KIND of thing found at this pole.
- Begin with an article: "a", "an", or "something".
- Resolve the term's intended sense. Never return the bare term on its own.
- Never define this pole by negating the other one — "not abstract" carries no direction.`;

const POLE_FEWSHOT: [string, string][] = [
  ["concrete", "a physical object you can touch"],
  ["abstract", "an abstract idea or principle"],
  ["practical", "a routine practical task"],
  ["mystical", "a mystical or magical practice"],
];

export function buildPoleExpansionMessages(term: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: POLE_SYSTEM_PROMPT }];
  for (const [example, phrase] of POLE_FEWSHOT) {
    messages.push({ role: "user", content: JSON.stringify({ term: example }) });
    messages.push({ role: "assistant", content: JSON.stringify({ phrase }) });
  }
  messages.push({ role: "user", content: JSON.stringify({ term }) });
  return messages;
}

/** Extract the phrase from whatever the model returned. Junk yields null so the
 *  caller can fall back — axis creation must not throw into the UI. */
export function parsePolePhrase(raw: unknown): string | null {
  let value: unknown = raw;
  if (typeof value === "string") {
    let text = value.trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1]) text = fence[1].trim();
    const parsed = tryParse(text);
    value = parsed === undefined ? text : parsed;
  }
  if (value !== null && typeof value === "object") {
    value = (value as Record<string, unknown>).phrase;
  }
  if (typeof value !== "string") return null;
  const phrase = value.trim().replace(/\s+/g, " ");
  if (!phrase || phrase.length > MAX_POLE_PHRASE_CHARS) return null;
  return phrase;
}

export interface ExpandedPole {
  phrase: string;
  /** False when expansion failed and `phrase` is the bare term. */
  expanded: boolean;
}

/** Expand a pole term, falling back to the bare term if the model or the
 *  network fails. A degraded axis beats a failed one — but the caller is told,
 *  because a bare pole scores AUC 0.640 against 0.980 and would otherwise
 *  violate "never embed a raw user term" invisibly. */
export async function expandPole(ai: AiRunner, model: string, term: string): Promise<ExpandedPole> {
  try {
    const result = await ai.run(model, {
      messages: buildPoleExpansionMessages(term),
      temperature: 0.2, // disambiguation is not a creative task
      max_tokens: 64,
    });
    const phrase = parsePolePhrase(extractResponse(result));
    return phrase === null ? { phrase: term, expanded: false } : { phrase, expanded: true };
  } catch {
    return { phrase: term, expanded: false };
  }
}
```

Add `MAX_POLE_PHRASE_CHARS` to the existing `./types` import at the top of `src/generation.ts`. If `src/generation.ts` has no `./types` import yet, add:

```typescript
import { MAX_POLE_PHRASE_CHARS } from "./types";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/generation.test.ts`
Expected: PASS. The 23 pre-existing generation tests must still pass.

- [ ] **Step 5: Commit**

```bash
git add src/generation.ts test/generation.test.ts
git commit -m "feat: expand axis pole terms into descriptive phrases

A user types 'concrete'; embedding that bare word drags the axis toward
cement and costs ~0.34 AUC. Expansion to 'a physical object you can
touch' recovers it, so this step is mandatory rather than cosmetic.

Falls back to the bare term when the model returns junk or the call
throws — a degraded axis beats a failed one.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Axis state and coordinates in PoolCore

**Files:**
- Modify: `src/pool-core.ts`
- Modify: `test/pool-core.test.ts`

**Interfaces:**
- Consumes: `axisVector`, `coordsFor` from `src/axis-core.ts`; `Axis`, `MAX_AXES`, `SerializedAxis` from `src/types.ts`.
- Produces: on `PoolCore` — `addAxis(axis: Axis): boolean`, `removeAxis(id: string): boolean`, `axes(): Axis[]`, `serializedAxes(): SerializedAxis[]`, `setPoleEmbedding(axisId: string, pole: "neg" | "pos", embedding: number[]): void`, `unembeddedPoles(): { axisId: string; pole: "neg" | "pos"; phrase: string }[]`. `PoolCoreState` gains `axes: Axis[]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/pool-core.test.ts` (import `MAX_AXES` and `type Axis` from `../src/types`):

```typescript
function makeAxis(id: string, negAxis: number, posAxis: number): Axis {
  return {
    id,
    neg: { term: `n${id}`, phrase: `a ${id} negative pole`, expanded: true, embedding: axisEmb(negAxis) },
    pos: { term: `p${id}`, phrase: `a ${id} positive pole`, expanded: true, embedding: axisEmb(posAxis) },
    createdAt: 1,
  };
}

describe("PoolCore axes", () => {
  it("accepts axes up to MAX_AXES and refuses beyond it", () => {
    const core = new PoolCore();
    for (let i = 0; i < MAX_AXES; i++) {
      expect(core.addAxis(makeAxis(`a${i}`, i * 2, i * 2 + 1))).toBe(true);
    }
    expect(core.addAxis(makeAxis("overflow", 12, 13))).toBe(false);
    expect(core.axes()).toHaveLength(MAX_AXES);
  });

  it("removes an axis by id and reports whether it existed", () => {
    const core = new PoolCore();
    core.addAxis(makeAxis("a", 0, 1));
    expect(core.removeAxis("a")).toBe(true);
    expect(core.removeAxis("a")).toBe(false);
    expect(core.axes()).toHaveLength(0);
  });

  it("never exposes embeddings through serializedAxes", () => {
    const core = new PoolCore();
    core.addAxis(makeAxis("a", 0, 1));
    expect(JSON.stringify(core.serializedAxes())).not.toContain("embedding");
    expect(core.serializedAxes()[0]!.ready).toBe(true);
  });

  it("reports an axis with an unembedded pole as not ready", () => {
    const core = new PoolCore();
    const axis = makeAxis("a", 0, 1);
    axis.pos.embedding = null;
    core.addAxis(axis);
    expect(core.serializedAxes()[0]!.ready).toBe(false);
    expect(core.unembeddedPoles()).toEqual([{ axisId: "a", pole: "pos", phrase: "a a positive pole" }]);
  });

  it("fills a pole embedding in place", () => {
    const core = new PoolCore();
    const axis = makeAxis("a", 0, 1);
    axis.neg.embedding = null;
    core.addAxis(axis);
    core.setPoleEmbedding("a", "neg", axisEmb(0));
    expect(core.unembeddedPoles()).toEqual([]);
    expect(core.serializedAxes()[0]!.ready).toBe(true);
  });
});

describe("PoolCore draw with axes", () => {
  it("serves [] coords when no axis is defined", () => {
    const core = new PoolCore();
    core.addCandidates("w1a0", entries(["alpha"]), 1);
    expect(core.draw("w1a0", 1, 2)[0]!.coords).toEqual([]);
  });

  it("orders words along the axis by their position on it", () => {
    const core = new PoolCore();
    core.addAxis(makeAxis("a", 0, 1));
    // "near-pos" sits on the positive pole, "near-neg" on the negative pole
    core.addCandidates("w1a0", [
      { text: "near-pos", embedding: axisEmb(1) },
      { text: "near-neg", embedding: axisEmb(0) },
    ], 1);
    const byText = new Map(core.draw("w1a0", 2, 2).map((s) => [s.text, s.coords[0]!]));
    expect(byText.get("near-pos")).toBeGreaterThan(byText.get("near-neg")!);
  });

  it("emits one coordinate per ready axis and skips unready ones", () => {
    const core = new PoolCore();
    core.addAxis(makeAxis("a", 0, 1));
    const pending = makeAxis("b", 2, 3);
    pending.pos.embedding = null;
    core.addAxis(pending);
    core.addCandidates("w1a0", entries(["alpha"], 4), 1);
    expect(core.draw("w1a0", 1, 2)[0]!.coords).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/pool-core.test.ts`
Expected: FAIL — `core.addAxis is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/pool-core.ts`:

1. Extend the imports:

```typescript
import { axisVector, coordsFor } from "./axis-core";
import { MAX_AXES, type Axis, type SerializedAxis } from "./types";
```

2. Add `axes: Axis[]` to the `PoolCoreState` interface, after `anchors: Anchor[]`:

```typescript
  axes: Axis[];
```

3. Add the backing field beside `private anchorList: Anchor[];` (`src/pool-core.ts:77`):

```typescript
  private axisList: Axis[];
```

and initialize it in the constructor immediately after the `anchorList` line (`src/pool-core.ts:88`), matching that line's copy-on-read style:

```typescript
    this.axisList = [...(state?.axes ?? [])];
```

`PoolCore.serialize(): PoolCoreState` **does** exist and must gain `axes: this.axes()`, or it no longer satisfies `PoolCoreState` once `axes` is a required field. (Round-trip tests construct a `PoolCore` from a `serialize()` result, so this is load-bearing.)

It is not, however, a whole-state persistence dump: `src/session-do.ts:377` calls it only to read `.candidates` for one bucket. Axis persistence is therefore still Task 4's own SQLite table — `serialize()` and the `axes` table are independent, and neither makes the other redundant.

4. Add these methods to the `PoolCore` class:

```typescript
  addAxis(axis: Axis): boolean {
    if (this.axisList.length >= MAX_AXES) return false;
    this.axisList.push(axis);
    return true;
  }

  removeAxis(id: string): boolean {
    const before = this.axisList.length;
    this.axisList = this.axisList.filter((a) => a.id !== id);
    return this.axisList.length < before;
  }

  /** Copy-on-read, matching `anchors()` one section above. A live reference
   *  would let `core.axes().push(...)` add a fourth axis straight past the
   *  MAX_AXES guard, and would alias into `serialize()`'s snapshot — `addAxis`
   *  pushes in place, so an earlier snapshot's `axes` would grow after the
   *  fact, breaking the point-in-time contract every other serialized field
   *  honors. The hot path reads `this.axisList` directly, so this costs
   *  nothing per draw. */
  axes(): Axis[] {
    return this.axisList.map((a) => ({ ...a }));
  }

  /** Client-facing view. Embeddings are deliberately absent — they never go on
   *  the wire (1024 dims x 60 candidates would be ~245 KB per bucket). */
  serializedAxes(): SerializedAxis[] {
    return this.axisList.map((a) => ({
      id: a.id,
      neg: { term: a.neg.term, phrase: a.neg.phrase },
      pos: { term: a.pos.term, phrase: a.pos.phrase },
      ready: a.neg.embedding !== null && a.pos.embedding !== null,
      degraded: !a.neg.expanded || !a.pos.expanded,
    }));
  }

  unembeddedPoles(): { axisId: string; pole: "neg" | "pos"; phrase: string }[] {
    const out: { axisId: string; pole: "neg" | "pos"; phrase: string }[] = [];
    for (const axis of this.axisList) {
      for (const pole of ["neg", "pos"] as const) {
        if (axis[pole].embedding === null) out.push({ axisId: axis.id, pole, phrase: axis[pole].phrase });
      }
    }
    return out;
  }

  setPoleEmbedding(axisId: string, pole: "neg" | "pos", embedding: number[]): void {
    const axis = this.axisList.find((a) => a.id === axisId);
    if (axis) axis[pole].embedding = embedding;
  }

  /** Axis vectors for every fully-embedded axis, in axis order. An axis with a
   *  pending pole contributes no coordinate rather than a wrong one. */
  private readyAxisVectors(): number[][] {
    return this.axisList
      .filter((a) => a.neg.embedding !== null && a.pos.embedding !== null)
      .map((a) => axisVector(a.neg.embedding!, a.pos.embedding!));
  }
```

5. In `draw()` (currently `src/pool-core.ts:98`), compute the axis vectors **once** before the loop that builds `Served` objects, and add `coords` to each returned object:

```typescript
    const axisVecs = this.readyAxisVectors();
```

and in the object literal built per served candidate, add:

```typescript
      coords: coordsFor(candidate.embedding, axisVecs),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/pool-core.test.ts`
Expected: PASS. All 51 pre-existing pool-core tests must still pass.

- [ ] **Step 5: Run the full gates**

Run: `npm run typecheck && npm test`
Expected: typecheck exits 0, all tests pass. The `Served.coords` breakage introduced in Task 1 is now resolved.

- [ ] **Step 6: Commit**

```bash
git add src/pool-core.ts test/pool-core.test.ts
git commit -m "feat: axis state and per-word coordinates in PoolCore

Axes live alongside anchors in the pure core: add/remove capped at
MAX_AXES, lazy pole embedding mirroring how anchors are embedded, and a
coordinate per ready axis attached to every served word.

An axis with a pending pole contributes no coordinate rather than a wrong
one. serializedAxes() deliberately omits embeddings — they never go on
the wire.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: SessionDO orchestration

**Files:**
- Modify: `src/session-do.ts`

**Interfaces:**
- Consumes: `expandPole` from `src/generation.ts`; `embedTexts` from `src/generation.ts`; the `PoolCore` axis methods from Task 3.
- Produces: on `SessionDO` — `createAxis(negTerm: string, posTerm: string): Promise<SerializedAxis[] | null>`, `removeAxis(id: string): Promise<SerializedAxis[] | null>`, `listAxes(): Promise<SerializedAxis[] | null>`.

- [ ] **Step 1: Add the `axes` table and its persistence**

`PoolCore` is pure; the `SessionDO` owns SQLite. Axis pole embeddings are 1024 floats each, so they belong in a BLOB column like `anchors.embedding`, not in a JSON `meta` row.

In `migrate()` (`src/session-do.ts:291`), add to the `CREATE TABLE` block:

```sql
      CREATE TABLE IF NOT EXISTS axes (
        id TEXT PRIMARY KEY,
        neg_term TEXT NOT NULL,
        neg_phrase TEXT NOT NULL,
        neg_expanded INTEGER NOT NULL,
        neg_embedding BLOB,
        pos_term TEXT NOT NULL,
        pos_phrase TEXT NOT NULL,
        pos_expanded INTEGER NOT NULL,
        pos_embedding BLOB,
        created_at INTEGER NOT NULL
      );
```

In `hydrate()` (`src/session-do.ts:312`), after the `anchors` block (`src/session-do.ts:331-341`), add:

```typescript
    const axes: Axis[] = this.ctx.storage.sql
      .exec<{
        id: string; neg_term: string; neg_phrase: string; neg_expanded: number; neg_embedding: ArrayBuffer | null;
        pos_term: string; pos_phrase: string; pos_expanded: number; pos_embedding: ArrayBuffer | null; created_at: number;
      }>(
        "SELECT id, neg_term, neg_phrase, neg_expanded, neg_embedding, pos_term, pos_phrase, pos_expanded, pos_embedding, created_at FROM axes",
      )
      .toArray()
      .map((r) => ({
        id: r.id,
        neg: { term: r.neg_term, phrase: r.neg_phrase, expanded: r.neg_expanded !== 0, embedding: r.neg_embedding ? fromBlob(r.neg_embedding) : null },
        pos: { term: r.pos_term, phrase: r.pos_phrase, expanded: r.pos_expanded !== 0, embedding: r.pos_embedding ? fromBlob(r.pos_embedding) : null },
        createdAt: r.created_at,
      }));
```

Then pass `axes` into the `new PoolCore({ ... })` call at the end of `hydrate()`, alongside the existing `anchors` key.

Add a `persistAxes()` beside `persistAnchors()`, mirroring its delete-and-reinsert shape:

```typescript
  private persistAxes(): void {
    this.ctx.storage.sql.exec("DELETE FROM axes");
    for (const a of this.core.axes()) {
      this.ctx.storage.sql.exec(
        "INSERT INTO axes (id, neg_term, neg_phrase, neg_expanded, neg_embedding, pos_term, pos_phrase, pos_expanded, pos_embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        a.id,
        a.neg.term,
        a.neg.phrase,
        a.neg.expanded ? 1 : 0,
        a.neg.embedding ? toBlob(a.neg.embedding) : null,
        a.pos.term,
        a.pos.phrase,
        a.pos.expanded ? 1 : 0,
        a.pos.embedding ? toBlob(a.pos.embedding) : null,
        a.createdAt,
      );
    }
  }
```

- [ ] **Step 2: Add the three public methods**

In `src/session-do.ts`, import `expandPole` alongside the existing `embedTexts` / `generateCandidates` import (`src/session-do.ts:8`), and add `MAX_AXES`, `type Axis`, `type SerializedAxis` to the `./types` import. Then add these methods, guarding with `if (!this.meta) return null;` exactly as `pin()` does (`src/session-do.ts:138`):

```typescript
  /** Create an axis from two pole terms. Expands each term to a descriptive
   *  phrase (mandatory — bare terms lose ~0.34 AUC to polysemy), embeds both
   *  phrases, then stores the axis. Slow and explicitly user-initiated; it must
   *  never sit in the pool-serving path. Returns null when the session is
   *  unknown, or the unchanged axis list when already at MAX_AXES. */
  async createAxis(
    negTerm: string,
    posTerm: string,
  ): Promise<{ axes: SerializedAxis[]; created: boolean } | null> {
    if (!this.meta) return null;
    // At cap: report it rather than returning the unchanged list, which the
    // route would otherwise answer with a 201 for a request it silently
    // dropped — the same silent-failure shape identical poles are rejected for.
    //
    // Counts in-flight creations too. Durable Objects are single-threaded per
    // slice but not atomic across awaits that aren't storage-gated, and the
    // expandPole calls below are two such awaits. Without the reservation, a
    // double-tap at 2/3 axes lets both requests clear this guard and pay for
    // LLM calls before the loser discovers the cap at addAxis().
    if (this.core.axes().length + this.axisCreationsInFlight >= MAX_AXES) {
      return { axes: this.core.serializedAxes(), created: false };
    }
    this.axisCreationsInFlight++;
    try {

    const ai = this.aiRunner(); // not env.AI directly — aiRunner() honors DEV_FAKE_AI
    const [neg, pos] = await Promise.all([
      expandPole(ai, this.env.GEN_MODEL, negTerm),
      expandPole(ai, this.env.GEN_MODEL, posTerm),
    ]);

    const axis = {
      id: crypto.randomUUID(),
      neg: { term: negTerm, phrase: neg.phrase, expanded: neg.expanded, embedding: null },
      pos: { term: posTerm, phrase: pos.phrase, expanded: pos.expanded, embedding: null },
      createdAt: Date.now(),
    };
    this.core.addAxis(axis);

    // Embed both poles now so coordinates start flowing immediately. On failure
    // the axis persists unembedded and reports ready:false; the next pump picks
    // up the pending poles.
    try {
      const vecs = await embedTexts(ai, this.env.EMBED_MODEL, [neg.phrase, pos.phrase]);
      this.core.setPoleEmbedding(axis.id, "neg", vecs[0]!);
      this.core.setPoleEmbedding(axis.id, "pos", vecs[1]!);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: "axis pole embed failed", axisId: axis.id, error: String(error) }));
    }

      this.persistAxes();
      return { axes: this.core.serializedAxes(), created: true };
    } finally {
      this.axisCreationsInFlight--;
    }
  }

  async removeAxis(id: string): Promise<SerializedAxis[] | null> {
    if (!this.meta) return null;
    if (this.core.removeAxis(id)) this.persistAxes();
    return this.core.serializedAxes();
  }

  async listAxes(): Promise<SerializedAxis[] | null> {
    if (!this.meta) return null;
    return this.core.serializedAxes();
  }
```

Note there is no `ensurePump(0)` call here, unlike `pin()`. Pinning changes what should be *generated*, so it invalidates buckets; naming an axis only changes how existing candidates are *measured*. The pool stays valid.

- [ ] **Step 3: Cover pending poles in the pump**

`src/session-do.ts:206` already re-embeds anchors whose embedding is null. Add the same treatment for axis poles immediately after that block, so an axis whose embedding failed at creation recovers on the next pump:

```typescript
      const pendingPoles = this.core.unembeddedPoles();
      if (pendingPoles.length > 0) {
        const vecs = await embedTexts(ai, this.env.EMBED_MODEL, pendingPoles.map((p) => p.phrase));
        pendingPoles.forEach((p, i) => this.core.setPoleEmbedding(p.axisId, p.pole, vecs[i]!));
        this.persistAxes();
      }
```

- [ ] **Step 4: Run the gates**

Run: `npm run typecheck && npm test`
Expected: typecheck exits 0; 120+ tests pass. No new tests here — `SessionDO` is the thin stateful shell and the logic it calls is already covered by Tasks 1–3.

- [ ] **Step 5: Commit**

```bash
git add src/session-do.ts
git commit -m "feat: axis persistence, creation, removal and listing in SessionDO

Expands both pole terms, embeds the phrases, stores the axis. Explicitly
user-initiated and allowed to be slow; it never sits in the pool-serving
path, so the field cannot stall on it.

A failed pole embed leaves the axis stored but not ready, and the pump's
existing lazy-embed pass picks it up — mirroring how anchors recover.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: API routes

**Files:**
- Modify: `src/index.ts`
- Create: `test/api-axes.test.ts`

**Interfaces:**
- Consumes: `createAxis` / `removeAxis` / `listAxes` from Task 4.
- Produces: `parsePoleTerms(body: Record<string, unknown>): { negTerm: string; posTerm: string } | null` in `src/axis-core.ts`. Routes: `GET|POST /api/session/:id/axes`, `DELETE /api/session/:id/axes/:axisId`.

**Note:** `parsePoleTerms` lives in `src/axis-core.ts`, not `src/index.ts`. `src/index.ts` re-exports `SessionDO` (`src/index.ts:7`), which imports `cloudflare:workers` — importing it from a plain vitest test fails to resolve. No existing test imports `src/index`, and this plan does not start.

- [ ] **Step 1: Write the failing tests**

Create `test/api-axes.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { parsePoleTerms } from "../src/axis-core";
import { MAX_POLE_TERM_CHARS } from "../src/types";

describe("parsePoleTerms", () => {
  it("accepts two non-empty terms and trims them", () => {
    expect(parsePoleTerms({ negTerm: "  concrete ", posTerm: "abstract" }))
      .toEqual({ negTerm: "concrete", posTerm: "abstract" });
  });

  it("rejects a missing or empty pole", () => {
    expect(parsePoleTerms({ negTerm: "concrete" })).toBeNull();
    expect(parsePoleTerms({ negTerm: "concrete", posTerm: "   " })).toBeNull();
  });

  it("rejects non-string poles", () => {
    expect(parsePoleTerms({ negTerm: 1, posTerm: "abstract" })).toBeNull();
  });

  it("rejects a term longer than MAX_POLE_TERM_CHARS", () => {
    expect(parsePoleTerms({ negTerm: "x".repeat(MAX_POLE_TERM_CHARS + 1), posTerm: "abstract" })).toBeNull();
  });

  it("measures length after trimming, not before", () => {
    // Padding a legal term past the cap with whitespace must still be accepted;
    // a cap applied to the raw string would reject it. Without this case the
    // suite cannot tell the two implementations apart.
    const padded = `  ${"x".repeat(MAX_POLE_TERM_CHARS)}  `;
    expect(parsePoleTerms({ negTerm: padded, posTerm: "abstract" })).toEqual({
      negTerm: "x".repeat(MAX_POLE_TERM_CHARS),
      posTerm: "abstract",
    });
  });

  it("rejects two identical poles, which would give a zero-length axis", () => {
    expect(parsePoleTerms({ negTerm: "concrete", posTerm: " Concrete " })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/api-axes.test.ts`
Expected: FAIL — `parsePoleTerms is not exported`.

- [ ] **Step 3: Write the implementation**

Append to `src/axis-core.ts`, adding `MAX_POLE_TERM_CHARS` to its `./types` import:

```typescript
/** Both poles of an axis. Identical poles are rejected: pos - neg would be the
 *  zero vector, which projects everything to 0 — a silently dead axis. Lives
 *  here rather than in index.ts so it is testable without pulling in the
 *  Durable Object and its cloudflare:workers import. */
export function parsePoleTerms(body: Record<string, unknown>): { negTerm: string; posTerm: string } | null {
  const neg = body.negTerm;
  const pos = body.posTerm;
  if (typeof neg !== "string" || typeof pos !== "string") return null;
  const negTerm = neg.trim();
  const posTerm = pos.trim();
  if (!negTerm || !posTerm) return null;
  if (negTerm.length > MAX_POLE_TERM_CHARS || posTerm.length > MAX_POLE_TERM_CHARS) return null;
  if (negTerm.toLowerCase() === posTerm.toLowerCase()) return null;
  return { negTerm, posTerm };
}
```

In `src/index.ts`, import it:

```typescript
import { parsePoleTerms } from "./axis-core";
```

and add `MAX_POLE_TERM_CHARS` to the existing `./types` import. Add the routes immediately before the final `return json({ error: "not found" }, 404);` at `src/index.ts:177`:

```typescript
  if (rest === "/axes" && method === "GET") {
    const axes = await stub.listAxes();
    return axes ? json({ axes }) : json({ error: "no such session" }, 404);
  }

  if (rest === "/axes" && method === "POST") {
    const body = await readBody(request);
    if (!body) return badRequest("expected a JSON object body");
    const terms = parsePoleTerms(body);
    if (!terms) {
      return badRequest(`negTerm and posTerm must be different non-empty strings of at most ${MAX_POLE_TERM_CHARS} characters`);
    }
    const result = await stub.createAxis(terms.negTerm, terms.posTerm);
    if (!result) return json({ error: "no such session" }, 404);
    // 201 only when an axis was actually added. At cap the request was dropped,
    // and answering 201 would report a silent failure as a success.
    return result.created
      ? json({ axes: result.axes }, 201)
      : json({ error: `at most ${MAX_AXES} axes`, axes: result.axes }, 409);
  }

  const axisMatch = rest.match(/^\/axes\/([^/]+)$/);
  if (axisMatch && method === "DELETE") {
    const axes = await stub.removeAxis(axisMatch[1]!);
    return axes ? json({ axes }) : json({ error: "no such session" }, 404);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/api-axes.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the wire-format regression guard**

Append to `test/pool-core.test.ts`:

```typescript
describe("wire format", () => {
  it("never leaks embeddings into served words", () => {
    const core = new PoolCore();
    core.addAxis(makeAxis("a", 0, 1));
    core.addCandidates("w1a0", entries(["alpha"], 4), 1);
    const served = core.draw("w1a0", 1, 2);
    expect(JSON.stringify(served)).not.toContain("embedding");
    // coords must be a short list of numbers, not a 1024-dim vector
    expect(served[0]!.coords.length).toBeLessThanOrEqual(MAX_AXES);
  });
});
```

- [ ] **Step 6: Run the full gates**

Run: `npm run typecheck && npm test`
Expected: typecheck exits 0, all tests pass.

- [ ] **Step 7: Manual smoke test**

The `wrangler dev` path needs WARP paused and Access service tokens exported — see [CLAUDE.md](../../../CLAUDE.md). Start it, then:

```bash
SID=$(curl -s -X POST localhost:8787/api/session -H 'content-type: application/json' \
  -d '{"seed":"tools for thinking"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
curl -s -X POST localhost:8787/api/session/$SID/axes -H 'content-type: application/json' \
  -d '{"negTerm":"concrete","posTerm":"abstract"}' | python3 -m json.tool
```

Expected: `201`, one axis, `ready: true`, and pole phrases that are **descriptive** (`"a physical object you can touch"`), not the bare terms echoed back. Bare terms echoed back means expansion silently fell back — check the AI binding with `GET /api/debug/ai`.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/axis-core.ts test/api-axes.test.ts test/pool-core.test.ts
git commit -m "feat: axis API routes

GET/POST /api/session/:id/axes and DELETE /api/session/:id/axes/:axisId.

Identical poles are rejected: pos - neg would be the zero vector, which
projects every word to 0 and silently produces a dead axis.

Adds a regression test asserting embeddings never reach served words —
shipping raw 1024-dim vectors would be ~245 KB per bucket.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Client axis data module

**Files:**
- Create: `public/axes.js`
- Modify: `public/pool-client.js`

**Interfaces:**
- Consumes: the routes from Task 5; `Served.coords` from Task 3.
- Produces: `createAxisClient(sessionId)` returning `{ list(), create(negTerm, posTerm), remove(id), axes() }`, and `normalizeCoords(values)`. No rendering — workstream A consumes this.

- [ ] **Step 1: Write the client module**

Create `public/axes.js`:

```javascript
// Client-side axis data path. No rendering — workstream A owns pixels.
// normalizeCoords mirrors src/axis-core.ts (tested there); the duplication
// follows the existing src/hint-machine.ts <-> public/hint-machine.js pattern.

/** Min-max onto 0..1. Normalization belongs on the client because it must run
 *  against the VISIBLE set, which the server does not know. Raw cosines sit in
 *  a narrow band near zero — rendered unnormalized, every word lands in a few
 *  central pixels. */
export function normalizeCoords(values) {
  if (values.length === 0) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  if (span === 0) return values.map(() => 0.5);
  return values.map((v) => (v - lo) / span);
}

export function createAxisClient(sessionId) {
  let current = [];

  async function call(path, options) {
    const res = await fetch(`/api/session/${sessionId}${path}`, options);
    if (!res.ok) throw new Error(`axis request failed: ${res.status}`);
    const { axes } = await res.json();
    current = axes ?? [];
    return current;
  }

  return {
    axes() {
      return current;
    },
    list() {
      return call('/axes');
    },
    /** Slow by design — the server expands both pole terms with an LLM call
     *  before embedding them. Callers should show progress, and must never
     *  block the field on this. */
    create(negTerm, posTerm) {
      return call('/axes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ negTerm, posTerm }),
      });
    },
    remove(id) {
      return call(`/axes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
  };
}
```

- [ ] **Step 2: Guard the mirror against drift**

`normalizeCoords` now exists twice. The repo already has this situation and solves it by running one suite against both copies — see [test/hint-machine.test.ts:1-24](../../../test/hint-machine.test.ts). Do the same here.

In `test/axis-core.test.ts`, add the browser import below the existing one:

```typescript
// public/axes.js is plain JS served raw from public/ (no build step), so it
// sits outside tsconfig's include; the cast pins it to the canonical module's
// surface and the normalizeCoords suite runs against both to prevent drift.
// @ts-expect-error — public/axes.js ships untyped
import * as browserAxesUntyped from "../public/axes.js";
const browserAxes = browserAxesUntyped as { normalizeCoords: typeof normalizeCoords };
```

Then replace the existing `describe("normalizeCoords", ...)` block with a parameterized version running the identical assertions against both:

```typescript
describe.each([
  ["src/axis-core.ts", { normalizeCoords }],
  ["public/axes.js (browser mirror)", browserAxes],
])("normalizeCoords — %s", (_name, impl) => {
  it("maps the observed range onto 0..1", () => {
    expect(impl.normalizeCoords([-0.1, 0, 0.1])).toEqual([0, 0.5, 1]);
  });

  it("centers a degenerate range instead of dividing by zero", () => {
    expect(impl.normalizeCoords([0.3, 0.3, 0.3])).toEqual([0.5, 0.5, 0.5]);
  });

  it("returns [] for an empty input", () => {
    expect(impl.normalizeCoords([])).toEqual([]);
  });
});
```

Run: `npx vitest run test/axis-core.test.ts`
Expected: PASS, with each `normalizeCoords` case reported twice — once per implementation. Deliberately break one copy (change `0.5` to `0.4` in `public/axes.js`) and confirm the suite goes red, then revert. A guard that cannot fail is not a guard.

- [ ] **Step 3: Carry coords through the pool buffer**

`public/pool-client.js:25` pushes served words into per-bucket buffers and `draw()` shifts them out. Those objects are passed through by reference, so `coords` already survives — but `public/field.js:50` reconstructs a new object (`return { text: pick.text, tier };`) and drops everything else.

Leave `field.js` alone (workstream A rewrites that path). Instead add a comment at `public/pool-client.js:25` recording the contract:

```javascript
      // Buffered items are the server's Served objects: {text, tier, alt,
      // seedDist, coords}. coords is one raw cosine per ready axis, needing
      // normalizeCoords() against the visible set before use as layout
      // positions. field.js currently keeps only {text, tier}; map mode
      // (workstream A) is what consumes coords.
      buffers.get(bucket).push(...condensed);
```

- [ ] **Step 4: Verify in the browser**

Start the dev server via the `dewpt` config in [.claude/launch.json](../../../.claude/launch.json) (never `npm run dev` from Bash). In the console:

```javascript
const { createAxisClient } = await import('/axes.js');
// The session id is not in location.search — read it off a /api/session/<id>/…
// request in the network panel, or from whatever the page holds it in.
const ax = createAxisClient(SESSION_ID);
await ax.create('concrete', 'abstract');
```

Expected: an array of one axis, `ready: true`, with descriptive pole phrases. Then confirm coordinates are flowing:

```javascript
await (await fetch(`/api/session/${SID}/pool?bucket=w1a0&count=5`)).json();
```

Expected: each `condensed` entry has a `coords` array of length 1, values roughly in −0.2…0.2. Values all exactly 0 mean the axis is not ready or the poles were identical.

- [ ] **Step 5: Run the gates**

Run: `npm run typecheck && npm test`
Expected: typecheck exits 0, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add public/axes.js public/pool-client.js test/axis-core.test.ts
git commit -m "feat: client axis data path

createAxisClient wraps the axis routes; normalizeCoords mirrors
src/axis-core.ts following the existing hint-machine src/public pattern.

Normalization lives on the client because it must run against the visible
set, which the server does not know. Raw cosines sit in a narrow band near
zero, so unnormalized coordinates would put every word in a few central
pixels.

No rendering — workstream A consumes this.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Done when

- A user can `POST /axes` with two pole terms and get back an axis whose phrases are descriptive expansions, not the bare terms.
- Every `/pool` response carries one coordinate per ready axis, and no embeddings.
- Words near a pole score toward that pole; orthogonal words score ~0.
- `npm run typecheck` exits 0 and the suite passes with the new tests.

## Explicitly out of scope

- **All rendering** — map mode, the axis-naming UI, and the position sliders are workstream A.
- **Editing a pole phrase after creation.** The design calls for showing the expansion and letting the user correct it; that is a UI affordance and lands with the UI. The data model already supports it (replace `phrase`, null the `embedding`, let the pump re-embed).
- **Collapsing `altitude` into a preset axis.** The design flags this as deferred.
- **Fog of war, the notes corpus, and re-projection on rename** — workstreams B and D.

## Open questions this plan does not resolve

- **Axis order vs. spatial assignment.** `coords` is emitted in axis-creation order, and the client currently decides which axis is x/y/z. If assignment should be persisted server-side, `Axis` needs an `assignedTo` field — the design doc sketches one, but nothing in workstream C needs it yet.
- **What the axes default to before any are named** (open question #1 in the design doc). This plan serves `coords: []` until the user names one, which is compatible with every option still on the table.
