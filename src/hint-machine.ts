// Progressive hint state machine (issue #9): the single .hint line advances as
// the user demonstrates each interaction, then goes quiet — permanently. Pure
// state + event → state so vitest can walk every path; all side effects
// (timers, the localStorage taught flag, live-region mirroring, the resume
// replay of pin/evaporate) live in public/app.js.
//
// States mirror the H-table decided in docs/ui-teaching-research.md
// § "Progressive hint script (layer 2 — #9)"; every line of copy and both
// timeout values are taken from there verbatim.
//
// public/hint-machine.js is this module's browser mirror — the client is
// served raw from public/ with no build step, so the logic exists twice.
// test/hint-machine.test.ts runs the identical suite against both files to
// keep them from drifting.

export type HintState =
  | "preSeed" //        H0 — enter a seed…
  | "seeded" //         H1 — prospect line
  | "prospected" //     H2 — pin line
  | "pinned" //         H3 — pins steer · sliders set the weather
  | "slidersPointed" // H3 retired; line empty, waiting on an evaporation
  | "recoverShown" //   H4 — evaporated-recovery line
  | "reminder" //       taught users: combined one-liner, then quiet
  | "quiet"; //         empty, permanently

export type HintEvent =
  | "seed" //       fresh session start
  | "seedTaught" // session start with the cross-session taught flag set
  | "prospect" //   first prospect (field onProspect)
  | "pin" //        first pin (onPin); also replayed on resume for info.anchors
  | "slider" //     first slider input
  | "evaporate" //  an evaporation (only heard while waiting in slidersPointed)
  | "restore" //    evaporated-sidebar restore click
  | "timeout"; //   the active state's own timer elapsed

/** The one line shown per state (empty string = the hint is blank). */
export const HINT_COPY: Record<HintState, string> = {
  preSeed: "enter a seed to begin condensation",
  seeded: "click blank space to prospect — a pulse of stranger words",
  prospected: "click a word to pin it — pinned words never evaporate",
  pinned: "pins steer what condenses next · sliders set the weather",
  slidersPointed: "",
  recoverShown: "faded words rest in evaporated — click to condense again",
  reminder: "click blank space to prospect · click a word to pin it",
  quiet: "",
};

/** States that retire themselves; ms until the caller sends "timeout". */
export const HINT_TIMEOUTS: Partial<Record<HintState, number>> = {
  pinned: 30_000, //       H3: retire even if the sliders are never touched
  recoverShown: 20_000, // H4
  reminder: 15_000, //     taught-user one-liner
};

const TRANSITIONS: Partial<Record<HintState, Partial<Record<HintEvent, HintState>>>> = {
  preSeed: { seed: "seeded", seedTaught: "reminder" },
  // pin from seeded fast-forwards past H2 — pinning was just demonstrated
  seeded: { prospect: "prospected", pin: "pinned" },
  prospected: { pin: "pinned" },
  pinned: { slider: "slidersPointed", timeout: "slidersPointed" },
  // restore here means the user recovered a ghost before H4 ever showed —
  // the lesson is demonstrated, skip it (action-retires always win)
  slidersPointed: { evaporate: "recoverShown", restore: "quiet" },
  recoverShown: { timeout: "quiet", restore: "quiet" },
  reminder: { timeout: "quiet" }, // reminder, not curriculum: only time retires it
  // quiet: terminal
};

/** Advance the hint machine; unrecognized (state, event) pairs are no-ops. */
export function nextHintState(state: HintState, event: HintEvent): HintState {
  return TRANSITIONS[state]?.[event] ?? state;
}
