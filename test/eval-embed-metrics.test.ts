import { describe, expect, it } from "vitest";
import { altitudeAuc, dewpointAuc, duplicateRate } from "../scripts/eval-embed-metrics";
import { DEDUPE_COSINE } from "../src/types";

/** Unit vector at angle `t`, so cosine between two of them is cos(t1 - t2) and
 *  the test can name the exact similarity it wants. */
const unit = (t: number): number[] => [Math.cos(t), Math.sin(t)];

/** The `name` of whatever `fn` throws, so a test can assert the error is the
 *  module's own named error without importing the class. */
function thrownName(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).name;
  }
  return "(did not throw)";
}

describe("dewpointAuc", () => {
  it("is 1 when far words sit further from the seed than near words", () => {
    // seedDist = 1 - cosine(seed, word), so "far" means low cosine to seed.
    const seed = [1, 0];
    const near = [
      [1, 0.05],
      [1, 0.1],
    ];
    const far = [
      [0.1, 1],
      [0, 1],
    ];
    expect(dewpointAuc(seed, near, far)).toBe(1);
  });

  it("is 0.5 when the two bands interleave", () => {
    // far at 0.1 rad beats neither near word; far at 1.0 rad beats both. 2/4.
    const seed = [1, 0];
    const near = [unit(0.4), unit(0.7)];
    const far = [unit(0.1), unit(1.0)];
    expect(dewpointAuc(seed, near, far)).toBeCloseTo(0.5, 6);
  });

  it("scores exact ties pessimistically rather than at 0.5", () => {
    // eval-vec's auc ranks by a stable sort with no tie correction, so two
    // identical bands score 0.25, NOT the 0.5 a Mann-Whitney U with average
    // ranks would give. Embeddings tie only on identical vectors, so this is
    // documented rather than worked around — do not read 0.5 into a real run.
    const seed = [1, 0];
    const band = [
      [1, 0],
      [0, 1],
    ];
    expect(dewpointAuc(seed, band, band)).toBeCloseTo(0.25, 6);
  });
});

describe("altitudeAuc", () => {
  it("is 1 when abstract words project further along the axis", () => {
    const axis = [0, 1]; // pos - neg
    const concrete = [
      [1, 0],
      [1, 0.1],
    ];
    const abstract = [
      [0, 1],
      [0.1, 1],
    ];
    expect(altitudeAuc(axis, concrete, abstract)).toBe(1);
  });

  it("is 0 when the axis points the wrong way", () => {
    const axis = [0, -1];
    const concrete = [
      [1, 0],
      [1, 0.1],
    ];
    const abstract = [
      [0, 1],
      [0.1, 1],
    ];
    expect(altitudeAuc(axis, concrete, abstract)).toBe(0);
  });
});

describe("duplicateRate", () => {
  it("counts each word too close to an EARLIER word", () => {
    const a = [1, 0];
    const dup = [1, 0.01]; // cosine ~0.9999 > DEDUPE_COSINE
    const far = [0, 1];
    expect(duplicateRate([a, dup, far])).toBeCloseTo(1 / 3, 6);
  });

  it("returns 0 for an all-distinct batch", () => {
    expect(
      duplicateRate([
        [1, 0],
        [0, 1],
      ]),
    ).toBe(0);
  });
});

describe("empty inputs (guard A)", () => {
  // Duplicate rate is lower-is-better, so returning 0 for an empty batch reads
  // as PERFECT deduplication for a run that produced nothing at all. The AUCs
  // divide by pos.length * neg.length, so an empty side yields NaN, and a NaN
  // metric compares false against every threshold — it launders into a pass.
  it("duplicateRate throws on an empty batch instead of reporting a perfect 0", () => {
    expect(() => duplicateRate([])).toThrow(/vectors is empty/);
    expect(thrownName(() => duplicateRate([]))).toBe("EvalMetricError");
  });

  it("dewpointAuc names whichever side is empty", () => {
    const seed = [1, 0];
    const band = [[0, 1]];
    expect(() => dewpointAuc(seed, [], band)).toThrow(/nearVecs is empty/);
    expect(() => dewpointAuc(seed, band, [])).toThrow(/farVecs is empty/);
    expect(thrownName(() => dewpointAuc(seed, [], band))).toBe("EvalMetricError");
  });

  it("altitudeAuc names whichever side is empty", () => {
    const axis = [0, 1];
    const band = [[0, 1]];
    expect(() => altitudeAuc(axis, [], band)).toThrow(/concreteVecs is empty/);
    expect(() => altitudeAuc(axis, band, [])).toThrow(/abstractVecs is empty/);
    expect(thrownName(() => altitudeAuc(axis, [], band))).toBe("EvalMetricError");
  });

  it("rejects 0-dimensional vectors, which cosine would score as 0", () => {    // cosine([], []) is 0/(0*0 || 1) = 0, so a batch of empty vectors would
    // otherwise report a flawless 0 duplicate rate.
    expect(() => duplicateRate([[], []])).toThrow(/vectors\[0\] is empty/);
    expect(() => dewpointAuc([], [[1]], [[1]])).toThrow(/seedVec is empty/);
    expect(() => altitudeAuc([], [[1]], [[1]])).toThrow(/axis is empty/);
  });
});

