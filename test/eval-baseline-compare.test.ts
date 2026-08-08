import { describe, expect, it } from "vitest";
import { compareToBaseline, type Baseline, type Provenance } from "../scripts/eval-baseline-compare";

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
