import { describe, expect, it } from "vitest";
import { auc, cohensD, cosine, mean, norm, sub } from "../scripts/eval-vec";

describe("auc", () => {
  it("returns 1 when every positive outranks every negative", () => {
    expect(auc([3, 4, 5], [0, 1, 2])).toBe(1);
  });

  it("is symmetric about 0.5 when interleaving is reversed", () => {
    expect(auc([1, 3], [0, 2])).toBeCloseTo(0.75, 5);
    expect(auc([0, 2], [1, 3])).toBeCloseTo(0.25, 5);
  });

  it("returns 0 when every negative outranks every positive", () => {
    expect(auc([0, 1], [2, 3])).toBe(0);
  });
});

// Ties get average (mid)ranks, so identical data reads as "no signal" (0.5)
// rather than "inverted signal" (0). Before the correction every case below
// returned a number below chance — 0 for a total tie, which a lower-is-better
// gate reads as a catastrophic regression rather than an absent one.
describe("auc tie correction", () => {
  it("returns 0.5 for a total tie (genuine chance)", () => {
    expect(auc([1, 1], [1, 1])).toBeCloseTo(0.5, 12);
    expect(auc([1], [1])).toBeCloseTo(0.5, 12);
    expect(auc([5, 5, 5, 5], [5, 5, 5, 5])).toBeCloseTo(0.5, 12);
  });

  it("returns 0.5 when the two groups are the same multiset", () => {
    expect(auc([1, 2], [1, 2])).toBeCloseTo(0.5, 12);
  });

  it("counts a single tied pair as half a win", () => {
    // 5v5: 24 strict wins + 1 tie => (24 + 0.5) / 25 = 0.98. One shared value
    // is the shape a duplicate word produces — identical embedding, identical
    // score — which is exactly what duplicateRate exists to measure.
    const pos = [0.5, 0.6, 0.7, 0.8, 0.9];
    const neg = [0.1, 0.2, 0.3, 0.4, 0.5];
    expect(auc(pos, neg)).toBeCloseTo(0.98, 12);
  });

  it("is continuous across an exact tie rather than knife-edge", () => {
    // The defect made the metric discontinuous at zero separation: perturbing
    // by one ulp flipped it from 0 to 1, so float noise decided a gate verdict.
    // Midranks put the exact tie at the midpoint of the two limits.
    const eps = 1e-15;
    expect(auc([1, 1], [1, 1])).toBeCloseTo(0.5, 12);
    expect(auc([1 + eps, 1 + eps], [1, 1])).toBe(1);
    expect(auc([1, 1], [1 + eps, 1 + eps])).toBe(0);
  });

  it("never returns a value outside [0, 1] under heavy tying", () => {
    for (const [pos, neg] of [
      [[1, 1, 2], [1, 2, 2]],
      [[0, 0, 0], [0, 0]],
      [[3, 3], [1, 3, 3, 5]],
      [[2], [1, 2, 3]],
    ] as [number[], number[]][]) {
      const a = auc(pos, neg);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
  });

  it("is antisymmetric: auc(a, b) === 1 - auc(b, a), ties included", () => {
    for (const [pos, neg] of [
      [[1, 1], [1, 1]],
      [[1, 2], [1, 2]],
      [[0.5, 0.6, 0.7, 0.8, 0.9], [0.1, 0.2, 0.3, 0.4, 0.5]],
      [[3, 3, 1], [3, 2, 2, 1]],
    ] as [number[], number[]][]) {
      expect(auc(pos, neg)).toBeCloseTo(1 - auc(neg, pos), 12);
    }
  });
});

// The tie correction must not move any tie-free number: the axis spikes'
// recorded results (pair 0.843 > single 0.763; 0.980 vs 0.640 in src/types.ts)
// have to stay reproducible. This is the pre-correction auc, verbatim, so the
// two can be compared over randomly generated tie-free input.
function aucLegacy(posScores: number[], negScores: number[]): number {
  const all = [
    ...posScores.map((s) => ({ s, p: true })),
    ...negScores.map((s) => ({ s, p: false })),
  ];
  all.sort((a, b) => a.s - b.s);
  let rankSum = 0;
  all.forEach((item, i) => {
    if (item.p) rankSum += i + 1;
  });
  return (
    (rankSum - (posScores.length * (posScores.length + 1)) / 2) /
    (posScores.length * negScores.length)
  );
}

/** Deterministic PRNG — a fixed seed keeps a failure reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("auc differential fuzz vs the pre-correction implementation", () => {
  it("is bit-identical on tie-free input over 20000 random cases", () => {
    const rng = mulberry32(0x5eed);
    const TRIALS = 20_000;
    let compared = 0;
    const mismatches: { pos: number[]; neg: number[]; was: number; now: number }[] = [];

    for (let t = 0; t < TRIALS; t++) {
      const nPos = 1 + Math.floor(rng() * 12);
      const nNeg = 1 + Math.floor(rng() * 12);
      // Draw distinct values so the case is genuinely tie-free; reject and
      // redraw on collision rather than nudging, which could reintroduce a tie.
      const seen = new Set<number>();
      const draw = (): number => {
        for (let attempt = 0; attempt < 64; attempt++) {
          const v = Math.round(rng() * 2000 - 1000) / 100; // 2dp, collidable on purpose
          if (!seen.has(v)) {
            seen.add(v);
            return v;
          }
        }
        return NaN;
      };
      const pos = Array.from({ length: nPos }, draw);
      const neg = Array.from({ length: nNeg }, draw);
      if (pos.some(Number.isNaN) || neg.some(Number.isNaN)) continue;

      // Guard the guard: assert the case really has no ties before it counts.
      expect(new Set([...pos, ...neg]).size).toBe(nPos + nNeg);

      const was = aucLegacy(pos, neg);
      const now = auc(pos, neg);
      compared++;
      if (!Object.is(was, now)) mismatches.push({ pos, neg, was, now });
    }

    expect(mismatches).toEqual([]);
    // Exact, so a silently-skipped case can't shrink the fuzz into a no-op.
    expect(compared).toBe(TRIALS);
    expect(compared).toBe(20_000);
  });

  it("differs from the pre-correction implementation exactly when ties exist", () => {
    // The mirror image of the test above: proves the fuzz would have caught a
    // real change, i.e. that it is not vacuously passing.
    expect(aucLegacy([1, 1], [1, 1])).toBe(0);
    expect(auc([1, 1], [1, 1])).toBeCloseTo(0.5, 12);
    expect(aucLegacy([1, 2], [1, 2])).toBeCloseTo(0.25, 12);
    expect(auc([1, 2], [1, 2])).toBeCloseTo(0.5, 12);
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
