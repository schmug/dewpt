// Browser mirror of src/hint-machine.ts — the progressive hint state machine
// (issue #9). The client is served raw from public/ with no build step, so the
// canonical TypeScript module can't be imported here; keep the two files in
// lockstep. test/hint-machine.test.ts runs the identical suite against both,
// so behavioral drift fails CI. See src/hint-machine.ts for the full state
// docs; copy and timeouts are decided verbatim in docs/ui-teaching-research.md.

/** @typedef {'preSeed'|'seeded'|'prospected'|'pinned'|'slidersPointed'|'recoverShown'|'reminder'|'quiet'} HintState */
/** @typedef {'seed'|'seedTaught'|'prospect'|'pin'|'slider'|'evaporate'|'restore'|'timeout'} HintEvent */

/** The one line shown per state (empty string = the hint is blank).
 *  @type {Record<HintState, string>} */
export const HINT_COPY = {
  preSeed: "enter a seed to begin condensation",
  seeded: "click blank space to prospect — a pulse of stranger words",
  prospected: "click a word to pin it — pinned words never evaporate",
  pinned: "pins steer what condenses next · sliders set the weather",
  slidersPointed: "",
  recoverShown: "faded words rest in evaporated — click to condense again",
  reminder: "click blank space to prospect · click a word to pin it",
  quiet: "",
};

/** States that retire themselves; ms until the caller sends "timeout".
 *  @type {Partial<Record<HintState, number>>} */
export const HINT_TIMEOUTS = {
  pinned: 30000, //       H3: retire even if the sliders are never touched
  recoverShown: 20000, // H4
  reminder: 15000, //     taught-user one-liner
};

/** @type {Partial<Record<HintState, Partial<Record<HintEvent, HintState>>>>} */
const TRANSITIONS = {
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

/** Advance the hint machine; unrecognized (state, event) pairs are no-ops.
 *  @param {HintState} state
 *  @param {HintEvent} event
 *  @returns {HintState} */
export function nextHintState(state, event) {
  return (TRANSITIONS[state] && TRANSITIONS[state][event]) || state;
}
