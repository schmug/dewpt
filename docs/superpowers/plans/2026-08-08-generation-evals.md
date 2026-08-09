# Generation Evals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn dewpt's ad-hoc generation measurements into a re-runnable suite that gates prompt regressions and compares models with numbers.

**Architecture:** Pure metric functions in `scripts/eval-lib.ts` (no I/O, no node APIs) consumed by two thin runners — `scripts/eval.ts` (gate: small cell set, baseline compare, exit code) and `scripts/eval-matrix.ts` (sweep: model × metric table, refreshes baseline). This mirrors the `pool-core` / `session-do` split the project already mandates: testable logic stays out of the layer that does I/O.

**Tech Stack:** TypeScript, tsx, vitest, Ollama (OpenAI-compatible) or Workers AI REST.

**Spec:** [docs/superpowers/specs/2026-08-08-generation-evals-design.md](../specs/2026-08-08-generation-evals-design.md)

## Global Constraints

- **`scripts/eval-lib.ts` MUST NOT import node APIs or any module that does.** No `process`, no `node:fs`, no `node:os`. `tsconfig.json` sets `"types": []` and includes `test/**/*.ts`, so a test importing `eval-lib.ts` typechecks its whole import graph without node globals. Violating this breaks `npm run typecheck`.
- All I/O (baseline file, argv, hostname, git commit) lives in `eval.ts` / `eval-matrix.ts`, covered only by `tsconfig.scripts.json`.
- Eval seeds MUST NOT appear in `src/generation.ts`. Its few-shot seeds are `"security awareness people actually enjoy"` and `"urban gardening"`.
- Constants are imported from `src/types.ts`, never restated: `DEDUPE_COSINE`, `TIER_STRANGENESS`, `ALT_ABSTRACTION`.
- Gates after every task: `npm test` and `npm run typecheck`. Report counts, not vibes.
- Conventional commit prefixes: `feat:`, `test:`, `refactor:`, `docs:`.
- Never push to `main`. Commit on the current branch only.

---

### Task 1: Move pure math into `eval-lib.ts`

`axis-lib.ts` owns vector math today but also owns `process.env` access, so it cannot be on a test's import graph. Move the pure half out and re-export it, leaving the three existing spike scripts untouched.

**Files:**
- Create: `scripts/eval-lib.ts`
- Create: `test/eval-lib.test.ts`
- Modify: `scripts/axis-lib.ts` (delete the moved functions, re-export from eval-lib)

**Interfaces:**
- Consumes: nothing
- Produces: `dot(a: number[], b: number[]): number`, `norm(v: number[]): number`, `sub(a: number[], b: number[]): number[]`, `mean(vs: number[][]): number[]`, `cosine(a: number[], b: number[]): number`, `auc(pos: number[], neg: number[]): number`, `cohensD(a: number[], b: number[]): number`

- [ ] **Step 1: Write the failing test**

Create `test/eval-lib.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { auc, cohensD, cosine, mean, norm, sub } from "../scripts/eval-lib";

describe("auc", () => {
  it("returns 1 when every positive outranks every negative", () => {
    expect(auc([3, 4, 5], [0, 1, 2])).toBe(1);
  });

  it("returns 0.5 for interleaved scores (chance)", () => {
    expect(auc([1, 3], [0, 2])).toBeCloseTo(0.75, 5);
    expect(auc([0, 2], [1, 3])).toBeCloseTo(0.25, 5);
  });

  it("returns 0 when every negative outranks every positive", () => {
    expect(auc([0, 1], [2, 3])).toBe(0);
  });
});

describe("cosine", () => {
  it("is 1 for identical direction and 0 for orthogonal", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it("returns 0 rather than NaN for a zero vector", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("vector helpers", () => {
  it("computes norm, sub and mean", () => {
    expect(norm([3, 4])).toBe(5);
    expect(sub([5, 5], [1, 2])).toEqual([4, 3]);
    expect(mean([[0, 0], [2, 4]])).toEqual([1, 2]);
  });
});

describe("cohensD", () => {
  it("is positive when the first group sits higher", () => {
    expect(cohensD([10, 11, 12], [1, 2, 3])).toBeGreaterThan(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval-lib.test.ts`
Expected: FAIL — `Cannot find module '../scripts/eval-lib'`

- [ ] **Step 3: Create `scripts/eval-lib.ts`**

Copy the function bodies verbatim from `scripts/axis-lib.ts` (they are already correct and in use):

```ts
// Pure metrics for the generation eval suite. NO node APIs and no imports of
// modules that use them: test/eval-lib.test.ts pulls this file's whole import
// graph into tsconfig.json, which sets "types": []. All I/O lives in eval.ts
// and eval-matrix.ts.

export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export function norm(v: number[]): number {
  return Math.sqrt(dot(v, v));
}

export function sub(a: number[], b: number[]): number[] {
  return a.map((x, i) => x - b[i]!);
}

export function mean(vs: number[][]): number[] {
  const out = new Array(vs[0]!.length).fill(0);
  for (const v of vs) for (let i = 0; i < v.length; i++) out[i] += v[i]!;
  return out.map((x) => x / vs.length);
}

export function cosine(a: number[], b: number[]): number {
  return dot(a, b) / (norm(a) * norm(b) || 1);
}

/** Probability a random positive outranks a random negative (Mann-Whitney U).
 *  1.0 = perfect ordering, 0.5 = chance. */
export function auc(posScores: number[], negScores: number[]): number {
  const all = [
    ...posScores.map((s) => ({ s, p: true })),
    ...negScores.map((s) => ({ s, p: false })),
  ];
  all.sort((a, b) => a.s - b.s);
  let rankSum = 0;
  all.forEach((item, i) => {
    if (item.p) rankSum += i + 1;
  });
  return (rankSum - (posScores.length * (posScores.length + 1)) / 2) / (posScores.length * negScores.length);
}

/** Standardised mean difference — how far apart two groups sit, in pooled
 *  standard deviations. AUC says "ordered correctly", d says "by a wide margin". */
export function cohensD(a: number[], b: number[]): number {
  const m = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const variance = (xs: number[]) => {
    const mu = m(xs);
    return xs.reduce((s, x) => s + (x - mu) ** 2, 0) / (xs.length - 1);
  };
  const pooled = Math.sqrt(
    ((a.length - 1) * variance(a) + (b.length - 1) * variance(b)) / (a.length + b.length - 2),
  );
  return (m(a) - m(b)) / (pooled || 1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval-lib.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Re-export from `axis-lib.ts`**

In `scripts/axis-lib.ts`, delete the `// ── vector math ──` and `// ── ranking metrics ──` sections (the seven functions) and replace with:

