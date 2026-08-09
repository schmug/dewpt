// Embedding-based metrics for the generation eval suite. NO node APIs and no
// imports of modules that use them: test/eval-embed-metrics.test.ts pulls this
// file's whole import graph into tsconfig.json, which sets "types": []. Both
// imports below are pure. All I/O lives in eval.ts and eval-matrix.ts.

import { auc, cosine, norm } from "./eval-vec";
import { DEDUPE_COSINE } from "../src/types";

/** Thrown when an input cannot yield a meaningful metric. Every metric here is
 *  compared against a gate threshold downstream, and both 0 and NaN sail
 *  through a lower-is-better gate — so a bad input has to stop the run, never
 *  become a number. */
export class EvalMetricError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalMetricError";
  }
}

/** Validates one vector against the dimension already fixed by an earlier
 *  argument (`expected`, or null if this vector fixes it) and returns it. */
function checkVector(label: string, v: number[], expected: number | null): number {
  if (v.length === 0) {
    throw new EvalMetricError(`${label} is empty: a 0-dimensional vector has no direction`);
  }
  if (expected !== null && v.length !== expected) {
    throw new EvalMetricError(
      `dimension mismatch: ${label} has ${v.length} dimensions, expected ${expected}. ` +
        `eval-vec's dot() would read past the shorter vector or silently truncate the longer one.`,
    );
  }
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i])) {
      throw new EvalMetricError(`${label}[${i}] is not finite (${v[i]})`);
    }
  }
  // An all-zero vector is what an embedding backend returns when it errors out,
  // and it clears every check above: non-empty, right dimension, all finite.
  // eval-vec's cosine divides by `norm(a) * norm(b) || 1`, so the zero denominator
  // yields a clean 0 rather than NaN — which reads as "maximally distinct" and
  // launders a broken batch into a perfect duplicate rate and a flat AUC.
  if (norm(v) === 0) {
    throw new EvalMetricError(
      `${label} is all zeros: it has no direction, and cosine's divide-by-zero guard ` +
        `would score it 0 against everything rather than failing`,
    );
  }
  return v.length;
}

/** Validates a labelled group of vectors and returns the dimension they share. */
function checkGroup(label: string, vs: number[][], expected: number | null): number {
  if (vs.length === 0) {
    throw new EvalMetricError(`${label} is empty: a metric over an empty set is undefined, not 0`);
  }
  let dim = expected;
  for (let i = 0; i < vs.length; i++) dim = checkVector(`${label}[${i}]`, vs[i], dim);
  return dim as number;
}

/** Does the dewpoint slider mean anything? Scores every word by the same
 *  seedDist the pool computes (pool-core.ts:191) and asks whether tier-2 words
 *  outrank tier-0 ones. 0.5 means the slider does nothing. */
export function dewpointAuc(seedVec: number[], nearVecs: number[][], farVecs: number[][]): number {
  const dim = checkVector("seedVec", seedVec, null);
  checkGroup("nearVecs", nearVecs, dim);
  checkGroup("farVecs", farVecs, dim);
  const seedDist = (v: number[]) => 1 - cosine(seedVec, v);
  return auc(farVecs.map(seedDist), nearVecs.map(seedDist));
}

/** Same question for altitude, projecting onto the production-built
 *  concrete->abstract axis rather than onto distance from the seed. */
export function altitudeAuc(axis: number[], concreteVecs: number[][], abstractVecs: number[][]): number {
  const dim = checkVector("axis", axis, null);
  checkGroup("concreteVecs", concreteVecs, dim);
  checkGroup("abstractVecs", abstractVecs, dim);
  const project = (v: number[]) => cosine(axis, v);
  return auc(abstractVecs.map(project), concreteVecs.map(project));
}

/** Fraction of a batch the pool would throw away as near-duplicates. Replays
 *  the pool's own admission loop (pool-core.ts:180-186): walk the batch in
 *  order and compare each word only against the words already ADMITTED — a
 *  rejected near-duplicate `continue`s without entering the pool, so it never
 *  becomes a comparison target for anything after it. Comparing against all
 *  earlier words instead would let one reject cascade down a chain and inflate
 *  the rate — by a widening margin as the batch grows.
 *
 *  Within-batch only: the real pool also checks existing entries and anchors,
 *  but that is session state, not model quality. */
export function duplicateRate(vectors: number[][], threshold: number = DEDUPE_COSINE): number {
  checkGroup("vectors", vectors, null);
  // Range, not finiteness: cosine is bounded to [-1, 1], so any threshold above
  // 1 is unreachable and reports a flawless 0 for a batch of literal duplicates
  // — exactly what a NaN threshold does. `!(a && b)` also rejects NaN, which
  // compares false against both bounds.
  //
  // The interval is half-open, and deliberately asymmetric. The comparison
  // below is strict `>`, and cosine is bounded ABOVE by 1, so a threshold of
  // exactly 1 flags nothing — the same fail-open, one ulp inside a closed
  // range. -1 stays legal because cosine attains it and a threshold of -1
  // flags every pair except an exactly antipodal one: over-strict, which is
  // fail-closed and gives a lower-is-better gate nothing to hide behind.
  if (!(threshold >= -1 && threshold < 1)) {
    throw new EvalMetricError(
      `threshold is outside cosine's usable [-1, 1) range (${threshold}): no pair could ever exceed it`,
    );
  }
  const admitted: number[][] = [];
  let duplicates = 0;
  for (const v of vectors) {
    if (admitted.some((a) => cosine(a, v) > threshold)) duplicates++;
    else admitted.push(v);
  }
  return duplicates / vectors.length;
}
