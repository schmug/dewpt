# Board Speed and Pause Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the `/board` surface a three-preset speed control and a pause toggle that genuinely stops the belt — including the metered generation behind it — without destroying the cards it was invoked to let you read.

**Architecture:** Pause is a **frozen belt clock**, not a flag. A new pure module `src/board/clock.ts` produces a monotonic belt time that advances 1:1 with real time while running and stops while paused; `BoardDO` feeds that time to `BeltCore` everywhere it currently feeds `Date.now()`. Because the clock freezes, `BeltCore.tick()` becomes a natural no-op while paused and needs no pause-awareness at all. Speed is a separate, orthogonal knob: a minimum dwell a card must sit at a station before its next hop is requested, enforced inside `BeltCore.hungry()`.

**Tech Stack:** TypeScript on Cloudflare Workers + Durable Objects; `vitest` over pure core logic (bare node, no Workers runtime, no network); vanilla ES modules and hand-written CSS for the client, served raw out of `public/board/` with no build step.

**Spec:** [docs/superpowers/specs/2026-08-08-board-speed-and-pause-design.md](../specs/2026-08-08-board-speed-and-pause-design.md)

## Global Constraints

- **Never block the field on an AI call.** A state read returns without awaiting generation. Enforced lexically by `test/board-guards.test.ts` — `getView` and `seed` must not name `aiRunner|embedTexts|generateRewrites|expandPole|pumpOnce|prepareStations`.
- **No embeddings on the wire.** `assertNoEmbeddings` walks every board response. Nothing added here may introduce an `embedding` key at any depth.
- **Pinned/parked words are never silently lost.** A paused board must not evaporate an edge-parked lineage.
- **`prefers-reduced-motion` degrades to fade-only, no drift.** `test/board-client-guards.test.ts` asserts every animated selector is covered by the reduced-motion block.
- **Touch targets clear 44px** in both dimensions for buttons, min-height for inputs. Asserted by `test/board-client-guards.test.ts` against a *standalone* selector rule (one selector, no comma) — the assertion throws if no such rule exists.
- **`textContent`, never `innerHTML`**, in every `public/board/*.js`. Model output is untrusted input.
- **Vocabulary:** the board's nouns are station / lineage / ghost / edge. Weather terms (dewpoint, drizzle) belong to the field surface and must not appear here.
- **Conventional commit prefixes:** `feat:`, `fix:`, `test:`, `docs:`, `refactor:`.
- **Gates:** `npm run typecheck` and `npm test`. Report counts, not vibes.
- **`EDGE_DWELL_MS` stays 6000** and does not scale with the speed preset.
- **Exact preset values:** `brisk` = 0ms, `steady` = 3000ms, `slow` = 8000ms. Default `steady`.

**Before starting:** run `npm run types` once if `worker-configuration.d.ts` is absent — a fresh worktree is born without it and `tsc` will emit a dozen unrelated errors in `src/session-do.ts` and `src/index.ts`.

---

### Task 1: The belt clock

A pure, standalone module. Nothing else in this plan can be correct until this is.

**Files:**
- Create: `src/board/clock.ts`
- Test: `test/board-clock.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ClockState { base: number; since: number | null }`
  - `startedClock(realNow: number): ClockState`
  - `beltNow(clock: ClockState, realNow: number): number`
  - `pauseClock(clock: ClockState, realNow: number): ClockState`
  - `resumeClock(clock: ClockState, realNow: number): ClockState`
  - `isPaused(clock: ClockState): boolean`

- [ ] **Step 1: Write the failing test**

Create `test/board-clock.test.ts`:

```ts
// The belt clock: monotonic time that runs 1:1 with the wall clock while the
// board is running and freezes while it is paused. Pure, so all of it is
// reachable without a Workers runtime — which matters, because the property
// this module exists to guarantee (a pause does not evaporate the cards you
// paused to read) is otherwise only observable through a Durable Object, and
// there is no DO test harness in this repo (issue #31).

import { describe, expect, it } from "vitest";
import { beltNow, isPaused, pauseClock, resumeClock, startedClock } from "../src/board/clock";

describe("startedClock", () => {
  it("starts running, reading the real clock it was started from", () => {
    const clock = startedClock(1000);
    expect(isPaused(clock)).toBe(false);
    expect(beltNow(clock, 1000)).toBe(1000);
  });

  it("stays epoch-continuous, so timestamps already persisted keep their meaning", () => {
    // A board created before this feature has bornAt/edgeAt values in epoch ms.
    // A clock that started at zero would put belt time ~1.7e12 behind them:
    // `now - edgeAt` goes hugely negative, nothing is ever evicted, and no
    // dwell ever elapses. The board would silently freeze forever.
    const epochish = 1_775_000_000_000;
    expect(beltNow(startedClock(epochish), epochish)).toBe(epochish);
  });
});

describe("beltNow while running", () => {
  it("advances 1:1 with real time", () => {
    const clock = startedClock(1000);
    expect(beltNow(clock, 1000)).toBe(1000);
    expect(beltNow(clock, 4500)).toBe(4500);
  });

  it("never rewinds when the host clock jumps backwards", () => {
    // Belt time going backwards makes `now - edgeAt` negative, and an
    // edge-parked lineage that can never reach EDGE_DWELL_MS is immortal —
    // ephemerality quietly stops holding. Monotonic is load-bearing, not tidy.
    const clock = startedClock(5000);
    expect(beltNow(clock, 1000)).toBe(5000);
  });
});

describe("pauseClock", () => {
  it("freezes belt time at the instant of the pause", () => {
    const clock = pauseClock(startedClock(1000), 4000);
    expect(isPaused(clock)).toBe(true);
    expect(beltNow(clock, 4000)).toBe(4000);
    expect(beltNow(clock, 90_000)).toBe(4000);
  });

  it("is idempotent, so a double click cannot move the clock", () => {
    const once = pauseClock(startedClock(1000), 4000);
    const twice = pauseClock(once, 50_000);
    expect(beltNow(twice, 90_000)).toBe(4000);
  });
});

describe("resumeClock", () => {
  it("picks up where the pause left off rather than jumping", () => {
    // Ten seconds of real time pass while paused. Belt time must be unchanged
    // at the moment of resume, and must then advance normally.
    const paused = pauseClock(startedClock(1000), 4000);
    const running = resumeClock(paused, 14_000);
    expect(isPaused(running)).toBe(false);
    expect(beltNow(running, 14_000)).toBe(4000);
    expect(beltNow(running, 16_000)).toBe(6000);
  });

  it("leaves an already-running clock alone instead of rewinding it", () => {
    // Without the guard this re-anchors `since` to now while leaving `base`
    // behind, so belt time jumps BACKWARDS by however long the board had been
    // running — every dwell restarts and every edge-parked lineage is
    // reprieved. A repeated resume (two viewers, a retried request) is enough.
    const running = startedClock(1000);
    expect(beltNow(resumeClock(running, 5000), 5000)).toBe(5000);
  });

  it("survives a pause/resume cycle repeated many times without drifting", () => {
    let clock = startedClock(0);
    let real = 0;
    for (let i = 0; i < 100; i++) {
      real += 10; // 10ms running
      clock = pauseClock(clock, real);
      real += 1000; // 1s paused, which must not count
      clock = resumeClock(clock, real);
    }
    expect(beltNow(clock, real)).toBe(1000);
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails for the right reason**

```bash
npx vitest run test/board-clock.test.ts
```

Expected: FAIL — `Failed to resolve import "../src/board/clock"`. If it fails with anything else, the test file itself is wrong; fix that before implementing.

- [ ] **Step 3: Write the implementation**

Create `src/board/clock.ts`:

```ts
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
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
npx vitest run test/board-clock.test.ts
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Run the full gates**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean; the whole suite green with 10 more tests than before. Record the count.

