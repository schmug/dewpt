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
  it("counts each word too close to an already-ADMITTED word", () => {
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

  it("duplicateRate rejects a threshold outside cosine's usable [-1, 1) range", () => {
    // A NaN threshold compares false against everything, reporting a flawless 0
    // for a batch of literal duplicates. So does any threshold above 1, because
    // cosine is bounded to [-1, 1] and can never exceed it — 5, 1.5 and even
    // 1.0000001 are all silently unreachable, not merely "strict". A finiteness
    // check catches NaN and Infinity and misses every one of those.
    const identical = [
      [1, 0],
      [1, 0],
      [1, 0],
    ];
    expect(() => duplicateRate(identical, Number.NaN)).toThrow(
      /threshold is outside cosine's usable \[-1, 1\) range/,
    );
    expect(() => duplicateRate(identical, Number.POSITIVE_INFINITY)).toThrow(
      /threshold is outside cosine's usable \[-1, 1\) range/,
    );
    expect(() => duplicateRate(identical, 5)).toThrow(/threshold is outside cosine's usable \[-1, 1\) range/);
    expect(() => duplicateRate(identical, 1.5)).toThrow(
      /threshold is outside cosine's usable \[-1, 1\) range/,
    );
    expect(() => duplicateRate(identical, 1.0000001)).toThrow(
      /threshold is outside cosine's usable \[-1, 1\) range/,
    );
    expect(() => duplicateRate(identical, -1.0000001)).toThrow(
      /threshold is outside cosine's usable \[-1, 1\) range/,
    );
    expect(thrownName(() => duplicateRate(identical, 5))).toBe("EvalMetricError");
    // The true rate for this batch, which every rejected threshold hid behind a 0.
    expect(duplicateRate(identical)).toBeCloseTo(2 / 3, 6);
  });

  it("rejects a threshold of exactly 1, which no pair can ever exceed", () => {
    // The endpoints are NOT symmetric, because the comparison is strict `>`.
    // Cosine is bounded above by 1, so a threshold of 1.0 flags nothing at all
    // — the same fail-OPEN as NaN or 5, just one ulp inside the closed range.
    // These three IDENTICAL vectors have a true rate of 2/3 and would report
    // flawless deduplication instead.
    const identical = [
      [1, 0],
      [1, 0],
      [1, 0],
    ];
    expect(() => duplicateRate(identical, 1)).toThrow(
      /threshold is outside cosine's usable \[-1, 1\) range/,
    );
    expect(thrownName(() => duplicateRate(identical, 1))).toBe("EvalMetricError");
    expect(duplicateRate(identical)).toBeCloseTo(2 / 3, 6);
  });

  it("accepts -1, the loosest attainable threshold", () => {
    // The lower endpoint stays legal, and the asymmetry is principled: cosine
    // attains -1, and with strict `>` a threshold of -1 flags every pair EXCEPT
    // an exactly antipodal one. That is fail-CLOSED — over-strict in the
    // direction that reports too MANY duplicates — so there is nothing here for
    // a lower-is-better gate to hide behind.
    expect(
      duplicateRate(
        [
          [1, 0],
          [0, 1],
        ],
        -1,
      ),
    ).toBeCloseTo(0.5, 6);
    expect(
      duplicateRate(
        [
          [1, 0],
          [-1, 0],
        ],
        -1,
      ),
    ).toBe(0);
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

describe("zero-norm vectors (guard E)", () => {
  // A vector of all zeros is what an embedding backend hands back when it
  // errors out — the local OpenAI-compatible path is where a malformed
  // response is most likely. Every other guard waves it through: it is
  // non-empty, dimensionally consistent, and every component is finite.
  // eval-vec's cosine divides by `norm(a) * norm(b) || 1`, so instead of NaN
  // it returns a clean 0, and a clean 0 means "maximally distinct". Three
  // IDENTICAL zero vectors would report a flawless 0 duplicate rate, and a
  // zero seed or axis would collapse both AUCs onto a constant score.
  const zero = [0, 0];

  it("duplicateRate rejects an all-zero vector instead of scoring it as distinct", () => {
    expect(() => duplicateRate([zero, zero, zero])).toThrow(/vectors\[0\] is all zeros/);
    expect(thrownName(() => duplicateRate([zero, zero, zero]))).toBe("EvalMetricError");
    expect(() => duplicateRate([[1, 0], zero])).toThrow(/vectors\[1\] is all zeros/);
  });

  it("dewpointAuc rejects a zero seed or a zero vector in either band", () => {
    expect(() => dewpointAuc(zero, [[1, 0]], [[0, 1]])).toThrow(/seedVec is all zeros/);
    expect(() => dewpointAuc([1, 0], [zero], [[0, 1]])).toThrow(/nearVecs\[0\] is all zeros/);
    expect(() => dewpointAuc([1, 0], [[1, 0]], [zero])).toThrow(/farVecs\[0\] is all zeros/);
  });

  it("altitudeAuc rejects a zero axis or a zero vector in either band", () => {
    expect(() => altitudeAuc(zero, [[1, 0]], [[0, 1]])).toThrow(/axis is all zeros/);
    expect(() => altitudeAuc([0, 1], [zero], [[0, 1]])).toThrow(/concreteVecs\[0\] is all zeros/);
    expect(() => altitudeAuc([0, 1], [[1, 0]], [zero])).toThrow(/abstractVecs\[0\] is all zeros/);
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
  it("compares each vector only against ADMITTED ones, not every earlier one", () => {
    // A-B and B-C sit 0.25 rad apart (cosine 0.9689, above threshold); A-C sit
    // 0.5 rad apart (cosine 0.8776, below it). Three rules give three different
    // answers on this batch by construction:
    //   all-pairs      3/3 — A is marked through its LATER neighbour B
    //   all-earlier    2/3 — B marked against A, C marked against the REJECTED B
    //   accepted-only  1/3 — B is rejected, so C only ever meets A, and passes
    // pool-core.ts:180-186 is accepted-only: it compares against
    // this.allCandidates() (the accepted pool) and `continue`s past a rejected
    // near-duplicate, so the reject never becomes a comparison target. This
    // test fails if the implementation drifts to either of the other two rules.
    const a = unit(-0.25);
    const b = unit(0);
    const c = unit(0.25);
    expect(duplicateRate([a, b, c])).toBeCloseTo(1 / 3, 6);
    expect(duplicateRate([a, b, c])).not.toBeCloseTo(2 / 3, 6); // all-earlier
    expect(duplicateRate([a, b, c])).not.toBeCloseTo(1, 6); // all-pairs
    // The premise: A and C alone are NOT near-duplicates of each other.
    expect(duplicateRate([a, c])).toBe(0);
  });

  it("does not let a rejected vector seed further rejections down a long chain", () => {
    // Twelve vectors, each 0.25 rad (cosine 0.9689) from its neighbour.
    // Accepted-only admits every other one — 0, 2, 4, 6, 8, 10 — because a
    // rejected vector is not a comparison target, so 6/12 = 0.5. All-earlier
    // rejects everything after the first for 11/12 = 0.9167. The gap between
    // the two rules widens with batch size; this pins the right side of it.
    const chain = Array.from({ length: 12 }, (_, i) => unit(i * 0.25));
    expect(duplicateRate(chain)).toBeCloseTo(0.5, 6);
    expect(duplicateRate(chain)).not.toBeCloseTo(11 / 12, 6); // all-earlier
  });
});