```ts
// Vector math and ranking metrics now live in eval-lib.ts, which must stay free
// of node APIs so tests can import it. Re-exported here so the axis spikes keep
// their existing import site.
export { auc, cohensD, cosine, dot, mean, norm, sub } from "./eval-lib";
```

- [ ] **Step 6: Verify the spike scripts still typecheck**

Run: `npm run typecheck`
Expected: clean. `axis-spike.ts`, `axis-phrasing-spike.ts` and `axis-layout-prototype.ts` import these names from `axis-lib` and must be unaffected.

- [ ] **Step 7: Commit**

```bash
git add scripts/eval-lib.ts scripts/axis-lib.ts test/eval-lib.test.ts
git commit -m "refactor: move vector math and ranking metrics into eval-lib"
```

---

### Task 2: Baseline comparator

The highest-risk logic in the suite: a sign error here reports green forever. Written before any metric that feeds it.

**Files:**
- Modify: `scripts/eval-lib.ts`
- Modify: `test/eval-lib.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1
- Produces: `METRIC_DIRECTION: Record<MetricKey, "higher" | "lower">`, `compareToBaseline(observed: Record<string, number>, baseline: Baseline, provenance: Provenance, sigmas?: number): GateResult`, and the types `MetricKey`, `Provenance`, `BaselineEntry`, `Baseline`, `Comparison`, `GateResult`

- [ ] **Step 1: Write the failing test**

Append to `test/eval-lib.test.ts`:

```ts
import { compareToBaseline, type Baseline, type Provenance } from "../scripts/eval-lib";

const PROV: Provenance = {
  model: "qwen3.5:4b",
  backend: "local",
  date: "2026-08-08",
  commit: "abc1234",
  machine: "m4max",
};

function baseline(metrics: Baseline["metrics"], provenance: Provenance = PROV): Baseline {
  return { provenance, metrics };
}

