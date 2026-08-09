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

/** Most lineages — rows — a board holds at once. `addSeed` refuses past it
 *  (surfaced as a 409, never a silent no-op) and `applySeedFan` trims a fan to
 *  the room left.
 *
 *  UNMEASURED, and the design doc says so: open question 5 records it as
 *  "bounded by legibility, exact value unmeasured", with "the mockups read
 *  comfortably at four rows" as the only observation anyone recorded
 *  (docs/superpowers/specs/2026-08-08-conveyor-board-design.md:316). 6 is a
 *  judgement call above that, and nobody has since read a full 6-row board and
 *  reported back. Anyone tuning it is tuning an unvalidated number, not
 *  overriding a measurement.
 *
 *  One piece of arithmetic to know before changing it — a consequence, not the
 *  reason 6 was picked: at SEED_FANOUT = 3 the cap is exactly two full fans, so
 *  two seeds fill the board and a third is refused before it can fan.
 *
 *  Not `CAP = 14` in public/field.js. That caps words on the field, a different
 *  surface with different meaning; the design doc cites it as the contrast this
 *  cap improves on ("the row count is the concurrency cap, which is legible in
 *  a way dewpt's CAP = 14 never was"), not as its source. */
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

/** Minimum time a card sits at a station before its next hop is requested.
 *
 *  This is the one place the conveyor design's "there is no fixed belt speed"
 *  (docs/superpowers/specs/2026-08-08-conveyor-board-design.md) is amended, and
 *  the amendment is narrow: the belt now waits on a CLOCK, which always
 *  expires, never on a specific generation, which may not. Nothing here can
 *  make the board block on an AI call.
 *
 *  `brisk` is 0 — the behaviour the board shipped with, where a card advances
 *  the instant its child lands. The slower presets exist because at that pace a
 *  lineage is born, cooked and gone in about eleven seconds, which is not
 *  readable. The two values are judgement calls about reading speed, not
 *  measurements; nothing in scripts/board-calibrate.ts speaks to them. */
export const BELT_SPEEDS = {
  brisk: { hopDwellMs: 0 },
  steady: { hopDwellMs: 3000 },
  slow: { hopDwellMs: 8000 },
} as const;

export type BeltSpeed = keyof typeof BELT_SPEEDS;

/** Not `brisk`. This CHANGES the pace of every board, and deliberately: brisk
 *  is what shipped and its unreadability is the reason these controls exist. */
export const DEFAULT_BELT_SPEED: BeltSpeed = "steady";

/** `hasOwnProperty.call`, not `value in BELT_SPEEDS` and not an undefined
 *  check. Both of those pass for "constructor" and "toString", which then index
 *  to a function whose `.hopDwellMs` is undefined — a NaN dwell, against which
 *  every comparison is false, so no lineage is ever hungry and the board stops
 *  with no error anywhere. */
export function isBeltSpeed(value: unknown): value is BeltSpeed {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BELT_SPEEDS, value);
}

export function hopDwellMs(speed: BeltSpeed): number {
  return BELT_SPEEDS[speed].hopDwellMs;
}

/** The board's control state, as it appears on the wire. `paused` is derived
 *  from the belt clock rather than stored beside it, so the two can never
 *  disagree. */
export interface BoardControls {
  speed: BeltSpeed;
  paused: boolean;
}
