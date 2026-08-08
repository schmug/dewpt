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

/** Probability a random positive outranks a random negative, counting a tie as
 *  half a win (Mann-Whitney U with average ranks). 1.0 = perfect ordering,
 *  0.5 = chance, 0.0 = perfectly inverted.
 *
 *  Tied scores all receive the mean of the ranks they span, so identical data
 *  scores 0.5. Without that correction the stable sort hands every tie to the
 *  negatives and a total tie reads 0.0 — "inverted signal" rather than "no
 *  signal", and a knife-edge: one ulp of separation flips it to 1.0. Ties are
 *  routine here, since a model emitting the same word twice yields identical
 *  embeddings and hence identical scores. */
export function auc(posScores: number[], negScores: number[]): number {
  const all = [
    ...posScores.map((s) => ({ s, p: true })),
    ...negScores.map((s) => ({ s, p: false })),
  ];
  all.sort((a, b) => a.s - b.s);
  let rankSum = 0;
  for (let i = 0; i < all.length; ) {
    // [i, j] is the run of equal scores; every member takes the run's mean rank.
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.s === all[i]!.s) j++;
    // Ranks are 1-based, so the run spans i+1..j+1 and averages to (i+j+2)/2.
    // A run of one gives exactly i+1, keeping tie-free input bit-identical.
    const avgRank = (i + j + 2) / 2;
    for (let k = i; k <= j; k++) if (all[k]!.p) rankSum += avgRank;
    i = j + 1;
  }
  return (rankSum - (posScores.length * (posScores.length + 1)) / 2) / (posScores.length * negScores.length);
}

/** Standardised mean difference — how far apart two groups sit, in pooled
 *  standard deviations. AUC says "ordered correctly", d says "by a wide margin". */
export function cohensD(a: number[], b: number[]): number {
  const m = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const variance = (xs: number[]) => {
    const mu = m(xs);
    return xs.reduce((s, x) => s + (x - mu) ** 2, 0) / (xs.length - 1);
  };
  const pooled = Math.sqrt(
    ((a.length - 1) * variance(a) + (b.length - 1) * variance(b)) / (a.length + b.length - 2),
  );
  return (m(a) - m(b)) / (pooled || 1);
}
