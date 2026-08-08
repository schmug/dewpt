import { describe, expect, it } from "vitest";
import { meanYield, zeroRate, throughput, REQUIRED_THROUGHPUT, type CallResult } from "../scripts/eval-yield";

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
    // public/field.js:162 — interval = 2400 - drizzle*19 ms, +0-400ms jitter,
    // one spawn per tick. At drizzle 100 the mean interval is ~700ms.
    expect(REQUIRED_THROUGHPUT).toBeCloseTo(1.43, 2);
  });
});
