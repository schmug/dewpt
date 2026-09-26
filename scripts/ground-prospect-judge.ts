// Pure pieces of the prospect-only ground spike (scripts/ground-prospect-spike.ts):
// its pre-registered bars and verdict, the exact validity-gate tail, and the
// neighbour diagnostics. Shared helpers (prompts, parsing, binomTail, shuffle)
// come from scripts/ground-judge.ts; that file's PASS and verdict belong to the
// INVALID 2026-09-24 run and stay untouched.

import { meanJaccard, type Verdict } from "./ground-judge";

// ── pre-registered verdict ──────────────────────────────────────────────────
// Fixed 2026-09-25, BEFORE any real run of this spike. Carried over from
// ground-judge.ts PASS where they apply. One deliberate change: the Jaccard bar
// covers only the two NON-neighbour group pairs per seed. The neighbouring pair
// sits on adjacent sub-themes by design, so its overlap is expected and is not
// hubness; it is printed as a diagnostic. Do not tune after seeing data; change
// these only in a commit that says so and why.

export const PROSPECT_PASS = {
  /** Attribution: correct group for >= 11 of 18 prospect trials (3 seeds x 3
   *  clusters x 2 bursts), three groups shown. P(X >= 11 | n=18, p=1/3) =
   *  0.0144. Two of each seed's three groups are neighbours, so 12 of the 18
   *  trials are the hard case. */
  attributeMin: 11,
  attributeN: 18,
  /** Hubness: mean top-10 Jaccard over the non-neighbour group pairs <= 0.25. */
  jaccardMax: 0.25,
  /** Instrument validity, not a pass bar. If any displayed position takes >= 12
   *  of 18 answers the run is INVALID. Under a judge whose answers are uniform
   *  over positions (a content-driven judge is, because order is shuffled), the
   *  chance of that is positionMaxTail(12, 18, 3) = 0.0118. */
  positionMax: 12,
} as const;

export interface ProspectTallies {
  attribute: { correct: number; judged: number; byPosition: number[] };
  /** Mean top-10 Jaccard over non-neighbour pairs, averaged across seeds. */
  jaccard: number;
}

export function prospectVerdict(t: ProspectTallies): Verdict {
  const maxP = Math.max(0, ...t.attribute.byPosition);
  if (maxP >= PROSPECT_PASS.positionMax) {
    return { outcome: "INVALID", reasons: [`judge answered one position ${maxP}/${PROSPECT_PASS.attributeN} times — position-driven, not content-driven`] };
  }
  const reasons: string[] = [];
  // Unjudged trials count as misses and stay in n (see ground-judge.ts verdict).
  if (t.attribute.correct < PROSPECT_PASS.attributeMin) {
    reasons.push(`attribution ${t.attribute.correct}/${PROSPECT_PASS.attributeN} < ${PROSPECT_PASS.attributeMin} (${PROSPECT_PASS.attributeN - t.attribute.judged} unjudged)`);
  }
  if (!(t.jaccard <= PROSPECT_PASS.jaccardMax)) reasons.push(`top-10 jaccard ${t.jaccard.toFixed(3)} > ${PROSPECT_PASS.jaccardMax}`);
  return { outcome: reasons.length === 0 ? "PASS" : "FAIL", reasons };
}

/** P(the busiest of m equiprobable positions gets >= k of n answers). Exact:
 *  1 - P(every position gets <= k-1), counted over multinomial compositions. */
export function positionMaxTail(k: number, n: number, m: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  const cap = k - 1;
  const invFact: number[] = [1];
  for (let i = 1; i <= n; i++) invFact[i] = invFact[i - 1]! / i;
  // g[t] = sum over compositions of t into the positions so far, each part <= cap, of prod 1/c!
  let g = new Array<number>(n + 1).fill(0);
  g[0] = 1;
  for (let pos = 0; pos < m; pos++) {
    const next = new Array<number>(n + 1).fill(0);
    for (let t = 0; t <= n; t++) {
      for (let c = 0; c <= Math.min(cap, t); c++) next[t]! += g[t - c]! * invFact[c]!;
    }
    g = next;
  }
  let nFact = 1;
  for (let i = 2; i <= n; i++) nFact *= i;
  const allUnder = (nFact * g[n]!) / Math.pow(m, n);
  return Math.max(0, 1 - allUnder);
}

/** Top-10 overlap for one seed, split by the design: `bar` averages the pairs
 *  that are NOT the neighbouring pair; `neighbour` is that pair alone. A group
 *  with no near plan (null) makes both NaN, which the verdict fails. */
export function jaccardSplit(sets: readonly (readonly number[] | null)[], neighbours: readonly [number, number]): { bar: number; neighbour: number } {
  if (sets.some((s) => s === null)) return { bar: NaN, neighbour: NaN };
  const full = sets as readonly (readonly number[])[];
  const isNeighbourPair = (i: number, j: number) =>
    (i === neighbours[0] && j === neighbours[1]) || (i === neighbours[1] && j === neighbours[0]);
  const others: number[] = [];
  for (let i = 0; i < full.length; i++) {
    for (let j = i + 1; j < full.length; j++) if (!isNeighbourPair(i, j)) others.push(meanJaccard([full[i]!, full[j]!]));
  }
  return {
    bar: others.length ? others.reduce((a, b) => a + b, 0) / others.length : NaN,
    neighbour: meanJaccard([full[neighbours[0]]!, full[neighbours[1]]!]),
  };
}

/** Diagnostic, not a bar: how the trials at the two neighbouring groups went,
 *  and how many of their misses went to the sibling group specifically. */
export function neighbourSummary(
  trials: readonly { group: number; picked: number | null }[],
  neighbours: readonly [number, number],
): { n: number; correct: number; intoSibling: number } {
  let n = 0, correct = 0, intoSibling = 0;
  for (const t of trials) {
    if (t.group !== neighbours[0] && t.group !== neighbours[1]) continue;
    n++;
    const sibling = t.group === neighbours[0] ? neighbours[1] : neighbours[0];
    if (t.picked === t.group) correct++;
    else if (t.picked === sibling) intoSibling++;
  }
  return { n, correct, intoSibling };
}
