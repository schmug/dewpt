// Ranking statistics shared by the spikes. Pure and dependency-free so both
// scripts/ and src/ can use them — there must be exactly one AUC in this
// codebase, or two spikes will quietly disagree about what a number means.

/** Probability a random positive outranks a random negative (Mann-Whitney U).
 *  1.0 = perfect ordering, 0.5 = chance, 0.0 = fully inverted.
 *
 *  Ties take the mid-rank, so two identical distributions score exactly 0.5
 *  rather than resolving by sort order. Embedding cosines tie only when two
 *  texts are byte-identical — rare in the axis spikes, but the normal case for
 *  a band spike where the model repeated itself across strangeness levels. */
export function auc(posScores: number[], negScores: number[]): number {
  if (posScores.length === 0 || negScores.length === 0) return NaN;

  const all = [...posScores.map((s) => ({ s, p: true })), ...negScores.map((s) => ({ s, p: false }))];
  all.sort((a, b) => a.s - b.s);

  let rankSum = 0;
  for (let i = 0; i < all.length; ) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.s === all[i]!.s) j++;
    // ranks are 1-based; every member of a tied run takes the run's mean rank
    const midRank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) if (all[k]!.p) rankSum += midRank;
    i = j + 1;
  }

  const n = posScores.length;
  return (rankSum - (n * (n + 1)) / 2) / (n * negScores.length);
}

/** Standardised mean difference — how far apart the two groups sit, in pooled
 *  standard deviations. Complements AUC: AUC says "ordered correctly", d says
 *  "and by a wide margin". */
export function cohensD(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) return NaN;
  const m = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const variance = (xs: number[]) => {
    const mu = m(xs);
    return xs.reduce((s, x) => s + (x - mu) ** 2, 0) / (xs.length - 1);
  };
  const pooled = Math.sqrt(((a.length - 1) * variance(a) + (b.length - 1) * variance(b)) / (a.length + b.length - 2));
  return (m(a) - m(b)) / (pooled || 1);
}
