import { describe, expect, it } from "vitest";
import { axisFromRow, axisToRow, axisVector, coordsFor, isDegeneratePole, normalizeCoords } from "../src/axis-core";
import type { Axis } from "../src/types";

// public/axes.js is plain JS served raw from public/ (no build step), so it
// sits outside tsconfig's include; the cast pins it to the canonical module's
// surface and the normalizeCoords suite runs against both to prevent drift.
// @ts-expect-error — public/axes.js ships untyped
import * as browserAxesUntyped from "../public/axes.js";
const browserAxes = browserAxesUntyped as { normalizeCoords: typeof normalizeCoords };

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

// Guards pos - neg landing on the zero vector. Pulled out of
// SessionDO.createAxis specifically so this is reachable without a DO
// harness: axisEmb below builds synthetic unit-vector embeddings directly, so
// the identical/orthogonal/near-threshold cases are exercised as plain
// arithmetic — no AI call, real or faked, required.
describe("isDegeneratePole", () => {
  it("fires when both poles carry identical embeddings", () => {
    const v = axisEmb(3);
    expect(isDegeneratePole(v, v)).toBe(true);
  });

  it("does not fire for two distinct (orthogonal) embeddings", () => {
    expect(isDegeneratePole(axisEmb(0), axisEmb(1))).toBe(false);
  });

  it("does not fire for a highly similar but non-identical pair below threshold", () => {
    // A legitimate narrow axis ("a warm colour" vs "a cool colour" measured at
    // 0.9201 cosine against real embeddings) must survive. 0.95 sits above
    // that measured value and still clears the guard, showing the threshold
    // does not bite on realistically similar antonym pairs.
    const neg = [1, 0];
    const theta = Math.acos(0.95);
    const pos = [Math.cos(theta), Math.sin(theta)];
    expect(isDegeneratePole(neg, pos)).toBe(false);
  });
});

// The persist/hydrate round-trip. neg_expanded/pos_expanded are INTEGER columns
// standing in for booleans, and inverting either direction flips `degraded` for
// every axis on session resume — a silent regression with no other coverage,
// since the DO itself has no test harness.
describe("axis row round-trip", () => {
  function makeAxis(overrides: Partial<Axis> = {}): Axis {
    return {
      id: "axis-1",
      neg: { term: "sea", phrase: "a large body of salt water", expanded: true, embedding: axisEmb(0) },
      pos: { term: "desert", phrase: "an arid expanse of sand", expanded: true, embedding: axisEmb(1) },
      createdAt: 1234,
      ...overrides,
    };
  }

  it("returns an axis unchanged through toRow and back", () => {
    const axis = makeAxis();
    expect(axisFromRow(axisToRow(axis))).toEqual(axis);
  });

  it("keeps expanded:false false rather than flipping it", () => {
    // The case that matters: a degraded pole must survive resume as degraded.
    // An inverted `? 1 : 0` or `!== 0` passes every other test here.
    const axis = makeAxis();
    axis.neg.expanded = false;
    const back = axisFromRow(axisToRow(axis));
    expect(back.neg.expanded).toBe(false);
    expect(back.pos.expanded).toBe(true);
  });

  it("stores expanded as the integers the column expects", () => {
    const axis = makeAxis();
    axis.pos.expanded = false;
    const row = axisToRow(axis);
    expect(row.neg_expanded).toBe(1);
    expect(row.pos_expanded).toBe(0);
  });

  it("round-trips a null embedding as null, not as an empty vector", () => {
    // A pole still waiting on the pump. Coerced to [], readyAxisVectors would
    // treat the axis as ready and project every word onto a zero vector.
    const axis = makeAxis();
    axis.pos.embedding = null;
    const back = axisFromRow(axisToRow(axis));
    expect(back.pos.embedding).toBeNull();
    expect(back.neg.embedding).toEqual(axisEmb(0));
  });
});

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
