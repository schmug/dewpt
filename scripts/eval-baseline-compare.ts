// Baseline comparator for the generation eval suite. NO node APIs and no
// imports of modules that use them: test/eval-baseline-compare.test.ts pulls
// this file's whole import graph into tsconfig.json, which sets "types": [].
// Reading and writing the baseline file lives in eval.ts / eval-matrix.ts.

export type MetricKey =
  | "meanYield"
  | "zeroRate"
  | "dewpointAuc"
  | "altitudeAuc"
  | "throughput"
  | "duplicateRate";

/** Which way is better. Getting one of these wrong makes the gate silently
 *  unfireable for that metric, so they are declared once and tested directly. */
export const METRIC_DIRECTION: Record<MetricKey, "higher" | "lower"> = {
  meanYield: "higher",
  zeroRate: "lower",
  dewpointAuc: "higher",
  altitudeAuc: "higher",
  throughput: "higher",
  duplicateRate: "lower",
};

export interface Provenance {
  model: string;
  backend: string;
  date: string;
  commit: string;
  machine: string;
}

export interface BaselineEntry {
  mean: number;
  stddev: number;
  n: number;
}

export interface Baseline {
  provenance: Provenance;
  metrics: Partial<Record<MetricKey, BaselineEntry>>;
}

export interface Comparison {
  metric: string;
  observed: number;
  baseline: number | null;
  delta: number | null;
  threshold: number | null;
  verdict: "pass" | "fail" | "skipped";
}

export interface GateResult {
  comparisons: Comparison[];
  /** False when provenance drifted; the run reports but cannot fail. */
  gated: boolean;
  staleReason?: string;
  passed: boolean;
}

export function compareToBaseline(
  observed: Record<string, number>,
  baseline: Baseline,
  provenance: Provenance,
  sigmas = 2,
): GateResult {
  let staleReason: string | undefined;
  if (baseline.provenance.model !== provenance.model) {
    staleReason = `baseline model ${baseline.provenance.model} != ${provenance.model}`;
  } else if (baseline.provenance.backend !== provenance.backend) {
    staleReason = `baseline backend ${baseline.provenance.backend} != ${provenance.backend}`;
  }
  const gated = staleReason === undefined;

  const comparisons: Comparison[] = Object.entries(observed).map(([metric, value]) => {
    const entry = baseline.metrics[metric as MetricKey];
    if (!gated || !entry) {
      return { metric, observed: value, baseline: entry?.mean ?? null, delta: null, threshold: null, verdict: "skipped" };
    }
    const lowerIsBetter = METRIC_DIRECTION[metric as MetricKey] === "lower";
    const threshold = lowerIsBetter
      ? entry.mean + sigmas * entry.stddev
      : entry.mean - sigmas * entry.stddev;
    const failed = lowerIsBetter ? value > threshold : value < threshold;
    return {
      metric,
      observed: value,
      baseline: entry.mean,
      delta: value - entry.mean,
      threshold,
      verdict: failed ? "fail" : "pass",
    };
  });

  return {
    comparisons,
    gated,
    staleReason,
    passed: comparisons.every((c) => c.verdict !== "fail"),
  };
}
