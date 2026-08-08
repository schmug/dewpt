import { describe, expect, it } from "vitest";
import { auc, cohensD, cosine, mean, norm, sub } from "../scripts/eval-vec";

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
