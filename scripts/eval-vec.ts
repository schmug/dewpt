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

/** Probability a random positive outranks a random negative (Mann-Whitney U).
 *  1.0 = perfect ordering, 0.5 = chance. */
export function auc(posScores: number[], negScores: number[]): number {
  const all = [
    ...posScores.map((s) => ({ s, p: true })),
    ...negScores.map((s) => ({ s, p: false })),
  ];
  all.sort((a, b) => a.s - b.s);
  let rankSum = 0;
  all.forEach((item, i) => {
    if (item.p) rankSum += i + 1;
  });
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
