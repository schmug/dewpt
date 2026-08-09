# Conveyor Board — M0 + M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the calibration spike that proves the rewrite mechanic works, then the working belt — seed a word, watch 2–3 lineages flow rightward through three fixed stations being rewritten at each, leaving fading ghosts, and evaporate at the edge.

**Architecture:** A new `/board` surface on dewpt's existing Worker. A pure `BeltCore` (lineages, capacity, ghosts, edge eviction) and a pure `rewrite` module (prompt, scoring, selection) sit outside a thin `BoardDO` shell with an alarm loop, exactly mirroring how `PoolCore` sits outside `SessionDO`. Scoring treats **the parent card as the negative pole and the station phrase as the positive one**, reusing `axisVector` and `coordsFor` unchanged.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects (SQLite-backed), Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, `@cf/baai/bge-m3`), vitest, vanilla DOM client.

**Spec:** [2026-08-08-conveyor-board-design.md](../specs/2026-08-08-conveyor-board-design.md)

## Global Constraints

- **Never block the belt on an AI call.** Pool depth / readiness is a correctness requirement, not an optimization. A state read must return without awaiting generation.
- **No embeddings on the wire, ever.** Any `/api/board/*` response containing an `embedding` key is a bug.
- **Logic stays out of the Durable Object.** New pool/scoring/belt logic goes in pure modules under `src/board/`; `board-do.ts` is the thin stateful shell.
- **Weather vocabulary in user-facing copy, API params and schema keys.** Code comments and LLM prompts use the plain concept ("strangeness", not "dewpoint"). The board adds no new weather terms — it uses *station*, *lineage*, *ghost*, *harvest*, *edge*.
- **`prefers-reduced-motion` must degrade to no drift.** On the board the drift *is* the belt, so it becomes step-only with no transitions.
- **Unpinned content evaporates.** Nothing may make a card permanent.
- Gates are `npm run typecheck` and `npm test`, reported as counts ("226 passing, 0 failing"), never as "tests pass".
- Tests are vitest over pure core logic — no network, no Workers runtime. AI is faked by `src/dev-fake-ai.ts`.
- Conventional commit prefixes: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`.
- `wrangler.jsonc`'s existing `v1` migration tag must never be edited. New Durable Object classes get a new tag.

## File Structure

**Create:**

| Path | Responsibility |
| --- | --- |
| `src/board/types.ts` | `Station`, `Card`, `Lineage`, `EvaporatedCard`, all constants |
| `src/board/rewrite.ts` | Prompt construction, candidate parsing, scoring, selection, arrival |
| `src/board/belt-core.ts` | Pure belt: seeds, fan, hops, ghosts, capacity, edge eviction, failure release |
| `src/board/board-do.ts` | `BoardDO` — thin stateful shell + alarm loop |
| `scripts/board-calibrate.ts` | M0 measurement; prints the three constants |
| `public/board/index.html` | Board shell |
| `public/board/board.js` | Client state, seeding, polling |
| `public/board/belt-render.js` | DOM rendering of stations, lineages, ghosts |
| `public/board/styles.css` | Board styling |
| `test/board-rewrite.test.ts` | Scoring, selection, arrival, prompt/parse |
| `test/board-belt-core.test.ts` | Belt mechanics |
| `test/board-api.test.ts` | Route shape + wire-format guard |

**Modify:**

| Path | Change |
| --- | --- |
| `src/index.ts` | Add `/api/board/*` routing ahead of the existing session matcher |
| `src/dev-fake-ai.ts` | Board-aware branches for pole expansion and rewrites |
| `wrangler.jsonc` | `BOARD_DO` binding + `v2` migration tag |
| `package.json` | `board-calibrate` script |

---

### Task 1: Scoring math

**Files:**
- Create: `src/board/types.ts`
- Create: `src/board/rewrite.ts`
- Test: `test/board-rewrite.test.ts`

**Interfaces:**
- Consumes: `axisVector`, `coordsFor` from `src/axis-core.ts`; `cosineSim` from `src/pool-core.ts`; `DEDUPE_COSINE` from `src/types.ts`
- Produces: `scoreCandidates(parentEmb, phraseEmb, candidates) → ScoredCandidate[]`, `selectChild(parentEmb, phraseEmb, candidates, opts) → ScoredCandidate | null`, `hasArrived(parentEmb, phraseEmb, arrivalCosine) → boolean`, and every constant in `src/board/types.ts`

Note the deliberate design choice: **`selectChild` and `hasArrived` take their thresholds as parameters** with defaults from `types.ts`. Tests pass explicit values, so they do not break when Task 2 replaces the calibrated numbers.

- [ ] **Step 1: Write the failing test**

Create `test/board-rewrite.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hasArrived, scoreCandidates, selectChild } from "../src/board/rewrite";

/** Unit vector in 3-space, so the projections below are hand-checkable. */
function unit(v: number[]): number[] {
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / m);
}

const PARENT = [1, 0, 0];
const PHRASE = [0, 1, 0];

describe("scoreCandidates", () => {
  it("scores a candidate by how much of its displacement lands along phrase - parent", () => {
    const [halfway] = scoreCandidates(PARENT, PHRASE, [{ text: "halfway", embedding: unit([1, 1, 0]) }]);
    // displacement (-0.293, 0.707, 0) against station vector (-1, 1, 0)
    expect(halfway!.score).toBeCloseTo(0.924, 2);
    expect(halfway!.tether).toBeCloseTo(0.707, 2);
  });

  it("gives the phrase itself the maximum score and zero tether", () => {
    const [arrived] = scoreCandidates(PARENT, PHRASE, [{ text: "arrived", embedding: PHRASE }]);
    expect(arrived!.score).toBeCloseTo(1, 5);
    expect(arrived!.tether).toBeCloseTo(0, 5);
  });

  it("gives a candidate identical to the parent a zero score", () => {
    const [stuck] = scoreCandidates(PARENT, PHRASE, [{ text: "stuck", embedding: PARENT }]);
    expect(stuck!.score).toBeCloseTo(0, 5);
  });
});

describe("selectChild", () => {
  const candidates = [
    { text: "halfway", embedding: unit([1, 1, 0]) },  // score .924, tether .707
    { text: "timid", embedding: unit([3, 1, 0]) },    // score .811, tether .949
    { text: "untethered", embedding: PHRASE },        // score 1.00, tether 0
  ];

  it("picks the highest-scoring candidate that clears the tether floor", () => {
    const picked = selectChild(PARENT, PHRASE, candidates, { tetherFloor: 0.5 });
    expect(picked?.text).toBe("halfway");
  });

  it("never picks a candidate below the tether floor even when it scores highest", () => {
    const picked = selectChild(PARENT, PHRASE, candidates, { tetherFloor: 0.9 });
    expect(picked?.text).toBe("timid");
  });

  it("returns null when every candidate fails the floor, rather than lowering it", () => {
    expect(selectChild(PARENT, PHRASE, candidates, { tetherFloor: 0.99 })).toBeNull();
  });

  it("rejects a candidate that near-duplicates the lineage's own history", () => {
    const picked = selectChild(PARENT, PHRASE, candidates, {
      tetherFloor: 0.5,
      exclude: [unit([1, 1, 0])],
    });
    expect(picked?.text).toBe("timid");
  });
});

