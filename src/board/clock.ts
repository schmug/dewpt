// The belt clock. Monotonic time for one board session: it advances 1:1 with
// real time while the board runs and stops dead while it is paused.
//
// This exists because EDGE_DWELL_MS is measured against a clock. If pause were
// merely a flag that stopped the pump, real time would keep running underneath
// it, and a board paused for thirty seconds would evaporate every edge-parked
// lineage the instant it resumed — pause would destroy exactly the cards it was
// invoked to let someone read.
//
// Freezing the clock instead means BeltCore learns nothing about pause: tick()
// against a frozen time is idempotent by construction, so there is no
// pause-handling branch in the tick path to get wrong.

export interface ClockState {
  /** Belt-time reading at the last start/stop boundary. */
  base: number;
  /** Real-time anchor while running; null while paused.
   *
   *  Absolute rather than a duration, so the clock survives Durable Object
   *  hibernation and isolate eviction with no per-tick write: a board that is
   *  simply running never writes its clock at all. */
  since: number | null;
}

/** A running clock reading `realNow`.
 *
 *  Seeded from the real clock rather than from zero, and that is a migration
 *  decision rather than an arbitrary origin: boards created before this feature
 *  hold bornAt/edgeAt values in epoch ms. A belt clock starting at zero would
 *  put every one of those ~1.7e12 in the future, so no dwell would ever elapse
 *  and no lineage would ever be evicted. Starting at the epoch makes belt time
 *  continuous with what is already stored, and no migration is needed. */
export function startedClock(realNow: number): ClockState {
  return { base: realNow, since: realNow };
}

export function isPaused(clock: ClockState): boolean {
  return clock.since === null;
}

/** Belt time now.
 *
 *  The `Math.max(0, …)` is not defensive dressing. A backward host-clock jump
 *  that rewound belt time would drive `now - edgeAt` negative, and an
 *  edge-parked lineage that can never reach EDGE_DWELL_MS never evaporates —
 *  ephemerality stops holding, silently. */
export function beltNow(clock: ClockState, realNow: number): number {
  if (clock.since === null) return clock.base;
  return clock.base + Math.max(0, realNow - clock.since);
}

/** Freeze. Idempotent: pausing a paused clock reads `base` back out unchanged. */
export function pauseClock(clock: ClockState, realNow: number): ClockState {
  if (clock.since === null) return clock;
  return { base: beltNow(clock, realNow), since: null };
}

/** Unfreeze, re-anchoring to the current real time so the paused interval is
 *  simply not counted.
 *
 *  The already-running guard is load-bearing. Without it a second resume — two
 *  viewers of the same board URL, or one retried request — re-anchors `since`
 *  to now while leaving `base` where it was, and belt time jumps BACKWARDS by
 *  however long the board had been running. Every dwell would restart and every
 *  edge-parked lineage would be reprieved. */
export function resumeClock(clock: ClockState, realNow: number): ClockState {
  if (clock.since !== null) return clock;
  return { base: clock.base, since: realNow };
}
