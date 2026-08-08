// Rewrite scoring for the conveyor board.
//
// A direction needs two poles. THE PARENT CARD IS THE NEGATIVE POLE and the
// station phrase is the positive one, so the intended move is
// `phrase - parent` and a candidate is judged by how much of its own
// displacement lands along it. This keeps the pair construction the axis spike
// measured at mean AUC 0.843 against 0.763 for a single term — scoring
// candidates against the phrase embedding alone is the weaker construction and
// looks identical from the outside.

import { axisVector, coordsFor } from "../axis-core";
import { cosineSim } from "../pool-core";
import { DEDUPE_COSINE } from "../types";
import { ARRIVAL_COSINE, TETHER_FLOOR } from "./types";

export interface Candidate {
  text: string;
  embedding: number[];
}

export interface ScoredCandidate extends Candidate {
  /** COSINE between the candidate's displacement and the intended direction —
   *  alignment, not distance. Higher means better aimed, NOT further travelled:
   *  a tiny nudge exactly along `phrase - parent` outscores a large, mostly
   *  aligned move. That is deliberate (it is also what `coordsFor` does for the
   *  field, raw on purpose), and it is why the tether floor is a floor rather
   *  than part of the score — the two pull in opposite directions and must stay
   *  separable. Whether alignment-only selection actually makes a chain
   *  progress rather than crawl is measured by scripts/board-calibrate.ts. */
  score: number;
  /** Cosine against the parent. Low means the "rewrite" drifted off-topic. */
  tether: number;
}

export function scoreCandidates(
  parentEmb: number[],
  phraseEmb: number[],
  candidates: Candidate[],
): ScoredCandidate[] {
  const stationVec = axisVector(parentEmb, phraseEmb);
  return candidates.map((c) => ({
    ...c,
    score: coordsFor(axisVector(parentEmb, c.embedding), [stationVec])[0] ?? 0,
    tether: cosineSim(c.embedding, parentEmb),
  }));
}

export interface SelectOptions {
  tetherFloor?: number;
  dedupeCosine?: number;
  /** Embeddings the child must not near-duplicate: the lineage's own history
   *  plus anything else the caller wants excluded. */
  exclude?: number[][];
}

/** Highest-scoring candidate that clears the tether floor and duplicates
 *  nothing excluded. Returns null when none qualify — the caller retries or
 *  releases the lineage. It must NEVER lower the floor to find a winner; that
 *  turns a quality guard into a no-op. */
export function selectChild(
  parentEmb: number[],
  phraseEmb: number[],
  candidates: Candidate[],
  opts: SelectOptions = {},
): ScoredCandidate | null {
  const floor = opts.tetherFloor ?? TETHER_FLOOR;
  const dedupe = opts.dedupeCosine ?? DEDUPE_COSINE;
  const exclude = opts.exclude ?? [];
  let best: ScoredCandidate | null = null;
  for (const c of scoreCandidates(parentEmb, phraseEmb, candidates)) {
    if (c.tether < floor) continue;
    if (exclude.some((e) => cosineSim(e, c.embedding) > dedupe)) continue;
    if (best === null || c.score > best.score) best = c;
  }
  return best;
}

/** True when the card has effectively reached the station's phrase, so this
 *  direction is exhausted for this idea. Not a failure — information. */
export function hasArrived(
  parentEmb: number[],
  phraseEmb: number[],
  arrivalCosine: number = ARRIVAL_COSINE,
): boolean {
  return cosineSim(parentEmb, phraseEmb) >= arrivalCosine;
}