describe("hasArrived", () => {
  it("is true when the parent has effectively reached the station phrase", () => {
    expect(hasArrived(PHRASE, PHRASE, 0.9)).toBe(true);
  });

  it("is false while there is still distance to travel", () => {
    expect(hasArrived(PARENT, PHRASE, 0.9)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/board-rewrite.test.ts`
Expected: FAIL — `Failed to resolve import "../src/board/rewrite"`

- [ ] **Step 3: Write `src/board/types.ts`**

```ts
// Conveyor board types and constants. Vocabulary note (SPEC.md): the board's
// nouns are station / lineage / ghost / edge / harvest. The weather terms
// belong to the field; prompts use plain concepts.

/** One station on the belt — a user-named direction, expanded to a
 *  descriptive phrase before embedding. A bare term costs ~0.34 AUC to
 *  polysemy (docs/latent-space-navigation-design.md), so `phrase` is never
 *  optional and `expanded: false` must stay visible. */
export interface Station {
  id: string;
  order: number;
  term: string;
  phrase: string;
  expanded: boolean;
  embedding: number[] | null;
}

export interface Card {
  id: string;
  text: string;
  /** 0 = the seed column. A card at index k has passed k stations. */
  stationIndex: number;
  bornAt: number;
  embedding: number[] | null;
}

export interface Lineage {
  id: string;
  seedText: string;
  /** cards[0] is the seed; the last element is the live head, the rest ghosts. */
  cards: Card[];
  /** Consecutive failed hops. At MAX_HOP_FAILURES the lineage is released. */
  failures: number;
  arrivedAt: number | null;
  /** Set when the head passes the last station; evicted EDGE_DWELL_MS later. */
  edgeAt: number | null;
}

export interface EvaporatedCard {
  text: string;
  evaporatedAt: number;
}

export const DEFAULT_STATION_TERMS = ["concretize", "make strange", "ground it"];

/** Legibility cap — the board's CAP = 14. The mockups read comfortably at
 *  four rows; this is bounded by readability, not by frame rate. */
export const MAX_LINEAGES = 6;

/** Children requested from a seed's first hop. One call, so a fresh board with
 *  a single seed is never gated on one generation. */
export const SEED_FANOUT = 3;

/** How long a head dwells at the edge before evaporating. A legibility pause
 *  (long enough to read and, from M3, to pin), not a tuning knob. */
export const EDGE_DWELL_MS = 6000;

/** Consecutive failed hops before a lineage is released to the edge. A
 *  permanently stuck card is indistinguishable from a slow one. */
export const MAX_HOP_FAILURES = 3;

/** Ghosts kept behind the head. Older ones are dropped from the wire entirely. */
export const GHOST_DEPTH = 3;

export const EVAPORATED_CAP = 20;

// ── calibrated in M0 (scripts/board-calibrate.ts) ──────────────────────────
// The values below are the pre-calibration defaults used to get Task 1
// compiling. Task 2 replaces them with measured numbers and records the
// evidence. Do not ship on these.

/** Minimum cosine against the parent for a rewrite to still be a rewrite
 *  rather than a non-sequitur. */
export const TETHER_FLOOR = 0.5;

/** Cosine at which a card has effectively reached a station's phrase, so that
 *  direction has nothing left to give. NOTE: this is deliberately NOT
 *  DEGENERATE_POLE_COSINE (0.98) from src/types.ts — that constant was tuned
 *  pole-against-pole and does not transfer to card-against-phrase. */
export const ARRIVAL_COSINE = 0.9;

/** Candidates requested per hop, before tether and dedupe filtering. */
export const CANDIDATES_PER_HOP = 8;
```

- [ ] **Step 4: Write `src/board/rewrite.ts` (scoring half only)**

```ts
// Rewrite scoring for the conveyor board.
//
// A direction needs two poles. THE PARENT CARD IS THE NEGATIVE POLE and the
// station phrase is the positive one, so the intended move is
// `phrase - parent` and a candidate is judged by how much of its own
// displacement lands along it. This keeps the pair construction the axis spike
// measured at mean AUC 0.843 against 0.763 for a single term — scoring
// candidates against the phrase embedding alone is the weaker construction and
// looks identical from the outside.

import { axisVector, coordsFor } from "../axis-core";
import { cosineSim } from "../pool-core";
import { DEDUPE_COSINE } from "../types";
import { ARRIVAL_COSINE, TETHER_FLOOR } from "./types";

export interface Candidate {
  text: string;
  embedding: number[];
}

export interface ScoredCandidate extends Candidate {
  /** Displacement projected onto the intended direction. Higher is further. */
  score: number;
  /** Cosine against the parent. Low means the "rewrite" drifted off-topic. */
  tether: number;
}

export function scoreCandidates(
  parentEmb: number[],
  phraseEmb: number[],
  candidates: Candidate[],
): ScoredCandidate[] {
  const stationVec = axisVector(parentEmb, phraseEmb);
  return candidates.map((c) => ({
    ...c,
    score: coordsFor(axisVector(parentEmb, c.embedding), [stationVec])[0] ?? 0,
    tether: cosineSim(c.embedding, parentEmb),
  }));
}

export interface SelectOptions {
  tetherFloor?: number;
  dedupeCosine?: number;
  /** Embeddings the child must not near-duplicate: the lineage's own history
   *  plus anything else the caller wants excluded. */
  exclude?: number[][];
}

/** Highest-scoring candidate that clears the tether floor and duplicates
 *  nothing excluded. Returns null when none qualify — the caller retries or
 *  releases the lineage. It must NEVER lower the floor to find a winner; that
 *  turns a quality guard into a no-op. */
export function selectChild(
  parentEmb: number[],
  phraseEmb: number[],
  candidates: Candidate[],
  opts: SelectOptions = {},
): ScoredCandidate | null {
  const floor = opts.tetherFloor ?? TETHER_FLOOR;
  const dedupe = opts.dedupeCosine ?? DEDUPE_COSINE;
  const exclude = opts.exclude ?? [];
  let best: ScoredCandidate | null = null;
  for (const c of scoreCandidates(parentEmb, phraseEmb, candidates)) {
    if (c.tether < floor) continue;
    if (exclude.some((e) => cosineSim(e, c.embedding) > dedupe)) continue;
    if (best === null || c.score > best.score) best = c;
  }
  return best;
}

/** True when the card has effectively reached the station's phrase, so this
 *  direction is exhausted for this idea. Not a failure — information. */
export function hasArrived(
  parentEmb: number[],
  phraseEmb: number[],
  arrivalCosine: number = ARRIVAL_COSINE,
): boolean {
  return cosineSim(parentEmb, phraseEmb) >= arrivalCosine;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/board-rewrite.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 6: Run the full gates**

Run: `npm test && npm run typecheck`
Expected: all prior tests still pass; typecheck clean. Report counts.

- [ ] **Step 7: Commit**

```bash
git add src/board/types.ts src/board/rewrite.ts test/board-rewrite.test.ts
git commit -m "feat: score board rewrites with the parent as negative pole"
```

---

### Task 2: M0 — calibrate the three constants

**Files:**
- Create: `scripts/board-calibrate.ts`
- Modify: `package.json` (add `board-calibrate` script)
- Modify: `src/board/types.ts` (replace the three pre-calibration values)

**Interfaces:**
- Consumes: `scoreCandidates` from Task 1; `requireCreds`, `embedTexts`, `auc`, `cosine` from `scripts/axis-lib.ts`
- Produces: measured values for `TETHER_FLOOR`, `ARRIVAL_COSINE`, `CANDIDATES_PER_HOP`

**This task is a gate.** If the script reports that genuine rewrites and non-sequiturs do not separate — AUC below 0.80 — the rewrite mechanic does not work as designed. **Stop, report the number, and do not start Task 3.** Better known now than after a UI exists.

Like `calibrate.ts` and the axis spikes, this talks to Workers AI over REST from node, which is unaffected by the local `wrangler dev` egress problems documented in CLAUDE.md.

- [ ] **Step 1: Add the npm script**

In `package.json`, inside `"scripts"`, after the `"axis-layout"` line:

```json
    "board-calibrate": "tsx scripts/board-calibrate.ts"
```

- [ ] **Step 2: Write the calibration script**

Create `scripts/board-calibrate.ts`:

```ts
// M0 calibration for the conveyor board. Measures the three constants the
// design cannot guess: TETHER_FLOOR, ARRIVAL_COSINE and CANDIDATES_PER_HOP.
//
// REST-from-node like calibrate.ts and the axis spikes, so it is unaffected by
// the local wrangler-dev egress issues (see CLAUDE.md).
//
//   CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run board-calibrate
//
// The token needs "Workers AI - Read".

import { scoreCandidates } from "../src/board/rewrite";
import { auc, cosine, embedTexts, requireCreds } from "./axis-lib";

const GEN_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** Hand-built probes: a parent fragment, a station phrase, genuine rewrites
 *  along that direction, and non-sequiturs that are plausible English but not
 *  derived from the parent. The non-sequiturs are what TETHER_FLOOR must
 *  exclude. */
const PROBES = [
  {
    parent: "urban gardening",
    phrase: "a physical object you can touch",
    genuine: ["rooftop bee lease", "balcony planter boxes", "rain barrel", "window herb box", "compost bin"],
    nonSequitur: ["quarterly earnings call", "saxophone reed", "lighthouse keeper", "gingham tablecloth", "referendum ballot"],
  },
  {
    parent: "tool libraries",
    phrase: "a surreal, dreamlike version",
    genuine: ["lathe confessional", "hammer that remembers", "borrowed-wrench oracle", "saw with a conscience", "drill that dreams"],
    nonSequitur: ["monsoon season", "escalator maintenance", "porcelain figurine", "tuesday afternoon", "meridian line"],
  },
  {
    parent: "security awareness training",
    phrase: "a mystical or magical practice",
    genuine: ["threat-model tarot deck", "phishing ouija board", "firewall gargoyles", "breach divination", "password incantation"],
    nonSequitur: ["linoleum flooring", "tributary river", "cardigan sweater", "handshake protocol fee", "photosynthesis rate"],
  },
] as const;

async function generate(accountId: string, token: string, messages: unknown, temperature: number): Promise<string> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${GEN_MODEL}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ messages, temperature, max_tokens: 512 }),
  });
  const body = (await res.json()) as { success: boolean; result?: { response?: string }; errors?: { message: string }[] };
  if (!res.ok || !body.success) {
    throw new Error(`generate failed: ${body.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`}`);
  }
  return body.result?.response ?? "";
}

function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[i]!;
}

function mean(xs: number[]): number {
  return xs.reduce((s, x) => s + x, 0) / (xs.length || 1);
}

async function main(): Promise<void> {
  const { accountId, token } = requireCreds();

  // ── 1. TETHER_FLOOR ─────────────────────────────────────────────────────
  // Do genuine rewrites and non-sequiturs separate by cosine-against-parent?
  const genuineTethers: number[] = [];
  const nonSequiturTethers: number[] = [];
  const arrivalByHop: number[][] = [];

  for (const probe of PROBES) {
    const texts = [probe.parent, probe.phrase, ...probe.genuine, ...probe.nonSequitur];
    const vecs = await embedTexts(accountId, token, texts);
    const [parentVec, phraseVec] = [vecs[0]!, vecs[1]!];
    const genuineVecs = vecs.slice(2, 2 + probe.genuine.length);
    const nonVecs = vecs.slice(2 + probe.genuine.length);

    for (const v of genuineVecs) genuineTethers.push(cosine(v, parentVec));
    for (const v of nonVecs) nonSequiturTethers.push(cosine(v, parentVec));

    // ── 2. ARRIVAL_COSINE ────────────────────────────────────────────────
    // How close to the phrase does a genuine rewrite actually land? Arrival
    // must sit ABOVE this, or every first hop reports arrival immediately.
    arrivalByHop.push(genuineVecs.map((v) => cosine(v, phraseVec)));

    // Sanity: the scoring function must rank genuine rewrites above
    // non-sequiturs on movement, not just on tether.
    const scored = scoreCandidates(parentVec, phraseVec, [
      ...probe.genuine.map((text, i) => ({ text, embedding: genuineVecs[i]! })),
      ...probe.nonSequitur.map((text, i) => ({ text, embedding: nonVecs[i]! })),
    ]);
    const g = scored.slice(0, probe.genuine.length).map((c) => c.score);
    const n = scored.slice(probe.genuine.length).map((c) => c.score);
    console.log(`\n${probe.parent}  ->  ${probe.phrase}`);
    console.log(`  movement AUC (genuine vs non-sequitur): ${auc(g, n).toFixed(3)}`);
    console.log(`  mean tether  genuine ${mean(genuineVecs.map((v) => cosine(v, parentVec))).toFixed(3)}  non-seq ${mean(nonVecs.map((v) => cosine(v, parentVec))).toFixed(3)}`);
  }

  const tetherAuc = auc(genuineTethers, nonSequiturTethers);
  // Keep ~95% of genuine rewrites; the floor sits just under their 5th pct.
  const floor = pct(genuineTethers, 0.05);
  const falseAccept = nonSequiturTethers.filter((t) => t >= floor).length / nonSequiturTethers.length;

  console.log("\n=== TETHER_FLOOR ===");
  console.log(`  separation AUC        ${tetherAuc.toFixed(3)}   (gate: >= 0.80)`);
  console.log(`  genuine  p05 ${pct(genuineTethers, 0.05).toFixed(3)}  p50 ${pct(genuineTethers, 0.5).toFixed(3)}`);
  console.log(`  non-seq  p50 ${pct(nonSequiturTethers, 0.5).toFixed(3)}  p95 ${pct(nonSequiturTethers, 0.95).toFixed(3)}`);
  console.log(`  proposed TETHER_FLOOR ${floor.toFixed(3)}  (admits ${(falseAccept * 100).toFixed(0)}% of non-sequiturs)`);

  const arrivals = arrivalByHop.flat();
  console.log("\n=== ARRIVAL_COSINE ===");
  console.log(`  genuine-rewrite cosine to phrase: p50 ${pct(arrivals, 0.5).toFixed(3)}  p95 ${pct(arrivals, 0.95).toFixed(3)}  max ${Math.max(...arrivals).toFixed(3)}`);
  console.log(`  proposed ARRIVAL_COSINE ${(pct(arrivals, 0.95) + 0.05).toFixed(3)}  (above p95, so a normal hop never false-reports arrival)`);

  // ── 3. CANDIDATES_PER_HOP ───────────────────────────────────────────────
  // For each N, how often does at least one live candidate clear the floor,
  // and how much better is argmax than an average candidate?
  console.log("\n=== CANDIDATES_PER_HOP ===");
  const system = `You rewrite a short fragment into a NEW short fragment that moves it toward a target quality while staying recognisably derived from it.

Rules:
- Respond with a JSON array of strings only. No prose, no code fences.
- Each item is 1-5 words.
- Every item must be a rewrite of the given fragment, not a new topic.
- No duplicates.`;

  for (const n of [4, 8, 12]) {
    let yielded = 0;
    let lift = 0;
    for (const probe of PROBES) {
      const raw = await generate(accountId, token, [
        { role: "system", content: system },
        { role: "user", content: `${JSON.stringify({ fragment: probe.parent, target: probe.phrase, count: n })}\nReturn a JSON array of exactly ${n} strings.` },
      ], 0.9);
      let items: string[] = [];
      try {
        const start = raw.indexOf("[");
        const end = raw.lastIndexOf("]");
        items = start !== -1 && end > start ? (JSON.parse(raw.slice(start, end + 1)) as string[]) : [];
      } catch {
        items = [];
      }
      items = items.filter((s) => typeof s === "string" && s.trim()).slice(0, n);
      if (items.length === 0) continue;
      const vecs = await embedTexts(accountId, token, [probe.parent, probe.phrase, ...items]);
      const scored = scoreCandidates(vecs[0]!, vecs[1]!, items.map((text, i) => ({ text, embedding: vecs[i + 2]! })));
      const live = scored.filter((c) => c.tether >= floor);
      if (live.length > 0) {
        yielded++;
        lift += Math.max(...live.map((c) => c.score)) - mean(scored.map((c) => c.score));
      }
    }
    console.log(`  n=${String(n).padStart(2)}  hops with a usable child: ${yielded}/${PROBES.length}   argmax lift over mean: ${(lift / PROBES.length).toFixed(3)}`);
  }

  console.log("\nGATE: if separation AUC < 0.80, the rewrite mechanic does not work. Stop and report.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 3: Run the calibration**

Run:

```bash
CLOUDFLARE_ACCOUNT_ID=<id> CLOUDFLARE_API_TOKEN=<token> npm run board-calibrate
```

Expected: three labelled blocks of numbers. **Read the separation AUC first.**

- [ ] **Step 4: Evaluate the gate**

- **Separation AUC ≥ 0.80** → proceed. Record the printed `proposed TETHER_FLOOR`, `proposed ARRIVAL_COSINE`, and the smallest `n` whose "hops with a usable child" is 3/3.
- **Separation AUC < 0.80** → **STOP.** Do not start Task 3. Report the number and the per-probe breakdown, and say plainly that the rewrite mechanic did not clear its gate.

- [ ] **Step 5: Write the measured constants in**

In `src/board/types.ts`, replace the three pre-calibration values with the measured ones and replace the "do not ship on these" comment block with the evidence. For example, if the run reported floor 0.42, arrival 0.71, n=8:

```ts
// ── calibrated in M0 (npm run board-calibrate, 2026-08-08) ─────────────────
// Separation AUC 0.9xx between genuine rewrites and non-sequiturs — the
// mechanic's gate. Re-run the script if the rewrite prompt changes.

/** Minimum cosine against the parent for a rewrite to still be a rewrite
 *  rather than a non-sequitur. Set just under the 5th percentile of genuine
 *  rewrites, admitting N% of non-sequiturs. */
export const TETHER_FLOOR = 0.42;

/** Cosine at which a card has effectively reached a station's phrase, so that
 *  direction has nothing left to give. Sits above the 95th percentile of
 *  normal hops, so an ordinary rewrite never false-reports arrival. NOTE:
 *  deliberately NOT DEGENERATE_POLE_COSINE (0.98) from src/types.ts — that was
 *  tuned pole-against-pole and does not transfer to card-against-phrase. */
export const ARRIVAL_COSINE = 0.71;

/** Candidates per hop, before tether and dedupe filtering. Smallest count that
 *  yielded a usable child on every probe. */
export const CANDIDATES_PER_HOP = 8;
```

- [ ] **Step 6: Run the gates**

Run: `npm test && npm run typecheck`
Expected: Task 1's tests still pass — they pass thresholds explicitly, so calibrated constants cannot break them. Report counts.

- [ ] **Step 7: Commit**

```bash
git add scripts/board-calibrate.ts package.json src/board/types.ts
git commit -m "feat: calibrate the board's tether, arrival and hop-width constants"
```

---

### Task 3: Rewrite prompt and generation

**Files:**
- Modify: `src/board/rewrite.ts`
- Test: `test/board-rewrite.test.ts`

**Interfaces:**
- Consumes: `AiRunner`, `parseCandidateList` from `src/generation.ts`
- Produces: `buildRewriteMessages(inputs: RewriteInputs) → ChatMessage[]`, `generateRewrites(ai, model, inputs) → Promise<string[]>`, `RewriteInputs { fragment, target, count, exclude }`

`parseCandidateList` is reused rather than reimplemented: it already enforces the 5-word / 64-char caps and already survives fenced blocks, prose wrappers and object envelopes. It never throws — junk yields `[]`.

- [ ] **Step 1: Write the failing test**

Append to `test/board-rewrite.test.ts`:

```ts
import { buildRewriteMessages, generateRewrites } from "../src/board/rewrite";
import type { AiRunner } from "../src/generation";

describe("buildRewriteMessages", () => {
  const inputs = { fragment: "urban gardening", target: "a surreal, dreamlike version", count: 8, exclude: ["rooftop bee lease"] };

  it("puts the fragment, target and count in the final user turn", () => {
    const messages = buildRewriteMessages(inputs);
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe("user");
    expect(last.content).toContain("urban gardening");
    expect(last.content).toContain("a surreal, dreamlike version");
    expect(last.content).toContain("8");
  });

  it("carries the exclusion list so the model avoids the lineage's own history", () => {
    expect(buildRewriteMessages(inputs).at(-1)!.content).toContain("rooftop bee lease");
  });

  it("opens with a system turn and includes few-shot demonstrations", () => {
    const messages = buildRewriteMessages(inputs);
    expect(messages[0]!.role).toBe("system");
    expect(messages.filter((m) => m.role === "assistant").length).toBeGreaterThan(0);
  });

  it("never mentions the weather vocabulary — prompts use plain concepts", () => {
    const all = buildRewriteMessages(inputs).map((m) => m.content).join(" ").toLowerCase();
    for (const term of ["dewpoint", "drizzle", "condensate", "evaporated"]) {
      expect(all).not.toContain(term);
    }
  });
});

describe("generateRewrites", () => {
  function runnerReturning(payload: unknown): AiRunner {
    return { async run() { return payload; } };
  }

  it("parses a plain JSON array", async () => {
    const ai = runnerReturning({ response: JSON.stringify(["lathe confessional", "hammer that dreams"]) });
    await expect(generateRewrites(ai, "m", { fragment: "tool libraries", target: "x", count: 2, exclude: [] }))
      .resolves.toEqual(["lathe confessional", "hammer that dreams"]);
  });

  it("recovers an array buried in prose", async () => {
    const ai = runnerReturning({ response: 'Sure! ["rain barrel", "seed swap"] hope that helps' });
    await expect(generateRewrites(ai, "m", { fragment: "gardening", target: "x", count: 2, exclude: [] }))
      .resolves.toEqual(["rain barrel", "seed swap"]);
  });

  it("returns an empty list rather than throwing on junk", async () => {
    const ai = runnerReturning({ response: "I'm sorry, I can't help with that." });
    await expect(generateRewrites(ai, "m", { fragment: "x", target: "y", count: 4, exclude: [] }))
      .resolves.toEqual([]);
  });

  it("drops items longer than five words, per the fragment register", async () => {
    const ai = runnerReturning({ response: JSON.stringify(["rooftop bee lease", "this phrase is far too long to be a fragment"]) });
    await expect(generateRewrites(ai, "m", { fragment: "x", target: "y", count: 2, exclude: [] }))
      .resolves.toEqual(["rooftop bee lease"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/board-rewrite.test.ts`
Expected: FAIL — `buildRewriteMessages is not a function`

- [ ] **Step 3: Implement**

Append to `src/board/rewrite.ts`:

```ts
import { parseCandidateList, type AiRunner, type ChatMessage } from "../generation";

export interface RewriteInputs {
  fragment: string;
  /** The station's expanded descriptive phrase, never its bare term. */
  target: string;
  count: number;
  exclude: string[];
}

const REWRITE_SYSTEM_PROMPT = `You rewrite a short fragment into a NEW short fragment that moves it toward a target quality while staying recognisably derived from it.

Rules:
- Respond with a JSON array of strings only. No prose, no code fences, no keys.
- Each item is 1-5 words. No sentences, no explanations.
- Every item must be a rewrite of the given fragment, carrying something of it forward. A new topic is a failure, however good it sounds.
- Move decisively toward the target. An item that would fit the original fragment equally well has not moved.
- Never repeat anything in the exclusion list, and avoid trivial variants of it.
- No duplicates within your answer.`;

/** Two demonstrations, from different domains so the model does not overfit to
 *  one, showing the move that matters: the child keeps the parent's subject and
 *  changes its character. */
const REWRITE_FEWSHOT: { inputs: RewriteInputs; out: string[] }[] = [
  {
    inputs: { fragment: "urban gardening", target: "a physical object you can touch", count: 5, exclude: [] },
    out: ["rooftop bee lease", "balcony planter boxes", "rain barrel", "window herb box", "sidewalk seed bomb"],
  },
  {
    inputs: { fragment: "security awareness training", target: "a mystical or magical practice", count: 5, exclude: [] },
    out: ["threat-model tarot deck", "phishing ouija board", "firewall gargoyles", "breach divination", "password incantation"],
  },
];

function rewritePayload(inputs: RewriteInputs): string {
  const payload = JSON.stringify({
    fragment: inputs.fragment,
    target: inputs.target,
    exclude: inputs.exclude,
    count: inputs.count,
  });
  return `${payload}\nReturn a JSON array of exactly ${inputs.count} strings. No other text.`;
}

export function buildRewriteMessages(inputs: RewriteInputs): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: REWRITE_SYSTEM_PROMPT }];
  for (const shot of REWRITE_FEWSHOT) {
    messages.push({ role: "user", content: rewritePayload(shot.inputs) });
    messages.push({ role: "assistant", content: JSON.stringify(shot.out) });
  }
  messages.push({ role: "user", content: rewritePayload(inputs) });
  return messages;
}

/** Temperature is fixed rather than banded: unlike the field, the board's
 *  variety comes from the station phrase, not from a strangeness slider. */
const REWRITE_TEMPERATURE = 0.9;

export async function generateRewrites(ai: AiRunner, model: string, inputs: RewriteInputs): Promise<string[]> {
  const result = await ai.run(model, {
    messages: buildRewriteMessages(inputs),
    temperature: REWRITE_TEMPERATURE,
    max_tokens: 512,
  });
  return parseCandidateList(extractRewriteResponse(result), inputs.count);
}

/** Mirrors generation.ts's envelope handling; kept local because that module
 *  does not export its version. */
function extractRewriteResponse(result: unknown): unknown {
  if (result === null || result === undefined) return null;
  if (typeof result === "string" || Array.isArray(result)) return result;
  if (typeof result !== "object") return null;
  const obj = result as Record<string, unknown>;
  if (obj.response !== undefined) return obj.response;
  const choices = obj.choices as { message?: { content?: unknown } }[] | undefined;
  if (Array.isArray(choices) && choices[0]?.message?.content !== undefined) return choices[0].message.content;
  if (obj.output_text !== undefined) return obj.output_text;
  if (obj.result !== undefined) return extractRewriteResponse(obj.result);
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/board-rewrite.test.ts`
Expected: PASS, 17 tests

- [ ] **Step 5: Run the gates and commit**

```bash
npm test && npm run typecheck
git add src/board/rewrite.ts test/board-rewrite.test.ts
git commit -m "feat: add the board's rewrite prompt and generation path"
```

---

### Task 4: Teach the fake AI about the board

**Files:**
- Modify: `src/dev-fake-ai.ts`
- Test: `test/board-rewrite.test.ts`

**Interfaces:**
- Consumes: `fakeAiRunner` from `src/dev-fake-ai.ts`
- Produces: `fakeAiRunner()` handling three request shapes — embeddings, field generation, and now pole expansion + board rewrites

**Why this is its own task.** `fakeAiRunner` currently parses the last message's first line as `{strangeness, altitude, count}` ([dev-fake-ai.ts:48](../../../src/dev-fake-ai.ts)). A board rewrite request parses fine as JSON but has no `strangeness`, so `undefined < 0.33` is false and `undefined <= 0.66` is false — it silently falls through to tier 2 and returns **security-awareness words**. It does not throw. Local board development would appear to work while testing nothing. The same bug already makes every axis degraded under `DEV_FAKE_AI=1`, because `expandPole`'s response never parses as `{phrase}`.

- [ ] **Step 1: Write the failing test**

Append to `test/board-rewrite.test.ts`:

```ts
import { fakeAiRunner } from "../src/dev-fake-ai";
import { expandPole } from "../src/generation";

describe("fakeAiRunner — board support", () => {
  it("returns rewrites of the fragment, not field words", async () => {
    const ai = fakeAiRunner();
    const out = await generateRewrites(ai, "m", {
      fragment: "tool libraries",
      target: "a surreal, dreamlike version",
      count: 4,
      exclude: [],
    });
    expect(out).toHaveLength(4);
    for (const item of out) expect(item).toContain("tool libraries");
    expect(out).not.toContain("phishing drill");
  });

  it("returns distinct rewrites across successive hops so dedupe has work to do", async () => {
    const ai = fakeAiRunner();
    const inputs = { fragment: "vacant lot", target: "a physical object you can touch", count: 3, exclude: [] };
    const first = await generateRewrites(ai, "m", inputs);
    const second = await generateRewrites(ai, "m", inputs);
    expect(new Set([...first, ...second]).size).toBe(6);
  });

  it("expands a pole to a phrase instead of silently degrading", async () => {
    const pole = await expandPole(fakeAiRunner(), "m", "make strange");
    expect(pole.expanded).toBe(true);
    expect(pole.phrase).not.toBe("make strange");
    expect(pole.phrase.split(" ").length).toBeGreaterThanOrEqual(4);
  });

  it("still serves the field's bucketed pools unchanged", async () => {
    const ai = fakeAiRunner();
    const result = (await ai.run("m", {
      messages: [{ role: "user", content: `${JSON.stringify({ seed: "x", strangeness: 0.2, altitude: 0.2, count: 2 })}\nReturn a JSON array.` }],
    })) as { response: string };
    expect(JSON.parse(result.response)).toEqual(["phishing drill", "password day"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/board-rewrite.test.ts -t "board support"`
Expected: FAIL — the first test gets `"haunted inbox exhibit"` rather than a rewrite of `"tool libraries"`, which is precisely the silent-wrong-answer bug.

- [ ] **Step 3: Implement**

In `src/dev-fake-ai.ts`, replace the body of the `run` method's non-embedding branch. The existing embedding branch and `POOLS` stay untouched.

```ts
export function fakeAiRunner(): AiRunner {
  const counters = new Map<string, number>();
  return {
    async run(_model, inputs) {
      await new Promise((r) => setTimeout(r, 250)); // a little pretend latency
      if (Array.isArray(inputs.text)) {
        return { data: (inputs.text as string[]).map(pseudoEmbedding) };
      }
      const messages = inputs.messages as { content: string }[];
      const lastContent = messages[messages.length - 1]!.content;
      const firstLine = lastContent.slice(0, lastContent.indexOf("\n") === -1 ? undefined : lastContent.indexOf("\n"));
      let req: Record<string, unknown>;
      try {
        req = JSON.parse(firstLine) as Record<string, unknown>;
      } catch {
        return { response: "[]" };
      }

      // Pole expansion (generation.ts expandPole) — a bare {term} payload.
      // Without this branch every axis and every station silently degrades,
      // because the field's array response never parses as {phrase}.
      if (typeof req.term === "string") {
        return { response: JSON.stringify({ phrase: `a ${req.term} kind of thing you can point at` }) };
      }

      // Board rewrite — {fragment, target, count}. Children embed the parent
      // text so tether stays high and lineage dedupe is exercised.
      if (typeof req.fragment === "string") {
        const count = Number(req.count) || 1;
        const key = `rw:${req.fragment}`;
        let cursor = counters.get(key) ?? 0;
        const out: string[] = [];
        while (out.length < count) {
          out.push(`${req.fragment} ${cursor + 1}`);
          cursor++;
        }
        counters.set(key, cursor);
        return { response: JSON.stringify(out) };
      }

      // Field generation — the original bucketed behaviour.
      const strangeness = Number(req.strangeness);
      const altitude = Number(req.altitude);
      const count = Number(req.count) || 1;
      const tier = strangeness < 0.33 ? 0 : strangeness <= 0.66 ? 1 : 2;
      const alt = altitude >= 0.5 ? 1 : 0;
      const bucket = `w${tier}a${alt}`;
      const base = POOLS[bucket]!;
      const out: string[] = [];
      let cursor = counters.get(bucket) ?? 0;
      while (out.length < count) {
        const generation = Math.floor(cursor / base.length);
        const word = base[cursor % base.length]!;
        out.push(generation === 0 ? word : `${word} ${generation + 1}`);
        cursor++;
      }
      counters.set(bucket, cursor);
      return { response: JSON.stringify(out) };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/board-rewrite.test.ts`
Expected: PASS, 21 tests

- [ ] **Step 5: Run the gates and commit**

The field's own generation tests must be unaffected — that is what the fourth test guards.

```bash
npm test && npm run typecheck
git add src/dev-fake-ai.ts test/board-rewrite.test.ts
git commit -m "fix: teach the fake AI pole expansion and board rewrites"
```

---

### Task 5: Belt core — seeds, fan, hops, ghosts

**Files:**
- Create: `src/board/belt-core.ts`
- Test: `test/board-belt-core.test.ts`

**Interfaces:**
- Consumes: `Station`, `Card`, `Lineage`, `EvaporatedCard`, `GHOST_DEPTH`, `SEED_FANOUT`, `MAX_LINEAGES` from `src/board/types.ts`
- Produces: `class BeltCore` with `addSeed(text, now) → boolean`, `hungry() → HungryHop[]`, `applySeedFan(lineageId, children, now)`, `applyHop(lineageId, child, now)`, `lineages() → Lineage[]`, `stations() → Station[]`, `view() → BoardView`, `serialize() → BeltCoreState`

A lineage's `cards[0]` is the seed and its last card is the live head; everything between is a ghost. Ghost fade is **not** stored — the client derives it from `head - index`.

- [ ] **Step 1: Write the failing test**

Create `test/board-belt-core.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BeltCore } from "../src/board/belt-core";
import { GHOST_DEPTH, MAX_LINEAGES, SEED_FANOUT, type Station } from "../src/board/types";

function stations(n = 3): Station[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    order: i + 1,
    term: `dir ${i}`,
    phrase: `a ${i} kind of thing`,
    expanded: true,
    embedding: [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0],
  }));
}

function child(text: string) {
  return { text, embedding: [0.5, 0.5, 0] };
}

/** Drive one lineage forward `hops` times, so tests can position a head. */
function advance(belt: BeltCore, lineageId: string, hops: number, from = 1): void {
  for (let i = 0; i < hops; i++) belt.applyHop(lineageId, child(`hop ${from + i}`), 1000 + i);
}

describe("addSeed", () => {
  it("creates one lineage holding just the seed card", () => {
    const belt = new BeltCore({ stations: stations() });
    expect(belt.addSeed("urban gardening", 1000)).toBe(true);
    const [lineage] = belt.lineages();
    expect(lineage!.cards).toHaveLength(1);
    expect(lineage!.cards[0]!.text).toBe("urban gardening");
    expect(lineage!.cards[0]!.stationIndex).toBe(0);
  });

  it("refuses a seed when the board is at capacity", () => {
    const belt = new BeltCore({ stations: stations() });
    for (let i = 0; i < MAX_LINEAGES; i++) expect(belt.addSeed(`seed ${i}`, 1000)).toBe(true);
    expect(belt.addSeed("one too many", 1000)).toBe(false);
  });
});

describe("hungry", () => {
  it("reports a fresh seed as needing a fan-width first hop", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const [hop] = belt.hungry();
    expect(hop!.stationIndex).toBe(1);
    expect(hop!.count).toBe(SEED_FANOUT);
    expect(hop!.parentText).toBe("urban gardening");
  });

  it("reports a moved lineage as needing a single child", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("rooftop bee lease")], 1001);
    const [hop] = belt.hungry();
    expect(hop!.stationIndex).toBe(2);
    expect(hop!.count).toBe(1);
  });

  it("stops reporting a lineage whose head has passed the last station", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("a")], 1001);
    advance(belt, id, 2, 2);
    expect(belt.hungry()).toHaveLength(0);
  });
});

describe("applySeedFan", () => {
  it("splits one seed into a lineage per child, sharing the seed card", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("a"), child("b"), child("c")], 1001);
    const all = belt.lineages();
    expect(all).toHaveLength(3);
    for (const lineage of all) {
      expect(lineage.cards[0]!.text).toBe("urban gardening");
      expect(lineage.cards).toHaveLength(2);
    }
    expect(all.map((l) => l.cards[1]!.text).sort()).toEqual(["a", "b", "c"]);
  });

  it("takes only as many children as capacity allows", () => {
    const belt = new BeltCore({ stations: stations() });
    for (let i = 0; i < MAX_LINEAGES - 1; i++) belt.addSeed(`filler ${i}`, 1000);
    belt.addSeed("urban gardening", 1000);
    const id = belt.lineages().at(-1)!.id;
    belt.applySeedFan(id, [child("a"), child("b"), child("c")], 1001);
    expect(belt.lineages()).toHaveLength(MAX_LINEAGES);
  });
});

describe("applyHop", () => {
  it("appends the child as the new head and demotes the old head to a ghost", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("rooftop bee lease")], 1001);
    belt.applyHop(belt.lineages()[0]!.id, child("pigeon-assisted pollination"), 1002);
    const cards = belt.lineages()[0]!.cards;
    expect(cards.map((c) => c.text)).toEqual(["urban gardening", "rooftop bee lease", "pigeon-assisted pollination"]);
    expect(cards.at(-1)!.stationIndex).toBe(2);
  });

  it("resets the failure counter on a successful hop", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("x", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("a")], 1001);
    const live = belt.lineages()[0]!.id;
    belt.noteHopFailure(live, 1002);
    belt.applyHop(live, child("b"), 1003);
    expect(belt.lineages()[0]!.failures).toBe(0);
  });
});

describe("view", () => {
  // NOTE: this substring form is WRONG and was replaced during implementation.
  // A card whose text contains the word "embedding" fails it with nothing
  // leaked, which is plausible on a board of LLM-generated fragments. The
  // shipped version walks keys structurally via a `keysDeep` helper, and is
  // paired with a companion test asserting keysDeep(serialize()) DOES contain
  // "embedding" — without that, the guard could pass vacuously.
  it("never puts an embedding on the wire", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("word embedding tricks", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("a")], 1001);
    expect(keysDeep(belt.view())).not.toContain("embedding");
  });

  it("trims ghosts beyond GHOST_DEPTH behind the head", () => {
    const belt = new BeltCore({ stations: stations(6) });
    belt.addSeed("seed", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("a")], 1001);
    advance(belt, belt.lineages()[0]!.id, 4, 2);
    const cards = belt.view().lineages[0]!.cards;
    expect(cards).toHaveLength(GHOST_DEPTH + 1);
    expect(cards.at(-1)!.text).toBe("hop 5");
  });

  it("reports a station's degraded flag so a bare pole stays visible", () => {
    const degraded = stations(1);
    degraded[0]!.expanded = false;
    const belt = new BeltCore({ stations: degraded });
    expect(belt.view().stations[0]!.degraded).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/board-belt-core.test.ts`
Expected: FAIL — `Failed to resolve import "../src/board/belt-core"`

- [ ] **Step 3: Implement**

Create `src/board/belt-core.ts`:

```ts
// Pure belt logic for one board session: lineages, the seed fan, hops, ghost
// trimming, capacity, edge eviction. No bindings, no storage, no I/O — BoardDO
// hydrates and persists this, exactly as SessionDO does for PoolCore.

import {
  EDGE_DWELL_MS,
  EVAPORATED_CAP,
  GHOST_DEPTH,
  MAX_HOP_FAILURES,
  MAX_LINEAGES,
  SEED_FANOUT,
  type Card,
  type EvaporatedCard,
  type Lineage,
  type Station,
} from "./types";

export interface BeltCoreState {
  stations: Station[];
  lineages: Lineage[];
  evaporated: EvaporatedCard[];
}

/** One hop the DO should generate for. `count` is SEED_FANOUT on a lineage's
 *  first hop so a single seed produces motion from one call. */
export interface HungryHop {
  lineageId: string;
  parentText: string;
  parentEmbedding: number[] | null;
  stationIndex: number;
  count: number;
}

export interface CardView {
  id: string;
  text: string;
  stationIndex: number;
}

export interface LineageView {
  id: string;
  cards: CardView[];
  arrived: boolean;
  atEdge: boolean;
}

export interface StationView {
  id: string;
  order: number;
  term: string;
  phrase: string;
  degraded: boolean;
  ready: boolean;
}

export interface BoardView {
  stations: StationView[];
  lineages: LineageView[];
  evaporated: EvaporatedCard[];
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}${idCounter}`;
}

export class BeltCore {
  private stationList: Station[];
  private lineageList: Lineage[];
  private evaporatedList: EvaporatedCard[];

  constructor(state?: Partial<BeltCoreState>) {
    this.stationList = [...(state?.stations ?? [])].sort((a, b) => a.order - b.order);
    this.lineageList = [...(state?.lineages ?? [])];
    this.evaporatedList = [...(state?.evaporated ?? [])];
  }

  stations(): Station[] {
    return this.stationList.map((s) => ({ ...s }));
  }

  lineages(): Lineage[] {
    return this.lineageList.map((l) => ({ ...l, cards: l.cards.map((c) => ({ ...c })) }));
  }

  evaporated(): EvaporatedCard[] {
    return this.evaporatedList.map((e) => ({ ...e }));
  }

  setStationEmbedding(id: string, embedding: number[]): void {
    const station = this.stationList.find((s) => s.id === id);
    if (station) station.embedding = embedding;
  }

  /** Admit a seed, unless the board is at its legibility cap. */
  addSeed(text: string, now: number): boolean {
    if (this.lineageList.length >= MAX_LINEAGES) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    this.lineageList.push({
      id: nextId("l"),
      seedText: trimmed,
      cards: [{ id: nextId("c"), text: trimmed, stationIndex: 0, bornAt: now, embedding: null }],
      failures: 0,
      arrivedAt: null,
      edgeAt: null,
    });
    return true;
  }

  /** Lineages that need their next card. A lineage still sitting on its seed
   *  asks for SEED_FANOUT children; every later hop asks for one. */
  hungry(): HungryHop[] {
    const out: HungryHop[] = [];
    for (const lineage of this.lineageList) {
      if (lineage.arrivedAt !== null || lineage.edgeAt !== null) continue;
      const head = lineage.cards.at(-1)!;
      if (head.stationIndex >= this.stationList.length) continue;
      out.push({
        lineageId: lineage.id,
        parentText: head.text,
        parentEmbedding: head.embedding,
        stationIndex: head.stationIndex + 1,
        count: lineage.cards.length === 1 ? SEED_FANOUT : 1,
      });
    }
    return out;
  }

  /** Split a seed lineage into one lineage per child, each keeping a copy of
   *  the seed card so every row still reads from its origin. */
  applySeedFan(lineageId: string, children: { text: string; embedding: number[] }[], now: number): void {
    const index = this.lineageList.findIndex((l) => l.id === lineageId);
    if (index === -1 || children.length === 0) return;
    const original = this.lineageList[index]!;
    const seedCard = original.cards[0]!;
    const room = MAX_LINEAGES - this.lineageList.length + 1; // the original's slot is reusable
    const admitted = children.slice(0, Math.max(1, room));
    const spawned: Lineage[] = admitted.map((child) => ({
      id: nextId("l"),
      seedText: original.seedText,
      cards: [
        { ...seedCard, id: nextId("c") },
        { id: nextId("c"), text: child.text, stationIndex: 1, bornAt: now, embedding: child.embedding },
      ],
      failures: 0,
      arrivedAt: null,
      edgeAt: null,
    }));
    this.lineageList.splice(index, 1, ...spawned);
  }

  /** Append a child as the new head. The old head becomes a ghost simply by
   *  no longer being last — nothing about the fade is stored. */
  applyHop(lineageId: string, child: { text: string; embedding: number[] }, now: number): void {
    const lineage = this.lineageList.find((l) => l.id === lineageId);
    if (!lineage) return;
    const head = lineage.cards.at(-1)!;
    lineage.cards.push({
      id: nextId("c"),
      text: child.text,
      stationIndex: head.stationIndex + 1,
      bornAt: now,
      embedding: child.embedding,
    });
    lineage.failures = 0;
  }

  noteHopFailure(lineageId: string, now: number): void {
    const lineage = this.lineageList.find((l) => l.id === lineageId);
    if (!lineage) return;
    lineage.failures += 1;
    if (lineage.failures >= MAX_HOP_FAILURES) lineage.edgeAt = now;
  }

  markArrived(lineageId: string, now: number): void {
    const lineage = this.lineageList.find((l) => l.id === lineageId);
    if (lineage) lineage.arrivedAt = now;
  }

  /** Client projection. Embeddings are absent by construction — this is the
   *  only path to the wire, so there is nowhere for one to leak through. */
  view(): BoardView {
    return {
      stations: this.stationList.map((s) => ({
        id: s.id,
        order: s.order,
        term: s.term,
        phrase: s.phrase,
        degraded: !s.expanded,
        ready: s.embedding !== null,
      })),
      lineages: this.lineageList.map((l) => ({
        id: l.id,
        cards: l.cards.slice(-(GHOST_DEPTH + 1)).map((c) => ({ id: c.id, text: c.text, stationIndex: c.stationIndex })),
        arrived: l.arrivedAt !== null,
        atEdge: l.edgeAt !== null,
      })),
      evaporated: this.evaporated(),
    };
  }

  serialize(): BeltCoreState {
    return { stations: this.stations(), lineages: this.lineages(), evaporated: this.evaporated() };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/board-belt-core.test.ts`
Expected: PASS, 12 tests

- [ ] **Step 5: Run the gates and commit**

```bash
npm test && npm run typecheck
git add src/board/belt-core.ts test/board-belt-core.test.ts
git commit -m "feat: add the belt core with seed fan, hops and ghost trimming"
```

---

### Task 6: Belt core — edge eviction and the ephemerality guard

**Files:**
- Modify: `src/board/belt-core.ts`
- Test: `test/board-belt-core.test.ts`

**Interfaces:**
- Produces: `BeltCore.tick(now) → void`, plus the `edgeAt` transition when a head passes the last station

- [ ] **Step 1: Write the failing test**

Append to `test/board-belt-core.test.ts`:

```ts
import { EDGE_DWELL_MS, EVAPORATED_CAP, MAX_HOP_FAILURES } from "../src/board/types";

describe("tick", () => {
  function atEnd(): { belt: BeltCore; id: string } {
    const belt = new BeltCore({ stations: stations(1) });
    belt.addSeed("urban gardening", 1000);
    belt.applySeedFan(belt.lineages()[0]!.id, [child("rooftop bee lease")], 1001);
    return { belt, id: belt.lineages()[0]!.id };
  }

  it("sends a head that has passed the last station to the edge", () => {
    const { belt } = atEnd();
    belt.tick(2000);
    expect(belt.lineages()[0]!.edgeAt).toBe(2000);
  });

  it("keeps the lineage readable for the whole dwell", () => {
    const { belt } = atEnd();
    belt.tick(2000);
    belt.tick(2000 + EDGE_DWELL_MS - 1);
    expect(belt.lineages()).toHaveLength(1);
  });

  it("evicts the lineage once the dwell elapses", () => {
    const { belt } = atEnd();
    belt.tick(2000);
    belt.tick(2000 + EDGE_DWELL_MS);
    expect(belt.lineages()).toHaveLength(0);
  });

  it("records the evicted head in the evaporated ring", () => {
    const { belt } = atEnd();
    belt.tick(2000);
    belt.tick(2000 + EDGE_DWELL_MS);
    expect(belt.evaporated()[0]!.text).toBe("rooftop bee lease");
  });

  it("caps the evaporated ring", () => {
    const belt = new BeltCore({ stations: stations(1) });
    for (let i = 0; i < EVAPORATED_CAP + 3; i++) {
      belt.addSeed(`seed ${i}`, 1000);
      const id = belt.lineages().at(-1)!.id;
      belt.applySeedFan(id, [child(`child ${i}`)], 1001);
      belt.tick(2000);
      belt.tick(2000 + EDGE_DWELL_MS);
    }
    expect(belt.evaporated()).toHaveLength(EVAPORATED_CAP);
  });

  it("releases a lineage that has failed its hop too many times", () => {
    const belt = new BeltCore({ stations: stations(3) });
    belt.addSeed("stuck", 1000);
    const id = belt.lineages()[0]!.id;
    belt.applySeedFan(id, [child("a")], 1001);
    const live = belt.lineages()[0]!.id;
    for (let i = 0; i < MAX_HOP_FAILURES; i++) belt.noteHopFailure(live, 1002);
    belt.tick(2000 + EDGE_DWELL_MS);
    expect(belt.lineages()).toHaveLength(0);
  });

  it("stores no card text anywhere once a lineage is evicted, beyond the ring", () => {
    const { belt } = atEnd();
    belt.tick(2000);
    belt.tick(2000 + EDGE_DWELL_MS);
    const dump = JSON.stringify(belt.serialize());
    // The seed's own text is gone with the lineage; only the head survives,
    // in the evaporated ring, which is the one sanctioned mercy.
    expect(dump).not.toContain("urban gardening");
    expect(belt.evaporated().map((e) => e.text)).toEqual(["rooftop bee lease"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/board-belt-core.test.ts -t "tick"`
Expected: FAIL — `belt.tick is not a function`

- [ ] **Step 3: Implement**

Add to `src/board/belt-core.ts`, inside the class after `markArrived`:

```ts
  /** Advance time: park finished heads at the edge, then evict the ones whose
   *  dwell has elapsed. An evicted head's text goes to the evaporated ring —
   *  the only thing that outlives a lineage. Everything else is gone, which is
   *  the ephemerality premise (SPEC.md) holding for this surface. */
  tick(now: number): void {
    for (const lineage of this.lineageList) {
      if (lineage.edgeAt !== null) continue;
      const head = lineage.cards.at(-1)!;
      const finished = head.stationIndex >= this.stationList.length || lineage.arrivedAt !== null;
      if (finished) lineage.edgeAt = now;
    }

    const survivors: Lineage[] = [];
    for (const lineage of this.lineageList) {
      if (lineage.edgeAt !== null && now - lineage.edgeAt >= EDGE_DWELL_MS) {
        this.evaporatedList.unshift({ text: lineage.cards.at(-1)!.text, evaporatedAt: now });
        continue;
      }
      survivors.push(lineage);
    }
    this.lineageList = survivors;
    if (this.evaporatedList.length > EVAPORATED_CAP) this.evaporatedList.length = EVAPORATED_CAP;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/board-belt-core.test.ts`
Expected: PASS, 19 tests

- [ ] **Step 5: Run the gates and commit**

```bash
npm test && npm run typecheck
git add src/board/belt-core.ts test/board-belt-core.test.ts
git commit -m "feat: evict finished lineages at the edge into the evaporated ring"
```

---

### Task 7: BoardDO, routing and the wire-format guard

**Files:**
- Create: `src/board/board-do.ts`
- Modify: `src/index.ts`
- Modify: `wrangler.jsonc`
- Test: `test/board-api.test.ts`

**Interfaces:**
- Consumes: `BeltCore`, `generateRewrites`, `selectChild`, `hasArrived`, `expandPole`, `embedTexts`
- Produces: `BoardDO` with `init(id) → BoardView`, `getView() → BoardView | null`, `seed(text) → BoardView | null`; routes `POST /api/board`, `GET /api/board/:id`, `POST /api/board/:id/seed`

`src/index.ts` already routes `/api/*` worker-first, so no `wrangler.jsonc` routing change is needed — only the new binding and migration tag. **The existing `v1` tag must not be edited.**

- [ ] **Step 1: Write the failing test**

Create `test/board-api.test.ts`. This mirrors `test/api-axes.test.ts`'s approach of testing the route table without a Workers runtime.

```ts
import { describe, expect, it } from "vitest";
import { BeltCore } from "../src/board/belt-core";
import { DEFAULT_STATION_TERMS, type Station } from "../src/board/types";

function readyStations(): Station[] {
  return DEFAULT_STATION_TERMS.map((term, i) => ({
    id: `s${i}`,
    order: i + 1,
    term,
    phrase: `a ${term} kind of thing`,
    expanded: true,
    embedding: [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0],
  }));
}

describe("board wire format", () => {
  it("ships three default stations", () => {
    expect(new BeltCore({ stations: readyStations() }).view().stations).toHaveLength(3);
  });

  it("carries the expanded phrase, which is what the user edits and what gets embedded", () => {
    const [first] = new BeltCore({ stations: readyStations() }).view().stations;
    expect(first!.term).toBe("concretize");
    expect(first!.phrase).not.toBe("concretize");
  });

  // A substring match on JSON.stringify was the FIRST version of this guard and
  // it is wrong: a card whose text contains the word "embedding" — entirely
  // plausible on a board of LLM-generated idea fragments — fails it with
  // nothing leaked. Node N5 replaced it with a structural key walk; reuse that
  // helper here rather than reintroducing the substring check.
  it("contains no embedding key anywhere, at any depth", () => {
    const belt = new BeltCore({ stations: readyStations() });
    belt.addSeed("word embedding tricks", 1000); // the input that broke the old guard
    belt.applySeedFan(belt.lineages()[0]!.id, [{ text: "rooftop bee lease", embedding: [1, 0, 0] }], 1001);
    const view = belt.view();
    expect(keysDeep(view)).not.toContain("embedding");
    expect(JSON.stringify(view)).toContain("rooftop bee lease");
  });

  it("marks a station not ready while its pole is still being embedded", () => {
    const pending = readyStations();
    pending[1]!.embedding = null;
    const view = new BeltCore({ stations: pending }).view();
    expect(view.stations[1]!.ready).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/board-api.test.ts`
Expected: FAIL — `Failed to resolve import "../src/board/types"` is already satisfied by Task 1, so this fails on the assertion that `phrase` differs from `term` only if stations are wired wrong. If all four pass immediately, that is correct — Tasks 1 and 5 already provide the behaviour; proceed to Step 3, which is where the new code lives.

- [ ] **Step 3: Write `src/board/board-do.ts`**

```ts
// Thin stateful shell for one board session. All belt logic lives in
// BeltCore and all scoring in rewrite.ts; this file does storage, the alarm
// loop, and the AI calls — mirroring how SessionDO wraps PoolCore.

import { DurableObject } from "cloudflare:workers";
import { fakeAiRunner } from "../dev-fake-ai";
import { embedTexts, expandPole, type AiRunner } from "../generation";
import { BeltCore, type BoardView } from "./belt-core";
import { generateRewrites, hasArrived, selectChild } from "./rewrite";
import { CANDIDATES_PER_HOP, DEFAULT_STATION_TERMS, type Station } from "./types";

const PUMP_MS = 500;

export class BoardDO extends DurableObject<Env> {
  private belt!: BeltCore;
  private ready = false;
  private pumping = false;
  private devFakeAi: AiRunner | null = null;

  private aiRunner(): AiRunner {
    if ((this.env as { DEV_FAKE_AI?: string }).DEV_FAKE_AI !== "1") return this.env.AI as unknown as AiRunner;
    this.devFakeAi ??= fakeAiRunner();
    return this.devFakeAi;
  }

  private async load(): Promise<void> {
    if (this.ready) return;
    const state = await this.ctx.storage.get<ReturnType<BeltCore["serialize"]>>("belt");
    this.belt = new BeltCore(state ?? {});
    this.ready = true;
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put("belt", this.belt.serialize());
  }

  /** Create the session with the three default stations. Pole expansion runs
   *  in the background: a station without an embedding is reported not-ready
   *  and holds its lineages rather than falling through to unscored
   *  selection, which would be indistinguishable from working. */
  async init(): Promise<BoardView> {
    await this.load();
    if (this.belt.stations().length === 0) {
      const stations: Station[] = DEFAULT_STATION_TERMS.map((term, i) => ({
        id: `s${i + 1}`,
        order: i + 1,
        term,
        phrase: term,
        expanded: false,
        embedding: null,
      }));
      this.belt = new BeltCore({ ...this.belt.serialize(), stations });
      await this.save();
      void this.ctx.waitUntil(this.prepareStations());
    }
    await this.schedulePump();
    return this.belt.view();
  }

  async getView(): Promise<BoardView | null> {
    await this.load();
    if (this.belt.stations().length === 0) return null;
    this.belt.tick(Date.now());
    await this.save();
    await this.schedulePump();
    return this.belt.view();
  }

  /** `addSeed` returns false when the board is at MAX_LINEAGES. That boolean
   *  MUST be honoured and surfaced: the first draft of this method discarded
   *  it, which made a full board answer 200 with an unchanged view — the typed
   *  word simply vanished with no error, no status and nothing for the client
   *  to react to. Silent no-op on a user's direct action is worse than an
   *  error, and it is invisible to `if (!res.ok)`. */
  async seed(text: string): Promise<{ view: BoardView; accepted: boolean } | null> {
    await this.load();
    if (this.belt.stations().length === 0) return null;
    const accepted = this.belt.addSeed(text, Date.now());
    await this.save();
    await this.schedulePump();
    return { view: this.belt.view(), accepted };
  }

  /** Expand each default term to a descriptive phrase and embed it. A bare
   *  term costs ~0.34 AUC to polysemy, so a station that fails expansion stays
   *  flagged degraded rather than passing as normal. */
  private async prepareStations(): Promise<void> {
    const ai = this.aiRunner();
    const model = this.env.GEN_MODEL as string;
    for (const station of this.belt.stations()) {
      try {
        const expanded = await expandPole(ai, model, station.term);
        const [embedding] = await embedTexts(ai, this.env.EMBED_MODEL as string, [expanded.phrase]);
        const current = this.belt.serialize();
        const target = current.stations.find((s) => s.id === station.id);
        if (target) {
          target.phrase = expanded.phrase;
          target.expanded = expanded.expanded;
          target.embedding = embedding ?? null;
        }
        this.belt = new BeltCore(current);
        await this.save();
      } catch (error) {
        console.error(JSON.stringify({ level: "error", message: "station prepare failed", station: station.term, error: String(error) }));
      }
    }
  }

  private async schedulePump(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) await this.ctx.storage.setAlarm(Date.now() + PUMP_MS);
  }

  async alarm(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      await this.load();
      this.belt.tick(Date.now());
      await this.pumpOnce();
      await this.save();
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: "board pump failed", error: String(error) }));
    } finally {
      this.pumping = false;
      await this.ctx.storage.setAlarm(Date.now() + PUMP_MS);
    }
  }

  /** One hop for one hungry lineage per tick. Errors are contained here: an
   *  embedding or generation failure abandons the hop and must never escape
   *  into alarm(), which would freeze the whole board. */
  private async pumpOnce(): Promise<void> {
    const stations = this.belt.stations();
    const hop = this.belt.hungry()[0];
    if (!hop) return;
    const station = stations[hop.stationIndex - 1];
    if (!station || station.embedding === null) return; // hold, do not guess

    const ai = this.aiRunner();
    try {
      let parentEmb = hop.parentEmbedding;
      if (parentEmb === null) {
        [parentEmb] = await embedTexts(ai, this.env.EMBED_MODEL as string, [hop.parentText]);
        if (!parentEmb) return;
      }

      if (hasArrived(parentEmb, station.embedding)) {
        this.belt.markArrived(hop.lineageId, Date.now());
        return;
      }

      const lineage = this.belt.lineages().find((l) => l.id === hop.lineageId);
      const history = (lineage?.cards ?? []).map((c) => c.embedding).filter((e): e is number[] => e !== null);
      const texts = await generateRewrites(ai, this.env.GEN_MODEL as string, {
        fragment: hop.parentText,
        target: station.phrase,
        count: hop.count === 1 ? CANDIDATES_PER_HOP : CANDIDATES_PER_HOP,
        exclude: (lineage?.cards ?? []).map((c) => c.text),
      });
      if (texts.length === 0) {
        this.belt.noteHopFailure(hop.lineageId, Date.now());
        return;
      }

      const vecs = await embedTexts(ai, this.env.EMBED_MODEL as string, texts);
      const candidates = texts.map((text, i) => ({ text, embedding: vecs[i]! }));

      if (hop.count > 1) {
        const chosen: { text: string; embedding: number[] }[] = [];
        const exclude = [...history];
        for (let i = 0; i < hop.count; i++) {
          const pick = selectChild(parentEmb, station.embedding, candidates.filter((c) => !chosen.includes(c)), { exclude });
          if (!pick) break;
          chosen.push({ text: pick.text, embedding: pick.embedding });
          exclude.push(pick.embedding);
        }
        if (chosen.length === 0) {
          this.belt.noteHopFailure(hop.lineageId, Date.now());
          return;
        }
        this.belt.applySeedFan(hop.lineageId, chosen, Date.now());
        return;
      }

      const pick = selectChild(parentEmb, station.embedding, candidates, { exclude: history });
      if (!pick) {
        this.belt.noteHopFailure(hop.lineageId, Date.now());
        return;
      }
      this.belt.applyHop(hop.lineageId, { text: pick.text, embedding: pick.embedding }, Date.now());
    } catch (error) {
      console.error(JSON.stringify({ level: "error", message: "hop failed", error: String(error) }));
      this.belt.noteHopFailure(hop.lineageId, Date.now());
    }
  }
}
```

- [ ] **Step 4: Wire the binding and migration**

In `wrangler.jsonc`, replace the `durable_objects` and `migrations` blocks:

```jsonc
  "durable_objects": {
    "bindings": [
      { "name": "SESSION_DO", "class_name": "SessionDO" },
      { "name": "BOARD_DO", "class_name": "BoardDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["SessionDO"] },
    { "tag": "v2", "new_sqlite_classes": ["BoardDO"] }
  ],
```

- [ ] **Step 5: Add the routes**

In `src/index.ts`, add the export beside the existing one:

```ts
export { BoardDO } from "./board/board-do";
```

Then, inside `handleApi`, immediately before the line `const match = path.match(/^\/api\/session\/([^/]+)(\/.*)?$/);`:

```ts
  if (path === "/api/board" && method === "POST") {
    const id = crypto.randomUUID();
    const view = await env.BOARD_DO.getByName(id).init();
    return json({ id, ...view }, 201);
  }

  const boardMatch = path.match(/^\/api\/board\/([^/]+)(\/.*)?$/);
  if (boardMatch) {
    const [, boardId, boardRest = ""] = boardMatch;
    if (!boardId || !UUID_RE.test(boardId)) return badRequest("invalid board id");
    const board = env.BOARD_DO.getByName(boardId);

    if (boardRest === "" && method === "GET") {
      const view = await board.getView();
      return view ? json(view) : json({ error: "no such board" }, 404);
    }

    if (boardRest === "/seed" && method === "POST") {
      const body = await readBody(request);
      if (!body) return badRequest("expected a JSON object body");
      const text = parseText(body);
      if (!text) return badRequest(`text must be a non-empty string of at most ${MAX_TEXT_CHARS} characters`);
      const result = await board.seed(text);
      if (!result) return json({ error: "no such board" }, 404);
      // 409, not 200, when the board is at MAX_LINEAGES. The client cannot
      // distinguish "accepted" from "silently dropped" if both answer 200 with
      // a view, and the seed the user typed would just disappear. The view is
      // still returned so the client can repaint without a follow-up GET —
      // same pattern as the axes route's 409/422 responses in this file.
      if (!result.accepted) return json({ error: "the board is full", ...result.view }, 409);
      return json(result.view);
    }

    return json({ error: "not found" }, 404);
  }
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm run typecheck && npm test`

`npm run typecheck` regenerates `worker-configuration.d.ts` first, which is what teaches `Env` about `BOARD_DO`. Run it **before** `tsc` complains — the script already does this in the right order.

Expected: typecheck clean, `test/board-api.test.ts` 4 passing.

- [ ] **Step 7: Commit**

```bash
git add src/board/board-do.ts src/index.ts wrangler.jsonc test/board-api.test.ts
git commit -m "feat: serve the board behind BoardDO and /api/board"
```

---

### Task 8: The client

**Files:**
- Create: `public/board/index.html`
- Create: `public/board/board.js`
- Create: `public/board/belt-render.js`
- Create: `public/board/styles.css`

**Interfaces:**
- Consumes: `POST /api/board`, `GET /api/board/:id`, `POST /api/board/:id/seed`
- Produces: a rendered board at `/board`

Rows are lineages, columns are stations. A card's column is its `stationIndex`; ghost opacity is derived from its distance behind the head, **client-side** — the server ships no fade.

- [ ] **Step 1: Write the renderer**

Create `public/board/belt-render.js`:

```js
// Rendering only. Rows are lineages, columns are stations, and a card's
// position is its stationIndex. Ghost fade is derived here from distance
// behind the head — the server never ships an opacity.

const GHOST_OPACITY = [1, 0.5, 0.34, 0.2];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  // textContent, never innerHTML: card text is model output (CLAUDE.md).
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderStations(headerRow, stations) {
  headerRow.replaceChildren();
  headerRow.appendChild(el("div", "lane-head seed", "Seed · yours"));
  for (const station of stations) {
    const head = el("div", "lane-head");
    head.appendChild(el("span", "station-term", station.term));
    const phrase = el("span", "station-phrase", station.phrase);
    if (station.degraded) phrase.classList.add("degraded");
    head.appendChild(phrase);
    if (!station.ready) head.classList.add("pending");
    headerRow.appendChild(head);
  }
  headerRow.appendChild(el("div", "lane-head edge", "Edge"));
}

export function renderLineages(belt, view) {
  belt.replaceChildren();
  const columns = view.stations.length + 2;
  belt.style.setProperty("--columns", String(columns));
  for (const lineage of view.lineages) {
    const head = lineage.cards[lineage.cards.length - 1];
    for (const card of lineage.cards) {
      const behind = head.stationIndex - card.stationIndex;
      const node = el("div", "kcard", card.text);
      node.style.gridColumn = String(card.stationIndex + 1);
      node.style.opacity = String(GHOST_OPACITY[Math.min(behind, GHOST_OPACITY.length - 1)]);
      if (behind > 0) node.classList.add("ghost");
      if (lineage.arrived && behind === 0) node.classList.add("arrived");
      if (lineage.atEdge && behind === 0) node.classList.add("dying");
      belt.appendChild(node);
    }
  }
}

export function renderEvaporated(list, evaporated) {
  list.replaceChildren();
  for (const ghost of evaporated) list.appendChild(el("li", "ghost-item", ghost.text));
}
```

- [ ] **Step 2: Write the client**

Create `public/board/board.js`:

```js
import { renderEvaporated, renderLineages, renderStations } from "./belt-render.js";

const POLL_MS = 900;

const headerRow = document.getElementById("stations");
const belt = document.getElementById("belt");
const ghosts = document.getElementById("ghosts");
const form = document.getElementById("seed-form");
const input = document.getElementById("seed-input");

let boardId = null;

function paint(view) {
  renderStations(headerRow, view.stations);
  renderLineages(belt, view);
  renderEvaporated(ghosts, view.evaporated);
}

async function start() {
  const res = await fetch("/api/board", { method: "POST" });
  const view = await res.json();
  boardId = view.id;
  history.replaceState(null, "", `#${boardId}`);
  paint(view);
  poll();
}

async function poll() {
  if (!boardId) return;
  try {
    const res = await fetch(`/api/board/${boardId}`);
    if (res.ok) paint(await res.json());
  } catch {
    // A dropped poll is not an error state — the next tick repaints.
  }
  setTimeout(poll, POLL_MS);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || !boardId) return;
  input.value = "";
  const res = await fetch(`/api/board/${boardId}/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (res.ok) paint(await res.json());
});

start();
```

- [ ] **Step 3: Write the shell and styles**

Create `public/board/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>dewpt · board</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <header>
      <h1>board</h1>
      <p class="subtitle">Seed a word. Watch it get cooked, station by station, until it blows off the edge.</p>
    </header>
    <form id="seed-form">
      <input id="seed-input" type="text" maxlength="64" placeholder="a topic, a phrase…" autocomplete="off" />
      <button type="submit">condense</button>
    </form>
    <div id="stations" class="board-row"></div>
    <div id="belt" class="board-row belt"></div>
    <section class="ghosts">
      <h2>evaporated</h2>
      <ul id="ghosts"></ul>
    </section>
    <script type="module" src="./board.js"></script>
  </body>
</html>
```

Create `public/board/styles.css`:

```css
:root { --ink: #f2f1ed; --ground: #0b0a09; --rule: rgba(242, 241, 237, 0.28); }
* { box-sizing: border-box; }
body { margin: 0; padding: 28px clamp(16px, 4vw, 48px); background: var(--ground); color: var(--ink);
       font: 15px/1.5 ui-sans-serif, system-ui, sans-serif; min-height: 100dvh; }
h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: 0.02em; }
.subtitle { margin: 0 0 22px; opacity: 0.6; font-size: 13px; }
#seed-form { display: flex; gap: 8px; margin-bottom: 26px; }
#seed-input { flex: 1; max-width: 320px; min-height: 44px; padding: 0 12px; background: transparent;
              border: 1px solid var(--rule); border-radius: 3px; color: inherit; font: inherit; }
#seed-form button { min-height: 44px; padding: 0 18px; background: transparent; border: 1px solid var(--rule);
                    border-radius: 3px; color: inherit; font: inherit; cursor: pointer; }

.board-row { display: grid; grid-template-columns: repeat(var(--columns, 5), minmax(0, 1fr)); gap: 8px 10px; }
.lane-head { display: flex; flex-direction: column; gap: 2px; padding-bottom: 7px; margin-bottom: 10px;
             border-bottom: 1px solid var(--rule); }
.station-term { font: 600 10px/1.4 ui-monospace, Menlo, monospace; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.62; }
.station-phrase { font-size: 11px; opacity: 0.42; font-style: italic; }
.station-phrase.degraded { color: #d98555; opacity: 0.85; font-style: normal; }
.lane-head.pending { opacity: 0.45; }
.lane-head.edge { opacity: 0.36; }

.kcard { border: 1px solid var(--rule); border-radius: 3px; padding: 8px 10px; font-size: 13px;
         background: rgba(242, 241, 237, 0.07); transition: opacity 0.6s cubic-bezier(0.22, 1, 0.36, 1),
         transform 0.6s cubic-bezier(0.22, 1, 0.36, 1); }
.kcard.ghost { border-style: dashed; background: transparent; }
.kcard.arrived { border-color: rgba(217, 133, 85, 0.8); }
.kcard.dying { font-style: italic; }

.ghosts { margin-top: 28px; border-top: 1px solid var(--rule); padding-top: 12px; }
.ghosts h2 { font: 600 9px/1 ui-monospace, Menlo, monospace; letter-spacing: 0.13em; text-transform: uppercase; opacity: 0.5; }
.ghosts ul { list-style: none; padding: 0; margin: 10px 0 0; display: flex; flex-wrap: wrap; gap: 8px; }
.ghost-item { font-size: 12px; opacity: 0.42; }

/* The drift IS the belt here, so reduced motion becomes step-only. */
@media (prefers-reduced-motion: reduce) {
  .kcard { transition: none; }
}
```

- [ ] **Step 4: Verify in the browser**

Run the dev server through the preview tooling (never `wrangler dev` in a raw shell), with `DEV_FAKE_AI=1` in `.dev.vars` so no Workers AI call is needed.

Confirm, in order:
1. `/board` loads with three station headers.
2. Each header's phrase differs from its term (pole expansion ran).
3. Seeding a word produces 2–3 rows within a few seconds.
4. Rows advance rightward, leaving progressively fainter cards behind.
5. Heads reaching the last column pause, then disappear into `evaporated`.
6. The browser console is free of errors.

- [ ] **Step 5: Commit**

```bash
git add public/board
git commit -m "feat: render the conveyor board"
```

---

### Task 9: Guards and final gates

**Files:**
- Test: `test/board-belt-core.test.ts`
- Test: `test/board-api.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces: the three cross-cutting regression guards the spec names

- [ ] **Step 1: Write the failing tests**

Append to `test/board-api.test.ts`:

```ts
import { BeltCore as Belt } from "../src/board/belt-core";
import { MAX_LINEAGES as CAP } from "../src/board/types";

describe("guards", () => {
  it("never blocks: a view is available while every lineage still awaits its first hop", () => {
    const belt = new Belt({ stations: readyStations() });
    belt.addSeed("urban gardening", 1000);
    const view = belt.view();
    expect(view.lineages).toHaveLength(1);
    expect(view.lineages[0]!.cards[0]!.text).toBe("urban gardening");
  });

  it("holds a lineage rather than guessing when its station is unembedded", () => {
    const pending = readyStations();
    pending[0]!.embedding = null;
    const belt = new Belt({ stations: pending });
    belt.addSeed("urban gardening", 1000);
    // hungry() still reports it; the DO is what declines to act. The guard is
    // that the view stays serviceable either way.
    expect(belt.hungry()).toHaveLength(1);
    expect(belt.view().stations[0]!.ready).toBe(false);
  });

  it("holds the board at its legibility cap however many seeds arrive", () => {
    const belt = new Belt({ stations: readyStations() });
    for (let i = 0; i < CAP * 2; i++) belt.addSeed(`seed ${i}`, 1000);
    expect(belt.lineages().length).toBeLessThanOrEqual(CAP);
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `npx vitest run test/board-api.test.ts`
Expected: PASS. These assert behaviour Tasks 5–7 already built; they exist so a later change cannot remove it silently. If any fails, the guard has found a real regression — fix the source, not the test.

- [ ] **Step 3: Run the full gates**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all suites pass. **Report the counts explicitly** — for example "258 passing, 0 failing" — never "tests pass".

- [ ] **Step 4: Verify against live Workers AI**

`DEV_FAKE_AI` proves the machinery, not the output. Remove `DEV_FAKE_AI=1` from `.dev.vars` and reload `/board`.

If nothing generates, probe before debugging app code:

```bash
curl -s localhost:8787/api/debug/ai
```

`{"ok":true,…}` means the binding is fine and the bug is in the board. `{"ok":false,…}` almost always means WARP is intercepting workerd's egress — pause it. See CLAUDE.md.

Confirm the rewrites are genuine rewrites: a row's cards should stay recognisably about the seed while changing character. If they read as unrelated fragments, that is open question 1 in the spec resolving badly, and it needs reporting rather than patching.

- [ ] **Step 5: Commit**

```bash
git add test/board-api.test.ts
git commit -m "test: guard the board's never-blocks, hold-on-unready and capacity rules"
```

- [ ] **Step 6: Open the PR**

```bash
git push -u origin claude/dewpt-companion-ui-90ff41
gh pr create --title "feat: conveyor board M0 + M1" --body "$(cat <<'BODY'
Implements M0 and M1 of docs/superpowers/specs/2026-08-08-conveyor-board-design.md.

M0 calibrated TETHER_FLOOR, ARRIVAL_COSINE and CANDIDATES_PER_HOP via
`npm run board-calibrate`; the measured separation AUC is recorded in
src/board/types.ts.

M1 ships the belt: seed a word, it fans into 2-3 lineages, each is rewritten
at three fixed stations leaving a fading ghost trail, and heads evaporate at
the edge. No rename and no pin yet - those are M2 and M3.

Also fixes a latent bug in src/dev-fake-ai.ts: it parsed every non-embedding
request as a field generation, so pole expansion silently degraded and a board
rewrite would have returned security-awareness words instead of failing.

<!-- paste the `npm test` and `npm run typecheck` output here -->
BODY
)"
```

**Do not merge without explicit approval.**

---

## Self-Review

**Spec coverage.** Every M0 and M1 requirement maps to a task: calibration → 2; scoring rule with the parent as negative pole → 1; rewrite prompt → 3; seed fan → 5; ghost trail → 5; capacity cap → 5; edge eviction and the evaporated ring → 6; arrival → 6/7; 3-strike release → 6; hold-on-unready-station → 7; `/board` route and DO → 7; reduced motion → 8; the wire-format, ephemerality and never-blocks guards → 5/6/9. M2–M4 (rename cascade, pin and harvest, add/remove stations) are deliberately absent — they are separate cycles per the spec's sequencing note.

**Type consistency.** `Station`/`Card`/`Lineage` field names are identical across Tasks 1, 5, 6 and 7. `selectChild` keeps the same `(parentEmb, phraseEmb, candidates, opts)` signature everywhere. `BeltCore.view()` is the single wire projection used by Tasks 7, 8 and 9.

**One issue found and fixed inline:** the first draft had `hasArrived` reading `ARRIVAL_COSINE` from module scope, which would have made Task 1's tests break when Task 2 recalibrated it. Both `selectChild` and `hasArrived` now take thresholds as parameters with constants as defaults.

**One known wart, left deliberately:** `board-do.ts`'s `pumpOnce` passes `CANDIDATES_PER_HOP` in both branches of a ternary. It is written that way so the fan and single-hop paths stay visibly parallel and the fan can be widened independently later; collapsing it now would obscure that they are separate knobs.