- [ ] **Step 6: Commit**

```bash
git add src/board/clock.ts test/board-clock.test.ts
git commit -m "feat: add a freezable belt clock for the board"
```

---

### Task 2: Speed presets and the station dwell gate

**Files:**
- Modify: `src/board/types.ts` (append)
- Modify: `src/board/belt-core.ts` — `hungry`, plus a new `nextHopAt`
- Test: `test/board-belt-core.test.ts` (append)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `BELT_SPEEDS`, `type BeltSpeed = "brisk" | "steady" | "slow"`, `DEFAULT_BELT_SPEED`
  - `isBeltSpeed(value: unknown): value is BeltSpeed`
  - `hopDwellMs(speed: BeltSpeed): number`
  - `interface BoardControls { speed: BeltSpeed; paused: boolean }`
  - `BeltCore.hungry(now: number, hopDwellMs: number): HungryHop[]` — **both parameters required**
  - `BeltCore.nextHopAt(hopDwellMs: number): number | null`

**Breaking change:** `hungry()` gains two required parameters. Its only production caller is `BoardDO.pumpOnce`/`hasPendingWork`, fixed in Task 3; existing tests in `test/board-belt-core.test.ts` and `test/board-guards.test.ts` call it with no arguments and must be updated to `hungry(now, 0)` in this task. `0` preserves their current meaning exactly.

- [ ] **Step 1: Write the failing tests**

Append to `test/board-belt-core.test.ts`. Add `BELT_SPEEDS`, `DEFAULT_BELT_SPEED`, `hopDwellMs`, `isBeltSpeed` to the existing `../src/board/types` import at the top of the file.

```ts
describe("belt speed presets", () => {
  it("names exactly the three shipped presets, at the calibrated dwells", () => {
    expect(Object.keys(BELT_SPEEDS).sort()).toEqual(["brisk", "slow", "steady"]);
    expect(hopDwellMs("brisk")).toBe(0);
    expect(hopDwellMs("steady")).toBe(3000);
    expect(hopDwellMs("slow")).toBe(8000);
  });

  it("defaults to steady, not to the generation-bound pace", () => {
    // brisk is what the board shipped as, and its unreadability is the reason
    // this control exists. The default moving is deliberate; see the spec.
    expect(DEFAULT_BELT_SPEED).toBe("steady");
    expect(hopDwellMs(DEFAULT_BELT_SPEED)).toBeGreaterThan(0);
  });

  it("orders the presets strictly, so a slower name is never a faster belt", () => {
    expect(hopDwellMs("brisk")).toBeLessThan(hopDwellMs("steady"));
    expect(hopDwellMs("steady")).toBeLessThan(hopDwellMs("slow"));
  });

  it("recognises the presets and refuses everything else", () => {
    for (const name of ["brisk", "steady", "slow"]) expect(isBeltSpeed(name)).toBe(true);
    for (const junk of ["BRISK", "fast", "", null, undefined, 3000, {}]) {
      expect(isBeltSpeed(junk)).toBe(false);
    }
  });

  it("does not mistake an inherited Object property for a preset", () => {
    // A plain `value in BELT_SPEEDS` or `BELT_SPEEDS[value] !== undefined`
    // passes for "constructor" and "toString", which then index to a function
    // and read `.hopDwellMs` as undefined — a NaN dwell, i.e. a lineage that is
    // never hungry and a board that silently stops.
    for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(isBeltSpeed(inherited)).toBe(false);
    }
  });
});

describe("hungry with a station dwell", () => {
  it("holds a lineage whose head has not sat out the dwell", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const [seeded] = belt.lineages();
    belt.applySeedFan(seeded!.id, [child("rooftop hives")], 1000);
    const [lineage] = belt.lineages();
    expect(lineage!.cards).toHaveLength(2); // head born at 1000

    expect(belt.hungry(1500, 3000)).toHaveLength(0);
    expect(belt.hungry(3999, 3000)).toHaveLength(0);
  });

  it("releases it the moment the dwell has elapsed", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const [seeded] = belt.lineages();
    belt.applySeedFan(seeded!.id, [child("rooftop hives")], 1000);

    expect(belt.hungry(4000, 3000)).toHaveLength(1);
    expect(belt.hungry(9000, 3000)).toHaveLength(1);
  });

  it("is exactly today's behaviour at a zero dwell", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const [seeded] = belt.lineages();
    belt.applySeedFan(seeded!.id, [child("rooftop hives")], 1000);
    expect(belt.hungry(1000, 0)).toHaveLength(1);
  });

  it("exempts a seed's first hop, so a fresh board never looks like waiting", () => {
    // Gating the fan would leave a brand new board doing nothing for the whole
    // dwell — up to eight seconds of blank belt — which is precisely the
    // "will look like waiting" failure the seed fan was introduced to prevent.
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const [hop] = belt.hungry(1000, 8000);
    expect(hop).toBeDefined();
    expect(hop!.count).toBe(SEED_FANOUT);
  });

  it("still skips arrived, edge-parked and finished lineages under a dwell", () => {
    // The dwell is an extra reason to hold, never a reason to release. Without
    // this the gate could be written as the only condition and pass the tests
    // above while resurrecting lineages that are done.
    const belt = new BeltCore({ stations: stations(1) });
    belt.addSeed("a", 1000);
    const [seeded] = belt.lineages();
    belt.applySeedFan(seeded!.id, [child("b")], 1000);
    const [lineage] = belt.lineages();
    belt.markArrived(lineage!.id, 1000);
    expect(belt.hungry(99_000, 3000)).toHaveLength(0);
  });
});

describe("nextHopAt", () => {
  it("returns null when no lineage is hungry at any future time", () => {
    const belt = new BeltCore({ stations: stations() });
    expect(belt.nextHopAt(3000)).toBeNull();
  });

  it("names the instant a dwelling lineage comes due", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("urban gardening", 1000);
    const [seeded] = belt.lineages();
    belt.applySeedFan(seeded!.id, [child("rooftop hives")], 2000);
    expect(belt.nextHopAt(3000)).toBe(5000); // head bornAt 2000 + 3000
  });

  it("returns the soonest across several lineages, not the first", () => {
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("a", 1000);
    const [firstSeed] = belt.lineages();
    belt.applySeedFan(firstSeed!.id, [child("a1")], 5000);
    belt.addSeed("b", 1000);
    const second = belt.lineages().find((l) => l.cards.length === 1);
    belt.applySeedFan(second!.id, [child("b1")], 2000);
    expect(belt.nextHopAt(3000)).toBe(5000); // 2000 + 3000 beats 5000 + 3000
  });

  it("agrees with hungry at every instant, so the alarm cannot sleep through work", () => {
    // This is the invariant the DO's rearm arithmetic rests on: hungry() is
    // non-empty exactly when nextHopAt is non-null and already due. Two
    // separate traversals that could drift apart is precisely how a board ends
    // up either spinning or sleeping forever.
    const belt = new BeltCore({ stations: stations() });
    belt.addSeed("a", 1000);
    const [firstSeed] = belt.lineages();
    belt.applySeedFan(firstSeed!.id, [child("a1")], 2000);
    belt.addSeed("b", 4000);

    for (let now = 0; now <= 12_000; now += 250) {
      for (const dwell of [0, 3000, 8000]) {
        const due = belt.nextHopAt(dwell);
        const isDue = due !== null && due <= now;
        expect(belt.hungry(now, dwell).length > 0, `now=${now} dwell=${dwell}`).toBe(isDue);
      }
    }
  });
});
```