describe("compareToBaseline", () => {
  it("passes a higher-is-better metric inside the band", () => {
    const result = compareToBaseline(
      { dewpointAuc: 0.84 },
      baseline({ dewpointAuc: { mean: 0.86, stddev: 0.02, n: 5 } }),
      PROV,
    );
    expect(result.passed).toBe(true);
    expect(result.comparisons[0]!.verdict).toBe("pass");
  });

  it("fails a higher-is-better metric that drops more than 2 sigma", () => {
    const result = compareToBaseline(
      { dewpointAuc: 0.79 },
      baseline({ dewpointAuc: { mean: 0.86, stddev: 0.02, n: 5 } }),
      PROV,
    );
    expect(result.passed).toBe(false);
    expect(result.comparisons[0]!.verdict).toBe("fail");
  });

  it("fails a lower-is-better metric that RISES more than 2 sigma", () => {
    // The inverted case. A single shared comparator would never fire here,
    // and the suite would report green while duplicates climbed.
    const result = compareToBaseline(
      { duplicateRate: 0.30 },
      baseline({ duplicateRate: { mean: 0.10, stddev: 0.02, n: 5 } }),
      PROV,
    );
    expect(result.passed).toBe(false);
    expect(result.comparisons[0]!.verdict).toBe("fail");
  });

  it("passes a lower-is-better metric that improves", () => {
    const result = compareToBaseline(
      { zeroRate: 0.0 },
      baseline({ zeroRate: { mean: 0.20, stddev: 0.02, n: 5 } }),
      PROV,
    );
    expect(result.passed).toBe(true);
  });

  it("refuses to gate when the baseline came from a different model", () => {
    const result = compareToBaseline(
      { dewpointAuc: 0.10 },
      baseline({ dewpointAuc: { mean: 0.86, stddev: 0.02, n: 5 } }, { ...PROV, model: "gemma-4-e2b" }),
      PROV,
    );
    expect(result.gated).toBe(false);
    expect(result.passed).toBe(true);
    expect(result.staleReason).toMatch(/model/);
    expect(result.comparisons[0]!.verdict).toBe("skipped");
  });

  it("refuses to gate when the backend differs", () => {
    const result = compareToBaseline(
      { dewpointAuc: 0.10 },
      baseline({ dewpointAuc: { mean: 0.86, stddev: 0.02, n: 5 } }, { ...PROV, backend: "workers-ai" }),
      PROV,
    );
    expect(result.gated).toBe(false);
    expect(result.staleReason).toMatch(/backend/);
  });

  it("reports a metric with no baseline entry as skipped without failing", () => {
    const result = compareToBaseline({ throughput: 12 }, baseline({}), PROV);
    expect(result.passed).toBe(true);
    expect(result.comparisons[0]!.verdict).toBe("skipped");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval-lib.test.ts`
Expected: FAIL — `compareToBaseline is not a function`

- [ ] **Step 3: Implement in `scripts/eval-lib.ts`**

```ts
export type MetricKey =
  | "meanYield"
  | "zeroRate"
  | "dewpointAuc"
  | "altitudeAuc"
  | "throughput"
  | "duplicateRate";

/** Which way is better. Getting one of these wrong makes the gate silently
 *  unfireable for that metric, so they are declared once and tested directly. */
export const METRIC_DIRECTION: Record<MetricKey, "higher" | "lower"> = {
  meanYield: "higher",
  zeroRate: "lower",
  dewpointAuc: "higher",
  altitudeAuc: "higher",
  throughput: "higher",
  duplicateRate: "lower",
};

export interface Provenance {
  model: string;
  backend: string;
  date: string;
  commit: string;
  machine: string;
}

export interface BaselineEntry {
  mean: number;
  stddev: number;
  n: number;
}

export interface Baseline {
  provenance: Provenance;
  metrics: Partial<Record<MetricKey, BaselineEntry>>;
}

export interface Comparison {
  metric: string;
  observed: number;
  baseline: number | null;
  delta: number | null;
  threshold: number | null;
  verdict: "pass" | "fail" | "skipped";
}

export interface GateResult {
  comparisons: Comparison[];
  /** False when provenance drifted; the run reports but cannot fail. */
  gated: boolean;
  staleReason?: string;
  passed: boolean;
}

export function compareToBaseline(
  observed: Record<string, number>,
  baseline: Baseline,
  provenance: Provenance,
  sigmas = 2,
): GateResult {
  let staleReason: string | undefined;
  if (baseline.provenance.model !== provenance.model) {
    staleReason = `baseline model ${baseline.provenance.model} != ${provenance.model}`;
  } else if (baseline.provenance.backend !== provenance.backend) {
    staleReason = `baseline backend ${baseline.provenance.backend} != ${provenance.backend}`;
  }
  const gated = staleReason === undefined;

  const comparisons: Comparison[] = Object.entries(observed).map(([metric, value]) => {
    const entry = baseline.metrics[metric as MetricKey];
    if (!gated || !entry) {
      return { metric, observed: value, baseline: entry?.mean ?? null, delta: null, threshold: null, verdict: "skipped" };
    }
    const lowerIsBetter = METRIC_DIRECTION[metric as MetricKey] === "lower";
    const threshold = lowerIsBetter
      ? entry.mean + sigmas * entry.stddev
      : entry.mean - sigmas * entry.stddev;
    const failed = lowerIsBetter ? value > threshold : value < threshold;
    return {
      metric,
      observed: value,
      baseline: entry.mean,
      delta: value - entry.mean,
      threshold,
      verdict: failed ? "fail" : "pass",
    };
  });

  return {
    comparisons,
    gated,
    staleReason,
    passed: comparisons.every((c) => c.verdict !== "fail"),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval-lib.test.ts`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/eval-lib.ts test/eval-lib.test.ts
git commit -m "feat: direction-aware baseline comparator with staleness guard"
```

---

### Task 3: Yield and throughput aggregation

**Files:**
- Modify: `scripts/eval-lib.ts`
- Modify: `test/eval-lib.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `REQUIRED_THROUGHPUT: number`, `CallResult`, `meanYield(calls: CallResult[], requested: number): number`, `zeroRate(calls: CallResult[]): number`, `throughput(calls: CallResult[]): number`

- [ ] **Step 1: Write the failing test**

Append to `test/eval-lib.test.ts`:

```ts
import { meanYield, zeroRate, throughput, REQUIRED_THROUGHPUT, type CallResult } from "../scripts/eval-lib";

function call(words: number, elapsedMs: number): CallResult {
  return { words: Array.from({ length: words }, (_, i) => `w${i}`), elapsedMs };
}

describe("yield metrics", () => {
  it("averages the per-call parsed fraction", () => {
    expect(meanYield([call(24, 1000), call(12, 1000)], 24)).toBeCloseTo(0.75, 6);
  });

  it("counts a zero-word call as a dead pump cycle, not a low yield", () => {
    // Distinct from meanYield: two half-batches and one empty batch fill the
    // pool at the same average rate, but only the empty one wastes a cycle.
    expect(zeroRate([call(24, 1000), call(0, 1000), call(0, 1000)])).toBeCloseTo(2 / 3, 6);
    expect(zeroRate([call(1, 1000)])).toBe(0);
  });
});

describe("throughput", () => {
  it("divides accepted words by total elapsed seconds", () => {
    expect(throughput([call(20, 1000), call(20, 1000)])).toBeCloseTo(20, 6);
  });

  it("counts a slow empty call against the rate", () => {
    expect(throughput([call(0, 50_000)])).toBe(0);
  });

  it("states the field's drain ceiling", () => {
    // public/field.js:160 — interval = 2400 - drizzle*19 ms, +0-400ms jitter,
    // one spawn per tick. At drizzle 100 the mean interval is ~700ms.
    expect(REQUIRED_THROUGHPUT).toBeCloseTo(1.43, 2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval-lib.test.ts`
Expected: FAIL — `meanYield is not a function`

- [ ] **Step 3: Implement in `scripts/eval-lib.ts`**

```ts
/** Words per second the field consumes at drizzle 100. public/field.js:160 sets
 *  the spawn interval to `2400 - drizzle * 19` ms plus 0-400ms of jitter and
 *  spawns one word per tick, so the mean interval bottoms out near 700ms.
 *  Sustained generation below this makes the field visibly wait, which
 *  CLAUDE.md classes as correctness, not performance. */
export const REQUIRED_THROUGHPUT = 1000 / 700;

export interface CallResult {
  words: string[];
  elapsedMs: number;
}

export function meanYield(calls: CallResult[], requested: number): number {
  if (calls.length === 0) return 0;
  const total = calls.reduce((s, c) => s + c.words.length / requested, 0);
  return total / calls.length;
}

export function zeroRate(calls: CallResult[]): number {
  if (calls.length === 0) return 0;
  return calls.filter((c) => c.words.length === 0).length / calls.length;
}

export function throughput(calls: CallResult[]): number {
  const ms = calls.reduce((s, c) => s + c.elapsedMs, 0);
  if (ms === 0) return 0;
  return (calls.reduce((s, c) => s + c.words.length, 0) / ms) * 1000;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval-lib.test.ts`
Expected: PASS, 19 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/eval-lib.ts test/eval-lib.test.ts
git commit -m "feat: yield, zero-rate and throughput metrics"
```

---

### Task 4: Embedding-based metrics

**Files:**
- Modify: `scripts/eval-lib.ts`
- Modify: `test/eval-lib.test.ts`

**Interfaces:**
- Consumes: `cosine`, `auc` (Task 1)
- Produces: `dewpointAuc(seedVec: number[], nearVecs: number[][], farVecs: number[][]): number`, `altitudeAuc(axis: number[], concreteVecs: number[][], abstractVecs: number[][]): number`, `duplicateRate(vectors: number[][], threshold?: number): number`

- [ ] **Step 1: Write the failing test**

Append to `test/eval-lib.test.ts`:

```ts
import { dewpointAuc, altitudeAuc, duplicateRate } from "../scripts/eval-lib";
import { DEDUPE_COSINE } from "../src/types";

describe("dewpointAuc", () => {
  it("is 1 when far words sit further from the seed than near words", () => {
    // seedDist = 1 - cosine(seed, word), so "far" means low cosine to seed.
    const seed = [1, 0];
    const near = [[1, 0.05], [1, 0.1]];
    const far = [[0.1, 1], [0, 1]];
    expect(dewpointAuc(seed, near, far)).toBe(1);
  });

  it("is 0.5 when the bands are indistinguishable", () => {
    const seed = [1, 0];
    expect(dewpointAuc(seed, [[1, 0], [0, 1]], [[1, 0], [0, 1]])).toBeCloseTo(0.5, 6);
  });
});

describe("altitudeAuc", () => {
  it("is 1 when abstract words project further along the axis", () => {
    const axis = [0, 1]; // pos - neg
    const concrete = [[1, 0], [1, 0.1]];
    const abstract = [[0, 1], [0.1, 1]];
    expect(altitudeAuc(axis, concrete, abstract)).toBe(1);
  });
});

describe("duplicateRate", () => {
  it("counts each word too close to an EARLIER word", () => {
    const a = [1, 0];
    const dup = [1, 0.01]; // cosine ~0.9999 > DEDUPE_COSINE
    const far = [0, 1];
    expect(duplicateRate([a, dup, far])).toBeCloseTo(1 / 3, 6);
  });

  it("returns 0 for an all-distinct batch and 0 for an empty batch", () => {
    expect(duplicateRate([[1, 0], [0, 1]])).toBe(0);
    expect(duplicateRate([])).toBe(0);
  });

  it("uses the pool's own threshold by default", () => {
    // Imported, never restated — the pool would discard exactly these.
    expect(DEDUPE_COSINE).toBe(0.92);
    const justOver = [Math.cos(0.35), Math.sin(0.35)];
    expect(duplicateRate([[1, 0], justOver], 0.92)).toBeCloseTo(0.5, 6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval-lib.test.ts`
Expected: FAIL — `dewpointAuc is not a function`

- [ ] **Step 3: Implement in `scripts/eval-lib.ts`**

Add the import at the top of the file (note: `src/types.ts` is pure, so this respects the no-node-APIs constraint):

```ts
import { DEDUPE_COSINE } from "../src/types";
```

Then:

```ts
/** Does the dewpoint slider mean anything? Scores every word by the same
 *  seedDist the pool computes (pool-core.ts:191) and asks whether tier-2 words
 *  outrank tier-0 ones. 0.5 means the slider does nothing. */
export function dewpointAuc(seedVec: number[], nearVecs: number[][], farVecs: number[][]): number {
  const seedDist = (v: number[]) => 1 - cosine(seedVec, v);
  return auc(farVecs.map(seedDist), nearVecs.map(seedDist));
}

/** Same question for altitude, projecting onto the production-built
 *  concrete->abstract axis rather than onto distance from the seed. */
export function altitudeAuc(axis: number[], concreteVecs: number[][], abstractVecs: number[][]): number {
  const project = (v: number[]) => cosine(axis, v);
  return auc(abstractVecs.map(project), concreteVecs.map(project));
}

/** Fraction of a batch the pool would throw away as near-duplicates. Compares
 *  each word only against EARLIER ones, matching how the pool admits in order.
 *  Within-batch only: the real pool also checks existing entries and anchors,
 *  but that is session state, not model quality. */
export function duplicateRate(vectors: number[][], threshold: number = DEDUPE_COSINE): number {
  if (vectors.length === 0) return 0;
  let duplicates = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = 0; j < i; j++) {
      if (cosine(vectors[i]!, vectors[j]!) > threshold) {
        duplicates++;
        break;
      }
    }
  }
  return duplicates / vectors.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval-lib.test.ts`
Expected: PASS, 25 tests

- [ ] **Step 5: Run the full gates**

Run: `npm test && npm run typecheck`
Expected: all suites pass, typecheck clean. Confirms `eval-lib.ts` stayed free of node APIs.

- [ ] **Step 6: Commit**

```bash
git add scripts/eval-lib.ts test/eval-lib.test.ts
git commit -m "feat: dewpoint, altitude and near-duplicate metrics"
```

---

### Task 5: Extract `restAiRunner` and add script runner selection

`calibrate.ts` has a private Workers AI REST runner and `axis-lib.ts` has a private REST embedder. Both become one exported runner so evals can target either backend.

**Files:**
- Modify: `src/ai-runner.ts`
- Modify: `test/ai-runner.test.ts`
- Modify: `scripts/calibrate.ts:21-37` (delete `restRunner`, import instead)
- Create: `scripts/eval-runner.ts`

**Interfaces:**
- Consumes: `AiRunner` from `src/generation.ts`, `localAiRunner` from `src/ai-runner.ts`
- Produces: `restAiRunner(accountId: string, token: string): AiRunner` from `src/ai-runner.ts`; `resolveEvalRunner(argv: string[]): { runner: AiRunner; backend: "local" | "workers-ai"; genModel: string; embedModel: string }` from `scripts/eval-runner.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/ai-runner.test.ts`:

```ts
import { restAiRunner } from "../src/ai-runner";

describe("restAiRunner", () => {
  it("posts to the Workers AI account endpoint and unwraps result", async () => {
    const { calls } = captureFetch(() =>
      jsonResponse({ success: true, result: { response: '["a"]' } }),
    );

    const out = await restAiRunner("acct123", "tok456").run("@cf/meta/llama", { messages: [] });

    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/@cf/meta/llama");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer tok456");
    expect(out).toEqual({ response: '["a"]' });
  });

  it("throws with the provider message when success is false", async () => {
    captureFetch(() => jsonResponse({ success: false, errors: [{ message: "no such model" }] }, 404));

    await expect(restAiRunner("a", "t").run("@cf/nope", { messages: [] })).rejects.toThrow(/no such model/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/ai-runner.test.ts`
Expected: FAIL — `restAiRunner is not a function`

- [ ] **Step 3: Add `restAiRunner` to `src/ai-runner.ts`**

```ts
/** Workers AI over its REST API rather than a binding. Scripts run in node with
 *  no binding available, and this path is also unaffected by the wrangler-dev
 *  egress traps documented in CLAUDE.md. */
export function restAiRunner(accountId: string, token: string): AiRunner {
  return {
    async run(model, inputs) {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(inputs),
      });
      const body = (await response.json()) as {
        success: boolean;
        result?: unknown;
        errors?: { message: string }[];
      };
      if (!response.ok || !body.success) {
        const detail = body.errors?.map((e) => e.message).join("; ") || `HTTP ${response.status}`;
        throw new Error(`Workers AI call failed for ${model}: ${detail}`);
      }
      return body.result;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/ai-runner.test.ts`
Expected: PASS

- [ ] **Step 5: Migrate `calibrate.ts`**

Delete the local `restRunner` function (`scripts/calibrate.ts:21-37`) and change the import at line 11 to:

```ts
import { restAiRunner } from "../src/ai-runner";
import { bandTemperature, generateCandidates } from "../src/generation";
```

Then change line 62 from `const ai = restRunner(accountId, token);` to:

```ts
const ai = restAiRunner(accountId, token);
```

- [ ] **Step 6: Create `scripts/eval-runner.ts`**

```ts
// Backend selection for the eval scripts. Node-side, so it may use process.env
// — unlike eval-lib.ts. Local Ollama is the default because it costs nothing
// and needs no credentials; --workers-ai selects production's actual path.

import { localAiRunner, restAiRunner } from "../src/ai-runner";
import type { AiRunner } from "../src/generation";

export interface EvalRunner {
  runner: AiRunner;
  backend: "local" | "workers-ai";
  genModel: string;
  embedModel: string;
}

const DEFAULT_LOCAL_BASE = "http://localhost:11434/v1";
const DEFAULT_LOCAL_GEN = "qwen3.5:4b";
const DEFAULT_LOCAL_EMBED = "bge-m3";
const DEFAULT_CF_GEN = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT_CF_EMBED = "@cf/baai/bge-m3";

function flag(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

export function resolveEvalRunner(argv: string[]): EvalRunner {
  if (argv.includes("--workers-ai")) {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !token) {
      throw new Error('--workers-ai needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (token needs "Workers AI - Read")');
    }
    return {
      runner: restAiRunner(accountId, token),
      backend: "workers-ai",
      genModel: flag(argv, "model") ?? DEFAULT_CF_GEN,
      embedModel: flag(argv, "embed-model") ?? DEFAULT_CF_EMBED,
    };
  }
  const baseUrl = flag(argv, "base-url") ?? process.env.LOCAL_AI_BASE_URL ?? DEFAULT_LOCAL_BASE;
  const rawChatOptions = flag(argv, "chat-options") ?? process.env.LOCAL_AI_CHAT_OPTIONS;
  return {
    runner: localAiRunner({
      baseUrl,
      chatOptions: rawChatOptions ? (JSON.parse(rawChatOptions) as Record<string, unknown>) : undefined,
    }),
    backend: "local",
    genModel: flag(argv, "model") ?? DEFAULT_LOCAL_GEN,
    embedModel: flag(argv, "embed-model") ?? DEFAULT_LOCAL_EMBED,
  };
}
```

- [ ] **Step 7: Run the full gates**

Run: `npm test && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/ai-runner.ts test/ai-runner.test.ts scripts/calibrate.ts scripts/eval-runner.ts
git commit -m "refactor: extract restAiRunner and add eval backend selection"
```

---

### Task 6: The gate — `scripts/eval.ts`

**Files:**
- Create: `scripts/eval-cells.ts`
- Create: `scripts/eval-collect.ts`
- Create: `scripts/eval.ts`
- Create: `scripts/eval-baseline.json`
- Modify: `package.json` (add `eval` and `eval:baseline` scripts)
- Modify: `CLAUDE.md` (Gates section)

**Interfaces:**
- Consumes: `resolveEvalRunner` (Task 5); `meanYield`, `zeroRate`, `throughput`, `dewpointAuc`, `altitudeAuc`, `duplicateRate`, `compareToBaseline`, `Provenance`, `CallResult` (Tasks 2-4)
- Produces: `EVAL_SEEDS: string[]`, `GATE_SEEDS: string[]`, `collectMetrics(...): Promise<Record<MetricKey, number>>`

- [ ] **Step 1: Create `scripts/eval-cells.ts`**

```ts
// Held-out eval seeds. These MUST NOT appear in src/generation.ts: its
// few-shot examples use "security awareness people actually enjoy" and
// "urban gardening", and scoring against those measures recall of the prompt
// rather than generalisation — a model that merely copied its examples back
// would post excellent band separation.

export const EVAL_SEEDS = [
  "a neighborhood that remembers its rivers",
  "repairing old bicycles",
  "learning to cook alone",
  "the last bookshop on the street",
  "night shifts at a hospital",
  "teaching kids about money",
  "an orchestra that never rehearses",
  "coastal towns after the season ends",
] as const;

export const GATE_SEEDS = EVAL_SEEDS.slice(0, 3);
export const GATE_K = 5;
export const SWEEP_K = 10;
export const BATCH_COUNT = 24; // matches GEN_BATCH in src/types.ts
```

- [ ] **Step 2: Create `scripts/eval-collect.ts`**

```ts
// Runs the cells and turns raw calls into the six metrics. Node-side: does I/O.
//
// A failed call is NOT a score of zero. During the 2026-08-08 Maple
// investigation one run threw on a missing model and another returned zero
// parsed words; averaging the throw in as 0.0 would report a broken endpoint as
// a bad model. Throws abort; zero-word results are recorded as real data.

import { embedTexts, expandPole, generateCandidates, type AiRunner } from "../src/generation";
import { ALT_ABSTRACTION, TIER_STRANGENESS, type Alt, type Tier } from "../src/types";
import {
  altitudeAuc, dewpointAuc, duplicateRate, meanYield, sub, throughput, zeroRate,
  type CallResult, type MetricKey,
} from "./eval-lib";
import { BATCH_COUNT } from "./eval-cells";

export interface CellRun {
  seed: string;
  tier: Tier;
  alt: Alt;
  calls: CallResult[];
}

export async function runCell(
  ai: AiRunner, model: string, seed: string, tier: Tier, alt: Alt, k: number,
): Promise<CellRun> {
  const calls: CallResult[] = [];
  for (let i = 0; i < k; i++) {
    const started = Date.now();
    // Throws propagate: a transport failure is not a measurement.
    const words = await generateCandidates(ai, model, {
      seed,
      strangeness: TIER_STRANGENESS[tier],
      altitude: ALT_ABSTRACTION[alt],
      anchors: [],
      exclude: [],
      count: BATCH_COUNT,
    });
    calls.push({ words, elapsedMs: Date.now() - started });
  }
  return { seed, tier, alt, calls };
}

/** The production concrete->abstract axis, built exactly as axis-core builds
 *  it, so this doubles as a regression test on pole expansion. */
export async function buildAltitudeAxis(ai: AiRunner, genModel: string, embedModel: string): Promise<number[]> {
  const neg = await expandPole(ai, genModel, "concrete");
  const pos = await expandPole(ai, genModel, "abstract");
  const [negVec, posVec] = await embedTexts(ai, embedModel, [neg.phrase, pos.phrase]);
  return sub(posVec!, negVec!);
}

export async function collectMetrics(
  ai: AiRunner, genModel: string, embedModel: string, seeds: readonly string[], k: number,
): Promise<Record<MetricKey, number>> {
  const runs: CellRun[] = [];
  for (const seed of seeds) {
    for (const tier of [0, 1, 2] as Tier[]) {
      for (const alt of [0, 1] as Alt[]) {
        runs.push(await runCell(ai, genModel, seed, tier, alt, k));
      }
    }
  }

  const allCalls = runs.flatMap((r) => r.calls);
  const axis = await buildAltitudeAxis(ai, genModel, embedModel);

  const dewpointScores: number[] = [];
  const altitudeScores: number[] = [];
  const duplicateScores: number[] = [];

  for (const seed of seeds) {
    const [seedVec] = await embedTexts(ai, embedModel, [seed]);
    const wordsFor = (tier: Tier, alt: Alt) =>
      runs.filter((r) => r.seed === seed && r.tier === tier && r.alt === alt).flatMap((r) => r.calls).flatMap((c) => c.words);

    for (const alt of [0, 1] as Alt[]) {
      const near = wordsFor(0, alt);
      const far = wordsFor(2, alt);
      if (near.length && far.length) {
        const nearVecs = await embedTexts(ai, embedModel, near);
        const farVecs = await embedTexts(ai, embedModel, far);
        dewpointScores.push(dewpointAuc(seedVec!, nearVecs, farVecs));
        duplicateScores.push(duplicateRate(farVecs));
      }
    }

    for (const tier of [0, 1, 2] as Tier[]) {
      const concrete = wordsFor(tier, 0);
      const abstract = wordsFor(tier, 1);
      if (concrete.length && abstract.length) {
        altitudeScores.push(
          altitudeAuc(axis, await embedTexts(ai, embedModel, concrete), await embedTexts(ai, embedModel, abstract)),
        );
      }
    }
  }

  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

  return {
    meanYield: meanYield(allCalls, BATCH_COUNT),
    zeroRate: zeroRate(allCalls),
    dewpointAuc: avg(dewpointScores),
    altitudeAuc: avg(altitudeScores),
    throughput: throughput(allCalls),
    duplicateRate: avg(duplicateScores),
  };
}
```

- [ ] **Step 3: Create `scripts/eval.ts`**

```ts
// The gate. Runs GATE_SEEDS at k=GATE_K, compares against the committed
// baseline, exits 1 on regression.
//
// Usage:
//   npm run eval                       (local Ollama, the default)
//   npm run eval -- --workers-ai       (needs CLOUDFLARE_ACCOUNT_ID/API_TOKEN)
//   npm run eval -- --model=gemma-4-e2b

import { execSync } from "node:child_process";
import { hostname } from "node:os";
import { readFileSync } from "node:fs";
import { compareToBaseline, METRIC_DIRECTION, type Baseline, type Provenance } from "./eval-lib";
import { collectMetrics } from "./eval-collect";
import { GATE_K, GATE_SEEDS } from "./eval-cells";
import { resolveEvalRunner } from "./eval-runner";

const BASELINE_PATH = new URL("./eval-baseline.json", import.meta.url);

export function provenanceNow(model: string, backend: string): Provenance {
  return {
    model,
    backend,
    date: new Date().toISOString().slice(0, 10),
    commit: execSync("git rev-parse --short HEAD").toString().trim(),
    machine: hostname(),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { runner, backend, genModel, embedModel } = resolveEvalRunner(argv);

  console.log(`backend: ${backend}   gen: ${genModel}   embed: ${embedModel}`);
  console.log(`cells:   ${GATE_SEEDS.length} seeds x 3 tiers x 2 alts, k=${GATE_K} (${GATE_SEEDS.length * 6 * GATE_K} calls)\n`);

  const observed = await collectMetrics(runner, genModel, embedModel, GATE_SEEDS, GATE_K);
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
  const result = compareToBaseline(observed, baseline, provenanceNow(genModel, backend));

  for (const c of result.comparisons) {
    const arrow = METRIC_DIRECTION[c.metric as keyof typeof METRIC_DIRECTION] === "lower" ? "v" : "^";
    const base = c.baseline === null ? "  (no baseline)" : `vs ${c.baseline.toFixed(3)}`;
    console.log(`  ${c.verdict.toUpperCase().padEnd(8)} ${c.metric.padEnd(14)} ${arrow} ${c.observed.toFixed(3)} ${base}`);
  }

  if (!result.gated) {
    console.log(`\nreport-only: ${result.staleReason}`);
    console.log("re-record with: npm run eval:baseline");
    return;
  }
  if (!result.passed) {
    console.error("\nregression against baseline");
    process.exit(1);
  }
  console.log("\nno regression");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 4: Create a placeholder-free starting `scripts/eval-baseline.json`**

An empty `metrics` object makes every comparison `skipped` on the first run, so the gate reports without failing until a real baseline is recorded in Task 7.

```json
{
  "provenance": {
    "model": "unrecorded",
    "backend": "unrecorded",
    "date": "2026-08-08",
    "commit": "unrecorded",
    "machine": "unrecorded"
  },
  "metrics": {}
}
```

- [ ] **Step 5: Add the npm script**

In `package.json`, add to `"scripts"`:

```json
"eval": "tsx scripts/eval.ts",
```

- [ ] **Step 6: Run the gate against a live local model**

Ensure Ollama is running with `qwen3.5:4b` and `bge-m3`, then run: `npm run eval`
Expected: prints six metrics, every verdict `SKIPPED` (baseline model is `unrecorded`), reports `report-only`, exits 0.

- [ ] **Step 7: Document the CI limitation in `CLAUDE.md`**

In the `## Gates` section, after the existing `npm run typecheck` / `npm test` sentence, add:

```markdown
`npm run eval` scores generation itself — yield, dewpoint and altitude
separation, throughput, near-duplicate rate — against
[scripts/eval-baseline.json](scripts/eval-baseline.json). It **cannot run in
CI**: CI has no Ollama and no GPU, and the `--workers-ai` path needs credentials
and real spend. It is a local pre-PR gate, and the baseline refuses to compare
across a model or backend change rather than reporting a false regression.
```

- [ ] **Step 8: Commit**

```bash
git add scripts/eval-cells.ts scripts/eval-collect.ts scripts/eval.ts scripts/eval-baseline.json package.json CLAUDE.md
git commit -m "feat: generation eval gate with held-out seeds"
```

---

### Task 7: The sweep — `scripts/eval-matrix.ts`

**Files:**
- Create: `scripts/eval-matrix.ts`
- Modify: `package.json` (add `eval:matrix`, `eval:baseline`)
- Modify: `scripts/eval-baseline.json` (recorded from a real run)
- Modify: `README.md`

**Interfaces:**
- Consumes: `collectMetrics` (Task 6), `resolveEvalRunner` (Task 5), `provenanceNow` (Task 6), `EVAL_SEEDS`, `SWEEP_K` (Task 6)
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Create `scripts/eval-matrix.ts`**

```ts
// The sweep: run N models over the full seed set and print a comparison table.
// With --record, write the winning run into eval-baseline.json.
//
// Usage:
//   npm run eval:matrix -- --models=qwen3.5:4b,qwen3.5:0.8b
//   npm run eval:baseline -- --model=qwen3.5:4b

import { writeFileSync } from "node:fs";
import { collectMetrics } from "./eval-collect";
import { EVAL_SEEDS, SWEEP_K } from "./eval-cells";
import { provenanceNow } from "./eval";
import { resolveEvalRunner } from "./eval-runner";
import { REQUIRED_THROUGHPUT, type Baseline, type MetricKey } from "./eval-lib";

const BASELINE_PATH = new URL("./eval-baseline.json", import.meta.url);
const COLUMNS: MetricKey[] = ["meanYield", "zeroRate", "dewpointAuc", "altitudeAuc", "throughput", "duplicateRate"];

/** Spread across the per-model runs, so the gate has a band rather than a
 *  point. One model yields stddev 0, which makes the gate exact — record a
 *  baseline from repeated runs of one model when you want a real band. */
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mu = xs.reduce((s, x) => s + x, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mu) ** 2, 0) / (xs.length - 1));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const modelsFlag = argv.find((a) => a.startsWith("--models="))?.slice("--models=".length);
  const base = resolveEvalRunner(argv);
  const models = modelsFlag ? modelsFlag.split(",") : [base.genModel];
  const record = argv.includes("--record");

  const rows: { model: string; metrics: Record<MetricKey, number> }[] = [];
  for (const model of models) {
    console.error(`running ${model} (${EVAL_SEEDS.length * 6 * SWEEP_K} calls)...`);
    rows.push({ model, metrics: await collectMetrics(base.runner, model, base.embedModel, EVAL_SEEDS, SWEEP_K) });
  }

  console.log(`\n${"model".padEnd(26)}${COLUMNS.map((c) => c.padStart(14)).join("")}`);
  for (const row of rows) {
    console.log(row.model.padEnd(26) + COLUMNS.map((c) => row.metrics[c].toFixed(3).padStart(14)).join(""));
  }
  console.log(`\nthroughput requirement: ${REQUIRED_THROUGHPUT.toFixed(2)} candidates/sec (public/field.js at drizzle 100)`);
  for (const row of rows) {
    const headroom = row.metrics.throughput / REQUIRED_THROUGHPUT;
    console.log(`  ${row.model.padEnd(26)} ${headroom.toFixed(1)}x headroom${headroom < 1 ? "  <-- FIELD WILL WAIT" : ""}`);
  }

  if (record) {
    if (rows.length !== 1) throw new Error("--record needs exactly one --models entry, so provenance names one model");
    const row = rows[0]!;
    const baseline: Baseline = {
      provenance: provenanceNow(row.model, base.backend),
      metrics: Object.fromEntries(
        COLUMNS.map((c) => [c, { mean: row.metrics[c], stddev: stddev([row.metrics[c]]), n: SWEEP_K }]),
      ) as Baseline["metrics"],
    };
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`\nrecorded baseline for ${row.model}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm scripts**

In `package.json`:

```json
"eval:matrix": "tsx scripts/eval-matrix.ts",
"eval:baseline": "tsx scripts/eval-matrix.ts --record",
```

- [ ] **Step 3: Run the matrix against two live models**

Run: `npm run eval:matrix -- --models=qwen3.5:4b,qwen3.5:0.8b`
Expected: a two-row table. Based on 2026-08-08 hand measurements, `qwen3.5:4b` should show roughly 10x throughput headroom and `qwen3.5:0.8b` a materially higher `zeroRate`.

- [ ] **Step 4: Record a real baseline**

Run: `npm run eval:baseline -- --model=qwen3.5:4b`
Expected: `scripts/eval-baseline.json` now has real numbers and provenance naming `qwen3.5:4b` / `local`.

- [ ] **Step 5: Verify the gate now actually gates**

Run: `npm run eval`
Expected: verdicts are `PASS`/`FAIL` rather than `SKIPPED`, and it exits 0.

- [ ] **Step 6: Document in `README.md`**

Add after the "Tests & checks" section:

```markdown
## Generation evals

```sh
npm run eval                                        # gate: 90 calls, ~3-6 min
npm run eval:matrix -- --models=qwen3.5:4b,gemma-4-e2b
npm run eval:baseline -- --model=qwen3.5:4b         # re-record after a model change
```

Scores generation on six numbers: yield, zero-rate, dewpoint separation (AUC),
altitude separation (AUC), throughput against the field's 1.43 candidates/sec
drain ceiling, and near-duplicate rate. Seeds are held out from the few-shot
examples in `src/generation.ts` on purpose. `--workers-ai` runs it against
production's path instead of local Ollama.
```

- [ ] **Step 7: Commit**

```bash
git add scripts/eval-matrix.ts scripts/eval-baseline.json package.json README.md
git commit -m "feat: model comparison sweep and baseline recording"
```

---

### Task 8: Register judge

**Files:**
- Create: `scripts/eval-judge.ts`
- Modify: `test/eval-lib.test.ts`
- Modify: `scripts/eval-lib.ts` (add `judgeAccuracy`)
- Modify: `scripts/eval-matrix.ts` (call the judge, print calibration first)

**Interfaces:**
- Consumes: `AiRunner`, `EVAL_SEEDS`
- Produces: `judgeAccuracy(predicted: string[], actual: string[]): number` from `eval-lib.ts`; `JUDGE_FLOOR: number`, `calibrateJudge(ai, model): Promise<number>`, `judgeBands(ai, model, words): Promise<string[]>` from `eval-judge.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/eval-lib.test.ts`:

```ts
import { judgeAccuracy } from "../scripts/eval-lib";

describe("judgeAccuracy", () => {
  it("is the fraction of positions that match", () => {
    expect(judgeAccuracy(["near", "mid", "far"], ["near", "mid", "far"])).toBe(1);
    expect(judgeAccuracy(["near", "mid", "far"], ["near", "far", "far"])).toBeCloseTo(2 / 3, 6);
  });

  it("throws when the lists differ in length, rather than scoring a prefix", () => {
    expect(() => judgeAccuracy(["near"], ["near", "mid"])).toThrow(/length/);
  });

  it("is 0 for empty input rather than NaN", () => {
    expect(judgeAccuracy([], [])).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/eval-lib.test.ts`
Expected: FAIL — `judgeAccuracy is not a function`

- [ ] **Step 3: Implement `judgeAccuracy` in `scripts/eval-lib.ts`**

```ts
export function judgeAccuracy(predicted: string[], actual: string[]): number {
  if (predicted.length !== actual.length) {
    throw new Error(`judge returned ${predicted.length} labels for ${actual.length} words (length mismatch)`);
  }
  if (predicted.length === 0) return 0;
  return predicted.filter((p, i) => p === actual[i]).length / predicted.length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/eval-lib.test.ts`
Expected: PASS, 28 tests

- [ ] **Step 5: Create `scripts/eval-judge.ts`**

```ts
// Model grader for register. Sweep only, never the gate's decision on its own.
//
// Calibration comes first and is the judge's own score: it classifies the 72
// few-shot words already in src/generation.ts (2 seeds x 3 bands x 2 altitudes
// x 6 items), whose bands are known. A judge that cannot reproduce dewpt's own
// taste labels has not earned the right to influence a build.

import { parseCandidateList, type AiRunner } from "../src/generation";
import { judgeAccuracy } from "./eval-lib";

/** Chosen to sit well clear of the 0.33 chance rate on a 3-way classification.
 *  Re-set this from the first calibration run; it is not a measured value. */
export const JUDGE_FLOOR = 0.8;

const JUDGE_SYSTEM = `You classify words by how far they sit from an ordinary, expected association with a topic.

Labels:
- "near": obvious, adjacent, the first thing anyone would say
- "mid": playful, sideways, a step off the expected path
- "far": surreal or remote, yet still meaningfully tethered

Respond with a JSON array of labels only — one label per input word, same order, no prose.`;

export async function judgeBands(ai: AiRunner, model: string, words: string[]): Promise<string[]> {
  const result = await ai.run(model, {
    messages: [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: JSON.stringify({ words }) },
    ],
    temperature: 0,
    max_tokens: 1024,
  });
  const response = (result as { response?: unknown; choices?: { message?: { content?: unknown } }[] });
  const raw = response.response ?? response.choices?.[0]?.message?.content ?? "";
  return parseCandidateList(raw, words.length);
}

/** The 72 few-shot words with their known bands, read from the same constant
 *  the prompt uses so the two cannot drift apart. */
export function fewshotLabels(): { words: string[]; bands: string[] } {
  // FEWSHOT_SEEDS is not exported today; Step 6 exports it.
  const words: string[] = [];
  const bands: string[] = [];
  for (const seed of FEWSHOT_SEEDS) {
    for (const band of ["low", "mid", "high"] as const) {
      for (const items of [seed.bands[band].concrete, seed.bands[band].abstract]) {
        for (const item of items) {
          words.push(item);
          bands.push(band === "low" ? "near" : band === "mid" ? "mid" : "far");
        }
      }
    }
  }
  return { words, bands };
}

export async function calibrateJudge(ai: AiRunner, model: string): Promise<number> {
  const { words, bands } = fewshotLabels();
  return judgeAccuracy(await judgeBands(ai, model, words), bands);
}
```

- [ ] **Step 6: Export `FEWSHOT_SEEDS` from `src/generation.ts`**

Change `const FEWSHOT_SEEDS: FewshotSeed[] = [` to `export const FEWSHOT_SEEDS: FewshotSeed[] = [`, and change `interface FewshotSeed {` to `export interface FewshotSeed {`. Then add the import to `scripts/eval-judge.ts`:

```ts
import { FEWSHOT_SEEDS, parseCandidateList, type AiRunner } from "../src/generation";
```

- [ ] **Step 7: Wire the judge into `scripts/eval-matrix.ts`**

Add the import:

```ts
import { JUDGE_FLOOR, calibrateJudge } from "./eval-judge";
```

Then before the model loop in `main()`:

```ts
  const judgeModel = argv.find((a) => a.startsWith("--judge="))?.slice("--judge=".length);
  if (judgeModel) {
    if (models.includes(judgeModel)) {
      throw new Error(`--judge=${judgeModel} is also under test; the judge must be a different model`);
    }
    const accuracy = await calibrateJudge(base.runner, judgeModel);
    console.log(`judge ${judgeModel}: calibration ${accuracy.toFixed(3)} on the 72 few-shot words (floor ${JUDGE_FLOOR})`);
    if (accuracy < JUDGE_FLOOR) {
      console.log("  below floor — judge verdicts are reported but must not gate");
    }
  }
```

- [ ] **Step 8: Run the judge calibration live**

Run: `npm run eval:matrix -- --models=qwen3.5:0.8b --judge=qwen3.5:4b`
Expected: prints a calibration number before the table. Record whatever it reports in the spec — it is the first real measurement of the 0.80 floor's realism.

- [ ] **Step 9: Run the full gates**

Run: `npm test && npm run typecheck`
Expected: all pass, typecheck clean.

- [ ] **Step 10: Commit**

```bash
git add scripts/eval-judge.ts scripts/eval-lib.ts scripts/eval-matrix.ts src/generation.ts test/eval-lib.test.ts
git commit -m "feat: calibrated register judge for the eval sweep"
```

---

## Self-review notes

**Spec coverage.** All six metrics have tasks (2-4, 8). Held-out seeds: Task 6 Step 1. Backends: Task 5. Baseline + both guards: Task 2. Error handling (`failed call != zero`): Task 6 Step 2 comment plus propagating throws in `runCell`. CI limitation documented: Task 6 Step 7. `eval-lib` purity constraint: Global Constraints, verified at Task 4 Step 5.

**Known deviation from the spec.** The spec's original claim that `auc`/`cohensD` stay in `axis-lib.ts` was wrong and has been corrected in the spec itself: `axis-lib.ts` calls `process.env`, which cannot appear on a test's import graph under `"types": []`. The math moves into `eval-lib.ts` and `axis-lib.ts` re-exports it (Task 1).

**Deferred, deliberately.** `stddev` over a single recorded run is 0, which makes the gate exact rather than banded. Recording a real band needs repeated runs of one model; the note is in `eval-matrix.ts` and the first `eval:baseline` will expose it. Left as-is rather than guessing a synthetic spread.
