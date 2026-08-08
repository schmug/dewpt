// Conveyor board types and constants. Vocabulary note (SPEC.md): the board's
// nouns are station / lineage / ghost / edge / harvest. The weather terms
// belong to the field; prompts use plain concepts.

/** One station on the belt — a user-named direction, expanded to a
 *  descriptive phrase before embedding. A bare term costs ~0.34 AUC to
 *  polysemy (docs/latent-space-navigation-design.md), so `phrase` is never
 *  optional and `expanded: false` must stay visible. */
export interface Station {
  id: string;
  order: number;
  term: string;
  phrase: string;
  expanded: boolean;
  embedding: number[] | null;
}

export interface Card {
  id: string;
  text: string;
  /** 0 = the seed column. A card at index k has passed k stations. */
  stationIndex: number;
  bornAt: number;
  embedding: number[] | null;
}

export interface Lineage {
  id: string;
  seedText: string;
  /** cards[0] is the seed; the last element is the live head, the rest ghosts. */
  cards: Card[];
  /** Consecutive failed hops. At MAX_HOP_FAILURES the lineage is released. */
  failures: number;
  arrivedAt: number | null;
  /** Set when the head passes the last station; evicted EDGE_DWELL_MS later. */
  edgeAt: number | null;
}

export interface EvaporatedCard {
  text: string;
  evaporatedAt: number;
}

export const DEFAULT_STATION_TERMS = ["concretize", "make strange", "ground it"];

/** Legibility cap — the board's CAP = 14. The mockups read comfortably at
 *  four rows; this is bounded by readability, not by frame rate. */
export const MAX_LINEAGES = 6;

/** Children requested from a seed's first hop. One call, so a fresh board with
 *  a single seed is never gated on one generation. */
export const SEED_FANOUT = 3;

/** How long a head dwells at the edge before evaporating. A legibility pause
 *  (long enough to read and, from M3, to pin), not a tuning knob. */
export const EDGE_DWELL_MS = 6000;

/** Consecutive failed hops before a lineage is released to the edge. A
 *  permanently stuck card is indistinguishable from a slow one. */
export const MAX_HOP_FAILURES = 3;

/** Ghosts kept behind the head. Older ones are dropped from the wire entirely. */
export const GHOST_DEPTH = 3;

export const EVAPORATED_CAP = 20;

// ── calibrated in M0, 2026-08-08 ───────────────────────────────────────────
// Measured by `npm run board-calibrate`. Raw output committed verbatim at
// docs/measurements/2026-08-08-m0-calibration-run{1,2}.md — read those before
// changing any value here, and re-run the spike after changing the rewrite
// prompt, since every number below is measured through it.
//
// The M0 gate PASSED: tether separation AUC 0.853 against a 0.80 bar,
// reproduced identically on both runs.

/** Minimum cosine against the parent for a rewrite to still be a rewrite
 *  rather than a non-sequitur. The linear-interpolated 5th percentile of 15
 *  hand-written genuine rewrites — deliberately not their minimum, which
 *  retains 100% by construction and moves with one bad probe.
 *
 *  KNOWN WEAK. At this value 93% of genuine rewrites survive but 53% of
 *  non-sequiturs do too: the distributions barely separate (genuine p50 0.463,
 *  non-sequitur p50 0.400). It is the weakest number in the calibration, and
 *  the sample is 15 hand-written probes, at which size a p05 still swings on a
 *  single bad one. Widen PROBES in the spike before treating it as precise. */
export const TETHER_FLOOR = 0.4;

/** Cosine at which a card has effectively reached a station's phrase, so that
 *  direction has nothing left to give. Set above the interpolated p95 of
 *  observed rewrite-to-phrase cosines (p50 0.432, p95 0.578, max 0.579), so an
 *  ordinary hop never false-reports arrival.
 *
 *  Deliberately NOT DEGENERATE_POLE_COSINE (0.98) from src/types.ts — that was
 *  tuned pole-against-pole and does not transfer to card-against-phrase. The
 *  measured gap between them, 0.35, is the size of the mistake that assumption
 *  would have been. */
export const ARRIVAL_COSINE = 0.628;

/** Candidates requested per hop, before tether and dedupe filtering. The
 *  smallest measured width where every probe still left at least 3 candidates
 *  above the floor — 3 rather than 1 because selectChild then drops
 *  near-duplicates of the lineage's own history, so a hop needs spares.
 *
 *  Survivor count is still rising at n=8 and n=12; that does not argue for a
 *  larger value, because the criterion is a sufficiency threshold rather than a
 *  maximum. Caveat: ONE generation draw per (width, probe) at temperature 0.9,
 *  i.e. 3 samples per width, so this will move run to run. Read it as "this
 *  width sufficed on one draw", not as a stable estimate. */
export const CANDIDATES_PER_HOP = 4;