Also, in the same file, update every existing `belt.hungry()` call site to `belt.hungry(NOW, 0)` where `NOW` is a literal large enough to be past any `bornAt` the test sets — `belt.hungry(1_000_000, 0)` is safe everywhere. Do the same in `test/board-guards.test.ts`.

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npx vitest run test/board-belt-core.test.ts
```

Expected: FAIL — `BELT_SPEEDS` is not exported, and `belt.nextHopAt is not a function`.

- [ ] **Step 3: Add the presets to `src/board/types.ts`**

Append:

```ts
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
```

- [ ] **Step 4: Gate `hungry` and add `nextHopAt` in `src/board/belt-core.ts`**

Replace the existing `hungry()` method with:

```ts
  /** Lineages that need their next card. A lineage still sitting on its seed
   *  asks for SEED_FANOUT children; every later hop asks for one.
   *
   *  `hopDwellMs` is the speed preset's minimum station dwell: a head has to
   *  have sat that long, in belt time, before its next hop is requested. Both
   *  parameters are required rather than defaulted — a call site that forgets
   *  the dwell should fail to compile, not silently run that lineage at brisk.
   *
   *  The seed fan is EXEMPT — its dwell is zero. Gating a lineage's first hop
   *  leaves a brand new board doing nothing for the whole dwell, which is the
   *  "will look like waiting" failure the fan was introduced to prevent. The
   *  dwell paces the interval between things there are to read; before the fan
   *  there is nothing to read.
   *
   *  Both this and `nextHopAt` compute the same `due` instant and differ only in
   *  what they do with it. That is deliberate: written as two separate rules —
   *  "skip if still dwelling" here, "return bornAt + dwell" there — they
   *  disagree for a head whose bornAt is ahead of `now`, and the alarm either
   *  spins or sleeps through work it was told existed. */
  hungry(now: number, hopDwellMs: number): HungryHop[] {
    const out: HungryHop[] = [];
    for (const lineage of this.lineageList) {
      if (lineage.arrivedAt !== null || lineage.edgeAt !== null) continue;
      const head = lineage.cards.at(-1)!;
      if (head.stationIndex >= this.stationList.length) continue;
      const count = lineage.cards.length === 1 ? SEED_FANOUT : 1;
      if (now < head.bornAt + (count === 1 ? hopDwellMs : 0)) continue;
      out.push({
        lineageId: lineage.id,
        parentText: head.text,
        parentEmbedding: head.embedding,
        stationIndex: head.stationIndex + 1,
        count,
      });
    }
    return out;
  }

  /** Belt-time at which the next hop becomes eligible, or null when no lineage
   *  will ever be hungry from this state. A value at or before `now` means work
   *  is already due.
   *
   *  This exists so the alarm can sleep until the dwell expires instead of
   *  either spinning at PUMP_MS or — worse — lapsing. Without it, a board where
   *  every lineage is dwelling reports no pending work, the alarm is not
   *  re-armed, and the belt advances only as a side effect of somebody polling.
   *
   *  Deliberately takes no `now`: the answer does not depend on one, and a
   *  version that took one could disagree with `hungry` about the present.
   *
   *  The `due` expression below must stay character-for-character the one in
   *  `hungry`. `hungry` includes a lineage exactly when `now >= due`, so this
   *  returning `min(due)` is what makes "nextHopAt is non-null and at or before
   *  now" mean the same thing as "hungry is non-empty". */
  nextHopAt(hopDwellMs: number): number | null {
    let soonest: number | null = null;
    for (const lineage of this.lineageList) {
      if (lineage.arrivedAt !== null || lineage.edgeAt !== null) continue;
      const head = lineage.cards.at(-1)!;
      if (head.stationIndex >= this.stationList.length) continue;
      const count = lineage.cards.length === 1 ? SEED_FANOUT : 1;
      const due = head.bornAt + (count === 1 ? hopDwellMs : 0);
      if (soonest === null || due < soonest) soonest = due;
    }
    return soonest;
  }
```

- [ ] **Step 5: Update the two production call sites in `src/board/board-do.ts`**

This task leaves the board running at the default speed on the wall clock: the dwell is real and correct, it is just not yet configurable and there is no pause. Task 3 makes it both. Add `DEFAULT_BELT_SPEED, hopDwellMs` to the existing `./types` import, then:

- `hasPendingWork()` — replace the `hungry` call with `nextHopAt`, which is the correct form and is available now:

```ts
    if (this.belt.nextHopAt(hopDwellMs(DEFAULT_BELT_SPEED)) !== null) return true;
```

- `pumpOnce()`:

```ts
    const hop = this.belt.hungry(Date.now(), hopDwellMs(DEFAULT_BELT_SPEED))[0];
