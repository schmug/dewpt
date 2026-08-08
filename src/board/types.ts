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

// ── calibrated in M0 (scripts/board-calibrate.ts) ──────────────────────────
// The values below are the pre-calibration defaults used to get Task 1
// compiling. Task 2 replaces them with measured numbers and records the
// evidence. Do not ship on these.

/** Minimum cosine against the parent for a rewrite to still be a rewrite
 *  rather than a non-sequitur. */
export const TETHER_FLOOR = 0.5;

/** Cosine at which a card has effectively reached a station's phrase, so that
 *  direction has nothing left to give. NOTE: this is deliberately NOT
 *  DEGENERATE_POLE_COSINE (0.98) from src/types.ts — that constant was tuned
 *  pole-against-pole and does not transfer to card-against-phrase. */
export const ARRIVAL_COSINE = 0.9;

/** Candidates requested per hop, before tether and dedupe filtering. */
export const CANDIDATES_PER_HOP = 8;
