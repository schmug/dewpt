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
