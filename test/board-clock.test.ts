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
