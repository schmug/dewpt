import { describe, expect, it } from "vitest";
import {
  METRIC_DIRECTION,
  compareToBaseline,
  type Baseline,
  type Provenance,
} from "../scripts/eval-baseline-compare";

const PROV: Provenance = {
  model: "qwen3.5:4b",
  backend: "local",
  date: "2026-08-08",
  commit: "abc1234",
  machine: "m4max",
};

/** The observed-metrics argument. Several tests below deliberately feed it
 *  shapes the type forbids — a misspelled metric name, a corrupt baseline
 *  entry — because the real caller parses eval-baseline.json off disk, where
 *  the type is a promise rather than a guarantee. */
type Observed = Parameters<typeof compareToBaseline>[0];

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

  it("refuses to gate a metric name it has no direction for", () => {
    // snake_case slip of duplicateRate. The direction lookup misses, and a
    // missing direction is not "higher" — before the guard this took the
    // higher-is-better branch and passed 0.9 against a 0.10 baseline.
    const result = compareToBaseline(
      { duplicate_rate: 0.9 } as unknown as Observed,
      baseline({ duplicate_rate: { mean: 0.10, stddev: 0.02, n: 5 } } as unknown as Baseline["metrics"]),
      PROV,
    );
    expect(result.comparisons[0]!.verdict).toBe("skipped");
    expect(result.comparisons[0]!.threshold).toBeNull();
    expect(result.unknownMetrics).toEqual(["duplicate_rate"]);
    expect(result.checked).toBe(0);
  });

  it("does not mistake Object.prototype members for a direction or a baseline entry", () => {
    // METRIC_DIRECTION["toString"] and baseline.metrics["toString"] both
    // resolve to Object.prototype.toString, which is truthy and not
    // undefined, so both the no-entry skip and the unknown-direction skip
    // are escaped by inheritance alone.
    const result = compareToBaseline(
      { toString: 0.9 } as unknown as Observed,
      baseline({}),
      PROV,
    );
    expect(result.comparisons[0]!.verdict).toBe("skipped");
    expect(result.comparisons[0]!.baseline).toBeNull();
    expect(result.unknownMetrics).toEqual(["toString"]);
    expect(result.passed).toBe(true);
  });

  it("fails a metric whose observed value is not finite", () => {
    // NaN loses every comparison, so `failed` was always false. A metric that
    // failed to compute is a failure: a failed call is not a score of zero.
    const result = compareToBaseline(
      { dewpointAuc: NaN },
      baseline({ dewpointAuc: { mean: 0.86, stddev: 0.02, n: 5 } }),
      PROV,
    );
    expect(result.comparisons[0]!.verdict).toBe("fail");
    expect(result.comparisons[0]!.reason).toMatch(/finite/);
    expect(result.passed).toBe(false);
  });

  it("fails when the baseline entry itself is corrupt", () => {
    // A missing stddev makes the threshold NaN, which passed everything.
    const result = compareToBaseline(
      { dewpointAuc: 0.01 },
      baseline({ dewpointAuc: { mean: 0.86, n: 5 } } as unknown as Baseline["metrics"]),
      PROV,
    );
    expect(result.comparisons[0]!.verdict).toBe("fail");
    expect(result.comparisons[0]!.reason).toMatch(/baseline/);
    expect(result.passed).toBe(false);
  });

  it("does not fire on floating-point noise when the baseline stddev is 0", () => {
    // The first recorded baseline comes from a single run, so stddev is 0 for
    // every metric and the gate is bit-exact without a floor.
    const auc = compareToBaseline(
      { dewpointAuc: 0.86 - 1e-15 },
      baseline({ dewpointAuc: { mean: 0.86, stddev: 0, n: 1 } }),
      PROV,
    );
    expect(auc.comparisons[0]!.verdict).toBe("pass");

    // 1e-12 rather than the 1e-17 that first exposed this. Both are real
    // rises — one ulp of 0.1 is ~1.4e-17 — but 1e-12 clears it by five orders
    // of magnitude, so the assertion cannot start passing by rounding away.
    const dupes = compareToBaseline(
      { duplicateRate: 0.10 + 1e-12 },
      baseline({ duplicateRate: { mean: 0.10, stddev: 0, n: 1 } }),
      PROV,
    );
    expect(dupes.comparisons[0]!.verdict).toBe("pass");

    // The relative term keeps the floor meaningful for unbounded throughput.
    const fast = compareToBaseline(
      { throughput: 14 - 1e-12 },
      baseline({ throughput: { mean: 14, stddev: 0, n: 1 } }),
      PROV,
    );
    expect(fast.comparisons[0]!.verdict).toBe("pass");
  });

  it("still fires on a real regression when the baseline stddev is 0", () => {
    const auc = compareToBaseline(
      { dewpointAuc: 0.70 },
      baseline({ dewpointAuc: { mean: 0.86, stddev: 0, n: 1 } }),
      PROV,
    );
    expect(auc.comparisons[0]!.verdict).toBe("fail");

    const slow = compareToBaseline(
      { throughput: 8 },
      baseline({ throughput: { mean: 14, stddev: 0, n: 1 } }),
      PROV,
    );
    expect(slow.comparisons[0]!.verdict).toBe("fail");
  });

  it("skips only throughput when the baseline came from another machine", () => {
    // throughput is wall-clock; the AUCs are model-dependent and stay
    // comparable across machines, so a machine change must not silence them.
    const result = compareToBaseline(
      { throughput: 12, dewpointAuc: 0.10 },
      baseline(
        {
          throughput: { mean: 40, stddev: 2, n: 5 },
          dewpointAuc: { mean: 0.86, stddev: 0.02, n: 5 },
        },
        { ...PROV, machine: "ci-runner-2vcpu" },
      ),
      PROV,
    );
    expect(result.gated).toBe(true);
    expect(result.staleReason).toBeUndefined();

    const throughput = result.comparisons.find((c) => c.metric === "throughput")!;
    expect(throughput.verdict).toBe("skipped");
    expect(throughput.reason).toMatch(/machine/);

    const auc = result.comparisons.find((c) => c.metric === "dewpointAuc")!;
    expect(auc.verdict).toBe("fail");

    expect(result.passed).toBe(false);
    expect(result.checked).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("gates throughput normally when the machine matches", () => {
    const result = compareToBaseline(
      { throughput: 12 },
      baseline({ throughput: { mean: 40, stddev: 2, n: 5 } }),
      PROV,
    );
    expect(result.comparisons[0]!.verdict).toBe("fail");
    expect(result.checked).toBe(1);
  });

  it("counts how many metrics were actually checked", () => {
    // The worst possible run against an empty baseline. It is legitimately
    // report-only, but `passed: true` alone is indistinguishable from a real
    // green, so the counts have to be on the result.
    const result = compareToBaseline(
      { meanYield: 0, zeroRate: 1, dewpointAuc: 0, altitudeAuc: 0, throughput: 0, duplicateRate: 1 },
      baseline({}),
      PROV,
    );
    expect(result.passed).toBe(true);
    expect(result.gated).toBe(true);
    expect(result.checked).toBe(0);
    expect(result.skipped).toBe(6);
  });

  it("reports deltas in report-only mode", () => {
    // Report-only is the exact mode meant to answer "what changed when I
    // switched models", which it cannot do with a null delta.
    const result = compareToBaseline(
      { dewpointAuc: 0.10 },
      baseline({ dewpointAuc: { mean: 0.86, stddev: 0.02, n: 5 } }, { ...PROV, model: "gemma-4-e2b" }),
      PROV,
    );
    expect(result.gated).toBe(false);
    expect(result.comparisons[0]!.baseline).toBe(0.86);
    expect(result.comparisons[0]!.delta).toBeCloseTo(-0.76, 10);
    expect(result.comparisons[0]!.threshold).toBeNull();
  });
});

describe("METRIC_DIRECTION", () => {
  it("declares the direction of every metric", () => {
    // Flipping any one of these makes the gate silently unfireable for that
    // metric, and every behavioural test above would stay green. Assert the
    // whole table so the direction cannot drift unnoticed.
    expect(METRIC_DIRECTION).toEqual({
      meanYield: "higher",
      zeroRate: "lower",
      dewpointAuc: "higher",
      altitudeAuc: "higher",
      throughput: "higher",
      duplicateRate: "lower",
    });
  });
});
