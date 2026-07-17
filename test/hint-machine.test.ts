import { describe, expect, it } from "vitest";
import * as tsImpl from "../src/hint-machine";
import type { HintEvent, HintState } from "../src/hint-machine";

// The browser mirror is plain JS served raw from public/ (no build step), so
// it sits outside tsconfig's include; the cast pins it to the canonical
// module's surface and the whole suite runs against both to prevent drift.
// @ts-expect-error — public/hint-machine.js ships untyped
import * as browserImplUntyped from "../public/hint-machine.js";
const browserImpl = browserImplUntyped as typeof tsImpl;

/** Fold a sequence of events over the machine from a starting state. */
function walk(
  impl: typeof tsImpl,
  events: HintEvent[],
  from: HintState = "preSeed",
): HintState {
  return events.reduce((s, e) => impl.nextHintState(s, e), from);
}

describe.each([
  ["src/hint-machine.ts", tsImpl],
  ["public/hint-machine.js (browser mirror)", browserImpl],
])("hint machine — %s", (_name, impl) => {
  const { nextHintState, HINT_COPY, HINT_TIMEOUTS } = impl;

  describe("fresh-session walk (H0 → quiet)", () => {
    it("advances one state per demonstrated action", () => {
      let s: HintState = "preSeed";
      s = nextHintState(s, "seed");
      expect(s).toBe("seeded"); // H1
      s = nextHintState(s, "prospect");
      expect(s).toBe("prospected"); // H2
      s = nextHintState(s, "pin");
      expect(s).toBe("pinned"); // H3
      s = nextHintState(s, "slider");
      expect(s).toBe("slidersPointed"); // H3 retired, waiting on evaporation
      s = nextHintState(s, "evaporate");
      expect(s).toBe("recoverShown"); // H4
      s = nextHintState(s, "timeout");
      expect(s).toBe("quiet");
    });

    it("retires H3 on its 30 s timeout when no slider is touched", () => {
      expect(nextHintState("pinned", "timeout")).toBe("slidersPointed");
    });

    it("retires H4 on the first restore (action beats timeout)", () => {
      expect(nextHintState("recoverShown", "restore")).toBe("quiet");
    });
  });

  describe("out-of-order exploration", () => {
    it("fast-forwards past H2 when the user pins before prospecting", () => {
      expect(nextHintState("seeded", "pin")).toBe("pinned");
    });

    it("skips H4 when the user restores a ghost before H4 shows", () => {
      expect(nextHintState("slidersPointed", "restore")).toBe("quiet");
    });

    it("ignores evaporations before H3 has retired (H4 waits its turn)", () => {
      expect(nextHintState("seeded", "evaporate")).toBe("seeded");
      expect(nextHintState("prospected", "evaporate")).toBe("prospected");
      expect(nextHintState("pinned", "evaporate")).toBe("pinned");
    });

    it("ignores slider input outside H3", () => {
      expect(nextHintState("preSeed", "slider")).toBe("preSeed");
      expect(nextHintState("seeded", "slider")).toBe("seeded");
      expect(nextHintState("prospected", "slider")).toBe("prospected");
    });
  });

  describe("resume fast-forward", () => {
    it("a resumed session with anchors skips straight to H3", () => {
      // app.js replays one "pin" for a non-empty info.anchors
      expect(walk(impl, ["seed", "pin"])).toBe("pinned");
    });

    it("H3 retirement then the replayed evaporation reaches H4 immediately", () => {
      // app.js replays "evaporate" on entering slidersPointed when
      // info.evaporated was non-empty — H4's wait is skipped
      expect(walk(impl, ["seed", "pin", "slider", "evaporate"])).toBe(
        "recoverShown",
      );
    });
  });

  describe("taught users (cross-session localStorage flag)", () => {
    it("shows only the combined reminder, which times out to quiet", () => {
      let s: HintState = nextHintState("preSeed", "seedTaught");
      expect(s).toBe("reminder");
      s = nextHintState(s, "timeout");
      expect(s).toBe("quiet");
    });

    it("the reminder is not a curriculum: actions do not advance it", () => {
      for (const e of ["prospect", "pin", "slider", "evaporate", "restore"] as const) {
        expect(nextHintState("reminder", e)).toBe("reminder");
      }
    });
  });

  describe("quiet is terminal", () => {
    it("no event leaves quiet", () => {
      const events: HintEvent[] = [
        "seed",
        "seedTaught",
        "prospect",
        "pin",
        "slider",
        "evaporate",
        "restore",
        "timeout",
      ];
      for (const e of events) expect(nextHintState("quiet", e)).toBe("quiet");
    });
  });

  describe("copy and timeouts (decided verbatim in docs/ui-teaching-research.md)", () => {
    it("carries the decided line for every state", () => {
      expect(HINT_COPY.preSeed).toBe("enter a seed to begin condensation");
      expect(HINT_COPY.seeded).toBe(
        "click blank space to prospect — a pulse of stranger words",
      );
      expect(HINT_COPY.prospected).toBe(
        "click a word to pin it — pinned words never evaporate",
      );
      expect(HINT_COPY.pinned).toBe(
        "pins steer what condenses next · sliders set the weather",
      );
      expect(HINT_COPY.recoverShown).toBe(
        "faded words rest in evaporated — click to condense again",
      );
      expect(HINT_COPY.reminder).toBe(
        "click blank space to prospect · click a word to pin it",
      );
      expect(HINT_COPY.slidersPointed).toBe("");
      expect(HINT_COPY.quiet).toBe("");
    });

    it("times out H3 at 30 s, H4 at 20 s, the reminder at 15 s — nothing else", () => {
      expect(HINT_TIMEOUTS).toEqual({
        pinned: 30_000,
        recoverShown: 20_000,
        reminder: 15_000,
      });
    });
  });
});