describe("dimension mismatch (guard B)", () => {
  // Live hazard, not hypothetical: the README warns that switching EMBED_MODEL
  // mid-session mixes incompatible dimensions (bge-m3 is 1024, nomic-embed-text
  // is 768). eval-vec's dot() iterates a.length and reads b[i], so a short b
  // gives undefined arithmetic (NaN) and a long b is silently TRUNCATED — a
  // finite, plausible, wrong number. Both directions must stop the run.
  it("duplicateRate rejects a batch of mixed dimensions, both orderings", () => {
    expect(() =>
      duplicateRate([
        [1, 0],
        [1, 0, 5],
      ]),
    ).toThrow(/vectors\[1\] has 3 dimensions, expected 2/);
    expect(() =>
      duplicateRate([
        [1, 0, 5],
        [1, 0],
      ]),
    ).toThrow(/vectors\[1\] has 2 dimensions, expected 3/);
    expect(
      thrownName(() =>
        duplicateRate([
          [1, 0],
          [1, 0, 5],
        ]),
      ),
    ).toBe("EvalMetricError");
  });

  it("duplicateRate rejects a real bge-m3 / nomic-embed-text mix", () => {
    const bge = new Array<number>(1024).fill(0.1);
    const nomic = new Array<number>(768).fill(0.1);
    expect(() => duplicateRate([bge, nomic])).toThrow(
      /vectors\[1\] has 768 dimensions, expected 1024/,
    );
  });

  it("dewpointAuc holds the seed and both bands to one dimension", () => {
    const seed = [1, 0, 0];
    expect(() => dewpointAuc(seed, [[1, 0]], [[0, 1, 0]])).toThrow(
      /nearVecs\[0\] has 2 dimensions, expected 3/,
    );
    expect(() => dewpointAuc(seed, [[1, 0, 0]], [[0, 1]])).toThrow(
      /farVecs\[0\] has 2 dimensions, expected 3/,
    );
  });

  it("altitudeAuc holds the axis and both bands to one dimension", () => {
    const axis = [0, 1, 0];
    expect(() => altitudeAuc(axis, [[1, 0]], [[0, 1, 0]])).toThrow(
      /concreteVecs\[0\] has 2 dimensions, expected 3/,
    );
    expect(() => altitudeAuc(axis, [[1, 0, 0]], [[0, 1]])).toThrow(
      /abstractVecs\[0\] has 2 dimensions, expected 3/,
    );
  });
});

