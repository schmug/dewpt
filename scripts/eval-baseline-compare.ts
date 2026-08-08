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
  /** Null whenever no threshold was applied — every skip, and the two failure
   *  modes (unusable observation, unusable baseline) that never got that far. */
  threshold: number | null;
  verdict: "pass" | "fail" | "skipped";
  /** Why this metric was skipped, or why it failed without a threshold. */
  reason?: string;
}

export interface GateResult {
  comparisons: Comparison[];
  /** False when provenance drifted; the run reports but cannot fail. */
  gated: boolean;
  staleReason?: string;
  /** Observed keys with no entry in METRIC_DIRECTION. Never gated: the
   *  comparator has no direction for them and will not guess one. Non-empty
   *  means the caller is measuring something this gate cannot judge. */
  unknownMetrics: string[];
  /** How many comparisons applied a threshold, and how many did not. `passed`
   *  alone cannot distinguish a real green from a run where nothing was
   *  compared, so the consumer prints "N of M metrics checked". */
  checked: number;
  skipped: number;
  passed: boolean;
}

const hasOwn = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key);

/** Own-property lookups only. `METRIC_DIRECTION["toString"]` inherits a
 *  function from Object.prototype — truthy, and not `undefined` — which walks
 *  straight past both an `!entry` skip and an `=== undefined` direction check. */
function directionOf(metric: string): "higher" | "lower" | undefined {
  return hasOwn(METRIC_DIRECTION, metric) ? METRIC_DIRECTION[metric as MetricKey] : undefined;
}

/** `| null` is not in `Baseline`, and that is the point: the caller parses
 *  eval-baseline.json off disk, where `"dewpointAuc": null` is a shape
 *  hand-editing produces and the type cannot prevent. */
function entryOf(baseline: Baseline, metric: string): BaselineEntry | null | undefined {
  return hasOwn(baseline.metrics, metric) ? baseline.metrics[metric as MetricKey] : undefined;
}

export function compareToBaseline(
  observed: Partial<Record<MetricKey, number>>,
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

  // `machine` scopes to throughput alone rather than dropping the whole run to
  // report-only: throughput is wall-clock, so it is the one metric a different
  // machine invalidates. Yield, the AUCs and duplicate rate are model-dependent
  // and stay perfectly comparable across machines — silencing them on a machine
  // change would throw away most of the gate. `date` and `commit` are
  // deliberately not staleness inputs: a commit change is what we gate on.
  const machineReason =
    baseline.provenance.machine !== provenance.machine
      ? `throughput is wall-clock; baseline machine ${baseline.provenance.machine} != ${provenance.machine}`
      : undefined;

  const unknownMetrics: string[] = [];

  const comparisons: Comparison[] = Object.entries(observed).map(([metric, raw]): Comparison => {
    // An explicitly-undefined key is an observation that failed to compute,
    // which the non-finite rule below treats as a failure rather than a zero.
    const value = raw ?? NaN;
    const entry = entryOf(baseline, metric);
    // Loose `!=` deliberately: a null entry has to reach the corrupt-baseline
    // guard below, and `null !== undefined` walks it straight into `.mean`.
    const mean = entry != null && Number.isFinite(entry.mean) ? entry.mean : null;
    // Deltas print on every run, gated or not: report-only mode is the exact
    // mode meant to answer "what changed when I switched models". A threshold,
    // in contrast, is only reported when one was actually applied.
    const delta = mean !== null && Number.isFinite(value) ? value - mean : null;
    const report = (verdict: Comparison["verdict"], reason: string): Comparison => ({
      metric,
      observed: value,
      baseline: mean,
      delta,
      threshold: null,
      verdict,
      reason,
    });

    const direction = directionOf(metric);
    if (direction === undefined) {
      unknownMetrics.push(metric);
      return report("skipped", `no direction declared for "${metric}"`);
    }
    if (!gated) return report("skipped", staleReason!);
    if (metric === "throughput" && machineReason !== undefined) {
      return report("skipped", machineReason);
    }
    if (entry === undefined) return report("skipped", "no baseline entry");
    // A corrupt baseline is not a green light. Without this, a missing stddev
    // makes the threshold NaN and every comparison against it passes.
    if (entry === null || !Number.isFinite(entry.mean) || !Number.isFinite(entry.stddev)) {
      return report("fail", `corrupt baseline entry: mean=${entry?.mean} stddev=${entry?.stddev}`);
    }
    // A metric that failed to compute is a failure, not a pass: every NaN
    // comparison is false, so an unguarded NaN can never trip `failed`.
    if (!Number.isFinite(value)) {
      return report("fail", `observed value is not finite (${value})`);
    }

    // The first recorded baseline comes from a single run, so stddev is 0 for
    // every metric and the raw band admits only bit-exact equality — a 1e-15
    // drift would fail the gate. Floor it, but ONLY for such a degenerate
    // baseline. Unconditionally, the relative term dominates for any mean above
    // 0.25: a dewpointAuc stddev of 0.001 became 0.0172 (17.2x), a thirty-sigma
    // 0.86 -> 0.83 drop reported "pass", and no n could ever make the gate
    // sharper than +-3.4% of the mean. A baseline with n >= 2 and a real spread
    // has measured its own noise; using it is what lets the gate keep
    // tightening as n grows. Ordering matters: the guard above has already
    // rejected a non-finite mean or stddev, so `degenerate` only has to decide
    // between "no measurement" and "a measurement".
    const degenerate = !(entry.n >= 2) || !(entry.stddev > 0);
    // The relative term (2% of the mean) scales with unbounded metrics like
    // throughput (~14 candidates/sec); the absolute term covers metrics in
    // [0,1] — the AUCs and the rates — where 2% of a small mean is itself
    // smaller than the run-to-run noise.
    const sigma = degenerate
      ? Math.max(entry.stddev, 0.02 * Math.abs(entry.mean), 0.005)
      : entry.stddev;
    const threshold =
      direction === "lower" ? entry.mean + sigmas * sigma : entry.mean - sigmas * sigma;
    const failed = direction === "lower" ? value > threshold : value < threshold;
    return {
      metric,
      observed: value,
      baseline: entry.mean,
      delta: value - entry.mean,
      threshold,
      verdict: failed ? "fail" : "pass",
    };
  });

  const skipped = comparisons.filter((c) => c.verdict === "skipped").length;

  return {
    comparisons,
    gated,
    staleReason,
    unknownMetrics,
    checked: comparisons.length - skipped,
    skipped,
    passed: comparisons.every((c) => c.verdict !== "fail"),
  };
}