```

Do **not** hardcode a `0` dwell in either — that would silently ship the brisk pace regardless of the preset, which is the whole behaviour this task exists to change.

- [ ] **Step 6: Run the tests and confirm they pass**

```bash
npx vitest run test/board-belt-core.test.ts test/board-guards.test.ts
```

Expected: PASS. The `agrees with hungry at every instant` property test is the one to watch — it exercises 147 (now, dwell) combinations.

- [ ] **Step 7: Run the full gates**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean, whole suite green. Record the count.

- [ ] **Step 8: Commit**

```bash
git add src/board/types.ts src/board/belt-core.ts src/board/board-do.ts test/board-belt-core.test.ts test/board-guards.test.ts
git commit -m "feat: gate belt hops behind a per-speed station dwell"
```

---

### Task 3: Wire the clock and controls into BoardDO

**Files:**
- Modify: `src/board/board-do.ts`
- Test: `test/board-api.test.ts` (append — `pumpDelayMs`), `test/board-guards.test.ts` (append — a sixth guard)

**Interfaces:**
- Consumes: `ClockState`, `startedClock`, `beltNow`, `pauseClock`, `resumeClock`, `isPaused` (Task 1); `BeltSpeed`, `DEFAULT_BELT_SPEED`, `hopDwellMs`, `BoardControls` (Task 2); `BeltCore.hungry(now, dwell)`, `BeltCore.nextHopAt(dwell)` (Task 2).
- Produces:
  - `export interface BoardResponse extends BoardView { controls: BoardControls }`
  - `export function pumpDelayMs(input: { backoffMs: number; nextHopAt: number | null; edgeParked: boolean; beltNow: number }): number`
  - `BoardDO.setControls(patch: { speed?: BeltSpeed; paused?: boolean }): Promise<BoardResponse | null>`
  - `init`, `getView`, `seed` now resolve to `BoardResponse` shapes.

- [ ] **Step 1: Write the failing tests**

Append to `test/board-api.test.ts` (add `pumpDelayMs` to the existing `../src/board/board-do` import):

```ts
describe("pumpDelayMs", () => {
  const BACKOFF = 500;

  it("waits out the dwell when the only work is a lineage still dwelling", () => {
    expect(pumpDelayMs({ backoffMs: BACKOFF, nextHopAt: 9000, edgeParked: false, beltNow: 1000 })).toBe(8000);
  });

  it("never returns less than the backoff, so a saturated board still backs off", () => {
    expect(pumpDelayMs({ backoffMs: 30_000, nextHopAt: 1100, edgeParked: false, beltNow: 1000 })).toBe(30_000);
  });

  it("keeps polling at the backoff while anything is parked at the edge", () => {
    // An edge-parked lineage needs the tick that evicts it, and that tick is
    // due continuously rather than at a computed instant. Letting a long dwell
    // win here would hold a finished card on the belt for the whole dwell past
    // its EDGE_DWELL_MS — visibly wrong, and it breaks ephemerality's timing.
    expect(pumpDelayMs({ backoffMs: BACKOFF, nextHopAt: 20_000, edgeParked: true, beltNow: 1000 })).toBe(BACKOFF);
  });

  it("treats an overdue hop as due now rather than as a negative delay", () => {
    expect(pumpDelayMs({ backoffMs: BACKOFF, nextHopAt: 500, edgeParked: false, beltNow: 1000 })).toBe(BACKOFF);
  });

  it("falls back to the backoff when there is no work at all", () => {
    expect(pumpDelayMs({ backoffMs: BACKOFF, nextHopAt: null, edgeParked: false, beltNow: 1000 })).toBe(BACKOFF);
  });

  it("never returns a negative or non-finite delay", () => {
    for (const nextHopAt of [null, -1e9, 0, 1e9]) {
      for (const beltNow of [0, 1e9]) {
        const delay = pumpDelayMs({ backoffMs: BACKOFF, nextHopAt, edgeParked: false, beltNow });
        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
```

Append to `test/board-guards.test.ts` (add `import { beltNow, pauseClock, startedClock } from "../src/board/clock";` to the imports):

```ts
// ── guard 6: pause stops the work, and loses nothing ────────────────────────
//
// Pause has to stop metered generation, not merely stop the picture, and it
// must not cost the user the cards they paused to read. The first half is only
// reachable lexically (issue #31 again — no DO harness), the second half is a
// real property of BeltCore and is executed.

describe("pause guard", () => {
  it("evaporates nothing while belt time is frozen, however long the pause", () => {
    // THE reason pause is a frozen clock rather than a flag. Under a flag,
    // wall-clock time keeps running against edgeAt, and the first tick after a
    // long pause evicts every parked lineage at once.
    const belt = new BeltCore({ stations: stations(1) });
    belt.addSeed("urban gardening", 1000);
    const [seeded] = belt.lineages();
    belt.applySeedFan(seeded!.id, [child("rooftop hives")], 1000);
    const [lineage] = belt.lineages();
    belt.markArrived(lineage!.id, 1000);

    const frozen = beltNow(pauseClock(startedClock(1000), 2000), 2000);
    for (let i = 0; i < 200; i++) belt.tick(frozen); // ~ minutes of real time
    expect(belt.lineages()).toHaveLength(1);
    expect(belt.evaporated()).toHaveLength(0);

    // Non-vacuity: the same lineage does evaporate once belt time moves past
    // the dwell, so the assertion above is about the freeze, not about a
    // lineage that was never going to evaporate.
    belt.tick(frozen + EDGE_DWELL_MS);
    expect(belt.lineages()).toHaveLength(0);
    expect(belt.evaporated()).toHaveLength(1);
  });

  it("arms no alarm while the board is paused, whoever asks", () => {
    // One choke point. init, getView, seed, prepareStations and rearm all route
    // through schedulePump, so the check living here is what makes "paused
    // spends nothing" true for all of them at once rather than five times over.
    const proto = BoardDO.prototype as unknown as Record<string, () => string>;
    const schedulePump = proto.schedulePump!.toString();
    expect(schedulePump).toMatch(/setAlarm/); // non-vacuity: this is the real body
    expect(schedulePump).toMatch(/paused\(\)/);
  });

  it("returns from the alarm before pumping when paused", () => {
    const alarm = BoardDO.prototype.alarm.toString();
    expect(alarm).toMatch(/pumpOnce/); // non-vacuity
    const guard = alarm.indexOf("paused()");
    const pump = alarm.indexOf("pumpOnce");
    expect(guard, "alarm never checks paused()").toBeGreaterThan(-1);
    expect(guard, "alarm checks paused() only after pumping").toBeLessThan(pump);
  });

  it("does not count a pause as a stall, so a resumed board is not in backoff", () => {
    // A paused board that scored "stalled" would saturate MAX_CONSECUTIVE_STALLS
    // and wake into a 30s ladder — or a given-up state — the moment it resumed.
    // Pause is not a fault.
    const alarm = BoardDO.prototype.alarm.toString();
    const guard = alarm.indexOf("paused()");
    const pump = alarm.indexOf("pumpOnce");
    expect(guard).toBeGreaterThan(-1);
    expect(alarm.slice(guard, pump), "the paused branch never sets idle").toMatch(/idle/);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npx vitest run test/board-api.test.ts test/board-guards.test.ts
```

Expected: FAIL — `pumpDelayMs` is not exported, and the four pause-guard assertions fail on a `schedulePump`/`alarm` that never names `paused()`.

- [ ] **Step 3: Add the clock, the controls and `pumpDelayMs` to `src/board/board-do.ts`**

Add to the imports:

```ts
import { beltNow, isPaused, pauseClock, resumeClock, startedClock, type ClockState } from "./clock";
import {
  CANDIDATES_PER_HOP,
  DEFAULT_BELT_SPEED,
  DEFAULT_STATION_TERMS,
  hopDwellMs,
  type BeltSpeed,
  type BoardControls,
  type Station,
} from "./types";
```

Add below `STALLS_KEY`:

```ts
/** Storage key for the speed preset and the belt clock. Deliberately NOT part
 *  of the "belt" record: `beltFingerprint` compares that record byte for byte
 *  to decide whether the read path may skip its write, and its safety argument
 *  is that it can only ever err toward writing. Folding a clock into it — a
 *  value that moves on its own — would make every poll a change and put the
 *  per-poll write straight back. */
const CONTROLS_KEY = "controls";

interface ControlsRecord {
  speed: BeltSpeed;
  clock: ClockState;
}

/** The board's wire shape: the belt's projection plus the control state. */
export interface BoardResponse extends BoardView {
  controls: BoardControls;
}

/** Real-ms until the alarm should next fire.
 *
 *  Exported and pure for the same reason `candidateWidth` and
 *  `beltFingerprint` are: there is no Durable Object test harness in this repo
 *  (issue #31), so arithmetic that decides whether a board spins, sleeps, or
 *  stops has to be reachable without one.
 *
 *  `edgeParked` short-circuits to zero rather than computing an instant,
 *  because eviction is due continuously — the tick either finds the dwell
 *  elapsed or it does not. Letting a long station dwell win instead would hold
 *  a finished card on the belt for up to eight seconds past EDGE_DWELL_MS. */
export function pumpDelayMs(input: {
  backoffMs: number;
  nextHopAt: number | null;
  edgeParked: boolean;
  beltNow: number;
}): number {
  const waits: number[] = [];
  if (input.edgeParked) waits.push(0);
  if (input.nextHopAt !== null) waits.push(Math.max(0, input.nextHopAt - input.beltNow));
  const soonest = waits.length === 0 ? 0 : Math.min(...waits);
  return Math.max(input.backoffMs, soonest);
}
```

Add the fields and helpers to the class, beside `persistedBelt`:

```ts
  private speed: BeltSpeed = DEFAULT_BELT_SPEED;
  private clock: ClockState = { base: 0, since: null };
  /** Last controls record written, so a board that is merely running never
   *  writes its clock at all. */
  private persistedControls: string | null = null;

  /** Belt time: real time while running, frozen while paused. Everything the
   *  belt is given as `now` comes through here — a stray Date.now() reaching
   *  BeltCore would keep ticking through a pause and evict parked lineages. */
  private beltNow(): number {
    return beltNow(this.clock, Date.now());
  }

  private paused(): boolean {
    return isPaused(this.clock);
  }

  private dwell(): number {
    return hopDwellMs(this.speed);
  }

  private response(): BoardResponse {
    return { ...this.belt.view(), controls: { speed: this.speed, paused: this.paused() } };
  }

  private async saveControls(): Promise<void> {
    const record: ControlsRecord = { speed: this.speed, clock: this.clock };
    const fingerprint = JSON.stringify(record);
    if (fingerprint === this.persistedControls) return;
    await this.ctx.storage.put(CONTROLS_KEY, record);
    this.persistedControls = fingerprint;
  }
```

In `load()`, after the stalls read:

```ts
    const controls = await this.ctx.storage.get<ControlsRecord>(CONTROLS_KEY);
    this.speed = controls?.speed ?? DEFAULT_BELT_SPEED;
    // A board with no controls record — every board that predates this feature
    // — gets a clock started now. `startedClock` is epoch-seeded, so belt time
    // is continuous with the bornAt/edgeAt values already in its belt record and
    // no migration is needed. Nothing is written: a board that is simply running
    // re-derives the same running clock on every load.
    this.clock = controls?.clock ?? startedClock(Date.now());
    this.persistedControls = controls === undefined ? null : JSON.stringify(controls);
```

Replace `schedulePump` with:

```ts
  private async schedulePump(delayMs: number): Promise<void> {
    // The one choke point for pause. init, getView, seed, prepareStations and
    // rearm all arm the alarm through here, so a paused board spends nothing
    // because of this line rather than because five callers each remembered.
    // Resume unfreezes the clock BEFORE calling in, so it is not blocked by it.
    if (this.paused()) return;
    const target = Date.now() + delayMs;
    const existing = await this.ctx.storage.getAlarm();
    // Pull the alarm forward on user activity; never push it out.
    if (existing === null || existing > target) await this.ctx.storage.setAlarm(target);
  }
```

Replace `hasPendingWork` and `rearm`'s delay line:

```ts
  private hasPendingWork(): boolean {
    // nextHopAt, not hungry: a lineage still sitting out its dwell is pending
    // work. Asking hungry() here would report an all-dwelling board as idle,
    // the alarm would lapse, and the belt would advance only when someone
    // happened to poll.
    if (this.belt.nextHopAt(this.dwell()) !== null) return true;
    return this.belt.lineages().some((l) => l.edgeAt !== null);
  }
```

```ts
      const shift = Math.min(this.pumpFailures, PUMP_BACKOFF_MAX_SHIFT);
      const delay = pumpDelayMs({
        backoffMs: Math.min(PUMP_RETRY_MAX_MS, PUMP_MS * 2 ** shift),
        nextHopAt: this.belt.nextHopAt(this.dwell()),
        edgeParked: this.belt.lineages().some((l) => l.edgeAt !== null),
        beltNow: this.beltNow(),
      });
      // Through schedulePump, NOT a raw setAlarm: this must pull the alarm
      // forward and never push it out. A seed landing mid-pump has already
      // asked for 0ms, and a raw set here moved it to the full 30s backoff.
      await this.schedulePump(delay);
```

In `alarm()`, immediately after `await this.load();`:

```ts
      // Paused: request no work. "idle" rather than "stalled" keeps the backoff
      // ladder out of it — pause is not a fault, and a board resumed after a
      // long pause must not wake into a saturated backoff or a given-up state.
      if (this.paused()) {
        result = "idle";
        return;
      }
```

Swap every belt-facing `Date.now()` for `this.beltNow()`:

- `getView`: `this.belt.tick(this.beltNow());`
- `seed`: `this.belt.addSeed(text, this.beltNow());`
- `alarm`: `this.belt.tick(this.beltNow());`
- `pumpOnce`: `const now = () => this.beltNow();` and `const hop = this.belt.hungry(this.beltNow(), this.dwell())[0];`

Leave `schedulePump`'s own `Date.now()` alone — alarms are scheduled in real time, and that is the one place the two clocks legitimately meet.

Change the three RPC return types to `BoardResponse` and return `this.response()` in place of `this.belt.view()` (in `seed`, `{ view: this.response(), accepted }`).

Add the new RPC after `seed`:

```ts
  /** Set the speed preset, the paused state, or both.
   *
   *  Pausing ticks once at the frozen time before answering, so the snapshot
   *  the client is handed accounts for every millisecond up to the pause rather
   *  than deferring that work to whenever the board next resumes. Resuming
   *  unfreezes first and then asks for an immediate pump, so anything seeded
   *  during the pause releases at once — and, incidentally, so a board whose
   *  stall backoff had saturated recovers, by the same route getView and seed
   *  already use. */
  async setControls(patch: { speed?: BeltSpeed; paused?: boolean }): Promise<BoardResponse | null> {
    await this.load();
    if (this.belt.stations().length === 0) return null;
    const realNow = Date.now();
    if (patch.speed !== undefined) this.speed = patch.speed;
    if (patch.paused !== undefined) {
      this.clock = patch.paused ? pauseClock(this.clock, realNow) : resumeClock(this.clock, realNow);
    }
    await this.saveControls();
    this.belt.tick(this.beltNow());
    await this.saveIfChanged();
    await this.schedulePump(0);
    return this.response();
  }
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run test/board-api.test.ts test/board-guards.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full gates**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean, whole suite green. Record the count.

- [ ] **Step 6: Commit**

```bash
git add src/board/board-do.ts test/board-api.test.ts test/board-guards.test.ts
git commit -m "feat: freeze the belt clock on pause and pace the pump by dwell"
```

---

### Task 4: The controls route

**Files:**
- Modify: `src/index.ts`
- Test: `test/board-api.test.ts` (append)

**Interfaces:**
- Consumes: `BoardDO.setControls` (Task 3), `isBeltSpeed`, `BeltSpeed` (Task 2).
- Produces: `export function parseControlsPatch(body: Record<string, unknown>): { speed?: BeltSpeed; paused?: boolean } | null`, and `POST /api/board/:id/controls`.

- [ ] **Step 1: Write the failing tests**

Append to `test/board-api.test.ts`. Add `parseControlsPatch` to the existing `../src/index` import, and add `setControls?: (patch: unknown) => Promise<unknown>` to the `BoardStub` interface.

```ts
describe("parseControlsPatch", () => {
  it("accepts each shipped preset", () => {
    for (const speed of ["brisk", "steady", "slow"]) {
      expect(parseControlsPatch({ speed })).toEqual({ speed });
    }
  });

  it("accepts either half on its own, and both together", () => {
    expect(parseControlsPatch({ paused: true })).toEqual({ paused: true });
    expect(parseControlsPatch({ paused: false })).toEqual({ paused: false });
    expect(parseControlsPatch({ speed: "slow", paused: true })).toEqual({ speed: "slow", paused: true });
  });

  it("refuses an unknown speed rather than falling back to the default", () => {
    // A silent fallback means a typo in the client ships a board running at a
    // speed nobody selected, with a 200 and a control row that looks right.
    for (const speed of ["fast", "BRISK", "", 3000, null, {}]) {
      expect(parseControlsPatch({ speed })).toBeNull();
    }
  });

  it("refuses a non-boolean paused", () => {
    for (const paused of ["true", 1, 0, null, {}]) {
      expect(parseControlsPatch({ paused })).toBeNull();
    }
  });

  it("refuses a patch that asks for nothing", () => {
    // A no-op answering 200 is indistinguishable from a control that works.
    expect(parseControlsPatch({})).toBeNull();
    expect(parseControlsPatch({ speeed: "slow" })).toBeNull();
  });
});

describe("POST /api/board/:id/controls", () => {
  it("passes the patch through and returns the view", async () => {
    const seen: unknown[] = [];
    const { response } = callRoute(
      {
        setControls: async (patch) => {
          seen.push(patch);
          return { ...CLEAN_VIEW, controls: { speed: "slow", paused: true } };
        },
      },
      post(`/api/board/${BOARD_ID}/controls`, { speed: "slow", paused: true }),
    );
    const res = await response;
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ speed: "slow", paused: true }]);
    const body = (await res.json()) as { controls: { speed: string; paused: boolean } };
    expect(body.controls).toEqual({ speed: "slow", paused: true });
  });

  it("404s against an unknown board", async () => {
    const res = await callRoute(
      { setControls: async () => null },
      post(`/api/board/${BOARD_ID}/controls`, { paused: true }),
    ).response;
    expect(res.status).toBe(404);
  });

  it("400s an unknown speed without touching the board", async () => {
    let called = false;
    const res = await callRoute(
      {
        setControls: async () => {
          called = true;
          return CLEAN_VIEW;
        },
      },
      post(`/api/board/${BOARD_ID}/controls`, { speed: "ludicrous" }),
    ).response;
    expect(res.status).toBe(400);
    expect(called).toBe(false);
  });

  it("400s a non-object body", async () => {
    const res = await callRoute({}, post(`/api/board/${BOARD_ID}/controls`)).response;
    expect(res.status).toBe(400);
  });

  it("400s an invalid board id before reaching the DO", async () => {
    const { response, names } = callRoute({}, post("/api/board/not-a-uuid/controls", { paused: true }));
    expect((await response).status).toBe(400);
    expect(names).toEqual([]);
  });
});
```

Also bring the controls route under the existing no-embeddings guard. In `test/board-guards.test.ts`, add a fifth entry to the `allBoardResponses` helper (around line 276):

```ts
    controls: await callRoute(
      { setControls: async () => project(clean) },
      post(`/api/board/${BOARD_ID}/controls`, { paused: true }),
    ),
```

and add `controls: 200` to the `expected` status map in the `puts no embedding key at any depth in any board response` test, so the new route is checked for status as well as for leaks.

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npx vitest run test/board-api.test.ts
```

Expected: FAIL — `parseControlsPatch` is not exported; the route tests 404 because `/controls` falls through to the board matcher's final `not found`.

- [ ] **Step 3: Implement in `src/index.ts`**

Add `isBeltSpeed, type BeltSpeed` to the `./board/types` import, then add beside `parseText`:

```ts
/** Strict on purpose. An unknown speed is a 400, never a silent fall back to
 *  the default — a client typo would otherwise ship a board running at a speed
 *  nobody chose, with a 200 and a control row that looks correct. A patch that
 *  asks for nothing is refused for the same reason: a no-op answering 200 is
 *  indistinguishable from a control that works. */
export function parseControlsPatch(
  body: Record<string, unknown>,
): { speed?: BeltSpeed; paused?: boolean } | null {
  const patch: { speed?: BeltSpeed; paused?: boolean } = {};
  if (body.speed !== undefined) {
    if (!isBeltSpeed(body.speed)) return null;
    patch.speed = body.speed;
  }
  if (body.paused !== undefined) {
    if (typeof body.paused !== "boolean") return null;
    patch.paused = body.paused;
  }
  return patch.speed === undefined && patch.paused === undefined ? null : patch;
}
```

Add the route inside the `boardMatch` block, after the `/seed` handler:

```ts
    if (boardRest === "/controls" && method === "POST") {
      const body = await readBody(request);
      if (!body) return badRequest("expected a JSON object body");
      const patch = parseControlsPatch(body);
      if (!patch) {
        return badRequest("speed must be brisk, steady or slow; paused must be a boolean");
      }
      const view = await board.setControls(patch);
      if (!view) return json({ error: "no such board" }, 404);
      return boardJson(view);
    }
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run test/board-api.test.ts test/board-guards.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full gates**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean, whole suite green. Record the count.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/board-api.test.ts test/board-guards.test.ts
git commit -m "feat: expose the board's speed and pause over /api/board/:id/controls"
```

---

### Task 5: The client control row

**Files:**
- Modify: `public/board/belt-model.js` (append), `public/board/belt-render.js`, `public/board/board.js`, `public/board/index.html`, `public/board/styles.css`
- Test: `test/board-render.test.ts` (append), `test/board-client-guards.test.ts` (append)

**Interfaces:**
- Consumes: the `controls` key on every board response (Task 3), `POST /api/board/:id/controls` (Task 4).
- Produces:
  - `belt-model.js`: `BELT_SPEED_NAMES`, `DEFAULT_SPEED`, `controlsState(view)`
  - `belt-render.js`: `renderControls(nodes, view)`, and `paintBoard` calls it.

- [ ] **Step 1: Write the failing tests**

Append to `test/board-render.test.ts`. The file imports the untyped model module once as `beltModelUntyped` and destructures a typed view of it; extend that destructuring with the three new exports:

```ts
const { controlsState, BELT_SPEED_NAMES, DEFAULT_SPEED } = beltModelUntyped as unknown as {
  controlsState(view: unknown): { speed: string; paused: boolean };
  BELT_SPEED_NAMES: string[];
  DEFAULT_SPEED: string;
};
```

Merge this into the existing cast rather than adding a second one, matching how the file already surfaces `ghostOpacity`, `placeCards` and `columnCount`.

```ts
describe("controlsState", () => {
  it("reads the speed and paused state a view carries", () => {
    expect(controlsState({ controls: { speed: "slow", paused: true } })).toEqual({
      speed: "slow",
      paused: true,
    });
  });

  it("falls back to a coherent row when the view carries no controls", () => {
    // A dropped poll body, a 404 payload, or a response from a server that
    // predates this feature must still paint a control row. An undefined speed
    // would check none of the three radios and leave the group unreadable.
    for (const view of [null, undefined, {}, { controls: null }, { controls: "slow" }]) {
      expect(controlsState(view)).toEqual({ speed: DEFAULT_SPEED, paused: false });
    }
  });

  it("refuses a speed it does not know rather than passing it through", () => {
    expect(controlsState({ controls: { speed: "ludicrous", paused: false } }).speed).toBe(DEFAULT_SPEED);
  });

  it("treats anything but a literal true as running", () => {
    for (const paused of ["true", 1, null, undefined]) {
      expect(controlsState({ controls: { speed: "steady", paused } }).paused).toBe(false);
    }
  });

  it("names exactly the presets the server accepts", () => {
    // These strings go straight into the request body. Drifting from the
    // server's isBeltSpeed means every click 400s.
    expect(BELT_SPEED_NAMES).toEqual(["brisk", "steady", "slow"]);
    expect(BELT_SPEED_NAMES).toContain(DEFAULT_SPEED);
  });
});
```

Append to `test/board-client-guards.test.ts`:

```ts
describe("board control buttons clear 44px", () => {
  it("gives every control button 44px in both dimensions", () => {
    const body = bodyForExactSelector(css, ".board-surface .board-control-button");
    for (const prop of ["min-height", "min-width"]) {
      expect(pxLength(body, prop), `control button declares no px ${prop}`).not.toBeNull();
      expect(pxLength(body, prop), `control button ${prop} is under the 44px floor`).toBeGreaterThanOrEqual(44);
    }
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

```bash
npx vitest run test/board-render.test.ts test/board-client-guards.test.ts
```

Expected: FAIL — `controlsState is not a function`, and `no standalone rule found for selector ".board-surface .board-control-button"`.

- [ ] **Step 3: Add the model half to `public/board/belt-model.js`**

Append:

```js
/** The speed presets, in belt order. These strings are the wire values — they
 *  must match src/board/types.ts's BELT_SPEEDS exactly, because they go
 *  straight into the request body and anything else is a 400. */
export const BELT_SPEED_NAMES = ["brisk", "steady", "slow"];

export const DEFAULT_SPEED = "steady";

/** Normalize a view's control state.
 *
 *  Total by design. A dropped poll body, a 404 payload, or a response from a
 *  server that predates this feature must still paint a coherent control row:
 *  an undefined speed checks none of the three radios and leaves the group
 *  unreadable and unoperable. */
export function controlsState(view) {
  const controls = view && typeof view.controls === "object" && view.controls !== null ? view.controls : {};
  return {
    speed: BELT_SPEED_NAMES.includes(controls.speed) ? controls.speed : DEFAULT_SPEED,
    paused: controls.paused === true,
  };
}
```

- [ ] **Step 4: Add the DOM half to `public/board/belt-render.js`**

Change the import to `import { columnCount, controlsState, placeCards } from "./belt-model.js";`, then add:

```js
/** Paint the control row from the view's control state.
 *
 *  Attribute-driven rather than class-driven: `aria-pressed` and `aria-checked`
 *  ARE the state, and the stylesheet selects on them, so there is exactly one
 *  source of truth and the row cannot look set while reading as unset. */
export function renderControls(nodes, view) {
  const { speed, paused } = controlsState(view);
  if (nodes.pause) {
    nodes.pause.setAttribute("aria-pressed", String(paused));
    nodes.pause.textContent = paused ? "resume" : "pause";
  }
  for (const button of nodes.speeds ?? []) {
    button.setAttribute("aria-checked", String(button.dataset.speed === speed));
  }
  // Marked, not dimmed. Someone paused the board in order to read it.
  if (nodes.belt) nodes.belt.classList.toggle("board-grid--paused", paused);
}
```

and add `renderControls(nodes, view);` as the last line of `paintBoard`.

- [ ] **Step 5: Add the markup to `public/board/index.html`**

Insert between the seed form and `<p id="board-status">`:

```html
    <div class="board-controls">
      <button
        id="board-pause"
        type="button"
        class="board-control-button board-pause"
        aria-pressed="false"
      >
        pause
      </button>
      <div class="board-speed" role="radiogroup" aria-label="belt speed">
        <button type="button" class="board-control-button board-speed-option" data-speed="brisk" role="radio" aria-checked="false">brisk</button>
        <button type="button" class="board-control-button board-speed-option" data-speed="steady" role="radio" aria-checked="true">steady</button>
        <button type="button" class="board-control-button board-speed-option" data-speed="slow" role="radio" aria-checked="false">slow</button>
      </div>
    </div>
```

- [ ] **Step 6: Wire the network half in `public/board/board.js`**

Change the import to `import { paintBoard, renderControls } from "./belt-render.js";` and add `import { controlsState } from "./belt-model.js";`.

Add below `POLL_MS`:

```js
/** Poll cadence while paused. Nothing can change server-side except another
 *  viewer of the same board URL resuming it, so polling at the running rate is
 *  the same waste the read path's write-skip was added to remove. */
const POLL_PAUSED_MS = 3000;
```

Extend the `nodes` object and track the last view:

```js
const nodes = {
  stations: document.getElementById("board-stations"),
  belt: document.getElementById("board-belt"),
  evaporated: document.getElementById("board-evaporated"),
  pause: document.getElementById("board-pause"),
  speeds: [...document.querySelectorAll(".board-speed-option")],
};

/** The last view painted, so a failed control request can put the row back. */
let lastView = null;

function paint(view) {
  lastView = view;
  paintBoard(nodes, view);
}
```

Add the control sender:

```js
/** Send a control patch, painting the row optimistically so the click lands
 *  immediately rather than at the next poll.
 *
 *  Only the ROW is painted optimistically, never the belt: the client has no
 *  basis to predict what the belt does next, and guessing would flicker cards
 *  in and out. The response carries the authoritative view for everything. */
async function sendControls(patch) {
  if (!boardId) return;
  renderControls(nodes, { controls: { ...controlsState(lastView), ...patch } });
  try {
    const res = await fetch(boardUrl(boardId, "/controls"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      say("the board would not take that — try again");
      renderControls(nodes, lastView);
      return;
    }
    say("");
    paint(await res.json());
  } catch (err) {
    console.error("controls failed", err);
    say("the board would not take that — try again");
    renderControls(nodes, lastView);
  }
}

nodes.pause?.addEventListener("click", () => {
  sendControls({ paused: !controlsState(lastView).paused });
});

for (const button of nodes.speeds) {
  button.addEventListener("click", () => sendControls({ speed: button.dataset.speed }));
}
```

Change the last line of `poll()` to back off while paused:

```js
  setTimeout(poll, controlsState(lastView).paused ? POLL_PAUSED_MS : POLL_MS);
```

- [ ] **Step 7: Add the styles to `public/board/styles.css`**

Append. The `.board-control-button` rule must be **standalone** — one selector, no comma — or the 44px guard throws rather than failing.

```css
.board-surface .board-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
  margin: 0.5rem auto 0;
  max-width: 46rem;
}

.board-surface .board-speed {
  display: flex;
  gap: 0.25rem;
}

.board-surface .board-control-button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 0.9rem;
  border: 1px solid rgb(255 255 255 / 0.18);
  border-radius: 0.4rem;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.85rem;
  letter-spacing: 0.02em;
  cursor: pointer;
}

.board-surface .board-control-button:hover {
  border-color: rgb(255 255 255 / 0.36);
}

.board-surface .board-control-button:focus-visible {
  outline: 2px solid rgb(255 255 255 / 0.6);
  outline-offset: 2px;
}

.board-surface .board-control-button[aria-pressed="true"],
.board-surface .board-control-button[aria-checked="true"] {
  border-color: rgb(255 255 255 / 0.5);
  background: rgb(255 255 255 / 0.1);
}

/* Marked, not dimmed. The whole reason to pause a board is to read it, so the
   cue is a border on the belt rather than anything that costs legibility. */
.board-surface .board-grid--paused {
  box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.14);
}
```

Add no `transition` or `animation` anywhere in this block. Any you add must also be listed in the `@media (prefers-reduced-motion: reduce)` block, or the reduced-motion guard fails.

- [ ] **Step 8: Run the tests and confirm they pass**

```bash
npx vitest run test/board-render.test.ts test/board-client-guards.test.ts
```

Expected: PASS.

- [ ] **Step 9: Run the full gates**

```bash
npm run typecheck && npm test
```

Expected: typecheck clean, whole suite green. Record the count.

- [ ] **Step 10: Commit**

```bash
git add public/board test/board-render.test.ts test/board-client-guards.test.ts
git commit -m "feat: add the board's pause toggle and speed presets to the client"
```

---

### Task 6: Verify in the running app, then close out the spec

Unit tests cannot show that pause holds a card still on screen. This task is the browser check the project's rules require for UI work.

**Files:**
- Modify: `docs/superpowers/specs/2026-08-08-board-speed-and-pause-design.md` (status line)

- [ ] **Step 1: Start the dev server through the preview tooling**

Use `preview_start` with the name from [.claude/launch.json](../../../.claude/launch.json). Never `npm run dev` through Bash.

If the server dies instantly at startup, that is the Cloudflare Access trap in CLAUDE.md, not your code — `launch.json` already sources the service-token env vars, so check they are present in the environment. If generation never produces a card, probe `GET /api/debug/ai` before touching app code: WARP blocks all workerd egress on this machine, intermittently, and it looks exactly like an app bug.

- [ ] **Step 2: Open `/board`, seed a word, and confirm the default pace**

Navigate to `/board`, type a seed, submit. The fan must appear promptly — **not** after a 3-second wait. That is the seed-fan dwell exemption working; if the board sits blank for three seconds, the exemption is broken.

- [ ] **Step 3: Confirm the slow preset actually slows the belt**

Click `slow`, then watch one lineage advance. Read the DO's behaviour through `read_network_requests` for `/api/board/`: successive views should show a head's `stationIndex` advancing roughly every 8 seconds rather than every 1–2.

- [ ] **Step 4: Confirm pause holds, and holds a card at the edge**

Wait for a lineage to reach the edge (the last column), then click `pause` immediately. Take a screenshot. Wait at least 15 seconds — well past `EDGE_DWELL_MS` of 6000 — take a second screenshot, and confirm the card is **still there** and the evaporated list has not grown. This is the property the whole clock design exists for; if the card vanishes, the belt is getting `Date.now()` somewhere instead of `beltNow()`.

- [ ] **Step 5: Confirm resume does not fire a burst**

Click `resume`. The board must carry on from where it stopped — the parked card gets its remaining dwell, not an instant eviction, and no queue of hops lands at once.

- [ ] **Step 6: Confirm a seed typed while paused waits, then releases**

Pause, seed a word, confirm it appears in the seed column and does **not** fan. Resume, confirm it fans.

- [ ] **Step 7: Confirm the state survives a reload**

With the board paused on `slow`, reload the page. The control row must come back paused and on `slow` — the hash-resumed board reads its controls from the DO.

- [ ] **Step 8: Check the console and server logs are clean**

`read_console_messages` and `preview_logs` with `level: "error"`. A `seed fan under-filled` warning is pre-existing behaviour and not a failure of this work; anything naming controls, the clock or the pump is.

- [ ] **Step 9: Flip the spec's status**

In `docs/superpowers/specs/2026-08-08-board-speed-and-pause-design.md`, change `**Status:** approved, not yet implemented` to `**Status:** implemented`.

- [ ] **Step 10: Run the full gates one last time and commit**

```bash
npm run typecheck && npm test
```

```bash
git add docs/superpowers/specs/2026-08-08-board-speed-and-pause-design.md
git commit -m "docs: mark the board speed and pause spec implemented"
```

- [ ] **Step 11: Open the PR**

Use the `/ship` checklist. The PR body must carry the actual test output — counts, not "tests pass" — and the pause screenshots from Step 4. **Do not merge without explicit approval.**

---

## Follow-ups to file as issues, not to build here

Offer these to the user after the PR is open, per the project's issue-hygiene rule:

- **A "step one hop" button while paused.** Named as deferred in the spec. The machinery is all present — it is one `setControls`-shaped RPC that advances belt time by a fixed amount.
- **No DO test harness (issue #31) now costs more.** Four of this feature's guarantees — that the alarm does not re-arm while paused, that resume pumps immediately, that a legacy board migrates epoch-continuously, that controls survive hibernation — are reachable only lexically or not at all. Worth re-raising on the existing issue with these as concrete motivating cases.
- **`steady` and `slow` are unmeasured.** 3000ms and 8000ms are judgement calls about reading speed. Nothing in `scripts/board-calibrate.ts` speaks to them, and the repo's own standard is that a tuning constant should print a number.
