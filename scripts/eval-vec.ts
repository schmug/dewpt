// Vector math and ranking metrics for the generation eval suite. NO node APIs
// and no imports of modules that use them: test/eval-vec.test.ts pulls this
// file's whole import graph into tsconfig.json, which sets "types": []. All I/O
// lives in eval.ts and eval-matrix.ts.

export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

export function norm(v: number[]): number {
  return Math.sqrt(dot(v, v));
}

export function sub(a: number[], b: number[]): number[] {
  return a.map((x, i) => x - b[i]!);
}

export function mean(vs: number[][]): number[] {
  const out = new Array(vs[0]!.length).fill(0);
  for (const v of vs) for (let i = 0; i < v.length; i++) out[i] += v[i]!;
  return out.map((x) => x / vs.length);
}

export function cosine(a: number[], b: number[]): number {
  return dot(a, b) / (norm(a) * norm(b) || 1);
}

// Ranking metrics live in src/metrics.ts, which band-spike.ts also uses: there
// must be exactly one AUC in this codebase, or two spikes quietly disagree
// about what a number means. Re-exported so this module stays the single import
// site for the eval suite's maths.
//
// That module already applies the average-rank tie correction this suite needs.
// Without it, a stable sort hands every tie to the negatives and a total tie
// reads 0.0 — "inverted signal" rather than "no signal", and a knife-edge where
// one ulp of separation flips it to 1.0. Ties are routine here: a model
// emitting the same word twice yields identical embeddings, hence identical
// scores. src/metrics.ts additionally returns NaN for an empty group rather
// than dividing by zero.
export { auc, cohensD } from "../src/metrics";