describe("non-finite inputs (guard C)", () => {
  // A NaN component makes cosine NaN, and `NaN > threshold` is false — so a
  // corrupt embedding does not raise the duplicate rate, it LOWERS it. Same
  // laundering as the empty case: the metric still returns a number the gate
  // will happily accept.
  it("duplicateRate rejects NaN and Infinity components", () => {
    expect(() =>
      duplicateRate([
        [1, 0],
        [Number.NaN, 1],
      ]),
    ).toThrow(/vectors\[1\]\[0\] is not finite \(NaN\)/);
    expect(() =>
      duplicateRate([
        [1, 0],
        [1, Number.POSITIVE_INFINITY],
      ]),
    ).toThrow(/vectors\[1\]\[1\] is not finite \(Infinity\)/);
    expect(
      thrownName(() =>
        duplicateRate([
          [1, 0],
          [Number.NaN, 1],
        ]),
      ),
    ).toBe("EvalMetricError");
  });

  it("duplicateRate rejects a non-finite threshold", () => {
    // A NaN threshold compares false against everything, reporting a flawless
    // 0 for a batch of literal duplicates.
    const a = [1, 0];
    expect(() => duplicateRate([a, a], Number.NaN)).toThrow(/threshold is not finite/);
    expect(() => duplicateRate([a, a], Number.POSITIVE_INFINITY)).toThrow(
      /threshold is not finite/,
    );
  });

  it("dewpointAuc rejects non-finite components in the seed or either band", () => {
    expect(() => dewpointAuc([Number.NaN, 0], [[1, 0]], [[0, 1]])).toThrow(
      /seedVec\[0\] is not finite/,
    );
    expect(() => dewpointAuc([1, 0], [[Number.NaN, 0]], [[0, 1]])).toThrow(
      /nearVecs\[0\]\[0\] is not finite/,
    );
    expect(() => dewpointAuc([1, 0], [[1, 0]], [[0, Number.NEGATIVE_INFINITY]])).toThrow(
      /farVecs\[0\]\[1\] is not finite \(-Infinity\)/,
    );
  });

  it("altitudeAuc rejects non-finite components in the axis or either band", () => {
    expect(() => altitudeAuc([0, Number.NaN], [[1, 0]], [[0, 1]])).toThrow(
      /axis\[1\] is not finite/,
    );
    expect(() => altitudeAuc([0, 1], [[Number.NaN, 0]], [[0, 1]])).toThrow(
      /concreteVecs\[0\]\[0\] is not finite/,
    );
    expect(() => altitudeAuc([0, 1], [[1, 0]], [[Number.NaN, 1]])).toThrow(
      /abstractVecs\[0\]\[0\] is not finite/,
    );
  });
});

/** Unit vectors at cosine 0.9201 and 0.9199 to [1, 0] — one hair above the
 *  0.92 dedupe threshold and one hair below it. */
const justOverThreshold = [0.9201, Math.sqrt(1 - 0.9201 ** 2)];
const justUnderThreshold = [0.9199, Math.sqrt(1 - 0.9199 ** 2)];

describe("threshold default (guard D)", () => {
  it("uses the pool's own constant, which is 0.92", () => {
    expect(DEDUPE_COSINE).toBe(0.92);
  });

  it("brackets the DEFAULT threshold at 0.92 to within 1e-4", () => {
    // Not just "a default exists": a pair at cosine 0.9201 must count as a
    // duplicate and a pair at 0.9199 must not, which pins the default to
    // (0.9199, 0.9201]. Any other constant flips one of these two lines.
    expect(duplicateRate([[1, 0], justOverThreshold])).toBeCloseTo(0.5, 6);
    expect(duplicateRate([[1, 0], justUnderThreshold])).toBe(0);
  });

  it("gives the same answer as passing DEDUPE_COSINE explicitly", () => {
    const batch = [[1, 0], justOverThreshold, justUnderThreshold];
    expect(duplicateRate(batch)).toBe(duplicateRate(batch, DEDUPE_COSINE));
  });

  it("lets an explicit threshold override the default in both directions", () => {
    // Stricter than 0.92: the just-over pair stops being a duplicate.
    expect(duplicateRate([[1, 0], justOverThreshold], 0.99)).toBe(0);
    // Looser than 0.92: even orthogonal vectors count.
    expect(
      duplicateRate(
        [
          [1, 0],
          [0, 1],
        ],
        -1,
      ),
    ).toBeCloseTo(0.5, 6);
  });
});

describe("duplicate comparison order", () => {
  it("compares each vector only against EARLIER ones, never later ones", () => {
    // A-B and B-C sit 0.25 rad apart (cosine 0.9689, above threshold); A-C sit
    // 0.5 rad apart (cosine 0.8776, below it). Earlier-only marks B and C for
    // 2/3. Comparing against ALL other vectors would also mark A — through its
    // LATER neighbour B — for 3/3. The two rules disagree on this batch by
    // construction, so this test fails if the inner loop ever scans the whole
    // batch. Earlier-only is what the pool does: it admits in order and only
    // ever checks a candidate against what was already accepted.
    const a = unit(-0.25);
    const b = unit(0);
    const c = unit(0.25);
    expect(duplicateRate([a, b, c])).toBeCloseTo(2 / 3, 6);
    expect(duplicateRate([a, b, c])).not.toBeCloseTo(1, 6);
    // The premise: A and C alone are NOT near-duplicates of each other.
    expect(duplicateRate([a, c])).toBe(0);
  });
});
