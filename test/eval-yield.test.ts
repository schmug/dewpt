import { describe, expect, it } from "vitest";
import {
  meanYield,
  zeroRate,
  throughput,
  REQUIRED_THROUGHPUT,
  STEADY_SPAWN_RATE,
  EvalMetricError,
  type CallResult,
} from "../scripts/eval-yield";

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

  it("refuses a requested count that would make the yield non-finite", () => {
    // Every one of these used to return Infinity, NaN or a negative yield, all
    // of which launder into a passing gate downstream.
    expect(() => meanYield([call(24, 1000)], 0)).toThrow(EvalMetricError);
    expect(() => meanYield([call(24, 1000)], -24)).toThrow(EvalMetricError);
    expect(() => meanYield([call(24, 1000)], Number.NaN)).toThrow(EvalMetricError);
    expect(() => meanYield([call(24, 1000)], Number.POSITIVE_INFINITY)).toThrow(EvalMetricError);
    expect(() => meanYield([call(24, 1000)], 0)).toThrow(/requested/);
  });

  it("clamps an overproducing call so it cannot mask a dead one", () => {
    // 48 words against a request of 24 is 2.0 unclamped, which averaged with a
    // dead call reported a perfect 1.0. src/generation.ts:149 caps parsed output
    // in practice, but this must not depend on its caller for that.
    expect(meanYield([call(48, 1000), call(0, 1000)], 24)).toBeCloseTo(0.5, 6);
    expect(meanYield([call(48, 1000)], 24)).toBe(1);
  });
});

describe("empty batches", () => {
  it("refuses to report a rate over zero calls", () => {
    // zeroRate is the fail-open one: the old sentinel 0 means "no dead cycles",
    // i.e. perfect, so a total generation outage reported as ideal.
    expect(() => zeroRate([])).toThrow(EvalMetricError);
    expect(() => meanYield([], 24)).toThrow(EvalMetricError);
    expect(() => throughput([])).toThrow(EvalMetricError);
  });
});

describe("throughput", () => {
  it("divides accepted words by total elapsed seconds", () => {
    expect(throughput([call(20, 1000), call(20, 1000)])).toBeCloseTo(20, 6);
  });

  it("counts a slow empty call against the rate", () => {
    expect(throughput([call(0, 50_000)])).toBe(0);
  });

  it("refuses degenerate elapsed times instead of absorbing them", () => {
    // Each of these used to return a number: 0 with 20 words vanishing, -20
    // words/sec, or a bare 0 for a zero-duration batch.
    expect(() => throughput([call(10, 1000), call(10, -1000)])).toThrow(EvalMetricError);
    expect(() => throughput([call(10, 1000), call(10, -2000)])).toThrow(EvalMetricError);
    expect(() => throughput([call(10, Number.NaN)])).toThrow(EvalMetricError);
    expect(() => throughput([call(10, Number.POSITIVE_INFINITY)])).toThrow(EvalMetricError);
    expect(() => throughput([call(20, 0)])).toThrow(/elapsed/);
  });

  it("derives the steady spawn rate from the loop's interval formula", () => {
    // Recomputed from the literals the constants are built out of, so editing
    // the base interval (2400), the ms-per-drizzle-step (19), the jitter span
    // (400) or the slider max (100) in the module fails here. This does not
    // read public/field.js — the literals are duplicated, so it catches edits
    // to the module constants only, not drift in the spawn loop itself.
    expect(STEADY_SPAWN_RATE).toBe(1000 / (2400 - 100 * 19 + 400 / 2));
  });

  it("uses the minimum interval, not the mean, as the required throughput", () => {
    expect(REQUIRED_THROUGHPUT).toBe(1000 / (2400 - 100 * 19));
    // The ceiling must exceed the asymptotic mean, or it is not a ceiling.
    expect(REQUIRED_THROUGHPUT).toBeGreaterThan(STEADY_SPAWN_RATE);
  });
});
